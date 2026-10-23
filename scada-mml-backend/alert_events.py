"""Alert messages as events, for the Response board — no database, no FastAPI.

A plant's alert writer repeats itself: "Check speed: 8,197 pcs/min — outside
7,000–8,000" every twenty seconds for as long as the line runs fast. Forty rows
of that are one thing that happened, and one thing someone has to act on. So
messages are grouped into **events**: same location, same severity, same role
and the same kind of message, with no more than `gap` between one and the next.

The *kind* of a message is its text up to the first ":" ("Check speed"), so the
numbers after it may change from row to row; a message without a colon is its
own kind. That is a reading of how plants write alerts ("<check>: <detail>"),
not a rule they follow — a writer that puts the varying part first gets one
event per row, which is no worse than the raw list.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Iterable

SEVERITIES = ("crit", "warn", "info")
SEVERITY_RANK = {"crit": 0, "warn": 1, "info": 2}
DEFAULT_GAP = timedelta(minutes=5)


def message_kind(message: str) -> str:
    """'Check speed' for 'Check speed: 8,197 pcs/min — outside 7,000–8,000'."""
    text = (message or "").strip()
    head, sep, _ = text.partition(":")
    return head.strip() if sep and head.strip() else text


def at_least(severity: str, floor: str) -> bool:
    """Whether `severity` is `floor` or worse ('crit' is worse than 'warn')."""
    return SEVERITY_RANK.get(severity, 2) <= SEVERITY_RANK.get(floor, 2)


def _role_key(role: dict[str, Any] | None) -> tuple:
    return (role.get("id"), role.get("code")) if role else (None, None)


def group_events(alerts: Iterable[dict[str, Any]], gap: timedelta = DEFAULT_GAP) -> list[dict[str, Any]]:
    """Alerts ({ts, message, severity, location, role, via}) as events, newest first.

    Each event: start, end (its last alert), count, severity, location, kind,
    message (the latest wording — the most current reading), role, via, and
    `first_message` when the wording changed along the way.
    """
    open_by_key: dict[tuple, dict[str, Any]] = {}
    events: list[dict[str, Any]] = []
    for a in sorted(alerts, key=lambda x: x["ts"]):
        key = (a.get("location"), a["severity"], _role_key(a.get("role")), message_kind(a["message"]))
        ev = open_by_key.get(key)
        if ev is not None and a["ts"] - ev["end"] <= gap:
            ev["end"] = a["ts"]
            ev["count"] += 1
            ev["message"] = a["message"]
            continue
        ev = {
            "start": a["ts"], "end": a["ts"], "count": 1, "severity": a["severity"],
            "location": a.get("location"), "kind": message_kind(a["message"]),
            "message": a["message"], "first_message": a["message"],
            "role": a.get("role"), "via": a.get("via"),
        }
        open_by_key[key] = ev
        events.append(ev)
    for ev in events:
        if ev["first_message"] == ev["message"]:
            del ev["first_message"]
    events.sort(key=lambda e: e["end"], reverse=True)
    return events


def by_role(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Events counted per role and severity — who has how much on their plate.

    Worst first: most critical events, then most warnings, then most events.
    Events no rule routed (role None) are one row of their own, so they are
    seen rather than dropped.
    """
    rows: dict[tuple, dict[str, Any]] = {}
    for ev in events:
        k = _role_key(ev.get("role"))
        row = rows.setdefault(k, {"role": ev.get("role"), "events": 0, "latest": ev["end"],
                                  **{s: 0 for s in SEVERITIES}})
        row["events"] += 1
        row[ev["severity"]] = row.get(ev["severity"], 0) + 1
        row["latest"] = max(row["latest"], ev["end"])
    return sorted(rows.values(), key=lambda r: (-r["crit"], -r["warn"], -r["events"]))


def latest_at(events: list[dict[str, Any]]) -> datetime | None:
    return max((e["end"] for e in events), default=None)
