"""Dashboard-panel endpoints for the admin-managed live grid.

Reads are open to any authenticated user (the Live dashboard renders them);
writes (create / update / delete) require an admin token (``require_admin``),
except changing a panel's poll interval — operators may do that too via the
narrow PATCH .../poll-interval endpoint (``require_operator_or_admin``).
A panel binds to one of two data sources:
  - source='device': legacy device_id + metric (public.sensor_readings)
  - source='tag'   : tag_name + metric one-of TAG_FIELDS (public.variables_tag)
  - source='table' : generic table_name + metric (+ filter/ts columns)
  - source='kpi'   : a management block (Loss meter / Andon board / Loss
                     waterfall) reading machine families detected in
                     table_name; its settings live in options.kpi (kpi_options.py)
"""
from datetime import datetime

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

import db
from auth import can_see_cost, get_current_user, require_admin, require_operator_or_admin
from kpi_engine import strip_cost
from kpi_options import (
    KPI_CHART_TYPES, KPI_POLL_INTERVALS, KpiOptionsError, bind_families, bind_picked, counts_picked_columns,
    normalize_kpi_options,
)
from licensing import require_valid_license

router = APIRouter(
    prefix="/api/panels",
    tags=["panels"],
    dependencies=[Depends(require_valid_license)],
)

VALID_CHART_TYPES = {
    "timeseries",
    "line",
    "bar",
    "stat",
    "gauge",
    "bargauge",
    "histogram",
    "table",
    "pie",
    "heatmap",
    "scatter",
    "statetimeline",
    "candlestick",
    *KPI_CHART_TYPES,
}

VALID_SOURCES = {"device", "tag", "table", "kpi"}

# Poll-interval whitelist (seconds) — mirrors the frontend selector.
VALID_POLL_INTERVALS = {5, 30, 60, 600, 1800, 3600}


# --- Schemas ---------------------------------------------------------------
class PanelOut(BaseModel):
    id: int
    title: str
    device_id: int | None = None
    metric: str | None = None
    window_minutes: int
    chart_type: str
    position: int
    options: dict = {}
    source: str = "device"
    tag_name: str | None = None
    poll_interval_seconds: int = 5
    table_name: str | None = None
    filter_col: str | None = None
    ts_col: str | None = None
    dashboard_id: int | None = None
    datasource_id: int | None = None
    created_at: datetime


class PanelIn(BaseModel):
    title: str = Field(..., min_length=1)
    device_id: int | None = Field(None, ge=1)
    metric: str | None = None
    window_minutes: int = Field(15, ge=1, le=1440)
    chart_type: str = "timeseries"
    position: int = 0
    options: dict = {}
    source: str = "device"
    tag_name: str | None = None
    poll_interval_seconds: int = 5
    table_name: str | None = None
    filter_col: str | None = None
    ts_col: str | None = None
    dashboard_id: int | None = None
    datasource_id: int | None = None


class PollIntervalIn(BaseModel):
    poll_interval_seconds: int


# --- Helpers ---------------------------------------------------------------
def _validate(body: PanelIn) -> None:
    if body.dashboard_id is not None:
        if not any(d["id"] == body.dashboard_id for d in db.list_dashboards()):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"dashboard_id {body.dashboard_id} does not exist",
            )
    if body.datasource_id is not None and db.get_datasource(body.datasource_id) is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"datasource_id {body.datasource_id} does not exist",
        )
    if body.chart_type not in VALID_CHART_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Chart type must be one of: {', '.join(sorted(VALID_CHART_TYPES))}",
        )
    if body.source not in VALID_SOURCES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Source must be one of: {', '.join(sorted(VALID_SOURCES))}",
        )
    if body.poll_interval_seconds not in VALID_POLL_INTERVALS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"poll_interval_seconds must be one of: {sorted(VALID_POLL_INTERVALS)}",
        )
    if (body.chart_type in KPI_CHART_TYPES) != (body.source == "kpi"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Management blocks (lossmeter, andon, waterfall) use source 'kpi', and only they do",
        )
    if body.source == "kpi":
        _validate_kpi(body)
        return
    if body.source == "device":
        if not body.device_id or not body.metric:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="device source requires device_id and metric",
            )
    elif body.source == "tag":
        if not body.tag_name or not body.metric:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="tag source requires tag_name and metric (a numeric column of public.variables_tag)",
            )
        valid_fields = db.tag_fields()
        if body.metric not in valid_fields:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"metric for tag source must be one of: {', '.join(valid_fields)}",
            )
    else:  # table — generic public-table binding
        if not body.table_name or not body.metric:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="table source requires table_name and metric (a numeric column)",
            )
        try:
            cols = db.describe_table(body.table_name, body.datasource_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Table not allowed: {body.table_name!r}",
            )
        except psycopg.Error as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Could not reach the selected connection: "
                       f"{str(e).strip().splitlines()[0] if str(e).strip() else 'connection error'}",
            )
        # Booleans count as values: they arrive from /schema/series as 0/1 and
        # draw a step line. Numeric arrays are values too -- each listed slot of
        # one is its own line -- and so is text, which a Stat or Table prints as
        # the latest word. All three are kept out of `value_columns` upstream so
        # the editor can tell them from a measurement, so the union is spelled
        # here rather than widened there.
        pickable = (
            set(cols["value_columns"])
            | set(cols.get("bool_columns", []))
            | set(cols.get("array_value_columns", []))
            | set(cols.get("text_columns", []))
        )
        if body.metric not in pickable:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"metric must be a numeric, boolean, array or text column of {body.table_name!r}",
            )
        if body.filter_col and body.filter_col not in cols["filter_columns"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"filter_col must be a column of {body.table_name!r}",
            )
        if body.ts_col and body.ts_col not in cols["ts_columns"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"ts_col must be a timestamp column of {body.table_name!r}",
            )
        # Extra value columns ride in options.value_cols so the panel can chart
        # several columns from the same table as separate series. The primary
        # column stays in `metric` for back-compat; each extra must also be a
        # valid value column.
        options = body.options if isinstance(body.options, dict) else {}
        extra = options.get("value_cols")
        if extra is not None:
            if not isinstance(extra, list) or any(not isinstance(c, str) for c in extra):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="options.value_cols must be a list of column names",
                )
            for c in extra:
                if c not in pickable:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"options.value_cols[{c!r}] is not a numeric, boolean, array or "
                               f"text column of {body.table_name!r}",
                    )
        _validate_column_options(options)


def _validate_column_options(options: dict) -> None:
    """Shape of the per-column options the Live editor writes beside value_cols.

    `unsplitCols` / `textCols` are lists of column names; `arraySlots` maps an
    array column to the slots it draws, `[{"index": int >= 0, "name"?: str}]`.
    The tile reads these without further checks, so a malformed one is refused
    here rather than blanking the panel later.
    """
    for key in ("unsplitCols", "textCols"):
        value = options.get(key)
        if value is not None and (
            not isinstance(value, list) or any(not isinstance(c, str) for c in value)
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"options.{key} must be a list of column names",
            )
    slots_by_col = options.get("arraySlots")
    if slots_by_col is None:
        return
    bad = HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="options.arraySlots must map a column to a list of {index, name} slots",
    )
    if not isinstance(slots_by_col, dict):
        raise bad
    for slots in slots_by_col.values():
        if not isinstance(slots, list):
            raise bad
        for slot in slots:
            index = slot.get("index") if isinstance(slot, dict) else None
            name = slot.get("name") if isinstance(slot, dict) else None
            if (
                not isinstance(index, int) or isinstance(index, bool) or index < 0
                or (name is not None and not isinstance(name, str))
            ):
                raise bad


def _validate_kpi(body: PanelIn) -> None:
    """A management block: settings checked, and — once a table is chosen — its
    machines detected so a block can never be saved reading nothing.

    Normalizes `body.options["kpi"]` in place (defaults filled in) and sets
    `metric` to the first machine's speed column, for code that expects every
    table-ish panel to name one.
    """
    if body.poll_interval_seconds not in KPI_POLL_INTERVALS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Management blocks poll every {sorted(KPI_POLL_INTERVALS)} seconds",
        )
    options = body.options if isinstance(body.options, dict) else {}
    try:
        kpi = normalize_kpi_options(options.get("kpi"))
    except KpiOptionsError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    body.options = {**options, "kpi": kpi}
    if not body.table_name:
        # Dropped from the palette before any table was known: saved unbound,
        # and the inspector opens to bind it.
        body.metric = None
        return
    try:
        cols = db.describe_table(body.table_name, body.datasource_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Table not allowed: {body.table_name!r}",
        )
    except psycopg.Error as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Could not reach the selected connection: "
                   f"{str(e).strip().splitlines()[0] if str(e).strip() else 'connection error'}",
        )
    try:
        if counts_picked_columns(kpi, body.chart_type):
            body.metric = bind_picked(kpi, cols)["defect_cols"][0]
        else:
            families = bind_families(kpi, cols, location_tags(kpi.get("location"), body.datasource_id),
                                     _machine_values(body.table_name, body.datasource_id, kpi), body.table_name)
            body.metric = families[0]["speed"]
    except KpiOptionsError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    body.ts_col = kpi["ts_col"]
    body.filter_col = None


def _machine_values(table: str, datasource_id: int | None, kpi: dict) -> list[str] | None:
    """The machine column's distinct values for an explicitly bound table, else None."""
    from kpi import machine_values
    return machine_values(table, datasource_id, kpi)


def location_tags(location: str | None, datasource_id: int | None) -> set[str] | None:
    """The tag names at `location` (variables_tag.location), or None for every column."""
    if not location:
        return None
    try:
        rows = db.tag_locations(datasource_id=datasource_id)
    except (ValueError, psycopg.Error):
        return None
    return {r["tag_name"] for r in rows if r.get("location") == location}


def for_viewer(panel: dict | None, user: dict) -> dict | None:
    """`panel` as `user` may see it: a management block's price is cost data."""
    if panel is None or can_see_cost(user) or panel.get("source") != "kpi":
        return panel
    return {**panel, "options": strip_cost(panel.get("options") or {})}


# --- Endpoints -------------------------------------------------------------
@router.get("", response_model=list[PanelOut])
def list_panels(dashboard_id: int | None = None, user: dict = Depends(get_current_user)):
    return [for_viewer(p, user) for p in db.list_panels(dashboard_id)]


@router.post("", response_model=PanelOut, status_code=status.HTTP_201_CREATED)
def create_panel(body: PanelIn, _admin: dict = Depends(require_admin)):
    _validate(body)
    return db.create_panel(
        body.title.strip(),
        body.device_id,
        body.metric,
        body.window_minutes,
        body.chart_type,
        body.position,
        body.options,
        body.source,
        body.tag_name.strip() if body.tag_name else None,
        body.poll_interval_seconds,
        body.table_name,
        body.filter_col,
        body.ts_col,
        body.dashboard_id,
        body.datasource_id,
    )


@router.put("/{panel_id}", response_model=PanelOut)
def update_panel(panel_id: int, body: PanelIn, _admin: dict = Depends(require_admin)):
    _validate(body)
    panel = db.update_panel(
        panel_id,
        body.title.strip(),
        body.device_id,
        body.metric,
        body.window_minutes,
        body.chart_type,
        body.position,
        body.options,
        body.source,
        body.tag_name.strip() if body.tag_name else None,
        body.poll_interval_seconds,
        body.table_name,
        body.filter_col,
        body.ts_col,
        body.dashboard_id,
        body.datasource_id,
    )
    if panel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Panel not found")
    return panel


@router.patch("/{panel_id}/poll-interval", response_model=PanelOut)
def update_poll_interval(
    panel_id: int, body: PollIntervalIn, user: dict = Depends(require_operator_or_admin)
):
    """Operators (and admins) may change a panel's poll cadence without the
    full panel-edit rights update_panel() requires."""
    if body.poll_interval_seconds not in VALID_POLL_INTERVALS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"poll_interval_seconds must be one of: {sorted(VALID_POLL_INTERVALS)}",
        )
    current = db.get_panel(panel_id)
    if current is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Panel not found")
    if current.get("source") == "kpi" and body.poll_interval_seconds not in KPI_POLL_INTERVALS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Management blocks poll every {sorted(KPI_POLL_INTERVALS)} seconds",
        )
    panel = db.update_panel_poll_interval(panel_id, body.poll_interval_seconds)
    if panel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Panel not found")
    return for_viewer(panel, user)


@router.delete("/{panel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_panel(panel_id: int, _admin: dict = Depends(require_admin)):
    if not db.delete_panel(panel_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Panel not found")
