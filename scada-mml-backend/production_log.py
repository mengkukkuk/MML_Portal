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


def aggregate_counter_samples(
    samples: Iterable[dict[str, Any]],
    generated_at: datetime,
    shift_start: int = 8,
    shift_end: int = 18,
) -> dict[str, Any]:
    """Turn ordered cumulative samples into non-empty hourly increments.

    The first row may be the final sample before shift start. If no baseline is
    available, the first in-shift sample establishes one and contributes no
    invented production.
    """
    ordered = sorted((row for row in samples if row.get("ts") is not None), key=lambda r: r["ts"])
    totals: dict[int, dict[str, int]] = defaultdict(lambda: {"produced": 0, "rejected": 0})
    previous: tuple[int, int] | None = None

    for row in ordered:
        produced = _count(row.get("produced"))
        rejected = _count(row.get("rejected"))
        ts = row["ts"]
        if previous is not None and ts.date() == generated_at.date() and shift_start <= ts.hour < shift_end:
            totals[ts.hour]["produced"] += _increment(produced, previous[0])
            totals[ts.hour]["rejected"] += _increment(rejected, previous[1])
        previous = (produced, rejected)

    return {
        "date": generated_at.date(),
        "generated_at": generated_at,
        "buckets": [
            {"hour": hour, **totals[hour]}
            for hour in sorted(totals)
            if totals[hour]["produced"] or totals[hour]["rejected"]
        ],
    }
