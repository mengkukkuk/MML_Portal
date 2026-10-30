"""Network access endpoints -- who reached this host, and for how long.

Backs the Access page. Everything here is admin-only: the rows are remote IPs
and computer names. The monitor itself (access_monitor.py) polls inbound TCP on
the machine that hosts MML Portal -- web traffic through IIS and Remote Desktop --
and writes one line per finished session to <NETACCESS_LOG_ROOT>/YYYY-MM-DD/
conn_monitor.log; history is read back from those files.

The monitor is optional and fails soft: if it cannot start (no permission, no
psutil and no netstat, unwritable log folder) the API still boots, `running` is
false, and the page says so. That is the same contract as `_create_tables`.

Timestamps are naive server-local ISO strings, the convention report_engine uses.
"""
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

import access_monitor
import config
from access_log import AccessLog
from access_names import NameBook
from auth import require_admin
from licensing import require_valid_license

logger = logging.getLogger("mml-api.access")

router = APIRouter(
    prefix="/api/access",
    tags=["access"],
    dependencies=[Depends(require_valid_license)],
)

MAX_RANGE_DAYS = 31

_monitor: access_monitor.Monitor | None = None
_store: AccessLog | None = None


# --- Lifecycle (called from main.py) ----------------------------------------
def get_store() -> AccessLog:
    """The log reader/writer. Created lazily so history stays readable even when
    the monitor is switched off or failed to start."""
    global _store
    if _store is None:
        _store = AccessLog(config.NETACCESS_LOG_ROOT)
    return _store


def start_monitor() -> access_monitor.Monitor | None:
    """Build the monitor, or return None. Never raises."""
    global _monitor
    if not config.NETACCESS_ENABLED:
        logger.info("Network access monitor disabled (NETACCESS_ENABLED=0)")
        return None
    try:
        ports = access_monitor.parse_ports(config.NETACCESS_PORTS)
        if not ports:
            logger.warning("Network access monitor not started: NETACCESS_PORTS is empty")
            return None
        store = get_store()
        names = NameBook(config.NETACCESS_NAMES_FILE, store.cache_path,
                         config.NETACCESS_AUTO_RESOLVE_NAMES)
        _monitor = access_monitor.Monitor(
            ports, store, names,
            prefixes=config.NETACCESS_REMOTE_IP_PREFIXES,
            interval=config.NETACCESS_INTERVAL_SECONDS,
            ignore_loopback=config.NETACCESS_IGNORE_LOOPBACK,
        )
    except Exception:
        logger.exception("Network access monitor could not start - the Access page will show it as stopped")
        _monitor = None
    return _monitor


def stop_monitor() -> None:
    """Close open sessions on a clean shutdown. Never raises."""
    global _monitor
    if _monitor is None:
        return
    try:
        _monitor.shutdown()
    except Exception:
        logger.exception("Network access monitor did not shut down cleanly")
    finally:
        _monitor = None


# --- Schemas ----------------------------------------------------------------
class PortOut(BaseModel):
    port: int
    label: str
    grace_seconds: float


class StatusOut(BaseModel):
    enabled: bool
    running: bool
    since: datetime | None = None
    interval_seconds: float
    server_time: datetime
    ports: list[PortOut]


class ActiveSessionOut(BaseModel):
    computer_name: str
    remote_ip: str
    protocol: str
    port: int
    connected_since: datetime


class ActiveOut(BaseModel):
    server_time: datetime
    sessions: list[ActiveSessionOut]


class HistoryRowOut(BaseModel):
    computer_name: str
    remote_ip: str
    protocol: str
    port: int | None = None
    start: datetime
    end: datetime
    seconds: int
    duration: str
    note: str = ""


class HistoryOut(BaseModel):
    start: datetime
    end: datetime
    rows: list[HistoryRowOut]
    total: int
    truncated: bool
    files: list[str]


# --- Routes -----------------------------------------------------------------
def _naive_local(dt: datetime) -> datetime:
    """Accept both '2026-10-30T09:00:00' and '...Z' / '+07:00'; compare in server-local time."""
    return dt.astimezone().replace(tzinfo=None) if dt.tzinfo else dt


@router.get("/status", response_model=StatusOut)
def status(_admin=Depends(require_admin)) -> StatusOut:
    m = _monitor
    ports = sorted(m.ports.values(), key=lambda p: p.port) if m else []
    return StatusOut(
        enabled=config.NETACCESS_ENABLED,
        running=bool(m and m.is_running()),
        since=m.started if m else None,
        interval_seconds=m.interval if m else config.NETACCESS_INTERVAL_SECONDS,
        server_time=datetime.now().replace(microsecond=0),
        ports=[PortOut(port=p.port, label=p.label, grace_seconds=p.grace_seconds) for p in ports],
    )


@router.get("/active", response_model=ActiveOut)
def active(_admin=Depends(require_admin)) -> ActiveOut:
    m = _monitor
    return ActiveOut(
        server_time=datetime.now().replace(microsecond=0),
        sessions=m.active() if m else [],
    )


@router.get("/history", response_model=HistoryOut)
def history(
    start: datetime | None = Query(None, description="Range start (server-local ISO). Default: today 00:00"),
    end: datetime | None = Query(None, description="Range end (server-local ISO). Default: now"),
    protocol: str | None = Query(None, max_length=32),
    q: str | None = Query(None, max_length=100),
    limit: int = Query(5000, ge=1, le=10000),
    _admin=Depends(require_admin),
) -> HistoryOut:
    now = datetime.now().replace(microsecond=0)
    end_dt = _naive_local(end) if end else now
    start_dt = _naive_local(start) if start else end_dt.replace(hour=0, minute=0, second=0)
    if end_dt < start_dt:
        raise HTTPException(status_code=400, detail="'end' must not be before 'start'")
    if end_dt - start_dt > timedelta(days=MAX_RANGE_DAYS):
        raise HTTPException(status_code=400, detail=f"Range is limited to {MAX_RANGE_DAYS} days")
    try:
        rows, total, truncated, files = get_store().read_range(start_dt, end_dt, protocol, q, limit)
    except OSError as e:
        logger.warning("Access log folder unreadable: %s", e)
        raise HTTPException(status_code=503, detail="Access log folder is not readable")
    return HistoryOut(start=start_dt, end=end_dt, rows=rows, total=total,
                      truncated=truncated, files=files)
