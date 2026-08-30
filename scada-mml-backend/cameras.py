"""Camera config, defect counters and frame endpoints behind the /monitor rail.

``cameras`` is app config, not plant data: a station's camera is named once by
an admin, and a mimic node reaches it by its ``code``. Reads are open to any
authenticated user; writes require an admin token.

There are two separate image paths here, and the distinction is the reason this
module is longer than it looks:

* **Snapshots** (``camera_snapshots``) are uploaded *through* this API and kept
  as bytes in Postgres, for the reasons ``mimic.py`` gives for asset images —
  the file never becomes a URL the app cannot revoke. This is the only
  ingestion path in the system. The rail no longer renders them, but nothing
  else can accept a frame, so the route stays.
* **Frames** are read off disk from the folder the vision system writes into,
  via ``camera_files``. The app never writes there and treats everything it
  finds as untrusted: the size is capped, the format is sniffed from the
  content, and the path is proven to stay inside the configured root.

Defect counts come from ``camera_defect`` keyed by camera code — app data, not
a fanned-out plant read, which is why nothing in this file touches
``active_datasources``.
"""
import hashlib
from datetime import datetime
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

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


# --- Link picker source --------------------------------------------------------
# Which table backs the "Linked to" dropdown in the Monitor symbol inspector.
# Declared before the /{camera_id} routes below: FastAPI/Starlette matches by
# declaration order, and PUT /api/cameras/link-source would otherwise be
# captured by PUT /api/cameras/{camera_id} and 422 on the int conversion —
# same reasoning as datasources.py's /selection routes.
#
# Separate from the CRUD below: an admin can point the *picker* at a plant
# datasource's own camera registry (e.g. a vision system) without touching how
# defect counts or NG frames are stored — those keep reading this app's own
# `camera_defect` / `camera_snapshots`, keyed by the linked camera's code.
class CameraLinkSourceOut(BaseModel):
    datasource_id: int | None = None
    datasource_name: str | None = None


class CameraLinkSourceIn(BaseModel):
    datasource_id: int | None = None


@router.get("/link-source", response_model=CameraLinkSourceOut)
def camera_link_source(_user: dict = Depends(get_current_user)):
    return db.get_camera_link_source() or CameraLinkSourceOut()


@router.put("/link-source", response_model=CameraLinkSourceOut)
def set_camera_link_source(body: CameraLinkSourceIn, _admin: dict = Depends(require_admin)):
    if body.datasource_id is not None and db.get_datasource(body.datasource_id) is None:
        raise _not_found("Datasource")
    return db.set_camera_link_source(body.datasource_id)


class CameraLinkOptionOut(BaseModel):
    code: str
    name: str
    station_code: str | None = None
    station_label: str | None = None
    location: str | None = None
    enabled: bool = True


class CameraLinkOptionsOut(BaseModel):
    # "local" — no datasource designated, reading this app's own `cameras`.
    # "datasource" — reading the designated plant datasource's `cameras` table.
    source: str
    datasource_id: int | None = None
    datasource_name: str | None = None
    cameras: list[CameraLinkOptionOut]


@router.get("/link-options", response_model=CameraLinkOptionsOut)
def camera_link_options(_user: dict = Depends(get_current_user)):
    """Candidate cameras for the Monitor link picker, position (location) and
    code being the two fields the picker filters on.

    Falls back to this app's own `cameras` table when no datasource has been
    designated in Settings, so a fresh install still has a working picker.
    """
    settings = db.get_camera_link_source()
    ds_id = settings["datasource_id"] if settings else None
    if ds_id is None:
        return {
            "source": "local", "datasource_id": None, "datasource_name": None,
            "cameras": db.list_cameras(),
        }
    try:
        cameras = db.list_remote_camera_options(ds_id)
    except (ValueError, psycopg.Error) as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_detail(e))
    return {
        "source": "datasource", "datasource_id": ds_id,
        "datasource_name": settings.get("datasource_name"),
        "cameras": cameras,
    }


# --- camera config -----------------------------------------------------------
class CameraOut(BaseModel):
    id: int
    code: str
    name: str
    station_code: str | None = None
    station_label: str | None = None
    location: str | None = None
    enabled: bool = True
    updated_at: datetime
    defect_1_label: str | None = None
    defect_2_label: str | None = None
    defect_3_label: str | None = None
    defect_4_label: str | None = None
    defect_5_label: str | None = None


class CameraIn(BaseModel):
    # `code` reaches the filesystem: camera_files.py builds the image folder
    # path from it. Restricted here to characters that cannot mean anything to
    # a path resolve, and validated again at the filesystem boundary — one
    # layer is config, the other is the actual defense.
    code: str = Field(
        ..., min_length=1, max_length=40, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$"
    )
    name: str = Field(..., min_length=1, max_length=120)
    station_code: str | None = None
    station_label: str | None = None
    location: str | None = None
    enabled: bool = True
    # PUT replaces the whole row (there is no PATCH), so a caller that omits
    # these clears them. No such caller exists yet — nothing in the frontend
    # calls createCamera/updateCamera, SQL seeds the rows — but whoever
    # builds a camera admin form must give the labels inputs.
    defect_1_label: str | None = None
    defect_2_label: str | None = None
    defect_3_label: str | None = None
    defect_4_label: str | None = None
    defect_5_label: str | None = None


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

# Same hardening, different cache policy. A file on disk *can* be replaced in
# place by the vision system, so the immutability argument above does not carry
# over — a long max-age would pin a superseded frame in every operator's
# browser. A short revalidating window plus the ETag below is the honest
# version of the same optimization.
_FILE_IMAGE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=30, must-revalidate",
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


@router.get("/{camera_id}/defects", response_model=DefectSummaryOut)
def camera_defects(camera_id: int, _user: dict = Depends(get_current_user)):
    """The newest batch of defect counts for one camera, slot by slot.

    A null `batch_id` means no defect row has ever been written for this camera
    — which the rail shows differently from a batch that counted zero, because
    "nothing reported yet" and "nothing wrong" are different answers.

    A slot is returned when it is named, when it counted something, or when it
    has frames on disk. The rest are omitted: the table has five slots, but a
    given line rarely uses all five, and an empty unnamed bar says nothing.
    """
    camera = _get_camera_or_404(camera_id)
    row = db.camera_defect_latest(camera["code"])
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


@router.get("/{camera_id}/defects/{slot}/frames", response_model=list[FrameOut])
def list_slot_frames(
    camera_id: int,
    slot: int,
    limit: int = 30,
    _user: dict = Depends(get_current_user),
):
    """Frames stored on disk for one defect slot, newest first.

    Empty — never an error — when the image root is unconfigured, unreachable,
    or simply has no folder for this camera. An install with no image share is
    a normal install.
    """
    camera = _get_camera_or_404(camera_id)
    _checked_slot(slot)
    limit = max(1, min(limit, 100))
    return camera_files.list_slot_frames(camera["code"], slot, limit=limit)


@router.get("/{camera_id}/defects/{slot}/frames/{index}/image")
def get_slot_frame_image(
    camera_id: int, slot: int, index: int, _user: dict = Depends(get_current_user)
):
    """One frame's bytes, addressed by position in the newest-first listing.

    The format is sniffed from the content rather than trusted from the
    extension — this file was written by another system into a folder we do not
    control, so its name proves nothing about what is inside it.
    """
    camera = _get_camera_or_404(camera_id)
    _checked_slot(slot)
    try:
        data, meta = camera_files.read_frame(camera["code"], slot, index)
    except camera_files.FrameNotFound:
        raise _not_found("Frame") from None

    mime = _sniff_mime(data)
    if mime is None or mime not in ALLOWED_SNAPSHOT_MIMES:
        raise _bad("the stored file is not a PNG, JPEG or WebP image")

    headers = {
        **_FILE_IMAGE_HEADERS,
        "ETag": f'"{meta.mtime_ns:x}-{meta.size_bytes:x}"',
    }
    return Response(content=data, media_type=mime, headers=headers)


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
