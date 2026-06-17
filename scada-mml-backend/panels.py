"""Dashboard-panel endpoints for the admin-managed live grid.

Reads are open to any authenticated user (the Live dashboard renders them);
writes (create / update / delete) require an admin token (``require_admin``).
Each panel binds a device + metric from the flat ``public.sensor_readings`` /
``public.devices`` tables that back the real-time ECharts page.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

import db
from auth import get_current_user, require_admin

router = APIRouter(prefix="/api/panels", tags=["panels"])

# Grafana-style visualization types this dashboard supports. "line" is kept for
# backward compatibility with panels created before the multi-viz change and is
# rendered as a time series by the frontend.
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


# --- Schemas ---------------------------------------------------------------
class PanelOut(BaseModel):
    id: int
    title: str
    device_id: int
    metric: str
    window_minutes: int
    chart_type: str
    position: int
    options: dict = {}
    created_at: datetime


class PanelIn(BaseModel):
    title: str = Field(..., min_length=1)
    device_id: int = Field(..., ge=1)
    metric: str = Field(..., min_length=1)
    window_minutes: int = Field(15, ge=1, le=1440)
    chart_type: str = "timeseries"
    position: int = 0
    # Per-visualization parameters (min/max, thresholds, decimals, …).
    options: dict = {}


# --- Helpers ---------------------------------------------------------------
def _validate_chart_type(chart_type: str) -> None:
    if chart_type not in VALID_CHART_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Chart type must be one of: {', '.join(sorted(VALID_CHART_TYPES))}",
        )


# --- Endpoints -------------------------------------------------------------
@router.get("", response_model=list[PanelOut])
def list_panels(_user: dict = Depends(get_current_user)):
    """All dashboard panels — rendered by the Live grid for every user."""
    return db.list_panels()


@router.post("", response_model=PanelOut, status_code=status.HTTP_201_CREATED)
def create_panel(body: PanelIn, _admin: dict = Depends(require_admin)):
    _validate_chart_type(body.chart_type)
    return db.create_panel(
        body.title.strip(),
        body.device_id,
        body.metric,
        body.window_minutes,
        body.chart_type,
        body.position,
        body.options,
    )


@router.put("/{panel_id}", response_model=PanelOut)
def update_panel(panel_id: int, body: PanelIn, _admin: dict = Depends(require_admin)):
    _validate_chart_type(body.chart_type)
    panel = db.update_panel(
        panel_id,
        body.title.strip(),
        body.device_id,
        body.metric,
        body.window_minutes,
        body.chart_type,
        body.position,
        body.options,
    )
    if panel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Panel not found")
    return panel


@router.delete("/{panel_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_panel(panel_id: int, _admin: dict = Depends(require_admin)):
    if not db.delete_panel(panel_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Panel not found")
