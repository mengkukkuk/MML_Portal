"""Pure vision/camera-QC report math — the vision counterpart of report_engine.py.

reports.py owns the SQL against vision_data (production_hourly_log,
camera_defect_logs); this module owns the arithmetic. Deliberately free of any
database access so every edge case can be unit-tested against hand-built rows
(see tests/test_vision_report_engine.py).

The model, in one paragraph: a camera's `production_hourly_log` rows are
windowed inspected/defect *counts* (not transitions, unlike a machine's
event_logs), so no interval-building is needed — a defect rate is just
sum(defect_total) / sum(count_total) over whichever hourly rows fall in the
window. `camera_defect_logs` is the complementary per-batch historian, used
only for "what was the worst defect type" and "when did we last hear from
this camera", neither of which the hourly rollup carries.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable


def aggregate_camera(hourly_rows: list[dict[str, Any]],
                     window_seconds: float) -> dict[str, Any]:
    """Roll one camera's hourly rows up into inspected/defect totals + rate.

    `status` distinguishes "no data" (a data-pipeline problem: the camera
    never wrote an hourly row) from a genuine 0% defect rate, and "partial"
    (fewer than half the window's hours reported) from a fully-covered
    window — mirrors report_engine.aggregate's `coverage`, which exists for
    the same reason: a quiet camera must not look identical to a perfect one.
    """
    inspected = sum(r["count_total"] or 0 for r in hourly_rows)
    defects = sum(r["defect_total"] or 0 for r in hourly_rows)
    rate = (defects / inspected * 100) if inspected > 0 else None
    hours_reporting = len(hourly_rows)
    window_hours = window_seconds / 3600 if window_seconds > 0 else 0

    if hours_reporting <= 0:
        cam_status = "no_data"
    elif window_hours > 0 and hours_reporting < window_hours * 0.5:
        cam_status = "partial"
    else:
        cam_status = "ok"

    return {
        "inspected": inspected,
        "defects": defects,
        "defect_rate_pct": rate,
        "hours_reporting": hours_reporting,
        "status": cam_status,
    }


def totals_across(cameras: list[dict[str, Any]]) -> dict[str, Any]:
    """Line-level roll-up. Recomputed from summed counts rather than averaging
    each camera's rate: a mean of percentages would weight a barely-used
    camera the same as the line's main inspection point."""
    inspected = sum(c.get("inspected") or 0 for c in cameras)
    defects = sum(c.get("defects") or 0 for c in cameras)
    rate = (defects / inspected * 100) if inspected > 0 else None
    return {
        "inspected": inspected,
        "defects": defects,
        "defect_rate_pct": rate,
        "camera_count": len(cameras),
    }


def defect_pareto(rows: Iterable[dict[str, Any]], labels_by_code: dict[str, list[str]],
                  top_n: int = 10, rank_by: str = "count") -> list[dict[str, Any]]:
    """Rank defect *types* by how often they fired across all batches in the
    window, with a running cumulative % — same "Other" tail-collapsing shape
    as report_engine.downtime_pareto so the chart component can be shared.

    A row's `defect_array` is zipped against that camera's `defect_labels` by
    position. The two are read independently (see db.camera_defect_labels), so
    an array longer than its labels — a plant that added a defect slot without
    naming it yet — falls back to "Defect N" for the unnamed tail rather than
    raising or silently dropping those counts.
    """
    buckets: dict[str, dict[str, Any]] = {}
    for row in rows:
        labels = labels_by_code.get(row["code"]) or []
        for i, count in enumerate(row.get("defect_array") or []):
            if not count:
                continue
            label = labels[i] if i < len(labels) else f"Defect {i + 1}"
            b = buckets.setdefault(label, {"defect": label, "count": 0, "batches": 0})
            b["count"] += count
            b["batches"] += 1

    key = (lambda b: b["batches"]) if rank_by == "batches" else (lambda b: b["count"])
    ranked = sorted(buckets.values(), key=key, reverse=True)

    if top_n and len(ranked) > top_n:
        head, tail = ranked[:top_n], ranked[top_n:]
        ranked = head + [{
            "defect": "Other",
            "count": sum(b["count"] for b in tail),
            "batches": sum(b["batches"] for b in tail),
        }]

    total = sum(key(b) for b in ranked)
    running = 0.0
    for b in ranked:
        running += key(b)
        b["cumulative_pct"] = (running / total * 100) if total > 0 else 0.0
    return ranked


def quality_exceptions(cameras: list[dict[str, Any]], warn_pct: float, crit_pct: float,
                       top_n: int = 10) -> dict[str, Any]:
    """Cameras whose defect rate cleared a warn/crit threshold in the window.

    Thresholds are a per-report-template option (like the old KPI block's
    `targets.oee`), not a global setting — a packaging line's acceptable
    defect rate is not a weld line's. A camera with no rate (`status ==
    "no_data"`) never appears here: an outage is Camera Summary's "no_data"
    status to surface, not a quality exception.
    """
    exceeded = []
    by_severity = {"critical": 0, "warning": 0}
    for cam in cameras:
        rate = cam.get("defect_rate_pct")
        if rate is None:
            continue
        if rate >= crit_pct:
            sev = "critical"
        elif rate >= warn_pct:
            sev = "warning"
        else:
            continue
        by_severity[sev] += 1
        exceeded.append({**cam, "severity": sev})

    exceeded.sort(key=lambda c: c["defect_rate_pct"], reverse=True)
    return {
        "total": len(exceeded),
        "by_severity": by_severity,
        "top": exceeded[:top_n],
    }


def camera_batch_summary(rows: Iterable[dict[str, Any]],
                         labels_by_code: dict[str, list[str]],
                         ) -> dict[str, dict[str, Any]]:
    """Per-camera last-seen timestamp and worst single defect type in the
    window, keyed by camera code — built from camera_defect_logs, independent
    of the hourly aggregate. A camera with hourly rows but no logged batches
    (or vice versa) still gets whichever half of the picture it has data for,
    rather than one missing table blanking out the other.
    """
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        code = row["code"]
        entry = out.setdefault(code, {"last_seen": None, "worst_defect": None,
                                      "worst_defect_count": 0})
        seen: datetime | None = row.get("created_at")
        if seen is not None and (entry["last_seen"] is None or seen > entry["last_seen"]):
            entry["last_seen"] = seen
        labels = labels_by_code.get(code) or []
        for i, count in enumerate(row.get("defect_array") or []):
            if count and count > entry["worst_defect_count"]:
                entry["worst_defect_count"] = count
                entry["worst_defect"] = labels[i] if i < len(labels) else f"Defect {i + 1}"
    return out
