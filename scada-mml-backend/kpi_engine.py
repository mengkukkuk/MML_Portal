"""Pure loss accounting behind the Live management blocks.

The Loss meter, the Andon board and the Loss waterfall are three readings of one
calculation, and that calculation lives here — no database, no FastAPI — so its
rules are pinned down by tests rather than by whatever a chart happened to draw.

## Input: per-family minute buckets

`db.kpi_minute_buckets` reduces a plant table to one row per machine family per
minute. A bucket holds only facts that do not depend on the target:

    minute     aware datetime, start of the minute
    valid_s    seconds covered by a valid sample (speed within [0, valid_max])
    stop_s     of those, seconds at or below stop_threshold
    gap_s      seconds nothing valid covered (missing rows, glitch values)
    speed_sum  Σ speed over valid, running samples
    speed_n    how many samples that sum spans
    pieces     Σ speed × covered_s / 60  (speed is pieces per minute)
    defects    Σ defect rates × covered_s / 60

Keeping the target out of the bucket is what lets the cache survive a changed
target, a changed run ratio and the hourly auto-target refresh.

## Output: states, spans and losses

Each minute is No data, Stop, Run or Slow. Consecutive Stop minutes form a stop
span. Whether a span costs money depends on how long it is and on the block's
working hours — see `account_losses`. Potential output is *derived*
(`pieces + stop_loss + slow_loss`), so the waterfall balances by construction.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Any, Iterable

RUN, SLOW, STOP, NODATA, OFF = "run", "slow", "stop", "nodata", "off"

# Half a minute is the deciding share: a minute mostly without data is No data,
# a minute mostly stopped is Stop. Anything finer than this the minute grid
# cannot see — which is why min_stop_sec defaults to a whole minute.
HALF_MINUTE = 30

# p95 of running speed needs enough running minutes to mean anything; fewer
# than an hour's worth and the target is reported as unknown instead.
MIN_TARGET_MINUTES = 60

DEFAULT_SETTINGS: dict[str, Any] = {
    "run_ratio": 0.8,
    "min_stop_sec": 60,
    "max_loss_stop_min": 120,
    "working_hours": None,
}

BAHT_KEYS = ("baht", "cost_per_piece")


def _num(value: Any) -> float:
    return float(value) if value is not None else 0.0


def empty_bucket(minute: datetime) -> dict[str, Any]:
    """A minute nothing was logged in: all of it is gap."""
    return {
        "minute": minute, "valid_s": 0.0, "stop_s": 0.0, "gap_s": 60.0,
        "speed_sum": 0.0, "speed_n": 0, "pieces": 0.0, "defects": 0.0,
    }


def minute_grid(buckets: Iterable[dict[str, Any]], start: datetime, end: datetime) -> list[dict[str, Any]]:
    """One bucket per minute in [start, end), missing minutes filled as gap.

    `start` and `end` must be whole minutes. A table that only logs while the
    line runs leaves holes; those holes are No data, never Stop.
    """
    by_minute = {b["minute"]: b for b in buckets}
    out = []
    t = start
    while t < end:
        out.append(by_minute.get(t) or empty_bucket(t))
        t += timedelta(minutes=1)
    return out


def mean_speed(bucket: dict[str, Any]) -> float | None:
    n = bucket.get("speed_n") or 0
    return _num(bucket.get("speed_sum")) / n if n else None


def classify_minutes(buckets: list[dict[str, Any]], target: float | None, run_ratio: float) -> list[str]:
    """Run / Slow / Stop / No data per minute, in that order of precedence.

    Without a target there is nothing to be slow against, so any running minute
    is Run.
    """
    states = []
    for b in buckets:
        if _num(b.get("gap_s")) >= HALF_MINUTE:
            states.append(NODATA)
        elif _num(b.get("stop_s")) >= HALF_MINUTE:
            states.append(STOP)
        else:
            speed = mean_speed(b)
            if speed is None:
                states.append(STOP)
            elif target is None or speed >= run_ratio * target:
                states.append(RUN)
            else:
                states.append(SLOW)
    return states


def _runs(states: list[str]) -> list[tuple[str, int, int]]:
    """(state, first index, last index) for each run of equal states."""
    out: list[tuple[str, int, int]] = []
    for i, s in enumerate(states):
        if out and out[-1][0] == s:
            out[-1] = (s, out[-1][1], i)
        else:
            out.append((s, i, i))
    return out


def merge_short_stops(
    states: list[str], min_stop_sec: int, buckets: list[dict[str, Any]] | None = None,
) -> list[str]:
    """Stops shorter than `min_stop_sec` take the state around them.

    A stop's length is its stopped *seconds* when `buckets` are given: a 40 s
    dip fills one Stop minute, and judging it as 60 s would keep it.

    A brief dip is the machine running, not the machine stopping — counting it
    would make the Andon board flicker and charge a stop for a hiccup. The dip
    becomes whatever ran before it (or after it, at the very start); a dip
    between two No data stretches stays a stop, since there is nothing running
    to absorb it into.
    """
    out = list(states)
    runs = _runs(states)
    for k, (state, lo, hi) in enumerate(runs):
        if buckets is not None:
            length = sum(_num(buckets[i].get("stop_s")) for i in range(lo, hi + 1))
        else:
            length = (hi - lo + 1) * 60
        if state != STOP or length >= min_stop_sec:
            continue
        before = runs[k - 1][0] if k > 0 else None
        after = runs[k + 1][0] if k + 1 < len(runs) else None
        fill = next((s for s in (before, after) if s in (RUN, SLOW)), None)
        if fill:
            out[lo:hi + 1] = [fill] * (hi - lo + 1)
    return out


def stop_spans(states: list[str], live: bool) -> list[dict[str, Any]]:
    """Each run of Stop minutes, and whether it is still going.

    `open` only when the span reaches the last minute of a live period: a stop
    that ended — or one in yesterday's comparison window — has a final length.
    """
    spans = []
    for state, lo, hi in _runs(states):
        if state == STOP:
            spans.append({"lo": lo, "hi": hi, "minutes": hi - lo + 1, "open": live and hi == len(states) - 1})
    return spans


def _parse_clock(value: str) -> time:
    hh, mm = value.split(":")
    return time(int(hh), int(mm))


def in_working_hours(minute: datetime, hours: dict[str, Any] | None) -> bool:
    """Whether `minute` (plant-local) falls inside the block's working hours.

    `days` are ISO weekdays (1 = Monday). An end before the start is an
    overnight window: 22:00–06:00 covers Monday 23:00 and Tuesday 02:00, both
    counted against the day the window *opened*.
    """
    if not hours:
        return False
    start, end = _parse_clock(hours["start"]), _parse_clock(hours["end"])
    days = set(hours.get("days") or range(1, 8))
    clock = minute.timetz().replace(tzinfo=None)
    if start <= end:
        return start <= clock < end and minute.isoweekday() in days
    if clock >= start:
        return minute.isoweekday() in days
    if clock < end:
        return (minute - timedelta(days=1)).isoweekday() in days
    return False


def account_losses(
    buckets: list[dict[str, Any]],
    states: list[str],
    target: float | None,
    settings: dict[str, Any],
    live: bool,
    lo: int = 0,
    hi: int | None = None,
) -> dict[str, Any]:
    """Pieces, defects and the losses behind them, for one family.

    `buckets`/`states` may reach beyond the accounted window `[lo, hi)`: a
    stop's length is judged on the whole span, so a night stop that began at
    17:30 is still a 13-hour stop when the window starts at midnight — not a
    one-minute stop that costs a minute of output.

    A stop minute is one of three things:

    * **loss** — the span is no longer than `max_loss_stop_min`, or the minute
      lies inside `working_hours` (where every stop counts, however long);
    * **pending** — the span is still open and has not yet passed the cutoff, so
      it may yet turn out to be the end of the day;
    * **off** (not scheduled) — the span passed the cutoff outside working hours.

    A minute's loss is the target output it would have made minus what it did
    make, never below zero. Slow minutes lose the same shortfall. No data
    minutes lose nothing: not knowing is not the same as stopping.
    """
    s = {**DEFAULT_SETTINGS, **(settings or {})}
    cutoff = int(s["max_loss_stop_min"])
    hours = s.get("working_hours")
    hi = len(states) if hi is None else hi
    marks = list(states)
    minute_loss = [0.0] * len(states)
    stop_loss = slow_loss = pending = 0.0
    loss_min = pending_min = off_min = 0

    def shortfall(b: dict[str, Any]) -> float:
        if target is None:
            return 0.0
        return max(0.0, target * _num(b.get("valid_s")) / 60 - _num(b.get("pieces")))

    for span in stop_spans(states, live):
        for i in range(max(lo, span["lo"]), min(hi - 1, span["hi"]) + 1):
            b = buckets[i]
            if in_working_hours(b["minute"], hours) or span["minutes"] <= cutoff and not span["open"]:
                minute_loss[i] = shortfall(b)
                stop_loss += minute_loss[i]
                loss_min += 1
            elif span["open"] and span["minutes"] <= cutoff:
                pending += shortfall(b)
                pending_min += 1
            else:
                marks[i] = OFF
                off_min += 1

    run_min = slow_min = nodata_min = 0
    pieces = defects = 0.0
    for i in range(lo, hi):
        b, state = buckets[i], states[i]
        pieces += _num(b.get("pieces"))
        defects += _num(b.get("defects"))
        if state == SLOW:
            minute_loss[i] = shortfall(b)
            slow_loss += minute_loss[i]
            slow_min += 1
        elif state == RUN:
            run_min += 1
        elif state == NODATA:
            nodata_min += 1

    scheduled = run_min + slow_min + loss_min + pending_min
    return {
        "pieces": pieces,
        "defects": defects,
        "good": max(0.0, pieces - defects),
        "stop_loss": stop_loss,
        "slow_loss": slow_loss,
        "pending": pending,
        "potential": pieces + stop_loss + slow_loss,
        "minutes": {
            RUN: run_min, SLOW: slow_min, STOP: loss_min + pending_min,
            OFF: off_min, NODATA: nodata_min,
        },
        "run_pct": round(100 * (run_min + slow_min) / scheduled) if scheduled else None,
        "marks": marks[lo:hi],
        # counted loss per minute (stops within the cutoff, slow shortfall) —
        # what the plan-pace timeline adds to pieces to draw "could have made"
        "minute_loss": minute_loss[lo:hi],
    }


def p95_target(buckets: Iterable[dict[str, Any]]) -> float | None:
    """The auto target: the 95th percentile of mean speed over running minutes.

    Only minutes that were clearly running count — a stop or a gap would drag
    the "should make" figure down towards whatever the line achieved on its
    worst day.
    """
    speeds = sorted(
        sp for b in buckets
        if _num(b.get("gap_s")) < HALF_MINUTE and _num(b.get("stop_s")) < HALF_MINUTE
        and (sp := mean_speed(b)) is not None and sp > 0
    )
    if len(speeds) < MIN_TARGET_MINUTES:
        return None
    rank = 0.95 * (len(speeds) - 1)
    lo = int(rank)
    hi = min(lo + 1, len(speeds) - 1)
    return speeds[lo] + (speeds[hi] - speeds[lo]) * (rank - lo)


def current_state(states: list[str], buckets: list[dict[str, Any]]) -> tuple[str | None, datetime | None]:
    """The latest minute's state, and when that state began."""
    if not states:
        return None, None
    last = states[-1]
    i = len(states) - 1
    while i > 0 and states[i - 1] == last:
        i -= 1
    return last, buckets[i]["minute"]


def strip(marks: list[str], buckets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merged state spans for the Andon board's colour strip.

    Uses the accounted marks, so a stop past the cutoff draws as Off (an idle
    night) rather than as red.
    """
    out = []
    for state, lo, hi in _runs(marks):
        out.append({
            "start": buckets[lo]["minute"],
            "end": buckets[hi]["minute"] + timedelta(minutes=1),
            "state": state,
        })
    return out


# --- periods ----------------------------------------------------------------

PERIODS = ("today", "week", "month")


def _floor_minute(t: datetime) -> datetime:
    return t.replace(second=0, microsecond=0)


def period_bounds(period: str, now: datetime) -> tuple[datetime, datetime, datetime]:
    """(start, previous start, end) for a calendar period, plant-local.

    `end` is the current minute's start: the open minute is never accounted,
    since it is still being written.
    """
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "today":
        start = midnight
        prev = start - timedelta(days=1)
    elif period == "week":
        start = midnight - timedelta(days=now.isoweekday() - 1)
        prev = start - timedelta(days=7)
    elif period == "month":
        start = midnight.replace(day=1)
        prev = (start - timedelta(days=1)).replace(day=1)
    else:
        raise ValueError(f"unknown period {period!r}")
    return start, prev, _floor_minute(now)


def family_summary(
    buckets: list[dict[str, Any]],
    target: float | None,
    settings: dict[str, Any],
    start: datetime,
    end: datetime,
    live: bool,
    context: tuple[datetime, datetime] | None = None,
) -> dict[str, Any]:
    """Classify one family's minutes and account those in [start, end).

    `context` widens what is *classified* (not what is counted) so a stop
    straddling the window keeps its true length — pass the window padded by
    `context_pad(settings)` on each side, clipped to the data available. `live`
    means the context ends now, so a stop reaching its end is still open.
    """
    s = {**DEFAULT_SETTINGS, **(settings or {})}
    ctx_start, ctx_end = context or (start, end)
    ctx_start, ctx_end = min(ctx_start, start), max(ctx_end, end)
    grid = minute_grid(buckets, ctx_start, ctx_end)
    states = merge_short_stops(classify_minutes(grid, target, float(s["run_ratio"])), int(s["min_stop_sec"]), grid)
    lo = int((start - ctx_start).total_seconds() // 60)
    hi = lo + int((end - start).total_seconds() // 60)
    acc = account_losses(grid, states, target, s, live, lo, hi)
    acc["states"] = states[lo:hi]
    acc["grid"] = grid[lo:hi]
    return acc


def context_pad(settings: dict[str, Any]) -> timedelta:
    """How far either side of a window a stop's length must be looked for.

    One minute past the cutoff is enough to know a span is longer than it.
    """
    s = {**DEFAULT_SETTINGS, **(settings or {})}
    return timedelta(minutes=int(s["max_loss_stop_min"]) + 1)


def strip_cost(value: Any) -> Any:
    """`value` with every ฿ figure and the price removed, at any depth.

    Applied server-side for roles that may not see cost: hiding it in the
    browser would still ship it in the response.
    """
    if isinstance(value, dict):
        return {k: strip_cost(v) for k, v in value.items() if k not in BAHT_KEYS}
    if isinstance(value, list):
        return [strip_cost(v) for v in value]
    return value


# --- one line ------------------------------------------------------------------

def line_buckets(line_series: list[dict[str, Any]], all_series: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """The line as one machine: the pace-setting family's speed, every camera's defects.

    Line 13 makes its pieces through one line; the cameras along it inspect
    them. So output, run and stop come from one family's speed (`line_series`)
    while a reject caught by any camera is a reject of the line. A minute with
    defects but no line sample is still a gap — its defects count, its state is
    No data.
    """
    by_minute = {b["minute"]: {**b, "defects": 0.0} for b in line_series}
    for series in all_series:
        for b in series:
            row = by_minute.get(b["minute"])
            if row is None:
                row = by_minute[b["minute"]] = {**empty_bucket(b["minute"]), "defects": 0.0}
            row["defects"] += _num(b.get("defects"))
    return [by_minute[m] for m in sorted(by_minute)]


# --- timeline -------------------------------------------------------------------

STATE_RANK = {STOP: 0, NODATA: 1, SLOW: 2, RUN: 3, OFF: 4}


def timeline(grid: list[dict[str, Any]], marks: list[str], minute_loss: list[float], size: int) -> list[dict[str, Any]]:
    """Per-`size`-minute rows for the plan-pace and hourly blocks.

    Each row: start, pieces, defects, good, potential (pieces + counted loss —
    the "could have made" curve) and the state that held for most of it, ties
    going to the worse one so a short stop inside a bucket still shows.
    """
    out = []
    for k in range(0, len(grid), size):
        part = range(k, min(k + size, len(grid)))
        pieces = sum(_num(grid[i].get("pieces")) for i in part)
        defects = sum(_num(grid[i].get("defects")) for i in part)
        counts: dict[str, int] = {}
        for i in part:
            counts[marks[i]] = counts.get(marks[i], 0) + 1
        state = max(counts, key=lambda st: (counts[st], -STATE_RANK.get(st, 9)))
        out.append({
            "start": grid[k]["minute"],
            "minutes": len(part),
            "pieces": pieces,
            "defects": defects,
            # not clamped per row: a reject caught while the line stood still
            # still comes off the day's good total, and the cumulative curve
            # must land on that total
            "good": pieces - defects,
            "potential": pieces + sum(minute_loss[i] for i in part),
            "state": state,
        })
    return out


# --- sensors --------------------------------------------------------------------

OK, OUT, FLAT, MISSING = "ok", "out", "flat", "missing"


def sensor_states(grid: list[dict[str, Any]], flat_min: int) -> list[str]:
    """ok / out / flat / missing per minute for one sensor.

    * missing — under half the minute covered by a reading;
    * out — half the minute or more outside its own low..high (slots 3..4);
    * flat — part of a run of at least `flat_min` minutes in which the value
      never moved. A sensor reading 0 against a setpoint of 500 is "in band"
      when the band is wide; it is not telling the truth either way. A frozen
      reading outranks out-of-band: an out-of-band value that never moves is
      most likely a dead sensor, not a hot machine.
    """
    states = []
    for b in grid:
        if _num(b.get("valid_s")) < HALF_MINUTE:
            states.append(MISSING)
        elif _num(b.get("out_s")) >= HALF_MINUTE:
            states.append(OUT)
        else:
            states.append(OK)
    def steady(k: int) -> bool:
        g = grid[k]
        return states[k] != MISSING and g.get("vmin") is not None and g.get("vmin") == g.get("vmax")

    i, n = 0, len(grid)
    while i < n:
        if not steady(i):
            i += 1
            continue
        j = i
        while j + 1 < n and steady(j + 1) and grid[j + 1]["vmin"] == grid[i]["vmin"]:
            j += 1
        if j - i + 1 >= flat_min:
            states[i:j + 1] = [FLAT] * (j - i + 1)
        i = j + 1
    return states


def incidents(states: list[str], grid: list[dict[str, Any]], line_grid: list[dict[str, Any]],
              merge_min: int = 3, live: bool = False) -> list[dict[str, Any]]:
    """Out-of-band spans of one sensor, gaps of up to `merge_min` minutes joined.

    `risk_pieces` is what the line made while it lasted — the pieces to hold for
    inspection. A span reaching the last minute of a live window is still open.
    """
    runs: list[list[int]] = []
    for i, st in enumerate(states):
        if st != OUT:
            continue
        if runs and i - runs[-1][1] <= merge_min:
            runs[-1][1] = i
        else:
            runs.append([i, i])
    out = []
    for lo, hi in runs:
        out.append({
            "start": grid[lo]["minute"],
            "end": grid[hi]["minute"] + timedelta(minutes=1),
            "minutes": hi - lo + 1,
            "risk_pieces": sum(_num(line_grid[i].get("pieces")) for i in range(lo, hi + 1)),
            "open": live and hi == len(states) - 1,
        })
    return out
