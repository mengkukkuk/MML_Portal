"""Report endpoints — vision/camera-QC reporting over vision_data.

Read-only against the vision_data-schema tables in the selected datasources;
the only writes are to the app's own report_templates, which live in the
config database regardless of what is selected.

The interesting endpoint is POST /run. It fetches each camera's hourly rows
*once* and projects that single aggregate into every requested block, so the
KPI cards, the throughput timeline, the defect pareto and the camera summary
table can never disagree with each other — which they would if each block
queried independently.

A camera's identity is `(datasource_id, location, code)`, not `(location,
code)`. Two plants both running a "Line 1 / CAM01" would otherwise have their
batches merged into one timeline and one defect rate for a camera that does
not exist. `vision_report_engine` is per-camera and key-agnostic, so it is
unchanged by this.

All timestamps are naive/server-local (see vision_report_engine's module
docstring).
"""
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

import db
import vision_report_engine as engine
from auth import active_datasources, get_current_user, require_admin
from licensing import require_entitlement, require_valid_license
from sources import SourceReport, sort_key

router = APIRouter(
    prefix="/api/reports",
    tags=["reports"],
    dependencies=[Depends(require_valid_license), Depends(require_entitlement("reports"))],
)

#: Hard ceiling on an export. Large enough to cover a month of a busy line,
#: small enough that one click cannot exhaust the worker's memory. The response
#: flags truncation rather than silently returning a short file.
MAX_EXPORT_ROWS = 100_000

#: Guards against a fat-fingered date range scanning years of history.
MAX_WINDOW_DAYS = 400


# --- Schemas ----------------------------------------------------------------
class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    blocks: list[dict[str, Any]] = []
    default_filters: dict[str, Any] = {}
    is_default: bool = False


class TemplateOut(BaseModel):
    id: int
    name: str
    description: str = ""
    blocks: list[dict[str, Any]] = []
    default_filters: dict[str, Any] = {}
    is_default: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CatalogEntry(BaseModel):
    location: str | None = None
    code: str
    name: str | None = None
    datasource_id: int | None = None
    datasource_name: str | None = None


class RunIn(BaseModel):
    start: datetime
    end: datetime
    locations: list[str] = []
    camera_codes: list[str] = []
    #: Which projections to compute. Hourly rows (and, when a pareto or
    #: summary table is requested, the per-batch defect log) are fetched once
    #: and shared by every block below.
    blocks: list[str] = ["kpi", "timeline", "pareto", "exceptions", "summary_table"]
    pareto_top_n: int = Field(10, ge=1, le=100)
    pareto_rank_by: Literal["count", "batches"] = "count"
    #: A per-template setting, not a global one — a packaging line's acceptable
    #: defect rate is not a weld line's.
    exceptions_warn_pct: float = Field(2.0, ge=0)
    exceptions_crit_pct: float = Field(5.0, ge=0)
    exceptions_top_n: int = Field(10, ge=1, le=100)


# --- Templates --------------------------------------------------------------
@router.get("/templates", response_model=list[TemplateOut])
def list_templates(_user: dict = Depends(get_current_user)):
    """Every saved template. Any authenticated user may read and run these."""
    return db.list_report_templates()


@router.get("/templates/default", response_model=TemplateOut)
def default_template(_user: dict = Depends(get_current_user)):
    """The template /reports redirects to."""
    row = db.get_default_report_template()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No report templates exist")
    return row


@router.get("/templates/{template_id}", response_model=TemplateOut)
def get_template(template_id: int, _user: dict = Depends(get_current_user)):
    row = db.get_report_template(template_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    return row


@router.post("/templates", response_model=TemplateOut, status_code=201)
def create_template(payload: TemplateIn, _admin: dict = Depends(require_admin)):
    return db.create_report_template(
        payload.name, payload.description, payload.blocks,
        payload.default_filters, payload.is_default,
    )


@router.put("/templates/{template_id}", response_model=TemplateOut)
def update_template(template_id: int, payload: TemplateIn,
                    _admin: dict = Depends(require_admin)):
    row = db.update_report_template(
        template_id, payload.name, payload.description, payload.blocks,
        payload.default_filters, payload.is_default,
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    return row


@router.delete("/templates/{template_id}", status_code=204)
def delete_template(template_id: int, _admin: dict = Depends(require_admin)):
    if not db.delete_report_template(template_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")


# --- Catalog ----------------------------------------------------------------
@router.get("/catalog", response_model=list[CatalogEntry])
def catalog(
    refresh: bool = Query(False),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Selectable lines and cameras across the selected sources.

    A flat list rather than an envelope: the filter bar's Line/Camera pickers
    consume it directly, and a source that is unreachable simply contributes no
    options. Cached per source for 5 minutes; ?refresh=1 busts it.
    """
    entries, _reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.vision_report_catalog(force=refresh, datasource_id=ds),
        label="vision catalog",
    )
    return entries


# --- Run --------------------------------------------------------------------
def _validate_window(start: datetime, end: datetime) -> float:
    if end <= start:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "End of range must be after the start")
    seconds = (end - start).total_seconds()
    if seconds > MAX_WINDOW_DAYS * 86400:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Range too large — maximum is {MAX_WINDOW_DAYS} days",
        )
    return seconds


def _camera_key(row: dict[str, Any]) -> tuple:
    return (row["datasource_id"], row["location"], row["code"])


@router.post("/run")
def run_report(
    payload: RunIn = Body(...),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Execute a report over a window and return one payload for every block."""
    window_seconds = _validate_window(payload.start, payload.end)

    hourly, hourly_sources = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.fetch_camera_hourly(
            payload.start, payload.end, payload.locations, payload.camera_codes,
            datasource_id=ds),
        label="camera hourly",
    )
    catalog_entries, _catalog_sources = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.vision_report_catalog(datasource_id=ds),
        label="vision catalog",
    )
    catalog_by_key = {_camera_key(c): c["name"] for c in catalog_entries}

    # Group hourly rows by camera so each camera's aggregate is built from only
    # its own rows. The datasource is part of the key — see the module docstring.
    by_camera: dict[tuple, list] = {}
    for row in hourly:
        by_camera.setdefault(_camera_key(row), []).append(row)

    # A camera explicitly asked for but with no rows at all still deserves a
    # row in the report — showing it as "no_data" is the finding.
    keys = set(by_camera)
    if payload.camera_codes:
        keys |= {_camera_key(c) for c in catalog_entries
                 if c["code"] in payload.camera_codes
                 and (not payload.locations or c["location"] in payload.locations)}

    names = db.datasource_names(datasource_ids)
    want_hourly_detail = "timeline" in payload.blocks
    want_batch_detail = "pareto" in payload.blocks or "summary_table" in payload.blocks

    defect_rows: list[dict[str, Any]] = []
    labels_by_code: dict[str, list[str]] = {}
    if want_batch_detail:
        defect_rows, _defect_sources = db.fan_out_rows(
            datasource_ids,
            lambda ds: db.fetch_camera_defect_logs_window(
                payload.start, payload.end, payload.locations, payload.camera_codes,
                datasource_id=ds),
            label="camera defect logs",
        )
        label_maps, _label_sources = db.fan_out_rows(
            datasource_ids,
            lambda ds: [{"code": k, "defect_labels": v}
                       for k, v in db.camera_defect_labels(datasource_id=ds).items()],
            label="camera defect labels",
        )
        labels_by_code = {r["code"]: r["defect_labels"] for r in label_maps}

    batch_summary = engine.camera_batch_summary(defect_rows, labels_by_code) \
        if want_batch_detail else {}

    cameras: list[dict[str, Any]] = []
    for key in sorted(keys, key=lambda k: (k[1] or "", k[2] or "", k[0] or 0)):
        ds_id, location, code = key
        rows = by_camera.get(key, [])
        agg = engine.aggregate_camera(rows, window_seconds)
        entry = {
            "location": location,
            "code": code,
            "name": catalog_by_key.get(key) or code,
            "datasource_id": ds_id,
            "datasource_name": names.get(ds_id),
            **agg,
            **batch_summary.get(code, {"last_seen": None, "worst_defect": None}),
        }
        entry.pop("worst_defect_count", None)
        if want_hourly_detail:
            entry["hourly"] = sorted(
                ({"period_start": r["period_start"], "count_total": r["count_total"],
                  "defect_total": r["defect_total"]} for r in rows),
                key=lambda r: r["period_start"],
            )
        cameras.append(entry)

    result: dict[str, Any] = {
        "window": {
            "start": payload.start,
            "end": payload.end,
            "seconds": window_seconds,
            "generated_at": datetime.now(),
        },
        "sources": hourly_sources,
        "totals": engine.totals_across(cameras),
    }

    if "pareto" in payload.blocks:
        result["defect_reasons"] = engine.defect_pareto(
            defect_rows, labels_by_code, payload.pareto_top_n, payload.pareto_rank_by)

    if "exceptions" in payload.blocks:
        result["quality_exceptions"] = engine.quality_exceptions(
            cameras, payload.exceptions_warn_pct, payload.exceptions_crit_pct,
            payload.exceptions_top_n)

    result["cameras"] = cameras
    return result


@router.get("/logs")
def raw_logs(
    start: datetime = Query(...),
    end: datetime = Query(...),
    locations: list[str] = Query([]),
    camera_codes: list[str] = Query([]),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=MAX_EXPORT_ROWS),
    offset: int = Query(0, ge=0),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """A page of raw camera_defect_logs rows (per-batch), merged across the
    selected sources.

    The on-screen table pages through this 50 at a time; the export re-requests
    it with a large limit. `truncated` tells the caller the file is incomplete
    rather than letting a silently short download look authoritative.

    Paging a merge has to over-fetch: row 100 of the merged order can come from
    anywhere in the first 100 rows of any single source, so each source is asked
    for `offset + limit` and the slice is taken after sorting. That cost grows
    linearly with both the offset and the source count — the `MAX_EXPORT_ROWS`
    ceiling now applies to the *merged* total, so a large export over several
    plants is the expensive case to watch.
    """
    _validate_window(start, end)
    counts = db.fan_out(
        datasource_ids,
        lambda ds: db.count_camera_defect_logs(start, end, locations, camera_codes,
                                               search, datasource_id=ds),
        label="log count",
    )
    total = sum(c["result"] or 0 for c in counts)

    span = min(offset + limit, MAX_EXPORT_ROWS)
    rows, reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.fetch_camera_defect_logs_page(start, end, locations, camera_codes,
                                                    search, span, 0, datasource_id=ds),
        label="log page",
    )
    rows.sort(key=sort_key("created_at"), reverse=True)
    page = rows[offset:offset + limit]
    for row in page:
        # A raw int[] is not a friendly table cell; the total is what the
        # on-screen log and the export both actually want to sort/scan by.
        row["total_defects"] = sum(row.get("defect_array") or [])
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "truncated": offset + len(page) < total,
        "rows": page,
        "sources": reports,
    }
