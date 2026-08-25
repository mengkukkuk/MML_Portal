"""The response envelope every fanned-out route now returns.

The route functions are called directly rather than through TestClient — the
same choice test_db_boot.py makes, and here it also avoids adding httpx purely
for tests. Dependencies are passed as plain arguments, which is exactly what
FastAPI would do, and the db layer is stubbed so no database is involved.

What is being pinned down is the *contract the frontend unwraps*: rows live
under a named key, every row carries its source, and `sources` is present even
when a plant fails — "no rows" and "no rows because that plant is off" have to
stay distinguishable in the UI.
"""
from datetime import datetime, timedelta

import psycopg
import pytest
from fastapi import HTTPException

import alarms as alarms_router
import db
import events as events_router
import readings as readings_router
import schema as schema_router
import tags as tags_router

USER = {"id": 1, "username": "tester", "role": "admin"}
SOURCES = [1, 2]


@pytest.fixture(autouse=True)
def _names(monkeypatch):
    monkeypatch.setattr(db, "datasource_names",
                        lambda ids: {i: f"Plant {i}" for i in ids})


def _stub(monkeypatch, name, per_source):
    """Replace a db function with one returning `per_source[datasource_id]`."""
    monkeypatch.setattr(
        db, name, lambda *a, datasource_id=None, **k: per_source[datasource_id]
    )


# --- Events -----------------------------------------------------------------
def test_events_envelope_tags_every_row(monkeypatch):
    now = datetime(2026, 1, 1, 12, 0)
    _stub(monkeypatch, "list_recent_events", {
        1: [{"location": "Line 1", "tag_name": "P1", "event": "RUN",
             "at_date_time": now}],
        2: [{"location": "Line 1", "tag_name": "P1", "event": "STOP",
             "at_date_time": now - timedelta(minutes=5)}],
    })
    body = events_router.recent_events(10, USER, SOURCES)
    assert [e["datasource_id"] for e in body["events"]] == [1, 2]
    assert [e["datasource_name"] for e in body["events"]] == ["Plant 1", "Plant 2"]
    assert [s["ok"] for s in body["sources"]] == [True, True]


def test_events_are_newest_first_within_a_machine(monkeypatch):
    """Both plants report the same location/tag; the merged order must still be
    location, tag, then newest first — that is what the page's tree renders."""
    base = datetime(2026, 1, 1, 12, 0)
    _stub(monkeypatch, "list_recent_events", {
        1: [{"location": "Line 1", "tag_name": "P1", "event": "old",
             "at_date_time": base}],
        2: [{"location": "Line 1", "tag_name": "P1", "event": "new",
             "at_date_time": base + timedelta(hours=1)}],
    })
    body = events_router.recent_events(10, USER, SOURCES)
    assert [e["event"] for e in body["events"]] == ["new", "old"]


def test_merge_survives_plants_disagreeing_about_timezones(monkeypatch):
    """One plant's column is timestamptz and the other's is not. Comparing the
    two raises TypeError, which would be a 500 that only appears once a second
    source is selected."""
    from datetime import timezone
    _stub(monkeypatch, "list_recent_events", {
        1: [{"location": "L", "tag_name": "T", "event": "naive",
             "at_date_time": datetime(2026, 1, 1, 10, 0)}],
        2: [{"location": "L", "tag_name": "T", "event": "aware",
             "at_date_time": datetime(2026, 1, 1, 11, 0, tzinfo=timezone.utc)}],
    })
    body = events_router.recent_events(10, USER, SOURCES)
    assert [e["event"] for e in body["events"]] == ["aware", "naive"]


def test_a_dead_plant_still_returns_the_healthy_one(monkeypatch):
    def flaky(limit, datasource_id=None):
        if datasource_id == 2:
            raise psycopg.OperationalError("connection timeout expired")
        return [{"location": "L", "tag_name": "T", "event": "RUN",
                 "at_date_time": datetime(2026, 1, 1)}]

    monkeypatch.setattr(db, "list_recent_events", flaky)
    body = events_router.recent_events(10, USER, SOURCES)
    assert len(body["events"]) == 1
    assert [s["ok"] for s in body["sources"]] == [True, False]
    assert "timeout" in body["sources"][1]["error"]


# --- Alarms -----------------------------------------------------------------
def test_active_alarms_envelope(monkeypatch):
    _stub(monkeypatch, "list_active_alarms", {
        1: [{"alarm_id": 7, "location": "L", "tag_name": "T", "alarm": "hot",
             "severity": 3, "at_date_time": datetime(2026, 1, 1)}],
        2: [],
    })
    body = alarms_router.active_alarms(USER, SOURCES)
    assert body["alarms"][0]["datasource_id"] == 1
    assert len(body["sources"]) == 2
    # The severity coercion lives in the response model, so check it there.
    assert alarms_router.ActiveAlarmOut(**body["alarms"][0]).severity == "critical"


def test_acknowledge_targets_the_row_the_operator_clicked(monkeypatch):
    """The regression this guards: alarm id 42 exists in every plant because
    each alarm_logs has its own sequence, so acknowledging without naming the
    source acks a different plant's alarm."""
    seen = {}

    def ack(alarm_id, user_id, datasource_id=None):
        seen["ds"] = datasource_id
        return {"id": alarm_id, "location": "L", "acknowledged": True}

    monkeypatch.setattr(db, "acknowledge_alarm", ack)
    body = alarms_router.acknowledge(42, 2, USER, SOURCES)
    assert seen["ds"] == 2
    assert body["datasource_id"] == 2 and body["datasource_name"] == "Plant 2"


def test_acknowledge_defaults_to_the_first_selected_source(monkeypatch):
    seen = {}
    monkeypatch.setattr(db, "acknowledge_alarm", lambda a, u, datasource_id=None: (
        seen.update(ds=datasource_id) or {"id": a, "acknowledged": True}))
    alarms_router.acknowledge(42, None, USER, SOURCES)
    assert seen["ds"] == 1


def test_acknowledge_rejects_a_source_outside_the_selection(monkeypatch):
    """A stale tab holding rows from a deselected plant must not write to it."""
    monkeypatch.setattr(db, "acknowledge_alarm",
                        lambda *a, **k: pytest.fail("should not have been called"))
    with pytest.raises(HTTPException) as e:
        alarms_router.acknowledge(1, 99, USER, SOURCES)
    assert e.value.status_code == 400


# --- Tags -------------------------------------------------------------------
def test_tag_fields_is_the_union_not_the_intersection(monkeypatch):
    """A field only one plant has must still be offerable — a panel bound to it
    simply renders no series for the plants that lack it."""
    _stub(monkeypatch, "tag_fields", {
        1: ("current_value", "current_setpoint"),
        2: ("current_value", "flow_rate"),
    })
    fields = [f["field"] for f in tags_router.list_fields(USER, SOURCES)]
    assert fields == ["current_value", "current_setpoint", "flow_rate"]


def test_tag_fields_survives_one_source_being_down(monkeypatch):
    def flaky(datasource_id=None):
        if datasource_id == 2:
            raise psycopg.OperationalError("down")
        return ("current_value",)

    monkeypatch.setattr(db, "tag_fields", flaky)
    assert [f["field"] for f in tags_router.list_fields(USER, SOURCES)] == [
        "current_value"]


def test_latest_tag_is_not_a_404_when_only_one_plant_has_it(monkeypatch):
    """With several plants selected, "this one has no Pump 1" is normal. A 404
    would blank a tile that has perfectly good data from the other source."""
    _stub(monkeypatch, "latest_tag", {
        1: {"tag_name": "Pump 1", "current_value": 3.0},
        2: None,
    })
    body = tags_router.get_latest("Pump 1", USER, SOURCES)
    assert len(body["tags"]) == 1 and body["tags"][0]["datasource_id"] == 1


def test_latest_tag_is_a_404_when_no_plant_has_it(monkeypatch):
    _stub(monkeypatch, "latest_tag", {1: None, 2: None})
    with pytest.raises(HTTPException) as e:
        tags_router.get_latest("nope", USER, SOURCES)
    assert e.value.status_code == 404


# --- Schema (Live panels) ---------------------------------------------------
def test_schema_series_is_one_entry_per_source(monkeypatch):
    """Separate series, not merged points: two plants' readings from the same
    table are unrelated measurements and one line through both is a lie."""
    now = datetime(2026, 1, 1)
    monkeypatch.setattr(db, "table_series", lambda *a: [
        {"ts": now, "value": 1.0}, {"ts": now, "value": 2.0}])
    body = schema_router.get_series("variables_tag", "current_value", "ts",
                                    None, None, 15, USER, SOURCES)
    assert [s["datasource_id"] for s in body["series"]] == [1, 2]
    assert len(body["series"][0]["points"]) == 2


def test_schema_series_uses_the_header_not_a_panel_binding(monkeypatch):
    """`/series` takes no datasource_id at all — the header wins, which is what
    makes one dashboard layout portable between plants."""
    import inspect
    params = inspect.signature(schema_router.get_series).parameters
    assert "datasource_id" not in params

    seen = []
    monkeypatch.setattr(db, "table_series", lambda *a: seen.append(a[-1]) or [])
    schema_router.get_series("t", "v", "ts", None, None, 15, USER, SOURCES)
    assert sorted(seen) == [1, 2]


def test_schema_latest_reports_a_bad_column_as_400(monkeypatch):
    """Every source failing identically is a misconfigured panel, not a partial
    result — a 200 with no rows renders as a chart that never draws, with
    nothing on screen to explain why."""
    def bad(*a):
        raise ValueError("unknown column 'nope'")

    monkeypatch.setattr(db, "table_latest", bad)
    with pytest.raises(HTTPException) as e:
        schema_router.get_latest("t", "nope", None, None, None, USER, SOURCES)
    assert e.value.status_code == 400 and "nope" in e.value.detail


def test_schema_latest_is_404_only_when_sources_answered_but_had_nothing(monkeypatch):
    monkeypatch.setattr(db, "table_latest", lambda *a: None)
    with pytest.raises(HTTPException) as e:
        schema_router.get_latest("t", "v", None, None, None, USER, SOURCES)
    assert e.value.status_code == 404


def test_schema_catalogue_still_honours_an_explicit_datasource(monkeypatch):
    """The panel editor legitimately browses connections nobody has selected."""
    seen = []
    monkeypatch.setattr(db, "list_schema_tables", lambda ds: seen.append(ds) or [])
    schema_router.list_tables(99, USER, SOURCES)
    assert seen == [99]


def test_schema_catalogue_defaults_to_the_first_active_source(monkeypatch):
    """Not the app database: it holds configuration and has no plant tables to
    offer, so the old default could only ever produce an empty picker."""
    seen = []
    monkeypatch.setattr(db, "list_schema_tables", lambda ds: seen.append(ds) or [])
    schema_router.list_tables(None, USER, SOURCES)
    assert seen == [1]


# --- Readings ---------------------------------------------------------------
def test_readings_devices_are_tagged_because_device_id_collides(monkeypatch):
    _stub(monkeypatch, "list_devices", {
        1: [{"id": 1, "name": "Pump"}],
        2: [{"id": 1, "name": "Pump"}],
    })
    body = readings_router.get_devices(USER, SOURCES)
    assert [d["datasource_id"] for d in body["devices"]] == [1, 2]
