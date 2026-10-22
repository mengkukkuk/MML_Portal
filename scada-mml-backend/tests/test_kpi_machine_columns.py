"""The machine blocks bound to explicit columns (kpi_options.py, db/kpi.py, kpi.py).

A table without `<machine>-count_1` columns is bound by naming its Machine
column and its Output column. Composed without a database; the buckets the SQL
makes were compared with the wide-table query's on identical readings (stops,
gaps, glitches, naive clocks, counters) against a scratch Postgres table.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import db
import kpi
import kpi_cache
from kpi_options import (
    MAX_MACHINES, KpiOptionsError, bind_families, bind_sensors, columns_layout, counts_picked_columns,
    normalize_kpi_options,
)

# pressure1log: one row per reading, the machine (tag) named in a column
DESCRIBE = {
    "value_columns": ["value", "setpoint", "high"],
    "array_value_columns": ["speed_in_time"],
    "bool_columns": ["flag"],
    "datetime_columns": ["timestamp"],
    "ts_columns": ["timestamp", "logdate"],
    "text_columns": ["tag_name", "line"],
    "filter_columns": ["tag_name", "line", "flag"],
    "column_types": {c: "x" for c in ["value", "setpoint", "high", "speed_in_time", "flag", "timestamp",
                                      "logdate", "tag_name", "line", "payload"]},
}
COLUMNS = {"timestamp": "timestamp without time zone", "tag_name": "character varying", "value": "integer",
           "setpoint": "integer", "speed_in_time": "_int4"}
LAYOUT = {"machine_col": "tag_name", "value_kind": "rate", "filter": None}
FAMS = [{"key": "P1", "speed": "value", "defects": ["setpoint"]}, {"key": "P2", "speed": "value", "defects": ["setpoint"]}]


def opts(**over):
    return normalize_kpi_options({"ts_col": "timestamp", "output_col": "value", "machine_col": "tag_name", **over})


def text(q):
    return q.as_string(None)


# --- options -------------------------------------------------------------------------

def test_an_output_column_lifts_the_defect_only_restriction():
    # picked defects alone count defects; with an output column Production lost is measurable
    assert normalize_kpi_options({"defect_cols": ["x"], "output_col": "value", "mode": "lost"})["mode"] == "lost"
    with pytest.raises(KpiOptionsError, match="output"):
        normalize_kpi_options({"defect_cols": ["x"], "mode": "lost"})


def test_the_loss_meter_tallies_only_without_an_output_column():
    assert counts_picked_columns(normalize_kpi_options({"defect_cols": ["x"]}), "lossmeter")
    assert not counts_picked_columns(normalize_kpi_options({"defect_cols": ["x"], "output_col": "value"}), "lossmeter")


@pytest.mark.parametrize("over", [{"value_kind": "mean"}, {"machine_col": ""}, {"output_col": 3}])
def test_bad_machine_settings_are_refused(over):
    with pytest.raises(KpiOptionsError):
        opts(**over)


def test_layout_names_how_a_table_is_read_and_is_none_for_wide_tables():
    assert columns_layout(normalize_kpi_options({})) is None
    assert columns_layout(opts(value_kind="total", filter_col="line", filter_val="L1")) == {
        "machine_col": "tag_name", "value_kind": "total", "filter": ("line", "L1")}


# --- binding -------------------------------------------------------------------------

def test_each_value_of_the_machine_column_is_a_machine_reading_the_same_columns():
    fams = bind_families(opts(defect_cols=["setpoint"]), DESCRIBE, None, ["P1", "P2"], "pressure1log")
    assert fams == [{"key": "P1", "speed": "value", "defects": ["setpoint"]},
                    {"key": "P2", "speed": "value", "defects": ["setpoint"]}]


def test_a_table_without_a_machine_column_is_one_machine_named_after_it():
    fams = bind_families(opts(machine_col=None), DESCRIBE, None, None, "pressure1log")
    assert [f["key"] for f in fams] == ["pressure1log"]


def test_arrays_can_be_the_output_and_excluded_machines_are_dropped():
    fams = bind_families(opts(output_col="speed_in_time", exclude_families=["P2"]), DESCRIBE, None, ["P1", "P2"], "t")
    assert [f["key"] for f in fams] == ["P1"] and fams[0]["speed"] == "speed_in_time"


@pytest.mark.parametrize("over, msg", [
    ({"output_col": "tag_name"}, "not a number"),
    ({"output_col": "nope"}, "not a column"),
    ({"defect_cols": ["flag"]}, "not a number"),
    ({"machine_col": "value"}, "cannot name machines"),
    ({"filter_col": "value", "filter_val": "1"}, "cannot filter"),
])
def test_unusable_columns_are_named(over, msg):
    with pytest.raises(KpiOptionsError, match=msg):
        bind_families(opts(**over), DESCRIBE, None, ["P1"], "t")


def test_a_column_with_too_many_values_does_not_name_machines():
    with pytest.raises(KpiOptionsError, match="does not name machines"):
        bind_families(opts(), DESCRIBE, None, [str(i) for i in range(MAX_MACHINES + 1)], "t")
    with pytest.raises(KpiOptionsError, match="no values"):
        bind_families(opts(), DESCRIBE, None, [], "t")


def test_the_clock_is_still_required_and_wide_detection_still_answers_without_an_output_column():
    with pytest.raises(KpiOptionsError, match="time column"):
        bind_families(opts(ts_col="tag_name"), DESCRIBE, None, ["P1"], "t")
    with pytest.raises(KpiOptionsError, match="Output column"):
        bind_families(normalize_kpi_options({"ts_col": "timestamp"}), DESCRIBE)


def test_sensors_are_chosen_not_guessed_on_an_explicitly_bound_table():
    fams = bind_families(opts(), DESCRIBE, None, ["P1"], "t")
    assert bind_sensors(opts(), DESCRIBE, fams) == []
    assert bind_sensors(opts(sensors=["setpoint"]), DESCRIBE, fams) == ["setpoint"]


# --- SQL -----------------------------------------------------------------------------

def test_rows_are_measured_within_their_machine_and_only_count_for_it():
    q = text(db.kpi_minute_query_long(COLUMNS, "public", "pressure1log", "timestamp", FAMS, LAYOUT))
    assert "PARTITION BY m ORDER BY ts" in q
    assert '("tag_name")::text AS m' in q and '= ANY(%(mkeys)s::text[])' in q
    assert "m = %(mk_0)s AND" in q and "m = %(mk_1)s AND" in q
    assert '"public"."pressure1log"' in q and "(\"timestamp\" AT TIME ZONE current_setting('TimeZone')) AS ts" in q


def test_running_counters_become_a_rate_from_their_positive_change():
    q = text(db.kpi_minute_query_long(COLUMNS, "public", "t", "timestamp", FAMS, {**LAYOUT, "value_kind": "total"}))
    assert "lag(\"v_0\") OVER w AS \"p_0\"" in q
    assert "CASE WHEN \"v_0\" >= \"p_0\" THEN (\"v_0\" - \"p_0\") / cov * 60 END" in q
    assert '"p_0"' not in text(db.kpi_minute_query_long(COLUMNS, "public", "t", "timestamp", FAMS, LAYOUT))


def test_a_single_machine_table_has_no_machine_filter_and_a_row_filter_is_parameterised():
    q = text(db.kpi_minute_query_long(COLUMNS, "public", "t", "timestamp", FAMS[:1],
                                      {"machine_col": None, "value_kind": "rate", "filter": ("tag_name", "P1")}))
    assert "'x'::text AS m" in q and "mkeys" not in q and '"tag_name"::text = %(fval)s' in q


def test_unknown_identifiers_never_reach_the_long_sql():
    for bad in ({"machine_col": "x; DROP"}, {"filter": ("nope", "1"), "machine_col": None}):
        with pytest.raises(ValueError):
            db.kpi_minute_query_long(COLUMNS, "public", "t", "timestamp", FAMS, {**LAYOUT, **bad})
    with pytest.raises(ValueError):
        db.kpi_minute_query_long(COLUMNS, "public", "t", "timestamp", [{"key": "a", "speed": "zzz", "defects": []}], LAYOUT)


# --- summary -------------------------------------------------------------------------

TZ = timezone(timedelta(hours=7))
NOW = datetime(2026, 10, 21, 10, 0, 30, tzinfo=TZ)


@pytest.fixture
def stubbed(monkeypatch):
    seen = {}
    monkeypatch.setattr(db, "describe_table", lambda t, ds=None: DESCRIBE)
    monkeypatch.setattr(db, "distinct_column_values", lambda table, col, limit, ds=None: seen.setdefault("v", ["P1", "P2"]))
    monkeypatch.setattr(kpi, "location_tags", lambda loc, ds: None)
    monkeypatch.setattr(kpi, "_machine_cache", {})
    monkeypatch.setattr(kpi_cache, "CACHE", kpi_cache.KpiCache())
    monkeypatch.setattr(kpi, "CACHE", kpi_cache.CACHE)

    def buckets(ds, table, ts_col, fams, lo, hi, **kw):
        seen["layout"] = kw.get("layout")
        seen["fams"] = fams
        return {f["key"]: [] for f in fams}

    monkeypatch.setattr(db, "kpi_minute_buckets", buckets)
    return seen


def test_summary_machines_come_from_the_column_and_the_layout_reaches_the_sql(stubbed):
    out = kpi.summarize("pressure1log", 682, {"ts_col": "timestamp", "output_col": "value", "machine_col": "tag_name",
                                              "value_kind": "total", "defect_cols": ["setpoint"]}, chart_type="andon")
    assert [f["key"] for f in out["families"]] == ["P1", "P2"]
    assert stubbed["layout"] == {"machine_col": "tag_name", "value_kind": "total", "filter": None}
    assert stubbed["fams"][0]["defects"] == ["setpoint"]
    assert out["families"][0]["speed_col"] == "value"


def test_machine_values_are_read_once_for_a_while(stubbed, monkeypatch):
    calls = []
    monkeypatch.setattr(db, "distinct_column_values", lambda *a, **k: calls.append(a) or ["P1"])
    k = {"output_col": "value", "machine_col": "tag_name"}
    assert kpi.machine_values("t", 1, k) == ["P1"] and kpi.machine_values("t", 1, k) == ["P1"]
    assert len(calls) == 1 and calls[0][2] == MAX_MACHINES + 1
    assert kpi.machine_values("t", 1, {"output_col": "value"}) is None
    assert kpi.machine_values("t", 1, {"machine_col": "tag_name"}) is None


def test_the_cache_tells_two_layouts_of_one_table_apart(stubbed):
    for kind in ("rate", "total"):
        kpi.summarize("pressure1log", 682, {"ts_col": "timestamp", "output_col": "value", "machine_col": "tag_name",
                                            "value_kind": kind}, chart_type="andon", now=NOW)
    assert len(kpi_cache.CACHE._series) == 4   # (rate, total) x (P1, P2): never one layout's buckets for the other


def test_a_bad_binding_is_a_400(stubbed):
    with pytest.raises(HTTPException) as e:
        kpi.summarize("pressure1log", 682, {"ts_col": "timestamp", "output_col": "line", "machine_col": "tag_name"},
                      chart_type="andon")
    assert e.value.status_code == 400 and "not a number" in e.value.detail


def test_a_bound_table_with_nothing_in_the_period_says_why(stubbed, monkeypatch):
    k = {"ts_col": "timestamp", "output_col": "value", "machine_col": "tag_name"}
    out = kpi.summarize("camera_defect", 681, k, chart_type="andon", now=NOW)
    assert out["notice"] == kpi.NO_READINGS_NOTICE and "latest row per machine" in out["notice"]

    def one_bucket(ds, table, ts_col, fams, lo, hi, **kw):
        minute = NOW.replace(hour=9, minute=0, second=0)
        return {f["key"]: [{"minute": minute, "valid_s": 60.0, "stop_s": 0.0, "gap_s": 0.0, "speed_sum": 600.0,
                            "speed_n": 6, "pieces": 100.0, "defects": 1.0, "parts": [1.0]} for _ in [0]] for f in fams}

    monkeypatch.setattr(db, "kpi_minute_buckets", one_bucket)
    kpi_cache.CACHE.clear()
    assert "notice" not in kpi.summarize("camera_defect", 681, {**k, "defect_cols": ["setpoint"]},
                                         chart_type="andon", now=NOW)

