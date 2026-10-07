"""Devices, metrics and sensor readings."""

from typing import Any

from psycopg import sql

from . import tables as _tables

__all__ = [
    "latest_reading",
    "list_devices",
    "list_metrics",
    "reading_series",
]

# --- Live sensor readings (real-time charts) --------------------------------
# Plant data. Every function here takes a `datasource_id` and reaches the
# database through _table_source_conn, which also supplies that source's
# configured schema. The schema part is easy to miss and matters: a saved
# datasource can be on something other than `public`, and the hardcoded
# `public.`/bare table names these used to carry would silently 500 there.
def list_devices(datasource_id: int | None = None) -> list[dict[str, Any]]:
    """All monitored devices, ordered by id."""
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT id, name, type, location, status
                FROM {} ORDER BY id"""
            ).format(sql.Identifier(schema, "devices"))
        ).fetchall()
    return rows


def list_metrics(device_id: int, datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Distinct metrics (with their most recent unit) recorded for a device."""
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT DISTINCT ON (metric) metric, unit
                FROM {}
                WHERE device_id = %s
                ORDER BY metric, ts DESC"""
            ).format(sql.Identifier(schema, "sensor_readings")),
            (device_id,),
        ).fetchall()
    return rows


def latest_reading(
    device_id: int, metric: str, datasource_id: int | None = None
) -> dict[str, Any] | None:
    """Single most-recent reading for a device/metric, or None if none exist."""
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        row = conn.execute(
            sql.SQL(
                """SELECT value, unit, ts
                FROM {}
                WHERE device_id = %s AND metric = %s
                ORDER BY ts DESC LIMIT 1"""
            ).format(sql.Identifier(schema, "sensor_readings")),
            (device_id, metric),
        ).fetchone()
    return row


def reading_series(
    device_id: int, metric: str, minutes: int, datasource_id: int | None = None
) -> list[dict[str, Any]]:
    """Time-ordered readings for a device/metric over the last `minutes`."""
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT value, unit, ts
                FROM {}
                WHERE device_id = %s AND metric = %s
                  AND ts >= now() - make_interval(mins => %s)
                ORDER BY ts ASC"""
            ).format(sql.Identifier(schema, "sensor_readings")),
            (device_id, metric, minutes),
        ).fetchall()
    return rows
