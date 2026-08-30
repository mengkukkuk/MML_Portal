"""Configured-source camera registry, defect counters and NG frame endpoints.

Camera identity and defect batches are read exclusively from the datasource
selected in Settings. They never fall back to the app/config database and are
independent of the user's header datasource selection. Folder-backed NG images
remain read-only filesystem data keyed by the same stable camera code.
"""
from datetime import datetime
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from psycopg_pool import PoolTimeout

import camera_files
import db
from auth import get_current_user, require_admin
from licensing import require_valid_license

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


# --- Camera source -------------------------------------------------------------
# One saved datasource backs both the "Linked to" picker and rail defect data.
# NG image bytes remain filesystem-backed and use the same camera code.
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
    return db.set_camera_link_source(body.datasource_id)


class CameraLinkOptionOut(BaseModel):
    code: str
    name: str
    station_code: str | None = None
    station_label: str | None = None
    location: str | None = None
    enabled: bool = True
    defect_1_label: str | None = None
    defect_2_label: str | None = None
    defect_3_label: str | None = None
    defect_4_label: str | None = None
    defect_5_label: str | None = None


class CameraLinkOptionsOut(BaseModel):
    source: str
    datasource_id: int
    datasource_name: str | None = None
    cameras: list[CameraLinkOptionOut]


@router.get("/link-options", response_model=CameraLinkOptionsOut)
def camera_link_options(_user: dict = Depends(get_current_user)):
    """Candidate cameras for the Monitor link picker, position (location) and
    code being the two fields the picker filters on.

    A configured source is mandatory; an unconfigured install returns 409.
    """
    settings = _camera_source_or_409()
    ds_id = settings["datasource_id"]
    try:
        cameras = db.list_remote_camera_options(ds_id)
    except (psycopg.OperationalError, PoolTimeout) as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_detail(e),
        )
    except (ValueError, psycopg.Error) as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_detail(e))
    return {
        "source": "datasource", "datasource_id": ds_id,
        "datasource_name": settings.get("datasource_name"),
        "cameras": cameras,
    }


def _get_linked_camera_or_404(camera_code: str) -> tuple[int, dict[str, Any]]:
    """Resolve rail identity against the source selected in Settings.

    This is deliberately separate from ``_get_camera_or_404`` below. That
    helper backs CRUD/snapshot routes whose integer ids belong to the local app
    database; a Monitor link is a code and may belong to another database.
    """
    settings = _camera_source_or_409()
    ds_id = settings["datasource_id"]
    try:
        camera = db.get_remote_camera_option_by_code(ds_id, camera_code)
    except (psycopg.OperationalError, PoolTimeout) as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_detail(e),
        )
    except (ValueError, psycopg.Error) as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_detail(e))
    if camera is None:
        raise _not_found()
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
# revalidating cache window plus an ETag rather than immutable caching.
_FILE_IMAGE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=30, must-revalidate",
}


# --- defect counters -----------------------------------------------------------
# The five positional slots of `camera_defect`, named per camera by the
# matching `defect_N_label` on `cameras`. Slot N means the same defect on both
# tables and in the image folder's `defect_N` directory.
DEFECT_SLOTS = (1, 2, 3, 4, 5)


class DefectSlotOut(BaseModel):
    slot: int
    label: str | None = None
    count: int = 0
    has_frames: bool = False


class DefectSummaryOut(BaseModel):
    batch_id: int | None = None
    # Naive, unlike every other timestamp this API returns: camera_defect.updated_at
    # is `timestamp`, not `timestamp`. It is plant-local wall-clock time and is
    # serialized without an offset — do not read it as UTC.
    updated_at: datetime | None = None
    total: int = 0
    slots: list[DefectSlotOut] = []


def _defect_summary(datasource_id: int, camera: dict[str, Any]) -> dict[str, Any]:
    """Build the rail summary from a source-resolved camera identity."""
    try:
        row = db.camera_defect_latest(datasource_id, camera["code"])
    except (psycopg.OperationalError, PoolTimeout) as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_detail(e),
        )
    except (ValueError, psycopg.Error) as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_detail(e))
    # One walk of the folder for all five slots — this route is polled on the
    # page's live cadence, so it must not re-resolve the path per slot.
    with_frames = camera_files.slots_with_frames(camera["code"])

    slots: list[dict[str, Any]] = []
    total = 0
    for slot in DEFECT_SLOTS:
        count = (row[f"defect_{slot}"] or 0) if row else 0
        label = camera.get(f"defect_{slot}_label")
        has_frames = slot in with_frames
        total += count
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
# The categorized images the vision system writes to disk. Read-only: there is
# no write route here, and the app never creates anything under the image root.
class FrameOut(BaseModel):
    index: int
    captured_at: datetime
    size_bytes: int
    # Carried to the client so a replaced file gets a new cache key. The
    # browser-side blob cache keys on it; without that a frame swapped on disk
    # would stay on screen for the life of the page whatever the HTTP headers
    # say.
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
    """Folder-backed frames for a camera resolved from the configured source."""
    _datasource_id, camera = _get_linked_camera_or_404(camera_code)
    _checked_slot(slot)
    limit = max(1, min(limit, 100))
    return camera_files.list_slot_frames(camera["code"], slot, limit=limit)


def _frame_image(camera: dict[str, Any], slot: int, index: int) -> Response:
    _checked_slot(slot)
    try:
        data, meta = camera_files.read_frame(camera["code"], slot, index)
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
    """One frame for a camera resolved from the configured source."""
    _datasource_id, camera = _get_linked_camera_or_404(camera_code)
    return _frame_image(camera, slot, index)
