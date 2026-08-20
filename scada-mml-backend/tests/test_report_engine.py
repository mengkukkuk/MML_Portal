"""Tests for the OEE interval math in report_engine.

No database and no mocks — the module is deliberately pure, so every case here
is a hand-built event list with a hand-checked expected duration. That matters
because these numbers end up in management reports: a bug here does not crash,
it just quietly reports the wrong availability.

The recurring assertion is the tiling invariant: the intervals returned for a
window must sum to exactly that window, with no gaps and no overlaps. Almost
every plausible bug in build_intervals breaks it.
"""
from datetime import datetime, timedelta

import pytest

import report_engine as re_


T0 = datetime(2026, 8, 10, 0, 0, 0)
T_END = datetime(2026, 8, 11, 0, 0, 0)          # exactly 24h window
DAY = 86400.0
FUTURE = datetime(2030, 1, 1)                    # keeps `now` out of the way


def ev(offset_hours, event, ts=None):
    """One event row, positioned relative to the window start."""
    return {
        "location": "Line 1",
        "tag_name": "M01",
        "event": event,
        "at_date_time": ts or (T0 + timedelta(hours=offset_hours)),
    }


def secs(intervals, state):
    return sum(i["seconds"] for i in intervals if i["state"] == state)


def assert_tiles(intervals, start, end):
    """Intervals must exactly tile [start, end): contiguous, ordered, no gaps."""
    assert intervals, "expected a non-empty timeline"
    assert intervals[0]["start"] == start
    assert intervals[-1]["end"] == end
    for a, b in zip(intervals, intervals[1:]):
        assert a["end"] == b["start"], "gap or overlap between intervals"
    total = sum(i["seconds"] for i in intervals)
    assert total == pytest.approx((end - start).total_seconds())


# --- classify ---------------------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("Machine Started", re_.RUN),
    ("RUNNING", re_.RUN),
    ("Machine Stopped", re_.STOP),
    ("Emergency stop pressed", re_.STOP),
    ("Idle", re_.IDLE),
    ("Changeover begin", re_.PLANNED_DOWN),
])
def test_classify_matches_vocabulary(text, expected):
    assert re_.classify(text, None) == expected


def test_classify_prefers_specific_state_over_run_substring():
    # "restart after maintenance" contains both "start" (RUN) and "maintenance"
    # (PLANNED_DOWN). Priority order must pick the more specific one, otherwise
    # changeovers get counted as production time.
    assert re_.classify("Restart after maintenance", None) == re_.PLANNED_DOWN


def test_classify_exact_match_beats_substring_priority():
    # A plant can pin an ambiguous phrase by listing it verbatim.
    rules = {re_.RUN: ["stop and go"], re_.STOP: ["stop"]}
    assert re_.classify("Stop and go", rules) == re_.RUN


def test_classify_returns_none_for_unknown_and_empty():
    assert re_.classify("Operator badged in", None) is None
    assert re_.classify("", None) is None
    assert re_.classify(None, None) is None


# --- build_intervals --------------------------------------------------------

def test_carry_in_from_before_window():
    """A machine that started days ago and logged nothing inside the window
    must still report a full day of runtime, not zero."""
    events = [ev(-72, "Machine Started")]
    iv = re_.build_intervals(events, T0, T_END, now=FUTURE)
    assert_tiles(iv, T0, T_END)
    assert secs(iv, re_.RUN) == DAY
    assert secs(iv, re_.UNKNOWN) == 0


def test_carry_in_uses_latest_event_before_window():
    events = [ev(-72, "Machine Started"), ev(-2, "Machine Stopped")]
    iv = re_.build_intervals(events, T0, T_END, now=FUTURE)
    assert secs(iv, re_.STOP) == DAY


def test_no_prior_event_produces_leading_unknown():
    """Silence before the window is not evidence of running."""
    events = [ev(6, "Machine Started")]
    iv = re_.build_intervals(events, T0, T_END, now=FUTURE)
    assert_tiles(iv, T0, T_END)
    assert secs(iv, re_.UNKNOWN) == 6 * 3600
    assert secs(iv, re_.RUN) == 18 * 3600


def test_open_trailing_interval_clamps_to_now():
    """An in-progress report must not claim knowledge of the future."""
    now = T0 + timedelta(hours=10)
    iv = re_.build_intervals([ev(-1, "Machine Started")], T0, T_END, now=now)
    assert_tiles(iv, T0, now)
    assert secs(iv, re_.RUN) == 10 * 3600


def test_window_entirely_in_future_returns_nothing():
    iv = re_.build_intervals([ev(-1, "Machine Started")], T0, T_END, now=T0)
    assert iv == []


def test_unmatched_event_preserves_current_state():
    """An unrecognised event means 'no information', so the machine keeps
    running rather than punching an UNKNOWN hole in a measured timeline."""
    events = [ev(-1, "Machine Started"), ev(8, "Operator badged in")]
    iv = re_.build_intervals(events, T0, T_END, now=FUTURE)
    assert_tiles(iv, T0, T_END)
    assert secs(iv, re_.RUN) == DAY
    assert secs(iv, re_.UNKNOWN) == 0


def test_out_of_order_events_are_sorted():
    """Logs written by several PLCs are not guaranteed monotonic."""
    events = [ev(18, "Machine Started"), ev(-1, "Machine Started"), ev(6, "Machine Stopped")]
    iv = re_.build_intervals(events, T0, T_END, now=FUTURE)
    assert_tiles(iv, T0, T_END)
    assert secs(iv, re_.STOP) == 12 * 3600
    assert secs(iv, re_.RUN) == 12 * 3600


def test_repeated_same_state_events_do_not_split_intervals():
    """A chatty PLC re-announcing 'Running' must not inflate the stop count."""
    events = [ev(-1, "Machine Started"), ev(4, "Running"), ev(8, "Running")]
    iv = re_.build_intervals(events, T0, T_END, now=FUTURE)
    assert len(iv) == 1
    assert secs(iv, re_.RUN) == DAY


def test_duplicate_timestamps_drop_zero_width_intervals():
    same = T0 + timedelta(hours=5)
    events = [ev(-1, "Machine Started"), ev(0, "Machine Stopped", ts=same), ev(0, "Idle", ts=same)]
    iv = re_.build_intervals(events, T0, T_END, now=FUTURE)
    assert all(i["seconds"] > 0 for i in iv)
    assert_tiles(iv, T0, T_END)


def test_stop_straddling_midnight_is_split_by_window_edge():
    """A stop running from 22:00 to 02:00 must contribute 2h to each day."""
    events = [ev(-1, "Machine Started"), ev(22, "Machine Stopped"), ev(26, "Machine Started")]

    day1 = re_.build_intervals(events, T0, T_END, now=FUTURE)
    assert secs(day1, re_.STOP) == 2 * 3600

    d2_start, d2_end = T_END, T_END + timedelta(days=1)
    day2 = re_.build_intervals(events, d2_start, d2_end, now=FUTURE)
    assert secs(day2, re_.STOP) == 2 * 3600
    assert_tiles(day2, d2_start, d2_end)


def test_empty_event_list_is_all_unknown():
    iv = re_.build_intervals([], T0, T_END, now=FUTURE)
    assert_tiles(iv, T0, T_END)
    assert secs(iv, re_.UNKNOWN) == DAY


# --- attribute_reasons ------------------------------------------------------

def alarm(offset_hours, text, severity="warning"):
    return {"at": T0 + timedelta(hours=offset_hours), "text": text, "severity": severity}


def test_alarm_inside_interval_becomes_the_reason():
    iv = re_.build_intervals([ev(-1, "Machine Started"), ev(6, "Machine Stopped")], T0, T_END, now=FUTURE)
    re_.attribute_reasons(iv, [alarm(7, "Hydraulic pressure low")], lead_seconds=60)
    stop = next(i for i in iv if i["state"] == re_.STOP)
    assert stop["reason"] == "Hydraulic pressure low"


def test_alarm_just_before_stop_is_caught_by_lead_window():
    """Alarms typically fire seconds before the machine actually halts."""
    stop_at = T0 + timedelta(hours=6)
    iv = re_.build_intervals(
        [ev(-1, "Machine Started"), ev(0, "Machine Stopped", ts=stop_at)], T0, T_END, now=FUTURE)
    a = {"at": stop_at - timedelta(seconds=30), "text": "Motor overload", "severity": "critical"}
    re_.attribute_reasons(iv, [a], lead_seconds=60)
    assert next(i for i in iv if i["state"] == re_.STOP)["reason"] == "Motor overload"


def test_alarm_outside_lead_window_is_ignored():
    stop_at = T0 + timedelta(hours=6)
    iv = re_.build_intervals(
        [ev(-1, "Machine Started"), ev(0, "Machine Stopped", ts=stop_at)], T0, T_END, now=FUTURE)
    a = {"at": stop_at - timedelta(seconds=600), "text": "Unrelated", "severity": "critical"}
    re_.attribute_reasons(iv, [a], lead_seconds=60)
    # Falls back to the event text that opened the interval.
    assert next(i for i in iv if i["state"] == re_.STOP)["reason"] == "Machine Stopped"


def test_most_severe_overlapping_alarm_wins():
    iv = re_.build_intervals([ev(-1, "Machine Started"), ev(6, "Machine Stopped")], T0, T_END, now=FUTURE)
    re_.attribute_reasons(
        iv,
        [alarm(7, "Guard door open", "info"), alarm(8, "Gearbox temperature high", "critical")],
        lead_seconds=60,
    )
    assert next(i for i in iv if i["state"] == re_.STOP)["reason"] == "Gearbox temperature high"


def test_unexplained_downtime_is_bucketed_not_hidden():
    iv = re_.build_intervals([], T0, T_END, now=FUTURE)
    iv = [{"state": re_.STOP, "start": T0, "end": T_END, "seconds": DAY,
           "source_event": None, "reason": None}]
    re_.attribute_reasons(iv, [], lead_seconds=60)
    assert iv[0]["reason"] == re_.NO_REASON


def test_run_intervals_never_get_a_reason():
    iv = re_.build_intervals([ev(-1, "Machine Started")], T0, T_END, now=FUTURE)
    re_.attribute_reasons(iv, [alarm(6, "Something")], lead_seconds=60)
    assert iv[0]["reason"] is None


# --- aggregate --------------------------------------------------------------

def test_aggregate_availability_excludes_unknown_from_denominator():
    """12h unknown + 6h run + 6h stop => 50% of a *measured* 12h, not 25% of 24h."""
    iv = re_.build_intervals([ev(12, "Machine Started"), ev(18, "Machine Stopped")], T0, T_END, now=FUTURE)
    agg = re_.aggregate(iv, DAY)
    assert agg["unknown_s"] == 12 * 3600
    assert agg["measured_s"] == 12 * 3600
    assert agg["availability"] == pytest.approx(0.5)
    assert agg["coverage"] == pytest.approx(0.5)


def test_aggregate_idle_and_planned_down_count_as_downtime():
    events = [ev(-1, "Machine Started"), ev(6, "Idle"), ev(12, "Changeover"), ev(18, "Machine Started")]
    agg = re_.aggregate(re_.build_intervals(events, T0, T_END, now=FUTURE), DAY)
    assert agg["idle_s"] == 6 * 3600
    assert agg["planned_down_s"] == 6 * 3600
    assert agg["downtime_s"] == 12 * 3600
    assert agg["availability"] == pytest.approx(0.5)


def test_aggregate_oee_equals_availability_and_flags_the_mode():
    """No count data exists, so OEE must carry its caveat through the API."""
    agg = re_.aggregate(re_.build_intervals([ev(-1, "Machine Started")], T0, T_END, now=FUTURE), DAY)
    assert agg["oee"] == agg["availability"] == 1.0
    assert agg["oee_mode"] == "availability_only"


def test_aggregate_zero_stops_yields_none_not_division_error():
    agg = re_.aggregate(re_.build_intervals([ev(-1, "Machine Started")], T0, T_END, now=FUTURE), DAY)
    assert agg["stop_count"] == 0
    assert agg["mtbf_s"] is None
    assert agg["mttr_s"] is None


def test_aggregate_all_unknown_yields_none_availability():
    """Nothing observed must read as 'unknown', never as 0% availability."""
    agg = re_.aggregate(re_.build_intervals([], T0, T_END, now=FUTURE), DAY)
    assert agg["availability"] is None
    assert agg["coverage"] == 0.0


def test_mtbf_and_mttr_definitions():
    # 3 stops of 2h each inside 24h => downtime 6h, runtime 18h.
    events = [ev(-1, "Machine Started")]
    for h in (4, 10, 16):
        events += [ev(h, "Machine Stopped"), ev(h + 2, "Machine Started")]
    agg = re_.aggregate(re_.build_intervals(events, T0, T_END, now=FUTURE), DAY)
    assert agg["stop_count"] == 3
    assert agg["mttr_s"] == pytest.approx(2 * 3600)
    assert agg["mtbf_s"] == pytest.approx(18 * 3600 / 3)


# --- pareto / totals --------------------------------------------------------

def test_pareto_ranks_by_duration_and_reaches_100_percent():
    machines = [{"intervals": [
        {"state": re_.STOP, "seconds": 3600, "reason": "Jam"},
        {"state": re_.STOP, "seconds": 7200, "reason": "Overload"},
        {"state": re_.IDLE, "seconds": 1800, "reason": "Jam"},
        {"state": re_.RUN, "seconds": 9999, "reason": None},
    ]}]
    pareto = re_.downtime_pareto(machines, top_n=10)
    assert [b["reason"] for b in pareto] == ["Overload", "Jam"]
    assert pareto[0]["seconds"] == 7200
    assert pareto[1]["seconds"] == 5400
    assert pareto[1]["count"] == 2
    assert pareto[-1]["cumulative_pct"] == pytest.approx(100.0)


def test_pareto_collapses_tail_into_other():
    machines = [{"intervals": [
        {"state": re_.STOP, "seconds": 100 - i, "reason": f"R{i}"} for i in range(6)
    ]}]
    pareto = re_.downtime_pareto(machines, top_n=3)
    assert len(pareto) == 4
    assert pareto[-1]["reason"] == "Other"
    assert pareto[-1]["count"] == 3
    assert pareto[-1]["cumulative_pct"] == pytest.approx(100.0)


def test_totals_recompute_from_seconds_not_average_of_percentages():
    """A busy machine and an idle one must not be weighted equally."""
    machines = [
        {"run_s": 90.0, "stop_s": 10.0, "idle_s": 0.0, "planned_down_s": 0.0,
         "unknown_s": 0.0, "downtime_s": 10.0, "measured_s": 100.0, "stop_count": 1},
        {"run_s": 0.0, "stop_s": 900.0, "idle_s": 0.0, "planned_down_s": 0.0,
         "unknown_s": 0.0, "downtime_s": 900.0, "measured_s": 900.0, "stop_count": 1},
    ]
    totals = re_.totals_across(machines, 1000.0)
    # Mean of percentages would be 45%; the truthful line figure is 9%.
    assert totals["availability"] == pytest.approx(0.09)
    assert totals["machine_count"] == 2
