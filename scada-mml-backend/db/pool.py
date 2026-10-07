"""Connection pools, per-datasource health and fast-fail, and the app-DB handle."""

import atexit
from contextlib import contextmanager
from datetime import datetime, timezone
import logging
import threading
from time import monotonic
from typing import Any

from psycopg import sql
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

import config
import security

from . import datasources as _datasources

__all__ = [
    "SCHEMA_READY",
    "_DS_RETRY_AFTER_S",
    "_build_pool",
    "_claim_probe",
    "_db_state",
    "_ds_down_lock",
    "_ds_down_until",
    "_ds_errors",
    "_ds_probing",
    "_first_line",
    "_mark_reachable",
    "_outage_logged",
    "_pool_for",
    "_pool_lock",
    "_pool_schemas",
    "_pools",
    "_probe_done",
    "_record",
    "close_all_pools",
    "datasource_health",
    "datasource_reachable",
    "db_state",
    "drop_pool",
    "ensure_app_schema",
    "get_connection",
    "logger",
    "probe",
]

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
            ds = _datasources.get_datasource_secret(datasource_id)
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
    rows = _datasources.list_datasources()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "in_use": r["id"] in in_use,
            "last_error": _ds_errors.get(r["id"]),
            "ok": _ds_errors.get(r["id"]) is None,
            "credential_state": _datasources.datasource_credential_state(r["id"]),
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
