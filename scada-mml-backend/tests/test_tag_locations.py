"""variables_tag locations for the Reports trend's Location control.

A wide table like `sensor_log1` has one column per tag; variables_tag says which
line each tag is on. These run without a database: the connection is a stub
that answers the two reads `tag_locations` makes.
"""
from contextlib import contextmanager

import psycopg

import db
import tags


class _Conn:
    """Answers the column probe, then the tag read, in that order."""

    def __init__(self, has_location, rows=()):
        self.answers = [[{"?column?": 1}] if has_location else [], list(rows)]
        self.queries = []

    def execute(self, query, params=None):
        self.queries.append(query)
        self._rows = self.answers[len(self.queries) - 1]
        return self

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


def _stub(monkeypatch, conn, seen=None):
    @contextmanager
    def fake_conn(datasource_id):
        if seen is not None:
            seen.append(datasource_id)
        yield conn, "public"

    monkeypatch.setattr(db, "_table_source_conn", fake_conn)


def test_rows_come_back_from_the_tag_table(monkeypatch):
    rows = [{"tag_name": "CAM001-13-count_1", "location": "Line 13"}]
    conn = _Conn(True, rows)
    _stub(monkeypatch, conn)
    assert db.tag_locations(3) == rows
    text = conn.queries[1].as_string(None)
    assert "btrim" in text and '"public"."variables_tag"' in text


def test_a_tag_table_without_location_gives_nothing(monkeypatch):
    conn = _Conn(False)
    _stub(monkeypatch, conn)
    assert db.tag_locations(3) == []
    assert len(conn.queries) == 1


def test_the_route_falls_back_to_the_first_selected_source(monkeypatch):
    seen = []
    _stub(monkeypatch, _Conn(True, []), seen)
    tags.list_tag_locations(datasource_id=None, _user={}, datasource_ids=[7, 9])
    assert seen == [7]


def test_an_explicit_source_wins(monkeypatch):
    seen = []
    _stub(monkeypatch, _Conn(True, []), seen)
    tags.list_tag_locations(datasource_id=2, _user={}, datasource_ids=[7])
    assert seen == [2]


def test_an_unreachable_source_is_an_empty_map_not_an_error(monkeypatch):
    def boom(datasource_id=None):
        raise psycopg.OperationalError("connection refused")

    monkeypatch.setattr(db, "tag_locations", boom)
    assert tags.list_tag_locations(datasource_id=1, _user={}, datasource_ids=[1]) == {"tags": []}
