"""Regression coverage for the configured Monitor camera source.

The router cases exercise source selection and response semantics; the final
connection-boundary case verifies camera data cannot silently fall back to the
app/config connection.
"""

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
