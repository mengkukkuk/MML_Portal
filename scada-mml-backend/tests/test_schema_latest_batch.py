"""POST /api/schema/latest/batch and the one-connection reader behind it.

Route tests call the function directly with db stubbed, as test_router_envelopes
does, and pin the contract the frontend relies on: every item reproduces what
GET /latest would have answered for that binding alone. The reader tests run
against the real app database.
"""
import time

import psycopg
import pytest

import config
import db
import schema as schema_router

USER = {"id": 1, "username": "tester", "role": "admin"}
SOURCES = [1, 2]


def _body(*items):
    return schema_router.LatestBatchIn(items=[schema_router.LatestSpecIn(**i) for i in items])


def _batch(*items, sources=SOURCES):
    return schema_router.get_latest_batch(_body(*items), USER, sources)["results"]


@pytest.fixture
def names(monkeypatch):
    monkeypatch.setattr(db, "datasource_names", lambda ids: {i: f"Plant {i}" for i in ids})


# --- route contract -------------------------------------------------------------
def test_one_read_per_source_for_every_binding(monkeypatch, names):
    calls = []

    def many(specs, ds):
        calls.append((ds, [s["value_col"] for s in specs]))
        return [(True, {"value": ds * 10 + n, "ts": None}, None) for n, _ in enumerate(specs)]

    monkeypatch.setattr(db, "table_latest_many", many)
    results = _batch({"table": "t", "value_col": "a"}, {"table": "t", "value_col": "b"})
    assert sorted(calls) == [(1, ["a", "b"]), (2, ["a", "b"])]
    assert [r["status"] for r in results] == [200, 200]
    assert [(x["value"], x["datasource_name"]) for x in results[1]["readings"]] == [
        (11, "Plant 1"), (21, "Plant 2"),
    ]
    assert [s["ok"] for s in results[0]["sources"]] == [True, True]


def test_bad_binding_is_a_400_for_that_item_only(monkeypatch, names):
    def many(specs, ds):
        return [
            (False, None, "Column not in 't': 'nope'") if s["value_col"] == "nope"
            else (True, {"value": 1, "ts": None}, None)
            for s in specs
        ]

    monkeypatch.setattr(db, "table_latest_many", many)
    good, bad = _batch({"table": "t", "value_col": "v"}, {"table": "t", "value_col": "nope"})
    assert good["status"] == 200
    assert bad["status"] == 400
    assert "nope" in bad["detail"]["error"]
    assert len(bad["detail"]["sources"]) == 2


def test_no_row_anywhere_is_a_404_with_the_source_report(monkeypatch, names):
    monkeypatch.setattr(db, "table_latest_many", lambda specs, ds: [(True, None, None)] * len(specs))
    (only,) = _batch({"table": "t", "value_col": "v"})
    assert only["status"] == 404
    assert only["detail"]["error"] == "No matching row"
    assert all(s["ok"] for s in only["detail"]["sources"])


def test_a_dead_source_only_fails_its_share(monkeypatch, names):
    def many(specs, ds):
        if ds == 2:
            raise psycopg.OperationalError("connection refused")
        return [(True, {"value": 5, "ts": None}, None)] * len(specs)

    monkeypatch.setattr(db, "table_latest_many", many)
    (only,) = _batch({"table": "t", "value_col": "v"})
    assert only["status"] == 200
    assert [r["datasource_id"] for r in only["readings"]] == [1]
    assert [(s["datasource_id"], s["ok"]) for s in only["sources"]] == [(1, True), (2, False)]


def test_pinned_and_selection_items_share_a_source_read(monkeypatch, names):
    calls = []

    def many(specs, ds):
        calls.append((ds, len(specs)))
        return [(True, {"value": 1, "ts": None}, None)] * len(specs)

    monkeypatch.setattr(db, "table_latest_many", many)
    pinned, followed = _batch(
        {"table": "t", "value_col": "v", "datasource_id": 2},
        {"table": "t", "value_col": "w"},
    )
    assert sorted(calls) == [(1, 1), (2, 2)]
    assert [s["datasource_id"] for s in pinned["sources"]] == [2]
    assert [s["datasource_id"] for s in followed["sources"]] == [1, 2]


def test_pinned_source_failure_is_a_400(monkeypatch, names):
    def many(specs, ds):
        raise psycopg.OperationalError("down")

    monkeypatch.setattr(db, "table_latest_many", many)
    (only,) = _batch({"table": "t", "value_col": "v", "datasource_id": 2})
    assert only["status"] == 400


def test_numeric_filter_values_reach_the_query_as_text(monkeypatch, names):
    seen = []
    monkeypatch.setattr(
        db, "table_latest_many",
        lambda specs, ds: seen.extend(s["filter_val"] for s in specs) or [(True, None, None)] * len(specs),
    )
    _batch({"table": "t", "value_col": "v", "filter_col": "id", "filter_val": 7}, sources=[1])
    assert seen == ["7"]


def test_batch_size_is_capped():
    with pytest.raises(ValueError):
        _body(*[{"table": "t", "value_col": "v"}] * (schema_router.MAX_LATEST_BATCH + 1))


# --- reader, against the real database ------------------------------------------
@pytest.fixture
def probe_table():
    name = f"batch_probe_{int(time.time() * 1000)}"
    schema = config.APP_DB_SCHEMA
    with db.get_connection() as conn:
        conn.execute(f'CREATE TABLE "{schema}"."{name}" (tag TEXT, value FLOAT8, ts TIMESTAMPTZ)')
        conn.execute(
            f"""INSERT INTO "{schema}"."{name}" VALUES
                ('A', 1, now() - interval '1 minute'), ('A', 2, now()), ('B', 9, now())"""
        )
        conn.commit()
    yield name
    with db.get_connection() as conn:
        conn.execute(f'DROP TABLE IF EXISTS "{schema}"."{name}"')
        conn.commit()


def _spec(table, value_col="value", tag=None):
    return {"table": table, "value_col": value_col, "filter_col": "tag" if tag else None,
            "filter_val": tag, "ts_col": "ts"}


def test_reader_uses_one_connection_for_every_binding(probe_table, monkeypatch):
    real = db.get_connection
    opened = []

    def counting():
        opened.append(1)
        return real()

    monkeypatch.setattr(db, "get_connection", counting)
    out = db.table_latest_many([_spec(probe_table, tag="A"), _spec(probe_table, tag="B")])
    assert len(opened) == 1
    assert [(ok, row["value"]) for ok, row, _ in out] == [(True, 2.0), (True, 9.0)]


def test_reader_isolates_a_bad_binding(probe_table):
    out = db.table_latest_many([_spec(probe_table, "nope"), _spec(probe_table, tag="B")])
    assert out[0][0] is False and "nope" in out[0][2]
    assert out[1][0] is True and out[1][1]["value"] == 9.0


def test_reader_recovers_the_transaction_after_a_failed_statement(probe_table):
    """A column dropped after it was cached fails at execution, not validation;
    the next binding on the same connection must still be answered."""
    db.table_latest_many([_spec(probe_table, "value")])  # caches the column list
    with db.get_connection() as conn:
        conn.execute(f'ALTER TABLE "{config.APP_DB_SCHEMA}"."{probe_table}" DROP COLUMN value')
        conn.execute(f'ALTER TABLE "{config.APP_DB_SCHEMA}"."{probe_table}" ADD COLUMN v2 FLOAT8 DEFAULT 3')
        conn.commit()
    out = db.table_latest_many([_spec(probe_table, "value", tag="A"), _spec(probe_table, "v2", tag="B")])
    assert out[0] == (True, None, None)  # soft: the column is gone, like fan_out's schema misses
    assert out[1][0] is True and out[1][1]["value"] == 3.0
