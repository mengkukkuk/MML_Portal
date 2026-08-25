"""Mimic-layout endpoints for the /monitor single-plant drawing.

One row per plant (``mimic_layouts``). Reads are open to any authenticated
user — a commissioned drawing is the same for every operator — while writes
require an admin token, exactly like the Live dashboard's panels.

The whole layout document is stored and returned as one JSONB blob. Its
geometry (nodes, edges, ports) is opaque to the server, but every node's
``binding`` is validated here: an admin cannot save a drawing that points at a
datasource that does not exist, or at a column that is not on the table. That
check is what keeps a saved layout from silently rendering "no data" for every
operator afterwards.
"""
import hashlib
import re
from datetime import datetime
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field

import db
from auth import get_current_user, require_admin
from licensing import require_entitlement, require_valid_license

router = APIRouter(
    prefix="/api/mimic",
    tags=["mimic"],
    dependencies=[Depends(require_valid_license)],
)

# Guard rails on the document. A mimic is one plant on one screen; anything
# past this is a runaway client, not a drawing someone made.
MAX_NODES = 256
MAX_EDGES = 512

# Slugs are the drawing's identity in the URL and are unique in the table, so
# pin the shape rather than letting arbitrary text create a row per typo.
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# Symbol types the frontend registry (src/components/mimic/symbols/index.js)
# can render. A node whose type is unknown would draw as a hole in the mimic,
# so reject it at save time rather than storing an unrenderable document.
#
# Grouped by the registry's own categories so the two lists stay diffable.
# This set must be deployed *before* a frontend that can draw new types,
# otherwise an admin saves a layout the server rejects. It is also safe for it
# to run ahead of the frontend: a type nobody can draw is simply never saved.
VALID_NODE_TYPES = {
    # process
    "tank",
    "pump",
    "valve",
    "motor",
    "heatexchanger",
    "flowmeter",
    "gauge",
    "pipetee",
    "conveyor",
    "stacklight",
    "sensoreye",
    "actuator",
    # electrical
    "busbar",
    "breaker",
    "disconnector",
    "transformer",
    "mccstarter",
    "vfd",
    "capbank",
    # automation
    "plc",
    "remoteio",
    "networkswitch",
    "hmipanel",
    "controlloop",
    "safetyrelay",
    "edgegateway",
    # vision inspection
    "ipcamera",
    "lighting",
    "pcbased",
    # water treatment
    "clarifier",
    "sandfilter",
    "dosingpump",
    "uvreactor",
    "membrane",
    "blower",
    "weir",
    # cigarette production line
    "tobaccofeed",
    "rodmaker",
    "tipper",
    "packer",
    "cellophaner",
    "cartoner",
    "rejectstation",
    # data centre infrastructure (power chain, then cooling)
    "ats",
    "generator",
    "ups",
    "pdu",
    "rack",
    "crah",
    "coldaisle",
    # An admin-authored symbol from an uploaded image. One type covers the whole
    # custom library: which picture it draws and how it moves live in
    # `mimic_symbols`, referenced by the node's `symbolId`. That is what keeps
    # this allowlist finite — without it, every upload would need a redeploy
    # before a drawing could use it.
    "custom",
}

# How a binding turns a number into a run/stop state.
VALID_STATE_MODES = {"threshold", "map"}


# --- Schemas ---------------------------------------------------------------
class MimicSummary(BaseModel):
    slug: str
    name: str
    updated_at: datetime


class MimicOut(BaseModel):
    slug: str
    name: str
    doc: dict = {}
    updated_at: datetime


class MimicIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    doc: dict = {}
    # Optional for backwards compatibility. ``model_fields_set`` below keeps
    # an omitted value distinct from an explicit null used for a new layout.
    base_updated_at: datetime | None = None


# --- Validation ------------------------------------------------------------
def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def _describe_cached(
    cache: dict[tuple[int | None, str], dict[str, list[str]]],
    table: str,
    datasource_id: int | None,
) -> dict[str, list[str]]:
    """``db.describe_table`` memoised for the lifetime of one request.

    Every miss opens a fresh libpq connection (``db._table_source_conn``, which
    uses ``connect_timeout=5``), so an unmemoised 30-symbol save would mean 30
    handshakes to an external historian — and 150 seconds of them if that host
    is down. Symbols on a mimic overwhelmingly share a handful of tables, so a
    per-request cache collapses that to one connection per (connection, table).
    """
    key = (datasource_id, table)
    if key not in cache:
        cache[key] = db.describe_table(table, datasource_id)
    return cache[key]


def _validate_binding(
    binding: dict[str, Any],
    where: str,
    cache: dict[tuple[int | None, str], dict[str, list[str]]],
) -> None:
    """Confirm one node's binding points at something that actually exists."""
    ds_id = binding.get("datasource_id")
    if ds_id is not None:
        if not isinstance(ds_id, int):
            raise _bad(f"{where}: datasource_id must be an integer or null")
        if db.get_datasource(ds_id) is None:
            raise _bad(f"{where}: datasource_id {ds_id} does not exist")

    table = binding.get("table")
    if not table or not isinstance(table, str):
        raise _bad(f"{where}: binding requires a table")

    value_col = binding.get("value_col")
    if not value_col or not isinstance(value_col, str):
        raise _bad(f"{where}: binding requires a value_col")

    try:
        cols = _describe_cached(cache, table, ds_id)
    except ValueError:
        raise _bad(f"{where}: table not allowed: {table!r}")
    except psycopg.Error as e:
        first = str(e).strip().splitlines()[0] if str(e).strip() else "connection error"
        raise _bad(f"{where}: could not reach the selected connection: {first}")

    if value_col not in cols["value_columns"]:
        raise _bad(f"{where}: value_col must be a numeric column of {table!r}")

    ts_col = binding.get("ts_col")
    if ts_col and ts_col not in cols["ts_columns"]:
        raise _bad(f"{where}: ts_col must be a timestamp column of {table!r}")

    filter_col = binding.get("filter_col")
    if filter_col and filter_col not in cols["filter_columns"]:
        raise _bad(f"{where}: filter_col must be a column of {table!r}")

    # Without a timestamp column the latest-row query is a bare LIMIT 1 with no
    # ORDER BY (db.table_latest), so an unfiltered binding would read whichever
    # row Postgres happened to hand back. Live tolerates that because it charts
    # many series at once; one symbol is one device and must be pinned.
    if not ts_col and not filter_col:
        raise _bad(
            f"{where}: a table with no timestamp column needs a filter column "
            "and value to identify one device"
        )

    st = binding.get("state")
    if st is not None:
        if not isinstance(st, dict):
            raise _bad(f"{where}: binding.state must be an object or null")
        mode = st.get("mode")
        if mode not in VALID_STATE_MODES:
            raise _bad(
                f"{where}: binding.state.mode must be one of: "
                f"{', '.join(sorted(VALID_STATE_MODES))}"
            )


def _validate(doc: dict) -> None:
    """Reject a document that could not be rendered or could not be polled."""
    nodes = doc.get("nodes")
    edges = doc.get("edges", [])
    if not isinstance(nodes, list):
        raise _bad("doc.nodes must be a list")
    if not isinstance(edges, list):
        raise _bad("doc.edges must be a list")
    if len(nodes) > MAX_NODES:
        raise _bad(f"doc.nodes may not exceed {MAX_NODES} symbols")
    if len(edges) > MAX_EDGES:
        raise _bad(f"doc.edges may not exceed {MAX_EDGES} pipes")

    cache: dict[tuple[int | None, str], dict[str, list[str]]] = {}
    seen_ids: set[str] = set()
    # Read once for the whole document rather than per node: a drawing built from
    # a custom palette is mostly custom nodes, and each would otherwise be its
    # own round trip. Empty until the first symbol is authored, which is why it
    # is only touched by the branch that needs it.
    symbol_ids: set[int] = (
        {r["id"] for r in db.list_mimic_symbols()}
        if any(isinstance(n, dict) and n.get("type") == "custom" for n in nodes)
        else set()
    )

    for i, node in enumerate(nodes):
        where = f"doc.nodes[{i}]"
        if not isinstance(node, dict):
            raise _bad(f"{where} must be an object")
        node_id = node.get("id")
        if not node_id or not isinstance(node_id, str):
            raise _bad(f"{where}: id is required")
        if node_id in seen_ids:
            raise _bad(f"{where}: duplicate node id {node_id!r}")
        seen_ids.add(node_id)
        if node.get("type") not in VALID_NODE_TYPES:
            # Naming the offender beats listing forty valid slugs: the client
            # picked this type from a palette, so the useful fact is which one
            # this server build cannot draw.
            raise _bad(f"{where}: unknown symbol type {node.get('type')!r}")
        if node.get("type") == "custom":
            # A custom node is only as good as the library entry behind it. Let a
            # dangling symbolId through and the drawing saves clean, then renders
            # a placeholder for every operator with nothing to say why — so this
            # is checked here for the same reason a binding's datasource is.
            symbol_id = node.get("symbolId")
            if not isinstance(symbol_id, int) or isinstance(symbol_id, bool):
                raise _bad(f"{where}: a custom symbol requires an integer symbolId")
            if symbol_id not in symbol_ids:
                raise _bad(f"{where}: symbolId {symbol_id} is not in the symbol library")
        binding = node.get("binding")
        if binding is None:
            continue
        if not isinstance(binding, dict):
            raise _bad(f"{where}: binding must be an object or null")
        _validate_binding(binding, f"{where} ({node_id})", cache)

    # An edge whose endpoint is missing has no geometry to derive — the client
    # drops it silently, so catch it here where it can still be reported.
    for i, edge in enumerate(edges):
        if not isinstance(edge, dict):
            raise _bad(f"doc.edges[{i}] must be an object")
        for end in ("from", "to"):
            ref = edge.get(end)
            if not isinstance(ref, dict) or ref.get("node") not in seen_ids:
                raise _bad(f"doc.edges[{i}].{end} must reference an existing node")


# --- Endpoints -------------------------------------------------------------
@router.get("/layouts", response_model=list[MimicSummary])
def list_layouts(_user: dict = Depends(get_current_user)):
    return db.list_mimic_layouts()


@router.get("/layouts/{slug}", response_model=MimicOut)
def get_layout(slug: str, _user: dict = Depends(get_current_user)):
    """404 is a normal first-run outcome — the client falls back to its seed."""
    row = db.get_mimic_layout(slug)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Layout not found"
        )
    return row


@router.put("/layouts/{slug}", response_model=MimicOut)
def save_layout(
    slug: str,
    body: MimicIn,
    _admin: dict = Depends(require_admin),
    _tier: object = Depends(require_entitlement("monitor_editor")),
):
    """Upsert the whole document. Partial saves would let the drawing and its
    bindings drift out of step, so there is no PATCH."""
    slug = slug.strip()
    if not SLUG_RE.match(slug):
        raise _bad(
            "slug must be lowercase letters, digits, dash or underscore (max 64 characters)"
        )
    _validate(body.doc)
    enforce_revision = "base_updated_at" in body.model_fields_set
    row = db.upsert_mimic_layout(
        slug,
        body.name.strip(),
        body.doc,
        base_updated_at=body.base_updated_at,
        enforce_revision=enforce_revision,
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This mimic changed on the server after editing began. "
                "Reload the server revision or export the draft before retrying."
            ),
        )
    return row


@router.delete("/layouts/{slug}", status_code=status.HTTP_204_NO_CONTENT)
def delete_layout(
    slug: str,
    _admin: dict = Depends(require_admin),
    _tier: object = Depends(require_entitlement("monitor_editor")),
):
    """Remove a drawing entirely. There is no soft delete: a mimic is a
    commissioned document, and leaving a hidden one behind would let its slug
    silently block a later drawing of the same name."""
    slug = slug.strip()
    if not SLUG_RE.match(slug):
        raise _bad(
            "slug must be lowercase letters, digits, dash or underscore (max 64 characters)"
        )
    if not db.delete_mimic_layout(slug):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Layout not found"
        )


# --- assets ----------------------------------------------------------------
# An asset is one uploaded picture. It is served back through this API rather
# than from a static directory so the file never becomes a URL the app cannot
# revoke, and so the hardening headers below travel with every response.
MAX_ASSET_BYTES = 512 * 1024

# Declared content types an admin may upload. The declaration is not trusted —
# _sniff_mime below has to agree with it.
ALLOWED_ASSET_MIMES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/svg+xml",
}

# Leading bytes that identify each format. A browser will happily render a file
# by its sniffed type, so a PNG-labelled SVG would otherwise be a way to smuggle
# markup past the allowlist.
_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
)


def _sniff_mime(data: bytes) -> str | None:
    """The format these bytes actually are, or None if it is not one we take."""
    for prefix, mime in _MAGIC:
        if data.startswith(prefix):
            return mime
    # RIFF....WEBP — the size field sits between the two markers.
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    # SVG is text and may open with a comment, a BOM, or an XML declaration
    # before the root element, so look for the tag in the opening bytes rather
    # than requiring it first.
    #
    # The BOM has to come off explicitly: `lstrip()` removes whitespace, and a
    # UTF-8 BOM is not whitespace. Plenty of Windows editors write one, so
    # without this a perfectly good SVG is rejected as an unsupported format.
    head = data[:1024].lstrip(b"\xef\xbb\xbf").lstrip()
    if head[:1] == b"<" and b"<svg" in data[:1024].lower():
        return "image/svg+xml"
    return None


# Headers every asset response carries.
#
# The frontend only ever draws an asset through <image href>, where a browser
# treats the file as an image and never runs script in it. But an uploaded SVG is
# also reachable by *navigating* to this URL, and an SVG document served from our
# own origin can script that origin — the classic stored-XSS on user content.
# `sandbox` drops the response into an opaque origin, which closes that path
# without a sanitizer; `nosniff` stops a mislabelled file being re-interpreted.
_ASSET_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    # Content is addressed by row id and rows are never rewritten in place — an
    # edit uploads a new asset — so this is safe to cache hard.
    "Cache-Control": "public, max-age=31536000, immutable",
}


class AssetOut(BaseModel):
    id: int
    name: str
    mime: str
    size_bytes: int
    created_at: datetime


class AssetSummary(AssetOut):
    used_by: int


@router.get("/assets", response_model=list[AssetSummary])
def list_assets(_user: dict = Depends(get_current_user)):
    return db.list_mimic_assets()


@router.post("/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    file: UploadFile = File(...),
    admin: dict = Depends(require_admin),
    _tier: object = Depends(require_entitlement("monitor_editor")),
):
    """Store one image for use as a custom symbol's picture.

    Re-uploading a file that is already stored returns the existing row instead
    of a duplicate: an admin who drags the same icon in twice means the same
    symbol both times, and a library full of near-identical entries is worse than
    a no-op.
    """
    data = await file.read()
    if not data:
        raise _bad("the uploaded file is empty")
    if len(data) > MAX_ASSET_BYTES:
        raise _bad(
            f"image is {len(data) // 1024} KB; the limit is {MAX_ASSET_BYTES // 1024} KB"
        )

    sniffed = _sniff_mime(data)
    if sniffed is None or sniffed not in ALLOWED_ASSET_MIMES:
        raise _bad(
            "unsupported image format — use PNG, JPEG, WebP or SVG "
            f"(this file's contents read as {sniffed or 'something else'})"
        )
    # The declared type is only ever allowed to *agree*. A mismatch means the
    # name and the bytes disagree about what this is, which is never innocent.
    declared = (file.content_type or "").split(";")[0].strip().lower()
    if declared and declared in ALLOWED_ASSET_MIMES and declared != sniffed:
        raise _bad(f"file claims to be {declared} but its contents are {sniffed}")

    digest = hashlib.sha256(data).hexdigest()
    existing = db.find_mimic_asset_by_hash(digest)
    if existing is not None:
        return existing

    name = (file.filename or "image").strip()[:120] or "image"
    return db.insert_mimic_asset(name, sniffed, data, digest, admin.get("id"))


@router.get("/assets/{asset_id}")
def get_asset(asset_id: int, _user: dict = Depends(get_current_user)):
    """The image bytes.

    Authenticated like every other read here, which means the browser cannot
    fetch it as a bare <image href> — no Authorization header would be attached.
    The frontend pulls it through the API client and hands the symbol a blob URL
    instead (see components/mimic/useAssetUrl.js).
    """
    row = db.get_mimic_asset(asset_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found"
        )
    return Response(
        content=bytes(row["bytes"]),
        media_type=row["mime"],
        headers=_ASSET_HEADERS,
    )


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(
    asset_id: int,
    _admin: dict = Depends(require_admin),
    _tier: object = Depends(require_entitlement("monitor_editor")),
):
    """Remove an upload. Refused while a library symbol still draws with it —
    deleting it anyway would turn every drawing using that symbol into a
    placeholder, with nothing on screen to explain why."""
    users = db.mimic_asset_users(asset_id)
    if users:
        raise _bad(
            "this image is still used by: " + ", ".join(users)
            + ". Delete or repoint those symbols first."
        )
    if not db.delete_mimic_asset(asset_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found"
        )


# --- custom symbol library -------------------------------------------------
# A library entry is a symbol definition an admin authored from an uploaded
# picture: its size, its ports, and the dynamics that make it move. Nodes in a
# layout reference one by id (`{type: "custom", symbolId: n}`), so the same
# authored symbol can be dropped onto any number of drawings.
#
# Dynamics kinds are not validated against a list here. The renderer skips a kind
# it does not recognise, and pinning the vocabulary in two places would mean a
# frontend that grows a new dynamic cannot use it until the backend is redeployed
# — the exact coupling VALID_NODE_TYPES already imposes on symbol types, and the
# reason authoring a symbol has to stay a pure frontend concern.
#
# Their *pointers* are another matter: a dynamic that names an asset id gets the
# same treatment as any other reference in this file, because a dangling one
# renders as a symbol with no picture for every operator.
MAX_SYMBOL_PORTS = 12

VALID_SYMBOL_BINDINGS = {"analog", "discrete", "both", "none"}

# Matches SYMBOLS[*].defaultSize in the frontend registry: big enough to draw,
# small enough to stay inside the 1600x900 sheet.
MIN_SYMBOL_SIZE = 16
MAX_SYMBOL_SIZE = 900


class SymbolIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    asset_id: int
    w: int = Field(..., ge=MIN_SYMBOL_SIZE, le=MAX_SYMBOL_SIZE)
    h: int = Field(..., ge=MIN_SYMBOL_SIZE, le=MAX_SYMBOL_SIZE)
    ports: dict = {}
    dynamics: list = []
    binding: str = "analog"
    bubble: dict | None = None


class SymbolOut(BaseModel):
    id: int
    name: str
    asset_id: int
    w: int
    h: int
    ports: dict = {}
    dynamics: list = []
    binding: str
    bubble: dict | None = None
    updated_at: datetime


def _validate_symbol(body: SymbolIn) -> dict[str, Any]:
    """Check a definition can actually be drawn, and hand back the row fields."""
    if db.get_mimic_asset(body.asset_id) is None:
        raise _bad(f"asset_id {body.asset_id} does not exist")

    if body.binding not in VALID_SYMBOL_BINDINGS:
        raise _bad(
            "binding must be one of: " + ", ".join(sorted(VALID_SYMBOL_BINDINGS))
        )

    if len(body.ports) > MAX_SYMBOL_PORTS:
        raise _bad(f"a symbol may not have more than {MAX_SYMBOL_PORTS} ports")

    # Ports are fractions of the symbol's own box — that is what lets the edge
    # router re-derive every wire from the node's current geometry instead of
    # storing line coordinates. A port outside 0..1 would place a pipe end off
    # the symbol it belongs to.
    for name, frac in body.ports.items():
        where = f"ports[{name!r}]"
        if not isinstance(frac, (list, tuple)) or len(frac) != 2:
            raise _bad(f"{where} must be a [x, y] pair")
        for v in frac:
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                raise _bad(f"{where} must be two numbers")
            if not 0 <= v <= 1:
                raise _bad(f"{where} must be fractions of the symbol box, 0 to 1")

    for i, dyn in enumerate(body.dynamics):
        if not isinstance(dyn, dict):
            raise _bad(f"dynamics[{i}] must be an object")
        if not isinstance(dyn.get("kind"), str) or not dyn["kind"]:
            raise _bad(f"dynamics[{i}] requires a kind")

        # A `map` on any dynamic points state names at asset ids — that is how a
        # multi-state symbol picks its picture. Validated by *shape* rather than
        # by kind, so this stays kind-agnostic (see the note above) while still
        # refusing a dangling pointer: an unresolvable id renders as a symbol with
        # no picture and nothing on screen to say why, which is the same failure
        # `_validate_binding` exists to prevent for a datasource.
        mapping = dyn.get("map")
        if mapping is None:
            continue
        if not isinstance(mapping, dict):
            raise _bad(f"dynamics[{i}].map must be an object")
        for state, ref in mapping.items():
            where = f"dynamics[{i}].map[{state!r}]"
            if not isinstance(ref, int) or isinstance(ref, bool):
                raise _bad(f"{where} must be an asset id")
            if db.get_mimic_asset(ref) is None:
                raise _bad(f"{where}: asset {ref} does not exist")

    return {
        "name": body.name.strip(),
        "asset_id": body.asset_id,
        "w": body.w,
        "h": body.h,
        "ports": body.ports,
        "dynamics": body.dynamics,
        "binding": body.binding,
        "bubble": body.bubble,
    }


@router.get("/symbols", response_model=list[SymbolOut])
def list_symbols(_user: dict = Depends(get_current_user)):
    """The whole library. Every operator needs it to render a drawing that uses
    custom symbols, so this is a plain authenticated read."""
    return db.list_mimic_symbols()


@router.post("/symbols", response_model=SymbolOut, status_code=status.HTTP_201_CREATED)
def create_symbol(
    body: SymbolIn,
    _admin: dict = Depends(require_admin),
    _tier: object = Depends(require_entitlement("monitor_editor")),
):
    return db.insert_mimic_symbol(_validate_symbol(body))


@router.put("/symbols/{symbol_id}", response_model=SymbolOut)
def update_symbol(
    symbol_id: int,
    body: SymbolIn,
    _admin: dict = Depends(require_admin),
    _tier: object = Depends(require_entitlement("monitor_editor")),
):
    row = db.update_mimic_symbol(symbol_id, _validate_symbol(body))
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Symbol not found"
        )
    return row


@router.delete("/symbols/{symbol_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_symbol(
    symbol_id: int,
    _admin: dict = Depends(require_admin),
    _tier: object = Depends(require_entitlement("monitor_editor")),
):
    if not db.delete_mimic_symbol(symbol_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Symbol not found"
        )
