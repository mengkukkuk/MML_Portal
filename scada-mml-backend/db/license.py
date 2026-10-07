"""License event log."""

from datetime import datetime

from . import pool as _pool

__all__ = [
    "init_license_events_table",
    "insert_license_event",
]

# --- License activation audit log --------------------------------------------
# Log only, not the source of truth — the .lic file on disk (see licensing.py)
# is authoritative. This table exists purely so support can answer "who
# activated what, when" without SSH-ing in to read a log file. Must run after
# init_users_table (FK to actor_user_id).
def init_license_events_table() -> None:
    """Create the license_events table if it doesn't exist. Idempotent."""
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS license_events (
                id            SERIAL PRIMARY KEY,
                event_type    TEXT NOT NULL,
                state         TEXT NOT NULL,
                license_id    TEXT,
                tier          TEXT,
                expires_at    TIMESTAMPTZ,
                actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                detail        TEXT,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.commit()


def insert_license_event(
    event_type: str,
    state: str,
    license_id: str | None = None,
    tier: str | None = None,
    expires_at: datetime | None = None,
    actor_user_id: int | None = None,
    detail: str | None = None,
) -> None:
    with _pool.get_connection() as conn:
        conn.execute(
            """INSERT INTO license_events
                   (event_type, state, license_id, tier, expires_at, actor_user_id, detail)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (event_type, state, license_id, tier, expires_at, actor_user_id, detail),
        )
        conn.commit()
