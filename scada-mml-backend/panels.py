"""Dashboard-panel endpoints for the admin-managed live grid.

Reads are open to any authenticated user (the Live dashboard renders them);
writes (create / update / delete) require an admin token (``require_admin``).
A panel binds to one of two data sources:
  - source='device': legacy device_id + metric (public.sensor_readings)
  - source='tag'   : tag_name + metric one-of TAG_FIELDS (public.status_tag)
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

import db
from auth import get_current_user, require_admin

router = APIRouter(prefix="/api/panels", tags=["panels"])

VALID_CHART_TYPES = {
    "timeseries",
    "line",
    "bar",
    "stat",
    "gauge",
    "bargauge",
    "histogram",
    "table",
}

VALID_SOURCES = {"device", "tag", "table"}

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


# --- Helpers ---------------------------------------------------------------
def _validate(body: PanelIn) -> None:
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
                detail="tag source requires tag_name and metric (a numeric column of public.status_tag)",
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
            cols = db.describe_table(body.table_name)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Table not allowed: {body.table_name!r}",
            )
        if body.metric not in cols["value_columns"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"metric must be a numeric column of {body.table_name!r}",
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
        # valid numeric column.
        extra = body.options.get("value_cols") if isinstance(body.options, dict) else None
        if extra is not None:
            if not isinstance(extra, list) or any(not isinstance(c, str) for c in extra):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="options.value_cols must be a list of column names",
                )
            for c in extra:
                if c not in cols["value_columns"]:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"options.value_cols[{c!r}] is not a numeric column of {body.table_name!r}",
                    )


# --- Endpoints -------------------------------------------------------------
@router.get("", response_model=list[PanelOut])
def list_panels(_user: dict = Depends(get_current_user)):
    return db.list_panels()


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
    )
    if panel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Panel not found")
    return panel


@router.delete("/{panel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_panel(panel_id: int, _admin: dict = Depends(require_admin)):
    if not db.delete_panel(panel_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Panel not found")
