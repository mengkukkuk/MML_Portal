"""Numeric-array columns end to end: discovery, categorisation, and /series.

A `float[]` column carries several readings taken at one instant — a measured
value beside its setpoint and limits. Before this, information_schema's bare
'ARRAY' data_type meant such a column had no type the catalogue recognised, so
it fell out of `value_columns` by type and back into `filter_columns` by
negation: invisible where it was needed, offered where it was useless.

These run without a database. `describe_table`'s categorisation and `/series`'
row filtering are the two pieces of pure logic in that path, and they are where
the mistakes are.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal

import pytest

import db
import schema


# One table with every category represented, so each assertion is also a check
# that the others did not swallow the column under test.
COLUMNS = {
    "id": "integer",
    "code": "text",
    "location": "character varying",
    "reading": "_float8",          # float[] — the column this feature exists for
    "counts": "_int4",             # integer[]
    "labels": "_text",             # an array, but not a numeric one
    "temperature": "double precision",
    "recorded_at": "timestamp with time zone",
}

TS = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


class _RecordingConn:
    """Minimal psycopg stand-in: remembers the composed query, returns nothing."""

    def __init__(self):
        self.query = None
        self.params = None

    def execute(self, query, params=None):
        self.query, self.params = query, params
        return self

    def fetchall(self):
        return []


def _stub_conn(monkeypatch, conn=None):
    """Route every plant read at `conn` (or nothing) instead of a database."""

    @contextmanager
    def fake_conn(datasource_id):
        yield conn, "public"

    monkeypatch.setattr(db, "_table_source_conn", fake_conn)
    monkeypatch.setattr(db, "_safe_identifiers", lambda *a, **k: dict(COLUMNS))


def _query_text(conn):
    q = conn.query
    return q.as_string(None) if hasattr(q, "as_string") else str(q)


# --- catalogue ---------------------------------------------------------------


@pytest.fixture
def described(monkeypatch):
    """`describe_table` over COLUMNS, with its two DB reads stubbed out."""
    _stub_conn(monkeypatch)
    monkeypatch.setattr(db, "_table_columns", lambda c, s, t: dict(COLUMNS))
    monkeypatch.setattr(db, "_primary_key_columns", lambda c, s, t: {"id"})
    return db.describe_table("probe")


def test_numeric_arrays_are_offered_on_their_own(described):
    assert described["array_value_columns"] == ["reading", "counts"]


def test_numeric_arrays_stay_out_of_value_columns(described):
    # Everything downstream of `value_columns` — gauges, thresholds, the Live
    # trend — can only draw one number.
    assert described["value_columns"] == ["temperature"]


def test_numeric_arrays_are_not_filter_candidates(described):
    # The bug this had to fix first: `filter_columns` is a negation, so a column
    # with no recognised type landed in it and was offered as a device selector
    # that distinct_column_values would answer with literal '{1.2,3.4}' strings.
    assert "reading" not in described["filter_columns"]
    assert "counts" not in described["filter_columns"]


def test_text_arrays_are_neither_values_nor_filters(described):
    # Not plottable, but also not one value that could name a row — it must not
    # reappear in the filter list by negation either.
    assert "labels" not in described["array_value_columns"]
    assert "labels" not in described["value_columns"]
    assert "labels" not in described["filter_columns"]


def test_identifying_columns_are_still_filters(described):
    assert set(described["filter_columns"]) >= {"code", "location", "recorded_at"}
    assert described["ts_columns"] == ["recorded_at"]


# --- /series row filtering ---------------------------------------------------


def _series(rows, monkeypatch, limit=5000):
    """Drive the real route body over `rows`, with the fan-out collapsed."""
    monkeypatch.setattr(db, "table_series", lambda *a, **k: rows)
    monkeypatch.setattr(
        db, "fan_out_rows",
        lambda targets, query, label="": (query(targets[0]), []),
    )
    out = schema.get_series(
        table="probe", value_col="reading", ts_col="recorded_at",
        filter_col=None, filter_val=None, minutes=60, limit=limit,
        datasource_id=None, _user={}, datasource_ids=[None],
    )
    return out["series"][0]


def test_array_readings_survive_to_the_response(monkeypatch):
    rows = [{"ts": TS, "value": [41.2, 40.0, 44.0, 36.0]}]
    assert _series(rows, monkeypatch)["points"][0]["value"] == [41.2, 40.0, 44.0, 36.0]


def test_null_slots_ride_through_as_gaps(monkeypatch):
    # A missing limit should break that one band, not discard the measured value
    # recorded beside it.
    rows = [{"ts": TS, "value": [41.2, None, None, 36.0]}]
    assert _series(rows, monkeypatch)["points"][0]["value"] == [41.2, None, None, 36.0]


def test_scalar_readings_are_unaffected(monkeypatch):
    # The path every existing Live panel takes.
    rows = [{"ts": TS, "value": Decimal("3.5")}]
    assert _series(rows, monkeypatch)["points"][0]["value"] == Decimal("3.5")


@pytest.mark.parametrize("value", ["RUN", True, [], ["a", "b"], [1.0, "x"], None])
def test_unplottable_readings_are_dropped(value, monkeypatch):
    # Dropped rather than rejected — a text column is a legitimate binding for a
    # symbol that prints words, and those share this seed path.
    assert _series([{"ts": TS, "value": value}], monkeypatch)["points"] == []


def test_truncated_is_flagged_when_the_cap_bites(monkeypatch):
    # The route asks for limit + 1, so a fourth row means a third was dropped.
    rows = [{"ts": TS, "value": [float(i)]} for i in range(4)]
    out = _series(rows, monkeypatch, limit=3)
    assert out["truncated"] is True
    # And it keeps the newest, not the oldest — the end a trend is read from.
    assert [p["value"] for p in out["points"]] == [[1.0], [2.0], [3.0]]


def test_a_window_exactly_the_size_of_the_cap_is_not_truncated(monkeypatch):
    """Exactly `limit` rows is a complete window, not a clipped one.

    Telling someone to shorten a window they already saw in full is the one
    failure mode this flag exists to avoid.
    """
    rows = [{"ts": TS, "value": [1.0]}] * 3
    assert _series(rows, monkeypatch, limit=3)["truncated"] is False


def test_truncated_is_false_for_a_short_window(monkeypatch):
    rows = [{"ts": TS, "value": [1.0]}] * 3
    assert _series(rows, monkeypatch, limit=9)["truncated"] is False


# --- variables_tag buffer gate ----------------------------------------------


def test_array_column_bypasses_the_variables_tag_buffer(monkeypatch):
    """The buffer holds only the numeric-scalar fields discovery found.

    Serving an array column from it returns an empty series forever, with no
    error — strictly worse than the live query the short-circuit improves on.
    """
    monkeypatch.setattr(db, "is_tag_buffered", lambda ds: True)
    monkeypatch.setattr(db, "tag_fields", lambda ds: ("current_value",))
    monkeypatch.setattr(
        db, "buffered_tag_series",
        lambda *a, **k: pytest.fail("array column was served from the tag buffer"),
    )
    _stub_conn(monkeypatch, _RecordingConn())

    assert db.table_series("variables_tag", "reading", "tag_name", "M01",
                           "recorded_at", 60) == []


def test_discovered_scalar_still_uses_the_buffer(monkeypatch):
    monkeypatch.setattr(db, "is_tag_buffered", lambda ds: True)
    monkeypatch.setattr(db, "tag_fields", lambda ds: ("current_value",))
    monkeypatch.setattr(db, "buffered_tag_series",
                        lambda *a, **k: [{"ts": TS, "value": 1.0}])

    assert db.table_series("variables_tag", "current_value", "tag_name", "M01",
                           "recorded_at", 60) == [{"ts": TS, "value": 1.0}]


# --- the row cap -------------------------------------------------------------


def test_limit_keeps_the_newest_rows(monkeypatch):
    """The cap must clip the left-hand edge, not the end a trend is read from."""
    conn = _RecordingConn()
    _stub_conn(monkeypatch, conn)

    db.table_series("probe", "reading", None, None, "recorded_at", 60, None, limit=500)

    text = _query_text(conn)
    assert "DESC LIMIT" in text
    assert text.rstrip().endswith("ORDER BY w.ts ASC")
    assert conn.params[-1] == 500


def test_no_limit_leaves_the_query_flat(monkeypatch):
    """Omitted, the SQL every Live tile already runs must be unchanged."""
    conn = _RecordingConn()
    _stub_conn(monkeypatch, conn)

    db.table_series("probe", "reading", None, None, "recorded_at", 60)

    assert "LIMIT" not in _query_text(conn)
