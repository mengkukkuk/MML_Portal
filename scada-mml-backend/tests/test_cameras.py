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


# --- defect counters ------------------------------------------------------------

def _defect_row(code, batch_id, counts, updated_at="now()"):
    """Insert one camera_defect row. Raw SQL because nothing writes these in
    production either — the inspection system does, outside this app."""
    cols = ", ".join(f"defect_{i}" for i in range(1, 6))
    with db.get_connection() as conn:
        conn.execute(
            f"INSERT INTO camera_defect (camera_id, batch_id, updated_at, {cols}) "
            f"VALUES (%s, %s, {updated_at}, %s, %s, %s, %s, %s)",
            (code, batch_id, *counts),
        )
        conn.commit()


@pytest.fixture
def clean_defects(camera):
    """camera_defect has no FK, so deleting the camera does not cascade to it."""
    yield camera
    with db.get_connection() as conn:
        conn.execute("DELETE FROM camera_defect WHERE camera_id = %s", (camera["code"],))
        conn.commit()


def test_defect_latest_returns_none_when_nothing_was_ever_recorded(camera):
    """None is not "a batch of zeros" — the rail shows the two differently,
    because "nothing reported yet" and "nothing wrong" are different answers."""
    assert db.camera_defect_latest(camera["code"]) is None
    body = cameras.camera_defects(camera["id"], _user=USER)
    assert body["batch_id"] is None
    assert body["total"] == 0


def test_defect_latest_picks_the_highest_batch(clean_defects):
    code = clean_defects["code"]
    _defect_row(code, 7, (1, 0, 0, 0, 0))
    _defect_row(code, 9, (4, 2, 0, 0, 0))
    _defect_row(code, 8, (9, 9, 9, 9, 9))

    row = db.camera_defect_latest(code)
    assert row["batch_id"] == 9
    assert row["defect_1"] == 4


def test_defect_latest_still_answers_when_every_batch_id_is_null(clean_defects):
    """`WHERE batch_id = (SELECT max(batch_id) ...)` returns nothing here,
    because max() over all-NULL is NULL and `= NULL` matches no row. A camera
    whose feed never sets a batch would silently show an empty panel."""
    code = clean_defects["code"]
    _defect_row(code, None, (3, 0, 0, 0, 0))

    row = db.camera_defect_latest(code)
    assert row is not None
    assert row["batch_id"] is None
    assert row["defect_1"] == 3


def test_defect_latest_matches_the_code_case_insensitively(clean_defects):
    _defect_row(clean_defects["code"].lower(), 1, (5, 0, 0, 0, 0))
    assert db.camera_defect_latest(clean_defects["code"].upper()) is not None


def test_defects_endpoint_labels_slots_and_totals_the_batch(clean_defects):
    camera_id, code = clean_defects["id"], clean_defects["code"]
    db.update_camera(camera_id, {
        "code": code, "name": clean_defects["name"],
        "defect_1_label": "ระดับต่ำกว่าพิกัด",
        "defect_2_label": "ระดับสูงกว่าพิกัด",
    })
    _defect_row(code, 12, (15, 6, 0, 0, 0))

    body = cameras.camera_defects(camera_id, _user=USER)
    assert body["batch_id"] == 12
    assert body["total"] == 21
    by_slot = {s["slot"]: s for s in body["slots"]}
    assert by_slot[1]["label"] == "ระดับต่ำกว่าพิกัด"
    assert by_slot[1]["count"] == 15
    assert by_slot[2]["count"] == 6


def test_defects_endpoint_omits_slots_that_are_unnamed_empty_and_frameless(clean_defects):
    """Five columns exist but a line rarely uses five. An unnamed zero bar with
    no frames behind it tells an operator nothing, so it is not returned."""
    camera_id, code = clean_defects["id"], clean_defects["code"]
    _defect_row(code, 1, (4, 0, 0, 0, 0))

    body = cameras.camera_defects(camera_id, _user=USER)
    assert [s["slot"] for s in body["slots"]] == [1]


def test_defects_endpoint_keeps_a_named_slot_that_counted_zero(clean_defects):
    """A named slot is a defect this camera is known to look for. Reporting zero
    of it is a real answer, unlike an anonymous empty slot."""
    camera_id, code = clean_defects["id"], clean_defects["code"]
    db.update_camera(camera_id, {
        "code": code, "name": clean_defects["name"], "defect_3_label": "ฟองอากาศ",
    })
    _defect_row(code, 1, (2, 0, 0, 0, 0))

    body = cameras.camera_defects(camera_id, _user=USER)
    by_slot = {s["slot"]: s for s in body["slots"]}
    assert by_slot[3]["count"] == 0
    assert by_slot[3]["label"] == "ฟองอากาศ"


def test_defect_routes_404_for_a_missing_camera():
    for call in (
        lambda: cameras.camera_defects(-999, _user=USER),
        lambda: cameras.list_slot_frames(-999, 1, _user=USER),
        lambda: cameras.get_slot_frame_image(-999, 1, 0, _user=USER),
    ):
        with pytest.raises(HTTPException) as e:
            call()
        assert e.value.status_code == 404


@pytest.mark.parametrize("slot", [0, 6, -1])
def test_frame_routes_refuse_an_out_of_range_slot(camera, slot):
    with pytest.raises(HTTPException) as e:
        cameras.list_slot_frames(camera["id"], slot, _user=USER)
    assert e.value.status_code == 400


def test_frames_are_empty_when_no_image_root_is_configured(monkeypatch, camera):
    """The panel must survive an install with no image share — an empty contact
    sheet, not a 500 that takes the whole rail with it."""
    monkeypatch.setattr(cameras.camera_files.config, "CAMERA_IMAGE_ROOT", "")
    assert cameras.list_slot_frames(camera["id"], 1, _user=USER) == []
    with pytest.raises(HTTPException) as e:
        cameras.get_slot_frame_image(camera["id"], 1, 0, _user=USER)
    assert e.value.status_code == 404
