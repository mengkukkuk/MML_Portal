"""Event-log endpoints — backs the Events page against each plant's event_logs.

The event_logs table is populated in place by the SCADA system; this API is
read-only. Each request returns the last N events per (location, tag_name) so
the frontend can render a location -> tag_name -> events tree.

Which databases are read comes from the header selection, resolved per user by
`auth.active_datasources` — never from a panel setting. Rows from every selected
plant are merged and tagged with their source; the `sources` list says which
plants answered.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

import db
from auth import active_datasources, get_current_user
from sources import SourceReport, sort_key

router = APIRouter(prefix="/api/events", tags=["events"])


class EventOut(BaseModel):
    location: str | None = None
    tag_name: str | None = None
    event: str | None = None
    at_date_time: datetime | None = None
    # Two plants routinely share a location name. Without these the frontend
    # cannot key a merged list, and React silently renders one of the pair.
    datasource_id: int | None = None
    datasource_name: str | None = None


class EventsOut(BaseModel):
    events: list[EventOut]
    sources: list[SourceReport]


@router.get("/recent", response_model=EventsOut)
def recent_events(
    limit: int = Query(10, ge=1, le=100),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Last `limit` events per tag_name, merged across the selected sources.

    Each source is queried with the *full* limit rather than limit/N: the
    per-(location, tag_name) cap is what the page renders, and dividing it would
    truncate a busy plant because a quiet one is also selected.
    """
    events, reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: db.list_recent_events(limit, datasource_id=ds),
        label="events",
    )
    # Reproduce the single-source ORDER BY across the merge: location, tag_name,
    # at_date_time DESC. Two stable passes rather than one mixed-direction key,
    # since at_date_time has no usable negation.
    events.sort(key=sort_key("at_date_time"), reverse=True)
    events.sort(key=lambda r: (r["location"] or "", r["tag_name"] or ""))
    return {"events": events, "sources": reports}
