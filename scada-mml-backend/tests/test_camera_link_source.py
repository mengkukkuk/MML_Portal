"""Regression coverage for the configured Monitor camera source.

These tests stay above the database connection layer: the failure in
``c23bf6d6`` was routing, not SQL.  A selected remote registry must resolve the
rail's camera identity without consulting the app/config ``cameras`` table.
"""

import pytest
import psycopg
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
    "defect_1_label": "Scratch",
    "defect_2_label": None,
    "defect_3_label": None,
    "defect_4_label": None,
    "defect_5_label": None,
}


def test_camera_options_require_a_configured_source(monkeypatch):
    monkeypatch.setattr(db, "get_camera_link_source", lambda: {"datasource_id": None})

    with pytest.raises(HTTPException) as exc:
        cameras.camera_link_options(_user=USER)

    assert exc.value.status_code == 409
    assert exc.value.detail == "Camera source is not configured"


@pytest.mark.parametrize("payload", [{}, {"datasource_id": None}, {"datasource_id": 0}])
def test_camera_source_update_requires_a_datasource(payload):
    with pytest.raises(ValidationError):
        cameras.CameraLinkSourceIn(**payload)


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
        return {
            "batch_id": 15,
            "updated_at": None,
            "defect_1": 1,
            "defect_2": 1,
            "defect_3": 1,
            "defect_4": 1,
            "defect_5": 1,
        }

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
