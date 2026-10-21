"""`/api/kpi/summary` and `/api/kpi/preview` (kpi.py), with the db layer stubbed.

The summary is checked end to end through the engine and the cache with a
fake bucket source, so these also pin the response shape the blocks render.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import db
import kpi
import kpi_cache

TZ = timezone(timedelta(hours=7))
NOW = datetime(2026, 10, 21, 10, 0, 30, tzinfo=TZ)

ADMIN = {"id": 1, "role": "admin"}
MANAGER = {"id": 2, "role": "manager"}
OPERATOR = {"id": 3, "role": "operator"}

DESCRIBE = {
    "value_columns": [],
    "array_value_columns": ["A-1-count_1", "A-1-defect_1", "A-1-defect_2", "B-1-count_1", "B-1-defect_1"],
    "datetime_columns": ["ts"],
    "column_types": {c: "x" for c in ["ts", "A-1-count_1", "A-1-defect_1", "A-1-defect_2", "B-1-count_1", "B-1-defect_1"]},
}
KPI = {"ts_col": "ts", "cost_per_piece": 10, "targets": {"A-1": 100}}
PANEL = {"id": 7, "source": "kpi", "table_name": "t", "datasource_id": 5, "options": {"kpi": KPI}}


def bucket(minute, speed=100.0, stopped=False, defects=1.0):
    return {"minute": minute, "valid_s": 60.0, "stop_s": 60.0 if stopped else 0.0, "gap_s": 0.0,
            "speed_sum": 0.0 if stopped else speed * 6, "speed_n": 0 if stopped else 6,
            "pieces": 0.0 if stopped else speed, "defects": 0.0 if stopped else defects}


def fake_source(families, lo, hi):
    """A-1 runs 08:00-09:00, stops 09:00-09:30, runs again; B-1 logs nothing."""
    out, t = [], lo
    day = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    while t < hi:
        if t >= day + timedelta(hours=8):
            stopped = day + timedelta(hours=9) <= t < day + timedelta(hours=9, minutes=30)
            out.append(bucket(t, stopped=stopped))
        t += timedelta(minutes=1)
    return {"A-1": out, "B-1": []}


@pytest.fixture(autouse=True)
def _stubs(monkeypatch):
    kpi_cache.CACHE.clear()
    monkeypatch.setattr(db, "describe_table", lambda table, ds=None: DESCRIBE)
    monkeypatch.setattr(db, "get_panel", lambda i: PANEL if i == 7 else ({"id": 8, "source": "table"} if i == 8 else None))
    monkeypatch.setattr(db, "kpi_minute_buckets", lambda ds, t, ts, fams, lo, hi, **k: fake_source(fams, lo, hi))
    monkeypatch.setattr(kpi, "_now", lambda: NOW)


def test_summary_shape_and_numbers():
    out = kpi.get_summary(7, user=MANAGER)
    a, b = out["families"]
    assert a["key"] == "A-1" and a["target_source"] == "set"
    assert a["state"] == "run" and a["minutes"]["stop"] == 30
    assert a["stop_loss"] == pytest.approx(30 * 100)
    assert a["pieces"] == pytest.approx(90 * 100) and a["defects"] == pytest.approx(90)
    assert b["state"] == "nodata" and b["target_source"] == "none"
    t = out["totals"]
    assert t["potential"] - t["stop_loss"] - t["slow_loss"] - t["defects"] == pytest.approx(t["good"])
    assert t["baht"]["defects"] == pytest.approx(900) and t["baht"]["lost"] == pytest.approx(30_000)
    assert out["cost_visible"] is True and out["cost_per_piece"] == 10
    assert out["compare"]["pieces"] == 0  # yesterday had no rows in the fake source


def test_operator_gets_no_money_anywhere():
    out = kpi.get_summary(7, user=OPERATOR)
    assert out["cost_visible"] is False
    flat = repr(out)
    assert "baht" not in flat and "cost_per_piece" not in flat
    assert out["totals"]["defects"] == pytest.approx(90)


def test_second_poll_fetches_only_the_tail(monkeypatch):
    calls = []

    def recording(ds, t, ts, fams, lo, hi, **k):
        calls.append((lo, hi))
        return fake_source(fams, lo, hi)

    monkeypatch.setattr(db, "kpi_minute_buckets", recording)
    kpi.get_summary(7, user=ADMIN)
    monkeypatch.setattr(kpi, "_now", lambda: NOW + timedelta(minutes=1))
    kpi.get_summary(7, user=ADMIN)
    assert calls[1][1] - calls[1][0] == timedelta(minutes=3)


def test_unknown_and_non_kpi_panels():
    with pytest.raises(HTTPException) as e:
        kpi.get_summary(99, user=ADMIN)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        kpi.get_summary(8, user=ADMIN)
    assert e.value.status_code == 400


def test_preview_validates_like_a_save():
    ok = kpi.preview(kpi.KpiPreviewIn(chart_type="andon", table_name="t", datasource_id=5,
                                      options={"kpi": KPI}), admin=ADMIN)
    assert len(ok["families"]) == 2
    with pytest.raises(HTTPException) as e:
        kpi.preview(kpi.KpiPreviewIn(chart_type="andon", table_name="t", options={"kpi": {"period": "x"}}),
                    admin=ADMIN)
    assert e.value.status_code == 400


def test_unbound_block_says_so():
    with pytest.raises(HTTPException) as e:
        kpi.summarize(None, None, {})
    assert "isn't bound" in e.value.detail
