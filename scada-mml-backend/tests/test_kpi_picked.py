"""The Loss meter counting picked columns (kpi_options.py, db/kpi.py, kpi.py).

Tables without per-machine `<family>-count_1` columns — the vision tables, tag
logs, event logs — are bound by picking the columns to count. Composed without
a database, like test_kpi_sql.py; the arithmetic is checked against the real
plant tables by hand (see the verification notes in the commit).
"""
import pytest
from fastapi import HTTPException

import db
import kpi
import panels
from kpi_options import KpiOptionsError, bind_picked, counts_picked_columns, normalize_kpi_options

# camera_defect_logs as the schema endpoint describes it
DESCRIBE = {
    "value_columns": ["camera_id", "batch_id"],
    "array_value_columns": ["defect_array"],
    "bool_columns": ["flag"],
    "datetime_columns": ["created_at"],
    "ts_columns": ["created_at"],
    "text_columns": ["code", "location"],
    "filter_columns": ["code", "location", "created_at"],
    "column_types": {"camera_id": "int4", "batch_id": "int4", "defect_array": "int4[]", "flag": "bool",
                     "created_at": "timestamptz", "code": "text", "location": "text", "payload": "jsonb"},
}
COLUMNS = {"created_at": "timestamp with time zone", "defect_array": "_int4", "batch_id": "integer",
           "flag": "boolean", "code": "text"}


def kpi_opts(**over):
    return normalize_kpi_options({"ts_col": "created_at", "defect_cols": ["defect_array"], **over})


def text(query):
    return query.as_string(None)


# --- options -----------------------------------------------------------------------

def test_defaults_leave_machine_detection_in_charge():
    o = normalize_kpi_options({})
    assert o["defect_cols"] is None and o["array_mode"] == "sum" and o["filter_col"] is None
    assert not counts_picked_columns(o, "lossmeter")


def test_only_the_loss_meter_counts_picked_columns():
    o = kpi_opts()
    assert counts_picked_columns(o, "lossmeter")
    assert not counts_picked_columns(o, "andon")


@pytest.mark.parametrize("over", [
    {"defect_cols": []}, {"defect_cols": "defect_array"}, {"defect_cols": [3]},
    {"array_mode": "avg"}, {"filter_col": "code"}, {"filter_val": "A"}, {"filter_col": "", "filter_val": "A"},
    {"mode": "lost"}, {"mode": "total"},
])
def test_bad_picks_are_refused(over):
    with pytest.raises(KpiOptionsError):
        kpi_opts(**over)


def test_duplicate_columns_collapse():
    assert kpi_opts(defect_cols=["defect_array", "batch_id", "defect_array"])["defect_cols"] == ["defect_array", "batch_id"]


# --- binding -----------------------------------------------------------------------

def test_numeric_array_and_flag_columns_can_be_counted():
    bound = bind_picked(kpi_opts(defect_cols=["camera_id", "defect_array", "flag"]), DESCRIBE)
    assert bound["defect_cols"] == ["camera_id", "defect_array", "flag"] and bound["filter"] is None


def test_a_text_column_filters_rows_but_cannot_be_counted():
    bound = bind_picked(kpi_opts(filter_col="code", filter_val="CAM001-13"), DESCRIBE)
    assert bound["filter"] == ("code", "CAM001-13")
    with pytest.raises(KpiOptionsError, match="Only count rows where"):
        bind_picked(kpi_opts(defect_cols=["code"]), DESCRIBE)


def test_unknown_unsupported_and_bad_clock_columns_are_named():
    with pytest.raises(KpiOptionsError, match="'nope' is not a column"):
        bind_picked(kpi_opts(defect_cols=["nope"]), DESCRIBE)
    with pytest.raises(KpiOptionsError, match="payload.*jsonb"):
        bind_picked(kpi_opts(defect_cols=["payload"]), DESCRIBE)
    with pytest.raises(KpiOptionsError, match="ts_col"):
        bind_picked(kpi_opts(ts_col="code"), DESCRIBE)
    with pytest.raises(KpiOptionsError, match="cannot filter"):
        bind_picked(kpi_opts(filter_col="batch_id", filter_val="1"), DESCRIBE)


# --- SQL ---------------------------------------------------------------------------

def test_array_sum_adds_every_element_and_first_reads_slot_one():
    q = text(db.kpi_tally_query(COLUMNS, "vision", "camera_defect_logs", "created_at", ["defect_array"], "sum", None))
    assert 'unnest("defect_array")' in q and '"vision"."camera_defect_logs"' in q
    q = text(db.kpi_tally_query(COLUMNS, "vision", "t", "created_at", ["defect_array"], "first", None))
    assert '("defect_array"[1])::float8' in q and "unnest" not in q


def test_scalars_flags_and_filters_are_quoted_and_parameterised():
    q = text(db.kpi_tally_query(COLUMNS, "public", "t", "created_at", ["batch_id", "flag"], "sum", "code"))
    assert '("batch_id")::float8' in q and 'CASE WHEN "flag" THEN 1 ELSE 0 END' in q
    assert '"code"::text = %(fval)s' in q and "%(vmax)s" in q


def test_unknown_identifiers_never_reach_the_sql():
    for cols, flt in ((["x; DROP TABLE t"], None), (["batch_id"], "nope")):
        with pytest.raises(ValueError):
            db.kpi_tally_query(COLUMNS, "public", "t", "created_at", cols, "sum", flt)
    with pytest.raises(ValueError):
        db.kpi_tally_query(COLUMNS, "public", "t", "missing", ["batch_id"], "sum", None)


# --- summary ------------------------------------------------------------------------

@pytest.fixture
def fake_tally(monkeypatch):
    calls = {}

    def tally(datasource_id, table, ts_col, cols, **kw):
        calls.update(datasource_id=datasource_id, table=table, ts_col=ts_col, cols=cols, **kw)
        return {"cur": 35.0, "prev": 20.0, "cur_rows": 4}

    monkeypatch.setattr(db, "describe_table", lambda t, ds=None: DESCRIBE)
    monkeypatch.setattr(db, "kpi_tally", tally)
    return calls


def test_summary_reads_the_picked_columns_and_prices_them(fake_tally):
    out = kpi.summarize("camera_defect_logs", 681, {"ts_col": "created_at", "defect_cols": ["defect_array"],
                                                    "cost_per_piece": 12}, chart_type="lossmeter")
    assert out["totals"]["defects"] == 35 and out["totals"]["baht"]["defects"] == 420
    assert out["compare"]["defects"] == 20 and out["compare"]["baht"]["defects"] == 240
    assert out["families"] == [] and out["scope"] == "columns" and out["rows_in_period"] == 4
    assert fake_tally["cols"] == ["defect_array"] and fake_tally["array_mode"] == "sum"
    assert fake_tally["filter_col"] is None


def test_summary_passes_the_row_filter_and_skips_compare_when_off(fake_tally):
    out = kpi.summarize("camera_defect_logs", 681, {"ts_col": "created_at", "defect_cols": ["defect_array"],
                                                    "filter_col": "code", "filter_val": "CAM001-13",
                                                    "compare": False}, chart_type="lossmeter")
    assert "compare" not in out and "baht" not in out["totals"]
    assert (fake_tally["filter_col"], fake_tally["filter_val"]) == ("code", "CAM001-13")


def test_other_blocks_ignore_picked_columns_and_need_machines(fake_tally):
    with pytest.raises(HTTPException) as e:
        kpi.summarize("camera_defect_logs", 681, {"ts_col": "created_at", "defect_cols": ["defect_array"]},
                      chart_type="andon")
    assert e.value.status_code == 400 and "per-machine" in e.value.detail


def test_a_bad_pick_is_a_400_not_a_500(fake_tally):
    with pytest.raises(HTTPException) as e:
        kpi.summarize("camera_defect_logs", 681, {"ts_col": "created_at", "defect_cols": ["code"]},
                      chart_type="lossmeter")
    assert e.value.status_code == 400 and "cannot be counted" in e.value.detail


# --- saving ------------------------------------------------------------------------

ADMIN = {"id": 1, "username": "a", "role": "admin"}


def test_saving_a_picked_block_binds_without_machines(monkeypatch):
    monkeypatch.setattr(db, "describe_table", lambda t, ds=None: DESCRIBE)
    monkeypatch.setattr(db, "list_dashboards", lambda: [{"id": 1}])
    monkeypatch.setattr(db, "get_datasource", lambda i: {"id": i})
    monkeypatch.setattr(db, "create_panel", lambda *a: {"id": 9, "options": a[6], "source": a[7], "metric": a[2]})
    body = panels.PanelIn(title="Defects", chart_type="lossmeter", source="kpi", table_name="camera_defect_logs",
                          datasource_id=681, poll_interval_seconds=60,
                          options={"kpi": {"ts_col": "created_at", "defect_cols": ["defect_array"]}})
    out = panels.create_panel(body, _admin=ADMIN)
    assert out["metric"] == "defect_array" and out["options"]["kpi"]["defect_cols"] == ["defect_array"]
    bad = body.model_copy(update={"options": {"kpi": {"ts_col": "created_at", "defect_cols": ["payload"]}}})
    with pytest.raises(HTTPException) as e:
        panels.create_panel(bad, _admin=ADMIN)
    assert e.value.status_code == 400
