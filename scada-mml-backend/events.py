"""Event-log endpoints — backs the Events page against public.event_log.

The event_log table is populated in place by the SCADA system; this API is
read-only. Each request returns the last N events per (location, tag_name) so
the frontend can render a location -> tag_name -> events tree.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

import db
from auth import get_current_user

router = APIRouter(prefix="/api/events", tags=["events"])


class EventOut(BaseModel):
    location: str | None = None
    tag_name: str | None = None
    event: str | None = None
    at_date_time: datetime | None = None


@router.get("/recent", response_model=list[EventOut])
def recent_events(
    limit: int = Query(10, ge=1, le=100),
    _user: dict = Depends(get_current_user),
):
    """Last `limit` events per tag_name from public.event_log, newest first."""
    return db.list_recent_events(limit)
