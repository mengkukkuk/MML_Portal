"""Pure OEE/MES report math — turns raw event rows into machine state intervals.

Deliberately free of any database access so every edge case can be unit-tested
against hand-built event lists (see tests/test_report_engine.py). ``reports.py``
owns the SQL; this module owns the arithmetic the business will act on.

The model, in one paragraph: ``public.event_logs`` records discrete state
*transitions*, not durations. To measure how long a machine ran we pair each
event with the next one and clamp the result to the report window. An event
that lands before the window ("carry-in") tells us the state the machine was
already in when the window opened — without it, a machine that ran all week
with no logged events inside a one-day window would report zero runtime.

Timestamps are treated as naive/server-local throughout (see plan): the plant,
the database and the API all share a clock, so no timezone conversion happens
anywhere in this module.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Iterable

# --- States -----------------------------------------------------------------
RUN = "RUN"
STOP = "STOP"
IDLE = "IDLE"
PLANNED_DOWN = "PLANNED_DOWN"
UNKNOWN = "UNKNOWN"

#: Substring matching runs in this order so the most specific vocabulary wins.
#: Without it "restart after maintenance" would match RUN's "start" before
#: PLANNED_DOWN's "maintenance" and silently count a changeover as production.
MATCH_PRIORITY = (PLANNED_DOWN, IDLE, STOP, RUN)

#: Every state except RUN counts against availability. UNKNOWN is special-cased:
#: it is excluded from the denominator entirely rather than counted as downtime.
DOWN_STATES = (STOP, IDLE, PLANNED_DOWN)

DEFAULT_STATE_RULES: dict[str, list[str]] = {
    PLANNED_DOWN: ["changeover", "maintenance", "cleaning", "setup", "break"],
    IDLE: ["idle", "standby", "wait"],
    STOP: ["stop", "fault", "trip", "fail", "emergency", "alarm"],
    RUN: ["start", "running", "run", "auto"],
}

NO_REASON = "No reason logged"

#: Highest first — an interval overlapped by several alarms is attributed to the
#: most serious one, since that is what an engineer would call the cause.
_SEVERITY_RANK = {"critical": 3, "warning": 2, "info": 1}


def classify(event: str | None, rules: dict[str, list[str]] | None = None) -> str | None:
    """Map a raw event string to a state, or None when nothing matches.

    Exact (case-insensitive) matches win over substring matches everywhere, so a
    plant can pin an ambiguous phrase to one state by listing it verbatim.
    Returning None rather than UNKNOWN is intentional: an unrecognised event
    means "no information", so the caller keeps the previous state instead of
    punching a hole in the timeline.
    """
    if not event:
        return None
    rules = rules or DEFAULT_STATE_RULES
    text = event.strip().lower()

    for state in MATCH_PRIORITY:
        for pattern in rules.get(state, ()):
            if text == pattern.strip().lower():
                return state

    for state in MATCH_PRIORITY:
        for pattern in rules.get(state, ()):
            p = pattern.strip().lower()
            if p and p in text:
                return state
    return None


def build_intervals(
    events: Iterable[dict[str, Any]],
    start: datetime,
    end: datetime,
    rules: dict[str, list[str]] | None = None,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Expand transition events into contiguous, non-overlapping intervals.

    ``events`` are rows of {location, tag_name, event, at_date_time} for a single
    machine, in any order (they are sorted defensively — a log written by
    multiple PLCs is not guaranteed monotonic).

    The returned intervals always tile ``[start, effective_end]`` exactly with no
    gaps and no overlaps, which is what makes the
    ``sum(all state seconds) == window seconds`` invariant hold. That invariant
    is the cheapest possible smoke test for this whole feature.

    ``effective_end`` is ``min(end, now)`` so an in-progress report never claims
    the machine was in some state during the future.
    """
    rules = rules or DEFAULT_STATE_RULES
    now = now or datetime.now()
    effective_end = min(end, now)
    if effective_end <= start:
        return []

    rows = sorted(events, key=lambda r: r["at_date_time"])

    # Carry-in: the newest event strictly before the window defines the state the
    # machine is already in at `start`. Anything older is superseded.
    carry_state: str | None = None
    carry_event: str | None = None
    for row in rows:
        if row["at_date_time"] >= start:
            break
        state = classify(row.get("event"), rules)
        if state is not None:
            carry_state = state
            carry_event = row.get("event")

    in_window = [r for r in rows if start <= r["at_date_time"] < effective_end]

    # Each boundary is (timestamp, state, source_event). The first one opens the
    # window using the carried-in state, or UNKNOWN when the machine has no
    # history at all.
    boundaries: list[tuple[datetime, str, str | None]] = [
        (start, carry_state or UNKNOWN, carry_event)
    ]
    current = carry_state or UNKNOWN
    for row in in_window:
        state = classify(row.get("event"), rules)
        if state is None or state == current:
            # Unrecognised, or a repeat of the state we are already in — no new
            # interval, so a chatty PLC re-announcing "Running" costs nothing.
            continue
        current = state
        boundaries.append((row["at_date_time"], state, row.get("event")))

    intervals: list[dict[str, Any]] = []
    for i, (ts, state, source) in enumerate(boundaries):
        stop_ts = boundaries[i + 1][0] if i + 1 < len(boundaries) else effective_end
        seconds = (stop_ts - ts).total_seconds()
        if seconds <= 0:
            # Two events sharing a timestamp — keep the later one, drop the
            # zero-width interval rather than emitting a degenerate band.
            continue
        intervals.append({
            "state": state,
            "start": ts,
            "end": stop_ts,
            "seconds": seconds,
            "source_event": source,
            "reason": None,
        })
    return intervals


def attribute_reasons(
    intervals: list[dict[str, Any]],
    alarms: Iterable[dict[str, Any]],
    lead_seconds: int = 60,
) -> list[dict[str, Any]]:
    """Attach a downtime cause to every non-RUN interval, in place.

    An alarm usually fires slightly *before* the machine actually stops, so the
    match window is widened backwards by ``lead_seconds``. Where several alarms
    overlap, the most severe wins; ties break on the earliest, which is the one
    that started the trouble.

    Intervals with no overlapping alarm fall back to the event text that opened
    them, and finally to ``NO_REASON`` — that bucket is deliberately surfaced in
    the Pareto because it quantifies how much downtime the plant cannot explain.
    """
    alarm_rows = sorted(alarms, key=lambda a: a["at"])
    lead = timedelta(seconds=max(0, lead_seconds))

    for iv in intervals:
        if iv["state"] not in DOWN_STATES:
            continue
        window_start = iv["start"] - lead
        best = None
        best_key = None
        for alarm in alarm_rows:
            at = alarm["at"]
            if at > iv["end"]:
                break  # sorted — nothing later can overlap either
            if at < window_start:
                continue
            key = (_SEVERITY_RANK.get(alarm.get("severity") or "info", 1), -at.timestamp())
            if best_key is None or key > best_key:
                best_key, best = key, alarm
        if best is not None and best.get("text"):
            iv["reason"] = best["text"]
            iv["severity"] = best.get("severity") or "info"
        elif iv.get("source_event"):
            iv["reason"] = iv["source_event"]
        else:
            iv["reason"] = NO_REASON
    return intervals


def aggregate(intervals: list[dict[str, Any]], window_seconds: float) -> dict[str, Any]:
    """Roll intervals up into the KPI numbers shown on the report.

    Availability excludes UNKNOWN time from the denominator rather than guessing
    at it, so a machine with patchy logging shows a *smaller* measured window
    instead of a fabricated score. ``coverage`` reports how much of the window
    was actually observed, which is the number to check before trusting the rest.

    OEE is Availability here: this deployment has no production-count source, so
    Performance and Quality are assumed 100%. ``oee_mode`` carries that caveat
    through the API into the UI and the spreadsheet export.
    """
    totals = {RUN: 0.0, STOP: 0.0, IDLE: 0.0, PLANNED_DOWN: 0.0, UNKNOWN: 0.0}
    for iv in intervals:
        totals[iv["state"]] = totals.get(iv["state"], 0.0) + iv["seconds"]

    downtime = totals[STOP] + totals[IDLE] + totals[PLANNED_DOWN]
    measured = totals[RUN] + downtime
    availability = (totals[RUN] / measured) if measured > 0 else None

    # A "stop" is one transition into a down state. The opening interval counts
    # only if the machine was already down when the window began.
    stop_count = sum(1 for iv in intervals if iv["state"] in DOWN_STATES)

    return {
        "run_s": totals[RUN],
        "stop_s": totals[STOP],
        "idle_s": totals[IDLE],
        "planned_down_s": totals[PLANNED_DOWN],
        "unknown_s": totals[UNKNOWN],
        "downtime_s": downtime,
        "measured_s": measured,
        "window_s": window_seconds,
        "coverage": (measured / window_seconds) if window_seconds > 0 else None,
        "availability": availability,
        "oee": availability,
        "oee_mode": "availability_only",
        "stop_count": stop_count,
        "mtbf_s": (totals[RUN] / stop_count) if stop_count else None,
        "mttr_s": (downtime / stop_count) if stop_count else None,
    }


def downtime_pareto(
    machines: Iterable[dict[str, Any]],
    top_n: int = 10,
    rank_by: str = "duration",
) -> list[dict[str, Any]]:
    """Rank downtime causes across all machines, with a running cumulative %.

    Everything past ``top_n`` collapses into a single "Other" bucket so the
    cumulative line still reaches 100% and the chart never lies about the tail.
    """
    buckets: dict[str, dict[str, Any]] = {}
    for machine in machines:
        for iv in machine.get("intervals", ()):
            if iv["state"] not in DOWN_STATES:
                continue
            reason = iv.get("reason") or NO_REASON
            b = buckets.setdefault(reason, {"reason": reason, "seconds": 0.0, "count": 0})
            b["seconds"] += iv["seconds"]
            b["count"] += 1

    key = (lambda b: b["count"]) if rank_by == "count" else (lambda b: b["seconds"])
    ranked = sorted(buckets.values(), key=key, reverse=True)

    if top_n and len(ranked) > top_n:
        head, tail = ranked[:top_n], ranked[top_n:]
        ranked = head + [{
            "reason": "Other",
            "seconds": sum(b["seconds"] for b in tail),
            "count": sum(b["count"] for b in tail),
        }]

    total = sum(key(b) for b in ranked)
    running = 0.0
    for b in ranked:
        running += key(b)
        b["cumulative_pct"] = (running / total * 100) if total > 0 else 0.0
    return ranked


def totals_across(machines: list[dict[str, Any]], window_seconds: float) -> dict[str, Any]:
    """Line-level roll-up.

    Availability is recomputed from summed seconds rather than averaged across
    machines: a mean of percentages would weight a rarely-used machine the same
    as the line's bottleneck and quietly misreport the line.
    """
    agg = {"run_s": 0.0, "stop_s": 0.0, "idle_s": 0.0, "planned_down_s": 0.0,
           "unknown_s": 0.0, "downtime_s": 0.0, "measured_s": 0.0, "stop_count": 0}
    for m in machines:
        for k in agg:
            agg[k] += m.get(k) or 0

    measured = agg["measured_s"]
    availability = (agg["run_s"] / measured) if measured > 0 else None
    stops = agg["stop_count"]
    return {
        **agg,
        "machine_count": len(machines),
        "window_s": window_seconds,
        "availability": availability,
        "oee": availability,
        "oee_mode": "availability_only",
        "mtbf_s": (agg["run_s"] / stops) if stops else None,
        "mttr_s": (agg["downtime_s"] / stops) if stops else None,
    }
