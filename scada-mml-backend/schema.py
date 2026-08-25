"""Schema-introspection endpoints — back the generic table data source.

Admins can bind a Live panel to any numeric column of any non-sensitive table.
These read-only endpoints expose the table/column catalogue and the live values
so the editor can build its pickers and each tile can poll.

Two kinds of route live here, and they treat `datasource_id` differently:

* **Catalogue** (`/tables`, `/columns`, `/values`) still honours an explicit
  `datasource_id`, because the panel editor legitimately browses a connection
  the operator has not selected. Omitting it now means *the first active source*
  rather than the app database — the config database has no plant tables to
  offer, so the old default could only ever produce an empty picker.
* **Data** (`/latest`, `/series`) ignores `datasource_id` entirely and fans out
  over the header selection. That is the whole point of the header: a dashboard
  becomes portable, and the same layout can be pointed at another plant without
  editing every panel.

Security: table/column names are SQL identifiers validated against an
information_schema allowlist in db.py, per connection, so a plant database's own
catalogue governs what may be read from it (sensitive tables are denylisted
there); filter values are always parameterized.
"""
from datetime import datetime

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

import db
from auth import active_datasources, get_current_user
from licensing import require_valid_license
from sources import SourceReport

router = APIRouter(
    prefix="/api/schema",
    tags=["schema"],
    dependencies=[Depends(require_valid_license)],
)


def _detail(e: Exception) -> str:
    """First line of an error — trims psycopg's multi-line connection messages."""
    text = str(e).strip()
    return text.splitlines()[0] if text else "Database error"


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
    datasource_id: int | None = None
    datasource_name: str | None = None


class LatestListOut(BaseModel):
    readings: list[LatestOut]
    sources: list[SourceReport]


class Point(BaseModel):
    ts: datetime
    value: float


class SeriesOut(BaseModel):
    points: list[Point]
    datasource_id: int | None = None
    datasource_name: str | None = None


class SeriesListOut(BaseModel):
    series: list[SeriesOut]
    sources: list[SourceReport]


def _catalogue_source(explicit: int | None, active: list[int | None]) -> int | None:
    """Which connection a catalogue route browses.

    An explicit id wins — the panel editor's connection dropdown is how an admin
    inspects a source before selecting it. Otherwise the first active source,
    because the app database holds configuration and would list no plant tables.
    """
    return explicit if explicit is not None else active[0]


@router.get("/tables", response_model=list[TableOut])
def list_tables(
    datasource_id: int | None = Query(None),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Base tables an admin may chart (sensitive tables excluded)."""
    try:
        return db.list_schema_tables(_catalogue_source(datasource_id, datasource_ids))
    except (ValueError, psycopg.Error) as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_detail(e))


@router.get("/columns", response_model=ColumnsOut)
def list_columns(
    table: str = Query(..., min_length=1),
    datasource_id: int | None = Query(None),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Columns of a table, categorized into value / timestamp / filter."""
    try:
        return db.describe_table(table, _catalogue_source(datasource_id, datasource_ids))
    except (ValueError, psycopg.Error) as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_detail(e))


@router.get("/values", response_model=list[str])
def list_values(
    table: str = Query(..., min_length=1),
    column: str = Query(..., min_length=1),
    limit: int = Query(500, ge=1, le=2000),
    datasource_id: int | None = Query(None),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Distinct values of a filter column — populates the per-series dropdown."""
    try:
        return db.distinct_column_values(
            table, column, limit, _catalogue_source(datasource_id, datasource_ids)
        )
    except (ValueError, psycopg.Error) as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_detail(e))


@router.get("/latest", response_model=LatestListOut)
def get_latest(
    table: str = Query(..., min_length=1),
    value_col: str = Query(..., min_length=1),
    filter_col: str | None = Query(None),
    filter_val: str | None = Query(None),
    ts_col: str | None = Query(None),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Newest matching row per selected source — polled by each tile.

    A bad table/column name is a 400 from every source at once, so it is
    reported as one: `fan_out` would otherwise reduce a genuine
    misconfiguration to N identical per-source warnings and a 200 with no rows.
    """
    readings, reports = db.fan_out_rows(
        datasource_ids,
        lambda ds: (
            [row] if (row := db.table_latest(
                table, value_col, filter_col, filter_val, ts_col, ds)) else []
        ),
        label="table latest",
    )
    if not readings:
        _raise_if_all_failed(reports)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "No matching row", "sources": reports},
        )
    return {"readings": readings, "sources": reports}


@router.get("/series", response_model=SeriesListOut)
def get_series(
    table: str = Query(..., min_length=1),
    value_col: str = Query(..., min_length=1),
    ts_col: str = Query(..., min_length=1),
    filter_col: str | None = Query(None),
    filter_val: str | None = Query(None),
    minutes: int = Query(15, ge=1, le=10080),
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """One time-series window per source — seeds real history on load."""
    def one(ds):
        rows = db.table_series(table, value_col, filter_col, filter_val, ts_col,
                               minutes, ds)
        return [{"points": [{"ts": r["ts"], "value": r["value"]}
                            for r in rows if r["value"] is not None]}]

    series, reports = db.fan_out_rows(datasource_ids, one, label="table series")
    if not series:
        _raise_if_all_failed(reports)
    return {"series": series, "sources": reports}


def _raise_if_all_failed(reports: list[dict]) -> None:
    """Surface a misconfigured panel as a 400 instead of a silent empty chart.

    Only when *every* source failed: one plant missing the table while another
    has it is a partial result the tile should render, not an error.

    The per-source `reports` ride along in `detail` rather than being reduced
    to `reports[0]["error"]` alone: "every source failed" is indistinguishable
    from "one source is down" only if the caller can still see *which* source
    and why, and this is the one path where that would otherwise be lost —
    every other response shape carries `sources` alongside its data.
    """
    if reports and all(not r["ok"] for r in reports):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": reports[0]["error"], "sources": reports},
        )
