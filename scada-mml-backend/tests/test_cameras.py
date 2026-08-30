"""Tests for the vision-inspection feature, split across the three modules it
now lives in.

The split follows the code. Frame bytes are a filesystem concern and live in
``cameras.py``; camera identity and defect counters are *plant* data reached
through a mimic's ``doc.cameraDefect`` binding and live in ``db.py`` +
``mimic.py``. Nothing here touches an app-database ``cameras`` table, because
there no longer is one to touch.

Three styles, deliberately:

* Format sniffing is pure and is tested against real magic bytes.
* The SQL adapters are tested against a real table built on the app connection
  with ``datasource_id=None`` — the binding is the point, so it has to be run
  against something that actually has those columns.
* The router is tested with ``db`` monkeypatched, the same way
  test_production_log.py does it, because what is being checked there is slot
  assembly and error mapping, not SQL.
"""
import struct
from datetime import datetime

import psycopg
import pytest
from fastapi import HTTPException
from psycopg import sql

import cameras
import db
import mimic

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 24
WEBP = b"RIFF" + struct.pack("<I", 32) + b"WEBP" + b"\x00" * 20
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>'

USER = {"id": 2, "username": "operator", "role": "operator"}

CODE = "CAM-03"


# --- format sniffing ---------------------------------------------------------

@pytest.mark.parametrize(
    "data,expected",
    [
        (PNG, "image/png"),
        (JPEG, "image/jpeg"),
        (WEBP, "image/webp"),
    ],
)
def test_sniff_recognises_allowed_formats(data, expected):
    assert cameras._sniff_mime(data) == expected


def test_sniff_rejects_svg():
    """Unlike mimic assets, a camera frame is never SVG — the allowlist here
    is deliberately narrower and must not accept it."""
    assert cameras._sniff_mime(SVG) is None
    assert "image/svg+xml" not in cameras.ALLOWED_FRAME_MIMES


def test_image_headers_have_no_inline_style_exception():
    """Camera frames are always a raster format, so unlike mimic's asset
    headers there is no need for the SVG inline-style CSP carve-out."""
    csp = cameras._FILE_IMAGE_HEADERS["Content-Security-Policy"]
    assert "sandbox" in csp
    assert "default-src 'none'" in csp
    assert cameras._FILE_IMAGE_HEADERS["X-Content-Type-Options"] == "nosniff"


def test_frames_are_revalidated_rather_than_pinned():
    """The vision system replaces files in place, so a long max-age would leave
    a superseded frame on screen with no way to notice."""
    cache = cameras._FILE_IMAGE_HEADERS["Cache-Control"]
    assert "must-revalidate" in cache
    assert "private" in cache


# --- the code pattern --------------------------------------------------------
# A camera code reaches the filesystem, so the route pattern is the first of two
# layers. camera_files enforces the second; this one exists so a hostile code
# never gets as far as a syscall.

@pytest.mark.parametrize(
    "code",
    [
        "../../etc", "..\\..\\Windows", "C:\\Windows", "/etc/passwd",
        "cam-03/../..", "cam 03", ".hidden", "cam:03", "", "\uff0f",
    ],
)
def test_route_code_pattern_refuses_a_hostile_code(code):
    import re
    assert re.fullmatch(cameras.CODE_PATTERN, code) is None


@pytest.mark.parametrize("code", ["CAM-03", "cam-03", "cam_03", "CAM.03", "0"])
def test_route_code_pattern_accepts_a_real_code(code):
    import re
    assert re.fullmatch(cameras.CODE_PATTERN, code) is not None


# --- frame routes ------------------------------------------------------------
# Keyed by code, not by a row id: a code is what the vision system writes into
# its folder names, while a row id is a per-database serial that collides the
# moment these tables live in more than one plant.

@pytest.mark.parametrize("slot", [0, -1, 33, 99])
def test_frame_routes_refuse_an_out_of_range_slot(slot):
    with pytest.raises(HTTPException) as e:
        cameras.list_slot_frames(CODE, slot, _user=USER)
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        cameras.get_slot_frame_image(CODE, slot, 0, _user=USER)
    assert e.value.status_code == 400


def test_frames_are_empty_when_no_image_root_is_configured(monkeypatch):
    """The panel must survive an install with no image share — an empty contact
    sheet, not a 500 that takes the whole rail with it."""
    monkeypatch.setattr(cameras.camera_files.config, "CAMERA_IMAGE_ROOT", "")
    assert cameras.list_slot_frames(CODE, 1, _user=USER) == []
    with pytest.raises(HTTPException) as e:
        cameras.get_slot_frame_image(CODE, 1, 0, _user=USER)
    assert e.value.status_code == 404


def test_an_unknown_code_lists_nothing_rather_than_404ing(monkeypatch):
    """The listing route does not consult the binding first: that would put a
    plant round trip in front of a polled path to reject a code that resolves to
    no folder anyway."""
    monkeypatch.setattr(cameras.camera_files.config, "CAMERA_IMAGE_ROOT", "")
    assert cameras.list_slot_frames("CAM-NOPE", 1, _user=USER) == []


def test_a_frame_that_is_not_really_an_image_is_refused(monkeypatch, tmp_path):
    """A .png holding SVG markup reaches the router as bytes precisely so this
    check can happen. Serving it would put attacker-authored markup on the app's
    own origin."""
    slot_dir = tmp_path / "cam-03" / "NG" / "defect_1"
    slot_dir.mkdir(parents=True)
    (slot_dir / "liar.png").write_bytes(SVG)
    monkeypatch.setattr(
        cameras.camera_files.config, "CAMERA_IMAGE_ROOT", str(tmp_path)
    )

    with pytest.raises(HTTPException) as e:
        cameras.get_slot_frame_image(CODE, 1, 0, _user=USER)
    assert e.value.status_code == 400
    assert "PNG, JPEG or WebP" in e.value.detail


def test_a_real_frame_is_served_with_an_etag(monkeypatch, tmp_path):
    slot_dir = tmp_path / "cam-03" / "NG" / "defect_1"
    slot_dir.mkdir(parents=True)
    (slot_dir / "Screenshot 2025-05-07 111525.png").write_bytes(PNG)
    monkeypatch.setattr(
        cameras.camera_files.config, "CAMERA_IMAGE_ROOT", str(tmp_path)
    )

    response = cameras.get_slot_frame_image(CODE, 1, 0, _user=USER)

    assert response.media_type == "image/png"
    assert response.body == PNG
    # mtime is in the key, so a file replaced in place gets a new one.
    assert response.headers["etag"].startswith('"')
    frames = cameras.list_slot_frames(CODE, 1, limit=30, _user=USER)
    assert f"{frames[0].mtime_ns:x}" in response.headers["etag"]


# --- the SQL adapters --------------------------------------------------------
# Run against real tables so the binding is exercised end to end. `datasource_id
# is None` means the app connection, which is also the case that proves the
# denylist is now scoped: `camera_defect` used to be refused by name in every
# database, and a site keeping its cameras in `vision_line9` could not bind them.

def _defect_binding(table, registry=None, **overrides):
    value = {
        "datasource_id": None,
        "table": table,
        "camera_col": "camera_id",
        "batch_col": "batch_id",
        "ts_col": "updated_at",
        "defect_cols": [f"defect_{i}" for i in range(1, 6)],
        "registry": registry,
    }
    value.update(overrides)
    return value


@pytest.fixture
def defect_table():
    """A stand-in for `vision_line9.camera_defect`, dropped afterwards.

    Raw SQL because nothing in this application writes these rows in production
    either — the vision system does, into a schema it owns.
    """
    table = f"camera_defect_test_{id(object())}"
    ident = sql.Identifier(table)
    cols = ", ".join(f"defect_{i} integer" for i in range(1, 6))
    with db.get_connection() as conn:
        conn.execute(sql.SQL(
            "CREATE TABLE {} (camera_id text, batch_id bigint, "
            "updated_at timestamp, " + cols + ")"
        ).format(ident))
        conn.commit()
    try:
        yield table
    finally:
        with db.get_connection() as conn:
            conn.execute(sql.SQL("DROP TABLE {}").format(ident))
            conn.commit()


@pytest.fixture
def registry_table():
    table = f"cameras_test_{id(object())}"
    ident = sql.Identifier(table)
    labels = ", ".join(f"defect_{i}_label text" for i in range(1, 6))
    with db.get_connection() as conn:
        conn.execute(sql.SQL(
            "CREATE TABLE {} (code text PRIMARY KEY, name text, "
            "station_label text, " + labels + ")"
        ).format(ident))
        conn.commit()
    try:
        yield table
    finally:
        with db.get_connection() as conn:
            conn.execute(sql.SQL("DROP TABLE {}").format(ident))
            conn.commit()


def _registry_binding(table):
    return {
        "table": table,
        "code_col": "code",
        "name_col": "name",
        "station_col": "station_label",
        "label_cols": [f"defect_{i}_label" for i in range(1, 6)],
    }


def _defect_row(table, code, batch_id, counts, updated_at="now()"):
    cols = ", ".join(f"defect_{i}" for i in range(1, 6))
    placeholders = ", ".join(["%s"] * len(counts))
    with db.get_connection() as conn:
        conn.execute(sql.SQL(
            "INSERT INTO {} (camera_id, batch_id, updated_at, " + cols + ") "
            "VALUES (%s, %s, " + updated_at + ", " + placeholders + ")"
        ).format(sql.Identifier(table)), (code, batch_id, *counts))
        conn.commit()


def test_defect_latest_returns_none_when_nothing_was_ever_recorded(defect_table):
    """None is not "a batch of zeros" — the rail shows the two differently,
    because "nothing reported yet" and "nothing wrong" are different answers."""
    assert db.camera_defect_latest(_defect_binding(defect_table), CODE) is None


def test_defect_latest_picks_the_highest_batch(defect_table):
    _defect_row(defect_table, CODE, 7, (1, 0, 0, 0, 0))
    _defect_row(defect_table, CODE, 9, (4, 2, 0, 0, 0))
    _defect_row(defect_table, CODE, 8, (9, 9, 9, 9, 9))

    row = db.camera_defect_latest(_defect_binding(defect_table), CODE)

    assert row["batch_id"] == 9
    assert row["counts"] == [4, 2, 0, 0, 0]


def test_defect_latest_still_answers_when_every_batch_id_is_null(defect_table):
    """`WHERE batch_id = (SELECT max(batch_id) ...)` returns nothing here,
    because max() over all-NULL is NULL and `= NULL` matches no row. A camera
    whose feed never sets a batch would silently show an empty panel."""
    _defect_row(defect_table, CODE, None, (3, 0, 0, 0, 0))

    row = db.camera_defect_latest(_defect_binding(defect_table), CODE)

    assert row is not None
    assert row["batch_id"] is None
    assert row["counts"][0] == 3


def test_defect_latest_matches_the_code_case_insensitively(defect_table):
    """The code is typed into a mimic symbol by one person and into the vision
    system's configuration by another."""
    _defect_row(defect_table, CODE.lower(), 1, (5, 0, 0, 0, 0))
    row = db.camera_defect_latest(_defect_binding(defect_table), CODE.upper())
    assert row is not None


def test_defect_latest_does_not_leak_another_cameras_batch(defect_table):
    """The bug the ORDER BY form exists to avoid: CAM-04's rows all predate
    CAM-03's latest batch, and the max() subquery form would return nothing."""
    _defect_row(defect_table, CODE, 90, (1, 0, 0, 0, 0))
    _defect_row(defect_table, "CAM-04", 12, (6, 0, 0, 0, 0))

    row = db.camera_defect_latest(_defect_binding(defect_table), "CAM-04")

    assert row["batch_id"] == 12
    assert row["counts"][0] == 6


def test_defect_latest_projects_only_the_bound_columns(defect_table):
    """Slot N is `defect_cols[N-1]`, not `defect_N`. A line grading two
    categories out of the table's five binds two, and gets two."""
    _defect_row(defect_table, CODE, 1, (1, 2, 3, 4, 5))

    row = db.camera_defect_latest(
        _defect_binding(defect_table, defect_cols=["defect_3", "defect_1"]), CODE
    )

    assert row["counts"] == [3, 1]


def test_registry_falls_back_to_distinct_codes_without_a_registry_table(defect_table):
    """What makes a new line usable the moment its defect table is bound. Naming
    the cameras is a separate, later job; requiring it first would mean an
    operator sees nothing at all until an admin has filled in a second form."""
    _defect_row(defect_table, "CAM-04", 1, (0, 0, 0, 0, 0))
    _defect_row(defect_table, CODE, 1, (0, 0, 0, 0, 0))
    _defect_row(defect_table, CODE, 2, (0, 0, 0, 0, 0))

    found = db.camera_registry(_defect_binding(defect_table))

    assert [c["code"] for c in found] == ["CAM-03", "CAM-04"]
    assert all(c["name"] is None and c["labels"] == [] for c in found)


def test_registry_reads_names_and_labels_when_one_is_bound(defect_table, registry_table):
    with db.get_connection() as conn:
        conn.execute(sql.SQL(
            "INSERT INTO {} (code, name, station_label, defect_1_label, defect_2_label) "
            "VALUES (%s, %s, %s, %s, %s)"
        ).format(sql.Identifier(registry_table)),
            (CODE, "Wrapper cam", "Test station", "ระดับต่ำกว่าพิกัด", "ระดับสูงกว่าพิกัด"))
        conn.commit()

    binding = _defect_binding(defect_table, registry=_registry_binding(registry_table))
    found = db.camera_registry(binding)

    assert len(found) == 1
    assert found[0]["code"] == CODE
    assert found[0]["name"] == "Wrapper cam"
    assert found[0]["station"] == "Test station"
    assert found[0]["labels"][:2] == ["ระดับต่ำกว่าพิกัด", "ระดับสูงกว่าพิกัด"]
    assert found[0]["labels"][2:] == [None, None, None]


def test_registry_aliases_labels_positionally_not_by_name(defect_table, registry_table):
    """Two sites name these columns differently. Positional aliases are what let
    `defect_1_label` and `scratch_name` come back in the same shape — and stop
    either colliding with `code` or `name`."""
    with db.get_connection() as conn:
        conn.execute(sql.SQL(
            "INSERT INTO {} (code, name, defect_3_label) VALUES (%s, %s, %s)"
        ).format(sql.Identifier(registry_table)), (CODE, "Cam", "ฟองอากาศ"))
        conn.commit()

    binding = _defect_binding(defect_table, registry={
        "table": registry_table,
        "code_col": "code",
        "label_cols": ["defect_3_label"],
    })
    found = db.camera_registry(binding)

    assert found[0]["labels"] == ["ฟองอากาศ"]
    assert found[0]["station"] is None


def test_camera_tables_are_bindable_on_a_plant_connection():
    """The regression this whole change turns on. The denylist used to match on
    the bare table name in every database, so a plant table that happened to
    share a name with an app table was unreachable — and `cameras` was one."""
    assert "cameras" not in db._sensitive_tables(app_db=False)
    assert "camera_defect" not in db._sensitive_tables(app_db=False)
    # Still refused on a plant connection: these would hold credentials in any
    # database, and a plant historian with a `users` table is a plausible enough
    # accident to keep guarding against.
    assert "users" in db._sensitive_tables(app_db=False)
    assert "datasources" in db._sensitive_tables(app_db=False)


# --- the mimic router --------------------------------------------------------

def _layout(binding):
    return {
        "slug": "line-9",
        "name": "Line 9",
        "doc": {"version": 3, "nodes": [], "edges": [], "cameraDefect": binding},
        "updated_at": datetime(2026, 8, 28, 8, 0),
    }


def _wire(monkeypatch, *, latest, registry, binding=None, with_frames=frozenset()):
    binding = binding or _defect_binding("camera_defect")
    monkeypatch.setattr(db, "get_mimic_layout", lambda slug: _layout(binding))
    monkeypatch.setattr(db, "datasource_names", lambda ids: {4: "Plant 4"})
    monkeypatch.setattr(db, "camera_defect_latest", lambda *a, **k: latest)
    monkeypatch.setattr(db, "camera_registry", lambda *a, **k: registry)
    monkeypatch.setattr(
        mimic.camera_files, "slots_with_frames", lambda code, n: set(with_frames)
    )


def _entry(code=CODE, labels=()):
    return {"code": code, "name": "Wrapper cam", "station": None, "labels": list(labels)}


def test_defects_endpoint_labels_slots_and_totals_the_batch(monkeypatch):
    _wire(
        monkeypatch,
        latest={"batch_id": 12, "updated_at": None, "counts": [15, 6, 0, 0, 0]},
        registry=[_entry(labels=["ระดับต่ำกว่าพิกัด", "ระดับสูงกว่าพิกัด"])],
    )

    body = mimic.layout_camera_defects("line-9", CODE, USER, [4])

    assert body["batch_id"] == 12
    assert body["total"] == 21
    by_slot = {s["slot"]: s for s in body["slots"]}
    assert by_slot[1]["label"] == "ระดับต่ำกว่าพิกัด"
    assert by_slot[1]["count"] == 15
    assert by_slot[2]["count"] == 6
    assert mimic.CameraDefectOut(**body).total == 21


def test_defects_endpoint_omits_slots_that_are_unnamed_empty_and_frameless(monkeypatch):
    """A binding may declare more categories than a given line actually grades.
    An unnamed zero bar with no frames behind it tells an operator nothing."""
    _wire(
        monkeypatch,
        latest={"batch_id": 1, "updated_at": None, "counts": [4, 0, 0, 0, 0]},
        registry=[_entry()],
    )

    body = mimic.layout_camera_defects("line-9", CODE, USER, [4])

    assert [s["slot"] for s in body["slots"]] == [1]


def test_defects_endpoint_keeps_a_named_slot_that_counted_zero(monkeypatch):
    """A named slot is a defect this camera is known to look for. Reporting zero
    of it is a real answer, unlike an anonymous empty slot."""
    _wire(
        monkeypatch,
        latest={"batch_id": 1, "updated_at": None, "counts": [2, 0, 0, 0, 0]},
        registry=[_entry(labels=[None, None, "ฟองอากาศ"])],
    )

    body = mimic.layout_camera_defects("line-9", CODE, USER, [4])

    by_slot = {s["slot"]: s for s in body["slots"]}
    assert by_slot[3]["count"] == 0
    assert by_slot[3]["label"] == "ฟองอากาศ"


def test_defects_endpoint_keeps_an_empty_slot_that_has_frames(monkeypatch):
    """Frames on disk with a zero counter is exactly the state an operator wants
    to look at, so the slot has to survive the omission rule."""
    _wire(
        monkeypatch,
        latest={"batch_id": 1, "updated_at": None, "counts": [0, 0, 0, 0, 0]},
        registry=[_entry()],
        with_frames={4},
    )

    body = mimic.layout_camera_defects("line-9", CODE, USER, [4])

    assert [s["slot"] for s in body["slots"]] == [4]
    assert body["slots"][0]["has_frames"] is True
    assert body["total"] == 0


def test_defects_endpoint_reports_no_batch_without_inventing_zeros(monkeypatch):
    """A camera in the registry that the vision system has never written a row
    for. `batch_id: None` is what the rail renders as "no data yet"."""
    _wire(monkeypatch, latest=None, registry=[_entry(labels=["ฟองอากาศ"])])

    body = mimic.layout_camera_defects("line-9", CODE, USER, [4])

    assert body["batch_id"] is None
    assert body["total"] == 0
    assert body["slots"][0]["count"] == 0


def test_defects_endpoint_serves_slots_beyond_the_old_five(monkeypatch):
    """The cap this change removed. A line grading six categories used to have
    to drop the sixth on the floor or merge it into another."""
    binding = _defect_binding(
        "camera_defect", defect_cols=[f"defect_{i}" for i in range(1, 9)]
    )
    _wire(
        monkeypatch,
        latest={"batch_id": 3, "updated_at": None, "counts": [0] * 7 + [11]},
        registry=[_entry()],
        binding=binding,
    )

    body = mimic.layout_camera_defects("line-9", CODE, USER, [4])

    assert [s["slot"] for s in body["slots"]] == [8]
    assert body["total"] == 11


def test_defects_endpoint_404s_for_a_code_the_binding_cannot_reach(monkeypatch):
    _wire(monkeypatch, latest=None, registry=[])

    with pytest.raises(HTTPException) as e:
        mimic.layout_camera_defects("line-9", "CAM-NOPE", USER, [4])

    assert e.value.status_code == 404
    assert "not reachable" in e.value.detail


def test_defects_endpoint_answers_an_unregistered_code_that_has_rows(monkeypatch):
    """Codes recovered from the defect table are the fallback registry, but a
    row that appeared since the last listing must still resolve."""
    _wire(
        monkeypatch,
        latest={"batch_id": 4, "updated_at": None, "counts": [7, 0, 0, 0, 0]},
        registry=[],
    )

    body = mimic.layout_camera_defects("line-9", CODE, USER, [4])

    assert body["code"] == CODE
    assert body["total"] == 7


def test_unconfigured_mimic_reports_a_clear_not_found(monkeypatch):
    """Existing layouts have no binding until an admin sets one — the app cannot
    know which datasource holds a given line's vision schema."""
    monkeypatch.setattr(db, "get_mimic_layout", lambda slug: _layout(None))

    for call in (
        lambda: mimic.list_layout_cameras("line-9", USER, [4]),
        lambda: mimic.layout_camera_defects("line-9", CODE, USER, [4]),
    ):
        with pytest.raises(HTTPException) as e:
            call()
        assert e.value.status_code == 404
        assert "not configured" in e.value.detail


def test_missing_mimic_is_a_different_404_from_an_unconfigured_one(monkeypatch):
    monkeypatch.setattr(db, "get_mimic_layout", lambda slug: None)
    with pytest.raises(HTTPException) as e:
        mimic.layout_camera_defects("nope", CODE, USER, [4])
    assert e.value.status_code == 404
    assert "layout not found" in e.value.detail


def test_dead_source_returns_an_error_instead_of_an_empty_rail(monkeypatch):
    """An unreachable plant must not look like a camera with nothing to report."""
    monkeypatch.setattr(db, "get_mimic_layout", lambda slug: _layout(_defect_binding("camera_defect")))
    monkeypatch.setattr(db, "datasource_names", lambda ids: {4: "Plant 4"})
    monkeypatch.setattr(db, "camera_registry", lambda *a, **k: (_ for _ in ()).throw(
        psycopg.OperationalError("timeout")
    ))
    monkeypatch.setattr(db, "camera_defect_latest", lambda *a, **k: None)

    for call in (
        lambda: mimic.list_layout_cameras("line-9", USER, [4]),
        lambda: mimic.layout_camera_defects("line-9", CODE, USER, [4]),
    ):
        with pytest.raises(HTTPException) as e:
            call()
        assert e.value.status_code == 503
        assert "timeout" in e.value.detail


def test_stored_source_never_overrides_the_header_primary(monkeypatch):
    """Same rule as the production log, and the reason a layout stays portable
    between lines: the binding's datasource_id is editor context, not a redirect
    of an operator's read to another plant."""
    seen = {}
    binding = _defect_binding("camera_defect", datasource_id=9)
    monkeypatch.setattr(db, "get_mimic_layout", lambda slug: _layout(binding))
    monkeypatch.setattr(db, "datasource_names", lambda ids: {4: "Plant 4"})
    monkeypatch.setattr(db, "camera_registry", lambda b, datasource_id=None: (
        seen.update(datasource_id=datasource_id) or [_entry()]
    ))

    mimic.list_layout_cameras("line-9", USER, [4, 9])

    assert seen["datasource_id"] == 4


# --- binding validation ------------------------------------------------------

def _describe(**overrides):
    value = {
        "value_columns": [f"defect_{i}" for i in range(1, 6)] + ["batch_id"],
        "text_columns": ["camera_id"],
        "ts_columns": ["updated_at"],
        "datetime_columns": ["updated_at"],
        "filter_columns": ["camera_id", "updated_at", "code", "name", "station_label"]
                          + [f"defect_{i}_label" for i in range(1, 6)],
    }
    value.update(overrides)
    return value


@pytest.fixture
def described(monkeypatch):
    monkeypatch.setattr(db, "describe_table", lambda table, datasource_id: _describe())
    monkeypatch.setattr(db, "get_datasource", lambda datasource_id: {"id": datasource_id})


def _doc(binding):
    return {"nodes": [], "edges": [], "cameraDefect": binding}


def test_validation_requires_numeric_defect_columns(described):
    with pytest.raises(HTTPException) as e:
        mimic._validate(_doc(_defect_binding("camera_defect", defect_cols=["camera_id"])))
    assert "defect_cols must all be numeric columns" in e.value.detail


def test_validation_refuses_a_repeated_defect_column(described):
    """Two slots on one column would draw the same count twice under different
    names, and send both to different frame folders."""
    with pytest.raises(HTTPException) as e:
        mimic._validate(_doc(_defect_binding(
            "camera_defect", defect_cols=["defect_1", "defect_1"]
        )))
    assert "must not repeat" in e.value.detail


def test_validation_requires_a_way_to_identify_the_newest_batch(described):
    """Without either column "the newest batch" is whichever row Postgres hands
    back first, which is not a defect count anyone should act on."""
    with pytest.raises(HTTPException) as e:
        mimic._validate(_doc(_defect_binding(
            "camera_defect", batch_col=None, ts_col=None
        )))
    assert "required to identify the newest batch" in e.value.detail


def test_validation_caps_the_slot_count(described):
    with pytest.raises(HTTPException) as e:
        mimic._validate(_doc(_defect_binding(
            "camera_defect", defect_cols=[f"d{i}" for i in range(mimic.MAX_DEFECT_SLOTS + 1)]
        )))
    assert f"at most {mimic.MAX_DEFECT_SLOTS}" in e.value.detail


def test_validation_accepts_a_registry_code_that_is_a_primary_key(described):
    """`code` is the registry's natural key and is usually its primary key too,
    which describe_table excludes from every *value* list precisely because it
    identifies rather than reports. Checking it against text_columns would have
    made the common case unbindable."""
    mimic._validate(_doc(_defect_binding(
        "camera_defect", registry=_registry_binding("cameras")
    )))


def test_validation_allows_fewer_labels_than_slots(described):
    """Trailing slots fall back to a numbered label, and a null entry is how the
    editor leaves a gap when only some slots are named."""
    mimic._validate(_doc(_defect_binding("camera_defect", registry={
        "table": "cameras",
        "code_col": "code",
        "label_cols": [None, "defect_2_label"],
    })))


def test_validation_refuses_more_labels_than_slots(described):
    with pytest.raises(HTTPException) as e:
        mimic._validate(_doc(_defect_binding(
            "camera_defect",
            defect_cols=["defect_1"],
            registry={
                "table": "cameras",
                "code_col": "code",
                "label_cols": ["defect_1_label", "defect_2_label"],
            },
        )))
    assert "label_cols has 2 entries" in e.value.detail


def test_a_null_binding_is_valid(described):
    """The state every existing layout is in until an admin configures one."""
    mimic._validate(_doc(None))
