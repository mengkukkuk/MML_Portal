"""The alert message source — where the plant's alert text is kept — and reading it.

The report trend marks the moments a plant wrote an alert ("QC hold on lot
4471", "เปลี่ยนแม่พิมพ์ไลน์ 2") along its time axis. Those messages live in one
table on one connection, set once by an admin and stored here in the app
database as a singleton — the same arrangement as `camera_link_settings`.

One source for every trend, on purpose: the alert table usually sits on a
different connection from the readings it annotates (alerts in the vision
database, sensor_log1 in MMLData), so it cannot be found by following the
trend's own connection. Which messages a trend shows is narrowed by the report
filter's location/camera picks instead (see `read_alert_messages`).

The table it names may not exist yet: a source can be configured ahead of the
table. So nothing is validated against the plant when it is saved. Every read
goes through `_safe_identifiers`, the allowlist gate every other plant read
uses, and a table or column that is not there (yet) is reported as "not
available" rather than raised — the chart simply has no markers until it is.
"""

from datetime import datetime
import logging
from typing import Any

from psycopg import sql

from . import pool as _pool
from . import tables as _tables

logger = logging.getLogger("mml-api.db")

__all__ = [
    "ALERT_MATCH_FILTERS",
    "delete_alert_source",
    "get_alert_source",
    "init_alert_sources_table",
    "read_alert_messages",
    "set_alert_source",
    "severity_of",
]

# The report-filter dimensions a source's match column may follow. Named after
# the filter bar's own keys (reportRange.js FILTER_KEYS) so the client passes
# whichever one its filter holds, under the same name.
ALERT_MATCH_FILTERS = ("location", "camera")

_FIELDS = "table_name, ts_col, message_col, severity_col, match_col, match_filter, role_col"


def init_alert_sources_table() -> None:
    """Create the alert source singleton. Idempotent.

    No row means no source. The row goes with its connection (CASCADE): a source
    names one connection's table and means nothing once that connection is gone.
    Must run after init_datasources_table (FK).

    An earlier build kept one source per connection (`alert_message_sources`).
    Its most recently saved row becomes the singleton, and the old table is
    dropped — it held configuration only, and nothing reads it any more.
    """
    with _pool.get_connection() as conn:
        conn.execute(
            f"""CREATE TABLE IF NOT EXISTS alert_source_settings (
                id            INTEGER PRIMARY KEY DEFAULT 1,
                datasource_id INTEGER NOT NULL
                    REFERENCES datasources(id) ON DELETE CASCADE,
                table_name    TEXT NOT NULL,
                ts_col        TEXT NOT NULL,
                message_col   TEXT NOT NULL,
                severity_col  TEXT,
                match_col     TEXT,
                match_filter  TEXT,
                role_col      TEXT,
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT alert_source_settings_singleton CHECK (id = 1),
                CONSTRAINT alert_source_settings_match
                    CHECK ((match_col IS NULL) = (match_filter IS NULL)),
                CONSTRAINT alert_source_settings_filter
                    CHECK (match_filter IS NULL OR match_filter IN ('location', 'camera'))
            )"""
        )
        # Added after the singleton first shipped — the column that names the
        # alert's own response role (see db/response_roles.py).
        conn.execute("ALTER TABLE alert_source_settings ADD COLUMN IF NOT EXISTS role_col TEXT")
        legacy = conn.execute("SELECT to_regclass('alert_message_sources') AS t").fetchone()["t"]
        if legacy:
            moved = "table_name, ts_col, message_col, severity_col, match_col, match_filter"
            conn.execute(
                f"""INSERT INTO alert_source_settings (id, datasource_id, {moved}, updated_at)
                    SELECT 1, datasource_id, {moved}, updated_at
                    FROM alert_message_sources
                    ORDER BY updated_at DESC
                    LIMIT 1
                    ON CONFLICT (id) DO NOTHING"""
            )
            conn.execute("DROP TABLE alert_message_sources")
            logger.info("Alert sources: per-connection table migrated to the singleton")
        conn.commit()


def get_alert_source() -> dict[str, Any] | None:
    """The saved source with its connection's name, or None when there is none."""
    with _pool.get_connection() as conn:
        return conn.execute(
            """SELECT s.datasource_id, d.name AS datasource_name, s.table_name, s.ts_col,
                      s.message_col, s.severity_col, s.match_col, s.match_filter, s.role_col,
                      s.updated_at
               FROM alert_source_settings s
               JOIN datasources d ON d.id = s.datasource_id
               WHERE s.id = 1"""
        ).fetchone()


def set_alert_source(
    datasource_id: int,
    *,
    table_name: str,
    ts_col: str,
    message_col: str,
    severity_col: str | None = None,
    match_col: str | None = None,
    match_filter: str | None = None,
    role_col: str | None = None,
) -> dict[str, Any] | None:
    """Create or replace the source."""
    with _pool.get_connection() as conn:
        conn.execute(
            f"""INSERT INTO alert_source_settings (id, datasource_id, {_FIELDS})
            VALUES (1, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                datasource_id = EXCLUDED.datasource_id,
                table_name = EXCLUDED.table_name,
                ts_col = EXCLUDED.ts_col,
                message_col = EXCLUDED.message_col,
                severity_col = EXCLUDED.severity_col,
                match_col = EXCLUDED.match_col,
                match_filter = EXCLUDED.match_filter,
                role_col = EXCLUDED.role_col,
                updated_at = now()""",
            (datasource_id, table_name, ts_col, message_col, severity_col,
             match_col, match_filter, role_col),
        )
        conn.commit()
    return get_alert_source()


def delete_alert_source() -> bool:
    with _pool.get_connection() as conn:
        cur = conn.execute("DELETE FROM alert_source_settings WHERE id = 1")
        conn.commit()
    return cur.rowcount > 0


# --- Severity -----------------------------------------------------------------
# A convention rather than a per-plant mapping: the alert table does not exist
# yet, so the team creating it writes one of these words (or levels) and nothing
# has to be configured. Anything unrecognised — including no severity column at
# all — is plain information, never an alarm: a marker coloured red has to have
# earned it.
_CRIT = frozenset({"crit", "critical", "alarm", "high", "2"})
_WARN = frozenset({"warn", "warning", "medium", "1"})


def severity_of(raw: Any) -> str:
    """'crit', 'warn' or 'info' for a severity cell, read leniently.

    Case and surrounding space are ignored, and a numeric level is read by its
    value, so 2, 2.0 and '2' all mean crit.
    """
    if raw is None or isinstance(raw, bool):
        return "info"
    if isinstance(raw, (int, float)) and float(raw).is_integer():
        token = str(int(raw))
    else:
        token = str(raw).strip().lower()
        try:
            number = float(token)
        except ValueError:
            number = None
        if number is not None and number.is_integer():
            token = str(int(number))
    if token in _CRIT:
        return "crit"
    if token in _WARN:
        return "warn"
    return "info"


# --- Reading ------------------------------------------------------------------
def read_alert_messages(
    source: dict[str, Any],
    start: datetime,
    end: datetime,
    match_values: list[str] | None,
    limit: int,
) -> list[dict[str, Any]]:
    """Messages in [start, end], newest first, at most `limit` rows.

    `source` is the row from `get_alert_source`; the messages are read from its
    connection, whichever connection the trend asking for them reads from.
    `match_values` filters on the
    source's match column when both are set — the report filter is a multi-pick,
    so a message matches any of them; with none, every message in the window is
    returned. Raises ValueError when the table or a column is not
    there (`_safe_identifiers`), and lets the connection's own errors propagate.

    Message and severity are read as text whatever their column type: a message
    held in a varchar or a numeric alarm code is still something to print, and a
    numeric severity level is what `severity_of` expects to be handed anyway.
    """
    table = source["table_name"]
    ts_col = source["ts_col"]
    message_col = source["message_col"]
    severity_col = source.get("severity_col")
    match_col = source.get("match_col")
    role_col = source.get("role_col")

    with _tables._table_source_conn(source["datasource_id"]) as (conn, schema):
        columns = _tables._safe_identifiers(
            conn, schema, table, ts_col, message_col, severity_col, match_col, role_col
        )
        naive = columns[ts_col] == "timestamp without time zone"
        clock = sql.Identifier(ts_col)
        # A naive plant column is compared in the connection's timezone by
        # converting the bounds, not the column, so its index still applies —
        # and reported back as an aware time, as table_series does.
        bound = (
            sql.SQL("(%s::timestamptz AT TIME ZONE current_setting('TimeZone'))")
            if naive else sql.SQL("%s")
        )
        ts_out = (
            sql.SQL("({} AT TIME ZONE current_setting('TimeZone'))").format(clock)
            if naive else clock
        )
        severity = (
            sql.SQL("{}::text").format(sql.Identifier(severity_col))
            if severity_col else sql.SQL("NULL::text")
        )
        # The match column's value (the alert's location, when the source follows
        # Location) and the row's own role, for the response-role rules.
        text_or_null = lambda col: (  # noqa: E731
            sql.SQL("{}::text").format(sql.Identifier(col)) if col else sql.SQL("NULL::text"))
        query = sql.SQL(
            "SELECT {ts} AS ts, {msg}::text AS message, {sev} AS severity, "
            "{match} AS match_value, {role} AS role_value "
            "FROM {tbl} WHERE {clock} >= {bound} AND {clock} <= {bound} "
            "AND {msg} IS NOT NULL"
        ).format(
            ts=ts_out,
            msg=sql.Identifier(message_col),
            sev=severity,
            match=text_or_null(match_col),
            role=text_or_null(role_col),
            tbl=sql.Identifier(schema, table),
            clock=clock,
            bound=bound,
        )
        params: list[Any] = [start, end]
        if match_col and match_values:
            if len(match_values) == 1:
                # One value keeps _filter_clause's index-friendly integer compare.
                clause, param = _tables._filter_clause(columns, match_col, match_values[0])
            else:
                clause = sql.SQL("{}::text = ANY(%s)").format(sql.Identifier(match_col))
                param = list(match_values)
            query += sql.SQL(" AND ") + clause
            params.append(param)
        query += sql.SQL(" ORDER BY {} DESC LIMIT %s").format(clock)
        params.append(limit)
        return conn.execute(query, params).fetchall()
