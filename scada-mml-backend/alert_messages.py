"""Alert messages on the report trend — the source each plant keeps them in, and
the messages inside a window.

Two halves, with different audiences:

* **Sources** (`/sources/{datasource_id}`) — an admin names the table and
  columns a plant writes its alerts to. Reading one is open to any signed-in
  user (it is table and column names, nothing secret), and it carries a live
  check of whether that table is there yet, because a source can be — and for a
  new line usually is — configured before the table exists.
* **Messages** (`/messages`) — what the trend draws as markers. Never an error
  for "nothing to show": no source, a source whose table is missing and a plant
  that cannot be reached all answer 200 with `available: false` and a reason, so
  the chart keeps its readings and states quietly why it has no markers. A
  malformed request is still a 4xx.

Identifiers are never trusted from the request or the saved row alone: every
read goes through the same `_safe_identifiers` allowlist gate as /schema.
"""

from datetime import datetime, timedelta
import logging
import re
from typing import Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from psycopg_pool import PoolTimeout
from pydantic import BaseModel, Field, field_validator, model_validator

import db
from auth import get_current_user, require_admin
from licensing import require_valid_license

logger = logging.getLogger("mml-api.alerts")

router = APIRouter(
    prefix="/api/alerts",
    tags=["alerts"],
    dependencies=[Depends(require_valid_license)],
)

# The most messages one answer carries. A marker row past a few thousand flags is
# a solid bar; `truncated` says so rather than letting a clipped window pass for
# a quiet one.
MAX_MESSAGES = 2000
# Same ceiling as /schema/series, so any window the trend can show can be asked.
MAX_WINDOW_DAYS = 366
# The report filter's multi-pick, bounded so a hand-made URL stays a short query.
MAX_MATCH_VALUES = 50

# Postgres identifiers: at most 63 bytes. Anything else is still checked against
# the plant's catalogue on every read — this only turns an obvious typo into a
# 422 at save time instead of a permanently "unavailable" source.
_IDENT_MAX = 63
_CONTROL = re.compile(r"[\x00-\x1f]")

Reason = Literal["not_configured", "missing", "unreachable", "error"]


def _clean_ident(value: str | None, *, required: bool) -> str | None:
    if value is None or not value.strip():
        if required:
            raise ValueError("is required")
        return None
    value = value.strip()
    if len(value.encode()) > _IDENT_MAX or _CONTROL.search(value):
        raise ValueError("is not a valid column or table name")
    return value


def _first_line(e: Exception) -> str:
    text = str(e).strip()
    return text.splitlines()[0] if text else type(e).__name__


class AlertSourceIn(BaseModel):
    table_name: str = Field(..., max_length=200)
    ts_col: str = Field(..., max_length=200)
    message_col: str = Field(..., max_length=200)
    severity_col: str | None = Field(None, max_length=200)
    match_col: str | None = Field(None, max_length=200)
    match_filter: Literal["location", "camera"] | None = None

    @field_validator("table_name", "ts_col", "message_col")
    @classmethod
    def _required(cls, v):
        return _clean_ident(v, required=True)

    @field_validator("severity_col", "match_col")
    @classmethod
    def _optional(cls, v):
        return _clean_ident(v, required=False)

    @model_validator(mode="after")
    def _match_pair(self):
        # A match column with nothing to follow would filter on no value, and a
        # filter with no column has nothing to compare — both are a half-set form.
        if (self.match_col is None) != (self.match_filter is None):
            raise ValueError("match_col and match_filter must be set together")
        return self


class AlertSourceOut(BaseModel):
    datasource_id: int
    configured: bool
    table_name: str | None = None
    ts_col: str | None = None
    message_col: str | None = None
    severity_col: str | None = None
    match_col: str | None = None
    match_filter: Literal["location", "camera"] | None = None
    updated_at: datetime | None = None
    # Whether the table and every named column can be read right now. Unset for
    # a datasource with no source.
    available: bool | None = None
    reason: Reason | None = None
    detail: str | None = None


class AlertMessageOut(BaseModel):
    ts: datetime
    message: str
    severity: Literal["crit", "warn", "info"]
    # The cell as written, for a tooltip that wants the plant's own word.
    severity_raw: str | None = None


class AlertMessagesOut(BaseModel):
    datasource_id: int
    configured: bool
    available: bool
    reason: Reason | None = None
    detail: str | None = None
    # Which report filter the source follows, so the client knows whether its
    # location/camera choice narrowed these or every message was returned.
    match_filter: Literal["location", "camera"] | None = None
    messages: list[AlertMessageOut] = []
    truncated: bool = False


def _require_datasource(datasource_id: int) -> None:
    if db.get_datasource(datasource_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Datasource not found")


def _failure(e: Exception) -> tuple[Reason, str]:
    """Sort a failed plant read into the reason the client shows.

    A missing table or column usually arrives as ValueError from the allowlist
    gate — but not always: that gate caches what it found (db/tables.py), so for
    a short while after a table is dropped or renamed it still says yes, and
    Postgres is the one to say no.
    """
    if isinstance(e, (ValueError, psycopg.errors.UndefinedTable, psycopg.errors.UndefinedColumn)):
        return "missing", _first_line(e)
    if isinstance(e, (psycopg.OperationalError, PoolTimeout)):
        return "unreachable", _first_line(e)
    return "error", _first_line(e)


def _probe(source: dict, datasource_id: int) -> tuple[bool, Reason | None, str | None]:
    """Whether a saved source can be read now: an empty window, read for real."""
    end = datetime.now().astimezone()
    try:
        db.read_alert_messages(source, datasource_id, end - timedelta(seconds=1), end, None, 1)
    except (ValueError, psycopg.Error, PoolTimeout) as e:
        reason, detail = _failure(e)
        return False, reason, detail
    return True, None, None


def _source_out(datasource_id: int, source: dict | None, *, probe: bool) -> dict:
    if source is None:
        return {"datasource_id": datasource_id, "configured": False}
    out = {**source, "configured": True}
    if probe:
        out["available"], out["reason"], out["detail"] = _probe(source, datasource_id)
    return out


@router.get("/sources/{datasource_id}", response_model=AlertSourceOut)
def get_alert_source(datasource_id: int, _user: dict = Depends(get_current_user)):
    _require_datasource(datasource_id)
    return _source_out(datasource_id, db.get_alert_source(datasource_id), probe=True)


@router.put("/sources/{datasource_id}", response_model=AlertSourceOut)
def put_alert_source(
    datasource_id: int, body: AlertSourceIn, _admin: dict = Depends(require_admin)
):
    """Save a source. Accepted whether or not its table exists yet — the answer
    says which, so the settings form can show it without refusing the save."""
    _require_datasource(datasource_id)
    saved = db.set_alert_source(datasource_id, **body.model_dump())
    return _source_out(datasource_id, saved, probe=True)


@router.delete("/sources/{datasource_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_alert_source(datasource_id: int, _admin: dict = Depends(require_admin)):
    if not db.delete_alert_source(datasource_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alert source not found")


@router.get("/messages", response_model=AlertMessagesOut)
def get_alert_messages(
    datasource_id: int = Query(..., ge=1),
    start: datetime = Query(...),
    end: datetime = Query(...),
    location: list[str] = Query([]),
    camera: list[str] = Query([]),
    limit: int = Query(MAX_MESSAGES, ge=1, le=MAX_MESSAGES),
    _user: dict = Depends(get_current_user),
):
    """The alert messages in [start, end] for one datasource, newest first.

    `location` / `camera` are the report filter bar's values, repeated for a
    multi-pick; the one the source follows (its `match_filter`) narrows the
    messages to any of its values, the other is ignored. With none, every message
    in the window is returned — the same as the trend,
    which shows whatever the filter bar does not narrow.
    """
    if start.utcoffset() is None or end.utcoffset() is None:
        raise HTTPException(422, "Start and end must include a timezone offset")
    if not timedelta(0) < end - start <= timedelta(days=MAX_WINDOW_DAYS):
        raise HTTPException(
            422, f"Range must be greater than zero and at most {MAX_WINDOW_DAYS} days")

    source = db.get_alert_source(datasource_id)
    if source is None:
        _require_datasource(datasource_id)
        return {"datasource_id": datasource_id, "configured": False, "available": False,
                "reason": "not_configured"}

    match_filter = source.get("match_filter")
    wanted = {"location": location, "camera": camera}.get(match_filter, []) if match_filter else []
    match_values = list(dict.fromkeys(v.strip() for v in wanted if v and v.strip()))
    if len(match_values) > MAX_MATCH_VALUES or any(len(v) > 200 for v in match_values):
        raise HTTPException(422, f"At most {MAX_MATCH_VALUES} filter values of 200 characters")

    base = {"datasource_id": datasource_id, "configured": True, "match_filter": match_filter}
    try:
        # One row past the cap, then trimmed: exactly `limit` back cannot tell a
        # window that holds `limit` messages from one that holds more.
        rows = db.read_alert_messages(source, datasource_id, start, end, match_values, limit + 1)
    except (ValueError, psycopg.Error, PoolTimeout) as e:
        reason, detail = _failure(e)
        if reason == "error":
            logger.warning("Alert messages for datasource %s failed: %s", datasource_id, detail)
        return {**base, "available": False, "reason": reason, "detail": detail}

    messages = [
        {"ts": r["ts"], "message": r["message"], "severity": db.severity_of(r["severity"]),
         "severity_raw": r["severity"]}
        for r in rows[:limit]
        if r["ts"] is not None
    ]
    return {**base, "available": True, "messages": messages, "truncated": len(rows) > limit}
