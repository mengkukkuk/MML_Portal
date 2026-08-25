"""Live sensor-reading endpoints that back the real-time ECharts page.

Read-only, requires a valid access token (``get_current_user``). Data comes from
the flat ``sensor_readings`` / ``devices`` tables that ``simulate_data.py``
populates every 5 seconds, in whichever datasources the user selected.

``device_id`` is a per-database serial, so it collides across plants exactly the
way alarm ids do — every response therefore names its source.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

import db
from auth import active_datasources, get_current_user
from sources import SourceReport

router = APIRouter(prefix="/api/readings", tags=["readings"])


# --- Schemas ---------------------------------------------------------------
class DeviceOut(BaseModel):
    id: int
    name: str
    type: str | None = None
    location: str | None = None
    status: str | None = None
    datasource_id: int | None = None
    datasource_name: str | None = None


class DevicesOut(BaseModel):
    devices: list[DeviceOut]
    sources: list[SourceReport]


class MetricOut(BaseModel):
    metric: str
    unit: str | None = None
    datasource_id: int | None = None
    datasource_name: str | None = None


class MetricsOut(BaseModel):
    metrics: list[MetricOut]
    sources: list[SourceReport]


class Point(BaseModel):
    ts: datetime
    value: float


class LatestOut(BaseModel):
    device_id: int
    metric: str
    unit: str | None = None
    ts: datetime
    value: float
    datasource_id: int | None = None
    datasource_name: str | None = None


class LatestListOut(BaseModel):
    readings: list[LatestOut]
    sources: list[SourceReport]


class SeriesOut(BaseModel):
    device_id: int
    metric: str
    unit: str | None = None
    points: list[Point]
    datasource_id: int | None = None
    datasource_name: str | None = None


class SeriesListOut(BaseModel):
    series: list[SeriesOut]
    sources: list[SourceReport]


# --- Endpoints -------------------------------------------------------------
@router.get("/devices", response_model=DevicesOut)
def get_devices(
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Monitored devices across the selected sources."""
    devices, reports = db.fan_out_rows(
        datasource_ids, lambda ds: db.list_devices(datasource_id=ds), label="devices"
    )
    return {"devices": devices, "sources": reports}


@router.get("/metrics", response_model=MetricsOut)
def get_metrics(
    device_id: int = Query(..., ge=1),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Distinct metrics recorded for a device, each with its latest unit."""
    metrics, reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.list_metrics(device_id, datasource_id=ds),
        label="metrics",
    )
    return {"metrics": metrics, "sources": reports}


@router.get("/latest", response_model=LatestListOut)
def get_latest(
    device_id: int = Query(..., ge=1),
    metric: str = Query(..., min_length=1),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Most-recent reading per source — polled by the frontend every 5 seconds."""
    readings, reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: (
            [{"device_id": device_id, "metric": metric, **row}]
            if (row := db.latest_reading(device_id, metric, datasource_id=ds))
            else []
        ),
        label="latest reading",
    )
    if not readings:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No readings for that device/metric",
        )
    return {"readings": readings, "sources": reports}


@router.get("/series", response_model=SeriesListOut)
def get_series(
    device_id: int = Query(..., ge=1),
    metric: str = Query(..., min_length=1),
    minutes: int = Query(15, ge=1, le=10080),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """One time-series per source — used to seed the chart on load.

    Kept as separate series rather than merged points: two plants' readings for
    "the same" device id are unrelated measurements, and interleaving them would
    draw a line through both.
    """
    def one(ds):
        rows = db.reading_series(device_id, metric, minutes, datasource_id=ds)
        return [{
            "device_id": device_id,
            "metric": metric,
            "unit": rows[-1]["unit"] if rows else None,
            "points": [{"ts": r["ts"], "value": r["value"]} for r in rows],
        }]

    series, reports = db.fan_out_rows(datasource_ids, one, label="reading series")
    return {"series": series, "sources": reports}