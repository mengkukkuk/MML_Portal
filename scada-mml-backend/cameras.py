"""Camera config and NG-snapshot endpoints behind the /monitor camera rail.

``cameras`` is app config, not plant data: a station's camera is named once by
an admin, and a mimic node reaches it by loop id (its ``code``), the same way
any other symbol reaches its tag. Reads are open to any authenticated user;
writes — including snapshot uploads — require an admin token.

Snapshot bytes are stored in Postgres and served back through this API rather
than a static path, for the same reasons ``mimic.py`` gives for asset images:
the file never becomes a URL the app cannot revoke, and the hardening headers
below travel with every response.
"""
import hashlib
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

import db
from auth import active_datasources, get_current_user, require_admin
from licensing import require_valid_license
from sources import SourceReport

router = APIRouter(
    prefix="/api/cameras",
    tags=["cameras"],
    dependencies=[Depends(require_valid_license)],
)


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def _not_found(what: str = "Camera") -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


# --- camera config -----------------------------------------------------------
class CameraOut(BaseModel):
    id: int
    code: str
    name: str
    station_code: str | None = None
    station_label: str | None = None
    location: str | None = None
    stream_url: str | None = None
    notes: str | None = None
    binding: dict | None = None
    enabled: bool = True
    updated_at: datetime


class CameraIn(BaseModel):
    code: str = Field(..., min_length=1, max_length=40)
    name: str = Field(..., min_length=1, max_length=120)
    station_code: str | None = None
    station_label: str | None = None
    location: str | None = None
    stream_url: str | None = None
    notes: str | None = None
    binding: dict | None = None
    enabled: bool = True


@router.get("", response_model=list[CameraOut])
def list_cameras(_user: dict = Depends(get_current_user)):
    return db.list_cameras()


@router.post("", response_model=CameraOut, status_code=status.HTTP_201_CREATED)
def create_camera(body: CameraIn, _admin: dict = Depends(require_admin)):
    existing = db.get_camera_by_code(body.code)
    if existing is not None:
        raise _bad(f"a camera with code {body.code!r} already exists")
    return db.insert_camera(body.model_dump())


@router.put("/{camera_id}", response_model=CameraOut)
def update_camera(camera_id: int, body: CameraIn, _admin: dict = Depends(require_admin)):
    existing = db.get_camera_by_code(body.code)
    if existing is not None and existing["id"] != camera_id:
        raise _bad(f"a camera with code {body.code!r} already exists")
    row = db.update_camera(camera_id, body.model_dump())
    if row is None:
        raise _not_found()
    return row


@router.delete("/{camera_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_camera(camera_id: int, _admin: dict = Depends(require_admin)):
    if not db.delete_camera(camera_id):
        raise _not_found()


# --- NG snapshots -------------------------------------------------------------
# A photo budget, not the mimic asset budget: a camera frame is a real JPEG/PNG
# capture, not a small authored icon.
MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

# Deliberately narrower than mimic.py's ALLOWED_ASSET_MIMES — a camera frame is
# never SVG, so that allowlist (and its markup risk) does not apply here.
ALLOWED_SNAPSHOT_MIMES = {"image/png", "image/jpeg", "image/webp"}

_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
)


def _sniff_mime(data: bytes) -> str | None:
    for prefix, mime in _MAGIC:
        if data.startswith(prefix):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


_IMAGE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    # A snapshot row is never rewritten in place — a re-upload of the same
    # bytes returns the existing row instead of a new one — so this is safe
    # to cache hard, same reasoning as mimic.py's asset headers.
    "Cache-Control": "public, max-age=31536000, immutable",
}


class SnapshotOut(BaseModel):
    id: int
    camera_id: int
    captured_at: datetime
    cause: str | None = None
    verdict: str = "ng"
    mime: str
    size_bytes: int


def _get_camera_or_404(camera_id: int) -> dict[str, Any]:
    camera = db.get_camera(camera_id)
    if camera is None:
        raise _not_found()
    return camera


@router.get("/{camera_id}/snapshots", response_model=list[SnapshotOut])
def list_snapshots(
    camera_id: int,
    limit: int = 30,
    cause: str | None = None,
    _user: dict = Depends(get_current_user),
):
    _get_camera_or_404(camera_id)
    limit = max(1, min(limit, 100))
    return db.list_camera_snapshots(camera_id, limit=limit, cause=cause)


class CauseCountOut(BaseModel):
    cause: str
    n: int


@router.get("/{camera_id}/causes", response_model=list[CauseCountOut])
def cause_counts(camera_id: int, _user: dict = Depends(get_current_user)):
    _get_camera_or_404(camera_id)
    return db.camera_cause_counts(camera_id)


class SummaryOut(BaseModel):
    total: int | None = None
    ng: int | None = None
    sources: list[SourceReport] = []


@router.get("/{camera_id}/summary", response_model=SummaryOut)
def camera_summary(
    camera_id: int,
    _user: dict = Depends(get_current_user),
    datasource_ids: list[int | None] = Depends(active_datasources),
):
    """Total inspected + NG count from the plant, over the header's selected
    sources. `total`/`ng` are null (not zero) when the camera has no plant
    binding configured yet — a different state from "the plant answered with
    zero", which the rail must not conflate.
    """
    camera = _get_camera_or_404(camera_id)
    binding = camera.get("binding")
    if not binding:
        return {"total": None, "ng": None, "sources": []}

    reports = db.fan_out(
        datasource_ids,
        lambda ds: db.camera_plant_summary(
            ds, binding["table"], binding["filter_col"], binding["filter_val"],
            binding["ts_col"],
        ),
        label="camera summary",
    )
    total = sum(r["result"]["total"] for r in reports if r["ok"] and r["result"])
    ng = sum(r["result"]["ng"] for r in reports if r["ok"] and r["result"])
    sources = [
        {k: r[k] for k in ("datasource_id", "datasource_name", "ok", "error")}
        for r in reports
    ]
    return {"total": total, "ng": ng, "sources": sources}


@router.post(
    "/{camera_id}/snapshots", response_model=SnapshotOut, status_code=status.HTTP_201_CREATED
)
async def upload_snapshot(
    camera_id: int,
    file: UploadFile = File(...),
    cause: str | None = None,
    verdict: str = "ng",
    admin: dict = Depends(require_admin),
):
    """Store one NG (or OK) frame for a camera.

    Machine/inspection-station ingestion is a separate design with its own
    auth story — this endpoint is admin-only like every other write here, not
    opened to an operator role, since an image upload is real attack surface
    with no demonstrated non-admin caller yet.
    """
    _get_camera_or_404(camera_id)

    data = await file.read()
    if not data:
        raise _bad("the uploaded file is empty")
    if len(data) > MAX_SNAPSHOT_BYTES:
        raise _bad(
            f"image is {len(data) // 1024} KB; the limit is {MAX_SNAPSHOT_BYTES // 1024} KB"
        )

    sniffed = _sniff_mime(data)
    if sniffed is None or sniffed not in ALLOWED_SNAPSHOT_MIMES:
        raise _bad(
            "unsupported image format — use PNG, JPEG or WebP "
            f"(this file's contents read as {sniffed or 'something else'})"
        )
    declared = (file.content_type or "").split(";")[0].strip().lower()
    if declared and declared in ALLOWED_SNAPSHOT_MIMES and declared != sniffed:
        raise _bad(f"file claims to be {declared} but its contents are {sniffed}")

    digest = hashlib.sha256(data).hexdigest()
    existing = db.find_camera_snapshot_by_hash(camera_id, digest)
    if existing is not None:
        return existing

    return db.insert_camera_snapshot(
        camera_id, sniffed, data, digest, cause, verdict, admin.get("id")
    )


@router.get("/{camera_id}/snapshots/{snapshot_id}/image")
def get_snapshot_image(
    camera_id: int, snapshot_id: int, _user: dict = Depends(get_current_user)
):
    row = db.get_camera_snapshot_bytes(camera_id, snapshot_id)
    if row is None:
        raise _not_found("Snapshot")
    return Response(content=bytes(row["bytes"]), media_type=row["mime"], headers=_IMAGE_HEADERS)


@router.delete("/{camera_id}/snapshots/{snapshot_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_snapshot(
    camera_id: int, snapshot_id: int, _admin: dict = Depends(require_admin)
):
    if not db.delete_camera_snapshot(camera_id, snapshot_id):
        raise _not_found("Snapshot")
