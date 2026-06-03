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
