"""The minute-bucket query (db/kpi.py), composed without a database.

What matters here is what reaches the SQL text: identifiers quoted, array
columns read at slot 0, naive timestamps compared in the connection's timezone,
and no value ever formatted in. The arithmetic itself is checked end to end
against the showcase table (simulate_kpi_showcase.py).
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pytest

import db

COLUMNS = {
    "recorded_at": "timestamp with time zone",
    "CAM001-13-count_1": "_float8",
    "CAM001-13-defect_1": "_float8",
    "CAM001-13-defect_2": "_float8",
    "speed_plain": "double precision",
}
FAMILY = {"key": "CAM001-13", "speed": "CAM001-13-count_1",
          "defects": ["CAM001-13-defect_1", "CAM001-13-defect_2"]}


def text(query):
    return query.as_string(None)


def test_array_columns_read_slot_zero_and_identifiers_are_quoted():
    q = text(db.kpi_minute_query(COLUMNS, "public", "sensor_log1", "recorded_at", [FAMILY]))
    assert '("CAM001-13-count_1"[1])::float8' in q
    assert '("CAM001-13-defect_2"[1])::float8' in q
    assert '"public"."sensor_log1"' in q
    assert "%(vmax)s" in q and "%(stop)s" in q


def test_scalar_columns_read_as_is():
    fam = {"key": "x", "speed": "speed_plain", "defects": []}
    q = text(db.kpi_minute_query(COLUMNS, "public", "t", "recorded_at", [fam]))
    assert '("speed_plain")::float8' in q


def test_naive_timestamp_compared_in_connection_timezone():
    cols = {**COLUMNS, "recorded_at": "timestamp without time zone"}
    q = text(db.kpi_minute_query(cols, "public", "t", "recorded_at", [FAMILY]))
    assert "(%(lo)s::timestamptz AT TIME ZONE current_setting('TimeZone'))" in q
    assert "(\"recorded_at\" AT TIME ZONE current_setting('TimeZone')) AS ts" in q


@pytest.mark.parametrize("bad", ["nope", 'x"; DROP TABLE users; --'])
def test_unknown_columns_are_refused(bad):
    with pytest.raises(ValueError):
        db.kpi_minute_query(COLUMNS, "public", "t", "recorded_at", [{**FAMILY, "speed": bad}])
    with pytest.raises(ValueError):
        db.kpi_minute_query(COLUMNS, "public", "t", bad, [FAMILY])


class _Conn:
    def __init__(self, rows):
        self.rows, self.calls = rows, []

    @contextmanager
    def transaction(self):
        yield

    def execute(self, query, params=None):
        self.calls.append((query, params))
        return self

    def fetchall(self):
        return self.rows


def test_buckets_unpack_per_family_and_clamp(monkeypatch):
    minute = datetime(2026, 10, 21, 8, 0, tzinfo=timezone.utc)
    conn = _Conn([{"minute": minute, "valid_0": 70.0, "stop_0": 80.0, "ssum_0": 600.0,
                   "sn_0": 6, "pcs_0": 100.0, "def_0": 3.0,
                   "part_0_0": 2.0, "part_0_1": 1.0}])

    @contextmanager
    def fake_conn(datasource_id):
        yield conn, "public"

    monkeypatch.setattr(db, "_table_source_conn", fake_conn)
    monkeypatch.setattr(db, "_table_columns", lambda c, s, t: COLUMNS)
    out = db.kpi_minute_buckets(5, "sensor_log1", "recorded_at", [FAMILY],
                                minute, minute + timedelta(minutes=1), valid_max=50_000)
    (bucket,) = out["CAM001-13"]
    assert bucket["valid_s"] == 60.0 and bucket["stop_s"] == 60.0 and bucket["gap_s"] == 0.0
    assert bucket["pieces"] == 100.0 and bucket["defects"] == 3.0
    assert bucket["parts"] == [2.0, 1.0]
    params = conn.calls[-1][1]
    assert params["cap_s"] == 30 and params["vmax"] == 50_000
    assert "statement_timeout" in text(conn.calls[0][0])
