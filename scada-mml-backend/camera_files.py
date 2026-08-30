"""Read categorized inspection frames off disk.

The vision system writes rejected frames into a folder tree the app does not
own and did not create:

    <CAMERA_IMAGE_ROOT>/<camera code>/NG/defect_<slot>/<whatever>.png

This is the only place in the backend that touches a data directory, so it is
deliberately its own module with a DB-free, HTTP-free surface — the same role
``db._safe_identifiers`` plays for SQL identifiers. A named validator standing
in front of a risky primitive can be tested exhaustively on its own, and the
traversal battery in tests/test_camera_files.py needs neither Postgres nor a
TestClient to run.

Two rules carry most of the weight:

**Callers never name a file.** The requirement is "the last categorized image
per slot", so this module picks the file and the caller addresses it by integer
index. Every path component reaching the filesystem is then either a validated
camera code or a server-generated constant — which deletes a whole class of
Windows-specific filename attacks (reserved device names, trailing-dot
stripping, alternate data streams) instead of defending against each one.

**Every segment is matched against a directory listing, never joined blind.**
The folders are lowercase (``cam-03``) while ``cameras.code`` is upper
(``CAM-03``), so a case-insensitive match is needed anyway; taking the real
name from ``scandir`` makes it a containment guarantee at the same time.

An unconfigured or missing root is not an error. Every entry point degrades to
"no frames" so a deployment that has not mounted the share yet shows an empty
contact sheet rather than a 500 — which matters, because under NSSM the service
may run as an account that cannot read a user-profile path.
"""
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import config

# Slots are positional: slot N is the Nth column of the mimic's `defect_cols`
# binding, and the folder tree uses the same numbering, so defect_3 on disk is
# the third bound column in the database.
#
# MAX_SLOT is an absolute ceiling, not the slot count. The real count comes from
# the binding and is passed in by the caller; this only exists so a malformed
# request cannot ask this module to stat an unbounded number of directories.
MIN_SLOT = 1
MAX_SLOT = 32

# Only NG frames are categorized by defect. Every camera folder also carries an
# empty OK/ directory; nothing reads it, and nothing here should.
_VERDICT_DIR = "NG"

# A file this app did not write, in a folder it does not own, so the same 2 MB
# ceiling the upload endpoint applies. Kept local rather than imported from
# cameras.py to keep this module free of the router.
MAX_FRAME_BYTES = 2 * 1024 * 1024

# One path segment. An allowlist, never a denylist: this single rule rejects
# "/", "\", ".." and ":" (alternate data streams) along with every non-ASCII
# homoglyph — fullwidth solidus and the like — that a denylist would have to
# enumerate and would eventually miss.
_SEGMENT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")

# Win32 opens these successfully by name in any directory and returns nothing.
_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {
    f"{stem}{n}" for stem in ("COM", "LPT") for n in range(1, 10)
}

# A pathological directory must not turn one request into an unbounded stat
# storm. Far above any real camera folder.
_MAX_SCAN_ENTRIES = 5000


class FrameNotFound(Exception):
    """No such frame — a missing root, camera, slot or index all land here."""


@dataclass(frozen=True)
class FrameMeta:
    """One frame, addressed by its position in the newest-first listing.

    `index` is positional and therefore not stable across writes: a new capture
    landing in the folder shifts every older frame down one. `mtime_ns` is what
    makes a fetched frame identifiable — it goes into the browser's cache key
    and the ETag, so a file replaced in place is not served stale.
    """

    index: int
    captured_at: datetime
    size_bytes: int
    mtime_ns: int


def root() -> Path | None:
    """The configured image root, or None when it is unset or not a directory.

    None is a normal state, not a failure: it means this install has no image
    share mounted. Callers degrade to "no frames"; nothing raises.
    """
    configured = (config.CAMERA_IMAGE_ROOT or "").strip()
    if not configured:
        return None
    try:
        path = Path(configured).resolve(strict=True)
    except OSError:
        return None
    return path if path.is_dir() else None


def _safe_segment(segment: str) -> str:
    """Return `segment` if it can only ever name one entry in one directory.

    Raises ValueError otherwise. This runs before any filesystem call, so a
    rejected segment never becomes a syscall.
    """
    if not isinstance(segment, str) or not segment:
        raise ValueError("empty path segment")
    if len(segment) > 64:
        raise ValueError("path segment too long")
    # Win32 silently strips trailing dots and spaces, so "a.png." and "a.png"
    # open the same file. Reject the variants rather than normalising them —
    # a name that needs normalising is not a name we were given honestly.
    if segment != segment.rstrip(" ."):
        raise ValueError("path segment has a trailing dot or space")
    if not _SEGMENT_RE.fullmatch(segment):
        raise ValueError(f"illegal path segment: {segment!r}")
    if segment.rstrip(" .").upper() in _RESERVED:
        raise ValueError(f"reserved device name: {segment!r}")
    return segment


def _child(parent: Path, segment: str) -> Path:
    """Resolve one segment inside `parent`, case-insensitively.

    The name is taken from a directory listing rather than joined onto the
    parent, so what comes back is always something that genuinely exists there
    — not a string the caller composed.
    """
    wanted = _safe_segment(segment).lower()
    try:
        with os.scandir(parent) as entries:
            for seen, entry in enumerate(entries):
                if seen >= _MAX_SCAN_ENTRIES:
                    break
                if entry.name.lower() == wanted:
                    return parent / entry.name
    except OSError as exc:
        raise FrameNotFound(f"cannot read {parent}") from exc
    raise FrameNotFound(f"no entry named {segment!r}")


def _resolve_within(base: Path, *segments: str) -> Path:
    """Walk `segments` down from `base` and prove the result is still under it.

    resolve() on both sides is what makes the containment check meaningful, and
    because resolve() follows symlinks and junctions it is simultaneously the
    symlink-escape check: a `cam-03` junction pointing at C:\\Windows resolves
    outside `base` and is refused here.
    """
    current = base
    for segment in segments:
        current = _child(current, segment)
    target = current.resolve(strict=True)
    if not target.is_relative_to(base):
        raise FrameNotFound("resolved outside the image root")
    return target


def _slot_dir(code: str, slot: int) -> Path | None:
    """The folder holding one camera's frames for one defect slot, or None."""
    if not isinstance(slot, int) or isinstance(slot, bool):
        return None
    if not MIN_SLOT <= slot <= MAX_SLOT:
        return None
    base = root()
    if base is None:
        return None
    try:
        target = _resolve_within(base, code, _VERDICT_DIR, f"defect_{slot}")
    except (FrameNotFound, ValueError):
        # A camera with no folder, a slot never used, or a code that could not
        # be a path — all of them mean "no frames", not "something went wrong".
        return None
    return target if target.is_dir() else None


def slots_with_frames(code: str, slot_count: int) -> set[int]:
    """Which of one camera's first `slot_count` slots have a file behind them.

    Exists because the defects route is polled on the operator's live cadence,
    and the obvious implementation — call list_slot_frames once per slot — walks
    the camera's path once per slot and stats every file in every one of them
    just to answer that many yes/no questions. That is fine once on page load
    and wasteful several times a minute, especially when the image root is a
    network share.

    So: resolve the camera's NG directory once, then stop at the first file in
    each slot. Returns an empty set for anything unreadable, same contract as
    everything else here.

    `slot_count` comes from the caller's binding rather than a module constant,
    so a line grading six defect categories reports six. It is clamped to
    MAX_SLOT because this walks the filesystem on a request path.
    """
    limit = min(int(slot_count), MAX_SLOT)
    if limit < MIN_SLOT:
        return set()
    base = root()
    if base is None:
        return set()
    try:
        ng_dir = _resolve_within(base, code, _VERDICT_DIR)
    except (FrameNotFound, ValueError):
        return set()

    wanted = {f"defect_{slot}": slot for slot in range(MIN_SLOT, limit + 1)}
    found: set[int] = set()
    try:
        with os.scandir(ng_dir) as entries:
            for seen, entry in enumerate(entries):
                if seen >= _MAX_SCAN_ENTRIES:
                    break
                if not entry.is_dir():
                    continue
                slot = wanted.get(entry.name.lower())
                if slot is not None and _has_any_file(entry.path):
                    found.add(slot)
    except OSError:
        return set()
    return found


def _has_any_file(directory: str) -> bool:
    """True on the first regular file seen — no stat, no sort, no full listing."""
    try:
        with os.scandir(directory) as entries:
            for seen, entry in enumerate(entries):
                if seen >= _MAX_SCAN_ENTRIES:
                    break
                if entry.is_file():
                    return True
    except OSError:
        return False
    return False


def list_slot_frames(code: str, slot: int, limit: int = 30) -> list[FrameMeta]:
    """Frames for one camera and slot, newest first. Empty when there are none.

    Ordered by mtime rather than by parsing the filename: the names the vision
    system writes carry a timestamp but also spaces ("Screenshot 2025-05-07
    111525.png"), and mtime has been verified to match that timestamp exactly.
    Trusting the filesystem's own clock costs nothing and cannot misparse.
    """
    directory = _slot_dir(code, slot)
    if directory is None:
        return []

    stats: list[tuple[int, int]] = []  # (mtime_ns, size)
    try:
        with os.scandir(directory) as entries:
            for seen, entry in enumerate(entries):
                if seen >= _MAX_SCAN_ENTRIES:
                    break
                if not entry.is_file():
                    continue
                info = entry.stat()
                stats.append((info.st_mtime_ns, info.st_size))
    except OSError:
        return []

    stats.sort(key=lambda s: s[0], reverse=True)
    return [
        FrameMeta(
            index=i,
            captured_at=datetime.fromtimestamp(mtime_ns / 1_000_000_000),
            size_bytes=size,
            mtime_ns=mtime_ns,
        )
        for i, (mtime_ns, size) in enumerate(stats[:limit])
    ]


def read_frame(code: str, slot: int, index: int) -> tuple[bytes, FrameMeta]:
    """Read one frame's bytes by its position in the newest-first listing.

    Raises FrameNotFound for any missing piece. The size is checked from the
    directory entry *before* the read, so an oversized file is refused without
    ever being pulled into memory.

    Returns raw bytes rather than a path or a file object on purpose: the
    caller sniffs the magic bytes before serving them, and a FileResponse would
    have skipped both that and the size ceiling — the two checks that matter
    most for a file this application did not write.
    """
    directory = _slot_dir(code, slot)
    if directory is None:
        raise FrameNotFound("no such camera or slot")
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        raise FrameNotFound("index must be a non-negative integer")

    entries: list[tuple[int, int, Path]] = []
    try:
        with os.scandir(directory) as scan:
            for seen, entry in enumerate(scan):
                if seen >= _MAX_SCAN_ENTRIES:
                    break
                if not entry.is_file():
                    continue
                info = entry.stat()
                entries.append((info.st_mtime_ns, info.st_size, Path(entry.path)))
    except OSError as exc:
        raise FrameNotFound("cannot read the slot folder") from exc

    entries.sort(key=lambda e: e[0], reverse=True)
    if index >= len(entries):
        raise FrameNotFound(f"no frame at index {index}")

    mtime_ns, size, path = entries[index]
    if size > MAX_FRAME_BYTES:
        raise FrameNotFound(
            f"frame is {size // 1024} KB; the limit is {MAX_FRAME_BYTES // 1024} KB"
        )

    # The listing above came from scandir inside an already-contained
    # directory, but the file itself is resolved and re-checked: between the
    # scan and the read it is still a path we are choosing to trust.
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(directory):
        raise FrameNotFound("frame resolved outside its slot folder")
    if not resolved.is_file():
        raise FrameNotFound("not a regular file")

    try:
        data = resolved.read_bytes()
    except OSError as exc:
        raise FrameNotFound("cannot read the frame") from exc

    meta = FrameMeta(
        index=index,
        captured_at=datetime.fromtimestamp(mtime_ns / 1_000_000_000),
        size_bytes=size,
        mtime_ns=mtime_ns,
    )
    return data, meta
