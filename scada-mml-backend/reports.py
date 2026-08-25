"""Report endpoints — OEE / production status reporting over event_logs.

Read-only against the SCADA-owned log tables in the selected datasources; the
only writes are to the app's own report_templates / report_settings, which live
in the config database regardless of what is selected.

The interesting endpoint is POST /run. It builds each machine's state intervals
*once* and projects that single interval set into every requested block, so the
KPI cards, the Gantt, the Pareto and the summary table can never disagree with
each other — which they would if each block queried independently.

A machine's identity is `(datasource_id, location, tag_name)`, not
`(location, tag_name)`. Two plants both running a "Line 1 / Packer" would
otherwise have their events interleaved into one timeline, producing state
transitions that never happened and an OEE figure for a machine that does not
exist. `report_engine.build_intervals` is per-machine and key-agnostic, so it is
unchanged by this.

All timestamps are naive/server-local (see report_engine's module docstring).
"""
from datetime import datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

import db
import report_engine as engine
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


class SettingsIn(BaseModel):
    state_rules: dict[str, list[str]]
    alarm_lead_seconds: int = Field(60, ge=0, le=3600)


class SettingsOut(BaseModel):
    state_rules: dict[str, list[str]]
    alarm_lead_seconds: int
    updated_at: datetime | None = None


class CatalogEntry(BaseModel):
    location: str | None = None
    tag_name: str
    datasource_id: int | None = None
    datasource_name: str | None = None


class RunIn(BaseModel):
    start: datetime
    end: datetime
    locations: list[str] = []
    tag_names: list[str] = []
    #: Which projections to compute. `intervals` are only returned when a
    #: timeline is asked for — they are by far the largest part of the payload.
    blocks: list[str] = ["kpi", "timeline", "pareto", "alarms", "summary_table"]
    pareto_top_n: int = Field(10, ge=1, le=100)
    pareto_rank_by: Literal["duration", "count"] = "duration"


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


# --- Settings ---------------------------------------------------------------
@router.get("/settings", response_model=SettingsOut)
def read_settings(_user: dict = Depends(get_current_user)):
    """Readable by everyone so the UI can explain how a state was derived."""
    return db.get_report_settings()


@router.put("/settings", response_model=SettingsOut)
def write_settings(payload: SettingsIn, _admin: dict = Depends(require_admin)):
    """Changing this changes every historical report, so it is admin-only."""
    unknown = set(payload.state_rules) - set(engine.MATCH_PRIORITY)
    if unknown:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown state(s): {', '.join(sorted(unknown))}. "
            f"Valid states: {', '.join(engine.MATCH_PRIORITY)}",
        )
    return db.update_report_settings(payload.state_rules, payload.alarm_lead_seconds)


# --- Catalog ----------------------------------------------------------------
@router.get("/catalog", response_model=list[CatalogEntry])
def catalog(
    refresh: bool = Query(False),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Selectable lines and machines across the selected sources.

    A flat list rather than an envelope: the filter bar's Line/Machine pickers
    consume it directly, and a source that is unreachable simply contributes no
    options. Cached per source for 5 minutes; ?refresh=1 busts it.
    """
    entries, _reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.report_catalog(force=refresh, datasource_id=ds),
        label="report catalog",
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


def _machine_key(row: dict[str, Any]) -> tuple:
    return (row["datasource_id"], row["location"], row["tag_name"])


@router.post("/run")
def run_report(
    payload: RunIn = Body(...),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Execute a report over a window and return one payload for every block."""
    window_seconds = _validate_window(payload.start, payload.end)
    settings = db.get_report_settings()
    rules = settings["state_rules"]
    lead = settings["alarm_lead_seconds"]

    events, event_sources = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.fetch_state_events(
            payload.start, payload.end, payload.locations, payload.tag_names,
            datasource_id=ds),
        label="state events",
    )
    alarms, _alarm_sources = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.fetch_alarms_for_window(
            payload.start - timedelta(seconds=lead), payload.end,
            payload.locations, payload.tag_names, datasource_id=ds),
        label="report alarms",
    )

    # Group both feeds by machine so each machine's timeline is built from only
    # its own rows. The datasource is part of the key — see the module docstring.
    by_machine: dict[tuple, list] = {}
    for row in events:
        by_machine.setdefault(_machine_key(row), []).append(row)
    alarms_by_machine: dict[tuple, list] = {}
    for row in alarms:
        alarms_by_machine.setdefault(_machine_key(row), []).append(row)

    # A machine explicitly asked for but with no rows at all still deserves a row
    # in the report — showing it as 100% UNKNOWN is the finding.
    keys = set(by_machine) | set(alarms_by_machine)
    names = db.datasource_names(datasource_ids)
    if payload.tag_names:
        catalog_entries, _ = db.fan_out_rows(
            datasource_ids,
            lambda ds: db.report_catalog(datasource_id=ds),
            label="report catalog",
        )
        keys |= {_machine_key(c) for c in catalog_entries
                 if c["tag_name"] in payload.tag_names
                 and (not payload.locations or c["location"] in payload.locations)}

    now = datetime.now()
    want_intervals = "timeline" in payload.blocks
    machines: list[dict[str, Any]] = []

    for key in sorted(keys, key=lambda k: (k[1] or "", k[2] or "", k[0] or 0)):
        ds_id, location, tag_name = key
        intervals = engine.build_intervals(
            by_machine.get(key, []),
            payload.start, payload.end, rules, now=now,
        )
        machine_alarms = alarms_by_machine.get(key, [])
        engine.attribute_reasons(intervals, machine_alarms, lead)

        entry = {
            "location": location,
            "tag_name": tag_name,
            "datasource_id": ds_id,
            "datasource_name": names.get(ds_id),
            "alarm_count": len(machine_alarms),
            **engine.aggregate(intervals, window_seconds),
        }
        # Kept out of the response unless a timeline needs it, but always present
        # in-process so the Pareto can be computed from the same intervals.
        entry["intervals"] = intervals
        machines.append(entry)

    result: dict[str, Any] = {
        "window": {
            "start": payload.start,
            "end": payload.end,
            "seconds": window_seconds,
            "generated_at": now,
        },
        "oee_mode": "availability_only",
        "sources": event_sources,
        "totals": engine.totals_across(machines, window_seconds),
    }

    if "pareto" in payload.blocks:
        result["downtime_reasons"] = engine.downtime_pareto(
            machines, payload.pareto_top_n, payload.pareto_rank_by)

    if "alarms" in payload.blocks:
        by_severity: dict[str, int] = {}
        top: dict[str, dict[str, Any]] = {}
        for row in alarms:
            sev = (row.get("severity") or "info")
            sev = sev if isinstance(sev, str) else "info"
            by_severity[sev] = by_severity.get(sev, 0) + 1
            text = row.get("text") or "(no text)"
            bucket = top.setdefault(text, {"alarm": text, "severity": sev, "count": 0})
            bucket["count"] += 1
        result["alarm_summary"] = {
            "total": len(alarms),
            "by_severity": by_severity,
            "top": sorted(top.values(), key=lambda b: b["count"], reverse=True)[:10],
        }

    if not want_intervals:
        for m in machines:
            m.pop("intervals", None)
    result["machines"] = machines
    return result


@router.get("/logs")
def raw_logs(
    start: datetime = Query(...),
    end: datetime = Query(...),
    locations: list[str] = Query([]),
    tag_names: list[str] = Query([]),
    search: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=MAX_EXPORT_ROWS),
    offset: int = Query(0, ge=0),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """A page of raw event_logs rows, merged across the selected sources.

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
        lambda ds: db.count_event_log(start, end, locations, tag_names, search,
                                      datasource_id=ds),
        label="log count",
    )
    total = sum(c["result"] or 0 for c in counts)

    span = min(offset + limit, MAX_EXPORT_ROWS)
    rows, reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.fetch_event_log_page(start, end, locations, tag_names,
                                           search, span, 0, datasource_id=ds),
        label="log page",
    )
    rows.sort(key=sort_key("at_date_time"), reverse=True)
    page = rows[offset:offset + limit]
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "truncated": offset + len(page) < total,
        "rows": page,
        "sources": reports,
    }
