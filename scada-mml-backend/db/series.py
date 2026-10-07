"""Windowed series queries over plant tables, and the production-log aggregation."""

from datetime import datetime, timezone
import math
from typing import Any

from psycopg import sql

from production_log import aggregate_counter_samples, aggregate_counter_series, aggregate_hourly_totals

from . import tables as _tables
from . import tags as _tags

__all__ = [
    "_is_orderable_reading",
    "_series_window_query",
    "production_log_hourly",
    "series_step",
    "table_rows",
    "table_series",
]

def _series_window_query(
    columns: dict[str, str],
    schema: str,
    table: str,
    value_col: str,
    filter_col: str | None,
    filter_val: str | None,
    ts_col: str,
    minutes: int,
    start: datetime | None,
    end: datetime | None,
) -> tuple[sql.Composed, list[Any]]:
    """`SELECT value, ts` over the window and filter — shared by every series read.

    Explicit aware bounds win over `minutes`. A naive plant column is compared
    in the connection's timezone, converting the bounds rather than the indexed
    column so the index still applies.
    """
    timestamp = sql.Identifier(ts_col)
    if start is not None and columns[ts_col] == "timestamp without time zone":
        timestamp = sql.SQL("({} AT TIME ZONE current_setting('TimeZone'))").format(timestamp)
    query = sql.SQL(
        "SELECT {val} AS value, {ts} AS ts FROM {tbl} WHERE {ts} >= "
        "now() - make_interval(mins => %s)"
    ).format(
        val=sql.Identifier(value_col),
        ts=timestamp,
        tbl=sql.Identifier(schema, table),
    )
    params: list[Any] = [minutes]
    if start is not None:
        bound = sql.SQL("%s")
        if columns[ts_col] == "timestamp without time zone":
            bound = sql.SQL("(%s::timestamptz AT TIME ZONE current_setting('TimeZone'))")
        query = sql.SQL(
            "SELECT {val} AS value, {ts} AS ts FROM {tbl} "
            "WHERE {clock} >= {bound} AND {clock} <= {bound}"
        ).format(val=sql.Identifier(value_col), ts=timestamp,
                 tbl=sql.Identifier(schema, table), clock=sql.Identifier(ts_col), bound=bound)
        params = [start, end]
    if filter_col and filter_val is not None:
        query += sql.SQL(" AND {}::text = %s").format(sql.Identifier(filter_col))
        params.append(filter_val)
    return query, params


def _is_orderable_reading(data_type: str) -> bool:
    """Whether a value column can be ranked per bucket (min/max thinning).

    Numbers, booleans and numeric arrays — the readings a trend plots. Postgres
    orders an array element by element, so slot 0 (the measured value) leads.
    """
    return (
        data_type in _tags._NUMERIC_TYPES
        or data_type in _tables._BOOL_TYPES
        or data_type in _tables._NUMERIC_ARRAY_UDTS
    )


def series_step(
    table: str,
    value_col: str,
    filter_col: str | None,
    filter_val: str | None,
    ts_col: str,
    minutes: int,
    datasource_id: int | None = None,
    *,
    limit: int,
    start: datetime | None = None,
    end: datetime | None = None,
    floor_seconds: int = 1,
) -> int | None:
    """Bucket size, in seconds, that fits the window's *actual* rows under `limit`.

    `None` means no thinning: the rows already fit, so the chart gets every one
    of them. A year-long window over a table that only started logging a month
    ago used to be cut into buckets sized for the whole year, leaving a few dozen
    points where thousands of real rows existed. Sizing by the span the data
    occupies (first row to last) instead keeps the resolution where the data is.

    Two points survive per bucket (lowest and highest reading, see table_series),
    hence the halving. variables_tag served from the in-memory buffer is already
    small and takes no thinning.
    """
    if (
        table == "variables_tag"
        and filter_col == "tag_name"
        and filter_val is not None
        and _tags.is_tag_buffered(datasource_id)
        and value_col in _tags.tag_fields(datasource_id)
    ):
        return None
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        columns = _tables._safe_identifiers(conn, schema, table, value_col, filter_col, ts_col)
        query, params = _series_window_query(
            columns, schema, table, value_col, filter_col, filter_val, ts_col,
            minutes, start, end)
        row = conn.execute(
            sql.SQL("SELECT count(*) AS n, min(e.ts) AS lo, max(e.ts) AS hi FROM (")
            + query + sql.SQL(") AS e"),
            params,
        ).fetchone()
    count, first, last = row["n"], row["lo"], row["hi"]
    if count <= limit or first is None:
        return None
    # `limit // 2 - 1` buckets, plus the one a boundary can add, at two rows each.
    buckets = max(1, limit // 2 - 1)
    span = max((last - first).total_seconds(), 1)
    return max(floor_seconds, math.ceil(span / buckets))


def table_series(
    table: str,
    value_col: str,
    filter_col: str | None,
    filter_val: str | None,
    ts_col: str,
    minutes: int,
    datasource_id: int | None = None,
    limit: int | None = None,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
    sample_seconds: int | None = None,
) -> list[dict[str, Any]]:
    """Time-ordered rows in explicit bounds, or over the last `minutes`.

    `sample_seconds` thins the window to the rows holding the lowest and the
    highest reading in each bucket of that many seconds (see `series_step` for
    sizing it). It is how a year-long window draws the whole year: capping the
    newest N rows instead would show a year chart holding only its last days.
    Real rows rather than an average, because a value may be a numeric array (a
    reading with its setpoint and limits) that has no single mean, and because
    an average would flatten the spikes. A column with no ordering (text) keeps
    its newest row per bucket.

    Explicit bounds are aware datetimes validated by the series route. Naive
    plant columns use the connection's timezone and are returned as instants.

    variables_tag is a special case: it has no real row history (overwritten
    in place — see snapshot_variables_tag's docstring), so a panel bound
    directly to it and filtered by tag_name is served from the in-memory buffer
    instead of the table's always-≤1-row SQL query.

    Gated on the source actually being sampled, not on it being the app DB: a
    source the buffer loop never polls would otherwise render a permanently
    blank chart, which is worse than a slower live query returning one point.

    `limit` caps the result at the *newest* N rows. Omitted, the SQL is exactly
    what it always was — a Live tile asks for minutes, not rows, and a
    quarter-hour window needs no ceiling. It exists because the window is now
    selectable up to a week, and a week of a fast-logging table is unbounded.
    """
    if (
        table == "variables_tag"
        and filter_col == "tag_name"
        and filter_val is not None
        and _tags.is_tag_buffered(datasource_id)
        # The buffer only carries the fields discovery found, and discovery is
        # numeric-scalar only — an array column is invisible to it. Serving one
        # from here would answer every request with an empty series, forever and
        # without an error, which is strictly worse than the live query this
        # short-circuit exists to improve on.
        and value_col in _tags.tag_fields(datasource_id)
    ):
        if start is None:
            return _tags.buffered_tag_series(filter_val, value_col, minutes, datasource_id)
        # Explicit historical bounds must include samples older than the usual
        # relative window, while still using the source's sampled history.
        buffered_minutes = max(1, int((datetime.now(timezone.utc) - start).total_seconds() / 60) + 1)
        rows = [r for r in _tags.buffered_tag_series(filter_val, value_col, buffered_minutes, datasource_id)
                if start <= r["ts"] <= end]
        return rows[-limit:] if limit else rows
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        columns = _tables._safe_identifiers(conn, schema, table, value_col, filter_col, ts_col)
        query, params = _series_window_query(
            columns, schema, table, value_col, filter_col, filter_val, ts_col,
            minutes, start, end)
        if sample_seconds:
            if _is_orderable_reading(columns[value_col]):
                # Each bucket keeps the rows holding its lowest and highest
                # reading, not just its newest: a counter that spikes for a few
                # seconds is exactly what a year chart is opened to find, and
                # one-row-per-bucket drew it only when the spike happened to be
                # the last row of its bucket. Ordering by the raw value also
                # orders a numeric array (slot 0 first — the measured value),
                # and ties fall to the newest row.
                query = (
                    sql.SQL("SELECT w.value, w.ts FROM (SELECT q.value, q.ts, "
                            "row_number() OVER (PARTITION BY q.bucket "
                            "ORDER BY q.value ASC NULLS LAST, q.ts DESC) AS lo_rank, "
                            "row_number() OVER (PARTITION BY q.bucket "
                            "ORDER BY q.value DESC NULLS LAST, q.ts DESC) AS hi_rank "
                            "FROM (SELECT s.value, s.ts, "
                            "floor(extract(epoch FROM s.ts) / %s) AS bucket FROM (")
                    + query
                    + sql.SQL(") AS s) AS q) AS w WHERE w.lo_rank = 1 OR w.hi_rank = 1 "
                              "ORDER BY w.ts ASC")
                )
            else:
                # No ordering to take extremes by (text, json…): the newest row.
                query = (
                    sql.SQL("SELECT w.value, w.ts FROM (SELECT DISTINCT ON (bucket) q.value, q.ts, "
                            "floor(extract(epoch FROM q.ts) / %s) AS bucket FROM (")
                    + query
                    + sql.SQL(") AS q ORDER BY bucket, q.ts DESC) AS w ORDER BY w.ts ASC")
                )
            # No LIMIT: the caller sizes the bucket so the result already fits,
            # and a LIMIT on this ascending order would clip the newest end.
            params = [sample_seconds, *params]
        elif limit is None:
            query += sql.SQL(" ORDER BY {} ASC").format(sql.Identifier(ts_col))
        else:
            # Newest N, then put them back in reading order. Keeping the *oldest*
            # N would clip the right-hand edge — the end a trend is read from.
            query = (
                sql.SQL("SELECT w.value, w.ts FROM (")
                + query
                + sql.SQL(" ORDER BY {} DESC LIMIT %s) AS w ORDER BY w.ts ASC").format(
                    sql.Identifier(ts_col)
                )
            )
            params.append(limit)
        rows = conn.execute(query, params).fetchall()
    return rows


def production_log_hourly(
    binding: dict[str, Any], datasource_id: int | None = None
) -> dict[str, Any]:
    """Hourly good/reject counter deltas for the current plant-local shift.

    Two plant layouts reach this, told apart by whether the binding carries a
    filter value *per counter*:

    - **Wide** — one row per sample with a good column and a reject column side
      by side, optionally narrowed by one shared filter. The original layout.
    - **Tag-per-row (EAV)** — both counters in the same value column of the same
      table, told apart by a tag column: `produced_filter_val` and
      `rejected_filter_val` name the two tags. This is what a historian keyed by
      tag name gives you, and no shared-filter binding can express it, because
      the two counters need *different* values of the same column.
    - **Hourly totals** (`mode: "hourly"`) — a log table with one row per hour
      whose timestamp is the hour's start and whose columns already hold that
      hour's count and defect totals. Summed per hour, never differenced.

    For the counter layouts, one sample immediately before 08:00 is included as each counter's baseline.
    The pure aggregator owns reset semantics; this adapter owns identifier
    safety and reading from the configured plant connection.
    """
    table = binding["table"]
    ts_col = binding["ts_col"]
    produced_col = binding["produced_col"]
    rejected_col = binding["rejected_col"]
    filter_col = binding.get("filter_col")
    filter_val = binding.get("filter_val")
    produced_filter_val = binding.get("produced_filter_val")
    rejected_filter_val = binding.get("rejected_filter_val")
    per_counter = produced_filter_val is not None and rejected_filter_val is not None
    hourly = binding.get("mode") == "hourly"

    with _tables._table_source_conn(datasource_id) as (conn, schema):
        # Identifier validation below queries information_schema, so establish
        # the request snapshot before even that first read.
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        _tables._safe_identifiers(
            conn, schema, table, ts_col, produced_col, rejected_col, filter_col
        )
        table_sql = sql.Identifier(schema, table)

        # Keep every read on one database snapshot, and use the captured plant
        # timestamp as the upper bound.  That prevents future-dated rows (or
        # rows committed halfway through this request) from leaking into a
        # bucket that the response still describes as a current snapshot.
        generated_at = conn.execute("SELECT now() AS generated_at").fetchone()["generated_at"]

        def read(fields: sql.SQL, value: Any) -> tuple[Any, list[Any]]:
            """One counter's baseline row and in-shift rows, on this snapshot."""
            where = sql.SQL("")
            params: list[Any] = []
            if filter_col and value is not None:
                where = sql.SQL(" AND {}::text = %s").format(sql.Identifier(filter_col))
                params.append(value)
            baseline = conn.execute(
                sql.SQL(
                    "SELECT {fields} FROM {table} "
                    "WHERE {ts} < CURRENT_DATE + time '08:00'{filter} "
                    "ORDER BY {ts} DESC NULLS LAST LIMIT 1"
                ).format(
                    fields=fields, table=table_sql, ts=sql.Identifier(ts_col), filter=where,
                ),
                params,
            ).fetchone()
            rows = conn.execute(
                sql.SQL(
                    "SELECT {fields} FROM {table} "
                    "WHERE {ts} >= CURRENT_DATE + time '08:00' "
                    "AND {ts} < CURRENT_DATE + time '18:00' "
                    "AND {ts} <= %s{filter} "
                    "ORDER BY {ts} ASC"
                ).format(
                    fields=fields, table=table_sql, ts=sql.Identifier(ts_col), filter=where,
                ),
                [generated_at, *params],
            ).fetchall()
            return baseline, list(rows)

        def one(col: str) -> sql.SQL:
            return sql.SQL("{ts} AS ts, {value} AS value").format(
                ts=sql.Identifier(ts_col), value=sql.Identifier(col),
            )

        if hourly:
            # Already one row per hour: no baseline row, nothing to difference.
            where = sql.SQL("")
            params: list[Any] = []
            if filter_col and filter_val is not None:
                where = sql.SQL(" AND {}::text = %s").format(sql.Identifier(filter_col))
                params.append(filter_val)
            rows = conn.execute(
                sql.SQL(
                    "SELECT {ts} AS ts, {produced} AS produced, {rejected} AS rejected "
                    "FROM {table} "
                    "WHERE {ts} >= CURRENT_DATE + time '08:00' "
                    "AND {ts} < CURRENT_DATE + time '18:00' "
                    "AND {ts} <= %s{filter} "
                    "ORDER BY {ts} ASC"
                ).format(
                    ts=sql.Identifier(ts_col),
                    produced=sql.Identifier(produced_col),
                    rejected=sql.Identifier(rejected_col),
                    table=table_sql,
                    filter=where,
                ),
                [generated_at, *params],
            ).fetchall()
        elif per_counter:
            produced_baseline, produced_rows = read(one(produced_col), produced_filter_val)
            rejected_baseline, rejected_rows = read(one(rejected_col), rejected_filter_val)
        else:
            both = sql.SQL(
                "{ts} AS ts, {produced} AS produced, {rejected} AS rejected"
            ).format(
                ts=sql.Identifier(ts_col),
                produced=sql.Identifier(produced_col),
                rejected=sql.Identifier(rejected_col),
            )
            baseline, rows = read(both, filter_val)

    if hourly:
        return aggregate_hourly_totals(rows, generated_at)
    if per_counter:
        return aggregate_counter_series(
            ([produced_baseline] if produced_baseline else []) + produced_rows,
            ([rejected_baseline] if rejected_baseline else []) + rejected_rows,
            generated_at,
        )
    samples = ([baseline] if baseline else []) + rows
    return aggregate_counter_samples(samples, generated_at)


def table_rows(
    table: str,
    columns: list[str],
    filter_col: str | None,
    filter_val: str | None,
    ts_col: str | None,
    limit: int,
    datasource_id: int | None = None,
) -> list[dict[str, Any]]:
    """The newest `limit` rows of a table, projected onto `columns`.

    The wide sibling of `table_latest`: that answers "what does this one column
    read now", this answers "what do the last few rows say", which is what a
    mimic's table symbol draws. Every column goes through the same
    `_safe_identifiers` allowlist gate as a single-column read, so widening the
    projection widens nothing about what may be reached.

    Ordering needs a timestamp column. Without one the table has no newest row
    to speak of, so the rows arrive in whatever order the plant's storage hands
    them over — which is the honest answer for a current-state table that holds
    one row per device.
    """
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        _tables._safe_identifiers(conn, schema, table, *columns, filter_col, ts_col)
        query = sql.SQL("SELECT {cols} FROM {tbl}").format(
            cols=sql.SQL(", ").join(sql.Identifier(c) for c in columns),
            tbl=sql.Identifier(schema, table),
        )
        params: list[Any] = []
        if filter_col and filter_val is not None:
            query += sql.SQL(" WHERE {}::text = %s").format(sql.Identifier(filter_col))
            params.append(filter_val)
        if ts_col:
            query += sql.SQL(" ORDER BY {} DESC NULLS LAST").format(sql.Identifier(ts_col))
        query += sql.SQL(" LIMIT %s")
        params.append(limit)
        rows = conn.execute(query, params).fetchall()
    return rows
