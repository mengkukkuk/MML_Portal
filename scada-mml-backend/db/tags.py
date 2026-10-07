"""variables_tag column discovery and the in-memory tag buffer."""

from collections import deque
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
import logging
import threading
from time import monotonic
from typing import Any

from psycopg import sql

import config

from . import tables as _tables

logger = logging.getLogger("mml-api.db")

__all__ = [
    "_DB_COLUMN_FIELD",
    "_FIELD_DB_COLUMN",
    "_NUMERIC_TYPES",
    "_buffer_maxlen",
    "_discover_tag_fields",
    "_evict_excess_keys",
    "_metric_select",
    "_tag_buffer",
    "_tag_buffer_lock",
    "_tag_fields_cache",
    "_tag_sampled_at",
    "buffered_tag_latest",
    "buffered_tag_series",
    "is_tag_buffered",
    "latest_tag",
    "list_tags",
    "snapshot_variables_tag",
    "tag_buffer_stale_after",
    "tag_fields",
]

# --- Status tags (real SCADA data — public.variables_tag) ----------------------
# API field names ↔ actual DB columns. The DB exposes the "current" value as
# `current_value_tag`; we surface it as `current_value` for the frontend so
# existing panels (metric == "current_value") keep working.
_FIELD_DB_COLUMN = {"current_value": "current_value_tag"}
_DB_COLUMN_FIELD = {v: k for k, v in _FIELD_DB_COLUMN.items()}

# Postgres numeric data_types we plot as panel metrics.
_NUMERIC_TYPES = (
    "smallint", "integer", "bigint",
    "real", "double precision", "numeric", "decimal",
)

# Discovered API field names, per datasource. Two plants can be on different
# variables_tag revisions, so one cached tuple for the whole process would show
# the first-sampled plant's columns for every source. DDL on variables_tag is
# rare, so the cache is still process-lifetime and picked up on restart.
_tag_fields_cache: dict[int | None, tuple[str, ...]] = {}


def _discover_tag_fields(datasource_id: int | None = None) -> tuple[str, ...]:
    """Introspect variables_tag and return numeric columns as API field names.

    Excludes primary-key columns (e.g. integer `id`) since they identify rows,
    not metric values.
    """
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            """SELECT c.column_name
               FROM information_schema.columns c
               LEFT JOIN (
                 SELECT kcu.column_name
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON kcu.constraint_name = tc.constraint_name
                  AND kcu.table_schema   = tc.table_schema
                  AND kcu.table_name     = tc.table_name
                 WHERE tc.table_schema = %s
                   AND tc.table_name   = 'variables_tag'
                   AND tc.constraint_type = 'PRIMARY KEY'
               ) pk ON pk.column_name = c.column_name
               WHERE c.table_schema = %s
                 AND c.table_name   = 'variables_tag'
                 AND c.data_type    = ANY(%s)
                 AND pk.column_name IS NULL
               ORDER BY c.ordinal_position""",
            (schema, schema, list(_NUMERIC_TYPES)),
        ).fetchall()
    return tuple(_DB_COLUMN_FIELD.get(r["column_name"], r["column_name"]) for r in rows)


def tag_fields(datasource_id: int | None = None) -> tuple[str, ...]:
    """API field names exposed for panel `metric`. Cached per datasource.

    Only a non-empty discovery is cached. An empty one is what a plant looks like
    while its database is being restored or migrated, and caching that for the
    process lifetime makes snapshot_variables_tag return early forever — a state
    only a service restart can leave.
    """
    cached = _tag_fields_cache.get(datasource_id)
    if cached:
        return cached
    fields = _discover_tag_fields(datasource_id)
    if fields:
        _tag_fields_cache[datasource_id] = fields
    return fields


def _metric_select(fields: Sequence[str]) -> sql.Composed:
    """`"<db_col>" AS "<api_field>"` for each discovered field."""
    return sql.SQL(", ").join(
        sql.SQL("{} AS {}").format(
            sql.Identifier(_FIELD_DB_COLUMN.get(f, f)), sql.Identifier(f)
        )
        for f in fields
    )


def list_tags(datasource_id: int | None = None) -> list[dict[str, Any]]:
    """All distinct tag names in variables_tag, ordered alphabetically."""
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                "SELECT DISTINCT tag_name FROM {} "
                "WHERE tag_name IS NOT NULL ORDER BY tag_name"
            ).format(sql.Identifier(schema, "variables_tag"))
        ).fetchall()
    return rows


def latest_tag(tag_name: str, datasource_id: int | None = None) -> dict[str, Any] | None:
    """Most-recent row for a tag — all discovered numeric columns + updated_at + active."""
    fields = tag_fields(datasource_id)
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        row = conn.execute(
            sql.SQL(
                "SELECT tag_name, active, updated_at AS ts, {metrics} "
                "FROM {table} WHERE tag_name = %s "
                "ORDER BY updated_at DESC NULLS LAST LIMIT 1"
            ).format(
                metrics=_metric_select(fields),
                table=sql.Identifier(schema, "variables_tag"),
            ),
            (tag_name,),
        ).fetchone()
    return row


# --- Tag history buffer ------------------------------------------------------
# variables_tag is overwritten in place by the external SCADA writer (single row
# per tag_name — see tag_fields() above), so it has no real row history a SQL
# query can window over. snapshot_variables_tag() polls it on a timer (see
# main.py) and appends a wall-clock-stamped point per (datasource, tag_name,
# column) here; table_series() then serves variables_tag from this buffer instead
# of issuing its usual (always-≤1-row) SQL query. Process-lifetime only — resets
# on backend restart.
#
# Keyed by datasource because two plants publish the same tag names for different
# equipment; a shared key would interleave two machines into one chart.
_tag_buffer: dict[tuple[int | None, str, str], deque[tuple[datetime, float]]] = {}
# One lock for the whole buffer: writes happen once every TAG_BUFFER_POLL_SECONDS,
# so contention is negligible and per-source locks would only complicate eviction.
_tag_buffer_lock = threading.Lock()
# datasource_id -> monotonic() of its last successful snapshot.
# table_latest/table_series consult this before serving variables_tag from memory:
# an unsampled source would render a permanently blank chart, which is worse than
# a slower live query.
_tag_sampled_at: dict[int | None, float] = {}
_last_evict_log = 0.0


def _buffer_maxlen() -> int:
    """Points to keep per series. Bounding the deque makes eviction O(1) and
    free; the previous unbounded deques leaked, which multiplying by N sources
    turns from slow into urgent."""
    poll = max(config.TAG_BUFFER_POLL_SECONDS, 1)
    return -(-config.TAG_BUFFER_RETENTION_MINUTES * 60 // poll) + 10


def _evict_excess_keys() -> None:
    """Cap total series, dropping the least-recently-written first.

    Called with _tag_buffer_lock held. The key count, not the source count, is
    the real memory bound: at the defaults one series is ~47 KB, so 5000 keys is
    roughly 235 MB.
    """
    global _last_evict_log
    excess = len(_tag_buffer) - config.TAG_BUFFER_MAX_KEYS
    if excess <= 0:
        return
    stale = sorted(_tag_buffer, key=lambda k: _tag_buffer[k][-1][0] if _tag_buffer[k] else datetime.min.replace(tzinfo=timezone.utc))
    for key in stale[:excess]:
        del _tag_buffer[key]
    now = monotonic()
    if now - _last_evict_log > 60:
        _last_evict_log = now
        logger.warning(
            "Tag buffer at its %d-key cap; evicted %d least-recently-written "
            "series. Raise TAG_BUFFER_MAX_KEYS or select fewer datasources.",
            config.TAG_BUFFER_MAX_KEYS, excess,
        )


def snapshot_variables_tag(datasource_id: int | None = None) -> None:
    """Sample every tag's current numeric columns into the history buffer."""
    fields = tag_fields(datasource_id)
    if not fields:
        return
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL("SELECT tag_name, {metrics} FROM {table} WHERE tag_name IS NOT NULL")
            .format(
                metrics=_metric_select(fields),
                table=sql.Identifier(schema, "variables_tag"),
            )
        ).fetchall()
    now = datetime.now(timezone.utc)
    maxlen = _buffer_maxlen()
    with _tag_buffer_lock:
        for row in rows:
            tag = row["tag_name"]
            for f in fields:
                v = row[f]
                if v is None:
                    continue
                key = (datasource_id, tag, _FIELD_DB_COLUMN.get(f, f))
                buf = _tag_buffer.get(key)
                if buf is None:
                    buf = _tag_buffer[key] = deque(maxlen=maxlen)
                buf.append((now, float(v)))
        _evict_excess_keys()
    # Stamped after the lock is released, so the freshness gate can only open
    # once the points behind it are committed — never the other way round.
    _tag_sampled_at[datasource_id] = monotonic()


def tag_buffer_stale_after() -> float:
    """Seconds a buffer may go unrefreshed before it stops being authoritative.

    Matched to the point at which the sampling loop itself gives up on a source
    (TAG_BUFFER_FAIL_LIMIT consecutive misses), plus a tick of slack so a merely
    late poll does not flip the gate.
    """
    return max(config.TAG_BUFFER_POLL_SECONDS, 1) * (config.TAG_BUFFER_FAIL_LIMIT + 1)


def is_tag_buffered(datasource_id: int | None) -> bool:
    """Whether the buffer loop is *currently* sampling this source.

    Currently, not ever — and the difference is the whole reason a Live tile or a
    mimic symbol used to freeze permanently when its plant went down. The buffer
    holds the last sample taken before the outage; served unconditionally, that
    sample is returned as a perfectly good 200 forever, so nothing downstream
    ever learns the source is gone: no error, no reconnect, and no recovery when
    the plant comes back. Letting the gate expire routes the next poll at the
    live query instead, which either succeeds (the source is back, and the tile
    recovers on that poll) or raises, which fan_out reports as ok=False and the
    frontend renders as "retrying".

    Gated on this rather than on `datasource_id is None`: a source the buffer
    loop never polls would otherwise draw a permanently blank chart, where the
    live query at least shows the one row variables_tag holds.
    """
    at = _tag_sampled_at.get(datasource_id)
    return at is not None and monotonic() - at <= tag_buffer_stale_after()


def buffered_tag_series(
    tag_name: str, value_col: str, minutes: int, datasource_id: int | None = None
) -> list[dict[str, Any]]:
    """In-memory substitute for table_series() against variables_tag."""
    cutoff = datetime.now(timezone.utc) - timedelta(
        minutes=min(minutes, config.TAG_BUFFER_RETENTION_MINUTES)
    )
    with _tag_buffer_lock:
        buf = _tag_buffer.get((datasource_id, tag_name, value_col), deque())
        return [{"ts": ts, "value": v} for ts, v in buf if ts >= cutoff]


def buffered_tag_latest(
    tag_name: str, value_col: str, datasource_id: int | None = None
) -> dict[str, Any] | None:
    """In-memory substitute for table_latest() against variables_tag.

    variables_tag is overwritten in place and its updated_at is not maintained,
    so the table's own "ORDER BY updated_at DESC LIMIT 1" returns a frozen row —
    which strands each Live tile on a stale value. The snapshot buffer carries
    the real, wall-clock-stamped current value, so serve the newest sample here
    (mirrors buffered_tag_series). None when the buffer has no point yet, so the
    caller falls back to the direct SQL query.
    """
    with _tag_buffer_lock:
        buf = _tag_buffer.get((datasource_id, tag_name, value_col))
        if not buf:
            return None
        ts, v = buf[-1]
    return {"value": v, "ts": ts}
