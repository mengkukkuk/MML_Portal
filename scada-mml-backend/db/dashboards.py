"""Live dashboards (table + CRUD)."""

from typing import Any

from . import pool as _pool

__all__ = [
    "_DASH_COLS",
    "MAX_DASHBOARD_PAGES",
    "create_dashboard",
    "delete_dashboard",
    "init_dashboards_table",
    "list_dashboards",
    "set_dashboard_pages",
    "update_dashboard",
]

# A board's pages (the Live page's arrows): panels say which one they sit on in
# options.page. More than this is a second dashboard, not a longer one.
MAX_DASHBOARD_PAGES = 12

def init_dashboards_table() -> None:
    """Create the dashboards table and link panels to it. Idempotent.

    A dashboard groups panels so the Live page can host several named boards.
    Must run AFTER init_panels_table() (it alters dashboard_panels). Existing
    panels are adopted into a single 'Default' dashboard so nothing breaks.
    """
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS dashboards (
                id         SERIAL PRIMARY KEY,
                title      TEXT NOT NULL,
                position   INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        # Added after the table first shipped: every existing board is one page.
        conn.execute(
            "ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS page_count "
            "INTEGER NOT NULL DEFAULT 1"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels ADD COLUMN IF NOT EXISTS dashboard_id "
            "INTEGER REFERENCES dashboards(id) ON DELETE CASCADE"
        )
        # Guarantee at least one dashboard exists, then adopt any orphan panels.
        existing = conn.execute(
            "SELECT id FROM dashboards ORDER BY position, id LIMIT 1"
        ).fetchone()
        if existing is None:
            existing = conn.execute(
                "INSERT INTO dashboards (title, position) VALUES ('Default', 0) "
                "RETURNING id"
            ).fetchone()
        default_id = existing["id"]
        conn.execute(
            "UPDATE dashboard_panels SET dashboard_id = %s WHERE dashboard_id IS NULL",
            (default_id,),
        )
        conn.commit()


_DASH_COLS = "id, title, position, page_count, created_at"


def list_dashboards() -> list[dict[str, Any]]:
    """All dashboards, ordered by position then id."""
    with _pool.get_connection() as conn:
        rows = conn.execute(
            f"SELECT {_DASH_COLS} FROM dashboards ORDER BY position, id"
        ).fetchall()
    return rows


def create_dashboard(title: str, position: int = 0) -> dict[str, Any]:
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"INSERT INTO dashboards (title, position) VALUES (%s, %s) "
            f"RETURNING {_DASH_COLS}",
            (title, position),
        ).fetchone()
        conn.commit()
    return row


def update_dashboard(dashboard_id: int, title: str) -> dict[str, Any] | None:
    """Rename a dashboard. Returns None if no such dashboard."""
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"UPDATE dashboards SET title = %s WHERE id = %s RETURNING {_DASH_COLS}",
            (title, dashboard_id),
        ).fetchone()
        conn.commit()
    return row


def set_dashboard_pages(dashboard_id: int, page_count: int) -> dict[str, Any] | None:
    """Set how many pages a dashboard has. Returns None if no such dashboard.

    Panels are not touched: one whose options.page is past the last page is
    shown on the last page, so shrinking a board can hide no panel.
    """
    if not 1 <= page_count <= MAX_DASHBOARD_PAGES:
        raise ValueError(f"page_count must be between 1 and {MAX_DASHBOARD_PAGES}")
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"UPDATE dashboards SET page_count = %s WHERE id = %s RETURNING {_DASH_COLS}",
            (page_count, dashboard_id),
        ).fetchone()
        conn.commit()
    return row


def delete_dashboard(dashboard_id: int) -> bool:
    """Delete a dashboard (its panels cascade away). True if a row was removed."""
    with _pool.get_connection() as conn:
        cur = conn.execute("DELETE FROM dashboards WHERE id = %s", (dashboard_id,))
        conn.commit()
        return cur.rowcount > 0
