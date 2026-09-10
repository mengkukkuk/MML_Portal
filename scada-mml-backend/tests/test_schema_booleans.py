"""Boolean columns end to end: discovery, categorisation, /series, validation.

A flag — `enabled`, `is_running`, `door_open` — is a legitimate thing to chart.
It draws a step line, and it is what half a mimic drawing is actually about. But
`boolean` was in none of db.py's four type tuples, so `describe_table` dropped it
into `filter_columns` by negation and both validators rejected it as a value.

Worse, the two read paths disagreed about the same column: `/latest` reported
1.0 (pydantic resolves bool against the float member of LatestOut.value) while
`/series` reported nothing at all, because `scalar()` excluded bool explicitly.
A hand-crafted boolean binding showed a live number beside a permanently empty
chart.

The contract these pin: a boolean is *reported as a number* (0/1) on both
endpoints, and is *catalogued as a boolean* so the editor can still tell a flag
from a measurement. Both halves matter — collapsing either one is the bug.

These run without a database, in the style of test_schema_arrays.py.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal

import pytest

import db
import mimic
import panels
import schema
from panels import PanelIn


# One table with every category represented, so each assertion is also a check
# that the others did not swallow the column under test.
COLUMNS = {
    "id": "bigint",
    "code": "text",
    "enabled": "boolean",          # the column this feature exists for
    "door_open": "boolean",
    "temperature": "double precision",
    "count": "integer",
    "reading": "_float8",
    "recorded_at": "timestamp with time zone",
}

TS = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


def _stub_conn(monkeypatch):
    @contextmanager
    def fake_conn(datasource_id):
        yield None, "public"

    monkeypatch.setattr(db, "_table_source_conn", fake_conn)
    monkeypatch.setattr(db, "_safe_identifiers", lambda *a, **k: dict(COLUMNS))


# --- catalogue ---------------------------------------------------------------


@pytest.fixture
def described(monkeypatch):
    """`describe_table` over COLUMNS, with its two DB reads stubbed out."""
    _stub_conn(monkeypatch)
    monkeypatch.setattr(db, "_table_columns", lambda c, s, t: dict(COLUMNS))
    monkeypatch.setattr(db, "_primary_key_columns", lambda c, s, t: {"id"})
    return db.describe_table("probe")


def test_booleans_are_offered_on_their_own(described):
    assert described["bool_columns"] == ["enabled", "door_open"]


def test_booleans_stay_out_of_value_and_text_columns(described):
    # `value_columns` is what a gauge scales and a warn/crit threshold compares;
    # `text_columns` is what a symbol prints verbatim. A flag is neither, and
    # folding it into either would erase the distinction the editor needs to
    # offer on/off labels instead of decimals.
    assert described["value_columns"] == ["temperature", "count"]
    assert described["text_columns"] == ["code"]


def test_booleans_are_still_filter_candidates(described):
    # Deliberate, and the reason this test exists: `enabled = true` is a fine
    # way to partition a series, distinct_column_values already casts ::text,
    # and dropping them would break every saved binding that filters on one.
    assert {"enabled", "door_open"} <= set(described["filter_columns"])


def test_a_boolean_primary_key_is_not_a_value(monkeypatch):
    """A boolean PK identifies the row rather than reporting anything."""
    _stub_conn(monkeypatch)
    cols = {"active": "boolean", "flagged": "boolean", "id": "boolean"}
    monkeypatch.setattr(db, "_table_columns", lambda c, s, t: dict(cols))
    monkeypatch.setattr(db, "_primary_key_columns", lambda c, s, t: {"active"})

    # 'active' by PK constraint, 'id' by name — the same `skip` set text_columns
    # uses.
    assert db.describe_table("probe")["bool_columns"] == ["flagged"]


# --- type badges -------------------------------------------------------------


def test_every_column_carries_a_badge(described):
    # Including 'id', which no category claims: the badge answers "what kind of
    # thing is this", which is a different question from "may this be bound".
    assert set(described["column_types"]) == set(COLUMNS)


def test_badges_are_short_tokens(described):
    types = described["column_types"]
    assert types["id"] == "int8"
    assert types["temperature"] == "float8"
    assert types["enabled"] == "bool"
    assert types["recorded_at"] == "timestamptz"


def test_array_badges_name_their_element_type(described):
    # Relies on _table_columns' udt_name substitution: '_float8' -> 'float8[]'.
    assert described["column_types"]["reading"] == "float8[]"


def test_an_unknown_type_passes_through_verbatim():
    # A plant with an enum or a domain type should read its name in the picker,
    # not an empty badge.
    assert db._type_badge("mood") == "mood"
    assert db._type_badge("_mood") == "mood[]"


# --- /series -----------------------------------------------------------------


def _series(rows, monkeypatch, limit=5000):
    """Drive the real route body over `rows`, with the fan-out collapsed."""
    monkeypatch.setattr(db, "table_series", lambda *a, **k: rows)
    monkeypatch.setattr(
        db, "fan_out_rows",
        lambda targets, query, label="": (query(targets[0]), []),
    )
    out = schema.get_series(
        table="probe", value_col="enabled", ts_col="recorded_at",
        filter_col=None, filter_val=None, minutes=60, limit=limit,
        datasource_id=None, _user={}, datasource_ids=[None],
    )
    return out["series"][0]


def test_booleans_are_plotted_as_one_and_zero(monkeypatch):
    rows = [
        {"ts": TS, "value": True},
        {"ts": TS, "value": False},
        {"ts": TS, "value": None},     # dropped
        {"ts": TS, "value": "RUN"},    # dropped
    ]
    points = _series(rows, monkeypatch)["points"]
    assert [p["value"] for p in points] == [1, 0]


def test_the_drop_rather_than_reject_contract_survives(monkeypatch):
    """Only bool was promoted. Everything else still answers 200 with no points.

    A text column is a legitimate binding for a symbol that prints words, and
    those symbols share this seed path — rejecting here would have to be
    special-cased by every caller.
    """
    assert _series([{"ts": TS, "value": "FAULT"}], monkeypatch)["points"] == []
    assert _series([{"ts": TS, "value": None}], monkeypatch)["points"] == []


def test_numeric_readings_are_unaffected(monkeypatch):
    rows = [{"ts": TS, "value": Decimal("3.5")}, {"ts": TS, "value": 7}]
    assert [p["value"] for p in _series(rows, monkeypatch)["points"]] == [Decimal("3.5"), 7]


def test_latest_reports_a_boolean_as_a_number():
    """`/series` and `/latest` must agree, and this is the half that is implicit.

    LatestOut.value is `float | str | None`; a bool resolves against the float
    member. Pinned here so a future pydantic union-mode change cannot make the
    two endpoints disagree again without a test failing.
    """
    assert schema.LatestOut(value=True).value == 1.0
    assert schema.LatestOut(value=False).value == 0.0


# --- validation --------------------------------------------------------------


@pytest.fixture
def described_cols(monkeypatch):
    """Point both validators' describe_table at a COLUMNS-shaped catalogue."""
    cols = {
        "value_columns": ["temperature", "count"],
        "bool_columns": ["enabled", "door_open"],
        "text_columns": ["code"],
        "ts_columns": ["recorded_at"],
        "datetime_columns": ["recorded_at"],
        "filter_columns": ["code", "enabled", "door_open", "recorded_at"],
        "column_types": {c: db._type_badge(t) for c, t in COLUMNS.items()},
    }
    monkeypatch.setattr(db, "describe_table", lambda t, ds=None: dict(cols))
    return cols


def _panel(metric, **extra):
    return PanelIn(
        title="Door", source="table", table_name="probe", metric=metric,
        ts_col="recorded_at", **extra,
    )


def test_a_boolean_is_a_valid_panel_metric(described_cols):
    panels._validate(_panel("enabled"))          # must not raise


def test_a_boolean_is_a_valid_extra_series(described_cols):
    panels._validate(_panel("temperature", options={"value_cols": ["enabled"]}))


def test_a_text_column_is_still_not_a_panel_metric(described_cols):
    # The Live path plots; it never gained the text branch mimic has.
    with pytest.raises(Exception) as e:
        panels._validate(_panel("code"))
    assert "numeric or boolean" in str(e.value)


def test_a_boolean_is_a_valid_symbol_binding(described_cols):
    mimic._validate_binding(
        {"table": "probe", "value_col": "enabled", "ts_col": "recorded_at"},
        "doc.nodes[0]", {},
    )


def test_a_boolean_is_not_a_production_counter(described_cols):
    """Counters are read as hourly deltas; subtracting two flags is meaningless.

    A 0/1 delta would print a plausible-looking wrong production figure rather
    than failing, which is why this one validator stays numeric-only.
    """
    with pytest.raises(Exception) as e:
        mimic._validate_production_log(
            {"table": "probe", "produced_col": "enabled", "rejected_col": "count",
             "ts_col": "recorded_at"},
            {},
        )
    assert "numeric column" in str(e.value)


def test_a_bound_flag_records_how_it_is_presented(described_cols):
    """`value_kind` is the only place "this is a flag" survives to the canvas.

    /latest reports a boolean as 1.0 so it agrees with /series, which means the
    reading itself cannot carry the kind. deriveTag reads this instead.
    """
    mimic._validate_binding(
        {"table": "probe", "value_col": "enabled", "ts_col": "recorded_at",
         "value_kind": "bool"},
        "doc.nodes[0]", {},
    )


def test_a_typo_in_value_kind_is_rejected(described_cols):
    # Unvalidated it would fail silently, as a symbol quietly printing 1
    # instead of RUNNING.
    with pytest.raises(Exception) as e:
        mimic._validate_binding(
            {"table": "probe", "value_col": "enabled", "ts_col": "recorded_at",
             "value_kind": "boolean"},
            "doc.nodes[0]", {},
        )
    assert "value_kind" in str(e.value)


def test_a_binding_written_before_flags_existed_still_saves(described_cols):
    # Absent means a plain number — every binding saved before this feature.
    mimic._validate_binding(
        {"table": "probe", "value_col": "temperature", "ts_col": "recorded_at"},
        "doc.nodes[0]", {},
    )


def test_the_new_lists_actually_reach_the_wire(described):
    """describe_table can categorise all it likes; ColumnsOut is what ships.

    Both fields are defaulted on the model, so a typo in either key name would
    serialise as an empty list rather than an error — the editor would just
    silently never offer a flag again.
    """
    out = schema.ColumnsOut(**described).model_dump()
    assert out["bool_columns"] == ["enabled", "door_open"]
    assert out["column_types"]["enabled"] == "bool"


def test_a_flag_on_variables_tag_is_not_served_from_the_buffer(monkeypatch):
    """`table_latest` has no `value_col in tag_fields` gate, unlike table_series.

    It is safe anyway, but for a non-obvious reason worth pinning: the buffer is
    keyed by (datasource, tag, value_col), and `_discover_tag_fields` filters on
    _NUMERIC_TYPES, so a boolean column is never buffered under any key.
    `buffered_tag_latest` misses, returns None, and the caller falls through to
    live SQL. Tighten that keying and this test is what says why it mattered:
    the picker now offers such a column, so /latest must answer for it.
    """
    monkeypatch.setattr(db, "is_tag_buffered", lambda ds: True)
    monkeypatch.setattr(db, "tag_fields", lambda ds: ("current_value",))
    monkeypatch.setattr(db, "buffered_tag_latest", lambda *a, **k: None)

    reached_sql = []

    @contextmanager
    def fake_conn(datasource_id):
        reached_sql.append(True)
        raise RuntimeError("stop here — reaching SQL is the assertion")
        yield  # pragma: no cover

    monkeypatch.setattr(db, "_table_source_conn", fake_conn)

    with pytest.raises(RuntimeError):
        db.table_latest("variables_tag", "enabled", "tag_name", "M01", "updated_at")
    assert reached_sql, "a boolean column was served from the tag buffer"
