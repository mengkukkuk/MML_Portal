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
import heapq
import logging
import os
import re
import threading
import time
import zlib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import config

logger = logging.getLogger("mml-api.camera_files")

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

# Bound on the cheap "does this folder have anything" / "which subfolder"
# walks, which stop at the first hit and never need the whole directory.
_MAX_SCAN_ENTRIES = 5000

# Bound on the *frame* scan, which does need the whole directory: "newest" is
# only meaningful over every file. A day folder on a busy line holds well over
# 10k captures, and scandir yields in directory order (name order on NTFS, which
# for timestamped names is oldest first) - so truncating at 5000 here once made
# the strip show the oldest half of the day. The ceiling only exists so a
# runaway folder cannot pin a worker forever; hitting it is logged, not silent.
_SCAN_CEILING = 200_000

# How many of the newest frames a scan keeps. Equals the router's `limit` cap,
# so every listing and every id lookup the UI can issue is served from it.
_LIST_KEEP = 100

# One scan is shared by every request inside this window. A strip fires ~30
# image requests at once; without this each one re-walked the same 10k+ files.
# Short enough that a new capture appears on the next poll.
_LIST_TTL_S = 2.0
_LIST_CACHE_DIRS = 64

# A frame id: `<mtime_ns hex>-<crc32 of file name, hex>`. Anything else is
# rejected before the filesystem is touched.
_FID_RE = re.compile(r"^[0-9a-f]{1,16}-[0-9a-f]{8}$")


class FrameNotFound(Exception):
    """No such frame — a missing root, camera, slot or index all land here."""


@dataclass(frozen=True)
class FrameMeta:
    """One frame, addressed by its position in the newest-first listing.

    `index` is positional and therefore not stable across writes: a new capture
    landing in the folder shifts every older frame down one. `id` is what names
    a capture durably — it goes into the browser's cache key and the image URL,
    and because it embeds the mtime a file replaced in place gets a new id.
    """

    index: int
    captured_at: datetime
    size_bytes: int
    mtime_ns: int
    # Stable name for this exact capture (see frame_id). Unlike `index` it does
    # not change when newer files arrive, so it is what the browser caches by.
    id: str = ""


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


def frame_id(mtime_ns: int, name: str) -> str:
    """Durable id for one capture: its mtime plus a checksum of its file name.

    The checksum is only a tie-break for two files stamped in the same
    nanosecond (an FTP burst that preserves times); it is never used as, or
    joined into, a path.
    """
    crc = zlib.crc32(name.encode("utf-8", "surrogatepass"))
    return f"{mtime_ns:x}-{crc:08x}"


# (mtime_ns, size, file name, full path)
_Entry = tuple[int, int, str, Path]

_list_cache: dict[str, tuple[float, list[_Entry]]] = {}
_list_lock = threading.Lock()


def _scan_newest(directory: Path, keep: int = _LIST_KEEP) -> list[_Entry]:
    """The `keep` newest regular files, newest first, over the *whole* folder.

    heapq.nlargest holds `keep` entries however large the folder is, so this is
    one pass over the directory with O(keep) memory. Ordered by mtime rather
    than a parsed filename: the vision system's names carry a timestamp but
    also spaces ("Screenshot 2025-05-07 111525.png"), and mtime was verified to
    match it exactly. Ties break on name so the order is deterministic.
    """
    def entries():
        with os.scandir(directory) as scan:
            for seen, entry in enumerate(scan):
                if seen >= _SCAN_CEILING:
                    logger.warning(
                        "frame scan of %s stopped at %d entries; newer files may be missed",
                        directory, _SCAN_CEILING,
                    )
                    return
                if not entry.is_file():
                    continue
                info = entry.stat()
                yield (info.st_mtime_ns, info.st_size, entry.name, Path(entry.path))

    return heapq.nlargest(keep, entries(), key=lambda e: (e[0], e[2]))


def _newest_first(directory: Path) -> list[_Entry]:
    """`_scan_newest`, shared between concurrent callers for a couple of seconds.

    Single-flight under one lock: when 30 image requests arrive together the
    first does the scan and the other 29 reuse it, instead of each re-walking
    the folder. A short TTL (not a directory-mtime check) because a network
    share does not reliably bump a folder's mtime when a file is added.
    """
    key = str(directory)
    with _list_lock:
        now = time.monotonic()
        hit = _list_cache.get(key)
        if hit is not None and now - hit[0] < _LIST_TTL_S:
            return hit[1]
        entries = _scan_newest(directory)
        _list_cache[key] = (time.monotonic(), entries)
        while len(_list_cache) > _LIST_CACHE_DIRS:
            _list_cache.pop(next(iter(_list_cache)))
        return entries


def _meta(index: int, entry: _Entry) -> FrameMeta:
    mtime_ns, size, name, _path = entry
    return FrameMeta(
        index=index,
        captured_at=datetime.fromtimestamp(mtime_ns / 1_000_000_000),
        size_bytes=size,
        mtime_ns=mtime_ns,
        id=frame_id(mtime_ns, name),
    )


def _frames_in(directory: Path | None, limit: int) -> list[FrameMeta]:
    """Newest-first listing of one folder. Empty for anything unreadable."""
    if directory is None:
        return []
    try:
        entries = _newest_first(directory)
    except OSError:
        return []
    return [_meta(i, e) for i, e in enumerate(entries[:limit])]


def _open_entry(directory: Path, entry: _Entry, index: int) -> tuple[bytes, FrameMeta]:
    """Read one already-located frame, enforcing the size ceiling and containment.

    The size is checked from the directory entry *before* the read, so an
    oversized file is refused without ever being pulled into memory. Returns raw
    bytes rather than a path or file object on purpose: the caller sniffs the
    magic bytes before serving them, and a FileResponse would have skipped both
    that and the size ceiling - the two checks that matter most for a file this
    application did not write.
    """
    _mtime_ns, size, _name, path = entry
    if size > MAX_FRAME_BYTES:
        raise FrameNotFound(
            f"frame is {size // 1024} KB; the limit is {MAX_FRAME_BYTES // 1024} KB"
        )

    # The listing came from scandir inside an already-contained directory, but
    # the file itself is resolved and re-checked: between the scan and the read
    # it is still a path we are choosing to trust.
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise FrameNotFound("frame is gone") from exc
    if not resolved.is_relative_to(directory):
        raise FrameNotFound("frame resolved outside its folder")
    if not resolved.is_file():
        raise FrameNotFound("not a regular file")

    try:
        data = resolved.read_bytes()
    except OSError as exc:
        raise FrameNotFound("cannot read the frame") from exc

    return data, _meta(index, entry)


def _read_in(directory: Path | None, index: int) -> tuple[bytes, FrameMeta]:
    """Read one frame by its position in the newest-first listing.

    Kept for the positional routes. Position drifts as captures arrive, so the
    UI uses `_read_in_by_id`; this stays so an older client keeps working.
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
    return _open_entry(directory, entries[index], index)


def _find_by_id(directory: Path, fid: str) -> tuple[int, _Entry] | None:
    """Locate a capture by id: the shared newest-N listing first, else one scan.

    The fallback matters for a long-open lightbox: a frame that has since aged
    out of the newest 100 still exists and is still addressable.
    """
    for i, entry in enumerate(_newest_first(directory)):
        if frame_id(entry[0], entry[2]) == fid:
            return i, entry
    mtime_ns = int(fid.split("-", 1)[0], 16)
    with os.scandir(directory) as scan:
        for seen, dirent in enumerate(scan):
            if seen >= _SCAN_CEILING:
                break
            if not dirent.is_file():
                continue
            info = dirent.stat()
            if info.st_mtime_ns == mtime_ns and frame_id(mtime_ns, dirent.name) == fid:
                return -1, (info.st_mtime_ns, info.st_size, dirent.name, Path(dirent.path))
    return None


def _read_in_by_id(directory: Path | None, fid: str) -> tuple[bytes, FrameMeta]:
    """Read the one capture `fid` names. Same guarantees as `_read_in`.

    `fid` is validated against a strict pattern before anything else, and it is
    only ever *compared* with names that came out of scandir - it never reaches
    a path. The caller still cannot name a file.
    """
    if directory is None:
        raise FrameNotFound("no such camera, slot or verdict folder")
    if not isinstance(fid, str) or not _FID_RE.fullmatch(fid):
        raise FrameNotFound("malformed frame id")
    try:
        found = _find_by_id(directory, fid)
    except OSError as exc:
        raise FrameNotFound("cannot read the frame folder") from exc
    if found is None:
        raise FrameNotFound("no such frame")
    index, entry = found
    return _open_entry(directory, entry, index)


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


def read_frame_by_id(code: str, slot: int, fid: str) -> tuple[bytes, FrameMeta]:
    """One rejected frame's bytes, addressed by its durable id."""
    return _read_in_by_id(_slot_dir(code, slot), fid)


def read_ok_frame_by_id(code: str, fid: str) -> tuple[bytes, FrameMeta]:
    """One passing frame's bytes, addressed by its durable id."""
    return _read_in_by_id(_ok_dir(code), fid)
