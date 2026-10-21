"""`options.kpi` — the settings a management block stores, and their validation.

Shared by panels.py (saving a block) and kpi.py (previewing unsaved settings),
so a preview can never compute something a save would refuse. Strict on
purpose: unknown keys are refused rather than silently stored, because every
key here changes a figure the management board reads.
"""
from __future__ import annotations

import re
from typing import Any

from kpi_engine import PERIODS
from name_families import group_by_family, resolve_slot

KPI_CHART_TYPES = frozenset({"lossmeter", "andon", "waterfall"})

# No 5 s here: a ฿ figure that jitters every five seconds tells the board
# nothing, and each poll reads the plant database over the VPN.
KPI_POLL_INTERVALS = frozenset({30, 60, 600, 1800, 3600})

LOSSMETER_MODES = ("defects", "lost", "total")

KPI_DEFAULTS: dict[str, Any] = {
    "ts_col": None,
    "location": None,
    "slots": {"speed": "count_1", "defects": "defect_*"},
    "exclude_families": [],
    "period": "today",
    "compare": True,
    "mode": "defects",
    "cost_per_piece": None,
    "targets": {},
    "run_ratio": 0.8,
    "stop_threshold": 0,
    "min_stop_sec": 60,
    "valid_max": 50_000,
    "max_loss_stop_min": 120,
    "working_hours": None,
    "sample_sec": 10,
}

_RULE = re.compile(r"^[A-Za-z0-9_*?\-]{1,64}$")
_CLOCK = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class KpiOptionsError(ValueError):
    """A human-readable reason the settings were refused."""


def _number(name: str, value: Any, lo: float | None = None, hi: float | None = None,
            *, integer: bool = False, nullable: bool = False) -> float | int | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise KpiOptionsError(f"options.kpi.{name} must be a number")
    if integer and int(value) != value:
        raise KpiOptionsError(f"options.kpi.{name} must be a whole number")
    if lo is not None and value < lo or hi is not None and value > hi:
        raise KpiOptionsError(f"options.kpi.{name} must be between {lo} and {hi}")
    return int(value) if integer else value


def _working_hours(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {"start", "end", "days"}:
        raise KpiOptionsError("options.kpi.working_hours must be {start, end, days} or null")
    start, end = value.get("start"), value.get("end")
    if not isinstance(start, str) or not _CLOCK.match(start) or not isinstance(end, str) or not _CLOCK.match(end):
        raise KpiOptionsError("options.kpi.working_hours start/end must be HH:MM")
    if start == end:
        raise KpiOptionsError("options.kpi.working_hours start and end must differ")
    days = value.get("days", [1, 2, 3, 4, 5, 6, 7])
    if (not isinstance(days, list) or not days
            or any(isinstance(d, bool) or d not in range(1, 8) for d in days)):
        raise KpiOptionsError("options.kpi.working_hours.days must list weekdays 1 (Mon) to 7 (Sun)")
    return {"start": start, "end": end, "days": sorted(set(days))}


def normalize_kpi_options(raw: Any) -> dict[str, Any]:
    """`raw` merged over the defaults and checked; raises KpiOptionsError.

    Column-independent checks only — see `bind_families` for the table side.
    """
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise KpiOptionsError("options.kpi must be an object")
    unknown = set(raw) - set(KPI_DEFAULTS)
    if unknown:
        raise KpiOptionsError(f"options.kpi has unknown keys: {', '.join(sorted(unknown))}")
    o = {**KPI_DEFAULTS, **raw}

    if o["ts_col"] is not None and not isinstance(o["ts_col"], str):
        raise KpiOptionsError("options.kpi.ts_col must be a column name")
    if o["location"] is not None and not isinstance(o["location"], str):
        raise KpiOptionsError("options.kpi.location must be text or null")
    slots = o["slots"]
    if not isinstance(slots, dict) or set(slots) != {"speed", "defects"}:
        raise KpiOptionsError("options.kpi.slots must be {speed, defects}")
    for name, rule in slots.items():
        if not isinstance(rule, str) or not _RULE.match(rule):
            raise KpiOptionsError(f"options.kpi.slots.{name} must be a column suffix such as count_1 or defect_*")
    if not isinstance(o["exclude_families"], list) or any(not isinstance(f, str) for f in o["exclude_families"]):
        raise KpiOptionsError("options.kpi.exclude_families must be a list of family names")
    if o["period"] not in PERIODS:
        raise KpiOptionsError(f"options.kpi.period must be one of: {', '.join(PERIODS)}")
    if not isinstance(o["compare"], bool):
        raise KpiOptionsError("options.kpi.compare must be true or false")
    if o["mode"] not in LOSSMETER_MODES:
        raise KpiOptionsError(f"options.kpi.mode must be one of: {', '.join(LOSSMETER_MODES)}")
    o["cost_per_piece"] = _number("cost_per_piece", o["cost_per_piece"], 0, 1e9, nullable=True)
    if not isinstance(o["targets"], dict):
        raise KpiOptionsError("options.kpi.targets must map family names to pieces per minute")
    o["targets"] = {
        str(fam): _number(f"targets[{fam}]", v, 0.001, 1e9)
        for fam, v in o["targets"].items() if v is not None
    }
    o["run_ratio"] = _number("run_ratio", o["run_ratio"], 0.1, 1)
    o["stop_threshold"] = _number("stop_threshold", o["stop_threshold"], 0, 1e9)
    o["min_stop_sec"] = _number("min_stop_sec", o["min_stop_sec"], 0, 3600, integer=True)
    o["valid_max"] = _number("valid_max", o["valid_max"], 0.001, 1e12)
    if o["valid_max"] <= o["stop_threshold"]:
        raise KpiOptionsError("options.kpi.valid_max must be above stop_threshold")
    o["max_loss_stop_min"] = _number("max_loss_stop_min", o["max_loss_stop_min"], 1, 1440, integer=True)
    o["working_hours"] = _working_hours(o["working_hours"])
    o["sample_sec"] = _number("sample_sec", o["sample_sec"], 1, 600)
    return o


def bind_families(
    options: dict[str, Any],
    describe: dict[str, Any],
    location_tags: set[str] | None = None,
) -> list[dict[str, Any]]:
    """[{key, speed, defects}] — the machines this block reads, detected from columns.

    `describe` is `db.describe_table(...)`. Only numeric value and numeric array
    columns can feed a slot. `location_tags`, when given, narrows the columns to
    the tags at the block's location. A family without a speed column is not a
    machine this block can judge, so it is left out. Raises KpiOptionsError when
    nothing is left, so a block can never be saved reading nothing.
    """
    ts_col = options.get("ts_col")
    if not ts_col or ts_col not in describe.get("datetime_columns", describe.get("ts_columns", [])):
        raise KpiOptionsError("options.kpi.ts_col must be a timestamp column of the table")
    numeric = set(describe.get("value_columns", [])) | set(describe.get("array_value_columns", []))
    names = [c for c in describe.get("column_types", {}) if c in numeric]
    if location_tags is not None:
        names = [c for c in names if c in location_tags]
    excluded = set(options.get("exclude_families") or [])
    families = []
    for group in group_by_family(names):
        if not group["key"] or group["key"] in excluded:
            continue
        speed = resolve_slot(group["key"], group["names"], options["slots"]["speed"])
        if not speed:
            continue
        families.append({
            "key": group["key"],
            "speed": speed[0],
            "defects": resolve_slot(group["key"], group["names"], options["slots"]["defects"]),
        })
    if not families:
        raise KpiOptionsError(
            f"No machine in this table has a column ending in -{options['slots']['speed']}"
        )
    return families
