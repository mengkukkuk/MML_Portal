"""Saving management blocks (panels.py source='kpi') and the manager role.

Route functions are called directly with the db layer stubbed, as in
test_router_envelopes.py.
"""
import pytest
from fastapi import HTTPException

import auth
import db
import panels
import users
from kpi_options import KpiOptionsError, normalize_kpi_options

ADMIN = {"id": 1, "username": "a", "role": "admin"}
MANAGER = {"id": 2, "username": "m", "role": "manager"}
OPERATOR = {"id": 3, "username": "o", "role": "operator"}

DESCRIBE = {
    "value_columns": ["Temparature1"],
    "array_value_columns": ["CAM001-13-count_1", "CAM001-13-defect_1", "CAM002-13-count_1", "CAM002-13-defect_1"],
    "datetime_columns": ["recorded_at"],
    "ts_columns": ["recorded_at"],
    "column_types": {c: "x" for c in ["recorded_at", "CAM001-13-count_1", "CAM001-13-defect_1",
                                      "CAM002-13-count_1", "CAM002-13-defect_1", "Temparature1"]},
}


@pytest.fixture(autouse=True)
def _stubs(monkeypatch):
    monkeypatch.setattr(db, "describe_table", lambda table, ds=None: DESCRIBE)
    monkeypatch.setattr(db, "list_dashboards", lambda: [{"id": 1}])
    monkeypatch.setattr(db, "get_datasource", lambda i: {"id": i})
    saved = {}

    def create(*args):
        saved["args"] = args
        return {"id": 9, "options": args[6], "source": args[7], "metric": args[2]}

    monkeypatch.setattr(db, "create_panel", create)
    return saved


def body(**over):
    base = dict(title="Defect cost", chart_type="lossmeter", source="kpi", table_name="sensor_log1",
                datasource_id=850, poll_interval_seconds=60,
                options={"kpi": {"ts_col": "recorded_at", "cost_per_piece": 12}})
    base.update(over)
    return panels.PanelIn(**base)


def test_saving_a_block_detects_machines_and_fills_defaults(_stubs):
    out = panels.create_panel(body(), _admin=ADMIN)
    assert out["metric"] == "CAM001-13-count_1"
    kpi = out["options"]["kpi"]
    assert kpi["period"] == "today" and kpi["max_loss_stop_min"] == 120 and kpi["cost_per_piece"] == 12


def test_unbound_block_saves_without_a_table():
    out = panels.create_panel(body(table_name=None), _admin=ADMIN)
    assert out["metric"] is None


@pytest.mark.parametrize("over, msg", [
    ({"poll_interval_seconds": 15}, "must be one of"),
    ({"source": "table"}, "use source 'kpi'"),
    ({"chart_type": "gauge"}, "use source 'kpi'"),
    ({"options": {"kpi": {"ts_col": "recorded_at", "period": "year"}}}, "period"),
    ({"options": {"kpi": {"ts_col": "recorded_at", "bogus": 1}}}, "unknown keys"),
    ({"options": {"kpi": {"ts_col": "nope"}}}, "ts_col"),
    ({"options": {"kpi": {"ts_col": "recorded_at", "slots": {"speed": "rpm", "defects": "defect_*"}}}},
     "per-machine"),
])
def test_bad_blocks_are_refused(over, msg):
    with pytest.raises(HTTPException) as e:
        panels.create_panel(body(**over), _admin=ADMIN)
    assert e.value.status_code == 400 and msg in e.value.detail


@pytest.mark.parametrize("raw, msg", [
    ({"working_hours": {"start": "7:00", "end": "17:00"}}, "HH:MM"),
    ({"working_hours": {"start": "07:00", "end": "17:00", "days": [0]}}, "weekdays"),
    ({"run_ratio": 2}, "run_ratio"),
    ({"min_stop_sec": 1.5}, "whole number"),
    ({"valid_max": 0}, "valid_max"),
    ({"cost_per_piece": -1}, "cost_per_piece"),
    ({"slots": {"speed": "count_1; drop", "defects": "x"}}, "suffix"),
])
def test_option_validation(raw, msg):
    with pytest.raises(KpiOptionsError, match=msg):
        normalize_kpi_options(raw)


def test_excluded_family_is_left_out(_stubs):
    out = panels.create_panel(body(options={"kpi": {"ts_col": "recorded_at",
                                                    "exclude_families": ["CAM001-13"]}}), _admin=ADMIN)
    assert out["metric"] == "CAM002-13-count_1"


# --- who sees the price -----------------------------------------------------

PANEL = {"id": 9, "source": "kpi", "options": {"kpi": {"cost_per_piece": 12, "period": "today"}}}


def test_operator_list_has_no_price(monkeypatch):
    monkeypatch.setattr(db, "list_panels", lambda dashboard_id=None: [PANEL])
    (seen,) = panels.list_panels(None, user=OPERATOR)
    assert "cost_per_piece" not in seen["options"]["kpi"]
    (seen,) = panels.list_panels(None, user=MANAGER)
    assert seen["options"]["kpi"]["cost_per_piece"] == 12


def test_manager_may_change_poll_to_any_live_interval_on_a_block(monkeypatch):
    monkeypatch.setattr(db, "get_panel", lambda i: PANEL)
    monkeypatch.setattr(db, "update_panel_poll_interval", lambda i, s: {**PANEL, "poll_interval_seconds": s})
    assert auth.require_operator_or_admin(MANAGER) is MANAGER
    out = panels.update_poll_interval(9, panels.PollIntervalIn(poll_interval_seconds=30), user=OPERATOR)
    assert "cost_per_piece" not in out["options"]["kpi"]
    for fast in (5, 10):
        out = panels.update_poll_interval(9, panels.PollIntervalIn(poll_interval_seconds=fast), user=MANAGER)
        assert out["poll_interval_seconds"] == fast
    with pytest.raises(HTTPException):
        panels.update_poll_interval(9, panels.PollIntervalIn(poll_interval_seconds=15), user=MANAGER)


def test_a_block_can_be_created_polling_every_5_or_10_seconds():
    for fast in (5, 10):
        assert panels.create_panel(body(poll_interval_seconds=fast), _admin=ADMIN)  # not refused


def test_manager_is_a_valid_role_but_not_an_admin():
    assert "manager" in users.VALID_ROLES
    assert auth.can_see_cost(MANAGER) and auth.can_see_cost(ADMIN) and not auth.can_see_cost(OPERATOR)
    with pytest.raises(HTTPException):
        auth.require_admin(MANAGER)
