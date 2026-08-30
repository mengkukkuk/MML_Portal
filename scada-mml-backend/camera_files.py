"""Read categorized inspection frames off disk.

The vision system writes frames into a folder tree the app does not own and did
not create:

    <CAMERA_IMAGE_ROOT>/<camera code>/NG/<date>/defect_<slot>/<whatever>.png
    <CAMERA_IMAGE_ROOT>/<camera code>/OK/<date>/<whatever>.png

Only the **newest** date folder is read. The alternative — merging every date —
makes the cost of a single poll grow with every day the line has ever run, and
/defects is polled on the operator's live cadence against what is usually a
network share. The rail's own framing ("defects in the latest batch") is same-day
anyway, so the older folders are history, not live state.

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

# Slots are positions in camera_defect.defect_array; the folder tree uses the
# same numbering, so defect_3 on disk is element 3 of the array.
#
# The array is unbounded in the schema, but this is a path segment and a route
# parameter, so it needs a ceiling. 16 is comfortably above the 5 the vision
# system ships with while keeping the folder scan and the slot list bounded by
# something other than whatever a remote database happens to contain.
MIN_SLOT = 1
MAX_SLOT = 16

# `defect_<n>`, lowercased, as written by the vision system. No leading zeros:
# _slot_dir only ever builds `defect_{int}`, so accepting `defect_01` as slot 1
# would let slots_with_frames report frames that list_slot_frames cannot find.
_SLOT_DIR_RE = re.compile(r"^defect_([1-9][0-9]?)$")

# The two verdict trees. NG is subdivided by defect slot; OK is not — a passing
# frame has no reason to be categorized, so its date folder holds files directly.
_NG_DIR = "NG"
_OK_DIR = "OK"

# A capture date folder: `2026-08-30` or `20260830`. Matched rather than assumed
# so a stray `thumbs`/`.tmp` sibling can never be mistaken for the newest day.
# Comparison strips the dashes, which makes the two spellings sort against each
# other correctly on the off chance a tree contains both.
_DATE_DIR_RE = re.compile(r"^(\d{4})-?(\d{2})-?(\d{2})$")

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


def _contained(base: Path, path: Path) -> Path | None:
    """Resolve `path`, returning it only if it is still under `base`.

    The tail of `_resolve_within`, for paths that came out of a `scandir` rather
    than from a caller's segments. resolve() follows symlinks and junctions, so
    this is the escape check: a `2026-08-30` junction pointing at C:\\Windows
    resolves outside the root and is refused here.
    """
    try:
        target = path.resolve(strict=True)
    except OSError:
        return None
    return target if target.is_relative_to(base) else None


def _newest_date_dir(base: Path, code: str, verdict: str) -> Path | None:
    """One camera's most recent capture-date folder under NG/ or OK/, or None."""
    try:
        verdict_dir = _resolve_within(base, code, verdict)
    except (FrameNotFound, ValueError):
        # No folder for this camera, or a code that could not be a path. Both
        # mean "no frames", not "something went wrong".
        return None

    newest: tuple[str, Path] | None = None
    try:
        with os.scandir(verdict_dir) as entries:
            for seen, entry in enumerate(entries):
                if seen >= _MAX_SCAN_ENTRIES:
                    break
                if not entry.is_dir():
                    continue
                match = _DATE_DIR_RE.match(entry.name)
                if match is None:
                    continue
                key = "".join(match.groups())
                if newest is None or key > newest[0]:
                    newest = (key, Path(entry.path))
    except OSError:
        return None
    if newest is None:
        return None
    target = _contained(base, newest[1])
    return target if target is not None and target.is_dir() else None


def _slot_dir(code: str, slot: int) -> Path | None:
    """The folder holding one camera's newest-day frames for one defect slot."""
    if not isinstance(slot, int) or isinstance(slot, bool):
        return None
    if not MIN_SLOT <= slot <= MAX_SLOT:
        return None
    base = root()
    if base is None:
        return None
    day = _newest_date_dir(base, code, _NG_DIR)
    if day is None:
        return None
    try:
        child = _child(day, f"defect_{slot}")
    except (FrameNotFound, ValueError):
        # A slot never used on the newest day is not an error.
        return None
    target = _contained(base, child)
    return target if target is not None and target.is_dir() else None


def _ok_dir(code: str) -> Path | None:
    """The folder holding one camera's newest-day passing frames."""
    base = root()
    if base is None:
        return None
    return _newest_date_dir(base, code, _OK_DIR)


def slots_with_frames(code: str) -> set[int]:
    """Which of one camera's slots have at least one file behind them.

    Exists because /defects is polled on the operator's live cadence, and the
    obvious implementation — call list_slot_frames once per slot — re-walks the
    camera's path per slot and stats every file in each one just to answer a
    handful of yes/no questions. That is fine once on page load and wasteful
    several times a minute, especially when the image root is a network share.

    So: resolve the camera's newest NG day once, then stop at the first file in
    each slot. Returns an empty set for anything unreadable, same contract as
    everything else here.
    """
    base = root()
    if base is None:
        return set()
    day = _newest_date_dir(base, code, _NG_DIR)
    if day is None:
        return set()

    found: set[int] = set()
    try:
        with os.scandir(day) as entries:
            for seen, entry in enumerate(entries):
                if seen >= _MAX_SCAN_ENTRIES:
                    break
                if not entry.is_dir():
                    continue
                match = _SLOT_DIR_RE.match(entry.name.lower())
                if match is None:
                    continue
                slot = int(match.group(1))
                if MIN_SLOT <= slot <= MAX_SLOT and _has_any_file(entry.path):
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


def _newest_first(directory: Path) -> list[tuple[int, int, Path]]:
    """(mtime_ns, size, path) for every regular file, newest first.

    Ordered by mtime rather than by parsing the filename: the names the vision
    system writes carry a timestamp but also spaces ("Screenshot 2025-05-07
    111525.png"), and mtime has been verified to match that timestamp exactly.
    Trusting the filesystem's own clock costs nothing and cannot misparse.
    """
    entries: list[tuple[int, int, Path]] = []
    with os.scandir(directory) as scan:
        for seen, entry in enumerate(scan):
            if seen >= _MAX_SCAN_ENTRIES:
                break
            if not entry.is_file():
                continue
            info = entry.stat()
            entries.append((info.st_mtime_ns, info.st_size, Path(entry.path)))
    entries.sort(key=lambda e: e[0], reverse=True)
    return entries


def _meta(index: int, mtime_ns: int, size: int) -> FrameMeta:
    return FrameMeta(
        index=index,
        captured_at=datetime.fromtimestamp(mtime_ns / 1_000_000_000),
        size_bytes=size,
        mtime_ns=mtime_ns,
    )


def _frames_in(directory: Path | None, limit: int) -> list[FrameMeta]:
    """Newest-first listing of one folder. Empty for anything unreadable."""
    if directory is None:
        return []
    try:
        entries = _newest_first(directory)
    except OSError:
        return []
    return [
        _meta(i, mtime_ns, size)
        for i, (mtime_ns, size, _path) in enumerate(entries[:limit])
    ]


def _read_in(directory: Path | None, index: int) -> tuple[bytes, FrameMeta]:
    """Read one frame's bytes by its position in the newest-first listing.

    Raises FrameNotFound for any missing piece. The size is checked from the
    directory entry *before* the read, so an oversized file is refused without
    ever being pulled into memory.

    Returns raw bytes rather than a path or a file object on purpose: the
    caller sniffs the magic bytes before serving them, and a FileResponse would
    have skipped both that and the size ceiling — the two checks that matter
    most for a file this application did not write.
    """
    if directory is None:
        raise FrameNotFound("no such camera, slot or verdict folder")
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        raise FrameNotFound("index must be a non-negative integer")

    try:
        entries = _newest_first(directory)
    except OSError as exc:
        raise FrameNotFound("cannot read the frame folder") from exc

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
        raise FrameNotFound("frame resolved outside its folder")
    if not resolved.is_file():
        raise FrameNotFound("not a regular file")

    try:
        data = resolved.read_bytes()
    except OSError as exc:
        raise FrameNotFound("cannot read the frame") from exc

    return data, _meta(index, mtime_ns, size)


def list_slot_frames(code: str, slot: int, limit: int = 30) -> list[FrameMeta]:
    """Rejected frames for one camera and defect slot, newest first."""
    return _frames_in(_slot_dir(code, slot), limit)


def read_frame(code: str, slot: int, index: int) -> tuple[bytes, FrameMeta]:
    """One rejected frame's bytes, addressed by newest-first position."""
    return _read_in(_slot_dir(code, slot), index)


def list_ok_frames(code: str, limit: int = 30) -> list[FrameMeta]:
    """Passing frames for one camera, newest first. Not split by defect slot."""
    return _frames_in(_ok_dir(code), limit)


def read_ok_frame(code: str, index: int) -> tuple[bytes, FrameMeta]:
    """One passing frame's bytes, addressed by newest-first position."""
    return _read_in(_ok_dir(code), index)
