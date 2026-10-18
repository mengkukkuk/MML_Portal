"""Response roles: who has to act on an alert.

Each row is one rule — a role (its code and its Thai/English names) and the
conditions under which an alert is that role's to handle: severity, location,
a keyword in the message. Every condition is optional; a rule with none is the
catch-all. Rules are tried by `priority` (lower first, then id) and the first
that fits wins.

A role can also be named on the alert row itself, when the alert source has a
role column (alert_messages.response_role, say). That explicit value wins over
every rule, and is looked up by `code` here only to show the role's names.

Rules live in the app database, edited by admins in Settings, because the
alerts they classify do not have to come from a table anyone can change:
alarm_logs is written by the SCADA, and gets roles all the same.
"""

from typing import Any

from . import pool as _pool

__all__ = [
    "RESPONSE_ROLE_SEVERITIES",
    "create_response_role",
    "delete_response_role",
    "init_response_roles_table",
    "list_response_roles",
    "match_response_role",
    "update_response_role",
]

RESPONSE_ROLE_SEVERITIES = ("crit", "warn", "info")

_COLS = "id, code, name_th, name_en, severity, location, keyword, priority, updated_at"
_FIELDS = ("code", "name_th", "name_en", "severity", "location", "keyword", "priority")


def init_response_roles_table() -> None:
    """Create the response role rules table. Idempotent."""
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS response_role (
                id         SERIAL PRIMARY KEY,
                code       TEXT NOT NULL,
                name_th    TEXT NOT NULL,
                name_en    TEXT NOT NULL,
                severity   TEXT,
                location   TEXT,
                keyword    TEXT,
                priority   INTEGER NOT NULL DEFAULT 100,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                CONSTRAINT response_role_severity
                    CHECK (severity IS NULL OR severity IN ('crit', 'warn', 'info'))
            )"""
        )
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


def match_response_role(
    rules: list[dict[str, Any]],
    *,
    severity: str,
    location: str | None,
    message: str,
    explicit: str | None = None,
) -> dict[str, Any] | None:
    """The role that should act on one alert, as `{code, name_th, name_en}`, or None.

    `rules` come from `list_response_roles` (already in priority order).
    `severity` is the normalised one ('crit'/'warn'/'info'). `explicit` is the
    alert row's own role value, when its source has a role column: it wins, and
    is named by the first rule with that code — or shown as written when no
    rule has it, since the writer clearly meant someone.
    """
    if explicit and explicit.strip():
        code = explicit.strip()
        named = next((r for r in rules if r["code"].casefold() == code.casefold()), None)
        if named:
            return {"code": named["code"], "name_th": named["name_th"], "name_en": named["name_en"]}
        return {"code": code, "name_th": code, "name_en": code}

    where = _squash(location)
    text = (message or "").casefold()
    for r in rules:
        if r.get("severity") and r["severity"] != severity:
            continue
        if r.get("location") and _squash(r["location"]) != where:
            continue
        if r.get("keyword") and r["keyword"].casefold() not in text:
            continue
        return {"code": r["code"], "name_th": r["name_th"], "name_en": r["name_en"]}
    return None
