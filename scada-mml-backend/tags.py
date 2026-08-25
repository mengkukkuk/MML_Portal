"""Status-tag endpoints — backs the live dashboard against variables_tag.

The variables_tag table is updated in place by the SCADA system (single row per
tag_name). There is no native history, so the frontend builds its own series
by polling /api/tags/latest at the panel's configured poll interval.

Reads come from the datasources the user selected in the header. The tag *name*
is not globally unique — two plants routinely both have "Pump 1" — so every row
carries its source.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict

import db
from auth import active_datasources, get_current_user
from sources import SourceReport

router = APIRouter(prefix="/api/tags", tags=["tags"])


class TagOut(BaseModel):
    tag_name: str
    datasource_id: int | None = None
    datasource_name: str | None = None


class TagLatestOut(BaseModel):
    # extra='allow' so newly-discovered numeric columns from public.variables_tag
    # pass through without a Pydantic schema change.
    model_config = ConfigDict(extra="allow")

    tag_name: str
    active: bool | None = None
    ts: datetime | None = None
    current_value: float | None = None
    current_setpoint: float | None = None
    current_high_value: float | None = None
    current_low_value: float | None = None
    datasource_id: int | None = None
    datasource_name: str | None = None


class TagsOut(BaseModel):
    tags: list[TagOut]
    sources: list[SourceReport]


class TagLatestListOut(BaseModel):
    tags: list[TagLatestOut]
    sources: list[SourceReport]


class FieldOut(BaseModel):
    field: str
    label: str


# Preserve the cosmetic labels for the four legacy options so the UI doesn't
# visually change. Newly-discovered columns are auto-humanised from their name.
_FIELD_LABEL_OVERRIDES = {
    "current_value": "Current value",
    "current_setpoint": "Setpoint",
    "current_high_value": "High limit",
    "current_low_value": "Low limit",
}


def _humanise(name: str) -> str:
    return name.replace("_", " ").strip().capitalize() or name


@router.get("", response_model=TagsOut)
def list_tags(
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Distinct tag names across the selected sources, each tagged with its own."""
    tags, reports = db.fan_out_rows(
        datasource_ids, lambda ds: db.list_tags(datasource_id=ds), label="tags"
    )
    return {"tags": tags, "sources": reports}


@router.get("/fields", response_model=list[FieldOut])
def list_fields(
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Numeric columns of variables_tag a panel can bind to.

    The **union** across sources, not the intersection: a field present in any
    selected plant has to be offerable in the editor, and a plant that lacks it
    simply returns no series for that panel. An unreachable source contributes
    nothing rather than emptying the picker.
    """
    reports = db.fan_out(
        datasource_ids, lambda ds: db.tag_fields(datasource_id=ds), label="tag fields"
    )
    seen: list[str] = []
    for report in reports:
        for field in report["result"] or ():
            if field not in seen:
                seen.append(field)
    return [
        {"field": f, "label": _FIELD_LABEL_OVERRIDES.get(f, _humanise(f))}
        for f in seen
    ]


@router.get("/latest", response_model=TagLatestListOut)
def get_latest(
    tag_name: str = Query(..., min_length=1),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Most-recent row for a tag, one entry per source that has it.

    Not a 404 when a single source lacks the tag: with several plants selected,
    "this plant has no Pump 1" is normal and must not blank the whole tile. Only
    an entirely empty result is a 404.
    """
    tags, reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: ([row] if (row := db.latest_tag(tag_name, datasource_id=ds)) else []),
        label="latest tag",
    )
    if not tags:
        # `reports` rides along even on this 404: when every source is simply
        # missing the tag the list is all-ok, but when every source failed to
        # connect it is the only place that fact survives — see schema.py's
        # `_raise_if_all_failed` for the same reasoning.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "No data for that tag", "sources": reports},
        )
    return {"tags": tags, "sources": reports}
