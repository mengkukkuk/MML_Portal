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
    kpi._MINUTE_MEMO.clear()
    monkeypatch.setattr(db, "describe_table", lambda table, ds=None: DESCRIBE)
    monkeypatch.setattr(db, "kpi_minute_buckets", lambda ds, t, ts, fams, lo, hi, **kw: machine_source(fams, lo, hi))
    monkeypatch.setattr(db, "kpi_sensor_minutes", sensor_source)
    monkeypatch.setattr(db, "tag_locations", lambda datasource_id=None: [])
    monkeypatch.setattr(db, "get_alert_source", lambda: None)
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
    s = run("kpistrip")
    (inc,) = s["incidents"]
    assert inc["tag"] == "Temp1" and inc["minutes"] == 10
    assert inc["response_min"] == 11 and inc["by"] == "somchai"
    assert inc["role"]["code"] == "MT"
    assert s["metrics"]["avg_response_min"] == 11 and s["metrics"]["incidents"] == 1


def test_response_location_keeps_that_locations_incidents_and_role(monkeypatch):
    monkeypatch.setattr(db, "list_response_roles", lambda: [
        {"role_id": 1, "code": "L13", "name_th": "หัวหน้าไลน์ 13", "name_en": "Line 13 supervisor",
         "location": "Line 13"},
        {"role_id": 2, "code": "L2", "name_th": "หัวหน้าไลน์ 2", "name_en": "Line 2 supervisor",
         "location": "Line 2"},
        {"role_id": 3, "code": "MT", "name_th": "ช่างซ่อม", "name_en": "Maintenance", "location": "global"}])
    # no variables_tag: Temp1's location comes from its logged change ("Line 13")
    here = run("kpistrip", sensors=["Temp1"], response_location="line13")
    (inc,) = here["incidents"]
    assert inc["role"]["code"] == "L13" and inc["location"] == "line13"
    assert here["settings"]["response_location"] == "line13"
    assert [c["tag"] for c in here["changes"]] == ["Temp1"]
    elsewhere = run("kpistrip", sensors=["Temp1"], response_location="Line 2")
    assert elsewhere["incidents"] == [] and elsewhere["changes"] == []
    assert elsewhere["metrics"]["incidents"] == 0 and elsewhere["metrics"]["avg_response_min"] is None
    # global = every location; the role then follows the tag's own place
    every = run("kpistrip", sensors=["Temp1"], response_location="global")
    assert every["settings"]["response_location"] is None
    assert every["incidents"][0]["role"]["code"] == "L13"


def test_variables_tag_says_where_a_tag_is(monkeypatch):
    monkeypatch.setattr(db, "tag_locations", lambda datasource_id=None: [
        {"tag_name": "Temp1", "location": "Line 2"}])
    assert run("kpistrip", sensors=["Temp1"], response_location="Line 13")["incidents"] == []
    assert len(run("kpistrip", sensors=["Temp1"], response_location="Line 2")["incidents"]) == 1


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


# --- the Response board: alert messages and who must act -------------------------------

ALERT_SOURCE = {"datasource_id": 9, "datasource_name": "plant", "table_name": "alert_messages", "ts_col": "created_at",
                "message_col": "message", "severity_col": "severity", "match_col": "location",
                "match_filter": "location", "role_col": "role_id"}
ROLES = [
    {"role_id": 2, "code": "automation", "name_th": "ทีมระบบอัตโนมัติ", "name_en": "Automation team",
     "location": "global"},
    {"role_id": 1, "code": "L-13-sup", "name_th": "หัวหน้าไลน์ 13", "name_en": "Line 13 supervisor",
     "location": "Line 13"},
    {"role_id": 4, "code": "maint", "name_th": "ช่างซ่อมบำรุง", "name_en": "Maintenance", "location": "global"},
]


def alert(minute, message, severity="crit", location="Line 13", role=None):
    day = NOW.replace(hour=0, minute=0, second=0, microsecond=0)
    return {"ts": day + timedelta(hours=8, minutes=minute), "message": message, "severity": severity,
            "match_value": location, "role_value": role}


@pytest.fixture
def alerts(monkeypatch):
    rows = [
        alert(0, "Check speed: 8,197 pcs/min — outside 7,000–8,000"),
        alert(1, "Check speed: 8,243 pcs/min — outside 7,000–8,000"),
        alert(2, "Check speed: 8,311 pcs/min — outside 7,000–8,000"),
        alert(30, "Check speed: 8,100 pcs/min — outside 7,000–8,000"),   # a new event: 28 min later
        alert(3, "Check defect trend: rising", "warn"),
        alert(4, "Check defect rate: OK", "info"),
        alert(5, "Mold change", "warn", location="L13"),                 # spelled unlike its rule
        alert(6, "Hold lot 4471", "2", location="Line 13", role="4"),    # the row names its role
        alert(7, "Belt slip", "warn", location="Line 2"),
    ]
    monkeypatch.setattr(db, "get_alert_source", lambda: ALERT_SOURCE)
    monkeypatch.setattr(db, "read_alert_messages",
                        lambda src, lo, hi, values, limit: sorted(rows, key=lambda r: r["ts"], reverse=True)[:limit])
    monkeypatch.setattr(db, "list_response_roles", lambda: ROLES)
    return rows


def test_board_groups_repeats_into_events_and_routes_each(alerts):
    b = run("response")["alerts"]
    assert b["available"] and b["min_severity"] == "warn"
    assert b["alerts"] == {"crit": 5, "warn": 3, "info": 1}
    assert b["shown_alerts"] == 8                       # the info row is counted, not listed
    speed = [e for e in b["events"] if e["kind"] == "Check speed"]
    assert [e["count"] for e in speed] == [1, 3]        # newest first; 28 min apart is two events
    assert speed[1]["message"].startswith("Check speed: 8,311") and "first_message" in speed[1]
    route = {e["message"]: (e["role"]["code"], e["via"]) for e in b["events"]}
    assert route["Check defect trend: rising"] == ("L-13-sup", "location")
    assert route["Mold change"] == ("automation", "catch_all")
    assert route["Hold lot 4471"] == ("maint", "tag")
    assert route["Belt slip"] == ("automation", "catch_all")


def test_board_names_locations_no_rule_claims(alerts):
    b = run("response")["alerts"]
    assert b["locations"] == ["L13", "Line 13", "Line 2"]
    assert b["unmatched"] == ["L13", "Line 2"]
    assert b["catch_all"]["code"] == "automation"
    # the location filter narrows the events, never the places offered
    assert run("response", response_location="Line 2")["alerts"]["locations"] == b["locations"]


def test_board_counts_per_role_worst_first(alerts):
    rows = run("response")["alerts"]["by_role"]
    assert rows[0]["role"]["code"] == "L-13-sup" and rows[0]["crit"] == 2 and rows[0]["warn"] == 1
    assert {r["role"]["code"]: r["events"] for r in rows} == {"L-13-sup": 3, "automation": 2, "maint": 1}


def test_board_location_and_severity_filters(alerts):
    line13 = run("response", response_location="line 13")["alerts"]
    assert {e["location"] for e in line13["events"]} == {"Line 13"}
    assert line13["alerts"]["warn"] == 1                # Line 2 and "L13" rows are not this place's
    crit = run("response", alert_min_severity="crit")["alerts"]
    assert {e["severity"] for e in crit["events"]} == {"crit"}
    everything = run("response", alert_min_severity="info")["alerts"]
    assert any(e["severity"] == "info" for e in everything["events"])


def test_board_without_a_source_or_reachable_table(monkeypatch):
    assert run("response")["alerts"] == {"configured": False, "available": False, "reason": "not_configured"}
    monkeypatch.setattr(db, "get_alert_source", lambda: ALERT_SOURCE)

    def missing(*a, **kw):
        raise ValueError("Column not found: created_at")
    monkeypatch.setattr(db, "read_alert_messages", missing)
    b = run("response")["alerts"]
    assert b["available"] is False and b["reason"] == "missing" and b["table"] == "alert_messages"


def test_response_board_no_longer_reads_sensors():
    s = run("response")
    assert "sensors" not in s and "incidents" not in s


def test_one_computation_per_block_per_minute(monkeypatch):
    calls = []
    real = kpi.summarize
    monkeypatch.setattr(kpi, "summarize", lambda *a, **kw: calls.append(kw["now"]) or real(*a, **kw))
    kpi._MINUTE_MEMO.clear()
    opts = {**OPTS}
    first = kpi.minute_summary("t", 5, opts, "andon", now=NOW)
    again = kpi.minute_summary("t", 5, opts, "andon", now=NOW + timedelta(seconds=25))
    assert again is first and len(calls) == 1                     # same minute: the poll is free
    kpi.minute_summary("t", 5, {**opts, "run_ratio": 0.7}, "andon", now=NOW)
    kpi.minute_summary("t", 5, opts, "waterfall", now=NOW)
    assert len(calls) == 3                                         # another setting or block type
    kpi.minute_summary("t", 5, opts, "andon", now=NOW + timedelta(minutes=1))
    assert len(calls) == 4                                         # the next minute recomputes
