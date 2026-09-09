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
    assert seen == [{'limit': 3, 'start': START, 'end': END}]
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
    {'start': START.isoformat(), 'end': (START + timedelta(days=8)).isoformat()},
])
def test_invalid_ranges_are_rejected_before_query(client, monkeypatch, bounds):
    monkeypatch.setattr(db, 'table_series', lambda *a, **k: pytest.fail('queried an invalid range'))
    assert request(client, **bounds).status_code == 422


def test_relative_call_keeps_existing_interface(client, monkeypatch):
    seen = []
    monkeypatch.setattr(db, 'table_series', lambda *a, **k: seen.append((a, k)) or [])
    assert request(client, minutes=480).status_code == 200
    assert seen[0][0][5] == 480
    assert seen[0][1] == {'limit': 5001}


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
