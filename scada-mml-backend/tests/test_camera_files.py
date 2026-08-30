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


# The two capture days the fixture builds. Only DAY is ever read; OLD_DAY exists
# so every test is also a check that yesterday stays out of today's listing.
DAY = "2026-08-30"
OLD_DAY = "2026-08-29"


def ng_day(root, day=DAY):
    return root / "cam-03" / "NG" / day


def ok_day(root, day=DAY):
    return root / "cam-03" / "OK" / day


def _stamp(directory, names_and_mtimes, data=PNG):
    for name, mtime in names_and_mtimes:
        path = directory / name
        path.write_bytes(data)
        os.utime(path, (mtime, mtime))


@pytest.fixture
def image_root(tmp_path, monkeypatch):
    """A stand-in for the vision system's output folder.

    Mirrors the real one: lowercase camera directories against upper-case codes,
    NG and OK trees each subdivided by capture date, some slots used and some
    absent, and filenames with spaces in them.

    The older day is fully populated on both sides. Nothing under it should ever
    surface — reading it would mean a poll's cost grows with the line's history.
    """
    root = tmp_path / "tobacco_cam"
    slot1 = ng_day(root) / "defect_1"
    slot1.mkdir(parents=True)
    (ng_day(root) / "defect_2").mkdir()               # present but empty
    # defect_3.. deliberately absent — an unused slot has no folder at all.

    old_slot1 = ng_day(root, OLD_DAY) / "defect_1"
    old_slot1.mkdir(parents=True)
    (ng_day(root, OLD_DAY) / "defect_7").mkdir()      # a slot only yesterday used

    ok_day(root).mkdir(parents=True)
    ok_day(root, OLD_DAY).mkdir(parents=True)

    # Written oldest-first, then stamped out of order, so any test that passes
    # by accident of creation order fails here.
    _stamp(slot1, (
        ("Screenshot 2025-05-07 105855.png", 1_746_589_135),
        ("Screenshot 2025-05-07 111525.png", 1_746_591_325),
        ("Screenshot 2025-05-07 110032.png", 1_746_590_432),
    ))
    _stamp(old_slot1, (("yesterday.png", 1_746_500_000),))
    _stamp(ng_day(root, OLD_DAY) / "defect_7", (("yesterday.png", 1_746_500_001),))
    _stamp(ok_day(root), (
        ("pass a.png", 1_746_589_200),
        ("pass b.png", 1_746_591_400),
    ))
    _stamp(ok_day(root, OLD_DAY), (("yesterday-ok.png", 1_746_500_002),))

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
    """defect_5 has no folder. The table still has the column, so this is the
    normal state of an unused slot rather than a misconfiguration."""
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
    (ng_day(image_root) / "defect_1" / "subdir").mkdir()
    assert len(camera_files.list_slot_frames("CAM-03", 1)) == 3


@pytest.mark.parametrize("slot", [0, 6, -1, 99])
def test_out_of_range_slots_have_no_frames(image_root, slot):
    assert camera_files.list_slot_frames("CAM-03", slot) == []
    with pytest.raises(FrameNotFound):
        camera_files.read_frame("CAM-03", slot, 0)


def test_bool_is_not_a_valid_slot(image_root):
    """True == 1 in Python. A bool arriving here means a caller mixed up a flag
    with a slot number, and silently reading defect_1 would hide that."""
    assert camera_files.list_slot_frames("CAM-03", True) == []


# --- the date level ------------------------------------------------------------
# Only the newest capture day is read, on both trees. These pin that down,
# because "merge every day" is the intuitive reading of the folder tree and it
# is the one whose cost grows without bound.

def test_only_the_newest_day_is_listed(image_root):
    """The older day holds a defect_1 frame of its own. Seeing 4 here would mean
    a poll's cost grows with every day the line has ever run."""
    frames = camera_files.list_slot_frames("CAM-03", 1)
    assert len(frames) == 3
    assert all(f.mtime_ns > 1_746_500_000 * 1_000_000_000 for f in frames)


def test_a_slot_used_only_yesterday_is_not_offered(image_root):
    """defect_7 exists under the older day only. Offering it would put a chip on
    the rail whose film strip is permanently empty."""
    assert 7 not in camera_files.slots_with_frames("CAM-03")
    assert camera_files.list_slot_frames("CAM-03", 7) == []


def test_a_newer_day_takes_over(image_root):
    newer = ng_day(image_root, "2026-09-01") / "defect_1"
    newer.mkdir(parents=True)
    _stamp(newer, (("today.png", 1_800_000_000),))
    frames = camera_files.list_slot_frames("CAM-03", 1)
    assert [f.mtime_ns for f in frames] == [1_800_000_000 * 1_000_000_000]


def test_compact_and_dashed_date_folders_sort_against_each_other(image_root):
    """`20260901` and `2026-09-01` are the same day spelled two ways. Comparing
    the raw names would sort every compact folder below every dashed one."""
    newer = ng_day(image_root, "20260901") / "defect_1"
    newer.mkdir(parents=True)
    _stamp(newer, (("today.png", 1_800_000_000),))
    assert len(camera_files.list_slot_frames("CAM-03", 1)) == 1


def test_non_date_folders_are_never_mistaken_for_a_day(image_root):
    """A `thumbs`/`_tmp` sibling sorts above every date string. Picking it would
    empty the strip on a camera that has frames."""
    for name in ("thumbs", "zz-archive", "_tmp"):
        (image_root / "cam-03" / "NG" / name / "defect_1").mkdir(parents=True)
    assert len(camera_files.list_slot_frames("CAM-03", 1)) == 3


def test_a_verdict_tree_with_no_date_folders_is_empty(image_root):
    (image_root / "cam-09" / "NG").mkdir(parents=True)
    assert camera_files.list_slot_frames("CAM-09", 1) == []
    assert camera_files.slots_with_frames("CAM-09") == set()


# --- OK frames -----------------------------------------------------------------
# The passing tree is flat below the date: an OK capture has no defect, so there
# is nothing to categorize it by. Same degradation contract as everything else.

def test_ok_frames_are_newest_first(image_root):
    frames = camera_files.list_ok_frames("CAM-03")
    assert [f.index for f in frames] == [0, 1]
    assert frames[0].mtime_ns > frames[1].mtime_ns


def test_ok_frames_come_from_the_newest_day_only(image_root):
    assert len(camera_files.list_ok_frames("CAM-03")) == 2


def test_ok_limit_caps_the_listing(image_root):
    assert len(camera_files.list_ok_frames("CAM-03", limit=1)) == 1


def test_ok_frames_match_the_camera_case_insensitively(image_root):
    assert len(camera_files.list_ok_frames("cam-03")) == 2


def test_reading_an_ok_frame_returns_its_bytes(image_root):
    data, meta = camera_files.read_ok_frame("CAM-03", 0)
    assert data == PNG
    assert meta.index == 0
    assert meta.size_bytes == len(PNG)


def test_ok_index_past_the_end_is_not_found(image_root):
    with pytest.raises(FrameNotFound):
        camera_files.read_ok_frame("CAM-03", 2)


def test_ok_frames_are_empty_without_a_root(monkeypatch):
    monkeypatch.setattr(camera_files.config, "CAMERA_IMAGE_ROOT", "")
    assert camera_files.list_ok_frames("CAM-03") == []
    with pytest.raises(FrameNotFound):
        camera_files.read_ok_frame("CAM-03", 0)


def test_ok_frames_are_empty_for_a_camera_with_no_ok_tree(image_root):
    (image_root / "cam-07" / "NG").mkdir(parents=True)
    assert camera_files.list_ok_frames("CAM-07") == []


@pytest.mark.parametrize("code", ["../../etc", "C:\\Windows", "NUL", ""])
def test_a_hostile_camera_code_reads_no_ok_frames(image_root, code):
    """The OK path takes the camera code from the same place the NG path does,
    so it has to enforce the same containment."""
    assert camera_files.list_ok_frames(code) == []
    with pytest.raises(FrameNotFound):
        camera_files.read_ok_frame(code, 0)


# --- slots_with_frames ---------------------------------------------------------
# The polled path: /defects runs this on every live tick, so it answers five
# yes/no questions with one walk instead of five full listings.

def test_slots_with_frames_reports_only_slots_holding_files(image_root):
    """defect_1 has files, defect_2 is an empty directory, defect_3..5 have no
    directory at all. All three are different on disk and identical to an
    operator: nothing to look at."""
    assert camera_files.slots_with_frames("CAM-03") == {1}


def test_slots_with_frames_matches_the_camera_case_insensitively(image_root):
    assert camera_files.slots_with_frames("cam-03") == {1}


def test_slots_with_frames_agrees_with_list_slot_frames(image_root):
    """The cheap check and the full listing must never disagree — a slot shown
    as having frames that then renders an empty strip is worse than either."""
    for slot in range(camera_files.MIN_SLOT, camera_files.MAX_SLOT + 1):
        cheap = slot in camera_files.slots_with_frames("CAM-03")
        full = bool(camera_files.list_slot_frames("CAM-03", slot))
        assert cheap == full, f"slot {slot} disagrees"


def test_slots_with_frames_ignores_directories_that_are_not_slots(image_root):
    """Anything the router could not turn back into a `defect_N` path must be
    skipped, or the rail offers a chip whose film strip is always empty.

    `defect_01` is the subtle one: it reads as slot 1, but _slot_dir only ever
    builds `defect_1`, so honouring it would make the cheap check and the full
    listing disagree.
    """
    for name in (f"defect_{camera_files.MAX_SLOT + 1}", "defect_01", "scratch"):
        (ng_day(image_root) / name).mkdir()
        (ng_day(image_root) / name / "x.png").write_bytes(PNG)
    assert camera_files.slots_with_frames("CAM-03") == {1}


def test_slots_with_frames_reaches_past_the_original_five(image_root):
    """The ceiling moved with defect_array's length; a camera declaring more
    than five defect types must still be able to show their pictures."""
    (ng_day(image_root) / "defect_9").mkdir()
    (ng_day(image_root) / "defect_9" / "x.png").write_bytes(PNG)
    assert 9 in camera_files.slots_with_frames("CAM-03")
    assert [f.index for f in camera_files.list_slot_frames("CAM-03", 9)] == [0]


def test_slots_with_frames_is_empty_without_a_root(monkeypatch):
    monkeypatch.setattr(camera_files.config, "CAMERA_IMAGE_ROOT", "")
    assert camera_files.slots_with_frames("CAM-03") == set()


def test_slots_with_frames_is_empty_for_an_unknown_camera(image_root):
    assert camera_files.slots_with_frames("CAM-99") == set()


@pytest.mark.parametrize("code", ["../../etc", "C:\\Windows", "NUL", ""])
def test_slots_with_frames_refuses_a_hostile_code(image_root, code):
    """The fast path takes the same segments as the slow one, so it has to
    enforce the same containment — an optimisation that skipped the check
    would be a hole behind a route that is polled continuously."""
    assert camera_files.slots_with_frames(code) == set()


# --- reading -------------------------------------------------------------------

def test_index_past_the_end_is_not_found(image_root):
    with pytest.raises(FrameNotFound):
        camera_files.read_frame("CAM-03", 1, 3)


@pytest.mark.parametrize("index", [-1, True])
def test_negative_and_bool_indexes_are_refused(image_root, index):
    with pytest.raises(FrameNotFound):
        camera_files.read_frame("CAM-03", 1, index)


def test_oversized_frame_is_refused_without_being_read(image_root):
    big = ng_day(image_root) / "defect_1" / "huge.png"
    big.write_bytes(PNG + b"\x00" * (camera_files.MAX_FRAME_BYTES + 1))
    os.utime(big, (2_000_000_000, 2_000_000_000))  # newest, so index 0
    with pytest.raises(FrameNotFound):
        camera_files.read_frame("CAM-03", 1, 0)


def test_read_returns_bytes_so_the_caller_can_sniff_them(image_root):
    """A .png holding SVG markup must be catchable. camera_files returns bytes
    rather than a path precisely so cameras.py can check the magic bytes — a
    FileResponse would have streamed this to the browser on the strength of its
    extension alone."""
    liar = ng_day(image_root) / "defect_1" / "liar.png"
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
    """The DB-controlled leg. `cameras.code` is admin-supplied text that ends up
    in a filesystem path, so it is a traversal primitive unless something stops
    it — CameraIn's pattern is the first layer, this is the one that counts."""
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
    secret = tmp_path / "secret" / "NG" / DAY / "defect_1"
    secret.mkdir(parents=True)
    (secret / "loot.png").write_bytes(PNG)
    (root / "cam-03").symlink_to(tmp_path / "secret", target_is_directory=True)

    monkeypatch.setattr(camera_files.config, "CAMERA_IMAGE_ROOT", str(root))
    assert camera_files.list_slot_frames("CAM-03", 1) == []


def test_a_symlinked_date_folder_cannot_escape_the_root(tmp_path, monkeypatch):
    """The date level is chosen from a scandir rather than from caller segments,
    so it does not pass through _resolve_within. _contained is what re-checks it,
    and this is the case that would be silently open without it."""
    if not _can_symlink(tmp_path):
        pytest.skip("this host cannot create symlinks (Windows without Developer Mode)")

    root = tmp_path / "root"
    (root / "cam-03" / "NG").mkdir(parents=True)
    secret = tmp_path / "secret" / "defect_1"
    secret.mkdir(parents=True)
    (secret / "loot.png").write_bytes(PNG)
    (root / "cam-03" / "NG" / DAY).symlink_to(tmp_path / "secret", target_is_directory=True)

    monkeypatch.setattr(camera_files.config, "CAMERA_IMAGE_ROOT", str(root))
    assert camera_files.list_slot_frames("CAM-03", 1) == []
    assert camera_files.slots_with_frames("CAM-03") == set()
