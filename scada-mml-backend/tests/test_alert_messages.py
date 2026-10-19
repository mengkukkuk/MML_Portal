"""Alert message sources and /api/alerts/messages.

Run without a database, like test_schema_arrays: the query composition and the
router's handling of "nothing to show" are the logic here, and they are where
the mistakes would be. The plant read is exercised end to end against a live
database separately (see the step-2 verification in the commit message).
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import alert_messages
import db


USER = {"id": 2, "username": "operator", "role": "operator"}
TZ = timezone(timedelta(hours=7))
START = datetime(2026, 10, 18, 8, tzinfo=TZ)
END = START + timedelta(hours=8)

SOURCE = {
    "datasource_id": 7,
    "table_name": "alert_log",
    "ts_col": "created_at",
    "message_col": "message",
    "severity_col": "level",
    "match_col": "line_name",
    "match_filter": "location",
    "updated_at": START,
}

COLUMNS = {
    "id": "integer",
    "created_at": "timestamp with time zone",
    "message": "text",
    "level": "text",
    "line_name": "character varying",
}


# --- severity -----------------------------------------------------------------


@pytest.mark.parametrize("raw, expected", [
    ("crit", "crit"), ("CRITICAL", "crit"), (" Alarm ", "crit"), ("high", "crit"),
    (2, "crit"), (2.0, "crit"), ("2", "crit"), ("2.0", "crit"),
    ("warn", "warn"), ("Warning", "warn"), ("medium", "warn"), (1, "warn"), ("1", "warn"),
    ("info", "info"), ("note", "info"), ("", "info"), (None, "info"), (0, "info"),
    (3, "info"), (1.5, "info"), (True, "info"),
])
def test_severity_is_read_leniently(raw, expected):
    assert db.severity_of(raw) == expected


# --- source validation ----------------------------------------------------------


def test_source_needs_table_time_and_message():
    with pytest.raises(ValidationError):
        alert_messages.AlertSourceIn(datasource_id=7, table_name=" ", ts_col="t", message_col="m")


def test_source_trims_names_and_blanks_optional_ones():
    body = alert_messages.AlertSourceIn(
        datasource_id=7, table_name=" alert_log ", ts_col="created_at", message_col="message", severity_col="  ",
    )
    assert body.table_name == "alert_log"
    assert body.severity_col is None


@pytest.mark.parametrize("match", [
    {"match_col": "line_name"},
    {"match_filter": "location"},
])
def test_match_column_and_filter_come_together(match):
    with pytest.raises(ValidationError):
        alert_messages.AlertSourceIn(datasource_id=7, table_name="a", ts_col="t", message_col="m", **match)


def test_match_filter_is_a_report_filter():
    with pytest.raises(ValidationError):
        alert_messages.AlertSourceIn(
            datasource_id=7, table_name="a", ts_col="t", message_col="m", match_col="x",
            match_filter="device")


@pytest.mark.parametrize("name", ["x" * 64, "bad\x00name", "tab\tname"])
def test_impossible_identifiers_are_refused_at_save(name):
    with pytest.raises(ValidationError):
        alert_messages.AlertSourceIn(datasource_id=7, table_name=name, ts_col="t", message_col="m")


# --- the plant read -------------------------------------------------------------


class _Conn:
    """psycopg stand-in: records the composed query, answers with `rows`."""

    def __init__(self, rows=()):
        self.rows = list(rows)
        self.query = None
        self.params = None

    def execute(self, query, params=None):
        self.query, self.params = query, params
        return self

    def fetchall(self):
        return self.rows


def _stub_plant(monkeypatch, conn, columns=COLUMNS):
    seen = {}

    @contextmanager
    def fake_conn(datasource_id):
        seen["datasource_id"] = datasource_id
        yield conn, "vision_data"

    def fake_safe(c, schema, table, *cols):
        seen["identifiers"] = (schema, table, cols)
        missing = [col for col in cols if col is not None and col not in columns]
        if missing:
            raise ValueError(f"Column not in {table!r}: {missing[0]!r}")
        return dict(columns)

    monkeypatch.setattr(db, "_table_source_conn", fake_conn)
    monkeypatch.setattr(db, "_safe_identifiers", fake_safe)
    return seen


def _text(conn):
    return conn.query.as_string(None)


def test_every_named_column_passes_the_allowlist_gate(monkeypatch):
    conn = _Conn()
    seen = _stub_plant(monkeypatch, conn)
    db.read_alert_messages(SOURCE, START, END, None, 10)
    assert seen["datasource_id"] == 7
    assert seen["identifiers"] == (
        "vision_data", "alert_log", ("created_at", "message", "level", "line_name", None))


def test_query_is_windowed_newest_first_and_capped(monkeypatch):
    conn = _Conn()
    _stub_plant(monkeypatch, conn)
    db.read_alert_messages(SOURCE, START, END, None, 10)
    text = _text(conn)
    assert '"vision_data"."alert_log"' in text
    assert '"created_at" >= %s AND "created_at" <= %s' in text
    assert '"message" IS NOT NULL' in text
    assert text.endswith('ORDER BY "created_at" DESC LIMIT %s')
    assert conn.params == [START, END, 10]


def test_match_value_filters_on_the_match_column(monkeypatch):
    conn = _Conn()
    _stub_plant(monkeypatch, conn)
    db.read_alert_messages(SOURCE, START, END, ["L13"], 10)
    assert '"line_name"::text = %s' in _text(conn)
    assert conn.params == [START, END, "L13", 10]


def test_several_match_values_match_any(monkeypatch):
    conn = _Conn()
    _stub_plant(monkeypatch, conn)
    db.read_alert_messages(SOURCE, START, END, ["L13", "L2"], 10)
    assert '"line_name"::text = ANY(%s)' in _text(conn)
    assert conn.params == [START, END, ["L13", "L2"], 10]


def test_no_match_values_is_no_filter(monkeypatch):
    conn = _Conn()
    _stub_plant(monkeypatch, conn)
    db.read_alert_messages(SOURCE, START, END, [], 10)
    where = _text(conn).split(" WHERE ", 1)[1]
    assert '"line_name"' not in where


def test_without_a_severity_column_every_row_has_none(monkeypatch):
    conn = _Conn()
    _stub_plant(monkeypatch, conn)
    db.read_alert_messages({**SOURCE, "severity_col": None}, START, END, None, 10)
    assert "NULL::text AS severity" in _text(conn)


def test_naive_time_column_converts_the_bounds_not_the_column(monkeypatch):
    conn = _Conn()
    _stub_plant(monkeypatch, conn, {**COLUMNS, "created_at": "timestamp without time zone"})
    db.read_alert_messages(SOURCE, START, END, None, 10)
    text = _text(conn)
    assert "\"created_at\" >= (%s::timestamptz AT TIME ZONE current_setting('TimeZone'))" in text
    assert text.startswith("SELECT (\"created_at\" AT TIME ZONE current_setting('TimeZone')) AS ts")


def test_a_missing_column_is_a_value_error(monkeypatch):
    _stub_plant(monkeypatch, _Conn())
    with pytest.raises(ValueError):
        db.read_alert_messages({**SOURCE, "message_col": "nope"}, START, END, None, 10)


def test_location_and_role_values_are_read_for_the_role_rules(monkeypatch):
    conn = _Conn()
    _stub_plant(monkeypatch, conn, {**COLUMNS, "who": "text"})
    db.read_alert_messages({**SOURCE, "role_col": "who"}, START, END, None, 10)
    text = _text(conn)
    assert '"line_name"::text AS match_value' in text
    assert '"who"::text AS role_value' in text


def test_without_a_role_column_the_role_value_is_null(monkeypatch):
    conn = _Conn()
    _stub_plant(monkeypatch, conn)
    db.read_alert_messages(SOURCE, START, END, None, 10)
    assert "NULL::text AS role_value" in _text(conn)


# --- response roles -----------------------------------------------------------------

# `role_id` deliberately differs from `id`: a tag names the role_id, never the key.
RULES = [
    {"id": 1, "role_id": 11, "code": "it", "name_th": "ทีมระบบอัตโนมัติ",
     "name_en": "Automation team", "location": "Line 1", "priority": 10},
    {"id": 2, "role_id": 12, "code": "l13-sup", "name_th": "หัวหน้าไลน์ 13",
     "name_en": "Line 13 supervisor", "location": "Line 13", "priority": 20},
    {"id": 3, "role_id": 13, "code": "maint", "name_th": "ช่างซ่อมบำรุง",
     "name_en": "Maintenance", "location": "Line 1", "priority": 30},
    {"id": 4, "role_id": 7, "code": "op", "name_th": "พนักงานคุมเครื่อง",
     "name_en": "Operator", "location": None, "priority": 999},
]


def role(**kw):
    kw.setdefault("location", None)
    r = db.match_response_role(RULES, **kw)
    return r and r["code"]


def test_the_first_matching_rule_wins():
    # Two rules name Line 1; the lower priority number is tried first.
    assert role(location="Line 1") == "it"


def test_location_ignores_case_and_spaces():
    for spelt in ("Line 13", "Line13", " line 13 ", "LINE13"):
        assert role(location=spelt) == "l13-sup"
    assert role(location="Line 2") == "op"


def test_a_rule_with_no_conditions_is_the_catch_all():
    assert role() == "op"
    assert db.match_response_role(RULES[:3], location=None) is None


def test_the_row_role_id_wins_over_every_rule():
    # Tagged with role_id 7 (the operator), though the Line 1 rule would say "it".
    for tag in ("7", " 7 ", "7.0", 7):
        got = db.match_response_role(RULES, location="Line 1", explicit=tag)
        assert got == {"id": 7, "code": "op", "name_th": "พนักงานคุมเครื่อง", "name_en": "Operator"}
    assert role(location="Line 1", explicit="  ") == "it"
    assert role(location="Line 1", explicit=None) == "it"


def test_the_tag_is_the_role_id_not_the_primary_key():
    # id 3 is maintenance, but nothing has role_id 3.
    assert db.match_response_role(RULES, location=None, explicit="3")["id"] is None
    assert role(explicit="13") == "maint"


def test_a_role_code_is_accepted_as_the_tag_too():
    # alarm_logs carries a text role, not our id.
    assert role(explicit=" MAINT ") == "maint"


def test_a_tag_naming_no_role_is_shown_as_written():
    unknown = db.match_response_role(RULES, location=None, explicit="99")
    assert unknown == {"id": None, "code": "99", "name_th": "99", "name_en": "99"}
    assert role(explicit="QC lead") == "QC lead"


def test_role_input_trims_and_treats_blank_conditions_as_any():
    body = alert_messages.ResponseRoleIn(code=" maint ", name_th="ช่าง", name_en="Maintenance",
                                         location="  ", role_id=13)
    assert body.code == "maint" and body.location is None and body.role_id == 13
    dumped = body.model_dump()
    assert "severity" not in dumped and "keyword" not in dumped
    assert alert_messages.ResponseRoleIn(code="x", name_th="x", name_en="x").role_id is None
    with pytest.raises(ValidationError):
        alert_messages.ResponseRoleIn(code=" ", name_th="x", name_en="x")
    with pytest.raises(ValidationError):
        alert_messages.ResponseRoleIn(code="x", name_th="x", name_en="x", role_id=0)


def test_a_taken_role_id_is_a_conflict(monkeypatch):
    def taken(**fields):
        raise psycopg.errors.UniqueViolation("duplicate key value")
    monkeypatch.setattr(db, "create_response_role", taken)
    body = alert_messages.ResponseRoleIn(code="x", name_th="x", name_en="x", role_id=7)
    with pytest.raises(HTTPException) as err:
        alert_messages.create_role(body, _admin={})
    assert err.value.status_code == 409


# --- /messages -------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _rules(monkeypatch):
    """Role rules come from the app database; these tests run without one."""
    monkeypatch.setattr(db, "list_response_roles", lambda: list(RULES))


def _messages(**kw):
    args = {"start": START, "end": END, "location": [],
            "camera": [], "limit": alert_messages.MAX_MESSAGES, "_user": USER}
    return alert_messages.get_alert_messages(**{**args, **kw})


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(db, "get_alert_source", lambda: dict(SOURCE))
    calls = []

    def read(source, start, end, match_values, limit):
        calls.append({"match_values": match_values, "limit": limit})
        return [
            {"ts": END - timedelta(minutes=i), "message": f"m{i}", "severity": s}
            for i, s in enumerate(["crit", "1", None])
        ]

    monkeypatch.setattr(db, "read_alert_messages", read)
    return calls


def test_no_source_is_an_answer_not_an_error(monkeypatch):
    monkeypatch.setattr(db, "get_alert_source", lambda: None)
    body = _messages()
    assert body == {"configured": False, "available": False, "reason": "not_configured"}
    alert_messages.AlertMessagesOut(**body)


def test_each_message_carries_its_role(monkeypatch):
    monkeypatch.setattr(db, "get_alert_source", lambda: dict(SOURCE))
    monkeypatch.setattr(db, "read_alert_messages", lambda *a, **k: [
        {"ts": END, "message": "Motor overload", "severity": "critical", "match_value": "Line1", "role_value": None},
        {"ts": END, "message": "Speed low", "severity": "warning", "match_value": "Line13", "role_value": None},
        {"ts": END, "message": "Anything", "severity": "info", "match_value": None, "role_value": "13"},
    ])
    body = alert_messages.AlertMessagesOut(**_messages())
    assert [m.role.code for m in body.messages] == ["it", "l13-sup", "maint"]
    assert [m.role.id for m in body.messages] == [11, 12, 13]


def test_role_rules_failing_costs_the_roles_not_the_messages(monkeypatch, configured):
    def down():
        raise psycopg.OperationalError("app db down")
    monkeypatch.setattr(db, "list_response_roles", down)
    body = alert_messages.AlertMessagesOut(**_messages())
    assert len(body.messages) == 3 and all(m.role is None for m in body.messages)


def test_messages_come_from_the_source_connection(configured):
    # One source for every trend: the answer names the connection it was read
    # from, whichever connection the asking trend plots.
    body = _messages()
    assert body["datasource_id"] == SOURCE["datasource_id"]


def test_messages_carry_normalised_severity(configured):
    body = alert_messages.AlertMessagesOut(**_messages())
    assert body.available and body.configured
    assert [m.severity for m in body.messages] == ["crit", "warn", "info"]
    assert [m.severity_raw for m in body.messages] == ["crit", "1", None]
    assert body.truncated is False
    assert body.match_filter == "location"


def test_blank_messages_are_not_drawn(monkeypatch):
    monkeypatch.setattr(db, "get_alert_source", lambda: dict(SOURCE))
    monkeypatch.setattr(db, "read_alert_messages", lambda *a, **k: [
        {"ts": END, "message": "   ", "severity": "crit"},
        {"ts": END, "message": "real", "severity": None},
    ])
    body = _messages()
    assert [m["message"] for m in body["messages"]] == ["real"]


def test_cap_is_read_one_past_and_reported(configured):
    body = _messages(limit=2)
    assert configured[-1]["limit"] == 3
    assert len(body["messages"]) == 2
    assert body["truncated"] is True


def test_only_the_followed_filter_narrows(configured):
    _messages(location=[" L13 ", "L2", "L13"], camera=["CAM001"])
    assert configured[-1]["match_values"] == ["L13", "L2"]
    _messages(camera=["CAM001"])
    assert configured[-1]["match_values"] == []
    _messages(location=["   "])
    assert configured[-1]["match_values"] == []


def test_too_many_filter_values_is_422(configured):
    with pytest.raises(HTTPException) as exc:
        _messages(location=[f"L{i}" for i in range(alert_messages.MAX_MATCH_VALUES + 1)])
    assert exc.value.status_code == 422


@pytest.mark.parametrize("error, reason", [
    (ValueError("Table not allowed: 'alert_log'"), "missing"),
    # The allowlist gate caches; a table dropped since is Postgres' error to raise.
    (psycopg.errors.UndefinedTable('relation "vision_data.alert_log" does not exist'), "missing"),
    (psycopg.errors.UndefinedColumn('column "level" does not exist'), "missing"),
    (psycopg.OperationalError("connection timeout expired\nmore"), "unreachable"),
    (psycopg.errors.InsufficientPrivilege("permission denied"), "error"),
])
def test_a_failed_read_says_why_and_keeps_200(monkeypatch, error, reason):
    monkeypatch.setattr(db, "get_alert_source", lambda: dict(SOURCE))

    def fail(*a, **k):
        raise error

    monkeypatch.setattr(db, "read_alert_messages", fail)
    body = alert_messages.AlertMessagesOut(**_messages())
    assert body.configured is True and body.available is False
    assert body.reason == reason
    assert "\n" not in body.detail
    assert body.messages == []


@pytest.mark.parametrize("bounds", [
    {"start": START.replace(tzinfo=None)},
    {"end": START},
    {"start": END, "end": START},
    {"end": START + timedelta(days=367)},
])
def test_bad_windows_are_refused_before_any_read(monkeypatch, bounds):
    monkeypatch.setattr(db, "get_alert_source", lambda: pytest.fail("read a source"))
    with pytest.raises(HTTPException) as exc:
        _messages(**bounds)
    assert exc.value.status_code == 422


# --- /source ----------------------------------------------------------------------


def test_saving_a_source_for_a_table_that_does_not_exist_yet(monkeypatch):
    monkeypatch.setattr(db, "get_datasource", lambda ds: {"id": ds})
    saved = {}

    def store(ds, **fields):
        saved.update(fields, datasource_id=ds)
        return {"datasource_id": ds, "datasource_name": "MML cam", "updated_at": START, **fields}

    monkeypatch.setattr(db, "set_alert_source", store)

    def missing(*a, **k):
        raise ValueError("Table not allowed: 'alert_log'")

    monkeypatch.setattr(db, "read_alert_messages", missing)
    body = alert_messages.put_alert_source(
        alert_messages.AlertSourceIn(datasource_id=294, table_name="alert_log",
                                     ts_col="created_at", message_col="message"),
        _admin=USER,
    )
    out = alert_messages.AlertSourceOut(**body)
    assert saved["datasource_id"] == 294 and saved["table_name"] == "alert_log"
    assert saved["match_filter"] is None
    assert out.configured is True and out.datasource_name == "MML cam"
    assert out.available is False and out.reason == "missing"


def test_a_source_names_its_connection():
    with pytest.raises(ValidationError):
        alert_messages.AlertSourceIn(table_name="a", ts_col="t", message_col="m")


def test_saving_for_an_unknown_datasource_is_404(monkeypatch):
    monkeypatch.setattr(db, "get_datasource", lambda ds: None)
    monkeypatch.setattr(db, "set_alert_source", lambda *a, **k: pytest.fail("saved"))
    with pytest.raises(HTTPException) as exc:
        alert_messages.put_alert_source(
            alert_messages.AlertSourceIn(datasource_id=7, table_name="a", ts_col="t", message_col="m"),
            _admin=USER)
    assert exc.value.status_code == 404


def test_no_source_reads_as_unconfigured(monkeypatch):
    monkeypatch.setattr(db, "get_alert_source", lambda: None)
    out = alert_messages.AlertSourceOut(**alert_messages.get_alert_source(_user=USER))
    assert out.configured is False and out.available is None


def test_a_readable_source_reads_as_available(monkeypatch):
    monkeypatch.setattr(db, "get_alert_source", lambda: dict(SOURCE))
    monkeypatch.setattr(db, "read_alert_messages", lambda *a, **k: [])
    out = alert_messages.AlertSourceOut(**alert_messages.get_alert_source(_user=USER))
    assert out.available is True and out.reason is None


def test_deleting_nothing_is_404(monkeypatch):
    monkeypatch.setattr(db, "delete_alert_source", lambda: False)
    with pytest.raises(HTTPException) as exc:
        alert_messages.delete_alert_source(_admin=USER)
    assert exc.value.status_code == 404


def test_writes_are_admin_only():
    routes = {(r.path, tuple(sorted(r.methods))): r for r in alert_messages.router.routes}
    for path, methods in [("/api/alerts/source", ("PUT",)),
                          ("/api/alerts/source", ("DELETE",)),
                          ("/api/alerts/roles", ("POST",)),
                          ("/api/alerts/roles/{role_id}", ("PUT",)),
                          ("/api/alerts/roles/{role_id}", ("DELETE",))]:
        deps = [d.call for d in routes[(path, methods)].dependant.dependencies]
        assert alert_messages.require_admin in deps
