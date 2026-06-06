"""Thin PostgreSQL access layer using psycopg 3."""
from typing import Any

import psycopg
from psycopg.rows import dict_row

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
