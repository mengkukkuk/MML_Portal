"""Fan-out across selected datasources.

No database is touched: the callable handed to `fan_out` is arbitrary, so the
tests supply one directly and patch only `datasource_names` (a localhost lookup)
away. What is under test is the error *contract* — a fan-out that lets one dead
plant's exception escape would take down a page that has two healthy plants on
it, which is precisely the coupling this whole change exists to remove.
"""
import threading
import time

import psycopg
import pytest

import db


@pytest.fixture(autouse=True)
def _names(monkeypatch):
    """Skip the localhost round trip that labels each source."""
    monkeypatch.setattr(db, "datasource_names",
                        lambda ids: {i: f"ds{i}" for i in ids})


def test_order_follows_input_not_completion(monkeypatch):
    """Callers zip these against nothing — they index by position. A result list
    ordered by completion would silently attribute one plant's rows to another."""
    def slow_first(ds_id):
        time.sleep(0.15 if ds_id == 1 else 0)
        return ds_id

    out = db.fan_out([1, 2, 3], slow_first)
    assert [r["datasource_id"] for r in out] == [1, 2, 3]
    assert [r["result"] for r in out] == [1, 2, 3]


def test_runs_concurrently_not_sequentially():
    """The reason this is threaded at all: /api/alarms/active polls at 1 Hz, so
    N sources must cost max(...) and not sum(...)."""
    def sleeper(_ds_id):
        time.sleep(0.2)
        return True

    started = time.monotonic()
    db.fan_out([1, 2, 3, 4], sleeper)
    assert time.monotonic() - started < 0.6, "sources were queried in series"


def test_one_dead_source_does_not_take_down_the_others():
    """The core isolation guarantee. A powered-off plant raises
    OperationalError from libpq; the healthy sources must still return rows."""
    def maybe(ds_id):
        if ds_id == 2:
            raise psycopg.OperationalError("connection timeout expired")
        return [{"v": ds_id}]

    rows, sources = db.fan_out_rows([1, 2, 3], maybe)
    assert [r["v"] for r in rows] == [1, 3]
    assert [s["ok"] for s in sources] == [True, False, True]
    assert "timeout expired" in sources[1]["error"]


def test_a_plant_missing_the_table_is_reported_not_raised():
    """UndefinedTable is a ProgrammingError, not an OperationalError — a guard
    narrowed to connection failures would let this one propagate."""
    def missing(_ds_id):
        raise psycopg.errors.UndefinedTable('relation "event_logs" does not exist')

    out = db.fan_out([7], missing)
    assert out[0]["ok"] is False
    assert "event_logs" in out[0]["error"]


def test_error_is_first_line_only():
    """psycopg errors carry a multi-line HINT/CONTEXT tail. It ends up in a JSON
    response body, so only the first line travels."""
    def noisy(_ds_id):
        raise psycopg.OperationalError("could not connect\nHINT: is the server running?")

    assert db.fan_out([1], noisy)[0]["error"] == "could not connect"


def test_timeout_is_recorded_not_raised():
    release = threading.Event()

    def hang(_ds_id):
        release.wait(10)
        return "late"

    try:
        out = db.fan_out([1], hang, timeout=0.1)
        assert out[0]["ok"] is False
        assert out[0]["error"] == "timed out"
    finally:
        release.set()  # let the abandoned worker retire


def test_timeout_budget_is_shared_across_sources():
    """`timeout` is a budget for the whole fan-out, not per source: otherwise
    N dead plants cost N x the timeout on a 1 Hz endpoint."""
    release = threading.Event()

    def hang(_ds_id):
        release.wait(10)
        return None

    try:
        started = time.monotonic()
        out = db.fan_out([1, 2, 3], hang, timeout=0.2)
        elapsed = time.monotonic() - started
        assert all(r["ok"] is False for r in out)
        assert elapsed < 0.5, "each source restarted the clock"
    finally:
        release.set()


def test_rows_are_tagged_with_their_source():
    """Two plants both reporting 'Line 1' are otherwise indistinguishable — this
    tag is what React keys and the acknowledge path use to tell them apart."""
    rows, _ = db.fan_out_rows([1, 2], lambda ds: [{"location": "Line 1"}])
    assert [(r["location"], r["datasource_id"], r["datasource_name"]) for r in rows] == [
        ("Line 1", 1, "ds1"),
        ("Line 1", 2, "ds2"),
    ]


def test_source_report_survives_a_source_returning_nothing():
    """An empty result is not a failure. The header still has to be able to say
    the source was consulted."""
    rows, sources = db.fan_out_rows([1], lambda _ds: [])
    assert rows == []
    assert sources == [{"datasource_id": 1, "datasource_name": "ds1",
                        "ok": True, "error": None}]


def test_empty_selection_is_a_no_op():
    assert db.fan_out([], lambda _ds: 1) == []
    assert db.fan_out_rows([], lambda _ds: [{}]) == ([], [])


def test_app_db_participates_as_none():
    """[None] is the fresh-install tier of the resolver, so it must fan out like
    any other source rather than being special-cased out."""
    out = db.fan_out([None], lambda ds: ds is None)
    assert out[0]["datasource_id"] is None and out[0]["result"] is True
