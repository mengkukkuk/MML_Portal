"""Tests for the pure camera-QC math in vision_report_engine.

No database and no mocks, mirroring test_report_engine.py's approach: every
case here is a hand-built row list with a hand-checked expected number.
"""
from datetime import datetime, timedelta

import pytest

import vision_report_engine as ve

HOUR = 3600.0


def hourly(count_total, defect_total, offset_hours=0):
    return {
        "location": "Line 1",
        "code": "cam1",
        "period_start": datetime(2026, 8, 10) + timedelta(hours=offset_hours),
        "count_total": count_total,
        "defect_total": defect_total,
    }


# --- aggregate_camera ---------------------------------------------------------

def test_aggregate_camera_computes_rate_from_summed_counts():
    rows = [hourly(100, 5, 0), hourly(100, 15, 1)]
    out = ve.aggregate_camera(rows, window_seconds=2 * HOUR)
    assert out["inspected"] == 200
    assert out["defects"] == 20
    assert out["defect_rate_pct"] == 10.0
    assert out["status"] == "ok"


def test_aggregate_camera_zero_inspected_has_no_rate():
    """0/0 must not raise or silently report 0% -- that would hide a data gap
    as a perfect quality score."""
    out = ve.aggregate_camera([hourly(0, 0)], window_seconds=HOUR)
    assert out["defect_rate_pct"] is None


def test_aggregate_camera_no_rows_is_no_data_not_zero_percent():
    out = ve.aggregate_camera([], window_seconds=4 * HOUR)
    assert out["status"] == "no_data"
    assert out["defect_rate_pct"] is None


def test_aggregate_camera_partial_coverage_flagged():
    """Fewer than half the window's hours reported -- a data-pipeline hiccup,
    distinct from a camera that reported every hour and simply had zero
    defects."""
    out = ve.aggregate_camera([hourly(10, 0, 0)], window_seconds=10 * HOUR)
    assert out["status"] == "partial"


def test_aggregate_camera_full_coverage_is_ok():
    rows = [hourly(10, 0, h) for h in range(10)]
    out = ve.aggregate_camera(rows, window_seconds=10 * HOUR)
    assert out["status"] == "ok"


# --- totals_across -------------------------------------------------------------

def test_totals_across_recomputes_rate_not_averages_it():
    """A mean of two cameras' percentages would weight a barely-used camera the
    same as the line's main inspection point -- this must instead be a
    line-wide sum(defects)/sum(inspected)."""
    cameras = [
        {"inspected": 1000, "defects": 10},   # 1%
        {"inspected": 10, "defects": 5},      # 50%
    ]
    out = ve.totals_across(cameras)
    assert out["inspected"] == 1010
    assert out["defects"] == 15
    assert out["defect_rate_pct"] == pytest.approx(15 / 1010 * 100)
    assert out["camera_count"] == 2


def test_totals_across_empty_is_a_no_op():
    out = ve.totals_across([])
    assert out["camera_count"] == 0
    assert out["defect_rate_pct"] is None


# --- defect_pareto ---------------------------------------------------------------

def test_defect_pareto_ranks_by_count_with_running_cumulative_pct():
    rows = [
        {"code": "cam1", "defect_array": [5, 1]},
        {"code": "cam1", "defect_array": [3, 0]},
    ]
    labels = {"cam1": ["scratch", "dent"]}
    out = ve.defect_pareto(rows, labels, top_n=10, rank_by="count")
    assert [b["defect"] for b in out] == ["scratch", "dent"]
    assert out[0]["count"] == 8
    assert out[1]["count"] == 1
    assert out[-1]["cumulative_pct"] == pytest.approx(100.0)


def test_defect_pareto_handles_array_longer_than_labels():
    """A plant that added a defect slot without naming it yet must not raise
    or silently drop those counts."""
    rows = [{"code": "cam1", "defect_array": [0, 0, 4]}]
    out = ve.defect_pareto(rows, {"cam1": ["scratch", "dent"]})
    assert out[0]["defect"] == "Defect 3"
    assert out[0]["count"] == 4


def test_defect_pareto_collapses_tail_into_other():
    rows = [{"code": "cam1", "defect_array": [5, 4, 3, 2, 1]}]
    labels = {"cam1": ["a", "b", "c", "d", "e"]}
    out = ve.defect_pareto(rows, labels, top_n=2, rank_by="count")
    assert [b["defect"] for b in out] == ["a", "b", "Other"]
    assert out[-1]["count"] == 3 + 2 + 1


def test_defect_pareto_zero_counts_are_not_buckets():
    rows = [{"code": "cam1", "defect_array": [0, 0]}]
    out = ve.defect_pareto(rows, {"cam1": ["a", "b"]})
    assert out == []


# --- quality_exceptions -----------------------------------------------------

def test_quality_exceptions_splits_warn_and_crit():
    cameras = [
        {"code": "cam1", "defect_rate_pct": 1.0},   # under warn
        {"code": "cam2", "defect_rate_pct": 3.0},   # warn
        {"code": "cam3", "defect_rate_pct": 10.0},  # crit
    ]
    out = ve.quality_exceptions(cameras, warn_pct=2.0, crit_pct=5.0)
    assert out["total"] == 2
    assert out["by_severity"] == {"critical": 1, "warning": 1}
    assert [c["code"] for c in out["top"]] == ["cam3", "cam2"]


def test_quality_exceptions_ignores_cameras_with_no_rate():
    """A camera with no rate (status == 'no_data') is a Camera Summary finding,
    not a quality exception -- it must not silently rank as 0% (fine)."""
    cameras = [{"code": "cam1", "defect_rate_pct": None}]
    out = ve.quality_exceptions(cameras, warn_pct=2.0, crit_pct=5.0)
    assert out["total"] == 0


def test_quality_exceptions_respects_per_template_thresholds():
    """The whole point of making warn/crit a template option: the same 4%
    reads as a warning under one template and clean under a looser one."""
    cameras = [{"code": "cam1", "defect_rate_pct": 4.0}]
    strict = ve.quality_exceptions(cameras, warn_pct=2.0, crit_pct=5.0)
    loose = ve.quality_exceptions(cameras, warn_pct=6.0, crit_pct=10.0)
    assert strict["total"] == 1
    assert loose["total"] == 0


def test_quality_exceptions_top_n_caps_the_list_but_not_the_total():
    cameras = [{"code": f"cam{i}", "defect_rate_pct": 10.0} for i in range(5)]
    out = ve.quality_exceptions(cameras, warn_pct=2.0, crit_pct=5.0, top_n=2)
    assert out["total"] == 5
    assert len(out["top"]) == 2


# --- camera_batch_summary ----------------------------------------------------

def test_camera_batch_summary_tracks_last_seen_and_worst_defect():
    rows = [
        {"code": "cam1", "defect_array": [1, 0], "created_at": datetime(2026, 8, 10, 1)},
        {"code": "cam1", "defect_array": [0, 9], "created_at": datetime(2026, 8, 10, 2)},
    ]
    out = ve.camera_batch_summary(rows, {"cam1": ["scratch", "dent"]})
    assert out["cam1"]["last_seen"] == datetime(2026, 8, 10, 2)
    assert out["cam1"]["worst_defect"] == "dent"
    assert out["cam1"]["worst_defect_count"] == 9


def test_camera_batch_summary_missing_from_input_is_absent_not_zeroed():
    """A camera with no logged batches in the window contributes no entry --
    the caller (reports.py) decides how to render 'no batch data' rather than
    this function fabricating a zeroed-out row."""
    out = ve.camera_batch_summary([], {})
    assert out == {}
