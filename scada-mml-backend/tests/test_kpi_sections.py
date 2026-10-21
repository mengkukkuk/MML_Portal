"""The second set of management blocks: line mode, timelines, sensors, incidents,
responses, the 7-day trend and the defect Pareto (kpi_engine.py + kpi.py).

Rules taken from the Line 13 monitoring dashboard
(docs/Line13_Monitoring_Dashboard.html): one line, CAM001's count is output and
every camera's defects are the line's; a sensor is out of band against its own
[value, setpoint, high, low]; a reading unchanged for 10 minutes is frozen
("blind"); pieces made while a sensor is out or frozen are at risk.
"""
from datetime import datetime, timedelta, timezone

import pytest

import db
import kpi
import kpi_cache
import kpi_engine as k

TZ = timezone(timedelta(hours=7))
T0 = datetime(2026, 10, 21, 8, 0, tzinfo=TZ)


def fb(minute, speed=100.0, defects=1.0, stopped=False, parts=None):
    return {"minute": minute, "valid_s": 60.0, "stop_s": 60.0 if stopped else 0.0, "gap_s": 0.0,
            "speed_sum": 0.0 if stopped else speed * 6, "speed_n": 0 if stopped else 6,
            "pieces": 0.0 if stopped else speed, "defects": 0.0 if stopped else defects,
            "parts": parts if parts is not None else [defects, 0.0]}


def sb(minute, value, *, low=20.0, high=30.0, missing=False, moving=True):
    if missing:
        return {"minute": minute, "valid_s": 0.0, "gap_s": 60.0, "out_s": 0.0, "vmin": None, "vmax": None,
                "last": None, "setpoint": None, "high": None, "low": None}
    return {"minute": minute, "valid_s": 60.0, "gap_s": 0.0, "out_s": 60.0 if not low <= value <= high else 0.0,
            "vmin": value - (0.5 if moving else 0), "vmax": value + (0.5 if moving else 0), "last": value,
            "setpoint": 25.0, "high": high, "low": low}


# --- engine -----------------------------------------------------------------------

def test_line_takes_one_speed_and_every_cameras_defects():
    line = [fb(T0, 100, 1), fb(T0 + timedelta(minutes=1), 100, 2)]
    other = [fb(T0, 999, 5), fb(T0 + timedelta(minutes=2), 999, 7)]
    out = k.line_buckets(line, [line, other])
    assert [b["pieces"] for b in out] == [100, 100, 0.0]
    assert [b["defects"] for b in out] == [6, 2, 7]
    assert out[2]["gap_s"] == 60.0  # defects but no line sample: still a gap


def test_timeline_buckets_and_worst_state_on_ties():
    grid = [fb(T0 + timedelta(minutes=i)) for i in range(4)]
    rows = k.timeline(grid, [k.RUN, k.STOP, k.RUN, k.STOP], [0, 100, 0, 100], 2)
    assert len(rows) == 2 and rows[0]["state"] == k.STOP
    assert rows[0]["pieces"] == 200 and rows[0]["potential"] == 300


def test_sensor_states_out_flat_missing():
    grid = ([sb(T0 + timedelta(minutes=i), 25) for i in range(3)]
            + [sb(T0 + timedelta(minutes=3), 35)]
            + [sb(T0 + timedelta(minutes=4), None, missing=True)]
            + [sb(T0 + timedelta(minutes=5 + i), 0, moving=False) for i in range(10)])
    states = k.sensor_states(grid, 10)
    assert states[:5] == [k.OK, k.OK, k.OK, k.OUT, k.MISSING]
    assert set(states[5:]) == {k.FLAT}  # 0 against a 20..30 band, frozen: flat outranks out


def test_short_steady_run_is_not_flat():
    grid = [sb(T0 + timedelta(minutes=i), 25, moving=False) for i in range(9)]
    assert set(k.sensor_states(grid, 10)) == {k.OK}


def test_incidents_merge_short_gaps_and_count_risk_pieces():
    states = [k.OUT, k.OUT, k.OK, k.OK, k.OUT, k.OK, k.OK, k.OK, k.OK, k.OUT]
    grid = [sb(T0 + timedelta(minutes=i), 25) for i in range(10)]
    line = [fb(T0 + timedelta(minutes=i), 10) for i in range(10)]
    incs = k.incidents(states, grid, line, merge_min=3, live=True)
    assert [(i["minutes"], i["risk_pieces"], i["open"]) for i in incs] == [(5, 50, False), (1, 10, True)]


# --- summary sections ------------------------------------------------------------------

NOW = datetime(2026, 10, 21, 10, 0, 30, tzinfo=TZ)
DESCRIBE = {
    "value_columns": [],
    "array_value_columns": ["A-1-count_1", "A-1-defect_1", "A-1-defect_2",
                            "B-1-count_1", "B-1-defect_1", "B-1-defect_2", "Temp1", "Temp2"],
    "datetime_columns": ["ts"],
    "column_types": {c: "x" for c in ["ts", "A-1-count_1", "A-1-defect_1", "A-1-defect_2",
                                      "B-1-count_1", "B-1-defect_1", "B-1-defect_2", "Temp1", "Temp2"]},
}


def machine_source(families, lo, hi):
    """A-1 (the line) runs from 08:00, stops 09:00-09:30; B-1 inspects 50/min with 2 defects."""
    day = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    out = {"A-1": [], "B-1": []}
    t = lo
    while t < hi:
        if t >= day + timedelta(hours=8):
            stopped = day + timedelta(hours=9) <= t < day + timedelta(hours=9, minutes=30)
            out["A-1"].append(fb(t, 100, 1, stopped, parts=[0.0 if stopped else 1.0, 0.0]))
            out["B-1"].append(fb(t, 50, 2, parts=[0.5, 1.5]))
        t += timedelta(minutes=1)
    return out


def sensor_source(ds, table, ts_col, cols, lo, hi, **kw):
    """Temp1 out of band 08:30-08:39; Temp2 frozen at 0 all day."""
    day = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    out = {c: [] for c in cols}
    t = lo
    while t < hi:
        if "Temp1" in out:
            hot = day + timedelta(hours=8, minutes=30) <= t < day + timedelta(hours=8, minutes=40)
            out["Temp1"].append(sb(t, 35 if hot else 25))
        if "Temp2" in out:
            out["Temp2"].append(sb(t, 0, moving=False))
        t += timedelta(minutes=1)
    return out


@pytest.fixture(autouse=True)
def _stubs(monkeypatch):
    kpi_cache.CACHE.clear()
    monkeypatch.setattr(db, "describe_table", lambda table, ds=None: DESCRIBE)
    monkeypatch.setattr(db, "kpi_minute_buckets", lambda ds, t, ts, fams, lo, hi, **kw: machine_source(fams, lo, hi))
    monkeypatch.setattr(db, "kpi_sensor_minutes", sensor_source)
    monkeypatch.setattr(db, "list_response_roles", lambda: [
        {"role_id": 3, "code": "MT", "name_th": "ช่างซ่อม", "name_en": "Maintenance", "location": None}])
    monkeypatch.setattr(db, "kpi_event_rows", lambda ds, tags, lo, hi, limit=500: [
        {"location": "Line 13", "tag_name": "Temp1", "event": "setpoint 25 -> 24",
         "at_date_time": NOW.replace(hour=8, minute=41, second=0).replace(tzinfo=None), "who": "somchai"}])


OPTS = {"ts_col": "ts", "targets": {"A-1": 100, "B-1": 50}, "cost_per_piece": 10, "plan_pieces": 24000}


def run(chart_type, **over):
    return kpi.summarize("t", 5, {**OPTS, **over}, now=NOW, chart_type=chart_type)


def test_line_scope_counts_the_line_not_the_sum():
    s = run(None)
    assert s["scope"] == "line" and s["line_family"] == "A-1"
    t = s["totals"]
    assert t["pieces"] == pytest.approx(90 * 100)          # A-1 only
    assert t["defects"] == pytest.approx(90 * 1 + 120 * 2)  # every camera's rejects
    assert t["stop_loss"] == pytest.approx(30 * 100)
    machines = run(None, scope="machines")["totals"]
    assert machines["pieces"] == pytest.approx(90 * 100 + 120 * 50)


def test_metrics_and_plan_to_date():
    m = run(None)["metrics"]
    assert m["availability"] == pytest.approx(90 / 120)
    assert m["yield"] == pytest.approx((9000 - 330) / 9000)
    # plan 24,000 over the whole day, 600 minutes elapsed at 10:00
    assert m["plan_pct"] == pytest.approx((9000 - 330) / (24000 * 600 / 1440))
    assert m["baht"]["cost_total"] == pytest.approx((330 + 3000) * 10)


def test_plan_follows_working_hours():
    s = run(None, working_hours={"start": "08:00", "end": "16:00", "days": [1, 2, 3, 4, 5, 6, 7]})
    assert s["plan"]["to_date"] == pytest.approx(24000 * 120 / 480)


def test_timeline_rows_carry_cumulative_good_potential_and_plan():
    s = run("pace")
    rows = s["timeline"]["rows"]
    assert s["timeline"]["size_min"] == 5 and len(rows) == 120
    last = rows[-1]
    assert last["good_cum"] == pytest.approx(9000 - 330)
    assert last["potential_cum"] == pytest.approx(9000 + 3000)
    assert last["plan_cum"] == pytest.approx(24000 * 600 / 1440)
    assert any(r["state"] == "stop" for r in rows)
    hours = s["hourly"]["rows"]
    assert hours[9]["rate"] == pytest.approx((30 + 120) / 3000)


def test_sensors_risk_and_blind_time():
    s = run("sensors")
    by = {x["key"]: x for x in s["sensors"]}
    assert by["Temp1"]["minutes"]["out"] == 10 and by["Temp2"]["state"] == "flat"
    m = s["metrics"]
    # Temp2 frozen all day: every line minute is at risk and every scheduled minute is blind
    assert m["risk_pieces"] == pytest.approx(9000)
    assert m["blind_min"] == 120


def test_response_pairs_incidents_with_the_first_change():
    s = run("response")
    (inc,) = s["incidents"]
    assert inc["tag"] == "Temp1" and inc["minutes"] == 10
    assert inc["response_min"] == 11 and inc["by"] == "somchai"
    assert inc["role"]["code"] == "MT"
    assert s["metrics"]["avg_response_min"] == 11 and s["metrics"]["incidents"] == 1


def test_seven_day_trend():
    days = run("kpitrend")["days"]
    assert len(days) == 7
    today = days[-1]
    assert today["availability"] == pytest.approx(0.75)
    assert today["blind_min"] == 120
    assert days[0]["pieces"] == 0


def test_pareto_by_camera_and_type():
    p = run("pareto")["pareto"]
    names = [x["item"] for x in p["items"]]
    assert names[0] == "B-1 · defect_2"  # 1.5 x 120
    assert p["items"][-1]["cum_share"] == pytest.approx(1.0)
    assert p["total"] == pytest.approx(90 + 120 * 2)


def test_operator_sees_no_money_in_new_sections():
    s = kpi.for_user(run("pareto"), {"role": "operator"})
    assert "baht" not in repr(s) and "cost_per_piece" not in repr(s)
