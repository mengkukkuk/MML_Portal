"""Per-user datasource selection and datasource name lookup."""

from collections.abc import Sequence
from typing import Any

import config

from . import datasources as _datasources
from . import pool as _pool

__all__ = [
    "_SELECTION_COLS",
    "all_selected_datasource_ids",
    "datasource_names",
    "default_datasource",
    "get_user_selection",
    "init_user_datasource_selection_table",
    "sampled_datasource_ids",
    "set_user_selection",
]

# --- Per-user datasource selection ------------------------------------------
# Which plant datasources a user has chosen in the header. Every plant read
# fans out across this list, so it is the single input that decides where data
# comes from -- panel.datasource_id and per-symbol bindings no longer do.
def init_user_datasource_selection_table() -> None:
    """Create the user_datasource_selection table. Idempotent.

    `position` 0 is the *primary* source: what mimic symbols and the legacy
    single-value response fields resolve to. The order the operator picks is
    therefore load-bearing, not cosmetic.

    Both foreign keys cascade so a deleted user or datasource can never leave a
    dangling selection row. Without that, every read path would have to defend
    against ids that no longer exist.
    """
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS user_datasource_selection (
                user_id       INTEGER NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
                datasource_id INTEGER NOT NULL REFERENCES datasources(id) ON DELETE CASCADE,
                position      INTEGER NOT NULL DEFAULT 0,
                updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (user_id, datasource_id)
            )"""
        )
        conn.execute(
            """CREATE INDEX IF NOT EXISTS idx_uds_user
               ON user_datasource_selection (user_id, position)"""
        )
        conn.commit()


_SELECTION_COLS = (
    "d.id, d.name, d.host, d.port, d.dbname AS database, d.db_schema, s.position"
)


def get_user_selection(user_id: int) -> list[dict[str, Any]]:
    """This user's chosen datasources in position order.

    Joined to `datasources` so the caller only ever sees sources that still
    exist, and gets their current name rather than one cached at selection time.
    """
    with _pool.get_connection() as conn:
        rows = conn.execute(
            f"""SELECT {_SELECTION_COLS}
                FROM user_datasource_selection s
                JOIN datasources d ON d.id = s.datasource_id
                WHERE s.user_id = %s
                ORDER BY s.position, d.name""",
            (user_id,),
        ).fetchall()
    return rows


def set_user_selection(user_id: int, datasource_ids: list[int]) -> list[dict[str, Any]]:
    """Replace this user's selection atomically, preserving the given order.

    Unknown ids raise ValueError rather than being silently dropped: a selector
    that quietly discards half the operator's choice is worse than one that
    reports the stale id. Validation runs inside the same transaction as the
    replace, so a datasource deleted concurrently surfaces as a readable 400
    instead of a foreign-key 500.
    """
    if len(datasource_ids) > config.MAX_SELECTED_DATASOURCES:
        raise ValueError(
            f"at most {config.MAX_SELECTED_DATASOURCES} datasources may be selected"
        )
    # De-duplicate while keeping first-seen order; the PK would reject dupes and
    # position 0 is meaningful, so the *first* mention is the one that counts.
    ordered = list(dict.fromkeys(datasource_ids))
    with _pool.get_connection() as conn:
        if ordered:
            found = {
                r["id"] for r in conn.execute(
                    "SELECT id FROM datasources WHERE id = ANY(%s)", (ordered,)
                ).fetchall()
            }
            missing = [i for i in ordered if i not in found]
            if missing:
                conn.rollback()
                raise ValueError(
                    "unknown datasource id(s): " + ", ".join(str(i) for i in missing)
                )
        conn.execute(
            "DELETE FROM user_datasource_selection WHERE user_id = %s", (user_id,)
        )
        for position, ds_id in enumerate(ordered):
            conn.execute(
                """INSERT INTO user_datasource_selection (user_id, datasource_id, position)
                   VALUES (%s, %s, %s)""",
                (user_id, ds_id, position),
            )
        conn.commit()
    return get_user_selection(user_id)


def default_datasource() -> dict[str, Any] | None:
    """Lowest-id saved connection, used as the implicit selection.

    Deliberately not "all datasources": a user who has chosen nothing should not
    cause N remote handshakes, one of which may be a powered-off plant costing a
    full connect timeout on every request.
    """
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"SELECT {_datasources._DS_PUBLIC_COLS} FROM datasources ORDER BY id LIMIT 1"
        ).fetchone()
    return row


def all_selected_datasource_ids() -> list[int]:
    """Union of every user's selection — the set the tag buffer needs to sample.

    One cheap localhost query per poll, rather than a static config list that
    drifts the moment an operator selects something new.
    """
    with _pool.get_connection() as conn:
        rows = conn.execute(
            """SELECT DISTINCT datasource_id
               FROM user_datasource_selection ORDER BY datasource_id"""
        ).fetchall()
    return [r["datasource_id"] for r in rows]


def sampled_datasource_ids() -> list[int | None]:
    """Which sources the tag buffer should poll.

    The union of every explicit selection, falling back through the same ladder
    as auth.resolve_active_datasources — otherwise a fresh install where nobody
    has chosen anything yet buffers nothing, and every Live panel on the implicit
    default draws a blank chart until someone touches the header.
    """
    ids: list[int | None] = list(all_selected_datasource_ids())
    if ids:
        return ids
    fallback = default_datasource()
    return [fallback["id"]] if fallback else [None]


def datasource_names(datasource_ids: Sequence[int | None]) -> dict[int | None, str]:
    """{id: display name} for tagging fanned-out rows. `None` is the app DB."""
    concrete = [i for i in datasource_ids if i is not None]
    names: dict[int | None, str] = {None: "Local"}
    if concrete:
        with _pool.get_connection() as conn:
            rows = conn.execute(
                "SELECT id, name FROM datasources WHERE id = ANY(%s)", (concrete,)
            ).fetchall()
        names.update({r["id"]: r["name"] for r in rows})
    # A selected-then-deleted source still needs a label rather than a KeyError.
    for i in concrete:
        names.setdefault(i, f"datasource {i}")
    return names
