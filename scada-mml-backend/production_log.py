"""Pure hourly aggregation for cumulative production counters."""
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from typing import Any, Iterable


def _count(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, Decimal):
        value = float(value)
    return max(0, int(value))


def _increment(current: int, previous: int) -> int:
    """A falling PLC counter reset contributes its new post-reset value."""
    return current - previous if current >= previous else current


def _hourly_increments(
    samples: Iterable[dict[str, Any]],
    key: str,
    generated_at: datetime,
    shift_start: int,
    shift_end: int,
) -> dict[int, int]:
    """One counter's positive movement, bucketed by plant-local hour.

    The first row may be the final sample before shift start. If no baseline is
    available, the first in-shift sample establishes one and contributes no
    invented production.
    """
    ordered = sorted((row for row in samples if row.get("ts") is not None), key=lambda r: r["ts"])
    totals: dict[int, int] = defaultdict(int)
    previous: int | None = None

    for row in ordered:
        value = _count(row.get(key))
        ts = row["ts"]
        if previous is not None and ts.date() == generated_at.date() and shift_start <= ts.hour < shift_end:
            totals[ts.hour] += _increment(value, previous)
        previous = value

    return totals


def _envelope(
    produced: dict[int, int], rejected: dict[int, int], generated_at: datetime
) -> dict[str, Any]:
    """The shape every caller of this module returns, however it got there."""
    return {
        "date": generated_at.date(),
        "generated_at": generated_at,
        "buckets": [
            {"hour": hour, "produced": produced.get(hour, 0), "rejected": rejected.get(hour, 0)}
            for hour in sorted(set(produced) | set(rejected))
            if produced.get(hour) or rejected.get(hour)
        ],
    }


def aggregate_counter_samples(
    samples: Iterable[dict[str, Any]],
    generated_at: datetime,
    shift_start: int = 8,
    shift_end: int = 18,
) -> dict[str, Any]:
    """Hourly increments from one row stream carrying *both* counters.

    The wide layout: one timestamped row per sample, a good column and a reject
    column side by side. Both counters share a row, so they share a baseline row
    too.
    """
    ordered = list(samples)
    return _envelope(
        _hourly_increments(ordered, "produced", generated_at, shift_start, shift_end),
        _hourly_increments(ordered, "rejected", generated_at, shift_start, shift_end),
        generated_at,
    )


def aggregate_counter_series(
    produced_samples: Iterable[dict[str, Any]],
    rejected_samples: Iterable[dict[str, Any]],
    generated_at: datetime,
    shift_start: int = 8,
    shift_end: int = 18,
) -> dict[str, Any]:
    """Hourly increments from two *independent* counter streams.

    The tag-per-row (EAV) layout, which is what a historian keyed by tag name
    actually gives you: both counters live in the same `value` column of the
    same table, told apart by a tag column, so each arrives as its own series
    on its own timestamps.

    Each series is reduced on its own baseline rather than zipped first. A
    shared baseline would be wrong here: the two tags are written by separate
    scans and there is no row on which both are true at once, so pairing them by
    position would subtract a good count from whatever reject sample happened to
    sort next to it.
    """
    return _envelope(
        _hourly_increments(produced_samples, "value", generated_at, shift_start, shift_end),
        _hourly_increments(rejected_samples, "value", generated_at, shift_start, shift_end),
        generated_at,
    )
