"""HTTP-layer behavior for configured-source camera frame routes."""

import struct

import pytest
from fastapi import HTTPException

import cameras
import db
from camera_files import FrameMeta


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 24
WEBP = b"RIFF" + struct.pack("<I", 32) + b"WEBP" + b"\x00" * 20
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
USER = {"id": 2, "username": "operator", "role": "operator"}
CAMERA = {"code": "cam-001", "name": "Camera 1", "enabled": True}


@pytest.fixture(autouse=True)
def configured_camera(monkeypatch):
    monkeypatch.setattr(
        db,
        "get_camera_link_source",
        lambda: {"datasource_id": 86, "datasource_name": "vision"},
    )
    monkeypatch.setattr(
        db,
        "get_remote_camera_option_by_code",
        lambda _datasource_id, _code: CAMERA,
    )


@pytest.mark.parametrize(
    "data,expected",
    [(PNG, "image/png"), (JPEG, "image/jpeg"), (WEBP, "image/webp")],
)
def test_frame_sniff_recognises_allowed_formats(data, expected):
    assert cameras._sniff_mime(data) == expected


def test_frame_sniff_rejects_svg():
    assert cameras._sniff_mime(SVG) is None
    assert "image/svg+xml" not in cameras.ALLOWED_FRAME_MIMES


@pytest.mark.parametrize("slot", [0, 6, -1])
def test_frame_listing_refuses_an_out_of_range_slot(slot):
    with pytest.raises(HTTPException) as exc:
        cameras.list_linked_camera_slot_frames("cam-001", slot, _user=USER)
    assert exc.value.status_code == 400


def test_frame_listing_is_empty_when_no_image_root_is_configured(monkeypatch):
    monkeypatch.setattr(cameras.camera_files.config, "CAMERA_IMAGE_ROOT", "")
    assert cameras.list_linked_camera_slot_frames("cam-001", 1, _user=USER) == []


def test_frame_image_keeps_security_and_revalidation_headers(monkeypatch):
    meta = FrameMeta(index=0, captured_at=None, size_bytes=len(PNG), mtime_ns=123)
    monkeypatch.setattr(cameras.camera_files, "read_frame", lambda *_args: (PNG, meta))

    response = cameras.get_linked_camera_slot_frame_image("cam-001", 1, 0, _user=USER)

    assert response.media_type == "image/png"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "private, max-age=30, must-revalidate"
