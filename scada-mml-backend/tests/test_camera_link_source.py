"""Regression coverage for the configured Monitor camera source.

The router cases exercise source selection and response semantics; the final
connection-boundary case verifies camera data cannot silently fall back to the
app/config connection.
"""

import re
from contextlib import contextmanager
from datetime import datetime

import psycopg
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import cameras
import db


USER = {"id": 2, "username": "operator", "role": "operator"}

REMOTE_CAMERA = {
    "code": "VIS-01",
    "name": "Vision line 1",
    "station_code": "ST-01",
    "station_label": "Inspection",
    "location": "Line 1",
    "enabled": True,
    # One named slot. Deliberately shorter than the five-element defect_array
    # the counts below carry — the two columns are independent arrays and
    # nothing in the schema keeps them the same length.
    "defect_labels": ["Scratch"],
}


def test_camera_options_require_a_configured_source(monkeypatch):
    monkeypatch.setattr(db, "get_camera_link_source", lambda: {"datasource_id": None})

    with pytest.raises(HTTPException) as exc:
        cameras.camera_link_options(_user=USER)

    assert exc.value.status_code == 409
    assert exc.value.detail == "Camera source is not configured"


def test_camera_options_use_vision_datasource_codes_and_optional_labels(monkeypatch):
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": 86, "datasource_name": "vision"},
    )
    rows = [
        {**REMOTE_CAMERA, "code": "cam-001"},
        {**REMOTE_CAMERA, "code": "cam-002", "defect_labels": []},
    ]
    monkeypatch.setattr(db, "list_remote_camera_options", lambda datasource_id: rows)

    body = cameras.camera_link_options(_user=USER)
    validated = cameras.CameraLinkOptionsOut(**body)

    assert validated.datasource_id == 86
    assert validated.datasource_name == "vision"
    assert [camera.code for camera in validated.cameras] == ["cam-001", "cam-002"]
    assert validated.cameras[0].defect_labels == ["Scratch"]
    assert validated.cameras[1].defect_labels == []


@pytest.mark.parametrize("payload", [{}, {"datasource_id": None}, {"datasource_id": 0}])
def test_camera_source_update_requires_a_datasource(payload):
    with pytest.raises(ValidationError):
        cameras.CameraLinkSourceIn(**payload)


def test_deleted_datasource_cannot_be_selected(monkeypatch):
    monkeypatch.setattr(db, "get_datasource", lambda _datasource_id: None)
    monkeypatch.setattr(
        db,
        "set_camera_link_source",
        lambda _datasource_id: pytest.fail("must not save a deleted datasource"),
    )

    with pytest.raises(HTTPException) as exc:
        cameras.set_camera_link_source(
            cameras.CameraLinkSourceIn(datasource_id=999),
            _admin={"id": 1, "username": "admin", "role": "admin"},
        )

    assert exc.value.status_code == 404
    assert exc.value.detail == "Datasource not found"


def test_deleting_configured_datasource_clears_source_and_returns_409(monkeypatch):
    statements = []

    class Connection:
        def execute(self, statement, *_args):
            statements.append(str(statement))

        def commit(self):
            pass

    @contextmanager
    def app_connection():
        yield Connection()

    monkeypatch.setattr(db, "get_connection", app_connection)
    db.init_camera_link_settings_table()
    assert any("ON DELETE SET NULL" in statement for statement in statements)

    # This is the row shape after PostgreSQL applies that FK action.
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": None, "datasource_name": None},
    )
    monkeypatch.setattr(
        db,
        "get_remote_camera_option_by_code",
        lambda *_args: pytest.fail("must not query a cleared camera source"),
    )

    with pytest.raises(HTTPException) as exc:
        cameras.linked_camera_defects("cam-001", _user=USER)

    assert exc.value.status_code == 409
    assert exc.value.detail == "Camera source is not configured"


def test_camera_options_report_an_unreachable_source_as_503(monkeypatch):
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": 86, "datasource_name": "vision"},
    )
    monkeypatch.setattr(
        db,
        "list_remote_camera_options",
        lambda _datasource_id: (_ for _ in ()).throw(
            psycopg.OperationalError("vision database offline")
        ),
    )

    with pytest.raises(HTTPException) as exc:
        cameras.camera_link_options(_user=USER)

    assert exc.value.status_code == 503
    assert exc.value.detail == "vision database offline"


def test_missing_or_disabled_camera_is_404(monkeypatch):
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": 86, "datasource_name": "vision"},
    )
    monkeypatch.setattr(
        db,
        "get_remote_camera_option_by_code",
        lambda _datasource_id, _code: None,
    )

    with pytest.raises(HTTPException) as exc:
        cameras.linked_camera_defects("DISABLED-01", _user=USER)

    assert exc.value.status_code == 404
    assert exc.value.detail == "Camera not found"


def test_linked_camera_defects_read_the_configured_datasource_by_code(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": 86, "datasource_name": "vision"},
    )
    monkeypatch.setattr(
        db,
        "get_remote_camera_option_by_code",
        lambda datasource_id, code: REMOTE_CAMERA,
    )

    def latest(datasource_id, code):
        seen.update(datasource_id=datasource_id, code=code)
        return {"batch_id": 15, "updated_at": None, "defect_array": [1, 1, 1, 1, 1]}

    monkeypatch.setattr(
        db,
        "camera_defect_latest",
        latest,
    )
    monkeypatch.setattr(cameras.camera_files, "slots_with_frames", lambda _code: set())

    body = cameras.linked_camera_defects("VIS-01", _user=USER)

    assert seen == {"datasource_id": 86, "code": "VIS-01"}
    assert body["batch_id"] == 15
    assert body["total"] == 5
    assert body["slots"][0]["label"] == "Scratch"


def test_camera_with_no_defect_batch_is_not_reported_as_zero_batch(monkeypatch):
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": 86, "datasource_name": "vision"},
    )
    monkeypatch.setattr(
        db,
        "get_remote_camera_option_by_code",
        lambda _datasource_id, _code: REMOTE_CAMERA,
    )
    monkeypatch.setattr(db, "camera_defect_latest", lambda _datasource_id, _code: None)
    monkeypatch.setattr(cameras.camera_files, "slots_with_frames", lambda _code: set())

    body = cameras.linked_camera_defects("VIS-01", _user=USER)

    assert body["batch_id"] is None
    assert body["total"] == 0
    assert body["slots"] == [
        {"slot": 1, "label": "Scratch", "count": 0, "has_frames": False}
    ]


def test_null_batch_id_row_keeps_its_counts(monkeypatch):
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": 86, "datasource_name": "vision"},
    )
    monkeypatch.setattr(
        db,
        "get_remote_camera_option_by_code",
        lambda _datasource_id, _code: REMOTE_CAMERA,
    )
    monkeypatch.setattr(
        db,
        "camera_defect_latest",
        lambda _datasource_id, _code: {
            "batch_id": None,
            "updated_at": None,
            "defect_array": [2, 0, 0, 0, 0],
        },
    )
    monkeypatch.setattr(cameras.camera_files, "slots_with_frames", lambda _code: set())

    body = cameras.linked_camera_defects("VIS-01", _user=USER)

    assert body["batch_id"] is None
    assert body["total"] == 2


# --- ragged arrays ------------------------------------------------------------
# `cameras.defect_labels` and `camera_defect.defect_array` are separate columns
# on separate tables with no constraint tying their lengths together, so every
# mismatch below is a shape the vision database can legitimately produce. The
# rail must render all of them rather than blanking over a discrepancy an
# operator can neither see nor fix.
def _summary(monkeypatch, *, labels, counts, frames=frozenset()):
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": 86, "datasource_name": "vision"},
    )
    monkeypatch.setattr(
        db,
        "get_remote_camera_option_by_code",
        lambda _datasource_id, _code: {**REMOTE_CAMERA, "defect_labels": labels},
    )
    monkeypatch.setattr(
        db,
        "camera_defect_latest",
        lambda _datasource_id, _code: {
            "batch_id": 7, "updated_at": None, "defect_array": counts
        },
    )
    monkeypatch.setattr(
        cameras.camera_files, "slots_with_frames", lambda _code: set(frames)
    )
    return cameras.linked_camera_defects("VIS-01", _user=USER)


def test_more_counts_than_labels_keeps_the_unnamed_slots(monkeypatch):
    """The rail names an unlabelled slot by its number, so dropping it would
    lose real defects to a registry the operator has not finished filling in."""
    body = _summary(monkeypatch, labels=["Scratch"], counts=[1, 2, 3])

    assert [(s["slot"], s["label"], s["count"]) for s in body["slots"]] == [
        (1, "Scratch", 1), (2, None, 2), (3, None, 3),
    ]
    assert body["total"] == 6


def test_more_labels_than_counts_shows_the_extra_slots_as_zero(monkeypatch):
    """A declared defect type with no counter yet is a real zero, not absence —
    the cause list is what tells an operator which checks are even running."""
    body = _summary(monkeypatch, labels=["Scratch", "Tear", "Spot"], counts=[4])

    assert [(s["slot"], s["label"], s["count"]) for s in body["slots"]] == [
        (1, "Scratch", 4), (2, "Tear", 0), (3, "Spot", 0),
    ]
    assert body["total"] == 4


def test_null_elements_in_either_array_are_tolerated(monkeypatch):
    """Postgres arrays can hold NULLs. One unnamed slot in the middle of a
    named set must not fail the read for the other four."""
    body = _summary(monkeypatch, labels=["Scratch", None, "Spot"], counts=[1, None, 2])

    assert [(s["slot"], s["label"], s["count"]) for s in body["slots"]] == [
        (1, "Scratch", 1), (3, "Spot", 2),
    ]
    assert body["total"] == 3


def test_a_camera_with_nothing_recorded_reports_no_slots(monkeypatch):
    body = _summary(monkeypatch, labels=[], counts=[])

    assert body["slots"] == []
    assert body["total"] == 0


def test_a_slot_with_only_frames_on_disk_is_still_offered(monkeypatch):
    """Pictures exist for a defect the database has neither named nor counted.
    Hiding the chip would make them unreachable — it is the only way in."""
    body = _summary(monkeypatch, labels=[], counts=[0, 0], frames={3})

    assert [(s["slot"], s["count"], s["has_frames"]) for s in body["slots"]] == [
        (3, 0, True),
    ]


def test_an_array_longer_than_the_folder_convention_still_totals_honestly(monkeypatch):
    """`total` is the batch's real defect count and must match the source of
    truth. Only the addressable slots are listed, because a slot number that
    has no `defect_N` directory cannot show anyone a picture."""
    counts = [1] * (cameras.camera_files.MAX_SLOT + 3)
    body = _summary(monkeypatch, labels=[], counts=counts)

    assert body["total"] == len(counts)
    assert [s["slot"] for s in body["slots"]] == list(
        range(cameras.camera_files.MIN_SLOT, cameras.camera_files.MAX_SLOT + 1)
    )


def test_updated_at_is_returned_without_a_timezone(monkeypatch):
    """camera_defect.updated_at is a timestamptz cast down in the query. If an
    offset ever reached the browser, a 09:42 reject would render at the
    viewer's local time instead of the plant's."""
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": 86, "datasource_name": "vision"},
    )
    monkeypatch.setattr(
        db, "get_remote_camera_option_by_code", lambda *_args: REMOTE_CAMERA
    )
    monkeypatch.setattr(
        db,
        "camera_defect_latest",
        lambda *_args: {
            "batch_id": 7,
            "updated_at": datetime(2026, 8, 30, 9, 42),
            "defect_array": [1],
        },
    )
    monkeypatch.setattr(cameras.camera_files, "slots_with_frames", lambda _code: set())

    body = cameras.linked_camera_defects("VIS-01", _user=USER)
    validated = cameras.DefectSummaryOut(**body)

    assert validated.updated_at.tzinfo is None
    assert validated.updated_at.isoformat() == "2026-08-30T09:42:00"


def test_defect_query_casts_updated_at_and_reads_the_array_column(monkeypatch):
    """Pins the two schema-shape decisions to the SQL that implements them."""
    statements = []

    class Connection:
        def execute(self, statement, *_args):
            statements.append(str(statement))
            return type("R", (), {"fetchone": lambda _self: None})()

    @contextmanager
    def source_conn(_datasource_id):
        yield Connection(), "vision_data2"

    monkeypatch.setattr(db, "_table_source_conn", source_conn)
    db.camera_defect_latest(86, "VIS-01")

    assert "updated_at::timestamp AS updated_at" in statements[0]
    assert "defect_array" in statements[0]
    assert "defect_1" not in statements[0]


def _capture_sql(monkeypatch):
    """Record every (statement, params) a camera query sends, answering empty."""
    captured = []

    class Connection:
        def execute(self, statement, params):
            captured.append((statement.as_string(None), params))
            return type("R", (), {"fetchall": lambda _self: []})()

    @contextmanager
    def source_conn(_datasource_id):
        yield Connection(), "vision_data2"

    monkeypatch.setattr(db, "_table_source_conn", source_conn)
    return captured


def test_log_summary_labels_slots_from_the_same_plants_cameras(monkeypatch):
    """Pins the slot mapping to its SQL: the array is unnested with its slot
    number and labelled from that source's own `cameras`, unnamed slots fall
    back to "Defect N", and zero counts never become buckets."""
    captured = _capture_sql(monkeypatch)
    db.fetch_camera_log_summary("t0", "t1", camera_codes=["VIS-01"], datasource_id=86)

    statement, params = captured[0]
    assert '"vision_data2"."camera_defect_logs"' in statement
    assert "unnest(l.defect_array)" in statement and "WITH ORDINALITY" in statement
    assert 'LEFT JOIN "vision_data2"."cameras" c ON c.code = l.code' in statement
    # The slot CTE reads the labels carried through the window CTE as `l`.
    assert "l.defect_labels[s.slot]" in statement
    assert "'Defect ' || s.slot" in statement
    assert "s.cnt > 0" in statement
    assert "COUNT(DISTINCT l.batch_id)" in statement
    assert params == ("t0", "t1", ["VIS-01"])


def test_log_summary_is_one_query_that_never_ships_batch_ids(monkeypatch):
    """Per-camera figures, slots and the plant's batch count come back in one
    round trip, with batches counted in SQL — the old shape sent every distinct
    batch id to Python just to take `len()` of it."""
    captured = _capture_sql(monkeypatch)
    db.fetch_camera_log_summary("t0", "t1", datasource_id=86)
    assert len(captured) == 1
    statement, _params = captured[0]
    assert "COUNT(DISTINCT batch_id) AS batches" in statement
    assert "array_agg" not in statement
    assert "source_batches" in statement and "AS slots" in statement
    # A camera's total is the sum of the slots shown beside it.
    assert "SUM(count)::bigint AS defects" in statement
    # Materialising the window spills to disk and is slower than re-reading it.
    assert "AS NOT MATERIALIZED" in statement


def test_camera_code_filters_the_raw_log_but_the_line_filters_the_registered_one(monkeypatch):
    """Code filters inside the window subquery (index-friendly); the line is
    matched after the join on the camera's registered line, because the log's
    own copy is a stale snapshot of how the line used to be spelled."""
    captured = _capture_sql(monkeypatch)
    db.fetch_camera_log_summary("t0", "t1", locations=["Line 13"],
                                camera_codes=["VIS-01"], datasource_id=86)
    statement, params = captured[0]
    assert statement.index("code = ANY(%s)") < statement.index("LEFT JOIN")
    assert statement.index("LEFT JOIN") < statement.index("COALESCE(c.location, l.location) = ANY(%s)")
    assert params == ("t0", "t1", ["VIS-01"], ["Line 13"])


def test_hourly_query_sums_in_sql_and_counts_distinct_hours(monkeypatch):
    """(code, hour, batch) is the table's key, so a mid-hour batch change makes
    two rows for one hour; coverage must count the hour once."""
    captured = _capture_sql(monkeypatch)
    db.fetch_camera_hourly("t0", "t1", locations=["Line 13"], datasource_id=86)
    statement, params = captured[0]
    assert "SUM(h.count_total)" in statement
    assert "COUNT(DISTINCT h.period_start) AS hours_reporting" in statement
    assert 'LEFT JOIN "vision_data2"."cameras" c ON c.code = h.code' in statement
    assert "COALESCE(c.location, h.location) AS location" in statement
    assert "COALESCE(c.location, h.location) = ANY(%s)" in statement
    assert params == ("t0", "t1", ["Line 13"])


def test_defect_period_query_only_accepts_known_buckets(monkeypatch):
    """The bucket reaches SQL as a literal, so it is whitelisted first."""
    captured = _capture_sql(monkeypatch)
    db.fetch_camera_defect_periods("t0", "t1", "week", datasource_id=86)
    assert "date_trunc('week', l.created_at)" in captured[0][0]
    assert "c.defect_labels[s.slot]" in captured[0][0]
    with pytest.raises(ValueError):
        db.fetch_camera_defect_periods("t0", "t1", "week'); DROP TABLE x; --",
                                       datasource_id=86)
    assert len(captured) == 1


def test_batch_work_query_unpivots_camera_columns_and_joins_by_name(monkeypatch):
    """camera_batch_work stores one jsonb column per camera, named from the
    camera's `name` by fn_sync_camera_batch_work; the join back must use that
    same derivation, and must not name the columns (a plant can add more)."""
    captured = _capture_sql(monkeypatch)
    db.fetch_camera_batch_work("t0", "t1", locations=["Line 1"], datasource_id=86)
    statement, params = captured[0]
    assert '"vision_data2"."camera_batch_work"' in statement
    assert "jsonb_each(" in statement and "camera_1" not in statement
    assert "lower(replace(c.name, ' ', '_')) = kv.key" in statement
    assert "jsonb_typeof(kv.value) = 'array'" in statement
    # Overlap test: started before the end, last written after the start.
    assert params == ("t1", "t0", ["Line 1"], db.MAX_BATCH_WORK_ROWS)


def test_camera_roll_ups_take_the_line_from_cameras_not_the_log_snapshot(monkeypatch):
    """A log row snapshots the line as spelled at the time ("LINE 13", later
    "Line 13"); grouping on that splits one camera into two rows."""
    captured = _capture_sql(monkeypatch)
    db.fetch_camera_log_summary("t0", "t1", datasource_id=86)
    db.fetch_camera_hourly("t0", "t1", datasource_id=86)
    db.fetch_camera_defect_periods("t0", "t1", "day", datasource_id=86)
    assert len(captured) == 3
    for statement, _params in captured:
        assert re.search(r"COALESCE\(c\.location, (l|h)\.location\) AS location", statement)
        assert re.search(r'LEFT JOIN "vision_data2"\."cameras" c ON c\.code = (l|h)\.code',
                         statement)


def test_log_page_is_cut_before_the_label_join(monkeypatch):
    captured = _capture_sql(monkeypatch)
    db.fetch_camera_defect_logs_page("t0", "t1", search="cam", limit=5, offset=10,
                                     datasource_id=86)
    statement, params = captured[0]
    inner = statement.index("LIMIT %s OFFSET %s")
    assert inner < statement.index('LEFT JOIN "vision_data2"."cameras"')
    assert "defect_labels" in statement
    assert params == ("t0", "t1", "%cam%", "%cam%", 5, 10)


def test_camera_data_queries_never_use_the_app_database_connection(monkeypatch):
    class Result:
        def __init__(self, *, row=None, rows=None):
            self.row = row
            self.rows = rows

        def fetchone(self):
            return self.row

        def fetchall(self):
            return self.rows

    class Connection:
        def __init__(self, result):
            self.result = result

        def execute(self, *_args, **_kwargs):
            return self.result

    seen = []

    def install_source(result):
        @contextmanager
        def source_conn(datasource_id):
            seen.append(datasource_id)
            yield Connection(result), "vision_data"

        monkeypatch.setattr(db, "_table_source_conn", source_conn)

    monkeypatch.setattr(
        db,
        "get_connection",
        lambda: pytest.fail("camera data must not use the app/config connection"),
    )

    install_source(Result(rows=[REMOTE_CAMERA]))
    assert db.list_remote_camera_options(86) == [REMOTE_CAMERA]

    install_source(Result(row=REMOTE_CAMERA))
    assert db.get_remote_camera_option_by_code(86, "VIS-01") == REMOTE_CAMERA

    defect = {"code": "VIS-01", "batch_id": 15}
    install_source(Result(row=defect))
    assert db.camera_defect_latest(86, "VIS-01") == defect
    assert seen == [86, 86, 86]


def test_defect_query_reports_an_unreachable_source_as_503(monkeypatch):
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": 86, "datasource_name": "vision"},
    )
    monkeypatch.setattr(
        db,
        "get_remote_camera_option_by_code",
        lambda _datasource_id, _code: REMOTE_CAMERA,
    )
    monkeypatch.setattr(
        db,
        "camera_defect_latest",
        lambda _datasource_id, _code: (_ for _ in ()).throw(
            psycopg.OperationalError("vision database offline")
        ),
    )

    with pytest.raises(HTTPException) as exc:
        cameras.linked_camera_defects("VIS-01", _user=USER)

    assert exc.value.status_code == 503
