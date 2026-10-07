"""Camera link settings, remote camera options and the vision/camera report queries."""

from datetime import datetime
from typing import Any

from psycopg import sql

from . import pool as _pool
from . import reports as _reports
from . import tables as _tables

__all__ = [
    "MAX_BATCH_WORK_ROWS",
    "PERIOD_BUCKETS",
    "_SLOT_LABEL",
    "_camera_filter",
    "_camera_scope",
    "_slot_label",
    "_vision_catalog_cache",
    "camera_defect_latest",
    "count_camera_defect_logs",
    "fetch_camera_batch_work",
    "fetch_camera_defect_logs_page",
    "fetch_camera_defect_periods",
    "fetch_camera_hourly",
    "fetch_camera_log_summary",
    "get_camera_link_source",
    "get_remote_camera_option_by_code",
    "init_camera_link_settings_table",
    "list_remote_camera_options",
    "set_camera_link_source",
    "vision_report_catalog",
]

# --- Cameras (/monitor vision-inspection panel) -----------------------------
# App DB owns only the selected datasource id. Camera identity and defect
# batches live in that datasource's configured schema; NG frames live on disk.
def init_camera_link_settings_table() -> None:
    """Create the singleton settings row behind the Monitor camera picker.

    A source is required before Monitor camera bindings can load. The nullable
    FK still matters for lifecycle safety: deleting the selected datasource
    clears the singleton and makes camera endpoints return 409 until an admin
    chooses a replacement. Must run after init_datasources_table (FK).
    """
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS camera_link_settings (
                id            INTEGER PRIMARY KEY DEFAULT 1,
                datasource_id INTEGER REFERENCES datasources(id) ON DELETE SET NULL,
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT camera_link_settings_singleton CHECK (id = 1)
            )"""
        )
        conn.execute(
            "INSERT INTO camera_link_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING"
        )
        conn.commit()


def get_camera_link_source() -> dict[str, Any] | None:
    """The datasource designated as Monitor's camera source.

    A null datasource means the feature is not configured; there is no app-DB
    camera fallback.
    """
    with _pool.get_connection() as conn:
        row = conn.execute(
            """SELECT s.datasource_id, d.name AS datasource_name
               FROM camera_link_settings s
               LEFT JOIN datasources d ON d.id = s.datasource_id
               WHERE s.id = 1"""
        ).fetchone()
    return row


def set_camera_link_source(datasource_id: int) -> dict[str, Any] | None:
    with _pool.get_connection() as conn:
        conn.execute(
            """UPDATE camera_link_settings
               SET datasource_id = %s, updated_at = now()
               WHERE id = 1""",
            (datasource_id,),
        )
        conn.commit()
    return get_camera_link_source()


def list_remote_camera_options(datasource_id: int) -> list[dict[str, Any]]:
    """Camera identity rows read from the configured camera datasource.

    Not routed through the generic table/schema picker (schema.py / the
    describe_table family): `cameras` sits in that path's SENSITIVE_TABLES
    denylist, because reading it *locally* would expose this app's own camera
    config as a chartable table. Rather than punch a name-based hole in that
    denylist, this is a purpose-built, fixed-shape read of one specific
    connection an admin has deliberately designated for exactly this.
    """
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT code, name, station_code, station_label, location, enabled,
                          COALESCE(defect_labels, ARRAY[]::text[]) AS defect_labels
                   FROM {tbl}
                   WHERE enabled
                   ORDER BY location NULLS LAST, code"""
            ).format(tbl=sql.Identifier(schema, "cameras"))
        ).fetchall()
    return rows


def get_remote_camera_option_by_code(
    datasource_id: int, code: str
) -> dict[str, Any] | None:
    """One camera identity from the configured external camera registry.

    The Monitor rail resolves by the stable printed code, never by the remote
    table's serial id: ids can collide across databases and change on reseed.
    """
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        row = conn.execute(
            sql.SQL(
                """SELECT code, name, station_code, station_label, location, enabled,
                          COALESCE(defect_labels, ARRAY[]::text[]) AS defect_labels
                   FROM {tbl}
                   WHERE enabled AND lower(code) = lower(%s)
                   LIMIT 1"""
            ).format(tbl=sql.Identifier(schema, "cameras")),
            (code,),
        ).fetchone()
    return row


def camera_defect_latest(datasource_id: int, code: str) -> dict[str, Any] | None:
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        row = conn.execute(
            sql.SQL(
                """SELECT id, code, batch_id, updated_at::timestamp AS updated_at,
                          defect_array
                   FROM {table}
                   WHERE lower(code) = lower(%s)
                   ORDER BY batch_id DESC NULLS LAST, updated_at DESC, id DESC
                   LIMIT 1"""
            ).format(table=sql.Identifier(schema, "camera_defect")),
            (code,),
        ).fetchone()
    return row


# --- Vision (camera QC) catalog & log queries --------------------------------
# Mirrors the machine-report helpers above one-for-one, but reads the
# vision_data schema instead: `cameras` stands in for the tag registry,
# `production_hourly_log` for the windowed totals event_logs derives runtime
# from, and `camera_defect_logs` for the raw per-batch historian. Kept
# separate rather than parameterising the machine helpers because the two
# schemas' primary keys (tag_name vs. camera code) and windowing columns
# (at_date_time vs. period_start/created_at) don't line up cleanly enough to
# share a query without a maze of branching.
_vision_catalog_cache: dict[int | None, tuple[float, list[dict[str, Any]]]] = {}


def vision_report_catalog(force: bool = False,
                          datasource_id: int | None = None) -> list[dict[str, Any]]:
    """Distinct (location, code, name) camera rows — feeds the Line/Camera pickers."""
    now = datetime.now().timestamp()
    cached = _vision_catalog_cache.get(datasource_id)
    if not force and cached and now - cached[0] < _reports._CATALOG_TTL_SECONDS:
        return cached[1]

    with _tables._table_source_conn(datasource_id) as (conn, schema):
        rows = conn.execute(
            sql.SQL(
                """SELECT location, code, name FROM {cameras}
                   ORDER BY location NULLS LAST, code"""
            ).format(cameras=sql.Identifier(schema, "cameras"))
        ).fetchall()
    _vision_catalog_cache[datasource_id] = (now, rows)
    return rows


def _camera_filter(locations, camera_codes):
    """Same "empty means unfiltered" contract as `_machine_filter`."""
    clauses, params = [], []
    if locations:
        clauses.append("location = ANY(%s)")
        params.append(list(locations))
    if camera_codes:
        clauses.append("code = ANY(%s)")
        params.append(list(camera_codes))
    return ("".join(f" AND {c}" for c in clauses), params)


def _camera_scope(locations, camera_codes):
    """`(code_where, location_where, params)` for a query over a log table
    joined to `cameras` as `c`, the log side aliased `l`/`h`.

    The camera code filters the raw table, inside the window subquery, where a
    plain column can use an index. The line is filtered *after* the join, on
    `COALESCE(c.location, <log>.location)`: that is the spelling the Line picker
    offers (it comes from `cameras`) and the one rows are grouped under, while
    a log row's own copy is a stale snapshot ("LINE 13" last month, "Line 13"
    now) that would silently drop a moved camera's older rows.

    `params` follow the placeholders' order in the SQL: codes, then lines."""
    code_where, location_where, params = "", "", []
    if camera_codes:
        code_where = " AND code = ANY(%s)"
        params.append(list(camera_codes))
    if locations:
        location_where = " AND COALESCE(c.location, {side}.location) = ANY(%s)"
        params.append(list(locations))
    return code_where, location_where, params


def fetch_camera_hourly(start: datetime, end: datetime, locations=None,
                        camera_codes=None, datasource_id: int | None = None,
                        ) -> list[dict[str, Any]]:
    """`{location, code, inspected, hours_reporting}` per camera, windowed on
    `period_start` — the vision equivalent of a machine's runtime/downtime
    split. A camera silent for the whole window contributes no row, which the
    aggregator reads as "no data" rather than "zero throughput".

    Summed here rather than in Python so a year of hours stays one row per
    camera on the wire. `hours_reporting` counts *distinct* hours: the table is
    unique on (code, hour, batch), so a batch change mid-hour gives that hour
    two rows and a row count would report coverage the camera never had. The
    line is the camera's registered one, like every other camera roll-up, so
    its inspected count lands on the same camera as its defects."""
    code_where, location_where, params = _camera_scope(locations, camera_codes)
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """SELECT COALESCE(c.location, h.location) AS location, h.code,
                          COALESCE(SUM(h.count_total), 0)::bigint AS inspected,
                          COUNT(DISTINCT h.period_start) AS hours_reporting
                     FROM (SELECT location, code, period_start, count_total
                             FROM {tbl}
                            WHERE period_start >= %s AND period_start < %s""" + code_where + """
                          ) h
                     LEFT JOIN {cameras} c ON c.code = h.code
                    WHERE TRUE""" + location_where.format(side="h") + """
                    GROUP BY 1, h.code"""
            ).format(tbl=sql.Identifier(schema, "production_hourly_log"),
                     cameras=sql.Identifier(schema, "cameras")),
            (start, end, *params),
        ).fetchall()


# Every report block reads the per-batch historian (`camera_defect_logs`) or
# its pivot (`camera_batch_work`); `production_hourly_log` above is kept only
# for the inspected count a defect *rate* needs. Each query below pairs a
# defect_array slot with its name from `cameras.defect_labels` *inside the
# plant's own database*: pairing in Python off a code -> labels map merged
# across the whole selection would label plant A's batches with plant B's
# names whenever the two share a camera code.
#
# A camera's line is read from `cameras` when it is registered there: a log
# row snapshots the line as it was spelled at the time ("LINE 13" last month,
# "Line 13" now), and grouping on the snapshot would split one camera in two.
# The log's own copy is only the fallback for a camera no longer registered.
#
# Slot N of `defect_array` is `defect_labels[N]` (both 1-based via WITH
# ORDINALITY). An unnamed slot — an array longer than its labels, or a
# NULL/blank entry — falls back to "Defect N" rather than dropping the counts.
def _slot_label(labels: str) -> str:
    return f"COALESCE(NULLIF({labels}[s.slot], ''), 'Defect ' || s.slot)"


_SLOT_LABEL = _slot_label("c.defect_labels")

#: date_trunc() units the defect-period query accepts.
PERIOD_BUCKETS = ("hour", "day", "week", "month")


def fetch_camera_log_summary(start: datetime, end: datetime, locations=None,
                             camera_codes=None, datasource_id: int | None = None,
                             ) -> list[dict[str, Any]]:
    """One row per camera that logged in the window, in one query over
    `camera_defect_logs`: `{location, code, name, defects, batches, log_rows,
    last_seen, slots, source_batches}`.

    `defects` is the sum of the camera's `slots` — each slot's counts are
    already summed in the unnest pass, so the total costs no second look at
    every row, and a camera's figure can't disagree with the slots shown beside
    it (counts are never negative, so skipping zero slots loses nothing).
    `batches` is that camera's distinct batch ids. `slots` is its labelled
    defect types,
    `[{slot, defect, count, batches}]` in slot order, zero-count slots left out
    — it feeds each camera's worst defect, the pareto and the defect grid, so
    none of them needs a scan of its own. `source_batches` is the distinct
    batches across *all* the plant's cameras, repeated on every row: one batch
    runs past every camera on the line, so summing `batches` per camera would
    count it once per camera. Batch ids are per-plant serials, which is why the
    caller sums `source_batches` across plants rather than merging ids.

    The window is one CTE, `l`, with the camera's registered line and its
    labels joined on; see `_camera_scope` for why the line comes from
    `cameras`. It is deliberately NOT MATERIALIZED: spilling a wide window to a
    temp file cost ~1s more per 400k rows than letting each roll-up re-read the
    (cached) table. What a roll-up costs is its sort, not the scan."""
    code_where, location_where, params = _camera_scope(locations, camera_codes)
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """WITH l AS NOT MATERIALIZED (
                       SELECT COALESCE(c.location, l.location) AS location, l.code,
                              COALESCE(c.name, l.name) AS name, l.batch_id,
                              l.defect_array, l.created_at, c.defect_labels
                         FROM (SELECT location, code, name, batch_id, defect_array, created_at
                                 FROM {logs}
                                WHERE created_at >= %s AND created_at < %s""" + code_where + """
                              ) l
                         LEFT JOIN {cameras} c ON c.code = l.code
                        WHERE TRUE""" + location_where.format(side="l") + """
                   ),
                   slot AS (
                       SELECT l.location, l.code, s.slot,
                              """ + _slot_label("l.defect_labels") + """ AS defect,
                              SUM(s.cnt)::bigint AS count,
                              COUNT(DISTINCT l.batch_id) AS batches
                         FROM l
                        CROSS JOIN LATERAL unnest(l.defect_array)
                              WITH ORDINALITY AS s(cnt, slot)
                        WHERE s.cnt > 0
                        GROUP BY l.location, l.code, s.slot, 4
                   ),
                   cam AS (
                       SELECT location, code, MAX(name) AS name,
                              COUNT(DISTINCT batch_id) AS batches,
                              COUNT(*) AS log_rows,
                              MAX(created_at) AS last_seen
                         FROM l
                        GROUP BY location, code
                   ),
                   cam_slots AS (
                       SELECT location, code, SUM(count)::bigint AS defects,
                              jsonb_agg(jsonb_build_object(
                                  'slot', slot, 'defect', defect,
                                  'count', count, 'batches', batches) ORDER BY slot) AS slots
                         FROM slot
                        GROUP BY location, code
                   )
                   SELECT cam.location, cam.code, cam.name,
                          COALESCE(cs.defects, 0) AS defects,
                          cam.batches, cam.log_rows, cam.last_seen,
                          (SELECT COUNT(DISTINCT batch_id) FROM l) AS source_batches,
                          COALESCE(cs.slots, '[]'::jsonb) AS slots
                     FROM cam
                     LEFT JOIN cam_slots cs
                            ON cs.location IS NOT DISTINCT FROM cam.location
                           AND cs.code = cam.code"""
            ).format(logs=sql.Identifier(schema, "camera_defect_logs"),
                     cameras=sql.Identifier(schema, "cameras")),
            (start, end, *params),
        ).fetchall()


def fetch_camera_defect_periods(start: datetime, end: datetime, bucket: str,
                                locations=None, camera_codes=None,
                                datasource_id: int | None = None,
                                ) -> list[dict[str, Any]]:
    """`{period, location, code, defect, count}` — defects per time bucket per
    camera per labelled slot. Feeds both the defects-over-time chart (merged
    across cameras) and the camera timeline heatmap (merged across types).

    `bucket` is a date_trunc() unit from PERIOD_BUCKETS; the caller picks it
    from the window so a year renders as ~52 weeks, not 8,760 hours."""
    if bucket not in PERIOD_BUCKETS:
        raise ValueError(f"unsupported bucket {bucket!r}")
    code_where, location_where, params = _camera_scope(locations, camera_codes)
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """SELECT date_trunc({unit}, l.created_at) AS period,
                          COALESCE(c.location, l.location) AS location, l.code,
                          """ + _SLOT_LABEL + """ AS defect,
                          SUM(s.cnt)::bigint AS count
                     FROM (SELECT location, code, defect_array, created_at
                             FROM {logs}
                            WHERE created_at >= %s AND created_at < %s""" + code_where + """
                          ) l
                    CROSS JOIN LATERAL unnest(l.defect_array)
                          WITH ORDINALITY AS s(cnt, slot)
                     LEFT JOIN {cameras} c ON c.code = l.code
                    WHERE s.cnt > 0""" + location_where.format(side="l") + """
                    GROUP BY 1, 2, 3, 4
                    ORDER BY 1"""
            ).format(unit=sql.Literal(bucket),
                     logs=sql.Identifier(schema, "camera_defect_logs"),
                     cameras=sql.Identifier(schema, "cameras")),
            (start, end, *params),
        ).fetchall()


#: A batch-work window is one row per batch per camera, so this only bites on a
#: plant rolling batches every few minutes for a year.
MAX_BATCH_WORK_ROWS = 2000


def fetch_camera_batch_work(start: datetime, end: datetime, locations=None,
                            camera_codes=None, datasource_id: int | None = None,
                            ) -> list[dict[str, Any]]:
    """`camera_batch_work` unpivoted to one row per batch per camera.

    The table is a pivot: one row per batch, one jsonb column per camera
    (`camera_1` … `camera_N`) holding that camera's defect_array. The column
    name is the camera's `name` lower-cased with spaces as underscores — how
    `fn_sync_camera_batch_work` derives it — so that is the join back to
    `cameras` and its `defect_labels`. Columns are read with jsonb_each rather
    than named, so a plant that adds `camera_6` needs no code change. A column
    that matches no camera still comes back, with `code` NULL.

    A batch overlaps the window when it started before the end and was last
    written after the start. Newest batches first, capped at
    MAX_BATCH_WORK_ROWS batch-camera rows."""
    where, params = _camera_filter(locations, camera_codes)
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """SELECT b.batch_id, b.status, b.created_at, b.updated_at,
                          kv.key AS column_name, c.location, c.code, c.name,
                          ARRAY(SELECT e::numeric::bigint
                                  FROM jsonb_array_elements_text(kv.value) e) AS defect_array,
                          COALESCE(c.defect_labels, ARRAY[]::text[]) AS defect_labels
                     FROM {work} b
                    CROSS JOIN LATERAL jsonb_each(
                          to_jsonb(b) - 'batch_id' - 'status' - 'created_at' - 'updated_at'
                          ) AS kv
                     LEFT JOIN {cameras} c ON lower(replace(c.name, ' ', '_')) = kv.key
                    WHERE jsonb_typeof(kv.value) = 'array'
                      AND b.created_at < %s
                      AND COALESCE(b.updated_at, b.created_at) >= %s""" + where + """
                    ORDER BY b.batch_id DESC, kv.key
                    LIMIT %s"""
            ).format(work=sql.Identifier(schema, "camera_batch_work"),
                     cameras=sql.Identifier(schema, "cameras")),
            (end, start, *params, MAX_BATCH_WORK_ROWS),
        ).fetchall()


def count_camera_defect_logs(start, end, locations=None, camera_codes=None, search=None,
                             datasource_id: int | None = None) -> int:
    where, params = _camera_filter(locations, camera_codes)
    if search:
        where += " AND (name ILIKE %s OR code ILIKE %s)"
        params.extend([f"%{search}%", f"%{search}%"])
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        row = conn.execute(
            sql.SQL(
                """SELECT COUNT(*) AS n FROM {tbl}
                    WHERE created_at >= %s AND created_at < %s""" + where
            ).format(tbl=sql.Identifier(schema, "camera_defect_logs")),
            (start, end, *params),
        ).fetchone()
    return row["n"]


def fetch_camera_defect_logs_page(start, end, locations=None, camera_codes=None, search=None,
                                  limit: int = 50, offset: int = 0,
                                  datasource_id: int | None = None) -> list[dict[str, Any]]:
    """One page of the batch-defect log, newest first, each row carrying its
    camera's `defect_labels` so every slot can be named. The page is cut in the
    inner query and only then joined, so the join can never widen it
    (`cameras.code` is unique)."""
    where, params = _camera_filter(locations, camera_codes)
    if search:
        where += " AND (name ILIKE %s OR code ILIKE %s)"
        params.extend([f"%{search}%", f"%{search}%"])
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        return conn.execute(
            sql.SQL(
                """SELECT l.*, COALESCE(c.defect_labels, ARRAY[]::text[]) AS defect_labels
                     FROM (SELECT id, location, code, name, batch_id, defect_array, created_at
                             FROM {tbl}
                            WHERE created_at >= %s AND created_at < %s""" + where + """
                            ORDER BY created_at DESC
                            LIMIT %s OFFSET %s) l
                     LEFT JOIN {cameras} c ON c.code = l.code
                    ORDER BY l.created_at DESC"""
            ).format(tbl=sql.Identifier(schema, "camera_defect_logs"),
                     cameras=sql.Identifier(schema, "cameras")),
            (start, end, *params, limit, offset),
        ).fetchall()
