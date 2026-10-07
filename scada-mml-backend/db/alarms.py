"""Recent events and alarms, and acknowledging them."""

from typing import Any

from psycopg import sql

from . import tables as _tables

__all__ = [
    "acknowledge_alarm",
    "list_active_alarms",
    "list_recent_alarms",
    "list_recent_events",
]

# --- Event log (real SCADA data — event_logs, read-only) ---------------------
def list_recent_events(limit: int, datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Last `limit` events per (location, tag_name), newest first.

    Reads the externally-populated event_logs. Ordered so the frontend can
    group location -> tag_name in a single pass.
    """
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT location, tag_name, event, at_date_time
                   FROM (
                     SELECT location, tag_name, event, at_date_time,
                            ROW_NUMBER() OVER (
                              PARTITION BY location, tag_name
                              ORDER BY at_date_time DESC
                            ) AS rn
                     FROM {}
                   ) ranked
                   WHERE rn <= %s
                   ORDER BY location, tag_name, at_date_time DESC"""
            ).format(sql.Identifier(schema, "event_logs")),
            (limit,),
        ).fetchall()
    return rows


# --- Alarm log (real SCADA data — alarm_logs) --------------------------------
# DB column `alarm_events` is surfaced as API field `alarm`; `created_at` is
# surfaced as `at_date_time` so the frontend can share the events timestamp
# shape. Severity / acknowledgement columns were added via a one-shot
# migration (see _probe_alarms.py).
def list_recent_alarms(limit: int, datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Last `limit` alarms per (location, tag_name), newest first."""
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT id, location, tag_name,
                          alarm_events AS alarm,
                          severity,
                          created_at   AS at_date_time,
                          acknowledged, acknowledged_at, acknowledged_by
                   FROM (
                     SELECT id, location, tag_name, alarm_events, severity,
                            created_at, acknowledged, acknowledged_at,
                            acknowledged_by,
                            ROW_NUMBER() OVER (
                              PARTITION BY location, tag_name
                              ORDER BY created_at DESC
                            ) AS rn
                     FROM {}
                   ) ranked
                   WHERE rn <= %s
                   ORDER BY location, tag_name, created_at DESC"""
            ).format(sql.Identifier(schema, "alarm_logs")),
            (limit,),
        ).fetchall()
    return rows


def list_active_alarms(datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Tags currently in alarm (variables_tag.alarm_no not null), joined to the
    triggering alarm_logs row for the event text. Empty list when nothing active.

    The ack columns come along because the operator can acknowledge from the
    active view: without them every 1 Hz poll would redraw an acknowledged alarm
    as unacknowledged, and the second click would 404. Acknowledging does not
    clear the alarm — `st.alarm_no` still points here, so the row stays active.
    """
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT st.tag_name, st.location,
                          st.alarm_value, st.alarm_no, st.alarm_active,
                          al.id            AS alarm_id,
                          al.alarm_events  AS alarm,
                          al.severity,
                          al.created_at    AS at_date_time,
                          al.acknowledged,
                          al.acknowledged_at
                   FROM {tags} st
                   JOIN {alarms} al ON al.id = st.alarm_no
                   WHERE st.alarm_no IS NOT NULL
                   ORDER BY st.location, st.tag_name"""
            ).format(
                tags=sql.Identifier(schema, "variables_tag"),
                alarms=sql.Identifier(schema, "alarm_logs"),
            )
        ).fetchall()
    return rows


def acknowledge_alarm(
    alarm_id: int, user_id: int, datasource_id: int | None = None
) -> dict[str, Any] | None:
    """Mark an alarm acknowledged. Returns the updated row, or None if the
    alarm doesn't exist or was already acknowledged.

    Never fan this out. Alarm ids come from each database's own sequence and
    therefore collide across sources: trying each source in turn would happily
    acknowledge a different plant's alarm. The caller must resolve exactly one
    datasource_id before calling.
    """
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        row = conn.execute(
            sql.SQL(
                """UPDATE {}
                      SET acknowledged    = TRUE,
                          acknowledged_at = now(),
                          acknowledged_by = %s
                    WHERE id = %s AND acknowledged = FALSE
                    RETURNING id, location, tag_name,
                              alarm_events AS alarm,
                              severity,
                              created_at   AS at_date_time,
                              acknowledged, acknowledged_at, acknowledged_by"""
            ).format(sql.Identifier(schema, "alarm_logs")),
            (user_id, alarm_id),
        ).fetchone()
        conn.commit()
    return row
