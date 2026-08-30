"""Inspection frames read off disk for the /monitor camera rail.

This module is now only the *image* half of the camera feature. Camera identity
and defect counters are plant data reached through a mimic's ``doc.cameraDefect``
binding, and live in ``mimic.py`` alongside the layout that names them. What is
left here needs no binding at all:

**Frames** are read off disk from the folder the vision system writes into, via
``camera_files``. The app never writes there and treats everything it finds as
untrusted: the size is capped, the format is sniffed from the content, and the
path is proven to stay inside the configured root.

Routes are keyed by camera **code**, not by a row id. A code is what the vision
system writes into its folder names and what is printed on the physical station;
a row id is a per-database serial that collides across plants the moment these
tables live in more than one — the same hazard the rest of the app avoids by
stamping ``datasource_id`` onto every fanned-out row.

Reads are open to any authenticated user. There are no writes: this application
does not create anything under the image root.
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from fastapi.responses import Response
from pydantic import BaseModel

import camera_files
from auth import get_current_user
from licensing import require_valid_license

router = APIRouter(
    prefix="/api/cameras",
    tags=["cameras"],
    dependencies=[Depends(require_valid_license)],
)


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


# A camera code reaches the filesystem: camera_files.py builds the image folder
# path from it. Restricted here to characters that cannot mean anything to a
# path resolve, and validated again at the filesystem boundary — one layer is
# input shape, the other is the actual defense.
CODE_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]*$"

# Deliberately narrow: a camera frame is never SVG, so the markup risk that
# comes with mimic.py's asset allowlist does not apply here.
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


# A file on disk can be replaced in place by the vision system, so a long
# max-age would pin a superseded frame in every operator's browser. A short
# revalidating window plus the ETag below is the honest version of the same
# optimization.
_FILE_IMAGE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=30, must-revalidate",
}


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


@router.get("/{code}/defects/{slot}/frames", response_model=list[FrameOut])
def list_slot_frames(
    code: str = Path(..., min_length=1, max_length=40, pattern=CODE_PATTERN),
    slot: int = Path(...),
    limit: int = Query(30, ge=1, le=100),
    _user: dict = Depends(get_current_user),
):
    """Frames stored on disk for one defect slot, newest first.

    Empty — never an error — when the image root is unconfigured, unreachable,
    or simply has no folder for this camera. An install with no image share is
    a normal install.

    The code is not checked against the mimic's binding first. Doing so would
    put a plant database round trip in front of every frame listing, to reject a
    code that resolves to no folder anyway; an unknown code returns an empty
    list either way, and this path is polled.
    """
    _checked_slot(slot)
    return camera_files.list_slot_frames(code, slot, limit=limit)


@router.get("/{code}/defects/{slot}/frames/{index}/image")
def get_slot_frame_image(
    code: str = Path(..., min_length=1, max_length=40, pattern=CODE_PATTERN),
    slot: int = Path(...),
    index: int = Path(..., ge=0),
    _user: dict = Depends(get_current_user),
):
    """One frame's bytes, addressed by position in the newest-first listing.

    The format is sniffed from the content rather than trusted from the
    extension — this file was written by another system into a folder we do not
    control, so its name proves nothing about what is inside it.
    """
    _checked_slot(slot)
    try:
        data, meta = camera_files.read_frame(code, slot, index)
    except camera_files.FrameNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Frame not found"
        ) from None

    mime = _sniff_mime(data)
    if mime is None or mime not in ALLOWED_FRAME_MIMES:
        raise _bad("the stored file is not a PNG, JPEG or WebP image")

    headers = {
        **_FILE_IMAGE_HEADERS,
        "ETag": f'"{meta.mtime_ns:x}-{meta.size_bytes:x}"',
    }
    return Response(content=data, media_type=mime, headers=headers)
