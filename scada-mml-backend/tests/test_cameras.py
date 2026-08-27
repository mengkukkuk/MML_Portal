"""Tests for /api/cameras.

Same split as test_mimic_symbols.py: format sniffing is pure and tested
against real magic bytes; everything else touches Postgres directly, because
what's being checked (uniqueness, cascade, dedup) is about database state, not
routing.
"""
import struct

import pytest
from fastapi import HTTPException

import cameras
import db

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 24
WEBP = b"RIFF" + struct.pack("<I", 32) + b"WEBP" + b"\x00" * 20
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>'

ADMIN = {"id": 1, "username": "admin", "role": "admin"}
USER = {"id": 2, "username": "operator", "role": "operator"}


@pytest.fixture(scope="module", autouse=True)
def _tables():
    """The endpoints assume main.py's startup hook has run."""
    db.init_cameras_table()
    db.init_camera_snapshots_table()


@pytest.fixture
def camera():
    """One stored camera, removed afterwards (cascades to its snapshots)."""
    row = db.insert_camera({
        "code": f"CAM-TEST-{id(object())}",
        "name": "Fixture camera",
        "station_code": "ST-01",
        "station_label": "Test station",
    })
    yield row
    db.delete_camera(row["id"])


# --- format sniffing ---------------------------------------------------------

@pytest.mark.parametrize(
    "data,expected",
    [
        (PNG, "image/png"),
        (JPEG, "image/jpeg"),
        (WEBP, "image/webp"),
    ],
)
def test_sniff_recognises_allowed_formats(data, expected):
    assert cameras._sniff_mime(data) == expected


def test_sniff_rejects_svg():
    """Unlike mimic assets, a camera frame is never SVG — the allowlist here
    is deliberately narrower and must not accept it."""
    assert cameras._sniff_mime(SVG) is None
    assert "image/svg+xml" not in cameras.ALLOWED_SNAPSHOT_MIMES


def test_image_headers_have_no_inline_style_exception():
    """Camera frames are always a raster format, so unlike mimic's asset
    headers there is no need for the SVG inline-style CSP carve-out."""
    csp = cameras._IMAGE_HEADERS["Content-Security-Policy"]
    assert "sandbox" in csp
    assert "default-src 'none'" in csp
    assert cameras._IMAGE_HEADERS["X-Content-Type-Options"] == "nosniff"


# --- camera CRUD ---------------------------------------------------------------

def test_camera_code_is_case_insensitive(camera):
    found = db.get_camera_by_code(camera["code"].lower())
    assert found is not None
    assert found["id"] == camera["id"]


def test_creating_a_duplicate_code_is_refused(camera):
    with pytest.raises(HTTPException) as e:
        cameras.create_camera(
            cameras.CameraIn(code=camera["code"], name="Duplicate"), _admin=ADMIN
        )
    assert "already exists" in e.value.detail


def test_update_missing_camera_is_404():
    with pytest.raises(HTTPException) as e:
        cameras.update_camera(
            -999, cameras.CameraIn(code="CAM-NOPE", name="Nope"), _admin=ADMIN
        )
    assert e.value.status_code == 404


def test_delete_missing_camera_is_404():
    with pytest.raises(HTTPException) as e:
        cameras.delete_camera(-999, _admin=ADMIN)
    assert e.value.status_code == 404


def test_list_snapshots_404s_for_a_missing_camera():
    with pytest.raises(HTTPException) as e:
        cameras.list_snapshots(-999, _user=USER)
    assert e.value.status_code == 404


# --- snapshot storage + cause histogram ----------------------------------------

def test_identical_snapshot_upload_is_deduplicated(camera):
    row = db.insert_camera_snapshot(
        camera["id"], "image/png", PNG, "hash-a", "misaligned label", "ng", 1
    )
    found = db.find_camera_snapshot_by_hash(camera["id"], "hash-a")
    assert found is not None
    assert found["id"] == row["id"]


def test_snapshot_hash_uniqueness_is_scoped_per_camera(camera):
    """The same bytes on two different cameras are two different frames, not
    a collision — the UNIQUE constraint is (camera_id, sha256), not sha256 alone."""
    other = db.insert_camera({"code": f"CAM-TEST-B-{id(object())}", "name": "Other"})
    try:
        a = db.insert_camera_snapshot(camera["id"], "image/png", PNG, "hash-b", None, "ng", 1)
        b = db.insert_camera_snapshot(other["id"], "image/png", PNG, "hash-b", None, "ng", 1)
        assert a["id"] != b["id"]
    finally:
        db.delete_camera(other["id"])


def test_cause_counts_group_ng_frames_only(camera):
    db.insert_camera_snapshot(camera["id"], "image/png", PNG, "h1", "misaligned label", "ng", 1)
    db.insert_camera_snapshot(camera["id"], "image/png", PNG, "h2", "misaligned label", "ng", 1)
    db.insert_camera_snapshot(camera["id"], "image/png", PNG, "h3", "no label", "ng", 1)
    db.insert_camera_snapshot(camera["id"], "image/png", PNG, "h4", None, "ok", 1)

    counts = cameras.cause_counts(camera["id"], _user=USER)
    by_cause = {c["cause"]: c["n"] for c in counts}
    assert by_cause == {"misaligned label": 2, "no label": 1}


def test_deleting_a_camera_cascades_its_snapshots():
    row = db.insert_camera({"code": f"CAM-TEST-C-{id(object())}", "name": "Cascade fixture"})
    db.insert_camera_snapshot(row["id"], "image/png", PNG, "hash-c", None, "ng", 1)
    assert db.delete_camera(row["id"]) is True
    assert db.get_camera_snapshot_bytes(row["id"], 1) is None


def test_get_snapshot_image_404s_for_a_missing_frame(camera):
    with pytest.raises(HTTPException) as e:
        cameras.get_snapshot_image(camera["id"], -999, _user=USER)
    assert e.value.status_code == 404


# --- plant summary (Phase 3: graceful degrade, no plant table required) -------

def test_summary_is_null_not_zero_when_the_camera_has_no_binding(camera):
    """Null distinguishes "never configured" from "the plant answered zero" —
    the rail must not draw a 0% NG rate for a camera nobody has wired up yet."""
    body = cameras.camera_summary(camera["id"], _user=USER, datasource_ids=[None])
    assert body == {"total": None, "ng": None, "sources": []}


def test_summary_survives_one_dead_plant_and_reports_the_healthy_one(monkeypatch, camera):
    db.update_camera(camera["id"], {
        "code": camera["code"], "name": camera["name"],
        "binding": {"table": "inspections", "filter_col": "verdict",
                    "filter_val": "ng", "ts_col": "ts"},
    })

    def flaky(datasource_id, table, filter_col, filter_val, ts_col, hours=24):
        if datasource_id == 2:
            raise ValueError("Table not allowed: 'inspections'")
        return {"total": 100, "ng": 7}

    monkeypatch.setattr(db, "camera_plant_summary", flaky)
    body = cameras.camera_summary(camera["id"], _user=USER, datasource_ids=[1, 2])
    assert body["total"] == 100
    assert body["ng"] == 7
    assert [s["ok"] for s in body["sources"]] == [True, False]
    assert "not allowed" in body["sources"][1]["error"]
