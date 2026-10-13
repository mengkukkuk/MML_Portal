"""The introspection cache behind `_safe_identifiers` (db/tables.py).

Every plant read is gated by `_safe_identifiers`; uncached it costs two
information_schema queries per poll. These tests run against the real app
database in a throwaway schema and count the catalog queries a connection sees.
"""
import time

import pytest

import config
import db


class CountingConn:
    """A real connection that counts the information_schema queries sent through it."""

    def __init__(self, conn):
        self._conn = conn
        self.catalog_queries = 0

    @property
    def info(self):
        return self._conn.info

    def execute(self, query, params=None):
        text = query if isinstance(query, str) else query.as_string(self._conn)
        if "information_schema" in text:
            self.catalog_queries += 1
        return self._conn.execute(query, params)


@pytest.fixture
def plant():
    name = f"cache_{int(time.time() * 1000)}"
    with db.get_connection() as conn:
        conn.execute(f'CREATE SCHEMA "{name}"')
        conn.execute(f'CREATE TABLE "{name}".probe (tag TEXT, value FLOAT8, ts TIMESTAMPTZ)')
        conn.commit()
    yield name
    with db.get_connection() as conn:
        conn.execute(f'DROP SCHEMA "{name}" CASCADE')
        conn.commit()


def test_second_lookup_skips_information_schema(plant):
    with db.get_connection() as raw:
        conn = CountingConn(raw)
        db._safe_identifiers(conn, plant, "probe", "value", "tag", "ts")
        first = conn.catalog_queries
        db._safe_identifiers(conn, plant, "probe", "value", "tag", "ts")
    assert first == 2
    assert conn.catalog_queries == first


def test_new_column_is_accepted_without_waiting_for_the_ttl(plant):
    with db.get_connection() as raw:
        db._safe_identifiers(raw, plant, "probe", "value")
        raw.execute(f'ALTER TABLE "{plant}".probe ADD COLUMN extra FLOAT8')
        raw.commit()
        columns = db._safe_identifiers(raw, plant, "probe", "extra")
    assert "extra" in columns


def test_unknown_names_are_still_refused(plant):
    with db.get_connection() as raw:
        db._safe_identifiers(raw, plant, "probe", "value")
        with pytest.raises(ValueError):
            db._safe_identifiers(raw, plant, "probe", "nope")
        with pytest.raises(ValueError):
            db._safe_identifiers(raw, plant, "not_a_table", "value")


def test_sensitive_tables_are_never_cached_into_reach(plant):
    with db.get_connection() as raw:
        with pytest.raises(ValueError):
            db._safe_identifiers(raw, plant, "users", "password_hash")


def test_ttl_zero_disables_the_cache(plant, monkeypatch):
    monkeypatch.setattr(config, "SCHEMA_CACHE_TTL_S", 0)
    with db.get_connection() as raw:
        conn = CountingConn(raw)
        db._safe_identifiers(conn, plant, "probe", "value")
        db._safe_identifiers(conn, plant, "probe", "value")
    assert conn.catalog_queries == 4


def test_expired_entries_are_re_read(plant, monkeypatch):
    with db.get_connection() as raw:
        conn = CountingConn(raw)
        db._safe_identifiers(conn, plant, "probe", "value")
        monkeypatch.setattr(config, "SCHEMA_CACHE_TTL_S", 1e-9)
        db._safe_identifiers(conn, plant, "probe", "value")
    assert conn.catalog_queries == 4


def test_dropping_a_pool_forgets_cached_tables(plant):
    with db.get_connection() as raw:
        conn = CountingConn(raw)
        db._safe_identifiers(conn, plant, "probe", "value")
        db.drop_pool(987654321)  # any id: an edited datasource clears everything
        db._safe_identifiers(conn, plant, "probe", "value")
    assert conn.catalog_queries == 4
