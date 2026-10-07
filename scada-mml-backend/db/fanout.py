"""Parallel reads across every selected datasource."""

import atexit
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
import logging
from time import monotonic
from typing import Any

import psycopg

import config

from . import pool as _pool
from . import selection as _selection

logger = logging.getLogger("mml-api.db")

__all__ = [
    "_fanout_pool",
    "fan_out",
    "fan_out_rows",
]

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
    soft_schema_errors: bool = True,
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
    from a powered-off host — caught, reduced to its first line, returned as
    ok=False. Callers decide what partial means for them.

    An UndefinedTable/UndefinedColumn (a plant DB that simply doesn't
    implement this feature's schema — e.g. no `event_logs` table) is NOT a
    failure by default: it's returned as ok=True with an empty result.
    Selecting several sources where only some support a given view is the
    normal case, not an outage, so it must not trip the "did not answer"
    alert (SourceStatus) or the "CONNECTION LOST" strip (ConnectionAlarmStrip)
    — both read `ok` from this same report. Pass `soft_schema_errors=False`
    for a single-target call whose caller needs a hard error on a missing
    table (e.g. mimic.py's production-log lookup, which raises 503 with the
    detail rather than rendering an empty result).

    A future not complete within `timeout` is recorded ok=False and abandoned
    rather than cancelled: libpq is already blocked in a syscall, so cancelling
    would not free the worker any sooner.

    Callers must be sync defs. Every affected route already is, so it runs on the
    anyio worker threadpool where blocking is correct.
    """
    ids = list(datasource_ids)
    names = _selection.datasource_names(ids)
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
        except (psycopg.errors.UndefinedTable, psycopg.errors.UndefinedColumn) as e:
            # Schema mismatch, not an outage — see docstring. Soft-success so
            # this source contributes zero rows instead of raising an alert.
            if soft_schema_errors:
                entry = {"ok": True, "result": [], "error": None}
                logger.info(
                    "Fan-out %s: datasource %s has no matching schema (%s)",
                    label, ds_id, _pool._first_line(e) or type(e).__name__,
                )
            else:
                detail = _pool._first_line(e) or type(e).__name__
                entry = {"ok": False, "result": None, "error": detail}
                logger.warning("Fan-out %s failed on datasource %s: %s", label, ds_id, detail)
        except Exception as e:  # noqa: BLE001 — isolation is the whole point
            detail = _pool._first_line(e) or type(e).__name__
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
    soft_schema_errors: bool = True,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """fan_out + flatten. Every row gains `datasource_id` and `datasource_name`.

    Returns ``(rows, sources)``. `sources` is the per-source report, kept even on
    success so the UI can say which plants a merged list actually came from —
    "3 alarms" means something different from two sources than from one.

    Rows are tagged rather than grouped because the pages that consume this merge
    and sort across sources anyway; the tag is what makes React keys and the
    acknowledge path able to tell two plants' identically-named rows apart.
    """
    reports = fan_out(datasource_ids, query, label=label,
                      soft_schema_errors=soft_schema_errors)
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
