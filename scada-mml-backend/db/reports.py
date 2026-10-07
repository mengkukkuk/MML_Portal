"""Report templates, settings and the state/alarm/event-log report queries."""

from datetime import datetime
from typing import Any

from psycopg import sql
import psycopg
from psycopg.types.json import Json

import config

from . import pool as _pool
from . import tables as _tables

__all__ = [
    "REPORT_LAYOUT_VERSION",
    "_CATALOG_TTL_SECONDS",
    "_DEFAULT_STATE_RULES",
    "_DEFAULT_TEMPLATE_BLOCKS",
    "_LAYOUT_V2_BLOCKS",
    "_TEMPLATE_COLS",
    "_catalog_cache",
    "_machine_filter",
    "_upgrade_report_templates",
    "count_event_log",
    "create_report_template",
    "delete_report_template",
    "fetch_alarms_for_window",
    "fetch_event_log_page",
    "fetch_state_events",
    "get_default_report_template",
    "get_report_settings",
    "get_report_template",
    "init_report_tables",
    "list_report_templates",
    "report_catalog",
    "update_report_settings",
    "update_report_template",
]

# ============================================================================
# Reports — OEE / production status reporting
# ============================================================================

_DEFAULT_STATE_RULES = {
    "PLANNED_DOWN": ["changeover", "maintenance", "cleaning", "setup", "break"],
    "IDLE": ["idle", "standby", "wait"],
    "STOP": ["stop", "fault", "trip", "fail", "emergency", "alarm"],
    "RUN": ["start", "running", "run", "auto"],
}

_DEFAULT_TEMPLATE_BLOCKS = [
    # QC Summary tab — the analyst's read: how much, which defects, where.
    {"id": "b1", "type": "kpi", "title": "Overview", "width": "full",
     "options": {"targetDefectPct": 3}},
    {"id": "b7", "type": "defect_trend", "title": "Defects Over Time", "width": "full",
     "options": {}},
    {"id": "b3", "type": "pareto", "title": "Defect Type Pareto", "width": "half",
     "options": {"topN": 10, "rankBy": "count"}},
    {"id": "b4", "type": "exceptions", "title": "Quality Exceptions", "width": "half",
     "options": {"warnPct": 2, "critPct": 5, "topN": 10}},
    {"id": "b5", "type": "summary_table", "title": "Camera Summary", "width": "full",
     "options": {"columns": ["camera", "inspected", "defects", "rate", "batches",
                             "perBatch", "worstDefect", "lastSeen", "status"]}},
    # Engineering tab — the detail an engineer chases a finding down with.
    {"id": "b8", "type": "batch_matrix", "title": "Batch x Camera Matrix", "width": "full",
     "options": {}},
    {"id": "b9", "type": "defect_grid", "title": "Camera x Defect Type", "width": "full",
     "options": {}},
    {"id": "b2", "type": "timeline", "title": "Camera Defect Timeline", "width": "full",
     "options": {}},
    {"id": "b6", "type": "raw_log", "title": "Defect Batch Log", "width": "full",
     "options": {"pageSize": 50}},
]

#: Bumped when the default block set grows. Templates saved under an older
#: layout get the missing standard blocks appended once, on boot, and are
#: stamped with this version in `default_filters.layout` — so an admin who
#: later removes one of them deliberately doesn't see it come back.
REPORT_LAYOUT_VERSION = 2
_LAYOUT_V2_BLOCKS = ("defect_trend", "batch_matrix", "defect_grid")


def _upgrade_report_templates(conn) -> None:
    rows = conn.execute(
        "SELECT id, blocks, default_filters FROM report_templates").fetchall()
    standard = {b["type"]: b for b in _DEFAULT_TEMPLATE_BLOCKS}
    for row in rows:
        filters = row["default_filters"] or {}
        if (filters.get("layout") or 1) >= REPORT_LAYOUT_VERSION:
            continue
        blocks = list(row["blocks"] or [])
        have = {b.get("type") for b in blocks}
        # A saved Camera Summary column list predates the batch columns; slot
        # them in after "rate" so existing reports gain them too.
        for block in blocks:
            cols = (block.get("options") or {}).get("columns")
            if block.get("type") == "summary_table" and cols and "batches" not in cols:
                at = cols.index("rate") + 1 if "rate" in cols else len(cols)
                block["options"] = {**block["options"],
                                    "columns": [*cols[:at], "batches", "perBatch", *cols[at:]]}
        for block_type in _LAYOUT_V2_BLOCKS:
            if block_type not in have:
                blocks.append({**standard[block_type], "id": f"{standard[block_type]['id']}v2"})
        conn.execute(
            "UPDATE report_templates SET blocks = %s, default_filters = %s WHERE id = %s",
            (Json(blocks), Json({**filters, "layout": REPORT_LAYOUT_VERSION}), row["id"]),
        )


def init_report_tables() -> None:
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS report_templates (
                id              SERIAL PRIMARY KEY,
                name            TEXT NOT NULL,
                description     TEXT NOT NULL DEFAULT '',
                blocks          JSONB NOT NULL DEFAULT '[]'::jsonb,
                default_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
                is_default      BOOLEAN NOT NULL DEFAULT FALSE,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS report_settings (
                id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                state_rules        JSONB   NOT NULL DEFAULT '{}'::jsonb,
                alarm_lead_seconds INTEGER NOT NULL DEFAULT 60,
                updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.execute(
            """INSERT INTO report_settings (id, state_rules)
               VALUES (1, %s) ON CONFLICT (id) DO NOTHING""",
            (Json(_DEFAULT_STATE_RULES),),
        )
        # Seed the default template only into an empty table.
        empty = conn.execute("SELECT COUNT(*) AS n FROM report_templates").fetchone()
        if not empty["n"]:
            conn.execute(
                """INSERT INTO report_templates
                       (name, description, blocks, default_filters, is_default)
                   VALUES (%s, %s, %s, %s, TRUE)""",
                ("Vision QC Report",
                 "Defect counts, defect types and quality exceptions per camera, batch by batch.",
                 Json(_DEFAULT_TEMPLATE_BLOCKS),
                 Json({"preset": "last7d", "layout": REPORT_LAYOUT_VERSION})),
            )
        _upgrade_report_templates(conn)
        conn.commit()

    try:
        with _pool.get_connection() as conn:
            conn.execute(
                sql.SQL(
                    "CREATE INDEX IF NOT EXISTS event_logs_loc_tag_time_idx "
                    "ON {} (location, tag_name, at_date_time DESC)"
                ).format(sql.Identifier(config.APP_DB_SCHEMA, "event_logs"))
            )
            conn.commit()
    except psycopg.Error:
        pass

# --- Template CRUD ----------------------------------------------------------
_TEMPLATE_COLS = ("id, name, description, blocks, default_filters, is_default, "
                  "created_at, updated_at")

def list_report_templates() -> list[dict[str, Any]]:
    with _pool.get_connection() as conn:
        return conn.execute(
            f"SELECT {_TEMPLATE_COLS} FROM report_templates "
            "ORDER BY is_default DESC, name"
        ).fetchall()


def get_report_template(template_id: int) -> dict[str, Any] | None:
    with _pool.get_connection() as conn:
        return conn.execute(
            f"SELECT {_TEMPLATE_COLS} FROM report_templates WHERE id = %s",
            (template_id,),
        ).fetchone()


def get_default_report_template() -> dict[str, Any] | None:
    with _pool.get_connection() as conn:
        return conn.execute(
            f"SELECT {_TEMPLATE_COLS} FROM report_templates "
            "ORDER BY is_default DESC, name LIMIT 1"
        ).fetchone()


def create_report_template(name, description, blocks, default_filters, is_default):
    with _pool.get_connection() as conn:
        if is_default:
            conn.execute("UPDATE report_templates SET is_default = FALSE")
        row = conn.execute(
            f"""INSERT INTO report_templates
                    (name, description, blocks, default_filters, is_default)
                VALUES (%s, %s, %s, %s, %s) RETURNING {_TEMPLATE_COLS}""",
            (name, description, Json(blocks), Json(default_filters), is_default),
        ).fetchone()
        conn.commit()
    return row


def update_report_template(template_id, name, description, blocks,
                           default_filters, is_default):
    with _pool.get_connection() as conn:
        if is_default:
            # Exactly one default — clear the others first so /reports never has
            # to arbitrate between two.
            conn.execute(
                "UPDATE report_templates SET is_default = FALSE WHERE id <> %s",
                (template_id,),
            )
        row = conn.execute(
            f"""UPDATE report_templates
                   SET name = %s, description = %s, blocks = %s,
                       default_filters = %s, is_default = %s, updated_at = now()
                 WHERE id = %s RETURNING {_TEMPLATE_COLS}""",
            (name, description, Json(blocks), Json(default_filters),
             is_default, template_id),
        ).fetchone()
        conn.commit()
    return row


def delete_report_template(template_id: int) -> bool:
    with _pool.get_connection() as conn:
        cur = conn.execute("DELETE FROM report_templates WHERE id = %s", (template_id,))
        conn.commit()
    return cur.rowcount > 0


# --- Settings ---------------------------------------------------------------
def get_report_settings() -> dict[str, Any]:
    """Plant-wide event vocabulary. Falls back to the built-in defaults when the
    stored rules are empty, so a wiped row degrades to sane behaviour rather
    than classifying every event as UNKNOWN."""
    with _pool.get_connection() as conn:
        row = conn.execute(
            "SELECT state_rules, alarm_lead_seconds, updated_at "
            "FROM report_settings WHERE id = 1"
        ).fetchone()
    if not row:
        return {"state_rules": _DEFAULT_STATE_RULES, "alarm_lead_seconds": 60,
                "updated_at": None}
    if not row.get("state_rules"):
        row["state_rules"] = _DEFAULT_STATE_RULES
    return row


def update_report_settings(state_rules: dict, alarm_lead_seconds: int) -> dict[str, Any]:
    with _pool.get_connection() as conn:
        row = conn.execute(
            """INSERT INTO report_settings (id, state_rules, alarm_lead_seconds)
               VALUES (1, %s, %s)
               ON CONFLICT (id) DO UPDATE
                 SET state_rules = EXCLUDED.state_rules,
                     alarm_lead_seconds = EXCLUDED.alarm_lead_seconds,
                     updated_at = now()
               RETURNING state_rules, alarm_lead_seconds, updated_at""",
            (Json(state_rules), alarm_lead_seconds),
        ).fetchone()
        conn.commit()
    return row


# --- Machine catalog --------------------------------------------------------
# variables_tag is the live tag registry (tiny, one row per tag) and event_logs
# covers decommissioned machines that still have history. The union is cached
# because the event_logs DISTINCT is the expensive half and the answer changes
# only when the plant is re-tagged.
# Keyed by datasource: two plants have entirely unrelated machine lists, and a
# single cache would serve whichever one asked first to everybody.
_catalog_cache: dict[int | None, tuple[float, list[dict[str, Any]]]] = {}
_CATALOG_TTL_SECONDS = 300


def report_catalog(force: bool = False,
                   datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Distinct (location, tag_name) pairs — feeds the Line/Machine pickers."""
    now = datetime.now().timestamp()
    cached = _catalog_cache.get(datasource_id)
    if not force and cached and now - cached[0] < _CATALOG_TTL_SECONDS:
        return cached[1]

    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT location, tag_name FROM (
                       SELECT location, tag_name FROM {tags}
                       UNION
                       SELECT location, tag_name FROM {events}
                   ) c
                   WHERE tag_name IS NOT NULL
                   ORDER BY location NULLS LAST, tag_name"""
            ).format(
                tags=sql.Identifier(schema, "variables_tag"),
                events=sql.Identifier(schema, "event_logs"),
            )
        ).fetchall()
    _catalog_cache[datasource_id] = (now, rows)
    return rows


# --- Log queries ------------------------------------------------------------
def _machine_filter(locations, tag_names):
    """Build the shared WHERE fragment. Empty lists mean 'no filter' rather than
    'match nothing', which is what the UI's empty multi-selects imply."""
    clauses, params = [], []
    if locations:
        clauses.append("location = ANY(%s)")
        params.append(list(locations))
    if tag_names:
        clauses.append("tag_name = ANY(%s)")
        params.append(list(tag_names))
    return ("".join(f" AND {c}" for c in clauses), params)


def fetch_state_events(start: datetime, end: datetime, locations=None,
                       tag_names=None, datasource_id: int | None = None,
                       ) -> list[dict[str, Any]]:
    """Window events plus one carry-in row per machine, in a single round trip.

    The carry-in half (DISTINCT ON … at_date_time < start) is what lets a machine
    that ran all week with no events inside a one-day window still report
    runtime. Both halves ride the (location, tag_name, at_date_time) index.
    """
    where, params = _machine_filter(locations, tag_names)
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """(SELECT DISTINCT ON (location, tag_name)
                           location, tag_name, event, at_date_time
                      FROM {events}
                     WHERE at_date_time < %s""" + where + """
                     ORDER BY location, tag_name, at_date_time DESC)
                   UNION ALL
                   (SELECT location, tag_name, event, at_date_time
                      FROM {events}
                     WHERE at_date_time >= %s AND at_date_time < %s""" + where + """)
                   ORDER BY 1, 2, 4"""
            ).format(events=sql.Identifier(schema, "event_logs")),
            (start, *params, start, end, *params),
        ).fetchall()


def fetch_alarms_for_window(start: datetime, end: datetime, locations=None,
                            tag_names=None, datasource_id: int | None = None,
                            ) -> list[dict[str, Any]]:
    """Alarms overlapping the window, used to name downtime causes.

    `start` is expected to be already widened by the lead window so an alarm that
    fired just before the machine halted still matches.
    """
    where, params = _machine_filter(locations, tag_names)
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """SELECT id, location, tag_name, alarm_events AS text,
                          severity, created_at AS at
                     FROM {alarms}
                    WHERE created_at >= %s AND created_at < %s""" + where + """
                    ORDER BY created_at"""
            ).format(alarms=sql.Identifier(schema, "alarm_logs")),
            (start, end, *params),
        ).fetchall()


def count_event_log(start, end, locations=None, tag_names=None, search=None,
                    datasource_id: int | None = None) -> int:
    where, params = _machine_filter(locations, tag_names)
    if search:
        where += " AND event ILIKE %s"
        params.append(f"%{search}%")
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        row = conn.execute(
            sql.SQL(
                """SELECT COUNT(*) AS n FROM {events}
                    WHERE at_date_time >= %s AND at_date_time < %s""" + where
            ).format(events=sql.Identifier(schema, "event_logs")),
            (start, end, *params),
        ).fetchone()
    return row["n"]


def fetch_event_log_page(start, end, locations=None, tag_names=None, search=None,
                         limit: int = 50, offset: int = 0,
                         datasource_id: int | None = None) -> list[dict[str, Any]]:
    """One page of the raw log, newest first — backs the on-screen table and,
    with a large limit, the spreadsheet export."""
    where, params = _machine_filter(locations, tag_names)
    if search:
        where += " AND event ILIKE %s"
        params.append(f"%{search}%")
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """SELECT location, tag_name, event, at_date_time
                     FROM {events}
                    WHERE at_date_time >= %s AND at_date_time < %s""" + where + """
                    ORDER BY at_date_time DESC
                    LIMIT %s OFFSET %s"""
            ).format(events=sql.Identifier(schema, "event_logs")),
            (start, end, *params, limit, offset),
        ).fetchall()
