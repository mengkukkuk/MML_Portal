from datetime import datetime, timedelta, timezone
import asyncio
import json
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI

import db
import schema
from test_schema_arrays import COLUMNS, _RecordingConn, _query_text, _stub_conn


START = datetime(2026, 9, 9, 8, tzinfo=timezone(timedelta(hours=7)))
END = START + timedelta(hours=8)


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(schema.router)
    app.dependency_overrides[schema.get_current_user] = lambda: {}
    app.dependency_overrides[schema.active_datasources] = lambda: [1]
    app.dependency_overrides[schema.require_valid_license] = lambda: None
    monkeypatch.setattr(db, 'fan_out_rows', lambda targets, query, label='': (query(targets[0]), []))
    return app


def request(client, **bounds):
    params = {
        'table': 'probe', 'value_col': 'reading', 'ts_col': 'recorded_at', **bounds,
    }
    messages = []
    async def run():
        async def receive():
            return {'type': 'http.request', 'body': b'', 'more_body': False}
        async def send(message):
            messages.append(message)
        await client({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
                      'method': 'GET', 'scheme': 'http', 'path': '/api/schema/series',
                      'query_string': urlencode(params).encode(), 'headers': [],
                      'server': ('test', 80), 'client': ('test', 1), 'root_path': ''}, receive, send)
    asyncio.run(run())
    body = b''.join(m.get('body', b'') for m in messages)
    return SimpleNamespace(status_code=messages[0]['status'], json=lambda: json.loads(body))


def test_explicit_bounds_reach_query_with_offsets_and_keep_truncation(client, monkeypatch):
    seen = []
    def rows(*args, **kwargs):
        seen.append(kwargs)
        return [{'ts': START + timedelta(hours=i), 'value': [i]} for i in range(3)]
    monkeypatch.setattr(db, 'table_series', rows)
    response = request(client, start=START.isoformat(), end=END.isoformat(), minutes=10, limit=2)
    assert response.status_code == 200
    assert seen == [{'limit': 3, 'sample_seconds': None, 'start': START, 'end': END}]
    series = response.json()['series'][0]
    assert series['truncated'] is True
    assert [p['value'] for p in series['points']] == [[1], [2]]
    assert series['points'][0]['ts'].endswith('+07:00')


@pytest.mark.parametrize('bounds', [
    {'start': START.isoformat()}, {'end': END.isoformat()},
    {'start': 'bad', 'end': END.isoformat()},
    {'start': START.replace(tzinfo=None).isoformat(), 'end': END.isoformat()},
    {'start': START.isoformat(), 'end': START.isoformat()},
    {'start': END.isoformat(), 'end': START.isoformat()},
    {'start': START.isoformat(), 'end': (START + timedelta(days=367)).isoformat()},
])
def test_invalid_ranges_are_rejected_before_query(client, monkeypatch, bounds):
    monkeypatch.setattr(db, 'table_series', lambda *a, **k: pytest.fail('queried an invalid range'))
    assert request(client, **bounds).status_code == 422


def test_relative_call_keeps_existing_interface(client, monkeypatch):
    seen = []
    monkeypatch.setattr(db, 'table_series', lambda *a, **k: seen.append((a, k)) or [])
    assert request(client, minutes=480).status_code == 200
    assert seen[0][0][5] == 480
    assert seen[0][1] == {'limit': 5001, 'sample_seconds': None}


@pytest.mark.parametrize('kind', ['timestamp with time zone', 'timestamp without time zone'])
def test_sql_uses_both_bounds_and_normalizes_naive_timestamps(monkeypatch, kind):
    conn = _RecordingConn()
    _stub_conn(monkeypatch, conn)
    monkeypatch.setattr(db, '_safe_identifiers', lambda *a, **k: {**COLUMNS, 'recorded_at': kind})
    db.table_series('probe', 'reading', 'code', 'CAM001', 'recorded_at', 10, 1,
                    limit=5001, start=START, end=END)
    query = _query_text(conn)
    assert '"recorded_at" >= ' in query and '"recorded_at" <= ' in query
    if kind == 'timestamp without time zone':
        assert query.count("%s::timestamptz AT TIME ZONE current_setting('TimeZone')") == 2
    assert 'make_interval' not in query
    assert ("AT TIME ZONE current_setting('TimeZone')" in query) == (kind == 'timestamp without time zone')
    assert 'DESC LIMIT' in query and query.endswith('ORDER BY w.ts ASC')
    assert conn.params == [START, END, 'CAM001', 5001]


def test_buffer_applies_historical_bounds_and_newest_limit(monkeypatch):
    monkeypatch.setattr(db, 'is_tag_buffered', lambda ds: True)
    monkeypatch.setattr(db, 'tag_fields', lambda ds: ('value',))
    monkeypatch.setattr(db, 'buffered_tag_series', lambda *a: [
        {'ts': START + timedelta(hours=i), 'value': i} for i in range(-1, 10)
    ])
    result = db.table_series('variables_tag', 'value', 'tag_name', 'M01', 'ts', 10,
                             limit=2, start=START, end=END)
    assert [r['value'] for r in result] == [7, 8]


def test_a_year_window_is_accepted_and_thinned_by_the_step_the_data_needs(client, monkeypatch):
    """A year used to be refused (seven-day ceiling); now it is thinned so the
    whole year fits under `limit` instead of the newest `limit` rows of it. The
    step comes from the rows actually in the window, not from the window."""
    seen, steps = [], []
    def step(*a, **k):
        steps.append((a, k))
        return 1800
    monkeypatch.setattr(db, 'series_step', step)
    monkeypatch.setattr(db, 'table_series', lambda *a, **k: seen.append(k) or [])
    end = START + timedelta(days=365)
    response = request(client, start=START.isoformat(), end=end.isoformat(), limit=5000)
    assert response.status_code == 200
    assert steps[0][1] == {'limit': 5000, 'start': START, 'end': end}
    assert seen[0]['sample_seconds'] == 1800
    assert response.json()['series'][0]['sampled_seconds'] == 1800


def test_a_year_whose_rows_already_fit_is_returned_row_for_row(client, monkeypatch):
    seen = []
    monkeypatch.setattr(db, 'series_step', lambda *a, **k: None)
    monkeypatch.setattr(db, 'table_series', lambda *a, **k: seen.append(k) or [])
    end = START + timedelta(days=365)
    response = request(client, start=START.isoformat(), end=end.isoformat())
    assert response.status_code == 200
    assert seen[0]['sample_seconds'] is None
    assert response.json()['series'][0]['sampled_seconds'] is None


def test_a_relative_year_is_accepted_and_sampled(client, monkeypatch):
    seen, steps = [], []
    monkeypatch.setattr(db, 'series_step', lambda *a, **k: steps.append((a, k)) or 900)
    monkeypatch.setattr(db, 'table_series', lambda *a, **k: seen.append(k) or [])
    assert request(client, minutes=525600).status_code == 200
    assert steps[0][0][5] == 525600
    assert seen[0]['sample_seconds'] == 900


def test_a_week_is_still_returned_row_for_row(client, monkeypatch):
    seen = []
    monkeypatch.setattr(db, 'series_step', lambda *a, **k: pytest.fail('probed a short window'))
    monkeypatch.setattr(db, 'table_series', lambda *a, **k: seen.append(k) or [])
    end = START + timedelta(days=7)
    assert request(client, start=START.isoformat(), end=end.isoformat()).status_code == 200
    assert seen[0]['sample_seconds'] is None


def test_sampled_sql_keeps_the_lowest_and_highest_row_per_bucket_without_clipping(monkeypatch):
    conn = _RecordingConn()
    _stub_conn(monkeypatch, conn)
    monkeypatch.setattr(db, '_safe_identifiers', lambda *a, **k: {
        **COLUMNS, 'recorded_at': 'timestamp with time zone'})
    db.table_series('probe', 'reading', None, None, 'recorded_at', 10, 1,
                    limit=5001, start=START, end=END, sample_seconds=3600)
    query = _query_text(conn)
    assert 'floor(extract(epoch FROM s.ts) / %s) AS bucket' in query
    assert 'ORDER BY q.value ASC NULLS LAST' in query and 'ORDER BY q.value DESC NULLS LAST' in query
    assert 'lo_rank = 1 OR w.hi_rank = 1' in query
    # A LIMIT on the ascending result would drop the newest buckets.
    assert 'LIMIT' not in query and query.endswith('ORDER BY w.ts ASC')
    assert conn.params == [3600, START, END]


def test_sampled_sql_falls_back_to_the_newest_row_for_an_unordered_column(monkeypatch):
    conn = _RecordingConn()
    _stub_conn(monkeypatch, conn)
    monkeypatch.setattr(db, '_safe_identifiers', lambda *a, **k: {
        **COLUMNS, 'recorded_at': 'timestamp with time zone'})
    db.table_series('probe', 'code', None, None, 'recorded_at', 10, 1,
                    limit=5001, start=START, end=END, sample_seconds=3600)
    query = _query_text(conn)
    assert 'DISTINCT ON (bucket)' in query and 'ORDER BY bucket, q.ts DESC' in query
    assert 'lo_rank' not in query


class _ExtentConn(_RecordingConn):
    def __init__(self, count, first, last):
        super().__init__()
        self.row = {'n': count, 'lo': first, 'hi': last}

    def fetchone(self):
        return self.row


def _step(monkeypatch, conn, limit=5000):
    _stub_conn(monkeypatch, conn)
    monkeypatch.setattr(db, '_safe_identifiers', lambda *a, **k: {
        **COLUMNS, 'recorded_at': 'timestamp with time zone'})
    return db.series_step('probe', 'reading', None, None, 'recorded_at', 10, 1,
                          limit=limit, start=START, end=END)


def test_step_is_none_when_the_rows_already_fit(monkeypatch):
    conn = _ExtentConn(1395, START, START + timedelta(hours=4))
    assert _step(monkeypatch, conn) is None


def test_step_is_sized_to_the_span_the_data_occupies_not_the_window(monkeypatch):
    # 20 days of data inside a year-long window: 2 rows per bucket, so
    # limit // 2 - 1 buckets over the 20 days, not over the 365.
    conn = _ExtentConn(100_000, START, START + timedelta(days=20))
    assert _step(monkeypatch, conn) == -(-20 * 86400 // 2499)


def test_step_never_drops_below_one_second(monkeypatch):
    conn = _ExtentConn(6000, START, START + timedelta(seconds=30))
    assert _step(monkeypatch, conn) == 1
