"""Thin PostgreSQL access layer using psycopg 3."""
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Json

import config


def get_connection() -> psycopg.Connection:
    """Open a new connection. Rows are returned as dicts."""
    return psycopg.connect(config.DATABASE_URL, row_factory=dict_row)


def get_user_by_username(username: str) -> dict[str, Any] | None:
    with get_connection() as conn:
        row = conn.execute(
            """SELECT id, username, password_hash, role, display_name 
            FROM users WHERE username = %s""",
            (username,),
        ).fetchone()
    return row


def get_user_by_id(user_id: int) -> dict[str, Any] | None:
    with get_connection() as conn:
        row = conn.execute(
            """SELECT id, username, password_hash, role, display_name
            FROM users WHERE id = %s""",
            (user_id,),
        ).fetchone()
    return row


def get_user_by_email(email: str) -> dict[str, Any] | None:
    """Case-insensitive lookup — normalization must match users_email_lower_key."""
    with get_connection() as conn:
        row = conn.execute(
            """SELECT id, username, password_hash, role, display_name, email
            FROM users WHERE lower(email) = lower(%s)""",
            (email,),
        ).fetchone()
    return row


# --- Account management -----------------------------------------------------
def list_users() -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT id, username, role, display_name, email, created_at
            FROM users ORDER BY id"""
        ).fetchall()
    return rows


def create_user(
    username: str,
    password_hash: str,
    role: str,
    display_name: str,
    email: str | None,
) -> dict[str, Any]:
    """Insert a user. Raises psycopg.errors.UniqueViolation on duplicate username/email."""
    with get_connection() as conn:
        row = conn.execute(
            """INSERT INTO users (username, password_hash, role, display_name, email)
            VALUES (%s, %s, %s, %s, %s) RETURNING id, username, role, display_name, email, created_at""",
            (username, password_hash, role, display_name, email),
        ).fetchone()
        conn.commit()
    return row


def update_user(
    user_id: int,
    role: str,
    display_name: str,
    email: str | None,
) -> dict[str, Any] | None:
    """Update editable fields (not username/password). Returns None if no such user."""
    with get_connection() as conn:
        row = conn.execute(
            """UPDATE users SET role = %s, display_name = %s, email = %s
            WHERE id = %s RETURNING id, username, role, display_name, email, created_at""",
            (role, display_name, email, user_id),
        ).fetchone()
        conn.commit()
    return row


def delete_user(user_id: int) -> bool:
    """Delete a user. Returns True if a row was removed."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM users WHERE id = %s", (user_id,))
        conn.commit()
        return cur.rowcount > 0


def set_password(user_id: int, password_hash: str) -> bool:
    """Replace a user's password hash. Returns True if the user exists."""
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE users SET password_hash = %s WHERE id = %s",
            (password_hash, user_id),
        )
        conn.commit()
        return cur.rowcount > 0


def count_admins() -> int:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT count(*) AS n FROM users WHERE role = 'admin'"
        ).fetchone()
    return int(row["n"])


# --- Live sensor readings (real-time charts) --------------------------------
def list_devices() -> list[dict[str, Any]]:
    """All monitored devices, ordered by id."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT id, name, type, location, status
            FROM devices ORDER BY id"""
        ).fetchall()
    return rows


def list_metrics(device_id: int) -> list[dict[str, Any]]:
    """Distinct metrics (with their most recent unit) recorded for a device."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT DISTINCT ON (metric) metric, unit
            FROM sensor_readings
            WHERE device_id = %s
            ORDER BY metric, ts DESC""",
            (device_id,),
        ).fetchall()
    return rows


def latest_reading(device_id: int, metric: str) -> dict[str, Any] | None:
    """Single most-recent reading for a device/metric, or None if none exist."""
    with get_connection() as conn:
        row = conn.execute(
            """SELECT value, unit, ts
            FROM sensor_readings
            WHERE device_id = %s AND metric = %s
            ORDER BY ts DESC LIMIT 1""",
            (device_id, metric),
        ).fetchone()
    return row


def reading_series(device_id: int, metric: str, minutes: int) -> list[dict[str, Any]]:
    """Time-ordered readings for a device/metric over the last `minutes`."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT value, unit, ts
            FROM sensor_readings
            WHERE device_id = %s AND metric = %s
              AND ts >= now() - make_interval(mins => %s)
            ORDER BY ts ASC""",
            (device_id, metric, minutes),
        ).fetchall()
    return rows


# --- Dashboard panels (admin-managed live grid) -----------------------------
def init_panels_table() -> None:
    """Create the dashboard_panels table if it doesn't exist. Idempotent.

    ``options`` (JSONB) holds the per-visualization parameters (min/max,
    thresholds, decimals, orientation, …) so each panel can render in a
    different form. Added as an idempotent migration for existing tables.
    ``source`` is 'device' (legacy device+metric) or 'tag' (status_tag row).
    """
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS dashboard_panels (
                id             SERIAL PRIMARY KEY,
                title          TEXT NOT NULL,
                device_id      INTEGER,
                metric         TEXT,
                window_minutes INTEGER NOT NULL DEFAULT 15,
                chart_type     TEXT NOT NULL DEFAULT 'timeseries',
                position       INTEGER NOT NULL DEFAULT 0,
                options        JSONB NOT NULL DEFAULT '{}'::jsonb,
                source         TEXT NOT NULL DEFAULT 'device',
                tag_name       TEXT,
                poll_interval_seconds INTEGER NOT NULL DEFAULT 5,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.execute(
            "ALTER TABLE dashboard_panels "
            "ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels "
            "ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'device'"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels "
            "ADD COLUMN IF NOT EXISTS tag_name TEXT"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels "
            "ADD COLUMN IF NOT EXISTS poll_interval_seconds INTEGER NOT NULL DEFAULT 5"
        )
        # Generic table data-source binding (source='table'): the chosen public
        # table, the filter (series-key) column, and the timestamp column used for
        # ordering / the x-axis. The value column reuses `metric`; the per-series
        # filter values ride in options.filters (parallel to options.tags).
        conn.execute(
            "ALTER TABLE dashboard_panels ADD COLUMN IF NOT EXISTS table_name TEXT"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels ADD COLUMN IF NOT EXISTS filter_col TEXT"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels ADD COLUMN IF NOT EXISTS ts_col TEXT"
        )
        # Optional binding to a saved connection (datasources.id). Plain INTEGER
        # (no FK) so this migration never depends on table-creation order; the
        # selection is persisted now and used for query routing in a follow-up.
        conn.execute(
            "ALTER TABLE dashboard_panels ADD COLUMN IF NOT EXISTS datasource_id INTEGER"
        )
        conn.execute("ALTER TABLE dashboard_panels ALTER COLUMN device_id DROP NOT NULL")
        conn.execute("ALTER TABLE dashboard_panels ALTER COLUMN metric DROP NOT NULL")
        conn.commit()


def init_dashboards_table() -> None:
    """Create the dashboards table and link panels to it. Idempotent.

    A dashboard groups panels so the Live page can host several named boards.
    Must run AFTER init_panels_table() (it alters dashboard_panels). Existing
    panels are adopted into a single 'Default' dashboard so nothing breaks.
    """
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS dashboards (
                id         SERIAL PRIMARY KEY,
                title      TEXT NOT NULL,
                position   INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.execute(
            "ALTER TABLE dashboard_panels ADD COLUMN IF NOT EXISTS dashboard_id "
            "INTEGER REFERENCES dashboards(id) ON DELETE CASCADE"
        )
        # Guarantee at least one dashboard exists, then adopt any orphan panels.
        existing = conn.execute(
            "SELECT id FROM dashboards ORDER BY position, id LIMIT 1"
        ).fetchone()
        if existing is None:
            existing = conn.execute(
                "INSERT INTO dashboards (title, position) VALUES ('Default', 0) "
                "RETURNING id"
            ).fetchone()
        default_id = existing["id"]
        conn.execute(
            "UPDATE dashboard_panels SET dashboard_id = %s WHERE dashboard_id IS NULL",
            (default_id,),
        )
        conn.commit()


_DASH_COLS = "id, title, position, created_at"


def list_dashboards() -> list[dict[str, Any]]:
    """All dashboards, ordered by position then id."""
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT {_DASH_COLS} FROM dashboards ORDER BY position, id"
        ).fetchall()
    return rows


def create_dashboard(title: str, position: int = 0) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute(
            f"INSERT INTO dashboards (title, position) VALUES (%s, %s) "
            f"RETURNING {_DASH_COLS}",
            (title, position),
        ).fetchone()
        conn.commit()
    return row


def update_dashboard(dashboard_id: int, title: str) -> dict[str, Any] | None:
    """Rename a dashboard. Returns None if no such dashboard."""
    with get_connection() as conn:
        row = conn.execute(
            f"UPDATE dashboards SET title = %s WHERE id = %s RETURNING {_DASH_COLS}",
            (title, dashboard_id),
        ).fetchone()
        conn.commit()
    return row


def delete_dashboard(dashboard_id: int) -> bool:
    """Delete a dashboard (its panels cascade away). True if a row was removed."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM dashboards WHERE id = %s", (dashboard_id,))
        conn.commit()
        return cur.rowcount > 0


# --- Status tags (real SCADA data — public.status_tag) ----------------------
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

# Process-lifetime cache of discovered API field names. DDL on status_tag is
# rare and is only picked up on FastAPI restart — comment in plan.
_tag_fields_cache: tuple[str, ...] | None = None


def _discover_tag_fields() -> tuple[str, ...]:
    """Introspect public.status_tag and return numeric columns as API field names.

    Excludes primary-key columns (e.g. integer `id`) since they identify rows,
    not metric values.
    """
    with get_connection() as conn:
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
                 WHERE tc.table_schema = 'public'
                   AND tc.table_name   = 'status_tag'
                   AND tc.constraint_type = 'PRIMARY KEY'
               ) pk ON pk.column_name = c.column_name
               WHERE c.table_schema = 'public'
                 AND c.table_name   = 'status_tag'
                 AND c.data_type    = ANY(%s)
                 AND pk.column_name IS NULL
               ORDER BY c.ordinal_position""",
            (list(_NUMERIC_TYPES),),
        ).fetchall()
    return tuple(_DB_COLUMN_FIELD.get(r["column_name"], r["column_name"]) for r in rows)


def tag_fields() -> tuple[str, ...]:
    """API field names exposed for panel `metric`. Cached after first call."""
    global _tag_fields_cache
    if _tag_fields_cache is None:
        _tag_fields_cache = _discover_tag_fields()
    return _tag_fields_cache


def list_tags() -> list[dict[str, Any]]:
    """All distinct tag names in status_tag, ordered alphabetically."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT tag_name FROM public.status_tag "
            "WHERE tag_name IS NOT NULL ORDER BY tag_name"
        ).fetchall()
    return rows


def latest_tag(tag_name: str) -> dict[str, Any] | None:
    """Most-recent row for a tag — all discovered numeric columns + updated_at + active."""
    fields = tag_fields()
    # Build "<db_col> AS <api_field>" for each discovered field; pass through if no alias.
    select_metrics = ", ".join(f'{_FIELD_DB_COLUMN.get(f, f)} AS {f}' for f in fields)
    sql = (
        f"SELECT tag_name, active, updated_at AS ts, {select_metrics} "
        "FROM public.status_tag WHERE tag_name = %s "
        "ORDER BY updated_at DESC NULLS LAST LIMIT 1"
    )
    with get_connection() as conn:
        row = conn.execute(sql, (tag_name,)).fetchone()
    return row


# --- Event log (real SCADA data — public.event_logs, read-only) ---------------
def list_recent_events(limit: int) -> list[dict[str, Any]]:
    """Last `limit` events per (location, tag_name), newest first.

    Reads the externally-populated public.event_logs. Ordered so the frontend can
    group location -> tag_name in a single pass.
    """
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT location, tag_name, event, at_date_time
               FROM (
                 SELECT location, tag_name, event, at_date_time,
                        ROW_NUMBER() OVER (
                          PARTITION BY location, tag_name
                          ORDER BY at_date_time DESC
                        ) AS rn
                 FROM public.event_logs
               ) ranked
               WHERE rn <= %s
               ORDER BY location, tag_name, at_date_time DESC""",
            (limit,),
        ).fetchall()
    return rows


# --- Alarm log (real SCADA data — public.alarm_logs) -------------------------
# DB column `alarm_events` is surfaced as API field `alarm`; `created_at` is
# surfaced as `at_date_time` so the frontend can share the events timestamp
# shape. Severity / acknowledgement columns were added via a one-shot
# migration (see _probe_alarms.py).
def list_recent_alarms(limit: int) -> list[dict[str, Any]]:
    """Last `limit` alarms per (location, tag_name), newest first."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT id, location, tag_name,
                      alarm_events AS alarm,
                      severity,
                      created_at   AS at_date_time,
                      acknowledged, acknowledged_at, acknowledged_by
               FROM (
                 SELECT id, location, tag_name, alarm_events, severity,
                        created_at, acknowledged, acknowledged_at,
                        acknowledged_by,
                        ROW_NUMBER() OVER (
                          PARTITION BY location, tag_name
                          ORDER BY created_at DESC
                        ) AS rn
                 FROM public.alarm_logs
               ) ranked
               WHERE rn <= %s
               ORDER BY location, tag_name, created_at DESC""",
            (limit,),
        ).fetchall()
    return rows


def list_active_alarms() -> list[dict[str, Any]]:
    """Tags currently in alarm (status_tag.alarm_no not null), joined to the
    triggering alarm_logs row for the event text. Empty list when nothing active."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT st.tag_name, st.location,
                      st.alarm_value, st.alarm_no, st.alarm_active,
                      al.id            AS alarm_id,
                      al.alarm_events  AS alarm,
                      al.severity,
                      al.created_at    AS at_date_time
               FROM public.status_tag st
               JOIN public.alarm_logs al ON al.id = st.alarm_no
               WHERE st.alarm_no IS NOT NULL
               ORDER BY st.location, st.tag_name"""
        ).fetchall()
    return rows


def acknowledge_alarm(alarm_id: int, user_id: int) -> dict[str, Any] | None:
    """Mark an alarm acknowledged. Returns the updated row, or None if the
    alarm doesn't exist or was already acknowledged."""
    with get_connection() as conn:
        row = conn.execute(
            """UPDATE public.alarm_logs
                  SET acknowledged    = TRUE,
                      acknowledged_at = now(),
                      acknowledged_by = %s
                WHERE id = %s AND acknowledged = FALSE
                RETURNING id, location, tag_name,
                          alarm_events AS alarm,
                          severity,
                          created_at   AS at_date_time,
                          acknowledged, acknowledged_at, acknowledged_by""",
            (user_id, alarm_id),
        ).fetchone()
        conn.commit()
    return row


_PANEL_COLS = (
    "id, title, device_id, metric, window_minutes, chart_type, position, "
    "options, source, tag_name, poll_interval_seconds, "
    "table_name, filter_col, ts_col, dashboard_id, datasource_id, created_at"
)


def list_panels(dashboard_id: int | None = None) -> list[dict[str, Any]]:
    """Dashboard panels, ordered by position then id.

    When ``dashboard_id`` is given, only that dashboard's panels are returned.
    """
    with get_connection() as conn:
        if dashboard_id is None:
            rows = conn.execute(
                f"SELECT {_PANEL_COLS} FROM dashboard_panels ORDER BY position, id"
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT {_PANEL_COLS} FROM dashboard_panels "
                "WHERE dashboard_id = %s ORDER BY position, id",
                (dashboard_id,),
            ).fetchall()
    return rows


def create_panel(
    title: str,
    device_id: int | None,
    metric: str | None,
    window_minutes: int,
    chart_type: str,
    position: int,
    options: dict[str, Any],
    source: str,
    tag_name: str | None,
    poll_interval_seconds: int,
    table_name: str | None = None,
    filter_col: str | None = None,
    ts_col: str | None = None,
    dashboard_id: int | None = None,
    datasource_id: int | None = None,
) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute(
            f"""INSERT INTO dashboard_panels
                (title, device_id, metric, window_minutes, chart_type, position,
                 options, source, tag_name, poll_interval_seconds,
                 table_name, filter_col, ts_col, dashboard_id, datasource_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_PANEL_COLS}""",
            (title, device_id, metric, window_minutes, chart_type, position,
             Json(options), source, tag_name, poll_interval_seconds,
             table_name, filter_col, ts_col, dashboard_id, datasource_id),
        ).fetchone()
        conn.commit()
    return row


def update_panel(
    panel_id: int,
    title: str,
    device_id: int | None,
    metric: str | None,
    window_minutes: int,
    chart_type: str,
    position: int,
    options: dict[str, Any],
    source: str,
    tag_name: str | None,
    poll_interval_seconds: int,
    table_name: str | None = None,
    filter_col: str | None = None,
    ts_col: str | None = None,
    dashboard_id: int | None = None,
    datasource_id: int | None = None,
) -> dict[str, Any] | None:
    """Update a panel. Returns None if no such panel."""
    with get_connection() as conn:
        row = conn.execute(
            f"""UPDATE dashboard_panels
            SET title = %s, device_id = %s, metric = %s, window_minutes = %s,
                chart_type = %s, position = %s, options = %s,
                source = %s, tag_name = %s, poll_interval_seconds = %s,
                table_name = %s, filter_col = %s, ts_col = %s, dashboard_id = %s,
                datasource_id = %s
            WHERE id = %s
            RETURNING {_PANEL_COLS}""",
            (title, device_id, metric, window_minutes, chart_type, position,
             Json(options), source, tag_name, poll_interval_seconds,
             table_name, filter_col, ts_col, dashboard_id, datasource_id, panel_id),
        ).fetchone()
        conn.commit()
    return row


def delete_panel(panel_id: int) -> bool:
    """Delete a panel. Returns True if a row was removed."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM dashboard_panels WHERE id = %s", (panel_id,))
        conn.commit()
        return cur.rowcount > 0


# --- Generic table data-source (source='table') -----------------------------
# Admins can bind a panel to any numeric column of any non-sensitive public
# table. Table/column names are SQL *identifiers* and cannot be parameterized,
# so every identifier is validated against an information_schema allowlist and
# composed with psycopg.sql.Identifier — never string-interpolated. Filter
# *values* are always passed as %s params.

# Tables never exposed to the picker (credentials / app-internal state).
# `datasources` holds saved connection passwords — must never be chartable, or a
# text filter column could leak secrets via distinct_column_values.
SENSITIVE_TABLES = {"users", "dashboard_panels", "mmldatabuffer", "datasources"}

# Postgres date/time data_types usable as a panel's timestamp/x-axis column.
_TS_TYPES = (
    "timestamp without time zone",
    "timestamp with time zone",
    "date",
    "time without time zone",
    "time with time zone",
)


@contextmanager
def _table_source_conn(datasource_id: int | None):
    """Yield ``(conn, schema)`` for table-source queries.

    ``None`` → the app database + the ``public`` schema (unchanged behaviour).
    Otherwise opens a short-lived libpq connection to the saved datasource and
    uses its configured schema. Raises ``ValueError`` if the datasource id is
    unknown; ``psycopg.Error`` propagates when it can't be reached so callers can
    surface a connection failure. ``get_datasource_secret`` is defined later in
    this module — fine, it's only referenced at call time.
    """
    if datasource_id is None:
        with get_connection() as conn:
            yield conn, "public"
        return
    ds = get_datasource_secret(datasource_id)
    if ds is None:
        raise ValueError(f"datasource {datasource_id} not found")
    with psycopg.connect(
        host=ds["host"], port=ds["port"], dbname=ds["database"],
        user=ds["username"], password=ds["password"], sslmode=ds["sslmode"],
        connect_timeout=5, row_factory=dict_row,
    ) as conn:
        yield conn, (ds.get("db_schema") or "public")


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
        """SELECT column_name, data_type
           FROM information_schema.columns
           WHERE table_schema = %s AND table_name = %s
           ORDER BY ordinal_position""",
        (schema, table),
    ).fetchall()
    return {r["column_name"]: r["data_type"] for r in rows}


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


def describe_table(table: str, datasource_id: int | None = None) -> dict[str, list[str]]:
    """Categorize a table's columns for the panel editor's pickers."""
    with _table_source_conn(datasource_id) as (conn, schema):
        columns = _table_columns(conn, schema, table)
        # Numeric columns are chartable values, but a surrogate key identifies
        # rows, not a metric — exclude PK columns and any column conventionally
        # named `id` (some SCADA log tables carry an `id` with no PK constraint).
        skip = _primary_key_columns(conn, schema, table) | {"id"}
    value_columns = [c for c, t in columns.items() if t in _NUMERIC_TYPES and c not in skip]
    ts_columns = [c for c, t in columns.items() if t in _TS_TYPES]
    return {
        "value_columns": value_columns,
        "ts_columns": ts_columns,
        # Any column may identify a series; numeric value columns are the least
        # useful as a filter so they're excluded to keep the list focused.
        "filter_columns": [c for c in columns if c not in value_columns],
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
    """Newest matching row's value (+ ts when a timestamp column is given)."""
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


def table_series(
    table: str,
    value_col: str,
    filter_col: str | None,
    filter_val: str | None,
    ts_col: str,
    minutes: int,
    datasource_id: int | None = None,
) -> list[dict[str, Any]]:
    """Time-ordered rows over the last `minutes` (requires a timestamp column)."""
    with _table_source_conn(datasource_id) as (conn, schema):
        _safe_identifiers(conn, schema, table, value_col, filter_col, ts_col)
        query = sql.SQL(
            "SELECT {val} AS value, {ts} AS ts FROM {tbl} WHERE {ts} >= "
            "now() - make_interval(mins => %s)"
        ).format(
            val=sql.Identifier(value_col),
            ts=sql.Identifier(ts_col),
            tbl=sql.Identifier(schema, table),
        )
        params: list[Any] = [minutes]
        if filter_col and filter_val is not None:
            query += sql.SQL(" AND {}::text = %s").format(sql.Identifier(filter_col))
            params.append(filter_val)
        query += sql.SQL(" ORDER BY {} ASC").format(sql.Identifier(ts_col))
        rows = conn.execute(query, params).fetchall()
    return rows


# --- Saved connections (datasources) ----------------------------------------
# Admin-managed named Postgres connections. Panels reference one via
# dashboard_panels.datasource_id. Passwords are stored as-is (parity with the
# app's own .env credential) and are NEVER returned by the public API — callers
# get a `has_password` flag instead. `database` is stored in column `dbname`
# (avoids the reserved-ish identifier) and aliased back on read.
def init_datasources_table() -> None:
    """Create the datasources table if it doesn't exist. Idempotent."""
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS datasources (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL UNIQUE,
                type       TEXT NOT NULL DEFAULT 'postgres',
                host       TEXT NOT NULL DEFAULT '',
                port       INTEGER NOT NULL DEFAULT 5432,
                dbname     TEXT NOT NULL DEFAULT '',
                username   TEXT NOT NULL DEFAULT '',
                password   TEXT NOT NULL DEFAULT '',
                sslmode    TEXT NOT NULL DEFAULT 'prefer',
                db_schema  TEXT NOT NULL DEFAULT 'public',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        # Added after initial release — idempotent so existing tables pick it up.
        conn.execute(
            "ALTER TABLE datasources "
            "ADD COLUMN IF NOT EXISTS db_schema TEXT NOT NULL DEFAULT 'public'"
        )
        conn.commit()


# Public projection — everything the frontend needs minus the secret.
_DS_PUBLIC_COLS = (
    "id, name, type, host, port, dbname AS database, username, sslmode, "
    "db_schema, (password <> '') AS has_password, created_at, updated_at"
)


def list_datasources() -> list[dict[str, Any]]:
    """All saved connections, password-free, ordered by name."""
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT {_DS_PUBLIC_COLS} FROM datasources ORDER BY name"
        ).fetchall()
    return rows


def get_datasource(datasource_id: int) -> dict[str, Any] | None:
    """One saved connection, password-free. None if it doesn't exist."""
    with get_connection() as conn:
        row = conn.execute(
            f"SELECT {_DS_PUBLIC_COLS} FROM datasources WHERE id = %s",
            (datasource_id,),
        ).fetchone()
    return row


def get_datasource_secret(datasource_id: int) -> dict[str, Any] | None:
    """One saved connection WITH its password — for opening connections only.
    Never expose the result of this directly through the API."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, name, type, host, port, dbname AS database, username, "
            "password, sslmode, db_schema FROM datasources WHERE id = %s",
            (datasource_id,),
        ).fetchone()
    return row


def create_datasource(
    name: str,
    type: str,
    host: str,
    port: int,
    database: str,
    username: str,
    password: str,
    sslmode: str,
    db_schema: str = "public",
) -> dict[str, Any]:
    """Insert a connection. Raises psycopg.errors.UniqueViolation on dup name."""
    with get_connection() as conn:
        row = conn.execute(
            f"""INSERT INTO datasources
                (name, type, host, port, dbname, username, password, sslmode, db_schema)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_DS_PUBLIC_COLS}""",
            (name, type, host, port, database, username, password, sslmode, db_schema),
        ).fetchone()
        conn.commit()
    return row


def update_datasource(
    datasource_id: int,
    name: str,
    type: str,
    host: str,
    port: int,
    database: str,
    username: str,
    password: str | None,
    sslmode: str,
    db_schema: str = "public",
) -> dict[str, Any] | None:
    """Update a connection. A None password keeps the stored one (so the editor
    need not round-trip the secret). Returns None if no such datasource."""
    with get_connection() as conn:
        row = conn.execute(
            f"""UPDATE datasources
            SET name = %s, type = %s, host = %s, port = %s, dbname = %s,
                username = %s, password = COALESCE(%s, password),
                sslmode = %s, db_schema = %s, updated_at = now()
            WHERE id = %s
            RETURNING {_DS_PUBLIC_COLS}""",
            (name, type, host, port, database, username, password, sslmode,
             db_schema, datasource_id),
        ).fetchone()
        conn.commit()
    return row


def delete_datasource(datasource_id: int) -> bool:
    """Delete a connection. Returns True if a row was removed. Panels keep their
    (now-dangling) datasource_id; routing falls back to the app database."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM datasources WHERE id = %s", (datasource_id,))
        conn.commit()
        return cur.rowcount > 0
