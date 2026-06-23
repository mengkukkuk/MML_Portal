"""Schema-introspection endpoints — back the generic table data source.

Admins can bind a Live panel to any numeric column of any non-sensitive public
table. These read-only endpoints expose the table/column catalogue and the
live values so the editor can build its pickers and each tile can poll.

Security: table/column names are SQL identifiers validated against an
information_schema allowlist in db.py (sensitive tables are denylisted there);
filter values are always parameterized.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

import db
from auth import get_current_user

router = APIRouter(prefix="/api/schema", tags=["schema"])


class TableOut(BaseModel):
    table: str
    label: str


class ColumnsOut(BaseModel):
    value_columns: list[str]
    ts_columns: list[str]
    filter_columns: list[str]


class LatestOut(BaseModel):
    value: float | None = None
    ts: datetime | None = None


class Point(BaseModel):
    ts: datetime
    value: float


class SeriesOut(BaseModel):
    points: list[Point]


@router.get("/tables", response_model=list[TableOut])
def list_tables(_user: dict = Depends(get_current_user)):
    """Public base tables an admin may chart (sensitive tables excluded)."""
    return db.list_schema_tables()


@router.get("/columns", response_model=ColumnsOut)
def list_columns(
    table: str = Query(..., min_length=1),
    _user: dict = Depends(get_current_user),
):
    """Columns of a table, categorized into value / timestamp / filter."""
    try:
        return db.describe_table(table)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/values", response_model=list[str])
def list_values(
    table: str = Query(..., min_length=1),
    column: str = Query(..., min_length=1),
    limit: int = Query(500, ge=1, le=2000),
    _user: dict = Depends(get_current_user),
):
    """Distinct values of a filter column — populates the per-series dropdown."""
    try:
        return db.distinct_column_values(table, column, limit)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get("/latest", response_model=LatestOut)
def get_latest(
    table: str = Query(..., min_length=1),
    value_col: str = Query(..., min_length=1),
    filter_col: str | None = Query(None),
    filter_val: str | None = Query(None),
    ts_col: str | None = Query(None),
    _user: dict = Depends(get_current_user),
):
    """Newest matching row — polled by each tile."""
    try:
        row = db.table_latest(table, value_col, filter_col, filter_val, ts_col)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No matching row"
        )
    return row


@router.get("/series", response_model=SeriesOut)
def get_series(
    table: str = Query(..., min_length=1),
    value_col: str = Query(..., min_length=1),
    ts_col: str = Query(..., min_length=1),
    filter_col: str | None = Query(None),
    filter_val: str | None = Query(None),
    minutes: int = Query(15, ge=1, le=1440),
    _user: dict = Depends(get_current_user),
):
    """Time-series window — seeds real history on load (needs a timestamp col)."""
    try:
        rows = db.table_series(table, value_col, filter_col, filter_val, ts_col, minutes)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    points = [{"ts": r["ts"], "value": r["value"]} for r in rows if r["value"] is not None]
    return {"points": points}
