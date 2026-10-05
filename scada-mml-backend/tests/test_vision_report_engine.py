"""Tests for the pure camera-QC math in vision_report_engine.

No database and no mocks, mirroring test_report_engine.py's approach: every
case here is a hand-built row list with a hand-checked expected number.
"""
from datetime import datetime

import pytest

import vision_report_engine as ve

HOUR = 3600.0
DAY = 86400.0


def hourly(inspected, hours_reporting=1):
    """A camera's production_hourly_log roll-up, as db.fetch_camera_hourly returns it."""
    return {"location": "Line 1", "code": "cam1",
            "inspected": inspected, "hours_reporting": hours_reporting}


def stats(defects, batches=1, log_rows=None, last_seen=None):
    return {"defects": defects, "batches": batches,
            "log_rows": batches if log_rows is None else log_rows,
            "last_seen": last_seen}


# --- pick_bucket ------------------------------------------------------------------

@pytest.mark.parametrize("seconds, bucket", [
    (8 * HOUR, "hour"), (3 * DAY, "hour"), (30 * DAY, "day"), (365 * DAY, "week"),
])
def test_pick_bucket_keeps_a_year_to_weekly_bars(seconds, bucket):
    assert ve.pick_bucket(seconds) == bucket


# --- slot_breakdown -----------------------------------------------------------------

def test_slot_breakdown_names_slots_and_skips_zeros():
    out = ve.slot_breakdown([2, 0, 5], ["scratch", "dent", "burr"])
    assert out == [{"slot": 1, "defect": "scratch", "count": 2},
                   {"slot": 3, "defect": "burr", "count": 5}]


def test_slot_breakdown_falls_back_for_unnamed_and_blank_slots():
    """An array longer than its labels, or a blank label, must not drop counts."""
    out = ve.slot_breakdown([1, 1, 4], ["scratch", ""])
    assert [d["defect"] for d in out] == ["scratch", "Defect 2", "Defect 3"]


# --- aggregate_camera ---------------------------------------------------------

def test_aggregate_camera_takes_defects_from_logs_and_inspected_from_hourly():
    """Every defect figure is the log's; the hourly roll-up only supplies `inspected`."""
    out = ve.aggregate_camera(hourly(200, 2), stats(20, batches=2), window_seconds=2 * HOUR)
    assert out["inspected"] == 200
    assert out["defects"] == 20
    assert out["defect_rate_pct"] == 10.0
    assert out["batches"] == 2
    assert out["defects_per_batch"] == 10.0
    assert out["status"] == "ok"


def test_aggregate_camera_without_an_hourly_table_has_no_rate_not_zero():
    """A plant with no production_hourly_log: inspected unknown, rate None —
    never 0 inspected / 0%, which would read as a perfect line."""
    out = ve.aggregate_camera(None, stats(7), window_seconds=HOUR, inspected_known=False)
    assert out["inspected"] is None
    assert out["defect_rate_pct"] is None
    assert out["defects"] == 7
    assert out["status"] == "ok"


def test_aggregate_camera_zero_inspected_has_no_rate():
    out = ve.aggregate_camera(hourly(0), stats(3), window_seconds=HOUR)
    assert out["defect_rate_pct"] is None


def test_aggregate_camera_no_rows_is_no_data_not_zero_percent():
    out = ve.aggregate_camera(None, None, window_seconds=4 * HOUR)
    assert out["status"] == "no_data"
    assert out["defect_rate_pct"] is None
    assert out["defects_per_batch"] is None


def test_aggregate_camera_partial_coverage_flagged():
    out = ve.aggregate_camera(hourly(10, 1), stats(0), window_seconds=10 * HOUR)
    assert out["status"] == "partial"


def test_aggregate_camera_full_coverage_is_ok():
    out = ve.aggregate_camera(hourly(100, 10), stats(0), window_seconds=10 * HOUR)
    assert out["status"] == "ok"


# --- totals_across -------------------------------------------------------------

def test_totals_across_recomputes_rate_not_averages_it():
    cameras = [
        {"inspected": 1000, "defects": 10},   # 1%
        {"inspected": 10, "defects": 5},      # 50%
    ]
    out = ve.totals_across(cameras)
    assert out["inspected"] == 1010
    assert out["defects"] == 15
    assert out["defect_rate_pct"] == pytest.approx(15 / 1010 * 100)
    assert out["camera_count"] == 2


def test_totals_across_counts_a_batch_once_not_once_per_camera():
    """Two cameras, each saw both batches: the caller passes the line's 2
    distinct batches, not the 4 camera-batches the per-camera counts sum to."""
    cameras = [{"defects": 4, "batches": 2}, {"defects": 6, "batches": 2}]
    out = ve.totals_across(cameras, batches=2)
    assert out["batches"] == 2
    assert out["defects_per_batch"] == 5.0


def test_totals_across_rate_ignores_cameras_with_no_inspected_count():
    """Plant B has no hourly log. Its defects still count, but must not be
    divided by plant A's inspected units."""
    cameras = [{"inspected": 100, "defects": 5}, {"inspected": None, "defects": 50}]
    out = ve.totals_across(cameras)
    assert out["defects"] == 55
    assert out["defect_rate_pct"] == 5.0


def test_totals_across_without_any_inspected_count_has_no_rate():
    out = ve.totals_across([{"inspected": None, "defects": 5}])
    assert out["inspected"] is None
    assert out["defect_rate_pct"] is None


def test_totals_across_empty_is_a_no_op():
    out = ve.totals_across([])
    assert out["camera_count"] == 0
    assert out["defect_rate_pct"] is None


# --- camera_defect_profile ------------------------------------------------------

def test_camera_defect_profile_orders_slots_and_picks_the_worst_type():
    rows = [
        {"code": "cam1", "slot": 2, "defect": "dent", "count": 9, "batches": 1},
        {"code": "cam1", "slot": 1, "defect": "scratch", "count": 4, "batches": 3},
        {"code": "cam2", "slot": 1, "defect": "burr", "count": 1, "batches": 1},
    ]
    out = ve.camera_defect_profile(rows, key=lambda r: r["code"])
    assert [s["slot"] for s in out["cam1"]["slots"]] == [1, 2]
    assert out["cam1"]["worst_defect"] == "dent"
    assert out["cam2"]["worst_defect"] == "burr"


def test_camera_defect_profile_keeps_plants_apart():
    """Two plants' CAM01 are different cameras — the key decides, not the code."""
    rows = [
        {"datasource_id": 1, "code": "CAM01", "slot": 1, "defect": "scratch", "count": 2},
        {"datasource_id": 2, "code": "CAM01", "slot": 1, "defect": "crack", "count": 5},
    ]
    out = ve.camera_defect_profile(rows, key=lambda r: (r["datasource_id"], r["code"]))
    assert out[(1, "CAM01")]["worst_defect"] == "scratch"
    assert out[(2, "CAM01")]["worst_defect"] == "crack"


# --- defect_pareto ---------------------------------------------------------------

def bucket(defect, count, batches=1):
    return {"defect": defect, "count": count, "batches": batches}


def test_defect_pareto_ranks_by_count_with_running_cumulative_pct():
    out = ve.defect_pareto([bucket("dent", 1), bucket("scratch", 8, 2)],
                           top_n=10, rank_by="count")
    assert [b["defect"] for b in out] == ["scratch", "dent"]
    assert out[0]["count"] == 8
    assert out[1]["count"] == 1
    assert out[-1]["cumulative_pct"] == pytest.approx(100.0)


def test_defect_pareto_merges_the_same_label_across_cameras_and_sources():
    rows = [
        {**bucket("scratch", 5, 2), "datasource_id": 1},
        {**bucket("scratch", 3, 1), "datasource_id": 2},
        {**bucket("dent", 4, 4), "datasource_id": 2},
    ]
    out = ve.defect_pareto(rows, rank_by="batches")
    assert [b["defect"] for b in out] == ["dent", "scratch"]
    assert out[1]["count"] == 8
    assert out[1]["batches"] == 3


def test_defect_pareto_collapses_tail_into_other():
    rows = [bucket(name, n) for name, n in zip("abcde", [5, 4, 3, 2, 1])]
    out = ve.defect_pareto(rows, top_n=2, rank_by="count")
    assert [b["defect"] for b in out] == ["a", "b", "Other"]
    assert out[-1]["count"] == 3 + 2 + 1


def test_defect_pareto_top_n_zero_keeps_every_type():
    rows = [bucket(name, n) for name, n in zip("abc", [3, 2, 1])]
    assert len(ve.defect_pareto(rows, top_n=0)) == 3


def test_defect_pareto_no_buckets_is_empty():
    assert ve.defect_pareto([]) == []


# --- sum_by --------------------------------------------------------------------

def test_sum_by_collapses_cameras_into_one_bar_per_period_and_type():
    d1, d2 = datetime(2026, 9, 1), datetime(2026, 9, 2)
    rows = [
        {"period": d1, "code": "cam1", "defect": "scratch", "count": 2},
        {"period": d1, "code": "cam2", "defect": "scratch", "count": 3},
        {"period": d2, "code": "cam1", "defect": "dent", "count": 1},
    ]
    out = ve.sum_by(rows, ("period", "defect"))
    assert out == [{"period": d1, "defect": "scratch", "count": 5},
                   {"period": d2, "defect": "dent", "count": 1}]


# --- batch_matrix --------------------------------------------------------------

def work(batch_id, code, arr, labels=("scratch", "dent"), ds=1, created=None, column=None):
    return {"batch_id": batch_id, "datasource_id": ds, "datasource_name": f"P{ds}",
            "status": None, "created_at": created or datetime(2026, 9, batch_id),
            "updated_at": None, "column_name": column or f"camera_{code[-1]}",
            "location": "Line 1", "code": code, "name": f"Cam {code[-1]}",
            "defect_array": arr, "defect_labels": list(labels)}


def test_batch_matrix_folds_the_pivot_back_into_batch_rows_newest_first():
    out = ve.batch_matrix([
        work(1, "cam1", [1, 0]), work(1, "cam2", [0, 3]), work(2, "cam1", [2, 2]),
    ])
    assert [b["batch_id"] for b in out["batches"]] == [2, 1]
    first = out["batches"][1]
    assert first["total"] == 4
    assert first["cells"]["cam2"] == {"total": 3,
                                      "slots": [{"slot": 2, "defect": "dent", "count": 3}]}
    assert [c["key"] for c in out["cameras"]] == ["cam1", "cam2"]


def test_batch_matrix_keeps_two_plants_same_batch_id_apart():
    out = ve.batch_matrix([work(5, "cam1", [1], ds=1), work(5, "cam1", [4], ds=2)])
    assert sorted(b["total"] for b in out["batches"]) == [1, 4]


def test_batch_matrix_keeps_a_column_that_matches_no_camera():
    row = {**work(1, "cam1", [3]), "code": None, "name": None, "column_name": "camera_9"}
    out = ve.batch_matrix([row])
    assert out["cameras"][0]["key"] == "camera_9"
    assert out["batches"][0]["cells"]["camera_9"]["slots"][0]["defect"] == "scratch"


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
    assert out["rated_cameras"] == 3


def test_quality_exceptions_ignores_cameras_with_no_rate():
    """No rate is not a clean rate: `rated_cameras` lets the block say so."""
    cameras = [{"code": "cam1", "defect_rate_pct": None}]
    out = ve.quality_exceptions(cameras, warn_pct=2.0, crit_pct=5.0)
    assert out["total"] == 0
    assert out["rated_cameras"] == 0


def test_quality_exceptions_respects_per_template_thresholds():
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
