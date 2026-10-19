"""Alert messages on the report trend — the one source they are kept in, and
the messages inside a window.

Two halves, with different audiences:

* **Source** (`/source`) — an admin names the connection, table and columns the
  plant's alerts are written to. One source serves every trend, whichever
  connection its readings come from: alerts and readings usually live on
  different connections (see db/alert_messages.py). Reading it is open to any
  signed-in user (it is names, nothing secret), and it carries a live check of
  whether that table is there yet, because a source can be configured before
  the table exists.
* **Response roles** (`/roles`) — who has to act on an alert: rules an admin
  keeps (location -> role), or the role_id the alert row is tagged
  with, when the source has a role column. Every message comes back with its role.
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
    datasource_id: int = Field(..., ge=1)
    table_name: str = Field(..., max_length=200)
    ts_col: str = Field(..., max_length=200)
    message_col: str = Field(..., max_length=200)
    severity_col: str | None = Field(None, max_length=200)
    match_col: str | None = Field(None, max_length=200)
    match_filter: Literal["location", "camera"] | None = None
    # A column on the alert row holding a response role id (or code): the row is
    # that role's, whatever the rules say.
    role_col: str | None = Field(None, max_length=200)

    @field_validator("table_name", "ts_col", "message_col")
    @classmethod
    def _required(cls, v):
        return _clean_ident(v, required=True)

    @field_validator("severity_col", "match_col", "role_col")
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
    configured: bool
    datasource_id: int | None = None
    datasource_name: str | None = None
    table_name: str | None = None
    ts_col: str | None = None
    message_col: str | None = None
    severity_col: str | None = None
    match_col: str | None = None
    match_filter: Literal["location", "camera"] | None = None
    role_col: str | None = None
    updated_at: datetime | None = None
    # Whether the table and every named column can be read right now. Unset when
    # there is no source.
    available: bool | None = None
    reason: Reason | None = None
    detail: str | None = None


class RoleRef(BaseModel):
    # None when the alert row names a role this app has no rule for.
    id: int | None = None
    code: str
    name_th: str
    name_en: str


class AlertMessageOut(BaseModel):
    ts: datetime
    message: str
    severity: Literal["crit", "warn", "info"]
    # The cell as written, for a tooltip that wants the plant's own word.
    severity_raw: str | None = None
    # Who has to act — the row's own role tag, else the first matching rule.
    role: RoleRef | None = None


class ResponseRoleIn(BaseModel):
    code: str = Field(..., max_length=60)
    name_th: str = Field(..., max_length=120)
    name_en: str = Field(..., max_length=120)
    location: str | None = Field(None, max_length=200)
    priority: int = Field(100, ge=0, le=10_000)
    # The number an alert row's role column carries for this role. Left out on
    # create, the next free number is given; left out on update, it is kept.
    role_id: int | None = Field(None, ge=1, le=2_147_483_647)

    @field_validator("code", "name_th", "name_en")
    @classmethod
    def _required_text(cls, v):
        if not v or not v.strip():
            raise ValueError("is required")
        return v.strip()

    @field_validator("location", mode="before")
    @classmethod
    def _blank_is_any(cls, v):
        # A blank condition is no condition — "any location", not "location ''".
        return v.strip() if isinstance(v, str) and v.strip() else None


class ResponseRoleOut(ResponseRoleIn):
    id: int
    role_id: int
    updated_at: datetime | None = None


def _role_id_taken() -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT,
                         detail="That role ID is already used by another role")


class AlertMessagesOut(BaseModel):
    configured: bool
    datasource_id: int | None = None
    available: bool
    reason: Reason | None = None
    detail: str | None = None
    # Which report filter the source follows, so the client knows whether its
    # location/camera choice narrowed these or every message was returned.
    match_filter: Literal["location", "camera"] | None = None
    messages: list[AlertMessageOut] = []
    truncated: bool = False


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


def _probe(source: dict) -> tuple[bool, Reason | None, str | None]:
    """Whether the saved source can be read now: an empty window, read for real."""
    end = datetime.now().astimezone()
    try:
        db.read_alert_messages(source, end - timedelta(seconds=1), end, None, 1)
    except (ValueError, psycopg.Error, PoolTimeout) as e:
        reason, detail = _failure(e)
        return False, reason, detail
    return True, None, None


def _source_out(source: dict | None) -> dict:
    if source is None:
        return {"configured": False}
    out = {**source, "configured": True}
    out["available"], out["reason"], out["detail"] = _probe(source)
    return out


@router.get("/source", response_model=AlertSourceOut)
def get_alert_source(_user: dict = Depends(get_current_user)):
    return _source_out(db.get_alert_source())


@router.put("/source", response_model=AlertSourceOut)
def put_alert_source(body: AlertSourceIn, _admin: dict = Depends(require_admin)):
    """Save the source. Accepted whether or not its table exists yet — the answer
    says which, so the settings form can show it without refusing the save."""
    if db.get_datasource(body.datasource_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Datasource not found")
    fields = body.model_dump()
    return _source_out(db.set_alert_source(fields.pop("datasource_id"), **fields))


@router.delete("/source", status_code=status.HTTP_204_NO_CONTENT)
def delete_alert_source(_admin: dict = Depends(require_admin)):
    if not db.delete_alert_source():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alert source not found")


@router.get("/roles", response_model=list[ResponseRoleOut])
def list_roles(_user: dict = Depends(get_current_user)):
    return db.list_response_roles()


@router.post("/roles", response_model=ResponseRoleOut, status_code=status.HTTP_201_CREATED)
def create_role(body: ResponseRoleIn, _admin: dict = Depends(require_admin)):
    try:
        return db.create_response_role(**body.model_dump())
    except psycopg.errors.UniqueViolation as e:
        raise _role_id_taken() from e


@router.put("/roles/{role_id}", response_model=ResponseRoleOut)
def update_role(role_id: int, body: ResponseRoleIn, _admin: dict = Depends(require_admin)):
    try:
        row = db.update_response_role(role_id, **body.model_dump())
    except psycopg.errors.UniqueViolation as e:
        raise _role_id_taken() from e
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Response role not found")
    return row


@router.delete("/roles/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_role(role_id: int, _admin: dict = Depends(require_admin)):
    if not db.delete_response_role(role_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Response role not found")


@router.get("/messages", response_model=AlertMessagesOut)
def get_alert_messages(
    start: datetime = Query(...),
    end: datetime = Query(...),
    location: list[str] = Query([]),
    camera: list[str] = Query([]),
    limit: int = Query(MAX_MESSAGES, ge=1, le=MAX_MESSAGES),
    _user: dict = Depends(get_current_user),
):
    """The alert messages in [start, end], newest first, from the one source.

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

    source = db.get_alert_source()
    if source is None:
        return {"configured": False, "available": False, "reason": "not_configured"}
    datasource_id = source["datasource_id"]

    match_filter = source.get("match_filter")
    wanted = {"location": location, "camera": camera}.get(match_filter, []) if match_filter else []
    match_values = list(dict.fromkeys(v.strip() for v in wanted if v and v.strip()))
    if len(match_values) > MAX_MATCH_VALUES or any(len(v) > 200 for v in match_values):
        raise HTTPException(422, f"At most {MAX_MATCH_VALUES} filter values of 200 characters")

    base = {"datasource_id": datasource_id, "configured": True, "match_filter": match_filter}
    try:
        # One row past the cap, then trimmed: exactly `limit` back cannot tell a
        # window that holds `limit` messages from one that holds more.
        rows = db.read_alert_messages(source, start, end, match_values, limit + 1)
    except (ValueError, psycopg.Error, PoolTimeout) as e:
        reason, detail = _failure(e)
        if reason == "error":
            logger.warning("Alert messages for datasource %s failed: %s", datasource_id, detail)
        return {**base, "available": False, "reason": reason, "detail": detail}

    # Read once per answer: a handful of app-DB rows, and the one thing every
    # message is classified against. A failure to read them costs the roles,
    # not the messages.
    try:
        rules = db.list_response_roles()
    except psycopg.Error as e:
        logger.warning("Response roles unavailable: %s", _first_line(e))
        rules = []
    located = match_filter == "location"

    def one(r):
        severity = db.severity_of(r["severity"])
        return {
            "ts": r["ts"], "message": r["message"], "severity": severity,
            "severity_raw": r["severity"],
            "role": db.match_response_role(
                rules,
                location=r.get("match_value") if located else None,
                explicit=r.get("role_value"),
            ),
        }

    messages = [
        one(r)
        for r in rows[:limit]
        # A blank message would be a flag that says nothing. Our own table
        # refuses one (sch_vision_data.sql's guard), but a source may name any.
        if r["ts"] is not None and (r["message"] or "").strip()
    ]
    return {**base, "available": True, "messages": messages, "truncated": len(rows) > limit}
