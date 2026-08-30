"""Thin PostgreSQL access layer using psycopg 3."""
import atexit
import logging
import threading
from collections import deque
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from time import monotonic
from typing import Any

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Json
from psycopg_pool import ConnectionPool, PoolTimeout

import config
import security
from production_log import aggregate_counter_samples

logger = logging.getLogger("mml-api.db")

# Set by main._ensure_tables once the schema DDL has run against the active
# database. False means the app is serving without a verified schema.
SCHEMA_READY = False

# --- Connection pools -------------------------------------------------------
# One pool per database the process talks to: `None` is the app/config database
# (always localhost), an int is a saved datasource. Pooling matters because the
# fan-out reads below hit every selected datasource on a 1-5s cadence, and a
# fresh TCP+TLS+auth handshake per poll per source does not fit in the budget.
_pools: dict[int | None, "ConnectionPool"] = {}
_pool_schemas: dict[int | None, str] = {None: config.APP_DB_SCHEMA}
_pool_lock = threading.Lock()

# Cached app-DB health served by /health. Only ever describes localhost --
# per-datasource health is reported separately by datasource_health().
_db_state: dict[str, Any] = {"ok": False, "checked_at": None}

# Datasource ids already reported as unreachable, so a plant that stays down
# does not re-log on every poll.
_outage_logged: set[int | None] = set()
_ds_errors: dict[int | None, str | None] = {}

#: How long a source stays fast-failing after a connection failure, i.e. how
#: often it is re-probed. Kept at the poll cadence: long enough that one dead
#: plant costs one connect timeout per round instead of one per request, short
#: enough that a plant coming back is noticed on the next poll rather than after
#: a backoff an operator would read as "still broken".
_DS_RETRY_AFTER_S = 5.0
_ds_down_until: dict[int | None, float] = {}
_ds_probing: set[int | None] = set()
_ds_down_lock = threading.Lock()


def _first_line(exc: Exception) -> str | None:
    text = str(exc).strip()
    return text.splitlines()[0] if text else None


def _claim_probe(datasource_id: int | None) -> bool:
    """Whether this caller should really attempt a connection to a known-down
    source, or fast-fail on the last known error instead.

    One Monitor poll issues a request per bound symbol, and one Live page issues
    a request per tile. Letting each of them independently pay DB_CONNECT_TIMEOUT
    against a powered-off plant queues work faster than it drains: the fan-out
    workers fill with sleeping sockets and requests for *healthy* sources — and
    for the app database — start timing out behind them. The page then stops
    responding altogether, which is a far worse failure than the one source being
    unreachable.

    So a source that just failed is fast-failed for `_DS_RETRY_AFTER_S`, after
    which exactly one caller is let through to probe it while the rest keep
    fast-failing. That single probe is the reconnection attempt: when it
    succeeds the window is cleared and every subsequent request goes straight
    through, so recovery costs one poll, not a restart.
    """
    with _ds_down_lock:
        until = _ds_down_until.get(datasource_id)
        if until is None:
            return True
        if monotonic() < until or datasource_id in _ds_probing:
            return False
        _ds_probing.add(datasource_id)
        return True


def _mark_reachable(datasource_id: int | None) -> None:
    """Record that this source answered, whatever the query then did."""
    if datasource_id in _outage_logged:
        logger.info("Datasource %s reachable again", datasource_id)
        _outage_logged.discard(datasource_id)
    _ds_errors[datasource_id] = None
    _probe_done(datasource_id, ok=True)


def _probe_done(datasource_id: int | None, *, ok: bool) -> None:
    """Close out a connection attempt, opening or extending the fast-fail window."""
    with _ds_down_lock:
        _ds_probing.discard(datasource_id)
        if ok:
            _ds_down_until.pop(datasource_id, None)
        else:
            _ds_down_until[datasource_id] = monotonic() + _DS_RETRY_AFTER_S


def _record(ok: bool, error: str | None = None) -> None:
    """Update cached app-DB health.

    Written on every app-DB connection attempt rather than from a background
    loop, so it can never report a stale "ok" for a database that died after boot.
    """
    _db_state["ok"] = ok
    _db_state["checked_at"] = datetime.now(timezone.utc).isoformat()
    _ds_errors[None] = error


def db_state() -> dict[str, Any]:
    """Snapshot of app-database health for /health and the admin status route."""
    return {
        "ok": _db_state["ok"],
        "checked_at": _db_state["checked_at"],
        "schema_ready": SCHEMA_READY,
        "host": config.APP_DB_HOST,
        "database": config.APP_DB_NAME,
        "schema": config.APP_DB_SCHEMA,
    }


def _build_pool(datasource_id: int | None) -> tuple["ConnectionPool", str]:
    """Construct (but do not block on) a pool for one database.

    `open=False` then `open(wait=False)` is deliberate: a powered-off plant host
    must not stall startup or the first request that happens to touch it. The
    failure surfaces later at `pool.connection()` as PoolTimeout, which fan_out
    catches per source.
    """
    if datasource_id is None:
        kwargs = dict(config.APP_DB_KWARGS)
        min_size, max_size, schema = (
            config.APP_DB_POOL_MIN, config.APP_DB_POOL_MAX, config.APP_DB_SCHEMA,
        )
    else:
        try:
            ds = get_datasource_secret(datasource_id)
        except security.SecretDecryptionError as e:
            # Record before re-raising. Decryption happens here, *above* the
            # probe/_ds_errors bookkeeping in _connect, so without this the
            # source stays absent from _ds_errors and datasource_health() reports
            # it as ok=True/"never tried" -- a broken credential looking healthy
            # on the very page an admin opens to find broken credentials.
            _ds_errors[datasource_id] = _first_line(e) or str(e)
            raise
        if ds is None:
            raise ValueError(f"datasource {datasource_id} not found")
        kwargs = dict(
            host=ds["host"], port=ds["port"], dbname=ds["database"],
            user=ds["username"], password=ds["password"], sslmode=ds["sslmode"],
            connect_timeout=config.DB_CONNECT_TIMEOUT,
        )
        # min_size=0: a saved-but-unselected datasource must hold zero sockets.
        min_size, max_size = 0, config.DS_POOL_MAX
        schema = ds.get("db_schema") or "public"

    pool = ConnectionPool(
        kwargs={**kwargs, "row_factory": dict_row},
        min_size=min_size, max_size=max_size,
        timeout=config.DB_CONNECT_TIMEOUT,
        open=False, name=f"ds-{datasource_id}",
    )
    pool.open(wait=False)
    return pool, schema


def _pool_for(datasource_id: int | None) -> "ConnectionPool":
    """Pool for one database, created on first use."""
    with _pool_lock:
        pool = _pools.get(datasource_id)
        if pool is not None:
            return pool
    # Build outside the lock: resolving a datasource's secret is itself an
    # app-DB query, and holding _pool_lock across it would deadlock against the
    # nested _pool_for(None) that query needs.
    pool, schema = _build_pool(datasource_id)
    with _pool_lock:
        existing = _pools.get(datasource_id)
        if existing is not None:
            # Lost a race; discard ours rather than leak the loser's sockets.
            pool.close()
            return existing
        _pools[datasource_id] = pool
        _pool_schemas[datasource_id] = schema
        return pool


def drop_pool(datasource_id: int) -> None:
    """Discard a datasource's pool after its row was edited or deleted.

    close() is called *outside* _pool_lock: it waits for checked-out connections
    to be returned, and a fan-out worker blocked in _pool_for would deadlock
    against it.
    """
    with _pool_lock:
        pool = _pools.pop(datasource_id, None)
        _pool_schemas.pop(datasource_id, None)
    _outage_logged.discard(datasource_id)
    _ds_errors.pop(datasource_id, None)
    with _ds_down_lock:
        _ds_down_until.pop(datasource_id, None)
        _ds_probing.discard(datasource_id)
    if pool is not None:
        pool.close()


def close_all_pools() -> None:
    """Release every pooled socket. Called on shutdown so a uvicorn reload does
    not leak connections into the plant databases."""
    with _pool_lock:
        pools = list(_pools.values())
        _pools.clear()
        _pool_schemas.clear()
        _pool_schemas[None] = config.APP_DB_SCHEMA
    for pool in pools:
        try:
            pool.close()
        except Exception:  # noqa: BLE001 - shutdown must not raise
            pass


# A pool runs background worker threads. Left to the garbage collector they are
# joined during interpreter finalization, which raises PythonFinalizationError --
# harmless but alarming noise in every CLI script and test run. atexit runs early
# enough that the join succeeds. main.py still closes them explicitly on shutdown
# so a uvicorn reload releases plant sockets without waiting for process exit.
atexit.register(close_all_pools)


@contextmanager
def get_connection():
    """A connection to the APP/CONFIG database (always localhost).

    Never plant data. Everything reachable from here -- users, dashboards,
    panels, mimic layouts, report templates, saved datasources -- is MMLPortal's
    own state. Plant reads go through `_table_source_conn(datasource_id)`.
    """
    try:
        with _pool_for(None).connection() as conn:
            _record(True)
            yield conn
    except (psycopg.OperationalError, PoolTimeout) as e:
        detail = _first_line(e) or repr(e)
        _record(False, detail)
        if None not in _outage_logged:
            logger.warning("App database unreachable: %s", detail)
            _outage_logged.add(None)
        raise
    else:
        if None in _outage_logged:
            logger.info("App database reachable again")
            _outage_logged.discard(None)


def ensure_app_schema() -> None:
    """Create the configured app-DB schema if it doesn't exist yet.

    Must run before every ``init_*_table()`` call: those all use unqualified
    table names and rely on ``search_path`` (baked into ``APP_DB_KWARGS``)
    resolving to ``config.APP_DB_SCHEMA``. A schema that doesn't exist yet
    doesn't fail at connect time -- only on the first unqualified CREATE TABLE,
    with a confusing "no schema has been selected to create in" -- so this has
    to run first, and explicitly, rather than relying on Postgres to fall
    through to another schema.
    """
    with get_connection() as conn:
        conn.execute(
            sql.SQL("CREATE SCHEMA IF NOT EXISTS {}")
            .format(sql.Identifier(config.APP_DB_SCHEMA))
        )
        conn.commit()


def probe() -> bool:
    """Open and close one app-DB connection purely to refresh cached health.

    Lets /health stay accurate on an idle service, where no request would
    otherwise exercise get_connection().
    """
    try:
        with get_connection() as conn:
            conn.execute("SELECT 1")
        return True
    except (psycopg.OperationalError, PoolTimeout):
        return False


def datasource_health() -> list[dict[str, Any]]:
    """Per-datasource connection detail for the admin-gated status route.

    Never exposed on /health: the error text carries host and port.

    There are three real states, not two: never tried, working, failing. `ok`
    answers only "is there a known failure", so an untried source reports
    ok=True / in_use=False rather than ok=False -- a configured plant nobody has
    opened yet is not a broken one, and reporting it as broken trains an admin
    to ignore this page. `in_use` is what says whether ok=True was actually
    verified.
    """
    with _pool_lock:
        in_use = set(_pools) - {None}
    rows = list_datasources()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "in_use": r["id"] in in_use,
            "last_error": _ds_errors.get(r["id"]),
            "ok": _ds_errors.get(r["id"]) is None,
            "credential_state": datasource_credential_state(r["id"]),
        }
        for r in rows
    ]


def datasource_reachable(datasource_id: int | None) -> bool:
    """True when the most recent plant query against this source succeeded.

    Absent from `_ds_errors` means "never tried"; the value is set to None only
    after a query actually came back. This is how the request path — panels
    polling every few seconds — reports a recovered plant to the background tag
    buffer, which would otherwise sit out its full backoff before finding out.
    """
    return _ds_errors.get(datasource_id, "never tried") is None


# --- Fan-out across the selected datasources --------------------------------
# A module-level bounded executor, not a per-call `with ThreadPoolExecutor(...)`:
# the per-call form creates and joins N OS threads per request, and at 1 Hz x N
# panels x N sources that is real churn plus an unbounded thread count. The cap
# also bounds total concurrent remote connections independently of DS_POOL_MAX.
_fanout_pool = ThreadPoolExecutor(
    max_workers=config.FANOUT_MAX_WORKERS, thread_name_prefix="ds-fanout"
)
atexit.register(lambda: _fanout_pool.shutdown(wait=False, cancel_futures=True))


def fan_out(
    datasource_ids: Sequence[int | None],
    query,
    *,
    timeout: int | None = None,
    label: str = "query",
) -> list[dict[str, Any]]:
    """Run ``query(datasource_id)`` against each source concurrently.

    Returns one entry per input id, in the SAME order as ``datasource_ids``::

        {"datasource_id", "datasource_name", "ok", "result", "error"}

    Threaded rather than sequential because /api/alarms/active is polled once a
    second. With three sources of which one is powered off, sequential costs a
    full connect timeout plus two live queries *every tick* — the poll interval
    is exceeded before the first byte and requests queue until the anyio
    threadpool is exhausted. Threaded costs max(...) instead of sum(...), and the
    dead source's timeout is paid on a worker, not on the request thread.

    Error contract: a per-source failure NEVER propagates. An OperationalError
    from a powered-off host, an UndefinedTable from a plant DB with no
    `event_logs` — caught, reduced to its first line, returned as ok=False.
    Callers decide what partial means for them.

    A future not complete within `timeout` is recorded ok=False and abandoned
    rather than cancelled: libpq is already blocked in a syscall, so cancelling
    would not free the worker any sooner.

    Callers must be sync defs. Every affected route already is, so it runs on the
    anyio worker threadpool where blocking is correct.
    """
    ids = list(datasource_ids)
    names = datasource_names(ids)
    deadline = (timeout if timeout is not None else config.FANOUT_TIMEOUT_S)
    futures = [_fanout_pool.submit(query, ds_id) for ds_id in ids]

    out: list[dict[str, Any]] = []
    remaining = deadline
    for ds_id, future in zip(ids, futures):
        started = monotonic()
        try:
            result = future.result(timeout=max(remaining, 0))
            entry = {"ok": True, "result": result, "error": None}
        except FuturesTimeout:
            remaining = 0
            entry = {"ok": False, "result": None, "error": "timed out"}
            logger.warning("Fan-out %s timed out on datasource %s", label, ds_id)
        except Exception as e:  # noqa: BLE001 — isolation is the whole point
            detail = _first_line(e) or type(e).__name__
            entry = {"ok": False, "result": None, "error": detail}
            logger.warning("Fan-out %s failed on datasource %s: %s", label, ds_id, detail)
        else:
            remaining -= monotonic() - started
        out.append({
            "datasource_id": ds_id,
            "datasource_name": names.get(ds_id, str(ds_id)),
            **entry,
        })
    return out


def fan_out_rows(
    datasource_ids: Sequence[int | None],
    query,
    *,
    label: str = "rows",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """fan_out + flatten. Every row gains `datasource_id` and `datasource_name`.

    Returns ``(rows, sources)``. `sources` is the per-source report, kept even on
    success so the UI can say which plants a merged list actually came from —
    "3 alarms" means something different from two sources than from one.

    Rows are tagged rather than grouped because the pages that consume this merge
    and sort across sources anyway; the tag is what makes React keys and the
    acknowledge path able to tell two plants' identically-named rows apart.
    """
    reports = fan_out(datasource_ids, query, label=label)
    rows: list[dict[str, Any]] = []
    for report in reports:
        for row in report["result"] or []:
            rows.append({
                **row,
                "datasource_id": report["datasource_id"],
                "datasource_name": report["datasource_name"],
            })
    sources = [
        {k: r[k] for k in ("datasource_id", "datasource_name", "ok", "error")}
        for r in reports
    ]
    return rows, sources


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


def count_users() -> int:
    """Every row in `users` counts toward the license's max_users seat cap,
    including the seeded/initial admin — there is no free/excluded seat."""
    with get_connection() as conn:
        row = conn.execute("SELECT count(*) AS n FROM users").fetchone()
    return int(row["n"])


# --- Live sensor readings (real-time charts) --------------------------------
# Plant data. Every function here takes a `datasource_id` and reaches the
# database through _table_source_conn, which also supplies that source's
# configured schema. The schema part is easy to miss and matters: a saved
# datasource can be on something other than `public`, and the hardcoded
# `public.`/bare table names these used to carry would silently 500 there.
def list_devices(datasource_id: int | None = None) -> list[dict[str, Any]]:
    """All monitored devices, ordered by id."""
    with _table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT id, name, type, location, status
                FROM {} ORDER BY id"""
            ).format(sql.Identifier(schema, "devices"))
        ).fetchall()
    return rows


def list_metrics(device_id: int, datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Distinct metrics (with their most recent unit) recorded for a device."""
    with _table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT DISTINCT ON (metric) metric, unit
                FROM {}
                WHERE device_id = %s
                ORDER BY metric, ts DESC"""
            ).format(sql.Identifier(schema, "sensor_readings")),
            (device_id,),
        ).fetchall()
    return rows


def latest_reading(
    device_id: int, metric: str, datasource_id: int | None = None
) -> dict[str, Any] | None:
    """Single most-recent reading for a device/metric, or None if none exist."""
    with _table_source_conn(datasource_id) as (conn, schema):
        row = conn.execute(
            sql.SQL(
                """SELECT value, unit, ts
                FROM {}
                WHERE device_id = %s AND metric = %s
                ORDER BY ts DESC LIMIT 1"""
            ).format(sql.Identifier(schema, "sensor_readings")),
            (device_id, metric),
        ).fetchone()
    return row


def reading_series(
    device_id: int, metric: str, minutes: int, datasource_id: int | None = None
) -> list[dict[str, Any]]:
    """Time-ordered readings for a device/metric over the last `minutes`."""
    with _table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT value, unit, ts
                FROM {}
                WHERE device_id = %s AND metric = %s
                  AND ts >= now() - make_interval(mins => %s)
                ORDER BY ts ASC"""
            ).format(sql.Identifier(schema, "sensor_readings")),
            (device_id, metric, minutes),
        ).fetchall()
    return rows


# --- Dashboard panels (admin-managed live grid) -----------------------------
def init_panels_table() -> None:
    """Create the dashboard_panels table if it doesn't exist. Idempotent.

    ``options`` (JSONB) holds the per-visualization parameters (min/max,
    thresholds, decimals, orientation, …) so each panel can render in a
    different form. Added as an idempotent migration for existing tables.
    ``source`` is 'device' (legacy device+metric) or 'tag' (variables_tag row).
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
    with _table_source_conn(datasource_id) as (conn, schema):
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
    with _table_source_conn(datasource_id) as (conn, schema):
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
    with _table_source_conn(datasource_id) as (conn, schema):
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
    with _table_source_conn(datasource_id) as (conn, schema):
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


# --- Event log (real SCADA data — event_logs, read-only) ---------------------
def list_recent_events(limit: int, datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Last `limit` events per (location, tag_name), newest first.

    Reads the externally-populated event_logs. Ordered so the frontend can
    group location -> tag_name in a single pass.
    """
    with _table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT location, tag_name, event, at_date_time
                   FROM (
                     SELECT location, tag_name, event, at_date_time,
                            ROW_NUMBER() OVER (
                              PARTITION BY location, tag_name
                              ORDER BY at_date_time DESC
                            ) AS rn
                     FROM {}
                   ) ranked
                   WHERE rn <= %s
                   ORDER BY location, tag_name, at_date_time DESC"""
            ).format(sql.Identifier(schema, "event_logs")),
            (limit,),
        ).fetchall()
    return rows


# --- Alarm log (real SCADA data — alarm_logs) --------------------------------
# DB column `alarm_events` is surfaced as API field `alarm`; `created_at` is
# surfaced as `at_date_time` so the frontend can share the events timestamp
# shape. Severity / acknowledgement columns were added via a one-shot
# migration (see _probe_alarms.py).
def list_recent_alarms(limit: int, datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Last `limit` alarms per (location, tag_name), newest first."""
    with _table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
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
                     FROM {}
                   ) ranked
                   WHERE rn <= %s
                   ORDER BY location, tag_name, created_at DESC"""
            ).format(sql.Identifier(schema, "alarm_logs")),
            (limit,),
        ).fetchall()
    return rows


def list_active_alarms(datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Tags currently in alarm (variables_tag.alarm_no not null), joined to the
    triggering alarm_logs row for the event text. Empty list when nothing active."""
    with _table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT st.tag_name, st.location,
                          st.alarm_value, st.alarm_no, st.alarm_active,
                          al.id            AS alarm_id,
                          al.alarm_events  AS alarm,
                          al.severity,
                          al.created_at    AS at_date_time
                   FROM {tags} st
                   JOIN {alarms} al ON al.id = st.alarm_no
                   WHERE st.alarm_no IS NOT NULL
                   ORDER BY st.location, st.tag_name"""
            ).format(
                tags=sql.Identifier(schema, "variables_tag"),
                alarms=sql.Identifier(schema, "alarm_logs"),
            )
        ).fetchall()
    return rows


def acknowledge_alarm(
    alarm_id: int, user_id: int, datasource_id: int | None = None
) -> dict[str, Any] | None:
    """Mark an alarm acknowledged. Returns the updated row, or None if the
    alarm doesn't exist or was already acknowledged.

    Never fan this out. Alarm ids come from each database's own sequence and
    therefore collide across sources: trying each source in turn would happily
    acknowledge a different plant's alarm. The caller must resolve exactly one
    datasource_id before calling.
    """
    with _table_source_conn(datasource_id) as (conn, schema):
        row = conn.execute(
            sql.SQL(
                """UPDATE {}
                      SET acknowledged    = TRUE,
                          acknowledged_at = now(),
                          acknowledged_by = %s
                    WHERE id = %s AND acknowledged = FALSE
                    RETURNING id, location, tag_name,
                              alarm_events AS alarm,
                              severity,
                              created_at   AS at_date_time,
                              acknowledged, acknowledged_at, acknowledged_by"""
            ).format(sql.Identifier(schema, "alarm_logs")),
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


def update_panel_poll_interval(panel_id: int, poll_interval_seconds: int) -> dict[str, Any] | None:
    """Update only a panel's poll cadence. Returns None if no such panel.

    Narrower than update_panel() so operators can be granted this one write
    without exposing the rest of a panel's config (title, source, options, …)
    to a non-admin role.
    """
    with get_connection() as conn:
        row = conn.execute(
            f"""UPDATE dashboard_panels
            SET poll_interval_seconds = %s
            WHERE id = %s
            RETURNING {_PANEL_COLS}""",
            (poll_interval_seconds, panel_id),
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
#
# Scoped to the database it is protecting, which it was not always: the denylist
# used to be one flat set matched on the bare table name, so a *plant* table
# that happened to share a name with an app table was unreachable. That was
# invisible until the vision tables moved out of the app database — a site
# keeping its cameras in `vision_line9` could not bind them, because the app
# database's own `cameras` had claimed the name globally.
_APP_SENSITIVE_TABLES = {
    "users", "dashboard_panels", "mmldatabuffer", "datasources", "mimic_layouts",
    "mimic_assets", "mimic_symbols",
}

# Denied on a plant connection too. Not app-internal state — these are the two
# names that would hold credentials *in any database*, and a plant historian
# with a `users` table is a plausible enough accident to keep refusing. The
# camera tables are deliberately absent: on a plant source they are inspection
# results, and nothing in them is a secret.
_PLANT_SENSITIVE_TABLES = {"users", "datasources"}


def _sensitive_tables(app_db: bool) -> set[str]:
    return _APP_SENSITIVE_TABLES if app_db else _PLANT_SENSITIVE_TABLES

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
        with get_connection() as conn:
            yield conn, config.APP_DB_SCHEMA
        return
    # Resolve the pool *before* claiming the probe. _pool_for raises ValueError
    # for an unknown id, and a claim made above it would never be released --
    # wedging that id into fast-fail for the life of the process.
    pool = _pool_for(datasource_id)
    # Read the schema after _pool_for, which is what populates it.
    schema = _pool_schemas.get(datasource_id, "public")
    # Raised as OperationalError, not a bespoke type, because that is what this
    # is -- and because every caller and test already handles it.
    if not _claim_probe(datasource_id):
        raise psycopg.OperationalError(
            _ds_errors.get(datasource_id) or f"datasource {datasource_id} unreachable"
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
            detail = _first_line(unreachable) or repr(unreachable)
            _ds_errors[datasource_id] = detail
            _probe_done(datasource_id, ok=False)
            if datasource_id not in _outage_logged:
                logger.warning("Datasource %s unreachable: %s", datasource_id, detail)
                _outage_logged.add(datasource_id)
        else:
            # Every other outcome means the host answered — including a query
            # fault (missing table, bad column, denied identifier), which says
            # nothing about reachability. Recording those as down would
            # fast-fail every other panel on this source and keep the tag buffer
            # parked on evidence of nothing.
            _mark_reachable(datasource_id)


def _allowed_tables(conn, schema: str, datasource_id: int | None) -> set[str]:
    """Chartable base-table names in ``schema`` (minus the sensitive denylist).

    Takes the datasource id rather than a bool so callers pass the value they
    already hold — an ``app_db=`` flag is the kind of argument that eventually
    gets handed the wrong way round at one call site out of nine.
    """
    denied = _sensitive_tables(datasource_id is None)
    rows = conn.execute(
        """SELECT table_name FROM information_schema.tables
           WHERE table_schema = %s AND table_type = 'BASE TABLE'""",
        (schema,),
    ).fetchall()
    return {r["table_name"] for r in rows if r["table_name"] not in denied}


def list_schema_tables(datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Base tables an admin may chart, minus the sensitive denylist."""
    with _table_source_conn(datasource_id) as (conn, schema):
        names = sorted(_allowed_tables(conn, schema, datasource_id))
    return [{"table": n, "label": n} for n in names]


def _table_columns(
    conn, schema: str, table: str, datasource_id: int | None
) -> dict[str, str]:
    """{column_name: data_type} for an allowlisted table in ``schema``.

    Validation gate for all dynamic-SQL builders: raises ValueError if the table
    is not in the (denylist-filtered) allowlist, so a caller can never reference
    an arbitrary or sensitive table.
    """
    if table not in _allowed_tables(conn, schema, datasource_id):
        raise ValueError(f"Table not allowed: {table!r}")
    rows = conn.execute(
        """SELECT column_name, data_type
           FROM information_schema.columns
           WHERE table_schema = %s AND table_name = %s
           ORDER BY ordinal_position""",
        (schema, table),
    ).fetchall()
    return {r["column_name"]: r["data_type"] for r in rows}


def _safe_identifiers(
    conn, schema: str, table: str, *cols: str | None, datasource_id: int | None = None
) -> dict[str, str]:
    """Validate table + columns; return the table's {col: type} map.

    Each non-None column must exist on the table. Raises ValueError otherwise.

    ``datasource_id`` is keyword-only because ``cols`` is variadic — a
    positional id would be silently swallowed as another column name.
    """
    columns = _table_columns(conn, schema, table, datasource_id)
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
        columns = _table_columns(conn, schema, table, datasource_id)
        # Numeric columns are chartable values, but a surrogate key identifies
        # rows, not a metric — exclude PK columns and any column conventionally
        # named `id` (some SCADA log tables carry an `id` with no PK constraint).
        skip = _primary_key_columns(conn, schema, table) | {"id"}
    value_columns = [c for c, t in columns.items() if t in _NUMERIC_TYPES and c not in skip]
    ts_columns = [c for c, t in columns.items() if t in _TS_TYPES]
    datetime_columns = [c for c, t in columns.items() if t in _DATETIME_TYPES]
    # A status/description column: readable by symbols that print words, useless
    # to anything that scales or plots. `skip` applies here too — a text primary
    # key names the row rather than reporting anything about it.
    text_columns = [c for c, t in columns.items() if t in _TEXT_TYPES and c not in skip]
    return {
        "value_columns": value_columns,
        "ts_columns": ts_columns,
        "datetime_columns": datetime_columns,
        "text_columns": text_columns,
        # Any column may identify a series; numeric value columns are the least
        # useful as a filter so they're excluded to keep the list focused. Text
        # columns stay in: naming the device is what they are usually for, and a
        # column being printable somewhere else does not stop it identifying a row.
        "filter_columns": [c for c in columns if c not in value_columns],
    }


def distinct_column_values(
    table: str, column: str, limit: int, datasource_id: int | None = None
) -> list[str]:
    """Distinct non-null values of a filter column (series picker)."""
    with _table_source_conn(datasource_id) as (conn, schema):
        _safe_identifiers(conn, schema, table, column, datasource_id=datasource_id)
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
        and is_tag_buffered(datasource_id)
    ):
        buffered = buffered_tag_latest(filter_val, value_col, datasource_id)
        if buffered is not None:
            return buffered
    with _table_source_conn(datasource_id) as (conn, schema):
        _safe_identifiers(
            conn, schema, table, value_col, filter_col, ts_col,
            datasource_id=datasource_id,
        )
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
    """Time-ordered rows over the last `minutes` (requires a timestamp column).

    variables_tag is a special case: it has no real row history (overwritten
    in place — see snapshot_variables_tag's docstring), so a panel bound
    directly to it and filtered by tag_name is served from the in-memory buffer
    instead of the table's always-≤1-row SQL query.

    Gated on the source actually being sampled, not on it being the app DB: a
    source the buffer loop never polls would otherwise render a permanently
    blank chart, which is worse than a slower live query returning one point.
    """
    if (
        table == "variables_tag"
        and filter_col == "tag_name"
        and filter_val is not None
        and is_tag_buffered(datasource_id)
    ):
        return buffered_tag_series(filter_val, value_col, minutes, datasource_id)
    with _table_source_conn(datasource_id) as (conn, schema):
        _safe_identifiers(
            conn, schema, table, value_col, filter_col, ts_col,
            datasource_id=datasource_id,
        )
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


def production_log_hourly(
    binding: dict[str, Any], datasource_id: int | None = None
) -> dict[str, Any]:
    """Hourly good/reject counter deltas for the current plant-local shift.

    One sample immediately before 08:00 is included as the baseline. The pure
    aggregator owns reset semantics; this adapter owns identifier safety and
    reading from the configured plant connection.
    """
    table = binding["table"]
    ts_col = binding["ts_col"]
    produced_col = binding["produced_col"]
    rejected_col = binding["rejected_col"]
    filter_col = binding.get("filter_col")
    filter_val = binding.get("filter_val")

    with _table_source_conn(datasource_id) as (conn, schema):
        # Identifier validation below queries information_schema, so establish
        # the request snapshot before even that first read.
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        _safe_identifiers(
            conn, schema, table, ts_col, produced_col, rejected_col, filter_col,
            datasource_id=datasource_id,
        )
        table_sql = sql.Identifier(schema, table)
        fields = sql.SQL("{ts} AS ts, {produced} AS produced, {rejected} AS rejected").format(
            ts=sql.Identifier(ts_col),
            produced=sql.Identifier(produced_col),
            rejected=sql.Identifier(rejected_col),
        )
        filter_sql = sql.SQL("")
        params: list[Any] = []
        if filter_col and filter_val is not None:
            filter_sql = sql.SQL(" AND {}::text = %s").format(sql.Identifier(filter_col))
            params.append(filter_val)

        # Keep the three reads on one database snapshot, and use the captured
        # plant timestamp as the upper bound.  That prevents future-dated rows
        # (or rows committed halfway through this request) from leaking into a
        # bucket that the response still describes as a current snapshot.
        generated_at = conn.execute("SELECT now() AS generated_at").fetchone()["generated_at"]
        baseline = conn.execute(
            sql.SQL(
                "SELECT {fields} FROM {table} "
                "WHERE {ts} < CURRENT_DATE + time '08:00'{filter} "
                "ORDER BY {ts} DESC NULLS LAST LIMIT 1"
            ).format(
                fields=fields, table=table_sql, ts=sql.Identifier(ts_col), filter=filter_sql,
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
                fields=fields, table=table_sql, ts=sql.Identifier(ts_col), filter=filter_sql,
            ),
            [generated_at, *params],
        ).fetchall()

    samples = ([baseline] if baseline else []) + list(rows)
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
    with _table_source_conn(datasource_id) as (conn, schema):
        _safe_identifiers(
            conn, schema, table, *columns, filter_col, ts_col,
            datasource_id=datasource_id,
        )
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


def init_users_table() -> None:
    """Create the users table if it doesn't exist. Idempotent.

    Mirrors seed_users.CREATE_TABLE. Duplicated deliberately: the app cannot log
    anyone in without this table, and `user_datasource_selection` carries a
    foreign key to it, so it has no business being create-on-demand from a
    seeding script that a fresh install might never run.
    """
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS users (
                id            SERIAL PRIMARY KEY,
                username      TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'operator',
                display_name  TEXT NOT NULL,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT")
        conn.execute(
            """CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
               ON users (lower(email)) WHERE email IS NOT NULL"""
        )
        conn.commit()


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


def count_datasources() -> int:
    with get_connection() as conn:
        row = conn.execute("SELECT count(*) AS n FROM datasources").fetchone()
    return int(row["n"])


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
    if row is not None:
        row["password"] = security.decrypt_secret(row["password"])
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
            (name, type, host, port, database, username,
             security.encrypt_secret(password), sslmode, db_schema),
        ).fetchone()
        conn.commit()
    _refresh_credential_state_after_write()
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
    stored_password = password if password is None else security.encrypt_secret(password)
    with get_connection() as conn:
        row = conn.execute(
            f"""UPDATE datasources
            SET name = %s, type = %s, host = %s, port = %s, dbname = %s,
                username = %s, password = COALESCE(%s, password),
                sslmode = %s, db_schema = %s, updated_at = now()
            WHERE id = %s
            RETURNING {_DS_PUBLIC_COLS}""",
            (name, type, host, port, database, username, stored_password, sslmode,
             db_schema, datasource_id),
        ).fetchone()
        conn.commit()
    # The pool holds the *old* host/credentials/schema. Drop it so the next read
    # rebuilds against what was just saved, rather than silently querying the
    # previous server until the process restarts.
    drop_pool(datasource_id)
    _refresh_credential_state_after_write()
    return row


def _refresh_credential_state_after_write() -> None:
    """Re-audit after a committed datasource write so the admin status page and
    _ds_errors reflect the save immediately -- in particular so replacing a
    broken password clears its recovery flag without a service restart.

    Best-effort by design: the write is already committed, so a failure here must
    not be reported to the caller as a failed save.
    """
    try:
        reconcile_datasource_credentials()
    except psycopg.Error as e:
        logger.warning("Could not refresh datasource credential state: %s", e)


def encrypt_legacy_datasource_passwords() -> int:
    """One-time upgrade sweep: encrypt any plaintext password left over from
    before an encryption key was configured, or from before this feature existed.

    Safe on every boot -- already-encrypted rows are excluded by the NOT LIKE
    filter, so a repeat call is a no-op.

    Raises SecretConfigurationError when no usable key is configured. It used to
    guard on `if not config.ENCRYPTION_KEY: return 0`, which a *malformed* but
    non-empty key sailed straight through; encrypt_secret then returned the
    plaintext unchanged and this function still reported len(rows) migrated. It
    claimed to have encrypted rows it had just rewritten in cleartext. Callers
    that must not raise should go through reconcile_datasource_credentials().
    """
    problem = security.encryption_key_problem()
    if problem:
        raise security.SecretConfigurationError(
            f"Cannot encrypt legacy datasource passwords: {problem}"
        )
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, password FROM datasources "
            "WHERE password <> '' AND password NOT LIKE 'fernet$%'"
        ).fetchall()
        for row in rows:
            conn.execute(
                "UPDATE datasources SET password = %s WHERE id = %s",
                (security.encrypt_secret(row["password"]), row["id"]),
            )
        conn.commit()
    return len(rows)


# Cached result of the last reconciliation, served to the admin status route so
# it reports the audited state rather than re-decrypting on every page load.
_credential_security: dict[str, Any] = {
    "state": "unknown",
    "message": None,
    "migrated": 0,
    "plaintext_count": 0,
    "encrypted_count": 0,
    "recovery_required_count": 0,
}
_credential_states: dict[int, str] = {}


def datasource_credential_security() -> dict[str, Any]:
    """Global credential-encryption posture from the last reconciliation."""
    return dict(_credential_security)


def datasource_credential_state(datasource_id: int) -> str:
    """Per-row state: empty | plaintext | encrypted | recovery_required."""
    return _credential_states.get(datasource_id, "unknown")


def reconcile_datasource_credentials() -> dict[str, Any]:
    """Audit every stored datasource password, then migrate plaintext ones if —
    and only if — that is safe.

    Never raises for key problems: this runs from the startup path, which only
    catches psycopg.Error, and the operator needs the API up to *perform* the
    recovery. psycopg.Error is deliberately propagated so a database outage keeps
    its existing degraded-boot behaviour.

    The migrate-nothing-when-anything-is-unreadable rule is the important part.
    If old ciphertext cannot be read, the configured key is not the key that wrote
    it; encrypting the plaintext rows anyway would leave the table split across
    two keys, one of which nobody has. Better to stay uniformly recoverable.
    """
    global _credential_security

    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, password FROM datasources ORDER BY id"
        ).fetchall()

    problem = security.encryption_key_problem()
    states: dict[int, str] = {}
    plaintext_ids: list[int] = []
    encrypted = recovery = 0

    for row in rows:
        stored = row["password"] or ""
        if not stored:
            states[row["id"]] = "empty"
        elif not security.is_encrypted_secret(stored):
            states[row["id"]] = "plaintext"
            plaintext_ids.append(row["id"])
        else:
            try:
                security.decrypt_secret(stored)
            except security.SecretDecryptionError:
                states[row["id"]] = "recovery_required"
                recovery += 1
            else:
                states[row["id"]] = "encrypted"
                encrypted += 1

    migrated = 0
    if problem:
        state = "unconfigured"
        message = problem
    elif recovery:
        state = "recovery_required"
        message = (
            f"{recovery} datasource password(s) cannot be decrypted with the "
            "configured key. An administrator must re-enter them, or restore the "
            "original key. Plaintext migration is paused until then to avoid "
            "splitting the table across two keys."
        )
    else:
        migrated = _migrate_plaintext_passwords(plaintext_ids)
        for ds_id in plaintext_ids:
            states[ds_id] = "encrypted"
        encrypted += migrated
        state = "secure"
        message = None

    _credential_states.clear()
    _credential_states.update(states)
    for ds_id, ds_state in states.items():
        if ds_state == "recovery_required":
            _ds_errors[ds_id] = (
                f"{security.CREDENTIAL_RECOVERY_PREFIX} an administrator must "
                "re-enter this password, or restore the original encryption key."
            )
        elif _is_recovery_error(_ds_errors.get(ds_id)):
            # Recovered: drop the stale marker so the source reads as untried
            # again rather than staying red until something reconnects.
            _ds_errors.pop(ds_id, None)

    _credential_security = {
        "state": state,
        "message": message,
        "migrated": migrated,
        "plaintext_count": len(plaintext_ids) - migrated,
        "encrypted_count": encrypted,
        "recovery_required_count": recovery,
    }
    return dict(_credential_security)


def _is_recovery_error(error: str | None) -> bool:
    return bool(error) and error.startswith(security.CREDENTIAL_RECOVERY_PREFIX)


def _migrate_plaintext_passwords(datasource_ids: list[int]) -> int:
    """Encrypt the named plaintext rows in one transaction. Returns the count
    actually changed -- re-read inside the transaction so a row edited between
    the audit and here is not double-encrypted or miscounted."""
    if not datasource_ids:
        return 0
    changed = 0
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, password FROM datasources "
            "WHERE id = ANY(%s) AND password <> '' AND password NOT LIKE 'fernet$%%'",
            (datasource_ids,),
        ).fetchall()
        for row in rows:
            conn.execute(
                "UPDATE datasources SET password = %s WHERE id = %s",
                (security.encrypt_secret(row["password"]), row["id"]),
            )
            changed += 1
        conn.commit()
    return changed


def delete_datasource(datasource_id: int) -> bool:
    """Delete a connection. Returns True if a row was removed. Panels keep their
    (now-dangling) datasource_id; routing falls back to the app database."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM datasources WHERE id = %s", (datasource_id,))
        conn.commit()
        removed = cur.rowcount > 0
    if removed:
        drop_pool(datasource_id)
    return removed


# --- Per-user datasource selection ------------------------------------------
# Which plant datasources a user has chosen in the header. Every plant read
# fans out across this list, so it is the single input that decides where data
# comes from -- panel.datasource_id and per-symbol bindings no longer do.
def init_user_datasource_selection_table() -> None:
    """Create the user_datasource_selection table. Idempotent.

    `position` 0 is the *primary* source: what mimic symbols and the legacy
    single-value response fields resolve to. The order the operator picks is
    therefore load-bearing, not cosmetic.

    Both foreign keys cascade so a deleted user or datasource can never leave a
    dangling selection row. Without that, every read path would have to defend
    against ids that no longer exist.
    """
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS user_datasource_selection (
                user_id       INTEGER NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
                datasource_id INTEGER NOT NULL REFERENCES datasources(id) ON DELETE CASCADE,
                position      INTEGER NOT NULL DEFAULT 0,
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (user_id, datasource_id)
            )"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_uds_user
               ON user_datasource_selection (user_id, position)"""
        )
        conn.commit()


_SELECTION_COLS = (
    "d.id, d.name, d.host, d.port, d.dbname AS database, d.db_schema, s.position"
)


def get_user_selection(user_id: int) -> list[dict[str, Any]]:
    """This user's chosen datasources in position order.

    Joined to `datasources` so the caller only ever sees sources that still
    exist, and gets their current name rather than one cached at selection time.
    """
    with get_connection() as conn:
        rows = conn.execute(
            f"""SELECT {_SELECTION_COLS}
                FROM user_datasource_selection s
                JOIN datasources d ON d.id = s.datasource_id
                WHERE s.user_id = %s
                ORDER BY s.position, d.name""",
            (user_id,),
        ).fetchall()
    return rows


def set_user_selection(user_id: int, datasource_ids: list[int]) -> list[dict[str, Any]]:
    """Replace this user's selection atomically, preserving the given order.

    Unknown ids raise ValueError rather than being silently dropped: a selector
    that quietly discards half the operator's choice is worse than one that
    reports the stale id. Validation runs inside the same transaction as the
    replace, so a datasource deleted concurrently surfaces as a readable 400
    instead of a foreign-key 500.
    """
    if len(datasource_ids) > config.MAX_SELECTED_DATASOURCES:
        raise ValueError(
            f"at most {config.MAX_SELECTED_DATASOURCES} datasources may be selected"
        )
    # De-duplicate while keeping first-seen order; the PK would reject dupes and
    # position 0 is meaningful, so the *first* mention is the one that counts.
    ordered = list(dict.fromkeys(datasource_ids))
    with get_connection() as conn:
        if ordered:
            found = {
                r["id"] for r in conn.execute(
                    "SELECT id FROM datasources WHERE id = ANY(%s)", (ordered,)
                ).fetchall()
            }
            missing = [i for i in ordered if i not in found]
            if missing:
                conn.rollback()
                raise ValueError(
                    "unknown datasource id(s): " + ", ".join(str(i) for i in missing)
                )
        conn.execute(
            "DELETE FROM user_datasource_selection WHERE user_id = %s", (user_id,)
        )
        for position, ds_id in enumerate(ordered):
            conn.execute(
                """INSERT INTO user_datasource_selection (user_id, datasource_id, position)
                   VALUES (%s, %s, %s)""",
                (user_id, ds_id, position),
            )
        conn.commit()
    return get_user_selection(user_id)


def default_datasource() -> dict[str, Any] | None:
    """Lowest-id saved connection, used as the implicit selection.

    Deliberately not "all datasources": a user who has chosen nothing should not
    cause N remote handshakes, one of which may be a powered-off plant costing a
    full connect timeout on every request.
    """
    with get_connection() as conn:
        row = conn.execute(
            f"SELECT {_DS_PUBLIC_COLS} FROM datasources ORDER BY id LIMIT 1"
        ).fetchone()
    return row


def all_selected_datasource_ids() -> list[int]:
    """Union of every user's selection — the set the tag buffer needs to sample.

    One cheap localhost query per poll, rather than a static config list that
    drifts the moment an operator selects something new.
    """
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT DISTINCT datasource_id
               FROM user_datasource_selection ORDER BY datasource_id"""
        ).fetchall()
    return [r["datasource_id"] for r in rows]


def sampled_datasource_ids() -> list[int | None]:
    """Which sources the tag buffer should poll.

    The union of every explicit selection, falling back through the same ladder
    as auth.resolve_active_datasources — otherwise a fresh install where nobody
    has chosen anything yet buffers nothing, and every Live panel on the implicit
    default draws a blank chart until someone touches the header.
    """
    ids: list[int | None] = list(all_selected_datasource_ids())
    if ids:
        return ids
    fallback = default_datasource()
    return [fallback["id"]] if fallback else [None]


def datasource_names(datasource_ids: Sequence[int | None]) -> dict[int | None, str]:
    """{id: display name} for tagging fanned-out rows. `None` is the app DB."""
    concrete = [i for i in datasource_ids if i is not None]
    names: dict[int | None, str] = {None: "Local"}
    if concrete:
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT id, name FROM datasources WHERE id = ANY(%s)", (concrete,)
            ).fetchall()
        names.update({r["id"]: r["name"] for r in rows})
    # A selected-then-deleted source still needs a label rather than a KeyError.
    for i in concrete:
        names.setdefault(i, f"datasource {i}")
    return names


# --- Mimic layouts (/monitor) -----------------------------------------------
# One row per plant drawing. The whole layout document — nodes, edges, ports,
# geometry and each node's datasource binding — lives in `doc` as JSONB: none
# of it has query needs, and the frontend document is already flat and
# serialisable. Reads are open to any authenticated user (every operator sees
# the same commissioned plant); writes are admin-only, enforced in mimic.py.
# `mimic_layouts` is in _APP_SENSITIVE_TABLES so a layout can never be charted
# back through the generic table source.
def init_mimic_table() -> None:
    """Create the mimic_layouts table if it doesn't exist. Idempotent."""
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS mimic_layouts (
                id         SERIAL PRIMARY KEY,
                slug       TEXT NOT NULL UNIQUE,
                name       TEXT NOT NULL,
                doc        JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.commit()


def list_mimic_layouts() -> list[dict[str, Any]]:
    """Every saved drawing, without its document, ordered by name."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT slug, name, updated_at FROM mimic_layouts ORDER BY name"
        ).fetchall()
    return rows


def get_mimic_layout(slug: str) -> dict[str, Any] | None:
    """One drawing with its full document. None if it has never been saved —
    the client then falls back to its seeded layout."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT slug, name, doc, updated_at FROM mimic_layouts WHERE slug = %s",
            (slug,),
        ).fetchone()
    return row


def upsert_mimic_layout(
    slug: str,
    name: str,
    doc: dict[str, Any],
    *,
    base_updated_at=None,
    enforce_revision: bool = False,
) -> dict[str, Any] | None:
    """Create or replace a drawing, optionally guarded by its last revision.

    An omitted revision keeps the historical unconditional-upsert contract.
    Explicit ``None`` is insert-only; a timestamp updates only the exact row
    the editor started from. ``None`` is returned for either conflict shape.
    """
    with get_connection() as conn:
        if not enforce_revision:
            row = conn.execute(
                """INSERT INTO mimic_layouts (slug, name, doc)
                VALUES (%s, %s, %s)
                ON CONFLICT (slug) DO UPDATE
                    SET name = EXCLUDED.name,
                        doc = EXCLUDED.doc,
                        updated_at = now()
                RETURNING slug, name, doc, updated_at""",
                (slug, name, Json(doc)),
            ).fetchone()
        elif base_updated_at is None:
            row = conn.execute(
                """INSERT INTO mimic_layouts (slug, name, doc)
                VALUES (%s, %s, %s)
                ON CONFLICT (slug) DO NOTHING
                RETURNING slug, name, doc, updated_at""",
                (slug, name, Json(doc)),
            ).fetchone()
        else:
            row = conn.execute(
                """UPDATE mimic_layouts
                SET name = %s, doc = %s, updated_at = now()
                WHERE slug = %s AND updated_at = %s
                RETURNING slug, name, doc, updated_at""",
                (name, Json(doc), slug, base_updated_at),
            ).fetchone()
        conn.commit()
    return row


def delete_mimic_layout(slug: str) -> bool:
    """Remove a drawing. True if a row went, False if the slug was already
    gone — the caller turns that into the 404, so a double-delete from two
    admin tabs reports honestly instead of claiming success twice."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM mimic_layouts WHERE slug = %s", (slug,))
        conn.commit()
    return cur.rowcount > 0


# --- mimic assets & custom symbol library ----------------------------------
# Two tables behind /monitor's user-authored symbols. mimic_assets holds the
# uploaded image bytes; mimic_symbols is the library of symbol *definitions*
# that reference them.
#
# The split is deliberate. A definition carries the ports, size and dynamics an
# admin configured once, so dropping the same rack onto ten drawings reuses one
# entry instead of re-authoring it ten times — which is the difference between a
# symbol library and a per-node image field.
#
# Bytes live in Postgres rather than on disk: the app already treats the database
# as its only durable store, and an asset that vanished on redeploy would leave
# every drawing referencing it broken. Both tables are in _APP_SENSITIVE_TABLES
# so neither can be charted back through the generic table source.
def init_mimic_assets_table() -> None:
    """Create the mimic_assets table if it doesn't exist. Idempotent."""
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS mimic_assets (
                id          SERIAL PRIMARY KEY,
                name        TEXT NOT NULL,
                mime        TEXT NOT NULL,
                bytes       BYTEA NOT NULL,
                size_bytes  INTEGER NOT NULL,
                -- Content hash, not a name: two admins uploading the same icon
                -- should share one row rather than racking up near-duplicates
                -- nobody can tell apart in the picker.
                sha256      TEXT NOT NULL UNIQUE,
                uploaded_by INTEGER,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.commit()


def init_mimic_symbols_table() -> None:
    """Create the mimic_symbols table if it doesn't exist. Idempotent."""
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS mimic_symbols (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL,
                -- RESTRICT, not CASCADE: deleting an image out from under a
                -- symbol would leave every drawing using it drawing a
                -- placeholder. The API refuses the delete and says which
                -- symbols are in the way.
                asset_id   INTEGER NOT NULL REFERENCES mimic_assets(id) ON DELETE RESTRICT,
                w          INTEGER NOT NULL,
                h          INTEGER NOT NULL,
                ports      JSONB NOT NULL DEFAULT '{}'::jsonb,
                dynamics   JSONB NOT NULL DEFAULT '[]'::jsonb,
                binding    TEXT NOT NULL DEFAULT 'analog',
                bubble     JSONB,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.commit()


def list_mimic_assets() -> list[dict[str, Any]]:
    """Every uploaded asset, without its bytes.

    used_by counts the library symbols referencing it, so the picker can show at
    a glance which uploads are actually in play and which are dead weight.
    """
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT a.id, a.name, a.mime, a.size_bytes, a.created_at,
                      count(s.id)::int AS used_by
            FROM mimic_assets a
            LEFT JOIN mimic_symbols s ON s.asset_id = a.id
            GROUP BY a.id
            ORDER BY a.name"""
        ).fetchall()
    return rows


def get_mimic_asset(asset_id: int) -> dict[str, Any] | None:
    """One asset *with* its bytes — the read behind the image endpoint."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, name, mime, bytes, size_bytes FROM mimic_assets WHERE id = %s",
            (asset_id,),
        ).fetchone()
    return row


def find_mimic_asset_by_hash(sha256: str) -> dict[str, Any] | None:
    """An identical upload that is already stored, if there is one."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, name, mime, size_bytes, created_at FROM mimic_assets WHERE sha256 = %s",
            (sha256,),
        ).fetchone()
    return row


def insert_mimic_asset(
    name: str, mime: str, data: bytes, sha256: str, uploaded_by: int | None
) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute(
            """INSERT INTO mimic_assets (name, mime, bytes, size_bytes, sha256, uploaded_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, name, mime, size_bytes, created_at""",
            (name, mime, data, len(data), sha256, uploaded_by),
        ).fetchone()
        conn.commit()
    return row


def mimic_asset_users(asset_id: int) -> list[str]:
    """Names of the library symbols standing in the way of a delete."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT name FROM mimic_symbols WHERE asset_id = %s ORDER BY name",
            (asset_id,),
        ).fetchall()
    return [r["name"] for r in rows]


def delete_mimic_asset(asset_id: int) -> bool:
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM mimic_assets WHERE id = %s", (asset_id,))
        conn.commit()
    return cur.rowcount > 0


_SYMBOL_COLS = "id, name, asset_id, w, h, ports, dynamics, binding, bubble, updated_at"


def list_mimic_symbols() -> list[dict[str, Any]]:
    """The whole custom library.

    Small by nature (one row per authored symbol) and needed in full before a
    drawing can be rendered, so there is no paging: a node referencing a symbol
    missing from this list draws as a placeholder.
    """
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT {_SYMBOL_COLS} FROM mimic_symbols ORDER BY name"
        ).fetchall()
    return rows


def get_mimic_symbol(symbol_id: int) -> dict[str, Any] | None:
    with get_connection() as conn:
        row = conn.execute(
            f"SELECT {_SYMBOL_COLS} FROM mimic_symbols WHERE id = %s", (symbol_id,)
        ).fetchone()
    return row


def insert_mimic_symbol(fields: dict[str, Any]) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute(
            f"""INSERT INTO mimic_symbols
                (name, asset_id, w, h, ports, dynamics, binding, bubble)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_SYMBOL_COLS}""",
            (
                fields["name"], fields["asset_id"], fields["w"], fields["h"],
                Json(fields["ports"]), Json(fields["dynamics"]),
                fields["binding"],
                Json(fields["bubble"]) if fields.get("bubble") else None,
            ),
        ).fetchone()
        conn.commit()
    return row


def update_mimic_symbol(symbol_id: int, fields: dict[str, Any]) -> dict[str, Any] | None:
    """Replace a definition whole.

    Every drawing using it picks the change up on its next load — that is the
    point of a library, and why there is no PATCH.
    """
    with get_connection() as conn:
        row = conn.execute(
            f"""UPDATE mimic_symbols SET
                name = %s, asset_id = %s, w = %s, h = %s, ports = %s,
                dynamics = %s, binding = %s, bubble = %s, updated_at = now()
            WHERE id = %s
            RETURNING {_SYMBOL_COLS}""",
            (
                fields["name"], fields["asset_id"], fields["w"], fields["h"],
                Json(fields["ports"]), Json(fields["dynamics"]),
                fields["binding"],
                Json(fields["bubble"]) if fields.get("bubble") else None,
                symbol_id,
            ),
        ).fetchone()
        conn.commit()
    return row


def delete_mimic_symbol(symbol_id: int) -> bool:
    """Remove a library entry.

    Nodes still pointing at it draw as placeholders rather than taking their
    drawing down, so this needs no reference check — unlike an asset, whose
    removal would take the symbol's picture with it.
    """
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM mimic_symbols WHERE id = %s", (symbol_id,))
        conn.commit()
    return cur.rowcount > 0


# --- Cameras (/monitor vision-inspection panel) -----------------------------
# Camera identity and defect counters are *plant* data, read through the
# datasource the header has selected. They used to be app configuration, and
# that was the mistake this section exists to correct: the vision system owns
# both tables and writes them into its own per-line schema (`vision_line9`,
# `vision_line10`, …), so a copy of them in the app database was a second place
# for the same facts to live and drift.
#
# Nothing here creates a table, and that is the point. A second production line
# is a schema the vision system has already provisioned plus a `doc.cameraDefect`
# binding pointing at it — not a migration, and not a code change.
#
# Every identifier below arrives from a saved binding and is put through
# `_safe_identifiers` against the live `information_schema` on the connection it
# is about to be used on, exactly as `production_log_hourly` does. A binding is
# admin input that was validated when it was saved, which says nothing about
# whether the column still exists today.


def _registry_columns(registry: dict[str, Any]) -> tuple[str, str | None, str | None, list[str]]:
    """Unpack the optional registry sub-binding into its four column roles."""
    return (
        registry["code_col"],
        registry.get("name_col"),
        registry.get("station_col"),
        list(registry.get("label_cols") or []),
    )


def camera_registry(
    binding: dict[str, Any], datasource_id: int | None = None
) -> list[dict[str, Any]]:
    """Every camera this binding can reach, by code.

    Two paths, and the fallback is the interesting one. With a `registry`
    sub-binding the codes come from the vision system's own camera table, along
    with whatever names and per-slot labels it carries. Without one they are
    recovered as `DISTINCT camera_col` from the defect table itself.

    That fallback is what makes a new line usable the moment its defect table is
    bound: naming the cameras is a separate, later job, and requiring it first
    would mean an operator sees nothing at all until an admin has filled in a
    second form. An unnamed camera renders under its own code, which is what is
    painted on the physical station anyway.
    """
    table = binding["table"]
    camera_col = binding["camera_col"]
    registry = binding.get("registry")

    with _table_source_conn(datasource_id) as (conn, schema):
        if not registry:
            _safe_identifiers(
                conn, schema, table, camera_col, datasource_id=datasource_id
            )
            rows = conn.execute(
                sql.SQL(
                    "SELECT DISTINCT {col}::text AS code FROM {tbl} "
                    "WHERE {col} IS NOT NULL ORDER BY 1"
                ).format(
                    col=sql.Identifier(camera_col),
                    tbl=sql.Identifier(schema, table),
                )
            ).fetchall()
            return [
                {"code": r["code"], "name": None, "station": None, "labels": []}
                for r in rows
            ]

        reg_table = registry["table"]
        code_col, name_col, station_col, label_cols = _registry_columns(registry)
        _safe_identifiers(
            conn, schema, reg_table, code_col, name_col, station_col, *label_cols,
            datasource_id=datasource_id,
        )
        fields = [sql.SQL("{}::text AS code").format(sql.Identifier(code_col))]
        fields.append(
            sql.SQL("{}::text AS name").format(sql.Identifier(name_col))
            if name_col else sql.SQL("NULL::text AS name")
        )
        fields.append(
            sql.SQL("{}::text AS station").format(sql.Identifier(station_col))
            if station_col else sql.SQL("NULL::text AS station")
        )
        # Labels are aliased positionally rather than by their column names so
        # a registry using `defect_1_label` and one using `scratch_name` come
        # back in the same shape, and neither can collide with `code`/`name`.
        for i, col in enumerate(label_cols):
            fields.append(
                sql.SQL("{}::text AS {}").format(
                    sql.Identifier(col), sql.Identifier(f"label_{i}")
                )
            )
        rows = conn.execute(
            sql.SQL("SELECT {fields} FROM {tbl} WHERE {code} IS NOT NULL ORDER BY 1").format(
                fields=sql.SQL(", ").join(fields),
                tbl=sql.Identifier(schema, reg_table),
                code=sql.Identifier(code_col),
            )
        ).fetchall()

    return [
        {
            "code": r["code"],
            "name": r["name"],
            "station": r["station"],
            "labels": [r[f"label_{i}"] for i in range(len(label_cols))],
        }
        for r in rows
    ]


def camera_defect_latest(
    binding: dict[str, Any], code: str, datasource_id: int | None = None
) -> dict[str, Any] | None:
    """The newest batch of defect counters for one camera code.

    None means this camera has no rows at all — a different state from a batch
    that counted zero, and the rail says so differently. Preserved from the
    original implementation because it is the distinction operators asked for.

    Matched case-insensitively: the code is typed into a mimic symbol by one
    person and into the vision system's configuration by another.

    Ordered by the batch column when the binding names one, falling back to the
    timestamp. `ORDER BY … DESC LIMIT 1` rather than `WHERE batch = (SELECT
    max(…))` — the subquery form silently returns nothing for a camera whose
    rows all predate another camera's latest batch, which is the bug the
    original carried a comment about.
    """
    table = binding["table"]
    camera_col = binding["camera_col"]
    batch_col = binding.get("batch_col")
    ts_col = binding.get("ts_col")
    defect_cols = list(binding["defect_cols"])
    order_col = batch_col or ts_col

    with _table_source_conn(datasource_id) as (conn, schema):
        _safe_identifiers(
            conn, schema, table, camera_col, batch_col, ts_col, *defect_cols,
            datasource_id=datasource_id,
        )
        fields = [
            sql.SQL("{}::bigint AS batch_id").format(sql.Identifier(batch_col))
            if batch_col else sql.SQL("NULL::bigint AS batch_id"),
            sql.SQL("{} AS updated_at").format(sql.Identifier(ts_col))
            if ts_col else sql.SQL("NULL::timestamp AS updated_at"),
        ]
        for i, col in enumerate(defect_cols):
            fields.append(
                sql.SQL("{}::bigint AS {}").format(
                    sql.Identifier(col), sql.Identifier(f"defect_{i}")
                )
            )
        row = conn.execute(
            sql.SQL(
                "SELECT {fields} FROM {tbl} WHERE lower({cam}::text) = lower(%s) "
                "ORDER BY {order} DESC NULLS LAST LIMIT 1"
            ).format(
                fields=sql.SQL(", ").join(fields),
                tbl=sql.Identifier(schema, table),
                cam=sql.Identifier(camera_col),
                order=sql.Identifier(order_col),
            ),
            (code,),
        ).fetchone()

    if row is None:
        return None
    return {
        "batch_id": row["batch_id"],
        "updated_at": row["updated_at"],
        "counts": [row[f"defect_{i}"] or 0 for i in range(len(defect_cols))],
    }


# ============================================================================
# Reports — OEE / production status reporting
# ============================================================================
# Two app-owned tables (report_templates, report_settings) plus read-only
# queries against the SCADA-owned public.event_logs / public.alarm_logs.
# All timestamps here are naive/server-local: the plant, the database and the
# API share a clock, so no timezone conversion happens (documented constraint —
# a remote viewer sees plant time, not their own).

_DEFAULT_STATE_RULES = {
    "PLANNED_DOWN": ["changeover", "maintenance", "cleaning", "setup", "break"],
    "IDLE": ["idle", "standby", "wait"],
    "STOP": ["stop", "fault", "trip", "fail", "emergency", "alarm"],
    "RUN": ["start", "running", "run", "auto"],
}

#: The seeded "Production Status Report". Only inserted when the table is empty,
#: so an admin's edits are never clobbered by a service restart.
_DEFAULT_TEMPLATE_BLOCKS = [
    {"id": "b1", "type": "kpi", "title": "Overview", "width": "full",
     "options": {"metrics": ["oee", "availability", "runtime", "downtime", "stops", "mttr"],
                 "targets": {"oee": 85, "availability": 90}}},
    {"id": "b2", "type": "timeline", "title": "Machine State Timeline", "width": "full",
     "options": {"groupBy": "machine", "showUnknown": True}},
    {"id": "b3", "type": "pareto", "title": "Downtime Pareto", "width": "half",
     "options": {"topN": 10, "rankBy": "duration"}},
    {"id": "b4", "type": "alarms", "title": "Alarm Summary", "width": "half",
     "options": {"topN": 10}},
    {"id": "b5", "type": "summary_table", "title": "Machine Summary", "width": "full",
     "options": {"columns": ["machine", "runtime", "downtime", "availability",
                             "stops", "mtbf", "mttr", "alarms"]}},
    {"id": "b6", "type": "raw_log", "title": "Event Log", "width": "full",
     "options": {"pageSize": 50}},
]


def init_report_tables() -> None:
    """Create the report tables and the event_logs index. Idempotent.

    The CREATE INDEX targets a table the SCADA system owns, not the app. That is
    deliberate and has precedent (_probe_alarms.py does the same on alarm_logs):
    without it every report does a full scan, and the index is additive so the
    external writer is unaffected.
    """
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS report_templates (
                id              SERIAL PRIMARY KEY,
                name            TEXT NOT NULL,
                description     TEXT NOT NULL DEFAULT '',
                blocks          JSONB NOT NULL DEFAULT '[]'::jsonb,
                default_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
                is_default      BOOLEAN NOT NULL DEFAULT FALSE,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS report_settings (
                id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                state_rules        JSONB   NOT NULL DEFAULT '{}'::jsonb,
                alarm_lead_seconds INTEGER NOT NULL DEFAULT 60,
                updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.execute(
            """INSERT INTO report_settings (id, state_rules)
               VALUES (1, %s) ON CONFLICT (id) DO NOTHING""",
            (Json(_DEFAULT_STATE_RULES),),
        )
        # Seed the default template only into an empty table.
        empty = conn.execute("SELECT COUNT(*) AS n FROM report_templates").fetchone()
        if not empty["n"]:
            conn.execute(
                """INSERT INTO report_templates
                       (name, description, blocks, default_filters, is_default)
                   VALUES (%s, %s, %s, %s, TRUE)""",
                ("Production Status Report",
                 "Machine availability, downtime causes and OEE across a production line.",
                 Json(_DEFAULT_TEMPLATE_BLOCKS),
                 Json({"preset": "last7d"})),
            )
        conn.commit()

    # Separate connection: on a fresh install event_logs may not exist yet, or the
    # app role may lack DDL rights on a SCADA-owned table. Neither should stop the
    # API booting — reports just run unindexed until the table is created.
    try:
        with get_connection() as conn:
            conn.execute(
                sql.SQL(
                    "CREATE INDEX IF NOT EXISTS event_logs_loc_tag_time_idx "
                    "ON {} (location, tag_name, at_date_time DESC)"
                ).format(sql.Identifier(config.APP_DB_SCHEMA, "event_logs"))
            )
            conn.commit()
    except psycopg.Error:
        pass


# --- Template CRUD ----------------------------------------------------------
_TEMPLATE_COLS = ("id, name, description, blocks, default_filters, is_default, "
                  "created_at, updated_at")


def list_report_templates() -> list[dict[str, Any]]:
    with get_connection() as conn:
        return conn.execute(
            f"SELECT {_TEMPLATE_COLS} FROM report_templates "
            "ORDER BY is_default DESC, name"
        ).fetchall()


def get_report_template(template_id: int) -> dict[str, Any] | None:
    with get_connection() as conn:
        return conn.execute(
            f"SELECT {_TEMPLATE_COLS} FROM report_templates WHERE id = %s",
            (template_id,),
        ).fetchone()


def get_default_report_template() -> dict[str, Any] | None:
    """The template /reports lands on. Falls back to the first by name so the
    page still works if someone clears every is_default flag."""
    with get_connection() as conn:
        return conn.execute(
            f"SELECT {_TEMPLATE_COLS} FROM report_templates "
            "ORDER BY is_default DESC, name LIMIT 1"
        ).fetchone()


def create_report_template(name, description, blocks, default_filters, is_default):
    with get_connection() as conn:
        if is_default:
            conn.execute("UPDATE report_templates SET is_default = FALSE")
        row = conn.execute(
            f"""INSERT INTO report_templates
                    (name, description, blocks, default_filters, is_default)
                VALUES (%s, %s, %s, %s, %s) RETURNING {_TEMPLATE_COLS}""",
            (name, description, Json(blocks), Json(default_filters), is_default),
        ).fetchone()
        conn.commit()
    return row


def update_report_template(template_id, name, description, blocks,
                           default_filters, is_default):
    with get_connection() as conn:
        if is_default:
            # Exactly one default — clear the others first so /reports never has
            # to arbitrate between two.
            conn.execute(
                "UPDATE report_templates SET is_default = FALSE WHERE id <> %s",
                (template_id,),
            )
        row = conn.execute(
            f"""UPDATE report_templates
                   SET name = %s, description = %s, blocks = %s,
                       default_filters = %s, is_default = %s, updated_at = now()
                 WHERE id = %s RETURNING {_TEMPLATE_COLS}""",
            (name, description, Json(blocks), Json(default_filters),
             is_default, template_id),
        ).fetchone()
        conn.commit()
    return row


def delete_report_template(template_id: int) -> bool:
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM report_templates WHERE id = %s", (template_id,))
        conn.commit()
    return cur.rowcount > 0


# --- Settings ---------------------------------------------------------------
def get_report_settings() -> dict[str, Any]:
    """Plant-wide event vocabulary. Falls back to the built-in defaults when the
    stored rules are empty, so a wiped row degrades to sane behaviour rather
    than classifying every event as UNKNOWN."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT state_rules, alarm_lead_seconds, updated_at "
            "FROM report_settings WHERE id = 1"
        ).fetchone()
    if not row:
        return {"state_rules": _DEFAULT_STATE_RULES, "alarm_lead_seconds": 60,
                "updated_at": None}
    if not row.get("state_rules"):
        row["state_rules"] = _DEFAULT_STATE_RULES
    return row


def update_report_settings(state_rules: dict, alarm_lead_seconds: int) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute(
            """INSERT INTO report_settings (id, state_rules, alarm_lead_seconds)
               VALUES (1, %s, %s)
               ON CONFLICT (id) DO UPDATE
                 SET state_rules = EXCLUDED.state_rules,
                     alarm_lead_seconds = EXCLUDED.alarm_lead_seconds,
                     updated_at = now()
               RETURNING state_rules, alarm_lead_seconds, updated_at""",
            (Json(state_rules), alarm_lead_seconds),
        ).fetchone()
        conn.commit()
    return row


# --- Machine catalog --------------------------------------------------------
# variables_tag is the live tag registry (tiny, one row per tag) and event_logs
# covers decommissioned machines that still have history. The union is cached
# because the event_logs DISTINCT is the expensive half and the answer changes
# only when the plant is re-tagged.
# Keyed by datasource: two plants have entirely unrelated machine lists, and a
# single cache would serve whichever one asked first to everybody.
_catalog_cache: dict[int | None, tuple[float, list[dict[str, Any]]]] = {}
_CATALOG_TTL_SECONDS = 300


def report_catalog(force: bool = False,
                   datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Distinct (location, tag_name) pairs — feeds the Line/Machine pickers."""
    now = datetime.now().timestamp()
    cached = _catalog_cache.get(datasource_id)
    if not force and cached and now - cached[0] < _CATALOG_TTL_SECONDS:
        return cached[1]

    with _table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT location, tag_name FROM (
                       SELECT location, tag_name FROM {tags}
                       UNION
                       SELECT location, tag_name FROM {events}
                   ) c
                   WHERE tag_name IS NOT NULL
                   ORDER BY location NULLS LAST, tag_name"""
            ).format(
                tags=sql.Identifier(schema, "variables_tag"),
                events=sql.Identifier(schema, "event_logs"),
            )
        ).fetchall()
    _catalog_cache[datasource_id] = (now, rows)
    return rows


# --- Log queries ------------------------------------------------------------
def _machine_filter(locations, tag_names):
    """Build the shared WHERE fragment. Empty lists mean 'no filter' rather than
    'match nothing', which is what the UI's empty multi-selects imply."""
    clauses, params = [], []
    if locations:
        clauses.append("location = ANY(%s)")
        params.append(list(locations))
    if tag_names:
        clauses.append("tag_name = ANY(%s)")
        params.append(list(tag_names))
    return ("".join(f" AND {c}" for c in clauses), params)


def fetch_state_events(start: datetime, end: datetime, locations=None,
                       tag_names=None, datasource_id: int | None = None,
                       ) -> list[dict[str, Any]]:
    """Window events plus one carry-in row per machine, in a single round trip.

    The carry-in half (DISTINCT ON … at_date_time < start) is what lets a machine
    that ran all week with no events inside a one-day window still report
    runtime. Both halves ride the (location, tag_name, at_date_time) index.
    """
    where, params = _machine_filter(locations, tag_names)
    with _table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """(SELECT DISTINCT ON (location, tag_name)
                           location, tag_name, event, at_date_time
                      FROM {events}
                     WHERE at_date_time < %s""" + where + """
                     ORDER BY location, tag_name, at_date_time DESC)
                   UNION ALL
                   (SELECT location, tag_name, event, at_date_time
                      FROM {events}
                     WHERE at_date_time >= %s AND at_date_time < %s""" + where + """)
                   ORDER BY 1, 2, 4"""
            ).format(events=sql.Identifier(schema, "event_logs")),
            (start, *params, start, end, *params),
        ).fetchall()


def fetch_alarms_for_window(start: datetime, end: datetime, locations=None,
                            tag_names=None, datasource_id: int | None = None,
                            ) -> list[dict[str, Any]]:
    """Alarms overlapping the window, used to name downtime causes.

    `start` is expected to be already widened by the lead window so an alarm that
    fired just before the machine halted still matches.
    """
    where, params = _machine_filter(locations, tag_names)
    with _table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """SELECT id, location, tag_name, alarm_events AS text,
                          severity, created_at AS at
                     FROM {alarms}
                    WHERE created_at >= %s AND created_at < %s""" + where + """
                    ORDER BY created_at"""
            ).format(alarms=sql.Identifier(schema, "alarm_logs")),
            (start, end, *params),
        ).fetchall()


def count_event_log(start, end, locations=None, tag_names=None, search=None,
                    datasource_id: int | None = None) -> int:
    where, params = _machine_filter(locations, tag_names)
    if search:
        where += " AND event ILIKE %s"
        params.append(f"%{search}%")
    with _table_source_conn(datasource_id) as (conn, schema):
        row = conn.execute(
            sql.SQL(
                """SELECT COUNT(*) AS n FROM {events}
                    WHERE at_date_time >= %s AND at_date_time < %s""" + where
            ).format(events=sql.Identifier(schema, "event_logs")),
            (start, end, *params),
        ).fetchone()
    return row["n"]


def fetch_event_log_page(start, end, locations=None, tag_names=None, search=None,
                         limit: int = 50, offset: int = 0,
                         datasource_id: int | None = None) -> list[dict[str, Any]]:
    """One page of the raw log, newest first — backs the on-screen table and,
    with a large limit, the spreadsheet export."""
    where, params = _machine_filter(locations, tag_names)
    if search:
        where += " AND event ILIKE %s"
        params.append(f"%{search}%")
    with _table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """SELECT location, tag_name, event, at_date_time
                     FROM {events}
                    WHERE at_date_time >= %s AND at_date_time < %s""" + where + """
                    ORDER BY at_date_time DESC
                    LIMIT %s OFFSET %s"""
            ).format(events=sql.Identifier(schema, "event_logs")),
            (start, end, *params, limit, offset),
        ).fetchall()


# --- License activation audit log --------------------------------------------
# Log only, not the source of truth — the .lic file on disk (see licensing.py)
# is authoritative. This table exists purely so support can answer "who
# activated what, when" without SSH-ing in to read a log file. Must run after
# init_users_table (FK to actor_user_id).
def init_license_events_table() -> None:
    """Create the license_events table if it doesn't exist. Idempotent."""
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS license_events (
                id            SERIAL PRIMARY KEY,
                event_type    TEXT NOT NULL,
                state         TEXT NOT NULL,
                license_id    TEXT,
                tier          TEXT,
                expires_at    TIMESTAMPTZ,
                actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                detail        TEXT,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.commit()


def insert_license_event(
    event_type: str,
    state: str,
    license_id: str | None = None,
    tier: str | None = None,
    expires_at: datetime | None = None,
    actor_user_id: int | None = None,
    detail: str | None = None,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO license_events
                   (event_type, state, license_id, tier, expires_at, actor_user_id, detail)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (event_type, state, license_id, tier, expires_at, actor_user_id, detail),
        )
        conn.commit()
