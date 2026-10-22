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

KPI_CHART_TYPES = frozenset({
    "lossmeter", "andon", "waterfall",
    # second set, from the Line 13 monitoring dashboard (docs/Line13_Monitoring_Dashboard.html)
    "kpistrip", "hourly", "pace", "sensors", "response", "kpitrend", "pareto",
})

# What a KPI strip may show — keys of the summary's `metrics` (kpi.py).
KPI_METRICS = (
    "plan_pct", "yield", "availability", "risk_pieces", "blind_min", "avg_response_min",
    "good", "pieces", "defects", "defect_rate", "lost", "cost_total", "incidents",
)
MAX_STRIP_METRICS = 6

# No 5 s here: a ฿ figure that jitters every five seconds tells the board
# nothing, and each poll reads the plant database over the VPN.
KPI_POLL_INTERVALS = frozenset({30, 60, 600, 1800, 3600})

LOSSMETER_MODES = ("defects", "lost", "total")

# How a numeric array column reads when the Loss meter counts picked columns:
# "sum" adds every element (a per-type tally such as [15, 20, 0, 0, 0]), "first"
# takes element 1 (a newest-first series, or a wide table's [value, setpoint, ...]).
ARRAY_MODES = ("sum", "first")
MAX_DEFECT_COLS = 40

# How the machine blocks read an explicit output column: "rate" is pieces per
# minute (what a wide table's count_1 holds), "total" a running counter that only
# goes up — pieces are its positive change between readings.
VALUE_KINDS = ("rate", "total")
# One machine per distinct value of the machine column; past this the column is
# not a machine name (a timestamp, a batch id) and the block says so.
MAX_MACHINES = 64

KPI_DEFAULTS: dict[str, Any] = {
    "ts_col": None,
    "location": None,
    # Legacy machine detection for wide tables (CAM001-13-count_1, ...). No longer
    # edited in the inspector: it only decides what a table with such columns
    # does when `defect_cols` is not set.
    "slots": {"speed": "count_1", "defects": "defect_*"},
    # The Loss meter's explicit binding: count these columns (any numeric,
    # numeric-array or flag column), optionally only on rows where `filter_col`
    # reads `filter_val`. None leaves the wide-table detection in charge.
    "defect_cols": None,
    # The machine blocks' explicit binding: each distinct value of `machine_col`
    # is a machine (None: the whole table is one), whose output is `output_col`.
    # Set, it replaces the wide-table detection; `defect_cols` then name the
    # defect columns read per machine, in the same unit.
    "machine_col": None,
    "output_col": None,
    "value_kind": "rate",
    "array_mode": "sum",
    "filter_col": None,
    "filter_val": None,
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
    # "line": the families are cameras along one line — output, run and stop
    # come from `line_family` (default: the first), defects from every camera.
    # "machines": every family is its own machine and the totals add up.
    "scope": "line",
    "line_family": None,
    "plan_pieces": None,
    "metrics": ["plan_pct", "yield", "availability", "risk_pieces", "blind_min", "avg_response_min"],
    "sensors": None,
    "flat_min": 10,
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
    if o["defect_cols"] is not None:
        cols = o["defect_cols"]
        if (not isinstance(cols, list) or not cols or len(cols) > MAX_DEFECT_COLS
                or any(not isinstance(c, str) or not c for c in cols)):
            raise KpiOptionsError(
                f"options.kpi.defect_cols must list 1 to {MAX_DEFECT_COLS} column names, or be null")
        o["defect_cols"] = list(dict.fromkeys(cols))
    for name in ("machine_col", "output_col"):
        if o[name] is not None and (not isinstance(o[name], str) or not o[name]):
            raise KpiOptionsError(f"options.kpi.{name} must be a column name or null")
    if o["value_kind"] not in VALUE_KINDS:
        raise KpiOptionsError(f"options.kpi.value_kind must be one of: {', '.join(VALUE_KINDS)}")
    if o["array_mode"] not in ARRAY_MODES:
        raise KpiOptionsError(f"options.kpi.array_mode must be one of: {', '.join(ARRAY_MODES)}")
    if o["filter_col"] is not None and (not isinstance(o["filter_col"], str) or not o["filter_col"]):
        raise KpiOptionsError("options.kpi.filter_col must be a column name or null")
    if o["filter_val"] is not None and not isinstance(o["filter_val"], str):
        raise KpiOptionsError("options.kpi.filter_val must be text or null")
    if (o["filter_col"] is None) != (o["filter_val"] is None):
        raise KpiOptionsError("options.kpi.filter_col and filter_val go together")
    if not isinstance(o["exclude_families"], list) or any(not isinstance(f, str) for f in o["exclude_families"]):
        raise KpiOptionsError("options.kpi.exclude_families must be a list of family names")
    if o["period"] not in PERIODS:
        raise KpiOptionsError(f"options.kpi.period must be one of: {', '.join(PERIODS)}")
    if not isinstance(o["compare"], bool):
        raise KpiOptionsError("options.kpi.compare must be true or false")
    if o["mode"] not in LOSSMETER_MODES:
        raise KpiOptionsError(f"options.kpi.mode must be one of: {', '.join(LOSSMETER_MODES)}")
    if o["defect_cols"] is not None and o["output_col"] is None and o["mode"] != "defects":
        raise KpiOptionsError(
            "options.kpi: picked defect columns alone count defects only — choose an output "
            "column to measure Production lost and Total loss")
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
    if o["scope"] not in ("line", "machines"):
        raise KpiOptionsError("options.kpi.scope must be line or machines")
    if o["line_family"] is not None and not isinstance(o["line_family"], str):
        raise KpiOptionsError("options.kpi.line_family must be a family name or null")
    o["plan_pieces"] = _number("plan_pieces", o["plan_pieces"], 0, 1e12, nullable=True)
    metrics = o["metrics"]
    if (not isinstance(metrics, list) or not metrics or len(metrics) > MAX_STRIP_METRICS
            or any(m not in KPI_METRICS for m in metrics)):
        raise KpiOptionsError(
            f"options.kpi.metrics must list 1 to {MAX_STRIP_METRICS} of: {', '.join(KPI_METRICS)}")
    if o["sensors"] is not None and (
            not isinstance(o["sensors"], list) or any(not isinstance(c, str) for c in o["sensors"])):
        raise KpiOptionsError("options.kpi.sensors must be a list of column names or null")
    o["flat_min"] = _number("flat_min", o["flat_min"], 1, 240, integer=True)
    return o


def counts_picked_columns(options: dict[str, Any], chart_type: str | None) -> bool:
    """Whether this block reads explicitly picked columns rather than detected machines.

    Only the Loss meter does: the other blocks judge machines through speed
    columns, which a defect tally cannot stand in for.
    """
    return (chart_type == "lossmeter" and options.get("defect_cols") is not None
            and options.get("output_col") is None)


def columns_layout(options: dict[str, Any]) -> dict[str, Any] | None:
    """How the machine blocks read an explicitly bound table, or None for wide-table detection.

    Part of every bucket's identity (cache key) and of the SQL that makes them.
    """
    if not options.get("output_col"):
        return None
    flt = (options["filter_col"], options["filter_val"]) if options.get("filter_col") else None
    return {"machine_col": options.get("machine_col"), "value_kind": options.get("value_kind", "rate"),
            "filter": flt}


def bind_picked(options: dict[str, Any], describe: dict[str, Any]) -> dict[str, Any]:
    """{ts_col, defect_cols, filter} — the picked columns checked against the table.

    Numeric, numeric-array and flag columns can be counted; a text column can
    only filter rows. Raises KpiOptionsError naming the column and why, so the
    inspector can say what to change.
    """
    ts_col = options.get("ts_col")
    if not ts_col or ts_col not in describe.get("datetime_columns", describe.get("ts_columns", [])):
        raise KpiOptionsError("Choose the table's time column (options.kpi.ts_col) in block settings")
    types = describe.get("column_types", {})
    countable = (set(describe.get("value_columns", [])) | set(describe.get("array_value_columns", []))
                 | set(describe.get("bool_columns", [])))
    for col in options["defect_cols"]:
        if col not in types:
            raise KpiOptionsError(f"options.kpi.defect_cols: {col!r} is not a column of this table")
        if col not in countable:
            kind = types[col]
            hint = " — use it in \"Only count rows where\" instead" if col in describe.get("text_columns", []) else ""
            raise KpiOptionsError(f"options.kpi.defect_cols: {col!r} ({kind}) cannot be counted{hint}")
    flt = None
    if options.get("filter_col") is not None:
        if options["filter_col"] not in describe.get("filter_columns", []):
            raise KpiOptionsError(f"options.kpi.filter_col: {options['filter_col']!r} cannot filter rows")
        flt = (options["filter_col"], options["filter_val"])
    return {"ts_col": ts_col, "defect_cols": list(options["defect_cols"]), "filter": flt}


def _bind_columns(
    options: dict[str, Any],
    describe: dict[str, Any],
    machine_values: list[str] | None,
    table: str,
) -> list[dict[str, Any]]:
    """The machines of an explicitly bound table: one per value of the machine column.

    Every machine reads the same output and defect columns; `machine_values` are
    the machine column's distinct values (the caller reads them), or ignored when
    the whole table is one machine, which is then named after the table.
    """
    types = describe.get("column_types", {})
    numeric = set(describe.get("value_columns", [])) | set(describe.get("array_value_columns", []))
    out = options["output_col"]
    if out not in types:
        raise KpiOptionsError(f"options.kpi.output_col: {out!r} is not a column of this table")
    if out not in numeric:
        raise KpiOptionsError(f"options.kpi.output_col: {out!r} ({types[out]}) is not a number or numeric array")
    defects = list(options.get("defect_cols") or [])
    for col in defects:
        if col not in types:
            raise KpiOptionsError(f"options.kpi.defect_cols: {col!r} is not a column of this table")
        if col not in numeric:
            raise KpiOptionsError(f"options.kpi.defect_cols: {col!r} ({types[col]}) is not a number or numeric array")
    machine = options.get("machine_col")
    if machine is not None and machine not in describe.get("filter_columns", []):
        raise KpiOptionsError(f"options.kpi.machine_col: {machine!r} cannot name machines")
    if options.get("filter_col") is not None and options["filter_col"] not in describe.get("filter_columns", []):
        raise KpiOptionsError(f"options.kpi.filter_col: {options['filter_col']!r} cannot filter rows")
    excluded = set(options.get("exclude_families") or [])
    if machine is None:
        keys = [table]
    else:
        keys = list(machine_values or [])
        if len(keys) > MAX_MACHINES:
            raise KpiOptionsError(
                f"{machine!r} has more than {MAX_MACHINES} different values, so it does not name machines — "
                "choose another column, or narrow the rows with \"Only rows where\"")
    families = [{"key": k, "speed": out, "defects": defects} for k in keys if k not in excluded]
    if not families:
        raise KpiOptionsError("No machines to show: the machine column has no values in this table")
    return families


def bind_families(
    options: dict[str, Any],
    describe: dict[str, Any],
    location_tags: set[str] | None = None,
    machine_values: list[str] | None = None,
    table: str = "table",
) -> list[dict[str, Any]]:
    """[{key, speed, defects}] — the machines this block reads.

    With `output_col` set the table is bound explicitly (`_bind_columns`);
    otherwise machines are detected from `<machine>-<suffix>` column names.
    `describe` is `db.describe_table(...)`. Only numeric value and numeric array
    columns can feed a slot. `location_tags`, when given, narrows the columns to
    the tags at the block's location. A family without a speed column is not a
    machine this block can judge, so it is left out. Raises KpiOptionsError when
    nothing is left, so a block can never be saved reading nothing.
    """
    ts_col = options.get("ts_col")
    if not ts_col or ts_col not in describe.get("datetime_columns", describe.get("ts_columns", [])):
        raise KpiOptionsError("Choose the table's time column (options.kpi.ts_col) in block settings")
    if options.get("output_col"):
        return _bind_columns(options, describe, machine_values, table)
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
            "This table has no per-machine columns (like CAM001-13-count_1). "
            "Choose its Output column (and Machine column) in block settings; "
            "the Loss meter can also just count picked defect columns."
        )
    return families


def bind_sensors(options: dict[str, Any], describe: dict[str, Any], families: list[dict[str, Any]],
                 location_tags: set[str] | None = None) -> list[str]:
    """The sensor columns a block watches: chosen, or every numeric column no machine owns.

    Line 13's temperatures (`Temparature1-4`) are the columns left over once the
    camera families are taken out. A chosen column must be numeric.
    """
    numeric = list(dict.fromkeys(
        [c for c in describe.get("column_types", {})
         if c in set(describe.get("array_value_columns", [])) | set(describe.get("value_columns", []))]
    ))
    if location_tags is not None:
        numeric = [c for c in numeric if c in location_tags]
    if options.get("sensors") is None and options.get("output_col"):
        return []   # an explicitly bound table has no machine columns to subtract: sensors are chosen
    if options.get("sensors") is not None:
        bad = [c for c in options["sensors"] if c not in numeric]
        if bad:
            raise KpiOptionsError(f"options.kpi.sensors: not a numeric column: {', '.join(bad)}")
        return list(options["sensors"])
    owned = {f["key"] for f in families}
    taken = {c for g in group_by_family(numeric) if g["key"] for c in g["names"]}
    return [c for c in numeric if c not in taken and c not in owned]


def line_family(options: dict[str, Any], families: list[dict[str, Any]]) -> dict[str, Any]:
    """The family whose speed is the line's: the chosen one, else the first."""
    wanted = options.get("line_family")
    chosen = next((f for f in families if f["key"] == wanted), None) if wanted else None
    if wanted and chosen is None:
        raise KpiOptionsError(f"options.kpi.line_family {wanted!r} is not a machine of this table")
    return chosen or families[0]
