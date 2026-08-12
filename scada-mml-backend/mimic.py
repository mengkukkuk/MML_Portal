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
import re
from datetime import datetime
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

import db
from auth import get_current_user, require_admin

router = APIRouter(prefix="/api/mimic", tags=["mimic"])

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
def save_layout(slug: str, body: MimicIn, _admin: dict = Depends(require_admin)):
    """Upsert the whole document. Partial saves would let the drawing and its
    bindings drift out of step, so there is no PATCH."""
    slug = slug.strip()
    if not SLUG_RE.match(slug):
        raise _bad(
            "slug must be lowercase letters, digits, dash or underscore (max 64 characters)"
        )
    _validate(body.doc)
    return db.upsert_mimic_layout(slug, body.name.strip(), body.doc)


@router.delete("/layouts/{slug}", status_code=status.HTTP_204_NO_CONTENT)
def delete_layout(slug: str, _admin: dict = Depends(require_admin)):
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
