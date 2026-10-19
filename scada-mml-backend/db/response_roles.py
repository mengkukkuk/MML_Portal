"""Response roles: who has to act on an alert.

Each row is one rule — a role (its code and its Thai/English names) and the
conditions under which an alert is that role's to handle: its location and a
keyword in the message. Every condition is optional; a rule with none is the
catch-all. Rules are tried by `priority` (lower first, then id) and the first
that fits wins.

Severity is deliberately not a condition. How loud an alert is says nothing
about whose job it is, and a rule keyed on it sent every critical alert to one
team whatever had happened. An alert that must reach a particular role is
tagged with it instead: the alert source's role column (alert_messages.role_id)
holds this table's `id`, and that tag wins over every rule. A code is accepted
there too, for plant tables such as alarm_logs that carry a text role rather
than our id.

Rules live in the app database, edited by admins in Settings, because the
alerts they classify do not have to come from a table anyone can change:
alarm_logs is written by the SCADA, and gets roles all the same.
"""

from typing import Any

from . import pool as _pool

__all__ = [
    "create_response_role",
    "delete_response_role",
    "init_response_roles_table",
    "list_response_roles",
    "match_response_role",
    "update_response_role",
]

_COLS = "id, code, name_th, name_en, location, keyword, priority, updated_at"
_FIELDS = ("code", "name_th", "name_en", "location", "keyword", "priority")


def init_response_roles_table() -> None:
    """Create the response role rules table. Idempotent."""
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS response_role (
                id         SERIAL PRIMARY KEY,
                code       TEXT NOT NULL,
                name_th    TEXT NOT NULL,
                name_en    TEXT NOT NULL,
                location   TEXT,
                keyword    TEXT,
                priority   INTEGER NOT NULL DEFAULT 100,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        # The first build matched on severity too (the module docstring says why
        # it no longer does). Its CHECK constraint goes with the column.
        conn.execute("ALTER TABLE response_role DROP COLUMN IF EXISTS severity")
        conn.commit()


def list_response_roles() -> list[dict[str, Any]]:
    """Every rule, in the order they are tried."""
    with _pool.get_connection() as conn:
        return conn.execute(
            f"SELECT {_COLS} FROM response_role ORDER BY priority, id"
        ).fetchall()


def create_response_role(**fields) -> dict[str, Any]:
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"""INSERT INTO response_role ({', '.join(_FIELDS)})
                VALUES ({', '.join(['%s'] * len(_FIELDS))})
                RETURNING {_COLS}""",
            [fields.get(f) for f in _FIELDS],
        ).fetchone()
        conn.commit()
    return row


def update_response_role(role_id: int, **fields) -> dict[str, Any] | None:
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"""UPDATE response_role
                SET {', '.join(f'{f} = %s' for f in _FIELDS)}, updated_at = now()
                WHERE id = %s
                RETURNING {_COLS}""",
            [*(fields.get(f) for f in _FIELDS), role_id],
        ).fetchone()
        conn.commit()
    return row


def delete_response_role(role_id: int) -> bool:
    with _pool.get_connection() as conn:
        cur = conn.execute("DELETE FROM response_role WHERE id = %s", (role_id,))
        conn.commit()
    return cur.rowcount > 0


def _squash(text: str | None) -> str:
    """'Line 13', 'Line13' and ' line 13 ' are one line: case and spaces dropped.

    Plant tables are not consistent about either (alarm_logs carries all three
    spellings), and a rule that missed half a line's alarms would be worse than
    one that cannot tell 'Line 1 3' from 'Line 13'.
    """
    return "".join((text or "").split()).casefold()


def _ref(rule: dict[str, Any]) -> dict[str, Any]:
    return {"id": rule.get("id"), "code": rule["code"],
            "name_th": rule["name_th"], "name_en": rule["name_en"]}


def _role_id(tag: str) -> int | None:
    """'7', '7.0' and ' 7 ' are role 7 — the column may be text or numeric."""
    try:
        number = float(tag)
    except ValueError:
        return None
    return int(number) if number.is_integer() else None


def match_response_role(
    rules: list[dict[str, Any]],
    *,
    location: str | None,
    message: str,
    explicit: str | None = None,
) -> dict[str, Any] | None:
    """The role that should act on one alert, as `{id, code, name_th, name_en}`, or None.

    `rules` come from `list_response_roles` (already in priority order).
    `explicit` is the alert row's own role tag, when its source has a role
    column, and it wins over every rule. It is read as a role `id` first, then
    as a `code`; a tag that names no role is shown as written (with no id),
    since the writer clearly meant someone.
    """
    tag = str(explicit).strip() if explicit is not None else ""
    if tag:
        wanted = _role_id(tag)
        named = (
            next((r for r in rules if wanted is not None and r.get("id") == wanted), None)
            or next((r for r in rules if r["code"].casefold() == tag.casefold()), None)
        )
        if named:
            return _ref(named)
        return {"id": None, "code": tag, "name_th": tag, "name_en": tag}

    where = _squash(location)
    text = (message or "").casefold()
    for r in rules:
        if r.get("location") and _squash(r["location"]) != where:
            continue
        if r.get("keyword") and r["keyword"].casefold() not in text:
            continue
        return _ref(r)
    return None
