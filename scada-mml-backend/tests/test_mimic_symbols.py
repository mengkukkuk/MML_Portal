"""Tests for the custom-symbol half of /api/mimic.

Split across two concerns:

* Format sniffing is pure and needs nothing — it is the guard that stops an SVG
  arriving labelled as a PNG, so it is tested against real magic bytes rather
  than against the ``content_type`` the client claimed.
* Everything else touches Postgres. These use the app's own connection and clean
  up after themselves, because the validation being checked (does this asset
  exist, is this symbol in the library) is *about* database state and a mocked
  version of it would only be testing the mock.
"""
import io
import struct

import pytest
from fastapi import HTTPException

import db
import mimic

# --- fixtures ---------------------------------------------------------------

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 24
WEBP = b"RIFF" + struct.pack("<I", 32) + b"WEBP" + b"\x00" * 20
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>'


@pytest.fixture(scope="module", autouse=True)
def _tables():
    """The endpoints assume main.py's startup hook has run."""
    db.init_mimic_assets_table()
    db.init_mimic_symbols_table()


@pytest.fixture
def asset():
    """One stored asset, removed afterwards along with anything referencing it."""
    row = db.insert_mimic_asset("fixture.png", "image/png", PNG, f"fixture-{id(PNG)}-hash", None)
    yield row
    for name in db.mimic_asset_users(row["id"]):
        for s in db.list_mimic_symbols():
            if s["name"] == name:
                db.delete_mimic_symbol(s["id"])
    db.delete_mimic_asset(row["id"])


def symbol_body(asset_id, **over):
    body = {
        "name": "Fixture symbol",
        "asset_id": asset_id,
        "w": 120,
        "h": 120,
        "ports": {},
        "dynamics": [],
        "binding": "analog",
        "bubble": None,
    }
    body.update(over)
    return mimic.SymbolIn(**body)


# --- format sniffing --------------------------------------------------------

@pytest.mark.parametrize(
    "data,expected",
    [
        (PNG, "image/png"),
        (JPEG, "image/jpeg"),
        (WEBP, "image/webp"),
        (SVG, "image/svg+xml"),
        (b"\xef\xbb\xbf" + SVG, "image/svg+xml"),          # BOM first
        (b"<!-- a comment -->\n" + SVG, "image/svg+xml"),  # comment first
        (b'<?xml version="1.0"?>' + SVG, "image/svg+xml"),  # declaration first
    ],
)
def test_sniff_recognises_allowed_formats(data, expected):
    assert mimic._sniff_mime(data) == expected


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"GIF89a" + b"\x00" * 16,      # a real image, but not one we accept
        b"%PDF-1.7\n",
        b"MZ\x90\x00",                  # a Windows executable
        b"RIFF" + b"\x00" * 4 + b"AVI ",  # RIFF, but not WebP
        b"plain text, no markup",
    ],
)
def test_sniff_rejects_everything_else(data):
    assert mimic._sniff_mime(data) is None


def test_sniff_reads_contents_not_the_extension():
    """The whole point of the check: SVG markup in a .png stays SVG markup."""
    assert mimic._sniff_mime(SVG) == "image/svg+xml"
    assert mimic._sniff_mime(SVG) != "image/png"


def test_asset_headers_sandbox_direct_navigation():
    """An uploaded SVG is reachable by navigating to its URL, where a same-origin
    document could script the app. The sandbox directive is what closes that."""
    csp = mimic._ASSET_HEADERS["Content-Security-Policy"]
    assert "sandbox" in csp
    assert "default-src 'none'" in csp
    assert mimic._ASSET_HEADERS["X-Content-Type-Options"] == "nosniff"


# --- asset storage ----------------------------------------------------------

def test_identical_upload_is_deduplicated(asset):
    """Re-storing the same bytes must find the existing row, not add a second."""
    found = db.find_mimic_asset_by_hash(f"fixture-{id(PNG)}-hash")
    assert found is not None
    assert found["id"] == asset["id"]


def test_delete_is_refused_while_a_symbol_uses_the_asset(asset):
    created = db.insert_mimic_symbol(symbol_body(asset["id"]).model_dump())
    try:
        assert db.mimic_asset_users(asset["id"]) == ["Fixture symbol"]
        with pytest.raises(HTTPException) as e:
            mimic.delete_asset(asset["id"], _admin={"id": 1, "role": "admin"})
        assert "still used by" in e.value.detail
        assert "Fixture symbol" in e.value.detail
    finally:
        db.delete_mimic_symbol(created["id"])

    # With the symbol gone the same delete is allowed.
    assert db.mimic_asset_users(asset["id"]) == []


# --- symbol validation ------------------------------------------------------

def test_symbol_requires_an_existing_asset():
    with pytest.raises(HTTPException) as e:
        mimic._validate_symbol(symbol_body(-999))
    assert "does not exist" in e.value.detail


def test_symbol_rejects_an_unknown_binding(asset):
    with pytest.raises(HTTPException) as e:
        mimic._validate_symbol(symbol_body(asset["id"], binding="telepathy"))
    assert "binding must be one of" in e.value.detail


@pytest.mark.parametrize(
    "ports",
    [
        {"in": [1.4, 0.5]},    # outside the box
        {"in": [-0.1, 0.5]},
        {"in": [0.5]},          # not a pair
        {"in": "left"},
        {"in": [0.5, "mid"]},
        {"in": [True, 0.5]},    # a bool is not a coordinate
    ],
)
def test_symbol_rejects_ports_off_the_box(asset, ports):
    """Ports are fractions of the symbol's own box — that is what lets the edge
    router re-derive wires from geometry. One outside 0..1 puts a pipe end in
    empty space."""
    with pytest.raises(HTTPException):
        mimic._validate_symbol(symbol_body(asset["id"], ports=ports))


def test_symbol_accepts_ports_on_the_boundary(asset):
    fields = mimic._validate_symbol(
        symbol_body(asset["id"], ports={"in": [0, 0.5], "out": [1, 1]})
    )
    assert fields["ports"] == {"in": [0, 0.5], "out": [1, 1]}


def test_symbol_rejects_too_many_ports(asset):
    ports = {f"p{i}": [0.5, 0.5] for i in range(mimic.MAX_SYMBOL_PORTS + 1)}
    with pytest.raises(HTTPException) as e:
        mimic._validate_symbol(symbol_body(asset["id"], ports=ports))
    assert "more than" in e.value.detail


def test_symbol_requires_a_kind_on_every_dynamic(asset):
    with pytest.raises(HTTPException) as e:
        mimic._validate_symbol(symbol_body(asset["id"], dynamics=[{"speed": "fast"}]))
    assert "requires a kind" in e.value.detail


def test_symbol_accepts_a_dynamic_kind_the_backend_does_not_know(asset):
    """Deliberate: the renderer skips a kind it cannot draw, and pinning the
    vocabulary here would mean a frontend growing a new dynamic could not use it
    until the backend was redeployed."""
    fields = mimic._validate_symbol(
        symbol_body(asset["id"], dynamics=[{"kind": "shimmer", "amount": 3}])
    )
    assert fields["dynamics"] == [{"kind": "shimmer", "amount": 3}]


# --- layout validation for custom nodes -------------------------------------

def node(**over):
    n = {"id": "n1", "type": "custom", "x": 0, "y": 0, "w": 10, "h": 10, "symbolId": 1}
    n.update(over)
    return n


def test_layout_rejects_a_custom_node_with_no_symbol_id():
    with pytest.raises(HTTPException) as e:
        mimic._validate({"nodes": [node(symbolId=None)], "edges": []})
    assert "integer symbolId" in e.value.detail


def test_layout_rejects_a_custom_node_pointing_outside_the_library():
    with pytest.raises(HTTPException) as e:
        mimic._validate({"nodes": [node(symbolId=-12345)], "edges": []})
    assert "not in the symbol library" in e.value.detail


def test_layout_accepts_a_custom_node_that_resolves(asset):
    created = db.insert_mimic_symbol(symbol_body(asset["id"]).model_dump())
    try:
        mimic._validate({"nodes": [node(symbolId=created["id"])], "edges": []})
    finally:
        db.delete_mimic_symbol(created["id"])


def test_layout_does_not_read_the_library_for_a_drawing_with_no_custom_nodes(monkeypatch):
    """The library read is skipped entirely when nothing needs it — a boiler
    drawing should not pay for a feature it does not use."""
    def boom():
        raise AssertionError("list_mimic_symbols should not have been called")

    monkeypatch.setattr(db, "list_mimic_symbols", boom)
    mimic._validate({"nodes": [node(type="pump", symbolId=None)], "edges": []})


def test_every_dcim_type_is_allowlisted():
    """The frontend registry and this allowlist have to be deployed in step; this
    is the half that can be checked from here."""
    for t in ("ats", "generator", "ups", "pdu", "rack", "crah", "coldaisle", "custom"):
        assert t in mimic.VALID_NODE_TYPES


def test_symbol_rejects_a_dynamic_map_pointing_at_a_missing_asset(asset):
    """A `swap` map names asset ids. A dangling one draws a symbol with no
    picture and nothing on screen to explain it — the same failure
    `_validate_binding` refuses for a datasource."""
    with pytest.raises(HTTPException) as e:
        mimic._validate_symbol(symbol_body(
            asset["id"], dynamics=[{"kind": "swap", "map": {"run": -4321}}]
        ))
    assert "does not exist" in e.value.detail


@pytest.mark.parametrize("mapping", [{"run": "twelve"}, {"run": None}, {"run": True}, {"run": 1.5}])
def test_symbol_rejects_a_non_id_in_a_dynamic_map(asset, mapping):
    with pytest.raises(HTTPException) as e:
        mimic._validate_symbol(symbol_body(
            asset["id"], dynamics=[{"kind": "swap", "map": mapping}]
        ))
    assert "must be an asset id" in e.value.detail


def test_symbol_rejects_a_non_object_dynamic_map(asset):
    with pytest.raises(HTTPException) as e:
        mimic._validate_symbol(symbol_body(
            asset["id"], dynamics=[{"kind": "swap", "map": ["a", "b"]}]
        ))
    assert "map must be an object" in e.value.detail


def test_symbol_accepts_a_dynamic_map_of_real_assets(asset):
    fields = mimic._validate_symbol(symbol_body(
        asset["id"], dynamics=[{"kind": "swap", "map": {"run": asset["id"], "stop": asset["id"]}}]
    ))
    assert fields["dynamics"][0]["map"]["run"] == asset["id"]


def test_map_validation_is_kind_agnostic(asset):
    """Checked by shape, not by kind — so a dynamic this backend has never heard
    of still has its pointers validated, without the backend owning the
    vocabulary."""
    with pytest.raises(HTTPException) as e:
        mimic._validate_symbol(symbol_body(
            asset["id"], dynamics=[{"kind": "some-future-dynamic", "map": {"x": -99}}]
        ))
    assert "does not exist" in e.value.detail
