"""Tests for camera_files — the only filesystem reader in the backend.

Everything here runs against a fake root under tmp_path with no database and no
TestClient. That is the whole reason camera_files has a DB-free, HTTP-free
surface: the traversal battery below is the security boundary of this feature,
and it should be cheap enough that nobody is tempted to skip it.
"""
import os
import struct

import pytest

import camera_files
from camera_files import FrameNotFound

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 24
WEBP = b"RIFF" + struct.pack("<I", 32) + b"WEBP" + b"\x00" * 20
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'


@pytest.fixture
def image_root(tmp_path, monkeypatch):
    """A stand-in for the vision system's output folder.

    Mirrors the real one: lowercase camera directories against upper-case codes,
    an NG tree with some slots used and some absent, an empty OK/ nobody reads,
    and filenames with spaces in them.
    """
    root = tmp_path / "tobacco_cam"
    slot1 = root / "cam-03" / "NG" / "defect_1"
    slot1.mkdir(parents=True)
    (root / "cam-03" / "NG" / "defect_2").mkdir()      # present but empty
    (root / "cam-03" / "OK").mkdir()                    # never read
    # defect_3+ deliberately absent — the binding declares more slots than this
    # line actually grades, which is the normal state of a shared vision schema.

    # Written oldest-first, then stamped out of order, so any test that passes
    # by accident of creation order fails here.
    for name, mtime in (
        ("Screenshot 2025-05-07 105855.png", 1_746_589_135),
        ("Screenshot 2025-05-07 110032.png", 1_746_590_432),
        ("Screenshot 2025-05-07 111525.png", 1_746_591_325),
    ):
        path = slot1 / name
        path.write_bytes(PNG)
        os.utime(path, (mtime, mtime))

    monkeypatch.setattr(camera_files.config, "CAMERA_IMAGE_ROOT", str(root))
    return root


# --- the degradation contract --------------------------------------------------
# An install with no image share is a normal install, not a broken one. Each of
# these must return "nothing", never raise, because the endpoints above them
# turn an exception into a 500 and a 500 into an operator losing the whole panel.

def test_unconfigured_root_is_none_not_an_error(monkeypatch):
    monkeypatch.setattr(camera_files.config, "CAMERA_IMAGE_ROOT", "")
    assert camera_files.root() is None
    assert camera_files.list_slot_frames("CAM-03", 1) == []


def test_whitespace_only_root_is_treated_as_unset(monkeypatch):
    monkeypatch.setattr(camera_files.config, "CAMERA_IMAGE_ROOT", "   ")
    assert camera_files.root() is None


def test_nonexistent_root_degrades_instead_of_raising(monkeypatch, tmp_path):
    monkeypatch.setattr(
        camera_files.config, "CAMERA_IMAGE_ROOT", str(tmp_path / "not-mounted")
    )
    assert camera_files.root() is None
    assert camera_files.list_slot_frames("CAM-03", 1) == []
    with pytest.raises(FrameNotFound):
        camera_files.read_frame("CAM-03", 1, 0)


def test_root_pointing_at_a_file_is_not_a_root(monkeypatch, tmp_path):
    decoy = tmp_path / "a-file"
    decoy.write_bytes(PNG)
    monkeypatch.setattr(camera_files.config, "CAMERA_IMAGE_ROOT", str(decoy))
    assert camera_files.root() is None


def test_unknown_camera_is_empty_not_an_error(image_root):
    assert camera_files.list_slot_frames("CAM-99", 1) == []


def test_missing_slot_directory_is_empty_not_an_error(image_root):
    """defect_5 has no folder. The binding still names the column, so this is
    the normal state of an unused slot rather than a misconfiguration."""
    assert camera_files.list_slot_frames("CAM-03", 5) == []


def test_present_but_empty_slot_is_empty(image_root):
    assert camera_files.list_slot_frames("CAM-03", 2) == []


# --- listing behaviour ---------------------------------------------------------

def test_frames_are_newest_first(image_root):
    frames = camera_files.list_slot_frames("CAM-03", 1)
    assert len(frames) == 3
    assert [f.index for f in frames] == [0, 1, 2]
    mtimes = [f.mtime_ns for f in frames]
    assert mtimes == sorted(mtimes, reverse=True)


def test_camera_code_matches_the_folder_case_insensitively(image_root):
    """The folder is `cam-03`; the code is `CAM-03`. Different people typed
    them on different screens and neither is wrong."""
    assert len(camera_files.list_slot_frames("CAM-03", 1)) == 3
    assert len(camera_files.list_slot_frames("cam-03", 1)) == 3
    assert len(camera_files.list_slot_frames("Cam-03", 1)) == 3


def test_filenames_with_spaces_are_read(image_root):
    """Regression guard: the real files are named "Screenshot 2025-05-07
    111525.png". Any future tightening of the *filename* rules — as opposed to
    the path-segment rules — would silently empty every camera panel."""
    data, meta = camera_files.read_frame("CAM-03", 1, 0)
    assert data == PNG
    assert meta.size_bytes == len(PNG)


def test_limit_caps_the_listing(image_root):
    assert len(camera_files.list_slot_frames("CAM-03", 1, limit=2)) == 2


def test_directories_inside_a_slot_are_not_listed_as_frames(image_root):
    (image_root / "cam-03" / "NG" / "defect_1" / "subdir").mkdir()
    assert len(camera_files.list_slot_frames("CAM-03", 1)) == 3


@pytest.mark.parametrize("slot", [0, -1, 33, 99])
def test_out_of_range_slots_have_no_frames(image_root, slot):
    assert camera_files.list_slot_frames("CAM-03", slot) == []
    with pytest.raises(FrameNotFound):
        camera_files.read_frame("CAM-03", slot, 0)


def test_bool_is_not_a_valid_slot(image_root):
    """True == 1 in Python. A bool arriving here means a caller mixed up a flag
    with a slot number, and silently reading defect_1 would hide that."""
    assert camera_files.list_slot_frames("CAM-03", True) == []


# --- slots_with_frames ---------------------------------------------------------
# The polled path: /defects runs this on every live tick, so it answers N
# yes/no questions with one walk instead of N full listings. `slot_count` comes
# from the caller's `defect_cols` binding, not from a module constant, so a line
# grading six categories asks about six.

def test_slots_with_frames_reports_only_slots_holding_files(image_root):
    """defect_1 has files, defect_2 is an empty directory, defect_3..5 have no
    directory at all. All three are different on disk and identical to an
    operator: nothing to look at."""
    assert camera_files.slots_with_frames("CAM-03", 5) == {1}


def test_slots_with_frames_matches_the_camera_case_insensitively(image_root):
    assert camera_files.slots_with_frames("cam-03", 5) == {1}


def test_slots_with_frames_agrees_with_list_slot_frames(image_root):
    """The cheap check and the full listing must never disagree — a slot shown
    as having frames that then renders an empty strip is worse than either."""
    cheap = camera_files.slots_with_frames("CAM-03", camera_files.MAX_SLOT)
    for slot in range(camera_files.MIN_SLOT, camera_files.MAX_SLOT + 1):
        full = bool(camera_files.list_slot_frames("CAM-03", slot))
        assert (slot in cheap) == full, f"slot {slot} disagrees"


def test_slots_with_frames_stops_at_the_bound_slot_count(image_root):
    """The binding decides how many slots exist. A folder past the end of
    `defect_cols` is not a slot this line grades, however many files are in it."""
    (image_root / "cam-03" / "NG" / "defect_9").mkdir()
    (image_root / "cam-03" / "NG" / "defect_9" / "x.png").write_bytes(PNG)

    assert camera_files.slots_with_frames("CAM-03", 5) == {1}
    assert camera_files.slots_with_frames("CAM-03", 9) == {1, 9}


def test_slots_with_frames_ignores_directories_that_are_not_slots(image_root):
    (image_root / "cam-03" / "NG" / "scratch").mkdir()
    (image_root / "cam-03" / "NG" / "scratch" / "x.png").write_bytes(PNG)
    assert camera_files.slots_with_frames("CAM-03", camera_files.MAX_SLOT) == {1}


def test_slots_with_frames_clamps_an_absurd_slot_count(image_root):
    """MAX_SLOT is an absolute ceiling rather than the slot count: a malformed
    request must not turn one poll into an unbounded stat storm."""
    (image_root / "cam-03" / "NG" / f"defect_{camera_files.MAX_SLOT + 1}").mkdir()
    (image_root / "cam-03" / "NG" / f"defect_{camera_files.MAX_SLOT + 1}" / "x.png").write_bytes(PNG)

    assert camera_files.slots_with_frames("CAM-03", 10_000) == {1}


@pytest.mark.parametrize("slot_count", [0, -1])
def test_slots_with_frames_is_empty_for_a_binding_with_no_slots(image_root, slot_count):
    assert camera_files.slots_with_frames("CAM-03", slot_count) == set()


def test_slots_with_frames_is_empty_without_a_root(monkeypatch):
    monkeypatch.setattr(camera_files.config, "CAMERA_IMAGE_ROOT", "")
    assert camera_files.slots_with_frames("CAM-03", 5) == set()


def test_slots_with_frames_is_empty_for_an_unknown_camera(image_root):
    assert camera_files.slots_with_frames("CAM-99", 5) == set()


@pytest.mark.parametrize("code", ["../../etc", "C:\\Windows", "NUL", ""])
def test_slots_with_frames_refuses_a_hostile_code(image_root, code):
    """The fast path takes the same segments as the slow one, so it has to
    enforce the same containment — an optimisation that skipped the check
    would be a hole behind a route that is polled continuously."""
    assert camera_files.slots_with_frames(code, 5) == set()


# --- reading -------------------------------------------------------------------

def test_index_past_the_end_is_not_found(image_root):
    with pytest.raises(FrameNotFound):
        camera_files.read_frame("CAM-03", 1, 3)


@pytest.mark.parametrize("index", [-1, True])
def test_negative_and_bool_indexes_are_refused(image_root, index):
    with pytest.raises(FrameNotFound):
        camera_files.read_frame("CAM-03", 1, index)


def test_oversized_frame_is_refused_without_being_read(image_root):
    big = image_root / "cam-03" / "NG" / "defect_1" / "huge.png"
    big.write_bytes(PNG + b"\x00" * (camera_files.MAX_FRAME_BYTES + 1))
    os.utime(big, (2_000_000_000, 2_000_000_000))  # newest, so index 0
    with pytest.raises(FrameNotFound):
        camera_files.read_frame("CAM-03", 1, 0)


def test_read_returns_bytes_so_the_caller_can_sniff_them(image_root):
    """A .png holding SVG markup must be catchable. camera_files returns bytes
    rather than a path precisely so cameras.py can check the magic bytes — a
    FileResponse would have streamed this to the browser on the strength of its
    extension alone."""
    liar = image_root / "cam-03" / "NG" / "defect_1" / "liar.png"
    liar.write_bytes(SVG)
    os.utime(liar, (2_000_000_000, 2_000_000_000))
    data, _ = camera_files.read_frame("CAM-03", 1, 0)
    assert data == SVG  # camera_files hands it over…
    assert camera_files_sniff(data) is None  # …and the router refuses it


def camera_files_sniff(data):
    """The router's sniffer, imported lazily to keep this module DB-free."""
    import cameras
    return cameras._sniff_mime(data)


# --- the traversal battery -----------------------------------------------------
# _safe_segment runs before any syscall, so a rejected segment never becomes a
# filesystem operation. It is an allowlist; these cases document what that
# allowlist is actually buying.

@pytest.mark.parametrize(
    "segment",
    [
        "..", "../..", r"..\..", "....//", "./cam-03", ".",
        "C:\\Windows\\win.ini", "C:/Windows/win.ini", "/etc/passwd",
        "\\\\server\\share", "cam-03/../..", "cam-03\\..",
        "", " ", ".hidden",
        "NUL", "CON", "COM1", "LPT9", "nul", "con",
        "a.png.", "a.png ", "a.png:stream", "a:b",
        "．．", "\uff0f", "cam\u2044 03", "café",
        "a" * 300, "cam\x00-03", "cam\n03", "cam 03",
    ],
)
def test_illegal_path_segments_are_rejected(segment):
    with pytest.raises(ValueError):
        camera_files._safe_segment(segment)


@pytest.mark.parametrize("segment", ["cam-03", "CAM-03", "defect_1", "NG", "a.b-c_d", "0"])
def test_legal_path_segments_are_accepted(segment):
    assert camera_files._safe_segment(segment) == segment


@pytest.mark.parametrize(
    "code",
    [
        "../../etc", "..\\..\\Windows", "C:\\Windows",
        "/etc/passwd", "cam-03/../../..", "NUL", "",
    ],
)
def test_a_hostile_camera_code_reads_nothing(image_root, code):
    """The DB-controlled leg. A camera code now comes from a *plant* table the
    vision system owns, and ends up in a filesystem path — so it is a traversal
    primitive unless something stops it. The route's CODE_PATTERN is the first
    layer, this is the one that counts."""
    assert camera_files.list_slot_frames(code, 1) == []
    with pytest.raises(FrameNotFound):
        camera_files.read_frame(code, 1, 0)


def test_resolve_within_refuses_a_sibling_of_the_root(tmp_path, monkeypatch):
    """Containment is checked on the *resolved* path, both sides. A segment that
    walks out of the root has to be caught even if every individual name is
    otherwise legal."""
    root = tmp_path / "root"
    (root / "inside").mkdir(parents=True)
    (tmp_path / "outside").mkdir()
    base = root.resolve(strict=True)
    assert camera_files._resolve_within(base, "inside") == (base / "inside")
    with pytest.raises((FrameNotFound, ValueError)):
        camera_files._resolve_within(base, "..", "outside")


def _can_symlink(tmp_path):
    try:
        (tmp_path / "_probe").symlink_to(tmp_path)
        return True
    except (OSError, NotImplementedError):
        return False


def test_a_symlinked_camera_folder_cannot_escape_the_root(tmp_path, monkeypatch):
    """Covered in production by _resolve_within calling resolve() on both sides:
    resolve() follows links, so an escaping link lands outside `base` and fails
    the containment check. Skipped where the OS won't let the test build one —
    on Windows symlink creation needs admin or Developer Mode, which is a
    permissions fact about the test host, not a gap in the check.
    """
    if not _can_symlink(tmp_path):
        pytest.skip("this host cannot create symlinks (Windows without Developer Mode)")

    root = tmp_path / "root"
    root.mkdir()
    secret = tmp_path / "secret" / "NG" / "defect_1"
    secret.mkdir(parents=True)
    (secret / "loot.png").write_bytes(PNG)
    (root / "cam-03").symlink_to(tmp_path / "secret", target_is_directory=True)

    monkeypatch.setattr(camera_files.config, "CAMERA_IMAGE_ROOT", str(root))
    assert camera_files.list_slot_frames("CAM-03", 1) == []
