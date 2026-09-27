"""Pure vision/camera-QC report math — the vision counterpart of report_engine.py.

db.py owns the SQL against the camera schema; this module owns the arithmetic.
Deliberately free of any database access so every edge case can be
unit-tested against hand-built rows (see tests/test_vision_report_engine.py).

The model, in one paragraph: every defect figure comes from the per-batch
historian `camera_defect_logs` (and its per-batch pivot `camera_batch_work`),
with each `defect_array` slot already named from `cameras.defect_labels` by
the SQL. `production_hourly_log` is read for one thing only — the inspected
count a defect *rate* needs — and is optional: a plant without it still gets
every count, pareto and matrix, just no rate. A missing inspected count is
`None`, never 0, so it can't read as a perfect 0% line.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Hashable, Iterable

#: Window length (seconds) up to which each defect-period bucket is one
#: hour / one day; anything longer is bucketed by week. Picked so the busiest
#: case — a full year — is ~52 bars, and a shift still shows its hours.
_HOUR_BUCKET_MAX = 3 * 86400
_DAY_BUCKET_MAX = 120 * 86400


def pick_bucket(window_seconds: float) -> str:
    """The date_trunc() unit the defects-over-time projections use."""
    if window_seconds <= _HOUR_BUCKET_MAX:
        return "hour"
    if window_seconds <= _DAY_BUCKET_MAX:
        return "day"
    return "week"


def slot_breakdown(defect_array: Iterable[Any] | None,
                   labels: list[str | None] | None) -> list[dict[str, Any]]:
    """Name each non-zero slot of an array the SQL returned alongside its
    camera's labels (same plant, same query — so no cross-plant mixing).

    Same fallback as db._SLOT_LABEL: an unnamed or blank slot is "Defect N"."""
    labels = labels or []
    out = []
    for i, count in enumerate(defect_array or []):
        if not count:
            continue
        label = labels[i] if i < len(labels) and labels[i] else f"Defect {i + 1}"
        out.append({"slot": i + 1, "defect": label, "count": int(count)})
    return out


def aggregate_camera(hourly_rows: list[dict[str, Any]], log_stats: dict[str, Any] | None,
                     window_seconds: float, inspected_known: bool = True) -> dict[str, Any]:
    """One camera's figures for the window.

    Defects, batches and last-seen come from its camera_defect_logs roll-up.
    `inspected` comes from production_hourly_log, and is `None` when that
    table couldn't be read for this camera's plant (`inspected_known=False`) —
    the rate is then `None` too, not a false 0%.

    `status` distinguishes "no data" (neither a log row nor an hourly row in
    the window — a pipeline problem) from a genuinely clean camera, and
    "partial" (fewer than half the window's hours reported) from a
    fully-covered one: a quiet camera must not look identical to a perfect one.
    """
    stats = log_stats or {}
    defects = int(stats.get("defects") or 0)
    batches = len(stats.get("batch_ids") or [])
    log_rows = int(stats.get("log_rows") or 0)

    inspected = sum(r["count_total"] or 0 for r in hourly_rows) if inspected_known else None
    rate = (defects / inspected * 100) if inspected else None
    hours_reporting = len(hourly_rows)
    window_hours = window_seconds / 3600 if window_seconds > 0 else 0

    if not log_rows and not hours_reporting:
        cam_status = "no_data"
    elif inspected_known and hours_reporting and window_hours > 0 \
            and hours_reporting < window_hours * 0.5:
        cam_status = "partial"
    else:
        cam_status = "ok"

    return {
        "inspected": inspected,
        "defects": defects,
        "defect_rate_pct": rate,
        "batches": batches,
        "defects_per_batch": (defects / batches) if batches else None,
        "log_rows": log_rows,
        "hours_reporting": hours_reporting,
        "last_seen": stats.get("last_seen"),
        "status": cam_status,
    }


def totals_across(cameras: list[dict[str, Any]], batch_keys: set | None = None,
                  ) -> dict[str, Any]:
    """Line-level roll-up. Recomputed from summed counts rather than averaging
    each camera's rate: a mean of percentages would weight a barely-used
    camera the same as the line's main inspection point.

    `batch_keys` is the set of distinct `(datasource_id, batch_id)` across all
    cameras — one batch passes every camera, so per-camera batch counts can't
    simply be summed. `inspected` is `None` unless at least one camera has a
    known inspected count, and the rate then uses only those cameras' defects,
    so a plant without an hourly log can't dilute another plant's rate."""
    known = [c for c in cameras if c.get("inspected") is not None]
    inspected = sum(c["inspected"] for c in known) if known else None
    defects = sum(c.get("defects") or 0 for c in cameras)
    rated_defects = sum(c.get("defects") or 0 for c in known)
    rate = (rated_defects / inspected * 100) if inspected else None
    batches = len(batch_keys) if batch_keys is not None else 0
    return {
        "inspected": inspected,
        "defects": defects,
        "defect_rate_pct": rate,
        "batches": batches,
        "defects_per_batch": (defects / batches) if batches else None,
        "camera_count": len(cameras),
        "cameras_reporting": sum(1 for c in cameras if c.get("status") != "no_data"),
    }


def camera_defect_profile(slot_rows: Iterable[dict[str, Any]],
                          key: Callable[[dict[str, Any]], Hashable],
                          ) -> dict[Hashable, dict[str, Any]]:
    """Per camera: its labelled slots (slot order) and its worst defect type —
    the slot with the most defects in the window, not in any single batch, so
    one freak batch can't outrank a defect that fires every batch."""
    out: dict[Hashable, dict[str, Any]] = {}
    for row in slot_rows:
        entry = out.setdefault(key(row), {"slots": [], "worst_defect": None,
                                          "worst_defect_count": 0})
        count = int(row.get("count") or 0)
        entry["slots"].append({"slot": row["slot"], "defect": row["defect"],
                               "count": count, "batches": int(row.get("batches") or 0)})
        if count > entry["worst_defect_count"]:
            entry["worst_defect_count"] = count
            entry["worst_defect"] = row["defect"]
    for entry in out.values():
        entry["slots"].sort(key=lambda s: s["slot"])
    return out


def defect_pareto(buckets_in: Iterable[dict[str, Any]], top_n: int = 10,
                  rank_by: str = "count") -> list[dict[str, Any]]:
    """Rank defect *types* by how often they fired across all batches in the
    window, with a running cumulative % — same "Other" tail-collapsing shape
    as report_engine.downtime_pareto so the chart component can be shared.

    Input is db.fetch_camera_defect_slots' rows, already labelled per plant.
    The same label arrives once per camera (and per plant), so buckets are
    merged by name here first; `batches` then counts camera-batches.
    """
    buckets: dict[str, dict[str, Any]] = {}
    for row in buckets_in:
        label = row["defect"]
        b = buckets.setdefault(label, {"defect": label, "count": 0, "batches": 0})
        b["count"] += row.get("count") or 0
        b["batches"] += row.get("batches") or 0

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


def sum_by(rows: Iterable[dict[str, Any]], fields: tuple[str, ...],
           value: str = "count") -> list[dict[str, Any]]:
    """Collapse rows onto `fields`, summing `value` — e.g. defect periods onto
    (period, defect) for the trend, or onto (period, camera) for the heatmap.
    Order of first appearance is kept, so time-ordered input stays ordered."""
    out: dict[tuple, dict[str, Any]] = {}
    for row in rows:
        k = tuple(row.get(f) for f in fields)
        entry = out.setdefault(k, {**{f: row.get(f) for f in fields}, value: 0})
        entry[value] += row.get(value) or 0
    return list(out.values())


def batch_matrix(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """camera_batch_work, unpivoted by db.fetch_camera_batch_work, folded back
    into one row per batch with one cell per camera — the engineer's "which
    camera flagged what, batch by batch" view.

    A batch is `(datasource_id, batch_id)`: batch ids are per-plant serials.
    Camera columns are keyed by code (or the raw jsonb column name when it
    matched no camera), so a camera missing from a batch is an absent cell,
    not a zero."""
    cameras: dict[str, dict[str, Any]] = {}
    batches: dict[tuple, dict[str, Any]] = {}
    for row in rows:
        col = row.get("code") or row.get("column_name")
        if col not in cameras:
            cameras[col] = {"key": col, "code": row.get("code"),
                            "name": row.get("name") or row.get("column_name"),
                            "location": row.get("location")}
        bkey = (row.get("datasource_id"), row["batch_id"])
        batch = batches.setdefault(bkey, {
            "batch_id": row["batch_id"],
            "datasource_id": row.get("datasource_id"),
            "datasource_name": row.get("datasource_name"),
            "status": row.get("status"),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
            "total": 0,
            "cells": {},
        })
        slots = slot_breakdown(row.get("defect_array"), row.get("defect_labels"))
        total = sum(s["count"] for s in slots)
        batch["cells"][col] = {"total": total, "slots": slots}
        batch["total"] += total

    ordered = sorted(batches.values(),
                     key=lambda b: (b["created_at"] or datetime.min, b["batch_id"]),
                     reverse=True)
    return {
        "cameras": sorted(cameras.values(), key=lambda c: (c["location"] or "", c["name"] or "")),
        "batches": ordered,
    }


def quality_exceptions(cameras: list[dict[str, Any]], warn_pct: float, crit_pct: float,
                       top_n: int = 10) -> dict[str, Any]:
    """Cameras whose defect rate cleared a warn/crit threshold in the window.

    Thresholds are a per-report-template option, not a global setting — a
    packaging line's acceptable defect rate is not a weld line's. A camera
    with no rate (no inspected count, or no data) never appears here; the
    block says the rate is unavailable rather than showing a clean list.
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
        "rated_cameras": sum(1 for c in cameras if c.get("defect_rate_pct") is not None),
    }
