"""kpi_cache.KpiCache: fetch once, then only the tail."""
from datetime import datetime, timedelta, timezone

import kpi_cache
from kpi_cache import KpiCache

T0 = datetime(2026, 10, 21, 8, 0, tzinfo=timezone.utc)
FAM = [{"key": "A", "speed": "A-count_1", "defects": ["A-defect_1"]}]
BINDING = (5, "t", "ts", 0.0, 50_000, 10.0)


def bucket(minute, pieces=1.0):
    return {"minute": minute, "valid_s": 60.0, "stop_s": 0.0, "gap_s": 0.0,
            "speed_sum": 600.0, "speed_n": 6, "pieces": pieces, "defects": 0.0}


class Source:
    """Fake fetch: one bucket per minute, recording the ranges asked for."""

    def __init__(self, pieces=1.0):
        self.calls, self.pieces = [], pieces

    def __call__(self, families, lo, hi):
        self.calls.append((lo, hi))
        out, t = [], lo
        while t < hi:
            out.append(bucket(t, self.pieces))
            t += timedelta(minutes=1)
        return {f["key"]: out for f in families}


def at(minutes):
    return T0 + timedelta(minutes=minutes)


def test_second_call_fetches_only_the_tail_with_overlap():
    cache, src = KpiCache(), Source()
    cache.buckets(BINDING, FAM, at(0), at(60), src)
    out = cache.buckets(BINDING, FAM, at(0), at(61), src)
    assert src.calls == [(at(0), at(60)), (at(58), at(61))]
    assert len(out["A"]) == 61


def test_overlap_replaces_late_minutes_instead_of_duplicating():
    cache = KpiCache()
    cache.buckets(BINDING, FAM, at(0), at(10), Source(1.0))
    out = cache.buckets(BINDING, FAM, at(0), at(10), Source(5.0))
    assert len(out["A"]) == 10
    assert [b["pieces"] for b in out["A"]][-2:] == [5.0, 5.0]
    assert out["A"][0]["pieces"] == 1.0


def test_an_earlier_start_refetches_from_that_start():
    cache, src = KpiCache(), Source()
    cache.buckets(BINDING, FAM, at(30), at(60), src)
    out = cache.buckets(BINDING, FAM, at(0), at(60), src)
    assert src.calls[-1] == (at(0), at(60))
    assert len(out["A"]) == 60


def test_old_minutes_are_evicted(monkeypatch):
    monkeypatch.setattr(kpi_cache, "KEEP", timedelta(minutes=30))
    cache, src = KpiCache(), Source()
    cache.buckets(BINDING, FAM, at(0), at(60), src)
    entry = next(iter(cache._series.values()))
    assert min(entry["minutes"]) == at(30)


def test_key_count_is_capped_lru():
    cache, src = KpiCache(max_keys=2), Source()
    for i in range(3):
        cache.buckets((i, *BINDING[1:]), FAM, at(0), at(1), src)
    assert [k[0] for k in cache._series] == [1, 2]


def test_target_is_reused_within_the_hour():
    now = [0.0]
    cache = KpiCache(clock=lambda: now[0])
    running = [bucket(at(i)) for i in range(120)]
    assert cache.target(("A",), running) == 100.0
    assert cache.target(("A",), []) == 100.0          # cached, input ignored
    now[0] = 3601
    assert cache.target(("A",), []) is None            # refreshed
