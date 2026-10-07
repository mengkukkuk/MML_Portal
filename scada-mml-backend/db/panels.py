"""Live dashboard panels (table + CRUD)."""

from typing import Any

from psycopg.types.json import Json

from . import pool as _pool

__all__ = [
    "_PANEL_COLS",
    "create_panel",
    "delete_panel",
    "init_panels_table",
    "list_panels",
    "update_panel",
    "update_panel_poll_interval",
]

# --- Dashboard panels (admin-managed live grid) -----------------------------
def init_panels_table() -> None:
    """Create the dashboard_panels table if it doesn't exist. Idempotent.

    ``options`` (JSONB) holds the per-visualization parameters (min/max,
    thresholds, decimals, orientation, …) so each panel can render in a
    different form. Added as an idempotent migration for existing tables.
    ``source`` is 'device' (legacy device+metric) or 'tag' (variables_tag row).
    """
    with _pool.get_connection() as conn:
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
        # Generic table data-source binding (source='table'): the chosen public
        # table, the filter (series-key) column, and the timestamp column used for
        # ordering / the x-axis. The value column reuses `metric`; the per-series
        # filter values ride in options.filters (parallel to options.tags).
        conn.execute(
            "ALTER TABLE dashboard_panels ADD COLUMN IF NOT EXISTS table_name TEXT"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels ADD COLUMN IF NOT EXISTS filter_col TEXT"
        )
        conn.execute(
            "ALTER TABLE dashboard_panels ADD COLUMN IF NOT EXISTS ts_col TEXT"
        )
        # Optional binding to a saved connection (datasources.id). Plain INTEGER
        # (no FK) so this migration never depends on table-creation order; the
        # selection is persisted now and used for query routing in a follow-up.
        conn.execute(
            "ALTER TABLE dashboard_panels ADD COLUMN IF NOT EXISTS datasource_id INTEGER"
        )
        conn.execute("ALTER TABLE dashboard_panels ALTER COLUMN device_id DROP NOT NULL")
        conn.execute("ALTER TABLE dashboard_panels ALTER COLUMN metric DROP NOT NULL")
        conn.commit()


_PANEL_COLS = (
    "id, title, device_id, metric, window_minutes, chart_type, position, "
    "options, source, tag_name, poll_interval_seconds, "
    "table_name, filter_col, ts_col, dashboard_id, datasource_id, created_at"
)


def list_panels(dashboard_id: int | None = None) -> list[dict[str, Any]]:
    """Dashboard panels, ordered by position then id.

    When ``dashboard_id`` is given, only that dashboard's panels are returned.
    """
    with _pool.get_connection() as conn:
        if dashboard_id is None:
            rows = conn.execute(
                f"SELECT {_PANEL_COLS} FROM dashboard_panels ORDER BY position, id"
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT {_PANEL_COLS} FROM dashboard_panels "
                "WHERE dashboard_id = %s ORDER BY position, id",
                (dashboard_id,),
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
    table_name: str | None = None,
    filter_col: str | None = None,
    ts_col: str | None = None,
    dashboard_id: int | None = None,
    datasource_id: int | None = None,
) -> dict[str, Any]:
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"""INSERT INTO dashboard_panels
                (title, device_id, metric, window_minutes, chart_type, position,
                 options, source, tag_name, poll_interval_seconds,
                 table_name, filter_col, ts_col, dashboard_id, datasource_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_PANEL_COLS}""",
            (title, device_id, metric, window_minutes, chart_type, position,
             Json(options), source, tag_name, poll_interval_seconds,
             table_name, filter_col, ts_col, dashboard_id, datasource_id),
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
    table_name: str | None = None,
    filter_col: str | None = None,
    ts_col: str | None = None,
    dashboard_id: int | None = None,
    datasource_id: int | None = None,
) -> dict[str, Any] | None:
    """Update a panel. Returns None if no such panel."""
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"""UPDATE dashboard_panels
            SET title = %s, device_id = %s, metric = %s, window_minutes = %s,
                chart_type = %s, position = %s, options = %s,
                source = %s, tag_name = %s, poll_interval_seconds = %s,
                table_name = %s, filter_col = %s, ts_col = %s, dashboard_id = %s,
                datasource_id = %s
            WHERE id = %s
            RETURNING {_PANEL_COLS}""",
            (title, device_id, metric, window_minutes, chart_type, position,
             Json(options), source, tag_name, poll_interval_seconds,
             table_name, filter_col, ts_col, dashboard_id, datasource_id, panel_id),
        ).fetchone()
        conn.commit()
    return row


def update_panel_poll_interval(panel_id: int, poll_interval_seconds: int) -> dict[str, Any] | None:
    """Update only a panel's poll cadence. Returns None if no such panel.

    Narrower than update_panel() so operators can be granted this one write
    without exposing the rest of a panel's config (title, source, options, …)
    to a non-admin role.
    """
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"""UPDATE dashboard_panels
            SET poll_interval_seconds = %s
            WHERE id = %s
            RETURNING {_PANEL_COLS}""",
            (poll_interval_seconds, panel_id),
        ).fetchone()
        conn.commit()
    return row


def delete_panel(panel_id: int) -> bool:
    """Delete a panel. Returns True if a row was removed."""
    with _pool.get_connection() as conn:
        cur = conn.execute("DELETE FROM dashboard_panels WHERE id = %s", (panel_id,))
        conn.commit()
        return cur.rowcount > 0
