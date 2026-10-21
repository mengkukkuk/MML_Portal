"""Incremental, process-local cache of KPI minute buckets.

A month of 10-second rows is about 260k rows per table; re-reading them on
every 60-second poll of every management block would hammer the plant
database and the VPN link in front of it. Closed minutes never change (bar a
late row or two), so they are fetched once and kept: each later poll fetches
only the tail since the last one, re-reading a two-minute overlap so a late row
replaces its minute instead of being lost.

The open minute is never cached — `end` is always the current minute's start.
A backend restart simply starts cold again.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta
from typing import Any, Callable

import kpi_engine

OVERLAP = timedelta(minutes=2)
KEEP = timedelta(days=64)        # a month plus the month before it, for comparison
MAX_KEYS = 128
TARGET_TTL_S = 3600
TARGET_WINDOW = timedelta(days=7)

Fetch = Callable[[list[dict[str, Any]], datetime, datetime], dict[str, list[dict[str, Any]]]]


class KpiCache:
    """Minute buckets per (binding, family), plus the hourly auto targets."""

    def __init__(self, max_keys: int = MAX_KEYS, clock: Callable[[], float] = time.monotonic):
        self._lock = threading.Lock()
        self._series: OrderedDict[tuple, dict[str, Any]] = OrderedDict()
        self._targets: dict[tuple, tuple[float | None, float]] = {}
        self._max_keys = max_keys
        self._clock = clock

    def clear(self) -> None:
        with self._lock:
            self._series.clear()
            self._targets.clear()

    def buckets(
        self,
        binding: tuple,
        families: list[dict[str, Any]],
        start: datetime,
        end: datetime,
        fetch: Fetch,
    ) -> dict[str, list[dict[str, Any]]]:
        """{family key: buckets in [start, end)}, fetching only what is missing.

        `binding` identifies everything that shapes a bucket apart from the
        family itself (source, table, ts column, stop threshold, valid max,
        sample interval). All families share one fetch: one query reads them
        side by side, so the tail is fetched once per poll, not once per machine.
        """
        keys = {f["key"]: (*binding, f["key"], f["speed"], tuple(f["defects"])) for f in families}
        with self._lock:
            entries = {k: self._series.get(key) for k, key in keys.items()}
            if any(e is None or e["lo"] > start for e in entries.values()):
                lo = start
            else:
                lo = max(start, min(e["hi"] for e in entries.values()) - OVERLAP)
        fetched = fetch(families, lo, end) if lo < end else {}

        with self._lock:
            out = {}
            for fam_key, key in keys.items():
                entry = self._series.get(key)
                if entry is None or entry["lo"] > lo:
                    entry = {"lo": lo, "hi": lo, "minutes": {} if entry is None else entry["minutes"]}
                for m in [m for m in entry["minutes"] if m >= lo]:
                    del entry["minutes"][m]
                for bucket in fetched.get(fam_key, []):
                    entry["minutes"][bucket["minute"]] = bucket
                entry["hi"] = max(entry["hi"], end)
                floor = end - KEEP
                if entry["lo"] < floor:
                    entry["minutes"] = {m: b for m, b in entry["minutes"].items() if m >= floor}
                    entry["lo"] = floor
                self._series[key] = entry
                self._series.move_to_end(key)
                out[fam_key] = [b for m, b in sorted(entry["minutes"].items()) if start <= m < end]
            while len(self._series) > self._max_keys:
                self._series.popitem(last=False)
            return out

    def target(self, key: tuple, buckets: list[dict[str, Any]]) -> float | None:
        """The family's auto target, recomputed at most once an hour."""
        now = self._clock()
        with self._lock:
            hit = self._targets.get(key)
            if hit is not None and now - hit[1] < TARGET_TTL_S:
                return hit[0]
        value = kpi_engine.p95_target(buckets)
        with self._lock:
            self._targets[key] = (value, now)
        return value


#: the one cache the KPI router uses
CACHE = KpiCache()
