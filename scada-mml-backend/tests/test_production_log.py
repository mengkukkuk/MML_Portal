"""Hourly production-log behaviour exposed by the mimic router."""
from datetime import date, datetime

import db
import mimic
from production_log import aggregate_counter_samples
import pytest
from fastapi import HTTPException
import psycopg
from psycopg import sql


USER = {"id": 7, "username": "operator", "role": "operator"}


def _layout(binding=None):
    return {
        "slug": "line-1",
        "name": "Line 1",
        "doc": {
            "version": 3,
            "nodes": [],
            "edges": [],
            "productionLog": binding,
        },
        "updated_at": datetime(2026, 8, 28, 8, 0),
    }


def _binding(**overrides):
    value = {
        "datasource_id": None,
        "table": "line_counts",
        "ts_col": "recorded_at",
        "produced_col": "good_count",
        "rejected_col": "reject_count",
        "filter_col": None,
        "filter_val": None,
    }
    value.update(overrides)
    return value


def test_hourly_log_returns_the_active_mimics_zero_filled_shift(monkeypatch):
    monkeypatch.setattr(db, "get_mimic_layout", lambda slug: _layout(_binding()))
    monkeypatch.setattr(db, "datasource_names", lambda ids: {4: "Plant 4"})
    monkeypatch.setattr(db, "production_log_hourly", lambda *args, **kwargs: {
        "date": date(2026, 8, 28),
        "generated_at": datetime(2026, 8, 28, 13, 15),
        "buckets": [{"hour": 13, "produced": 183, "rejected": 6}],
    })

    body = mimic.get_production_log("line-1", USER, [4])

    assert body["date"] == date(2026, 8, 28)
    assert body["current_hour"] == 13
    assert len(body["buckets"]) == 10
    assert body["buckets"][0] == {
        "hour": 8, "label": "08", "produced": 0, "rejected": 0, "reject_rate": 0.0,
    }
    assert body["buckets"][5] == {
        "hour": 13, "label": "13", "produced": 183, "rejected": 6,
        "reject_rate": 3.17,
    }
    assert body["sources"] == [{
        "datasource_id": 4, "datasource_name": "Plant 4", "ok": True, "error": None,
    }]
    assert mimic.ProductionLogOut(**body).buckets[5].reject_rate == 3.17


def test_counter_samples_use_the_shift_baseline_and_survive_resets():
    samples = [
        {"ts": datetime(2026, 8, 28, 7, 55), "produced": 100, "rejected": 10},
        {"ts": datetime(2026, 8, 28, 8, 10), "produced": 110, "rejected": 11},
        {"ts": datetime(2026, 8, 28, 8, 50), "produced": 125, "rejected": 12},
        {"ts": datetime(2026, 8, 28, 9, 5), "produced": 5, "rejected": 1},
        {"ts": datetime(2026, 8, 28, 9, 40), "produced": 15, "rejected": 2},
    ]

    result = aggregate_counter_samples(samples, datetime(2026, 8, 28, 13, 15))

    assert result["buckets"] == [
        {"hour": 8, "produced": 25, "rejected": 2},
        {"hour": 9, "produced": 15, "rejected": 2},
    ]


def test_layout_validation_requires_numeric_counters_and_a_timestamp(monkeypatch):
    monkeypatch.setattr(db, "describe_table", lambda table, datasource_id: {
        "value_columns": ["good_count", "reject_count"],
        "text_columns": ["line_code"],
        "ts_columns": ["recorded_at"],
        "datetime_columns": ["recorded_at"],
        "filter_columns": ["line_code", "recorded_at"],
    })
    doc = {"nodes": [], "edges": [], "productionLog": _binding(produced_col="line_code")}

    with pytest.raises(HTTPException) as exc:
        mimic._validate(doc)

    assert exc.value.status_code == 400
    assert "produced_col must be a numeric column" in exc.value.detail


def test_unconfigured_mimic_reports_a_clear_not_found(monkeypatch):
    monkeypatch.setattr(db, "get_mimic_layout", lambda slug: _layout())
    with pytest.raises(HTTPException) as exc:
        mimic.get_production_log("line-1", USER, [4])
    assert exc.value.status_code == 404
    assert "not configured" in exc.value.detail


def test_dead_source_returns_an_error_instead_of_empty_production(monkeypatch):
    monkeypatch.setattr(db, "get_mimic_layout", lambda slug: _layout(_binding()))
    monkeypatch.setattr(db, "datasource_names", lambda ids: {4: "Plant 4"})
    monkeypatch.setattr(
        db, "production_log_hourly",
        lambda *args, **kwargs: (_ for _ in ()).throw(psycopg.OperationalError("timeout")),
    )

    with pytest.raises(HTTPException) as exc:
        mimic.get_production_log("line-1", USER, [4])

    assert exc.value.status_code == 503
    assert "timeout" in exc.value.detail


def test_stored_source_never_overrides_the_header_primary(monkeypatch):
    seen = {}
    monkeypatch.setattr(db, "get_mimic_layout", lambda slug: _layout(_binding(datasource_id=9)))
    monkeypatch.setattr(db, "datasource_names", lambda ids: {4: "Plant 4"})
    monkeypatch.setattr(db, "production_log_hourly", lambda binding, datasource_id: (
        seen.update(datasource_id=datasource_id) or {
            "date": date(2026, 8, 28),
            "generated_at": datetime(2026, 8, 28, 13, 15),
            "buckets": [],
        }
    ))

    mimic.get_production_log("line-1", USER, [4, 9])

    assert seen["datasource_id"] == 4


def test_production_timestamp_rejects_date_only_columns(monkeypatch):
    monkeypatch.setattr(db, "describe_table", lambda table, datasource_id: {
        "value_columns": ["good_count", "reject_count"],
        "text_columns": [],
        "ts_columns": ["production_date", "recorded_at"],
        "datetime_columns": ["recorded_at"],
        "filter_columns": ["production_date", "recorded_at"],
    })

    with pytest.raises(HTTPException) as exc:
        mimic._validate({
            "nodes": [], "edges": [],
            "productionLog": _binding(ts_col="production_date"),
        })

    assert "ts_col must be a timestamp column" in exc.value.detail


def test_null_source_is_validated_against_primary_selection_but_stored_as_null(monkeypatch):
    seen = {}
    monkeypatch.setattr(mimic, "active_datasources", lambda user: [4])
    monkeypatch.setattr(db, "get_datasource", lambda datasource_id: {"id": datasource_id})
    monkeypatch.setattr(db, "describe_table", lambda table, datasource_id: (
        seen.update(validated_source=datasource_id) or {
            "value_columns": ["good_count", "reject_count"],
            "text_columns": [],
            "ts_columns": ["recorded_at"],
            "datetime_columns": ["recorded_at"],
            "filter_columns": ["recorded_at"],
        }
    ))
    monkeypatch.setattr(db, "upsert_mimic_layout", lambda slug, name, doc, **kwargs: (
        seen.update(stored_doc=doc) or _layout(doc["productionLog"])
    ))
    doc = {"version": 3, "nodes": [], "edges": [], "productionLog": _binding()}

    mimic.save_layout("line-1", mimic.MimicIn(name="Line 1", doc=doc), USER)

    assert seen["validated_source"] == 4
    assert seen["stored_doc"]["productionLog"]["datasource_id"] is None


def test_first_in_shift_sample_is_a_baseline_when_no_earlier_sample_exists():
    samples = [
        {"ts": datetime(2026, 8, 28, 8, 10), "produced": 410, "rejected": 20},
        {"ts": datetime(2026, 8, 28, 8, 20), "produced": 417, "rejected": 21},
    ]
    result = aggregate_counter_samples(samples, datetime(2026, 8, 28, 13, 15))
    assert result["buckets"] == [{"hour": 8, "produced": 7, "rejected": 1}]


def test_database_adapter_applies_the_optional_line_filter():
    table = f"production_log_test_{id(object())}"
    table_id = sql.Identifier(table)
    with db.get_connection() as conn:
        conn.execute(sql.SQL(
            "CREATE TABLE {} (recorded_at timestamp, line_code text, good_count integer, reject_count integer)"
        ).format(table_id))
        conn.execute(sql.SQL(
            "INSERT INTO {} VALUES "
            "(CURRENT_DATE + time '07:55', 'A', 100, 10),"
            "(CURRENT_DATE + time '08:10', 'A', 110, 11),"
            "(CURRENT_DATE + time '08:30', 'A', 120, 12),"
            "(CURRENT_DATE + time '08:20', 'B', 9999, 9999)"
        ).format(table_id))
        conn.commit()
    try:
        result = db.production_log_hourly(_binding(
            table=table, filter_col="line_code", filter_val="A",
        ))
        assert result["buckets"] == [{"hour": 8, "produced": 20, "rejected": 2}]
    finally:
        with db.get_connection() as conn:
            conn.execute(sql.SQL("DROP TABLE {}").format(table_id))
            conn.commit()
