"""Saving a table panel bound to text / array columns, and the per-column options
the Live editor writes beside `value_cols` (unsplitCols, arraySlots, textCols).

`panels._validate` is called directly with the db layer stubbed, as in
test_kpi_panels.py.
"""
import pytest
from fastapi import HTTPException

import db
import panels

DESCRIBE = {
    "value_columns": ["flow"],
    "bool_columns": ["running"],
    "array_value_columns": ["reading"],
    "text_columns": ["mode"],
    "ts_columns": ["ts"],
    "filter_columns": ["tag", "mode"],
    "column_types": {"flow": "float8", "running": "bool", "reading": "float8[]",
                     "mode": "text", "ts": "timestamptz", "tag": "varchar"},
}


@pytest.fixture(autouse=True)
def _stubs(monkeypatch):
    monkeypatch.setattr(db, "describe_table", lambda table, ds=None: DESCRIBE)


def body(metric="flow", **options):
    return panels.PanelIn(
        title="t", chart_type="timeseries", source="table", table_name="plant",
        metric=metric, filter_col="tag", ts_col="ts", poll_interval_seconds=5,
        options=options,
    )


def detail(opts, metric="flow"):
    with pytest.raises(HTTPException) as exc:
        panels._validate(body(metric, **opts))
    assert exc.value.status_code == 400
    return exc.value.detail


@pytest.mark.parametrize("metric", ["flow", "running", "reading", "mode"])
def test_every_value_kind_can_be_the_metric(metric):
    panels._validate(body(metric))


def test_extra_value_columns_may_be_array_or_text():
    panels._validate(body(value_cols=["reading", "mode", "running"]))


def test_a_column_of_no_value_kind_is_still_refused():
    assert "metric must be" in detail({}, metric="tag")
    assert "value_cols" in detail({"value_cols": ["ts"]})


def test_well_formed_column_options_are_accepted():
    panels._validate(body(
        "reading", value_cols=["flow", "mode"], unsplitCols=["flow"], textCols=["mode"],
        arraySlots={"reading": [{"index": 0, "name": "Measured"}, {"index": 2}]},
    ))


@pytest.mark.parametrize("opts", [
    {"unsplitCols": "flow"},
    {"unsplitCols": [1]},
    {"textCols": {"mode": True}},
    {"arraySlots": ["reading"]},
    {"arraySlots": {"reading": {"index": 0}}},
    {"arraySlots": {"reading": [{"index": -1}]}},
    {"arraySlots": {"reading": [{"index": "0"}]}},
    {"arraySlots": {"reading": [{"index": True}]}},
    {"arraySlots": {"reading": [{"index": 1, "name": 5}]}},
    {"arraySlots": {"reading": [3]}},
])
def test_malformed_column_options_are_refused(opts):
    assert "options." in detail(opts, metric="reading")
