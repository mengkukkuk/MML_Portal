"""Plant-table access: schema introspection, the per-source connection, latest values."""

from contextlib import contextmanager
import logging
from typing import Any

from psycopg import sql
import psycopg
from psycopg_pool import PoolTimeout

import config

from . import pool as _pool
from . import tags as _tags

logger = logging.getLogger("mml-api.db")

__all__ = [
    "SENSITIVE_TABLES",
    "_BOOL_TYPES",
    "_DATETIME_TYPES",
    "_NUMERIC_ARRAY_UDTS",
    "_TEXT_TYPES",
    "_TS_TYPES",
    "_TYPE_BADGES",
    "_allowed_tables",
    "_is_array_type",
    "_primary_key_columns",
    "_safe_identifiers",
    "_table_columns",
    "_table_source_conn",
    "_type_badge",
    "describe_table",
    "distinct_column_values",
    "list_schema_tables",
    "table_latest",
]

# --- Generic table data-source (source='table') -----------------------------
# Admins can bind a panel to any numeric column of any non-sensitive public
# table. Table/column names are SQL *identifiers* and cannot be parameterized,
# so every identifier is validated against an information_schema allowlist and
# composed with psycopg.sql.Identifier — never string-interpolated. Filter
# *values* are always passed as %s params.

# Tables never exposed to the picker (credentials / app-internal state).
# `datasources` holds saved connection passwords — must never be chartable, or a
# text filter column could leak secrets via distinct_column_values.
SENSITIVE_TABLES = {
    "users", "dashboard_panels", "mmldatabuffer", "datasources", "mimic_layouts",
    "mimic_assets", "mimic_symbols", "cameras",
}

# Postgres text data_types a symbol may *print* rather than plot.
#
# Separate from _NUMERIC_TYPES rather than folded into it: a chart, a gauge and
# a threshold all need a number, so widening the one list every picker reads
# would offer a status column to a trend panel that cannot draw it. These are
# reported alongside instead, and each caller decides whether it can render one.
_TEXT_TYPES = (
    "text",
    "character varying",
    "character",
)

# Postgres boolean data_types a picker may offer as a value/metric source.
#
# Separate from _NUMERIC_TYPES for the opposite reason _TEXT_TYPES is separate:
# a flag *can* be plotted -- it is reported as 0/1 and draws a perfectly good
# step line -- but it is not a measurement. A gauge scaled 0-100, a production
# counter's delta and a warn/crit threshold all mean something different against
# a flag than against a reading, and the editor can only say so if the kind
# survives to the client. Folding booleans into value_columns would erase it.
_BOOL_TYPES = ("boolean",)

# Postgres array udt_names whose *elements* are numeric -- see _table_columns,
# which substitutes udt_name for the useless 'ARRAY' data_type.
#
# Reported separately from _NUMERIC_TYPES for the same reason _TEXT_TYPES is: a
# gauge, a threshold and a Live trend all need one number, and folding arrays
# into the list every picker reads would offer a four-slot column to a tile that
# can only draw a scalar. The consumer that understands array semantics asks for
# them by name.
_NUMERIC_ARRAY_UDTS = (
    "_float4",
    "_float8",
    "_int2",
    "_int4",
    "_int8",
    "_numeric",
)


def _is_array_type(data_type: str) -> bool:
    """Whether a type string from `_table_columns` denotes an array.

    Relies on that function's udt_name substitution: Postgres names every array
    type after its element with a leading underscore, and no scalar data_type
    starts with one. Broader than _NUMERIC_ARRAY_UDTS on purpose — a text[] is
    no more usable as a filter than a float[] is, and asking
    distinct_column_values for one returns literal '{a,b,c}' strings.
    """
    return data_type.startswith("_")


# Short type tokens the column pickers print beside a column name, so an admin
# can tell a counter from a flag from a timestamp before binding one.
#
# A projection for display only. `_table_columns` keeps returning raw
# information_schema `data_type` strings, because `table_series` compares them
# literally ("timestamp without time zone") to decide whether a naive column
# needs converting -- substituting tokens at the source would break that
# silently.
_TYPE_BADGES = {
    "smallint": "int2",
    "integer": "int4",
    "bigint": "int8",
    "real": "float4",
    "double precision": "float8",
    "numeric": "numeric",
    "decimal": "numeric",
    "boolean": "bool",
    "text": "text",
    "character varying": "varchar",
    "character": "char",
    "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp",
    "date": "date",
    "time with time zone": "timetz",
    "time without time zone": "time",
}


def _type_badge(data_type: str) -> str:
    """A short display token for one column's type.

    Unknown types pass through verbatim rather than becoming an empty string:
    a plant with an enum or a domain type should read "mood" in the picker, not
    nothing at all. Arrays are rendered from their element type, relying on
    `_table_columns`' udt_name substitution ('_float8' -> 'float8[]').
    """
    if data_type.startswith("_"):
        element = data_type[1:]
        return f"{_TYPE_BADGES.get(element, element)}[]"
    return _TYPE_BADGES.get(data_type, data_type)


# Postgres date/time data_types usable as a panel's timestamp/x-axis column.
_TS_TYPES = (
    "timestamp without time zone",
    "timestamp with time zone",
    "date",
    "time without time zone",
    "time with time zone",
)

# Production-log shift arithmetic needs a full calendar timestamp.  Keep the
# broader ``ts_columns`` catalogue for existing panels (which may legitimately
# chart dates or clock times), and expose this narrower subset to consumers
# that compare values with concrete shift boundaries.
_DATETIME_TYPES = (
    "timestamp without time zone",
    "timestamp with time zone",
)


@contextmanager
def _table_source_conn(datasource_id: int | None):
    """Yield ``(conn, schema)`` for every *plant data* query.

    ``None`` → the app database + the ``public`` schema. Otherwise a pooled
    connection to the saved datasource, using its configured schema. Raises
    ``ValueError`` if the datasource id is unknown; ``psycopg.Error`` and
    ``PoolTimeout`` propagate when it can't be reached so ``fan_out`` can record
    the failure against that one source. ``get_datasource_secret`` is defined
    later in this module — fine, it's only referenced at call time.
    """
    if datasource_id is None:
        with _pool.get_connection() as conn:
            yield conn, config.APP_DB_SCHEMA
        return
    # Resolve the pool *before* claiming the probe. _pool_for raises ValueError
    # for an unknown id, and a claim made above it would never be released --
    # wedging that id into fast-fail for the life of the process.
    pool = _pool._pool_for(datasource_id)
    # Read the schema after _pool_for, which is what populates it.
    schema = _pool._pool_schemas.get(datasource_id, "public")
    # Raised as OperationalError, not a bespoke type, because that is what this
    # is -- and because every caller and test already handles it.
    if not _pool._claim_probe(datasource_id):
        raise psycopg.OperationalError(
            _pool._ds_errors.get(datasource_id) or f"datasource {datasource_id} unreachable"
        )
    unreachable: Exception | None = None
    try:
        with pool.connection() as conn:
            yield conn, schema
    except (psycopg.OperationalError, PoolTimeout) as e:
        unreachable = e
        raise
    finally:
        # A `finally`, not a pair of except arms: a BaseException — a cancelled
        # task, a KeyboardInterrupt — is not an `except Exception`, and letting
        # one skip the release would leave this source claimed as "probe in
        # flight" forever, fast-failing every later request against a host that
        # is perfectly healthy.
        if unreachable is not None:
            detail = _pool._first_line(unreachable) or repr(unreachable)
            _pool._ds_errors[datasource_id] = detail
            _pool._probe_done(datasource_id, ok=False)
            if datasource_id not in _pool._outage_logged:
                logger.warning("Datasource %s unreachable: %s", datasource_id, detail)
                _pool._outage_logged.add(datasource_id)
        else:
            # Every other outcome means the host answered — including a query
            # fault (missing table, bad column, denied identifier), which says
            # nothing about reachability. Recording those as down would
            # fast-fail every other panel on this source and keep the tag buffer
            # parked on evidence of nothing.
            _pool._mark_reachable(datasource_id)


def _allowed_tables(conn, schema: str) -> set[str]:
    """Chartable base-table names in ``schema`` (minus the sensitive denylist)."""
    rows = conn.execute(
        """SELECT table_name FROM information_schema.tables
           WHERE table_schema = %s AND table_type = 'BASE TABLE'""",
        (schema,),
    ).fetchall()
    return {r["table_name"] for r in rows if r["table_name"] not in SENSITIVE_TABLES}


def list_schema_tables(datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Base tables an admin may chart, minus the sensitive denylist."""
    with _table_source_conn(datasource_id) as (conn, schema):
        names = sorted(_allowed_tables(conn, schema))
    return [{"table": n, "label": n} for n in names]


def _table_columns(conn, schema: str, table: str) -> dict[str, str]:
    """{column_name: data_type} for an allowlisted table in ``schema``.

    Validation gate for all dynamic-SQL builders: raises ValueError if the table
    is not in the (denylist-filtered) allowlist, so a caller can never reference
    an arbitrary or sensitive table.
    """
    if table not in _allowed_tables(conn, schema):
        raise ValueError(f"Table not allowed: {table!r}")
    rows = conn.execute(
        """SELECT column_name, data_type, udt_name
           FROM information_schema.columns
           WHERE table_schema = %s AND table_name = %s
           ORDER BY ordinal_position""",
        (schema, table),
    ).fetchall()
    # information_schema reports every array as the bare string 'ARRAY' -- the
    # element type only survives in udt_name ('_float8', '_int4'). Substituting
    # it keeps the flat {col: type} shape every caller already expects while
    # making an array distinguishable from any other, so describe_table can
    # categorize it instead of sweeping it into the leftovers.
    return {
        r["column_name"]: (r["udt_name"] if r["data_type"] == "ARRAY" else r["data_type"])
        for r in rows
    }


def _safe_identifiers(conn, schema: str, table: str, *cols: str | None) -> dict[str, str]:
    """Validate table + columns; return the table's {col: type} map.

    Each non-None column must exist on the table. Raises ValueError otherwise.
    """
    columns = _table_columns(conn, schema, table)
    for c in cols:
        if c is not None and c not in columns:
            raise ValueError(f"Column not in {table!r}: {c!r}")
    return columns


def _primary_key_columns(conn, schema: str, table: str) -> set[str]:
    """Primary-key column names for a table (used to drop id-like cols)."""
    rows = conn.execute(
        """SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema   = tc.table_schema
            AND kcu.table_name     = tc.table_name
           WHERE tc.table_schema = %s
             AND tc.table_name   = %s
             AND tc.constraint_type = 'PRIMARY KEY'""",
        (schema, table),
    ).fetchall()
    return {r["column_name"] for r in rows}


def describe_table(table: str, datasource_id: int | None = None) -> dict[str, Any]:
    """Categorize a table's columns for the panel editor's pickers."""
    with _table_source_conn(datasource_id) as (conn, schema):
        columns = _table_columns(conn, schema, table)
        # Numeric columns are chartable values, but a surrogate key identifies
        # rows, not a metric — exclude PK columns and any column conventionally
        # named `id` (some SCADA log tables carry an `id` with no PK constraint).
        skip = _primary_key_columns(conn, schema, table) | {"id"}
    value_columns = [c for c, t in columns.items() if t in _tags._NUMERIC_TYPES and c not in skip]
    # A numeric array is one column carrying several related readings -- a
    # measured value with its setpoint and limits, say. Nothing that plots a
    # single line can use it, so it is offered on its own rather than mixed in.
    array_value_columns = [
        c for c, t in columns.items() if t in _NUMERIC_ARRAY_UDTS and c not in skip
    ]
    ts_columns = [c for c, t in columns.items() if t in _TS_TYPES]
    datetime_columns = [c for c, t in columns.items() if t in _DATETIME_TYPES]
    # A status/description column: readable by symbols that print words, useless
    # to anything that scales or plots. `skip` applies here too — a text primary
    # key names the row rather than reporting anything about it.
    text_columns = [c for c, t in columns.items() if t in _TEXT_TYPES and c not in skip]
    # A flag: plottable as 0/1, but not a measurement. `skip` applies for the
    # same reason it does to text_columns -- a boolean primary key identifies
    # the row rather than reporting anything about it.
    bool_columns = [c for c, t in columns.items() if t in _BOOL_TYPES and c not in skip]
    # Excluded from `filter_columns` below, alongside the scalar value columns.
    # Every array, not just the numeric ones: none of them names a row.
    not_a_filter = set(value_columns) | {
        c for c, t in columns.items() if _is_array_type(t)
    }
    return {
        "value_columns": value_columns,
        "array_value_columns": array_value_columns,
        "bool_columns": bool_columns,
        "ts_columns": ts_columns,
        "datetime_columns": datetime_columns,
        "text_columns": text_columns,
        # Every column, categorised or not -- the badge answers "what kind of
        # thing is this" in the picker, which is a different question from
        # "may this be bound here". A column excluded from every list above
        # still shows up as a filter, and still deserves to say what it is.
        "column_types": {c: _type_badge(t) for c, t in columns.items()},
        # Any column may identify a series; numeric value columns are the least
        # useful as a filter so they're excluded to keep the list focused. Text
        # columns stay in: naming the device is what they are usually for, and a
        # column being printable somewhere else does not stop it identifying a row.
        #
        # Booleans stay in for the same reason, and deliberately so even now
        # that they are offerable as values: `enabled = true` is a legitimate
        # way to partition a series, distinct_column_values already casts
        # ::text so it answers 't'/'f' sensibly, and dropping them would break
        # every saved binding that filters on one today.
        #
        # Arrays are excluded too. Before udt_name was read they had no type this
        # function recognised, so they fell through to this list by negation and
        # were offered as filter candidates -- a four-slot reading dressed up as a
        # device selector, which `distinct_column_values` would happily answer with
        # literal '{1.2,3.4}' strings.
        "filter_columns": [c for c in columns if c not in not_a_filter],
    }


def distinct_column_values(
    table: str, column: str, limit: int, datasource_id: int | None = None
) -> list[str]:
    """Distinct non-null values of a filter column (series picker)."""
    with _table_source_conn(datasource_id) as (conn, schema):
        _safe_identifiers(conn, schema, table, column)
        query = sql.SQL(
            "SELECT DISTINCT {col}::text AS v FROM {tbl} "
            "WHERE {col} IS NOT NULL ORDER BY 1 LIMIT %s"
        ).format(col=sql.Identifier(column), tbl=sql.Identifier(schema, table))
        rows = conn.execute(query, (limit,)).fetchall()
    return [r["v"] for r in rows]


def table_latest(
    table: str,
    value_col: str,
    filter_col: str | None,
    filter_val: str | None,
    ts_col: str | None,
    datasource_id: int | None = None,
) -> dict[str, Any] | None:
    """Newest matching row's value (+ ts when a timestamp column is given).

    variables_tag is a special case (same rationale as table_series): the table
    is overwritten in place and its updated_at is stale, so ORDER BY updated_at
    would return a frozen row. Serve the newest buffered sample instead, falling
    back to the direct SQL query only when the buffer is empty.
    """
    if (
        table == "variables_tag"
        and filter_col == "tag_name"
        and filter_val is not None
        and _tags.is_tag_buffered(datasource_id)
    ):
        buffered = _tags.buffered_tag_latest(filter_val, value_col, datasource_id)
        if buffered is not None:
            return buffered
    with _table_source_conn(datasource_id) as (conn, schema):
        _safe_identifiers(conn, schema, table, value_col, filter_col, ts_col)
        ts_select = (
            sql.SQL(", {} AS ts").format(sql.Identifier(ts_col))
            if ts_col else sql.SQL(", NULL AS ts")
        )
        query = sql.SQL("SELECT {val} AS value{ts} FROM {tbl}").format(
            val=sql.Identifier(value_col), ts=ts_select, tbl=sql.Identifier(schema, table)
        )
        params: list[Any] = []
        if filter_col and filter_val is not None:
            query += sql.SQL(" WHERE {}::text = %s").format(sql.Identifier(filter_col))
            params.append(filter_val)
        if ts_col:
            query += sql.SQL(" ORDER BY {} DESC NULLS LAST").format(sql.Identifier(ts_col))
        query += sql.SQL(" LIMIT 1")
        row = conn.execute(query, params).fetchone()
    return row
