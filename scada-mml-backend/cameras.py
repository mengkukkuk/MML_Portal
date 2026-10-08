"""Configured-source camera registry, defect counters, and NG frame endpoints"""
import logging
import threading
import time
from collections.abc import Callable
from datetime import datetime
from typing import Any, TypeVar

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from psycopg_pool import PoolTimeout

import camera_files
import camera_thumbs
import db
from auth import get_current_user, require_admin
from licensing import require_valid_license

logger = logging.getLogger("mml-api.cameras")
_T = TypeVar("_T")

router = APIRouter(
    prefix="/api/cameras",
    tags=["cameras"],
    dependencies=[Depends(require_valid_license)],
)


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def _not_found(what: str = "Camera") -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


def _detail(e: Exception) -> str:
    text = str(e).strip()
    return text.splitlines()[0] if text else "Database error"


def _camera_source_or_409() -> dict[str, Any]:
    settings = db.get_camera_link_source()
    if not settings or settings.get("datasource_id") is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Camera source is not configured",
        )
    return settings


def _source_query(query: Callable[[], _T]) -> _T:
    """Run one camera-data read and keep datasource error semantics uniform."""
    try:
        return query()
    except (psycopg.OperationalError, PoolTimeout) as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_detail(e),
        ) from e
    except (ValueError, psycopg.Error) as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_detail(e),
        ) from e


# --- Camera source -------------------------------------------------------------
class CameraLinkSourceOut(BaseModel):
    datasource_id: int | None = None
    datasource_name: str | None = None


class CameraLinkSourceIn(BaseModel):
    datasource_id: int = Field(..., ge=1)


@router.get("/link-source", response_model=CameraLinkSourceOut)
def camera_link_source(_user: dict = Depends(get_current_user)):
    return db.get_camera_link_source() or CameraLinkSourceOut()


@router.put("/link-source", response_model=CameraLinkSourceOut)
def set_camera_link_source(body: CameraLinkSourceIn, _admin: dict = Depends(require_admin)):
    if db.get_datasource(body.datasource_id) is None:
        raise _not_found("Datasource")
    saved = db.set_camera_link_source(body.datasource_id)
    _forget_cameras()
    return saved


class CameraLinkOptionOut(BaseModel):
    code: str
    name: str
    station_code: str | None = None
    station_label: str | None = None
    location: str | None = None
    enabled: bool = True
    defect_labels: list[str | None] = []


class CameraLinkOptionsOut(BaseModel):
    source: str
    datasource_id: int
    datasource_name: str | None = None
    cameras: list[CameraLinkOptionOut]


@router.get("/link-options", response_model=CameraLinkOptionsOut)
def camera_link_options(_user: dict = Depends(get_current_user)):
    settings = _camera_source_or_409()
    ds_id = settings["datasource_id"]
    cameras = _source_query(lambda: db.list_remote_camera_options(ds_id))
    return {
        "source": "datasource", "datasource_id": ds_id,
        "datasource_name": settings.get("datasource_name"),
        "cameras": cameras,
    }


def _get_linked_camera_or_404(camera_code: str) -> tuple[int, dict[str, Any]]:
    """Resolve a stable camera code against the source selected in Settings."""
    settings = _camera_source_or_409()
    ds_id = settings["datasource_id"]
    camera = _source_query(
        lambda: db.get_remote_camera_option_by_code(ds_id, camera_code)
    )
    if camera is None:
        raise _not_found()
    return ds_id, camera

# Registry data (code, name, labels) barely changes, but every frame request
# used to re-resolve it: an app-DB read for the source setting plus a query to
# the remote camera datasource. One film strip is ~30 of those at once.
# Only the frame routes use this; /defects keeps the live lookup.
_CAMERA_TTL_S = 60.0
_camera_cache: dict[str, tuple[float, int, dict[str, Any]]] = {}
_camera_cache_lock = threading.Lock()


def _forget_cameras() -> None:
    with _camera_cache_lock:
        _camera_cache.clear()


def _get_linked_camera_cached(camera_code: str) -> tuple[int, dict[str, Any]]:
    """`_get_linked_camera_or_404` with a short TTL. A miss is never cached."""
    key = camera_code.lower()
    now = time.monotonic()
    with _camera_cache_lock:
        hit = _camera_cache.get(key)
        if hit is not None and now - hit[0] < _CAMERA_TTL_S:
            return hit[1], hit[2]
    ds_id, camera = _get_linked_camera_or_404(camera_code)
    with _camera_cache_lock:
        _camera_cache[key] = (time.monotonic(), ds_id, camera)
        while len(_camera_cache) > 256:
            _camera_cache.pop(next(iter(_camera_cache)))
    return ds_id, camera


# Folder-backed camera frames are always raster images.
ALLOWED_FRAME_MIMES = {"image/png", "image/jpeg", "image/webp"}

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

# A file on disk can be replaced in place by the vision system, so use a short
_FILE_IMAGE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=30, must-revalidate",
}

# An id-addressed frame is one immutable capture: the id embeds the file's mtime,
# so a file replaced in place gets a new id and a new URL. That is what makes a
# year-long cache lifetime correct here, where the positional routes above need
# the short one. `private` because the URL is only reachable with a token.
_FRAME_ID_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=31536000, immutable",
}

# --- defect counters -----------------------------------------------------------
class DefectSlotOut(BaseModel):
    slot: int
    label: str | None = None
    count: int = 0
    has_frames: bool = False

class DefectSummaryOut(BaseModel):
    batch_id: int | None = None
    updated_at: datetime | None = None
    total: int = 0
    slots: list[DefectSlotOut] = []

def _defect_summary(datasource_id: int, camera: dict[str, Any]) -> dict[str, Any]:
    row = _source_query(
        lambda: db.camera_defect_latest(datasource_id, camera["code"])
    )
    counts = (row.get("defect_array") if row else None) or []
    labels = camera.get("defect_labels") or []

    with_frames = camera_files.slots_with_frames(camera["code"])
    total = sum(int(c or 0) for c in counts)

    span = min(
        max(len(counts), len(labels), max(with_frames, default=0)),
        camera_files.MAX_SLOT,
    )
    slots: list[dict[str, Any]] = []
    for slot in range(camera_files.MIN_SLOT, span + 1):
        count = int(counts[slot - 1] or 0) if slot <= len(counts) else 0
        label = labels[slot - 1] if slot <= len(labels) else None
        has_frames = slot in with_frames
        if label or count or has_frames:
            slots.append(
                {"slot": slot, "label": label, "count": count, "has_frames": has_frames}
            )
    return {
        "batch_id": row["batch_id"] if row else None,
        "updated_at": row["updated_at"] if row else None,
        "total": total,
        "slots": slots,
    }

@router.get("/linked/{camera_code}/defects", response_model=DefectSummaryOut)
def linked_camera_defects(camera_code: str, _user: dict = Depends(get_current_user)):
    """Defect summary for the camera code selected from the configured source."""
    datasource_id, camera = _get_linked_camera_or_404(camera_code)
    return _defect_summary(datasource_id, camera)


# --- folder-backed frames -------------------------------------------------------
class FrameOut(BaseModel):
    # Durable name for this capture. `index` is only its position right now.
    id: str
    index: int
    captured_at: datetime
    size_bytes: int
    mtime_ns: int

def _checked_slot(slot: int) -> int:
    if not camera_files.MIN_SLOT <= slot <= camera_files.MAX_SLOT:
        raise _bad(
            f"slot must be between {camera_files.MIN_SLOT} and {camera_files.MAX_SLOT}"
        )
    return slot

@router.get("/linked/{camera_code}/defects/{slot}/frames", response_model=list[FrameOut])
def list_linked_camera_slot_frames(
    camera_code: str,
    slot: int,
    limit: int = 30,
    _user: dict = Depends(get_current_user),
):
    _datasource_id, camera = _get_linked_camera_cached(camera_code)
    _checked_slot(slot)
    limit = max(1, min(limit, 100))
    return camera_files.list_slot_frames(camera["code"], slot, limit=limit)

@router.get("/linked/{camera_code}/ok/frames", response_model=list[FrameOut])
def list_linked_camera_ok_frames(
    camera_code: str,
    limit: int = 30,
    _user: dict = Depends(get_current_user),
):
    """Passing frames for one camera. No slot: OK captures are uncategorized."""
    _datasource_id, camera = _get_linked_camera_cached(camera_code)
    limit = max(1, min(limit, 100))
    return camera_files.list_ok_frames(camera["code"], limit=limit)

def _serve_frame(read: Callable[[], tuple[bytes, camera_files.FrameMeta]]) -> Response:
    try:
        data, meta = read()
    except camera_files.FrameNotFound:
        raise _not_found("Frame") from None

    mime = _sniff_mime(data)
    if mime is None or mime not in ALLOWED_FRAME_MIMES:
        raise _bad("the stored file is not a PNG, JPEG or WebP image")

    headers = {
        **_FILE_IMAGE_HEADERS,
        "ETag": f'"{meta.mtime_ns:x}-{meta.size_bytes:x}"',
    }
    return Response(content=data, media_type=mime, headers=headers)

@router.get("/linked/{camera_code}/defects/{slot}/frames/{index}/image")
def get_linked_camera_slot_frame_image(
    camera_code: str,
    slot: int,
    index: int,
    _user: dict = Depends(get_current_user),
):
    _datasource_id, camera = _get_linked_camera_cached(camera_code)
    _checked_slot(slot)
    return _serve_frame(lambda: camera_files.read_frame(camera["code"], slot, index))

@router.get("/linked/{camera_code}/ok/frames/{index}/image")
def get_linked_camera_ok_frame_image(
    camera_code: str,
    index: int,
    _user: dict = Depends(get_current_user),
):
    _datasource_id, camera = _get_linked_camera_cached(camera_code)
    return _serve_frame(lambda: camera_files.read_ok_frame(camera["code"], index))


# --- id-addressed frames (what the UI uses) -------------------------------------
# `index` above shifts every time a capture lands, so a client that listed frames
# and then fetched "index 7" could be handed a different file than the one it
# listed. These routes name the capture itself.

def _checked_frame(read: Callable[[], tuple[bytes, camera_files.FrameMeta]]) -> tuple[bytes, str]:
    """Read one frame and return (bytes, sniffed mime), or the right HTTP error."""
    try:
        data, _meta = read()
    except camera_files.FrameNotFound:
        raise _not_found("Frame") from None
    mime = _sniff_mime(data)
    if mime is None or mime not in ALLOWED_FRAME_MIMES:
        raise _bad("the stored file is not a PNG, JPEG or WebP image")
    return data, mime


def _serve_frame_by_id(
    read: Callable[[], tuple[bytes, camera_files.FrameMeta]], fid: str
) -> Response:
    data, mime = _checked_frame(read)
    return Response(
        content=data, media_type=mime, headers={**_FRAME_ID_HEADERS, "ETag": f'"{fid}"'},
    )


def _serve_thumb(
    read: Callable[[], tuple[bytes, camera_files.FrameMeta]],
    key: tuple, fid: str, width: int,
) -> Response:
    """A small JPEG preview of one frame, generated once and then kept in memory.

    A cache hit does not touch the disk at all. If a preview cannot be made
    (Pillow missing, an undecodable file) the original is served instead, so the
    worst case is a slow tile rather than a failed one.
    """
    width = camera_thumbs.clamp_width(width)
    cache_key = (*key, fid, width)
    thumb = camera_thumbs.cached(cache_key)
    if thumb is None:
        data, mime = _checked_frame(read)
        thumb = camera_thumbs.make_thumbnail(data, width)
        if thumb is None:
            return Response(content=data, media_type=mime, headers=_FRAME_ID_HEADERS)
        camera_thumbs.remember(cache_key, thumb)
    return Response(
        content=thumb,
        media_type="image/jpeg",
        headers={**_FRAME_ID_HEADERS, "ETag": f'"{fid}-{width}"'},
    )


_THUMB_WIDTH = Query(camera_thumbs.DEFAULT_WIDTH, ge=1, le=4096, alias="w")


@router.get("/linked/{camera_code}/defects/{slot}/frames/id/{fid}/image")
def get_linked_camera_slot_frame_image_by_id(
    camera_code: str, slot: int, fid: str, _user: dict = Depends(get_current_user),
):
    _datasource_id, camera = _get_linked_camera_cached(camera_code)
    _checked_slot(slot)
    return _serve_frame_by_id(lambda: camera_files.read_frame_by_id(camera["code"], slot, fid), fid)


@router.get("/linked/{camera_code}/defects/{slot}/frames/id/{fid}/thumb")
def get_linked_camera_slot_frame_thumb(
    camera_code: str, slot: int, fid: str,
    width: int = _THUMB_WIDTH, _user: dict = Depends(get_current_user),
):
    _datasource_id, camera = _get_linked_camera_cached(camera_code)
    _checked_slot(slot)
    return _serve_thumb(
        lambda: camera_files.read_frame_by_id(camera["code"], slot, fid),
        (camera["code"].lower(), slot), fid, width,
    )


@router.get("/linked/{camera_code}/ok/frames/id/{fid}/image")
def get_linked_camera_ok_frame_image_by_id(
    camera_code: str, fid: str, _user: dict = Depends(get_current_user),
):
    _datasource_id, camera = _get_linked_camera_cached(camera_code)
    return _serve_frame_by_id(lambda: camera_files.read_ok_frame_by_id(camera["code"], fid), fid)


@router.get("/linked/{camera_code}/ok/frames/id/{fid}/thumb")
def get_linked_camera_ok_frame_thumb(
    camera_code: str, fid: str,
    width: int = _THUMB_WIDTH, _user: dict = Depends(get_current_user),
):
    _datasource_id, camera = _get_linked_camera_cached(camera_code)
    return _serve_thumb(
        lambda: camera_files.read_ok_frame_by_id(camera["code"], fid),
        (camera["code"].lower(), "ok"), fid, width,
    )
