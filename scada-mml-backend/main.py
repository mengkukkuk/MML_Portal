import asyncio
import logging
import os

import psycopg
from psycopg_pool import PoolTimeout
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import alarms
import auth
import cameras
import config
import dashboards
import datasources
import db
import events
import licensing
import mimic
import panels
import readings
import reports
import schema
import system
import tags
import users

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("mml-api")

app = FastAPI(title="MML-Portal-API")

# Allowed origins — must be explicit when allow_credentials=True (cannot use "*")
_ORIGINS = [o.strip() for o in os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173"  # Vite dev server
).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ORIGINS,
    allow_credentials=True,   # required for cookies
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(readings.router)
app.include_router(tags.router)
app.include_router(schema.router)
app.include_router(panels.router)
app.include_router(dashboards.router)
app.include_router(datasources.router)
app.include_router(mimic.router)
app.include_router(events.router)
app.include_router(alarms.router)
app.include_router(reports.router)
app.include_router(cameras.router)
app.include_router(system.router)
app.include_router(licensing.router)


def _create_tables() -> bool:
    """Create every app/config table so users, the Live grid, saved connections
    and the /monitor drawing can persist on the local database.

    Order is load-bearing in four places: `ensure_app_schema` must run before
    every `init_*_table()` call, since those all use unqualified table names
    that resolve against the configured schema via `search_path` -- a schema
    that doesn't exist yet fails the first CREATE TABLE, not the connection.
    dashboards must run after panels (it alters dashboard_panels), mimic_symbols
    must run after mimic_assets (it carries a foreign key to it), and
    user_datasource_selection must run after both users and datasources (it has
    a cascading FK to each). mimic_layouts stands alone.

    `users` is created here as well as by seed_users.py: a table the app cannot
    log in without has no business being create-on-demand from a seeding script,
    and user_datasource_selection's FK would fail on a fresh install otherwise.

    Returns True on success. A database that cannot be reached must never abort
    startup: an exception raised from a startup handler aborts Starlette's
    lifespan, so uvicorn exits before binding a single route -- taking /health
    with it and leaving NSSM to restart-loop for the length of the outage. The
    whole body is guarded as one unit rather than per call: if the first DDL
    cannot reach the database, every later call will fail the same way, and
    each paying its own connect timeout would add half a minute to every boot.
    """
    global _schema_ready
    try:
        db.ensure_app_schema()
        db.init_users_table()
        db.init_license_events_table()
        db.init_panels_table()
        db.init_dashboards_table()
        db.init_datasources_table()
        _report_credential_security(db.reconcile_datasource_credentials())
        db.init_user_datasource_selection_table()
        db.init_mimic_table()
        db.init_mimic_assets_table()
        db.init_mimic_symbols_table()
        db.init_report_tables()
        db.init_cameras_table()
        db.init_camera_defect_table()
        db.init_camera_snapshots_table()
    except psycopg.Error as e:
        # psycopg.Error, not just OperationalError: an unreachable host is only
        # one way this fails. DDL against a *live* server can raise
        # InsufficientPrivilege (a ProgrammingError) when the app role does not
        # own a SCADA-managed table -- and a service that refuses to start
        # because of a permissions detail is the same outage in a different
        # costume. Whatever went wrong, log it and serve; the watch loop retries.
        _schema_ready = False
        db.SCHEMA_READY = False
        logger.warning(
            "Schema init deferred - database unavailable (%s). The API is serving "
            "in degraded mode and will retry.",
            str(e).strip().splitlines()[0] if str(e).strip() else e,
        )
        return False
    _schema_ready = True
    db.SCHEMA_READY = True
    return True


def _report_credential_security(result: dict) -> None:
    """Log the datasource-password audit at a level matching how bad it is.

    Deliberately never aborts the lifespan, unlike _check_secure_config's
    JWT_SECRET guard. An install whose key is missing needs the API *up* so an
    admin can sign in and re-enter the affected passwords, and an existing
    deployment still on plaintext must survive the upgrade that introduces this.
    """
    state = result["state"]
    if state == "secure":
        if result["migrated"]:
            logger.info(
                "Encrypted %d legacy plaintext datasource password(s)", result["migrated"]
            )
        return
    if state == "unconfigured":
        logger.warning(
            "Datasource password encryption is UNAVAILABLE: %s Saving a datasource "
            "password will be refused until a key is provisioned; %d existing "
            "password(s) remain in plaintext.",
            result["message"], result["plaintext_count"],
        )
        return
    if state == "recovery_required":
        logger.error(
            "%d datasource password(s) require recovery: %s",
            result["recovery_required_count"], result["message"],
        )

_schema_ready = False

@app.on_event("startup")
def _check_secure_config() -> None:
    """The one startup handler here allowed to abort the lifespan — every
    neighbor degrades instead (see _create_tables/_load_license) because a
    down database or missing license is transient and worth staying up
    through. A placeholder JWT_SECRET is a static misconfiguration that makes
    every token forgeable and will not fix itself on retry."""
    if config.jwt_secret_is_insecure():
        raise RuntimeError(
            "JWT_SECRET is not set to a real secret. Generate one with: "
            'python -c "import secrets; print(secrets.token_hex(32))" '
            "and set it in .env before starting the service."
        )


@app.on_event("startup")
def _ensure_tables() -> None:
    _create_tables()


@app.on_event("startup")
def _load_license() -> None:
    """Must never raise — same contract as _create_tables above: an exception
    from a startup handler aborts Starlette's lifespan and uvicorn never binds,
    taking /health down with it. A missing or corrupt license degrades to
    state='missing', logged once, not a crash.
    """
    try:
        status = licensing.refresh()
        logger.info(
            "License state: %s (tier=%s)",
            status.state,
            (status.payload or {}).get("tier"),
        )
    except Exception:
        logger.exception("License check failed at startup - serving in unlicensed mode")


_tag_buffer_task: asyncio.Task | None = None
_db_watch_task: asyncio.Task | None = None


#: A source that fails this many polls in a row is parked. A plant database with
#: no variables_tag raises UndefinedTable every tick forever -- 720 log lines an
#: hour, per source, for a condition that will not fix itself.
_TAG_SKIP_MIN_S = 300
_TAG_SKIP_MAX_S = 3600

#: datasource_id -> (monotonic time to retry, current backoff seconds)
_tag_skip: dict[int | None, tuple[float, float]] = {}
_tag_fails: dict[int | None, int] = {}
#: Sources whose failures were connection-level. Only these parks can be refuted
#: by later evidence that the host answers -- see _unpark.
_tag_park_transient: set[int | None] = set()


def _unpark(datasource_id: int | None) -> None:
    """Release a park early because ordinary traffic proved the source is up.

    The backoff *level* is deliberately kept while the deadline is cleared, so a
    source that fails again resumes doubling from where it left off instead of
    restarting at the floor.
    """
    _, delay = _tag_skip.pop(datasource_id, (0.0, 0.0))
    _tag_fails.pop(datasource_id, None)
    _tag_park_transient.discard(datasource_id)
    if delay:
        _tag_skip[datasource_id] = (0.0, delay)
    logger.info("Tag buffer resuming datasource %s - reachable again", datasource_id)


def _tag_buffer_targets(selected: list[int | None]) -> list[int | None]:
    """Drop parked sources and apply the ceiling.

    TAG_BUFFER_MAX_SOURCES matters because the selection is a union across all
    users: one operator adding a plant grows everybody's memory footprint, so the
    cap has to be visible in the log when it bites.
    """
    now = asyncio.get_running_loop().time()
    # A park is a guess about the future, and a successful query is evidence
    # against it. Without this the buffer keeps ignoring a plant that came back
    # minutes ago, and its charts stay empty for the rest of the backoff — up to
    # an hour — while the tiles beside them show live values.
    #
    # Only a park caused by a *connection* failure can be refuted this way. A
    # plant with no variables_tag answers every query perfectly, so treating
    # "reachable" as recovery there would unpark it every tick and hand back the
    # exact log flood the park exists to stop.
    for i in selected:
        parked = _tag_skip.get(i)
        if (
            parked and parked[0] > now
            and i in _tag_park_transient
            and db.datasource_reachable(i)
        ):
            _unpark(i)
    live = [i for i in selected if _tag_skip.get(i, (0.0, 0.0))[0] <= now]
    if len(live) > config.TAG_BUFFER_MAX_SOURCES:
        logger.warning(
            "Tag buffer sampling only %d of %d selected datasources "
            "(TAG_BUFFER_MAX_SOURCES); the rest will chart from live queries.",
            config.TAG_BUFFER_MAX_SOURCES, len(live),
        )
    return live[:config.TAG_BUFFER_MAX_SOURCES]


def _park(datasource_id: int | None, error: str) -> None:
    """Back a repeatedly-failing source off, logging once per transition."""
    fails = _tag_fails.get(datasource_id, 0) + 1
    _tag_fails[datasource_id] = fails
    # Classify every failure, not just the one that trips the limit: whether the
    # host answered at all is what decides if this park can later be cut short.
    if db.datasource_reachable(datasource_id):
        _tag_park_transient.discard(datasource_id)
    else:
        _tag_park_transient.add(datasource_id)
    if fails < config.TAG_BUFFER_FAIL_LIMIT:
        return
    previous = _tag_skip.get(datasource_id, (0.0, 0.0))[1]
    delay = min(previous * 2, _TAG_SKIP_MAX_S) if previous else _TAG_SKIP_MIN_S
    _tag_skip[datasource_id] = (asyncio.get_running_loop().time() + delay, delay)
    logger.warning(
        "Tag buffer parking datasource %s for %ds after %d consecutive "
        "failures (%s)", datasource_id, delay, fails, error,
    )

async def _tag_buffer_loop() -> None:
    """Snapshot each selected source's variables_tag into db's in-memory history
    buffer on a timer, so Live panels bound to it can chart real
    `last N minutes` data despite the table holding only the current value.

    The set of sources is re-read every tick from the union of every user's
    selection. A static list would drift the moment an operator selects a new
    plant, and that drift is invisible: the panel just never fills in.
    """
    outage_logged = False
    while True:
        try:
            selected = await asyncio.to_thread(db.sampled_datasource_ids)
            outage_logged = False
        except (psycopg.OperationalError, PoolTimeout) as e:
            # Log the transition, not every tick: at a 5s poll an outage would
            # otherwise write a full traceback to the service log 720 times an
            # hour and bury everything else in it.
            if not outage_logged:
                logger.warning(
                    "Tag buffer paused - config database unreachable (%s)",
                    str(e).strip().splitlines()[0] if str(e).strip() else e,
                )
                outage_logged = True
            selected = []
        except Exception:
            logger.exception("Tag buffer could not resolve its datasources")
            selected = []

        targets = _tag_buffer_targets(selected)
        if targets:
            try:
                reports = await asyncio.to_thread(
                    db.fan_out, targets,
                    lambda ds: db.snapshot_variables_tag(datasource_id=ds),
                    label="tag snapshot",
                )
            except Exception:
                logger.exception("Tag buffer snapshot failed")
            else:
                for report in reports:
                    if report["ok"]:
                        _tag_fails.pop(report["datasource_id"], None)
                        _tag_skip.pop(report["datasource_id"], None)
                        _tag_park_transient.discard(report["datasource_id"])
                    else:
                        _park(report["datasource_id"], report["error"])
        await asyncio.sleep(config.TAG_BUFFER_POLL_SECONDS)

async def _db_watch_loop() -> None:
    """Keep cached DB health fresh and finish schema init once the host returns.
    Recovery must not need a service restart, so the schema DDL is retried here
    on a backoff. The probe runs whether or not the schema is ready: a database
    that dies *after* a successful boot is the common case, and without an
    unconditional probe an idle service would keep reporting the last known
    "ok" forever.
    """
    delay = _DB_RETRY_MIN_S
    while True:
        healthy = await asyncio.to_thread(db.probe)
        if healthy and not _schema_ready:
            if await asyncio.to_thread(_create_tables):
                logger.info("Database reachable again - schema initialised")
        try:
            await asyncio.to_thread(licensing.refresh)
        except Exception:
            logger.exception("Periodic license re-check failed")
        delay = _DB_RETRY_MIN_S if healthy else min(delay * 2, _DB_RETRY_MAX_S)
        await asyncio.sleep(_DB_POLL_S if healthy else delay)

_DB_POLL_S = 15          # steady-state health refresh
_DB_RETRY_MIN_S = 5      # first retry after a failure
_DB_RETRY_MAX_S = 60     # backoff ceiling during a long outage


@app.on_event("startup")
async def _start_background_tasks() -> None:
    global _tag_buffer_task, _db_watch_task
    _tag_buffer_task = asyncio.create_task(_tag_buffer_loop())
    _db_watch_task = asyncio.create_task(_db_watch_loop())

@app.on_event("shutdown")
async def _stop_background_tasks() -> None:
    for task in (_tag_buffer_task, _db_watch_task):
        if task:
            task.cancel()
    db.close_all_pools()

@app.exception_handler(psycopg.OperationalError)
@app.exception_handler(PoolTimeout)
async def _db_unavailable(request: Request, exc: Exception) -> JSONResponse:
    """Answer an unreachable database with 503 rather than an opaque 500.

    This covers the login path in particular: auth.get_user_by_username and
    get_user_by_id sit on the hot path of every authenticated request and have
    no error handling of their own.

    PoolTimeout is registered alongside OperationalError because pooling changes
    how an unreachable host surfaces: the pool opens without waiting, so the
    failure arrives when a caller asks for a connection and none can be made --
    a PoolTimeout, not an OperationalError. Without this it would be a 500.

    Note the routers that already catch psycopg.Error themselves (schema.py,
    panels.py, mimic.py) still answer 400 -- they intercept first, and are left
    alone here.
    """
    logger.warning("Database unavailable serving %s: %s", request.url.path, exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "Database unreachable - check the connection settings."},
    )

@app.get("/api/health")
@app.get("/health")
async def health() -> dict[str, object]:
    """Liveness probe so NSSM / monitoring can confirm the service is up.

    Always 200, even with the database down: install.ps1 smoke-tests this and
    NSSM restarts the service on a failure, so reporting a DB outage as an
    unhealthy *service* would turn a degraded API into a flapping one.

    The body stays coarse on purpose. This route has no auth dependency and
    -BindHost 0.0.0.0 is a documented deployment, so no error strings (psycopg
    embeds host and port in them) and no datasource names. Per-datasource detail
    lives behind the admin-gated /api/system/db.

    Exposed at /api/health as well as /health: in production IIS proxies only
    /api/* to this service, so the browser would get the SPA back from the root
    path and could never reach it.
    """
    state = db.db_state()
    return {
        "status": "ok",
        "db": "ok" if state["ok"] else "unreachable",
        "checked_at": state["checked_at"],
    }

# --- Bundled SPA ------------------------------------------------------------
# Registered last, on purpose: FastAPI matches routes in declaration order, so
# every /api router above already wins before the catch-all below is consulted.
# This is what lets a packaged install drop IIS + ARR entirely — one uvicorn
# process answers both /api/* and the React app. In dev STATIC_DIR does not
# exist, nothing is mounted, and Vite keeps serving the SPA on :5173.
if os.path.isdir(config.STATIC_DIR):
    from fastapi import HTTPException
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    _INDEX_HTML = os.path.join(config.STATIC_DIR, "index.html")
    app.mount(
        "/assets",
        StaticFiles(directory=os.path.join(config.STATIC_DIR, "assets")),
        name="assets",
    )
    logger.info("Serving bundled SPA from %s", config.STATIC_DIR)

    @app.get("/{spa_path:path}", include_in_schema=False)
    async def _spa(spa_path: str) -> FileResponse:
        # An unmatched /api/* path must 404 rather than get index.html back —
        # otherwise a client typo returns 200 + HTML and looks like a success.
        if spa_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")

        # Serve real files (favicon.svg, icons.svg, web.config, …) directly;
        # anything else is a client-side route and falls back to index.html.
        # abspath+prefix check keeps `..` segments from escaping STATIC_DIR.
        candidate = os.path.abspath(os.path.join(config.STATIC_DIR, spa_path))
        if (
            candidate.startswith(os.path.abspath(config.STATIC_DIR) + os.sep)
            and os.path.isfile(candidate)
        ):
            return FileResponse(candidate)
        return FileResponse(_INDEX_HTML)


if __name__ == "__main__":
    import uvicorn

    logger.info("Starting MML-Portal-API")
    uvicorn.run(app, host="0.0.0.0", port=8088)
