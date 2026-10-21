"""The loss rules behind the management blocks (kpi_engine.py).

Every number the Loss meter, Andon board and waterfall show comes from these
functions, so each agreed rule has a case here: the half-minute classification,
short dips, the 120-minute cutoff, pending stops, working hours, and the
waterfall balancing exactly.
"""
from datetime import datetime, timedelta, timezone

import pytest

import kpi_engine as k

TZ = timezone(timedelta(hours=7))
T0 = datetime(2026, 10, 20, 8, 0, tzinfo=TZ)
TARGET = 100.0  # pieces per minute


def b(i, speed=100.0, *, stop_s=0.0, gap_s=0.0, defects=0.0, start=T0):
    """A minute at `speed` pieces/min; stopped or gapped seconds produce nothing."""
    valid = 60.0 - gap_s
    running = valid - stop_s
    return {
        "minute": start + timedelta(minutes=i),
        "valid_s": valid,
        "stop_s": stop_s,
        "gap_s": gap_s,
        "speed_sum": speed * 6 if running > 0 else 0.0,
        "speed_n": 6 if running > 0 else 0,
        "pieces": speed * running / 60,
        "defects": defects,
    }


def stopped(i, start=T0):
    return b(i, 0, stop_s=60, start=start)


def run(buckets, *, live=False, target=TARGET, **settings):
    start = buckets[0]["minute"]
    end = buckets[-1]["minute"] + timedelta(minutes=1)
    return k.family_summary(buckets, target, settings, start, end, live)


# --- classification ---------------------------------------------------------

def test_classification_precedence_and_half_minute_rule():
    buckets = [
        b(0, gap_s=30),             # half the minute missing -> No data
        b(1, gap_s=29, stop_s=31),  # data present, mostly stopped -> Stop
        b(2, 80),                   # exactly run_ratio * target -> Run
        b(3, 79.9),                 # just under -> Slow
        b(4, 120),
    ]
    states = k.classify_minutes(buckets, TARGET, 0.8)
    assert states == [k.NODATA, k.STOP, k.RUN, k.SLOW, k.RUN]


def test_without_a_target_running_is_run():
    assert k.classify_minutes([b(0, 5)], None, 0.8) == [k.RUN]


def test_short_dip_stays_run_but_a_real_stop_is_a_stop():
    states = [k.RUN, k.STOP, k.RUN, k.RUN, k.STOP, k.STOP, k.RUN]
    assert k.merge_short_stops(states, 90) == [k.RUN, k.RUN, k.RUN, k.RUN, k.STOP, k.STOP, k.RUN]
    assert k.merge_short_stops(states, 60) == states


def test_dip_between_no_data_stays_a_stop():
    states = [k.NODATA, k.STOP, k.NODATA]
    assert k.merge_short_stops(states, 120) == states


def test_missing_minutes_are_no_data_not_stops():
    grid = k.minute_grid([b(0), b(3)], T0, T0 + timedelta(minutes=4))
    assert k.classify_minutes(grid, TARGET, 0.8) == [k.RUN, k.NODATA, k.NODATA, k.RUN]


# --- stop accounting --------------------------------------------------------

def test_lunch_stop_under_cutoff_is_loss():
    buckets = [b(0)] + [stopped(i) for i in range(1, 55)] + [b(55)]
    acc = run(buckets)
    assert acc["minutes"][k.STOP] == 54
    assert acc["stop_loss"] == pytest.approx(54 * TARGET)
    assert acc["pending"] == 0


def test_night_stop_past_cutoff_is_not_scheduled():
    buckets = [b(0)] + [stopped(i) for i in range(1, 16 * 60)] + [b(16 * 60)]
    acc = run(buckets)
    assert acc["stop_loss"] == 0
    assert acc["minutes"][k.OFF] == 16 * 60 - 1
    assert set(acc["marks"][1:-1]) == {k.OFF}


def test_open_stop_under_cutoff_is_pending():
    buckets = [b(0)] + [stopped(i) for i in range(1, 21)]
    acc = run(buckets, live=True)
    assert acc["pending"] == pytest.approx(20 * TARGET)
    assert acc["stop_loss"] == 0


def test_open_stop_past_cutoff_drops_pending_and_turns_off():
    buckets = [b(0)] + [stopped(i) for i in range(1, 122)]
    acc = run(buckets, live=True)
    assert acc["pending"] == 0
    assert acc["stop_loss"] == 0
    assert acc["minutes"][k.OFF] == 121


def test_a_stop_is_judged_on_its_whole_length_not_the_window():
    # stopped since 17:30 yesterday; the window is just after midnight
    evening = datetime(2026, 10, 21, 17, 30, tzinfo=TZ)
    midnight = datetime(2026, 10, 22, 0, 0, tzinfo=TZ)
    buckets = [stopped(i, start=evening) for i in range(6 * 60 + 31 + 2)]
    pad = k.context_pad({})
    acc = k.family_summary(buckets, TARGET, {}, midnight, midnight + timedelta(minutes=1), True,
                           (midnight - pad, midnight + timedelta(minutes=1)))
    assert acc["stop_loss"] == acc["pending"] == 0
    assert acc["minutes"][k.OFF] == 1
    # without the context the same minute looks like a fresh, pending stop
    naive = k.family_summary(buckets, TARGET, {}, midnight, midnight + timedelta(minutes=1), True)
    assert naive["pending"] > 0


def test_a_comparison_window_sees_the_stop_continue_past_it():
    # yesterday 07:00-07:01 compared, while that stop ran on for 3 hours
    seven = datetime(2026, 10, 21, 7, 0, tzinfo=TZ)
    buckets = [stopped(i, start=seven) for i in range(180)]
    pad = k.context_pad({})
    acc = k.family_summary(buckets, TARGET, {}, seven, seven + timedelta(minutes=1), False,
                           (seven - pad, seven + timedelta(minutes=1) + pad))
    assert acc["stop_loss"] == 0 and acc["minutes"][k.OFF] == 1


def test_working_hours_make_a_long_breakdown_loss():
    # 09:00-12:00 breakdown inside 07:00-17:00 working hours
    start = T0 + timedelta(hours=1)
    buckets = [stopped(i, start=start) for i in range(180)]
    hours = {"start": "07:00", "end": "17:00", "days": [1, 2, 3, 4, 5, 6]}
    acc = run(buckets, working_hours=hours)
    assert acc["stop_loss"] == pytest.approx(180 * TARGET)
    assert acc["minutes"][k.OFF] == 0
    # without hours the same breakdown passes the cutoff and is not counted
    assert run(buckets)["stop_loss"] == 0


def test_working_hours_overnight_and_weekdays():
    hours = {"start": "22:00", "end": "06:00", "days": [1]}  # Monday night only
    monday_23 = datetime(2026, 10, 19, 23, 0, tzinfo=TZ)
    assert k.in_working_hours(monday_23, hours)
    assert k.in_working_hours(monday_23 + timedelta(hours=4), hours)  # Tue 03:00
    assert not k.in_working_hours(monday_23 + timedelta(days=1), hours)  # Tue 23:00
    assert not k.in_working_hours(monday_23.replace(hour=12), hours)


# --- slow, defects, balance -------------------------------------------------

def test_slow_minutes_lose_the_shortfall():
    acc = run([b(0, 50), b(1, 100)])
    assert acc["slow_loss"] == pytest.approx(50)
    assert acc["minutes"][k.SLOW] == 1


def test_no_data_minutes_lose_nothing():
    acc = run([b(0), b(1, gap_s=60), b(2)])
    assert acc["stop_loss"] == acc["slow_loss"] == 0
    assert acc["minutes"][k.NODATA] == 1


def test_waterfall_balances_exactly():
    buckets = (
        [b(i, defects=2) for i in range(30)]
        + [stopped(i) for i in range(30, 40)]
        + [b(i, 60, defects=1) for i in range(40, 70)]
        + [b(70, gap_s=60)]
    )
    acc = run(buckets)
    assert acc["potential"] - acc["stop_loss"] - acc["slow_loss"] - acc["defects"] == pytest.approx(acc["good"])
    assert acc["defects"] == pytest.approx(90)


def test_run_pct_excludes_off_and_no_data():
    buckets = [b(0), b(1), stopped(2), b(3, gap_s=60)]
    assert run(buckets)["run_pct"] == round(100 * 2 / 3)


# --- target -----------------------------------------------------------------

def test_p95_ignores_stops_and_gaps():
    buckets = [b(i, 50 + i) for i in range(100)] + [stopped(100 + i) for i in range(50)]
    buckets += [b(200 + i, gap_s=60) for i in range(20)]
    target = k.p95_target(buckets)
    assert target == pytest.approx(50 + 0.95 * 99)


def test_p95_needs_an_hour_of_running():
    assert k.p95_target([b(i) for i in range(59)]) is None


# --- periods, current state, cost stripping ---------------------------------

def test_period_bounds():
    now = datetime(2026, 10, 21, 14, 30, 42, tzinfo=TZ)  # Wednesday
    start, prev, end = k.period_bounds("today", now)
    assert (start.day, prev.day, end) == (21, 20, now.replace(second=0))
    start, prev, _ = k.period_bounds("week", now)
    assert (start.day, prev.day) == (19, 12)
    start, prev, _ = k.period_bounds("month", now)
    assert (start.day, start.month, prev.month) == (1, 10, 9)


def test_current_state_and_since():
    buckets = [b(0), stopped(1), stopped(2)]
    state, since = k.current_state([k.RUN, k.STOP, k.STOP], buckets)
    assert state == k.STOP and since == buckets[1]["minute"]


def test_strip_merges_marks():
    buckets = [b(0), b(1), stopped(2)]
    spans = k.strip([k.RUN, k.RUN, k.STOP], buckets)
    assert [s["state"] for s in spans] == [k.RUN, k.STOP]
    assert spans[0]["end"] == buckets[2]["minute"]


def test_strip_cost_removes_every_baht_figure():
    payload = {
        "totals": {"lost": 5, "baht": {"lost": 60}},
        "families": [{"key": "A", "baht": {"defects": 1}}],
        "settings": {"cost_per_piece": 12, "run_ratio": 0.8},
    }
    assert k.strip_cost(payload) == {
        "totals": {"lost": 5},
        "families": [{"key": "A"}],
        "settings": {"run_ratio": 0.8},
    }


def test_a_40_second_dip_is_not_a_stop_even_though_it_fills_a_minute():
    buckets = [b(0), b(1, 33, stop_s=40), b(2)]
    acc = run(buckets)
    assert acc["minutes"][k.STOP] == 0 and acc["stop_loss"] == 0
    # a full stopped minute is a real one-minute stop
    assert run([b(0), stopped(1), b(2)])["minutes"][k.STOP] == 1
