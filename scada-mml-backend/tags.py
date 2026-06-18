"""Status-tag endpoints — backs the live dashboard against public.status_tag.

The status_tag table is updated in place by the SCADA system (single row per
tag_name). There is no native history, so the frontend builds its own series
by polling /api/tags/latest at the panel's configured poll interval.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

import db
from auth import get_current_user

router = APIRouter(prefix="/api/tags", tags=["tags"])


class TagOut(BaseModel):
    tag_name: str


class TagLatestOut(BaseModel):
    tag_name: str
    active: bool | None = None
    ts: datetime | None = None
    current_value: float | None = None
    current_setpoint: float | None = None
    current_high_value: float | None = None
    current_low_value: float | None = None


class FieldOut(BaseModel):
    field: str
    label: str


_FIELD_LABELS = {
    "current_value": "Current value",
    "current_setpoint": "Setpoint",
    "current_high_value": "High limit",
    "current_low_value": "Low limit",
}


@router.get("", response_model=list[TagOut])
def list_tags(_user: dict = Depends(get_current_user)):
    """All distinct tag names available in public.status_tag."""
    return db.list_tags()


@router.get("/fields", response_model=list[FieldOut])
def list_fields(_user: dict = Depends(get_current_user)):
    """The four numeric columns a panel can bind to."""
    return [{"field": f, "label": _FIELD_LABELS[f]} for f in db.TAG_FIELDS]


@router.get("/latest", response_model=TagLatestOut)
def get_latest(
    tag_name: str = Query(..., min_length=1),
    _user: dict = Depends(get_current_user),
):
    """Most-recent row for a tag — all four value columns + update_at + active."""
    row = db.latest_tag(tag_name)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No data for that tag",
        )
    return row
