"""Mimic layouts, uploaded assets and the custom symbol library."""

from typing import Any

from psycopg.types.json import Json

from . import pool as _pool

__all__ = [
    "_SYMBOL_COLS",
    "delete_mimic_asset",
    "delete_mimic_layout",
    "delete_mimic_symbol",
    "find_mimic_asset_by_hash",
    "get_mimic_asset",
    "get_mimic_layout",
    "get_mimic_symbol",
    "init_mimic_assets_table",
    "init_mimic_symbols_table",
    "init_mimic_table",
    "insert_mimic_asset",
    "insert_mimic_symbol",
    "list_mimic_assets",
    "list_mimic_layouts",
    "list_mimic_symbols",
    "mimic_asset_users",
    "update_mimic_symbol",
    "upsert_mimic_layout",
]

# --- Mimic layouts (/monitor) -----------------------------------------------
# One row per plant drawing. The whole layout document — nodes, edges, ports,
# geometry and each node's datasource binding — lives in `doc` as JSONB: none
# of it has query needs, and the frontend document is already flat and
# serialisable. Reads are open to any authenticated user (every operator sees
# the same commissioned plant); writes are admin-only, enforced in mimic.py.
# `mimic_layouts` is in SENSITIVE_TABLES so a layout can never be charted back
# through the generic table source.
def init_mimic_table() -> None:
    """Create the mimic_layouts table if it doesn't exist. Idempotent."""
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS mimic_layouts (
                id         SERIAL PRIMARY KEY,
                slug       TEXT NOT NULL UNIQUE,
                name       TEXT NOT NULL,
                doc        JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.commit()


def list_mimic_layouts() -> list[dict[str, Any]]:
    """Every saved drawing, without its document, ordered by name."""
    with _pool.get_connection() as conn:
        rows = conn.execute(
            "SELECT slug, name, updated_at FROM mimic_layouts ORDER BY name"
        ).fetchall()
    return rows


def get_mimic_layout(slug: str) -> dict[str, Any] | None:
    """One drawing with its full document. None if it has never been saved —
    the client then falls back to its seeded layout."""
    with _pool.get_connection() as conn:
        row = conn.execute(
            "SELECT slug, name, doc, updated_at FROM mimic_layouts WHERE slug = %s",
            (slug,),
        ).fetchone()
    return row


def upsert_mimic_layout(
    slug: str,
    name: str,
    doc: dict[str, Any],
    *,
    base_updated_at=None,
    enforce_revision: bool = False,
) -> dict[str, Any] | None:
    """Create or replace a drawing, optionally guarded by its last revision.

    An omitted revision keeps the historical unconditional-upsert contract.
    Explicit ``None`` is insert-only; a timestamp updates only the exact row
    the editor started from. ``None`` is returned for either conflict shape.
    """
    with _pool.get_connection() as conn:
        if not enforce_revision:
            row = conn.execute(
                """INSERT INTO mimic_layouts (slug, name, doc)
                VALUES (%s, %s, %s)
                ON CONFLICT (slug) DO UPDATE
                    SET name = EXCLUDED.name,
                        doc = EXCLUDED.doc,
                        updated_at = now()
                RETURNING slug, name, doc, updated_at""",
                (slug, name, Json(doc)),
            ).fetchone()
        elif base_updated_at is None:
            row = conn.execute(
                """INSERT INTO mimic_layouts (slug, name, doc)
                VALUES (%s, %s, %s)
                ON CONFLICT (slug) DO NOTHING
                RETURNING slug, name, doc, updated_at""",
                (slug, name, Json(doc)),
            ).fetchone()
        else:
            row = conn.execute(
                """UPDATE mimic_layouts
                SET name = %s, doc = %s, updated_at = now()
                WHERE slug = %s AND updated_at = %s
                RETURNING slug, name, doc, updated_at""",
                (name, Json(doc), slug, base_updated_at),
            ).fetchone()
        conn.commit()
    return row


def delete_mimic_layout(slug: str) -> bool:
    """Remove a drawing. True if a row went, False if the slug was already
    gone — the caller turns that into the 404, so a double-delete from two
    admin tabs reports honestly instead of claiming success twice."""
    with _pool.get_connection() as conn:
        cur = conn.execute("DELETE FROM mimic_layouts WHERE slug = %s", (slug,))
        conn.commit()
    return cur.rowcount > 0


# --- mimic assets & custom symbol library ----------------------------------
# Two tables behind /monitor's user-authored symbols. mimic_assets holds the
# uploaded image bytes; mimic_symbols is the library of symbol *definitions*
# that reference them.
#
# The split is deliberate. A definition carries the ports, size and dynamics an
# admin configured once, so dropping the same rack onto ten drawings reuses one
# entry instead of re-authoring it ten times — which is the difference between a
# symbol library and a per-node image field.
#
# Bytes live in Postgres rather than on disk: the app already treats the database
# as its only durable store, and an asset that vanished on redeploy would leave
# every drawing referencing it broken. Both tables are in SENSITIVE_TABLES so
# neither can be charted back through the generic table source.
def init_mimic_assets_table() -> None:
    """Create the mimic_assets table if it doesn't exist. Idempotent."""
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS mimic_assets (
                id          SERIAL PRIMARY KEY,
                name        TEXT NOT NULL,
                mime        TEXT NOT NULL,
                bytes       BYTEA NOT NULL,
                size_bytes  INTEGER NOT NULL,
                -- Content hash, not a name: two admins uploading the same icon
                -- should share one row rather than racking up near-duplicates
                -- nobody can tell apart in the picker.
                sha256      TEXT NOT NULL UNIQUE,
                uploaded_by INTEGER,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.commit()


def init_mimic_symbols_table() -> None:
    """Create the mimic_symbols table if it doesn't exist. Idempotent."""
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS mimic_symbols (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL,
                -- RESTRICT, not CASCADE: deleting an image out from under a
                -- symbol would leave every drawing using it drawing a
                -- placeholder. The API refuses the delete and says which
                -- symbols are in the way.
                asset_id   INTEGER NOT NULL REFERENCES mimic_assets(id) ON DELETE RESTRICT,
                w          INTEGER NOT NULL,
                h          INTEGER NOT NULL,
                ports      JSONB NOT NULL DEFAULT '{}'::jsonb,
                dynamics   JSONB NOT NULL DEFAULT '[]'::jsonb,
                binding    TEXT NOT NULL DEFAULT 'analog',
                bubble     JSONB,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        conn.commit()


def list_mimic_assets() -> list[dict[str, Any]]:
    """Every uploaded asset, without its bytes.

    used_by counts the library symbols referencing it, so the picker can show at
    a glance which uploads are actually in play and which are dead weight.
    """
    with _pool.get_connection() as conn:
        rows = conn.execute(
            """SELECT a.id, a.name, a.mime, a.size_bytes, a.created_at,
                      count(s.id)::int AS used_by
            FROM mimic_assets a
            LEFT JOIN mimic_symbols s ON s.asset_id = a.id
            GROUP BY a.id
            ORDER BY a.name"""
        ).fetchall()
    return rows


def get_mimic_asset(asset_id: int) -> dict[str, Any] | None:
    """One asset *with* its bytes — the read behind the image endpoint."""
    with _pool.get_connection() as conn:
        row = conn.execute(
            "SELECT id, name, mime, bytes, size_bytes FROM mimic_assets WHERE id = %s",
            (asset_id,),
        ).fetchone()
    return row


def find_mimic_asset_by_hash(sha256: str) -> dict[str, Any] | None:
    """An identical upload that is already stored, if there is one."""
    with _pool.get_connection() as conn:
        row = conn.execute(
            "SELECT id, name, mime, size_bytes, created_at FROM mimic_assets WHERE sha256 = %s",
            (sha256,),
        ).fetchone()
    return row


def insert_mimic_asset(
    name: str, mime: str, data: bytes, sha256: str, uploaded_by: int | None
) -> dict[str, Any]:
    with _pool.get_connection() as conn:
        row = conn.execute(
            """INSERT INTO mimic_assets (name, mime, bytes, size_bytes, sha256, uploaded_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, name, mime, size_bytes, created_at""",
            (name, mime, data, len(data), sha256, uploaded_by),
        ).fetchone()
        conn.commit()
    return row


def mimic_asset_users(asset_id: int) -> list[str]:
    """Names of the library symbols standing in the way of a delete."""
    with _pool.get_connection() as conn:
        rows = conn.execute(
            "SELECT name FROM mimic_symbols WHERE asset_id = %s ORDER BY name",
            (asset_id,),
        ).fetchall()
    return [r["name"] for r in rows]


def delete_mimic_asset(asset_id: int) -> bool:
    with _pool.get_connection() as conn:
        cur = conn.execute("DELETE FROM mimic_assets WHERE id = %s", (asset_id,))
        conn.commit()
    return cur.rowcount > 0


_SYMBOL_COLS = "id, name, asset_id, w, h, ports, dynamics, binding, bubble, updated_at"


def list_mimic_symbols() -> list[dict[str, Any]]:
    """The whole custom library.

    Small by nature (one row per authored symbol) and needed in full before a
    drawing can be rendered, so there is no paging: a node referencing a symbol
    missing from this list draws as a placeholder.
    """
    with _pool.get_connection() as conn:
        rows = conn.execute(
            f"SELECT {_SYMBOL_COLS} FROM mimic_symbols ORDER BY name"
        ).fetchall()
    return rows


def get_mimic_symbol(symbol_id: int) -> dict[str, Any] | None:
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"SELECT {_SYMBOL_COLS} FROM mimic_symbols WHERE id = %s", (symbol_id,)
        ).fetchone()
    return row


def insert_mimic_symbol(fields: dict[str, Any]) -> dict[str, Any]:
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"""INSERT INTO mimic_symbols
                (name, asset_id, w, h, ports, dynamics, binding, bubble)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_SYMBOL_COLS}""",
            (
                fields["name"], fields["asset_id"], fields["w"], fields["h"],
                Json(fields["ports"]), Json(fields["dynamics"]),
                fields["binding"],
                Json(fields["bubble"]) if fields.get("bubble") else None,
            ),
        ).fetchone()
        conn.commit()
    return row


def update_mimic_symbol(symbol_id: int, fields: dict[str, Any]) -> dict[str, Any] | None:
    """Replace a definition whole.

    Every drawing using it picks the change up on its next load — that is the
    point of a library, and why there is no PATCH.
    """
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"""UPDATE mimic_symbols SET
                name = %s, asset_id = %s, w = %s, h = %s, ports = %s,
                dynamics = %s, binding = %s, bubble = %s, updated_at = now()
            WHERE id = %s
            RETURNING {_SYMBOL_COLS}""",
            (
                fields["name"], fields["asset_id"], fields["w"], fields["h"],
                Json(fields["ports"]), Json(fields["dynamics"]),
                fields["binding"],
                Json(fields["bubble"]) if fields.get("bubble") else None,
                symbol_id,
            ),
        ).fetchone()
        conn.commit()
    return row


def delete_mimic_symbol(symbol_id: int) -> bool:
    """Remove a library entry.

    Nodes still pointing at it draw as placeholders rather than taking their
    drawing down, so this needs no reference check — unlike an asset, whose
    removal would take the symbol's picture with it.
    """
    with _pool.get_connection() as conn:
        cur = conn.execute("DELETE FROM mimic_symbols WHERE id = %s", (symbol_id,))
        conn.commit()
    return cur.rowcount > 0
