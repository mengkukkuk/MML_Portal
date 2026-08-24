import asyncio
import logging
import os

import psycopg
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import alarms
import auth
import config
import dashboards
import datasources
import db
import events
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

app = FastAPI(title="SCADA MML API")

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
app.include_router(system.router)


def _create_tables() -> bool:
    """Create the dashboard_panels + dashboards + datasources + mimic tables so
    the Live grid, saved connections and the /monitor drawing can persist.

    Order is load-bearing in two places: dashboards must run after panels (it
    alters dashboard_panels), and mimic_symbols must run after mimic_assets
    (it carries a foreign key to it). mimic_layouts stands alone.

    Returns True on success. A database that cannot be reached must never abort
    startup: an exception raised from a startup handler aborts Starlette's
    lifespan, so uvicorn exits before binding a single route -- taking /health
    with it and leaving NSSM to restart-loop for the length of the outage. The
    whole body is guarded as one unit rather than per call: if the first DDL
    cannot reach the database, all seven will fail the same way, and seven
    separate connect timeouts would add half a minute to every boot.
    """
    global _schema_ready
    try:
        db.init_panels_table()
        db.init_dashboards_table()
        db.init_datasources_table()
        db.init_mimic_table()
        db.init_mimic_assets_table()
        db.init_mimic_symbols_table()
        db.init_report_tables()
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


_schema_ready = False


@app.on_event("startup")
def _ensure_tables() -> None:
    _create_tables()


_tag_buffer_task: asyncio.Task | None = None
_db_watch_task: asyncio.Task | None = None


async def _tag_buffer_loop() -> None:
    """Snapshot public.variables_tag into db's in-memory history buffer on a
    timer, so Live panels bound to it can chart real `last N minutes` data
    despite the table holding only the current value per tag."""
    outage_logged = False
    while True:
        try:
            await asyncio.to_thread(db.snapshot_variables_tag)
            outage_logged = False
        except psycopg.OperationalError as e:
            # Log the transition, not every tick: at a 5s poll an outage would
            # otherwise write a full traceback to the service log 720 times an
            # hour and bury everything else in it.
            if not outage_logged:
                logger.warning(
                    "Tag buffer paused - database unreachable (%s)",
                    str(e).strip().splitlines()[0] if str(e).strip() else e,
                )
                outage_logged = True
        except Exception:
            logger.exception("Tag buffer snapshot failed")
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


@app.exception_handler(psycopg.OperationalError)
async def _db_unavailable(request: Request, exc: psycopg.OperationalError) -> JSONResponse:
    """Answer an unreachable database with 503 rather than an opaque 500.

    This covers the login path in particular: auth.get_user_by_username and
    get_user_by_id sit on the hot path of every authenticated request and have
    no error handling of their own.

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
    embeds host and port in them) and no candidate names. Per-candidate detail
    lives behind the admin-gated /api/system/db.

    Exposed at /api/health as well as /health: in production IIS proxies only
    /api/* to this service, so the browser would get the SPA back from the root
    path and could never reach it.
    """
    state = db.db_state()
    return {
        "status": "ok",
        "db": "ok" if state["ok"] else "unreachable",
        "db_fallback": state["is_fallback"],
        "checked_at": state["checked_at"],
    }


if __name__ == "__main__":
    import uvicorn

    logger.info("Starting SCADA MML API on 0.0.0.0:8088")
    uvicorn.run(app, host="0.0.0.0", port=8088)
