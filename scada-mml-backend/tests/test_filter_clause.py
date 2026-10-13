"""`_filter_clause`: filters that keep an integer column's index usable.

The old ``{col}::text = %s`` matched any column type but hid integer columns
from their indexes. The integer path must match exactly the rows the text
compare matched -- no more, no fewer -- and fall back whenever it cannot.
"""
import time

import pytest
from psycopg import sql

import config
import db

COLUMNS = {"line_id": "integer", "tag": "text", "ts": "timestamp with time zone"}


def _render(clause, conn):
    return clause.as_string(conn)


@pytest.fixture
def plant():
    name = f"filter_probe_{int(time.time() * 1000)}"
    schema = config.APP_DB_SCHEMA
    with db.get_connection() as conn:
        conn.execute(
            f'CREATE TABLE "{schema}"."{name}" (line_id INTEGER, tag TEXT, value FLOAT8, ts TIMESTAMPTZ)'
        )
        conn.execute(f'CREATE INDEX ON "{schema}"."{name}" (line_id)')
        conn.execute(
            f"""INSERT INTO "{schema}"."{name}"
                SELECT g % 50, 'T' || (g % 50), g, now() - make_interval(secs => g)
                FROM generate_series(1, 5000) g"""
        )
        conn.execute(f'ANALYZE "{schema}"."{name}"')
        conn.commit()
    yield name
    with db.get_connection() as conn:
        conn.execute(f'DROP TABLE IF EXISTS "{schema}"."{name}"')
        conn.commit()


def test_canonical_integer_on_integer_column_compares_as_integer():
    with db.get_connection() as conn:
        clause, param = db._filter_clause(COLUMNS, "line_id", "7")
        assert _render(clause, conn) == '"line_id" = %s'
    assert param == 7


@pytest.mark.parametrize("value", ["07", "7.0", " 7", "seven", "+7"])
def test_non_canonical_values_keep_the_text_compare(value):
    with db.get_connection() as conn:
        clause, param = db._filter_clause(COLUMNS, "line_id", value)
        assert _render(clause, conn) == '"line_id"::text = %s'
    assert param == value


def test_text_columns_keep_the_text_compare():
    with db.get_connection() as conn:
        clause, param = db._filter_clause(COLUMNS, "tag", "7")
        assert _render(clause, conn) == '"tag"::text = %s'
    assert param == "7"


def test_integer_filter_returns_the_same_row(plant):
    row = db.table_latest(plant, "value", "line_id", "7", "ts")
    assert row is not None and int(row["value"]) % 50 == 7


@pytest.mark.parametrize("value", ["07", "abc"])
def test_values_that_never_matched_still_do_not_match(plant, value):
    assert db.table_latest(plant, "value", "line_id", value, "ts") is None


def _plan(plant, clause, param):
    query = sql.SQL("EXPLAIN SELECT value FROM {} WHERE ").format(
        sql.Identifier(config.APP_DB_SCHEMA, plant)) + clause
    with db.get_connection() as conn:
        conn.execute("SET LOCAL enable_seqscan = off")
        return "\n".join(r["QUERY PLAN"] for r in conn.execute(query, [param]).fetchall())


def test_integer_filter_uses_the_index_the_text_cast_could_not(plant):
    columns = {"line_id": "integer"}
    new_plan = _plan(plant, *db._filter_clause(columns, "line_id", "7"))
    old_plan = _plan(plant, sql.SQL('"line_id"::text = %s'), "7")
    assert "Index" in new_plan
    assert "Seq Scan" in old_plan
