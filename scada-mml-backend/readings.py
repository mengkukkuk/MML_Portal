"""Live sensor-reading endpoints that back the real-time ECharts page.

Read-only, requires a valid access token (``get_current_user``). Data comes from
the flat ``public.sensor_readings`` / ``public.devices`` tables that
``simulate_data.py`` populates every 5 seconds.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

import db
from auth import get_current_user

router = APIRouter(prefix="/api/readings", tags=["readings"])


# --- Schemas ---------------------------------------------------------------
class DeviceOut(BaseModel):
    id: int
    name: str
    type: str | None = None
    location: str | None = None
    status: str | None = None


class MetricOut(BaseModel):
    metric: str
    unit: str | None = None


class Point(BaseModel):
    ts: datetime
    value: float


class LatestOut(BaseModel):
    device_id: int
    metric: str
    unit: str | None = None
    ts: datetime
    value: float


class SeriesOut(BaseModel):
    device_id: int
    metric: str
    unit: str | None = None
    points: list[Point]


# --- Endpoints -------------------------------------------------------------
@router.get("/devices", response_model=list[DeviceOut])
def get_devices(_user: dict = Depends(get_current_user)):
    """List all monitored devices."""
    return db.list_devices()


@router.get("/metrics", response_model=list[MetricOut])
def get_metrics(
    device_id: int = Query(..., ge=1),
    _user: dict = Depends(get_current_user),
):
    """Distinct metrics recorded for a device, each with its latest unit."""
    return db.list_metrics(device_id)


@router.get("/latest", response_model=LatestOut)
def get_latest(
    device_id: int = Query(..., ge=1),
    metric: str = Query(..., min_length=1),
    _user: dict = Depends(get_current_user),
):
    """Most-recent single reading — polled by the frontend every 5 seconds."""
    row = db.latest_reading(device_id, metric)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No readings for that device/metric",
        )
    return {"device_id": device_id, "metric": metric, **row}


@router.get("/series", response_model=SeriesOut)
def get_series(
    device_id: int = Query(..., ge=1),
    metric: str = Query(..., min_length=1),
    minutes: int = Query(15, ge=1, le=10080),
    _user: dict = Depends(get_current_user),
):
    """Time-series over the last `minutes` — used to seed the chart on load."""
    rows = db.reading_series(device_id, metric, minutes)
    unit = rows[-1]["unit"] if rows else None
    points = [{"ts": r["ts"], "value": r["value"]} for r in rows]
    return {"device_id": device_id, "metric": metric, "unit": unit, "points": points}