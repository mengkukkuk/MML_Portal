"""Alarm endpoints — backs the Alarms page against each plant's alarm_logs.

Mirrors the Events router shape but adds severity colour-coding and a
per-row Acknowledge action. The alarm_logs table is populated externally
(the SCADA system writes new alarm rows on its own); the Acknowledge action
is the only write this API performs against it.

Reads fan out over the user's selected datasources and merge. The write does
not — see `acknowledge`.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator

import db
from auth import active_datasources, get_current_user
from licensing import require_valid_license
from sources import SourceReport, sort_key

router = APIRouter(
    prefix="/api/alarms",
    tags=["alarms"],
    dependencies=[Depends(require_valid_license)],
)


_VALID_SEVERITIES = ("critical", "warning", "info")


def _normalize_severity(v):
    """Coerce DB severity values into the three colour tiers the UI knows.
    Accepts text labels (case-insensitive) or smallint codes (1/2/3)."""
    if v is None:
        return "info"
    if isinstance(v, (int, float)):
        return {1: "info", 2: "warning", 3: "critical"}.get(int(v), "info")
    s = str(v).strip().lower()
    return s if s in _VALID_SEVERITIES else "info"


class AlarmOut(BaseModel):
    id: int
    location: str | None = None
    tag_name: str | None = None
    alarm: str | None = None
    severity: str = "info"
    at_date_time: datetime | None = None
    acknowledged: bool = False
    acknowledged_at: datetime | None = None
    acknowledged_by: int | None = None
    # `id` alone is not unique across a merged list — each plant's alarm_logs
    # has its own sequence — so the source is part of a row's identity here.
    datasource_id: int | None = None
    datasource_name: str | None = None

    _norm_sev = field_validator("severity", mode="before")(_normalize_severity)


class ActiveAlarmOut(BaseModel):
    alarm_id: int | None = None
    location: str | None = None
    tag_name: str | None = None
    alarm: str | None = None
    alarm_value: int | None = None
    alarm_no: int | None = None
    alarm_active: bool = False
    severity: str = "info"
    at_date_time: datetime | None = None
    datasource_id: int | None = None
    datasource_name: str | None = None

    _norm_sev = field_validator("severity", mode="before")(_normalize_severity)


class ActiveAlarmsOut(BaseModel):
    alarms: list[ActiveAlarmOut]
    sources: list[SourceReport]


class RecentAlarmsOut(BaseModel):
    alarms: list[AlarmOut]
    sources: list[SourceReport]


@router.get("/active", response_model=ActiveAlarmsOut)
def active_alarms(
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Tags currently in alarm across the selected sources, newest first.

    This is the endpoint polled at 1 Hz, which is why `db.fan_out` is threaded:
    one powered-off plant would otherwise add a full connect timeout to every
    tick and the poll interval would be exceeded before the first byte.
    """
    alarms, reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.list_active_alarms(datasource_id=ds),
        label="active alarms",
    )
    alarms.sort(key=sort_key("at_date_time"), reverse=True)
    return {"alarms": alarms, "sources": reports}


@router.get("/recent", response_model=RecentAlarmsOut)
def recent_alarms(
    limit: int = Query(10, ge=1, le=100),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Last `limit` alarms per tag_name, merged across the selected sources.

    Each source gets the full `limit` for the same reason as /api/events/recent:
    it is a per-tag cap, and splitting it would truncate a busy plant.
    """
    alarms, reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.list_recent_alarms(limit, datasource_id=ds),
        label="recent alarms",
    )
    alarms.sort(key=sort_key("at_date_time"), reverse=True)
    return {"alarms": alarms, "sources": reports}


@router.post("/{alarm_id}/acknowledge", response_model=AlarmOut)
def acknowledge(
    alarm_id: int,
    datasource_id: int | None = Query(None),
    user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Mark one alarm row as acknowledged. 404 if no such row or already acked.

    Never fanned out. Alarm ids come from each database's own sequence, so id 42
    exists in every plant and means something different in each: trying the
    sources in turn would acknowledge a *different* plant's alarm on the second
    attempt. The row the operator clicked carries its `datasource_id`; the
    default only covers a client that predates the field.
    """
    target = datasource_id if datasource_id is not None else datasource_ids[0]
    if target not in datasource_ids:
        raise HTTPException(
            status_code=400,
            detail="That datasource is not in your current selection.",
        )
    row = db.acknowledge_alarm(alarm_id, user["id"], datasource_id=target)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Alarm not found or already acknowledged.",
        )
    return {**row, "datasource_id": target,
            "datasource_name": db.datasource_names([target]).get(target)}
