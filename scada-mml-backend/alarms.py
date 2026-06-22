"""Alarm endpoints — backs the Alarms page against public.alarm_logs.

Mirrors the Events router shape but adds severity colour-coding and a
per-row Acknowledge action. The alarm_logs table is populated externally
(the SCADA system writes new alarm rows on its own); the Acknowledge action
is the only write this API performs against it.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator

import db
from auth import get_current_user

router = APIRouter(prefix="/api/alarms", tags=["alarms"])


_VALID_SEVERITIES = ("critical", "warning", "info")


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

    @field_validator("severity", mode="before")
    @classmethod
    def _normalize_severity(cls, v):
        """Coerce DB severity values into the three colour tiers the UI knows.
        Accepts text labels (case-insensitive) or smallint codes (1/2/3)."""
        if v is None:
            return "info"
        if isinstance(v, (int, float)):
            return {1: "info", 2: "warning", 3: "critical"}.get(int(v), "info")
        s = str(v).strip().lower()
        return s if s in _VALID_SEVERITIES else "info"


@router.get("/recent", response_model=list[AlarmOut])
def recent_alarms(
    limit: int = Query(10, ge=1, le=100),
    _user: dict = Depends(get_current_user),
):
    """Last `limit` alarms per tag_name from public.alarm_logs, newest first."""
    return db.list_recent_alarms(limit)


@router.post("/{alarm_id}/acknowledge", response_model=AlarmOut)
def acknowledge(
    alarm_id: int,
    user: dict = Depends(get_current_user),
):
    """Mark an alarm row as acknowledged. 404 if no such row or already acked."""
    row = db.acknowledge_alarm(alarm_id, user["id"])
    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Alarm not found or already acknowledged.",
        )
    return row
