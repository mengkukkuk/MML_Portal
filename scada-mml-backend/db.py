"""Thin PostgreSQL access layer using psycopg 3."""
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json

import config


def get_connection() -> psycopg.Connection:
    """Open a new connection. Rows are returned as dicts."""
    return psycopg.connect(config.DATABASE_URL, row_factory=dict_row)


def get_user_by_username(username: str) -> dict[str, Any] | None:
    with get_connection() as conn:
        row = conn.execute(
            """SELECT id, username, password_hash, role, display_name 
            FROM users WHERE username = %s""",
            (username,),
        ).fetchone()
    return row


def get_user_by_id(user_id: int) -> dict[str, Any] | None:
    with get_connection() as conn:
        row = conn.execute(
            """SELECT id, username, password_hash, role, display_name
            FROM users WHERE id = %s""",
            (user_id,),
        ).fetchone()
    return row


def get_user_by_email(email: str) -> dict[str, Any] | None:
    """Case-insensitive lookup — normalization must match users_email_lower_key."""
    with get_connection() as conn:
        row = conn.execute(
            """SELECT id, username, password_hash, role, display_name, email
            FROM users WHERE lower(email) = lower(%s)""",
            (email,),
        ).fetchone()
    return row


# --- Account management -----------------------------------------------------
def list_users() -> list[dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT id, username, role, display_name, email, created_at
            FROM users ORDER BY id"""
        ).fetchall()
    return rows


def create_user(
    username: str,
    password_hash: str,
    role: str,
    display_name: str,
    email: str | None,
) -> dict[str, Any]:
    """Insert a user. Raises psycopg.errors.UniqueViolation on duplicate username/email."""
    with get_connection() as conn:
        row = conn.execute(
            """INSERT INTO users (username, password_hash, role, display_name, email)
            VALUES (%s, %s, %s, %s, %s) RETURNING id, username, role, display_name, email, created_at""",
            (username, password_hash, role, display_name, email),
        ).fetchone()
        conn.commit()
    return row


def update_user(
    user_id: int,
    role: str,
    display_name: str,
    email: str | None,
) -> dict[str, Any] | None:
    """Update editable fields (not username/password). Returns None if no such user."""
    with get_connection() as conn:
        row = conn.execute(
            """UPDATE users SET role = %s, display_name = %s, email = %s
            WHERE id = %s RETURNING id, username, role, display_name, email, created_at""",
            (role, display_name, email, user_id),
        ).fetchone()
        conn.commit()
    return row


def delete_user(user_id: int) -> bool:
    """Delete a user. Returns True if a row was removed."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM users WHERE id = %s", (user_id,))
        conn.commit()
        return cur.rowcount > 0


def set_password(user_id: int, password_hash: str) -> bool:
    """Replace a user's password hash. Returns True if the user exists."""
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE users SET password_hash = %s WHERE id = %s",
            (password_hash, user_id),
        )
        conn.commit()
        return cur.rowcount > 0


def count_admins() -> int:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT count(*) AS n FROM users WHERE role = 'admin'"
        ).fetchone()
    return int(row["n"])


# --- Live sensor readings (real-time charts) --------------------------------
def list_devices() -> list[dict[str, Any]]:
    """All monitored devices, ordered by id."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT id, name, type, location, status
            FROM devices ORDER BY id"""
        ).fetchall()
    return rows


def list_metrics(device_id: int) -> list[dict[str, Any]]:
    """Distinct metrics (with their most recent unit) recorded for a device."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT DISTINCT ON (metric) metric, unit
            FROM sensor_readings
            WHERE device_id = %s
            ORDER BY metric, ts DESC""",
            (device_id,),
        ).fetchall()
    return rows


def latest_reading(device_id: int, metric: str) -> dict[str, Any] | None:
    """Single most-recent reading for a device/metric, or None if none exist."""
    with get_connection() as conn:
        row = conn.execute(
            """SELECT value, unit, ts
            FROM sensor_readings
            WHERE device_id = %s AND metric = %s
            ORDER BY ts DESC LIMIT 1""",
            (device_id, metric),
        ).fetchone()
    return row


def reading_series(device_id: int, metric: str, minutes: int) -> list[dict[str, Any]]:
    """Time-ordered readings for a device/metric over the last `minutes`."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT value, unit, ts
            FROM sensor_readings
            WHERE device_id = %s AND metric = %s
              AND ts >= now() - make_interval(mins => %s)
            ORDER BY ts ASC""",
            (device_id, metric, minutes),
        ).fetchall()
    return rows


# --- Dashboard panels (admin-managed live grid) -----------------------------
def init_panels_table() -> None:
    """Create the dashboard_panels table if it doesn't exist. Idempotent.

    ``options`` (JSONB) holds the per-visualization parameters (min/max,
    thresholds, decimals, orientation, …) so each panel can render in a
    different form. Added as an idempotent migration for existing tables.
    ``source`` is 'device' (legacy device+metric) or 'tag' (status_tag row).
    """
    with get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS dashboard_panels (
                id             SERIAL PRIMARY KEY,
                title          TEXT NOT NULL,
                device_id      INTEGER,
                metric         TEXT,
                window_minutes INTEGER NOT NULL DEFAULT 15,
                chart_type     TEXT NOT NULL DEFAULT 'timeseries',
                position       INTEGER NOT NULL DEFAULT 0,
                options        JSONB NOT NULL DEFAULT '{}'::jsonb,
                source         TEXT NOT NULL DEFAULT 'device',
                tag_name       TEXT,
                poll_interval_seconds INTEGER NOT NULL DEFAULT 5,
                created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.execute(
            "ALTER TABLE dashboard_panels "
            "ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels "
            "ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'device'"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels "
            "ADD COLUMN IF NOT EXISTS tag_name TEXT"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels "
            "ADD COLUMN IF NOT EXISTS poll_interval_seconds INTEGER NOT NULL DEFAULT 5"
        )
        conn.execute("ALTER TABLE dashboard_panels ALTER COLUMN device_id DROP NOT NULL")
        conn.execute("ALTER TABLE dashboard_panels ALTER COLUMN metric DROP NOT NULL")
        conn.commit()


# --- Status tags (real SCADA data — public.status_tag) ----------------------
# API field names ↔ actual DB columns. The DB exposes the "current" value as
# `current_value_tag`; we surface it as `current_value` for the frontend.
TAG_FIELDS = ("current_value", "current_setpoint", "current_high_value", "current_low_value")


def list_tags() -> list[dict[str, Any]]:
    """All distinct tag names in status_tag, ordered alphabetically."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT DISTINCT tag_name FROM public.status_tag "
            "WHERE tag_name IS NOT NULL ORDER BY tag_name"
        ).fetchall()
    return rows


def latest_tag(tag_name: str) -> dict[str, Any] | None:
    """Most-recent row for a tag — all four value columns + updated_at + active."""
    with get_connection() as conn:
        row = conn.execute(
            """SELECT tag_name, active, updated_at AS ts,
                      current_value_tag AS current_value,
                      current_setpoint,
                      current_high_value,
                      current_low_value
            FROM public.status_tag
            WHERE tag_name = %s
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1""",
            (tag_name,),
        ).fetchone()
    return row


_PANEL_COLS = (
    "id, title, device_id, metric, window_minutes, chart_type, position, "
    "options, source, tag_name, poll_interval_seconds, created_at"
)


def list_panels() -> list[dict[str, Any]]:
    """All dashboard panels, ordered by position then id."""
    with get_connection() as conn:
        rows = conn.execute(
            f"SELECT {_PANEL_COLS} FROM dashboard_panels ORDER BY position, id"
        ).fetchall()
    return rows


def create_panel(
    title: str,
    device_id: int | None,
    metric: str | None,
    window_minutes: int,
    chart_type: str,
    position: int,
    options: dict[str, Any],
    source: str,
    tag_name: str | None,
    poll_interval_seconds: int,
) -> dict[str, Any]:
    with get_connection() as conn:
        row = conn.execute(
            f"""INSERT INTO dashboard_panels
                (title, device_id, metric, window_minutes, chart_type, position,
                 options, source, tag_name, poll_interval_seconds)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_PANEL_COLS}""",
            (title, device_id, metric, window_minutes, chart_type, position,
             Json(options), source, tag_name, poll_interval_seconds),
        ).fetchone()
        conn.commit()
    return row


def update_panel(
    panel_id: int,
    title: str,
    device_id: int | None,
    metric: str | None,
    window_minutes: int,
    chart_type: str,
    position: int,
    options: dict[str, Any],
    source: str,
    tag_name: str | None,
    poll_interval_seconds: int,
) -> dict[str, Any] | None:
    """Update a panel. Returns None if no such panel."""
    with get_connection() as conn:
        row = conn.execute(
            f"""UPDATE dashboard_panels
            SET title = %s, device_id = %s, metric = %s, window_minutes = %s,
                chart_type = %s, position = %s, options = %s,
                source = %s, tag_name = %s, poll_interval_seconds = %s
            WHERE id = %s
            RETURNING {_PANEL_COLS}""",
            (title, device_id, metric, window_minutes, chart_type, position,
             Json(options), source, tag_name, poll_interval_seconds, panel_id),
        ).fetchone()
        conn.commit()
    return row


def delete_panel(panel_id: int) -> bool:
    """Delete a panel. Returns True if a row was removed."""
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM dashboard_panels WHERE id = %s", (panel_id,))
        conn.commit()
        return cur.rowcount > 0
