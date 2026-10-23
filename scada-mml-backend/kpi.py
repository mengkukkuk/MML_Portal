"""Management-block figures for the Live grid (`/api/kpi`).

One summary feeds every management block — Loss meter, Andon board, Loss
waterfall, KPI strip, hourly rate, plan pace, sensor strip, response board,
7-day trend and defect Pareto — so they can never disagree: the same buckets,
the same states, the same losses, read different ways. Sections only one block
type uses (sensors, responses, the 7-day trend, the Pareto, the timelines) are
computed for that block type only.

* `GET /summary?panel_id=` — for a saved block. The binding and settings are
  read from the stored panel, never from the query, so a viewer cannot point
  the server at another table or try settings of their own.
* `POST /preview` — admin only, for the inspector's unsaved settings. Validated
  exactly as a save would be (kpi_options.py).

**Line or machines.** Line 13 is one line: the cameras along it inspect the
same pieces. In `scope: "line"` (the default) output, run and stop come from
one camera family's speed (`line_family`, else the first) and a reject caught
by any camera is a reject of the line; the per-camera figures stay available
for the Andon board. In `scope: "machines"` every family is its own machine and
the totals add up.

Cost is money the management board reads; `strip_cost` removes every ฿ figure
and the price for roles that may not see it, here on the server rather than in
the browser.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta
from typing import Any, Callable

import psycopg
from psycopg_pool import PoolTimeout
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

import alert_events
import db
import kpi_engine as engine
from auth import can_see_cost, get_current_user, require_admin
from kpi_cache import CACHE, TARGET_WINDOW
from kpi_options import (
    KPI_CHART_TYPES, MAX_MACHINES, KpiOptionsError, bind_families, bind_picked, bind_sensors,
    columns_layout, counts_picked_columns, line_family, normalize_kpi_options,
)
from licensing import require_valid_license
from panels import location_tags

logger = logging.getLogger("mml-api.kpi")

router = APIRouter(
    prefix="/api/kpi",
    tags=["kpi"],
    dependencies=[Depends(require_valid_license)],
)

STRIP_WINDOW = timedelta(hours=24)
TREND_DAYS = 7
# How long after an incident began a parameter change still counts as its response.
RESPONSE_WINDOW = timedelta(hours=4)
# Alert rows the Response board reads per period, newest first. A writer that
# logs every ten seconds fills a week with ~60k rows; past this the oldest are
# left out and `truncated` says so.
MAX_ALERT_ROWS = 5000
# Events the board sends; the per-role counts still cover every event.
MAX_ALERT_EVENTS = 100
# Timeline resolution per period: fine enough to see a stop, few enough points to draw.
TIMELINE_MIN = {"today": 5, "week": 60, "month": 360}
HOURLY_MIN = {"today": 60, "week": 1440, "month": 1440}

NO_READINGS_NOTICE = (
    "No readings in this period. A table that keeps only the latest row per machine cannot show "
    "run and stop — use a log table that adds a row for every reading."
)

WANTS = {
    "timeline": {"pace", "hourly"},
    "sensors": {"sensors", "kpistrip", "kpitrend"},
    # sensor incidents paired with parameter changes: the KPI strip's incident and
    # response-time tiles
    "response": {"kpistrip"},
    # the Response board: the plant's alert messages and who has to act on them
    "alerts": {"response"},
    "trend": {"kpitrend"},
    "pareto": {"pareto"},
}


class KpiPreviewIn(BaseModel):
    chart_type: str
    table_name: str | None = None
    datasource_id: int | None = None
    options: dict = {}


def _first_line(e: Exception) -> str:
    text = str(e).strip()
    return text.splitlines()[0] if text else e.__class__.__name__


def _now() -> datetime:
    """Plant-local now. The server runs at the plant, so its zone is the plant's."""
    return datetime.now().astimezone()


def _engine_settings(kpi: dict[str, Any]) -> dict[str, Any]:
    return {k: kpi[k] for k in ("run_ratio", "min_stop_sec", "max_loss_stop_min", "working_hours")}


def _figures(acc: dict[str, Any]) -> dict[str, float]:
    return {
        "pieces": acc["pieces"], "defects": acc["defects"], "good": acc["good"],
        "stop_loss": acc["stop_loss"], "slow_loss": acc["slow_loss"], "pending": acc["pending"],
        "potential": acc["potential"], "lost": acc["stop_loss"] + acc["slow_loss"],
    }


def _baht(figures: dict[str, float], price: float | None) -> dict[str, float] | None:
    if price is None:
        return None
    return {
        "defects": figures["defects"] * price,
        "lost": figures["lost"] * price,
        "stop_loss": figures["stop_loss"] * price,
        "slow_loss": figures["slow_loss"] * price,
        "pending": figures["pending"] * price,
        "potential": figures["potential"] * price,
        "good": figures["good"] * price,
        "total": (figures["defects"] + figures["lost"]) * price,
    }


def _sum(rows: list[dict[str, float]]) -> dict[str, float]:
    keys = ("pieces", "defects", "good", "stop_loss", "slow_loss", "pending", "potential", "lost")
    return {k: sum(r[k] for r in rows) for k in keys}


def _ratio(a: float | None, b: float | None) -> float | None:
    return a / b if a is not None and b else None


def _period_end(period: str, start: datetime) -> datetime:
    """Where the calendar period ends — the plan line runs to here."""
    if period == "today":
        return start + timedelta(days=1)
    if period == "week":
        return start + timedelta(days=7)
    nxt = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    return nxt


def _plan_clock(start: datetime, full_end: datetime, hours: dict[str, Any] | None) -> Callable[[datetime], int]:
    """planned(t): minutes of [start, t) the plan runs over — working hours if set, else all.

    Built once per summary as a prefix sum, so the plan line costs one pass over
    the period however many timeline rows ask for it.
    """
    if not hours:
        return lambda t: max(0, int((min(t, full_end) - start).total_seconds() // 60))
    prefix, n, t = [0], 0, start
    while t < full_end:
        n += engine.in_working_hours(t, hours)
        prefix.append(n)
        t += timedelta(minutes=1)
    return lambda t: prefix[max(0, min(len(prefix) - 1, int((t - start).total_seconds() // 60)))]


def _combine(accs: list[dict[str, Any]]) -> dict[str, Any]:
    """Several machines' accounts as one, for `scope: "machines"`.

    Figures add up; a minute's state is the one most machines were in, ties to
    the worse one — the timeline's grey "stopped" band means most of the plant
    was stopped, not that one machine was.
    """
    figures = _sum([_figures(a) for a in accs])
    n = len(accs[0]["grid"]) if accs else 0
    grid, marks, loss = [], [], []
    for i in range(n):
        grid.append({
            "minute": accs[0]["grid"][i]["minute"],
            "pieces": sum(a["grid"][i].get("pieces") or 0 for a in accs),
            "defects": sum(a["grid"][i].get("defects") or 0 for a in accs),
        })
        loss.append(sum(a["minute_loss"][i] for a in accs))
        counts: dict[str, int] = {}
        for a in accs:
            counts[a["marks"][i]] = counts.get(a["marks"][i], 0) + 1
        marks.append(max(counts, key=lambda st: (counts[st], -engine.STATE_RANK.get(st, 9))))
    minutes = {k: sum(a["minutes"][k] for a in accs) for k in accs[0]["minutes"]} if accs else {}
    scheduled = sum(minutes.get(k, 0) for k in (engine.RUN, engine.SLOW, engine.STOP))
    run_pct = round(100 * (minutes.get(engine.RUN, 0) + minutes.get(engine.SLOW, 0)) / scheduled) \
        if scheduled else None
    return {**figures, "grid": grid, "marks": marks, "minute_loss": loss, "minutes": minutes,
            "run_pct": run_pct}


def _fetch_errors(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except psycopg.errors.QueryCanceled:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="The plant database took too long to answer — try a shorter period")
    except psycopg.Error as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=f"Could not reach the selected connection: {_first_line(e)}")


def _aware(t: Any, tz) -> datetime | None:
    if not isinstance(t, datetime):
        return None
    return t if t.tzinfo else t.replace(tzinfo=tz)


_MACHINE_TTL_S = 300
_machine_cache: dict[tuple, tuple[float, list[str]]] = {}


def machine_values(table: str, datasource_id: int | None, kpi: dict[str, Any]) -> list[str] | None:
    """The machine column's distinct values, or None when the table is one machine.

    One more than MAX_MACHINES are asked for, so a column with too many values
    is recognised (and refused by `bind_families`) instead of silently cut.
    Kept five minutes: the machines of a table change rarely, and finding them
    scans the table.
    """
    col = kpi.get("machine_col")
    if not col or not kpi.get("output_col"):
        return None
    key = (datasource_id, table, col)
    hit = _machine_cache.get(key)
    if hit and time.monotonic() - hit[0] < _MACHINE_TTL_S:
        return hit[1]
    values = _fetch_errors(lambda: db.distinct_column_values(table, col, MAX_MACHINES + 1, datasource_id))
    if len(_machine_cache) > 256:
        _machine_cache.clear()
    _machine_cache[key] = (time.monotonic(), values)
    return values


def _tag_places(datasource_id: int | None, changes: list[dict[str, Any]]) -> dict[str, str]:
    """Each tag's location: variables_tag when the plant keeps one, else where its changes were logged.

    A Response board filtered to one location keeps the incidents on that
    location's tags. A sensor has no location of its own in the table it is read
    from, so the plant's tag list says where it is; a plant without one still
    logs a location with every parameter change, and the latest says it.
    """
    places: dict[str, str] = {}
    for c in changes:
        if c.get("tag") and c.get("location"):
            places[c["tag"]] = c["location"]
    try:
        rows = db.tag_locations(datasource_id=datasource_id)
    except (ValueError, psycopg.Error):
        rows = []
    for r in rows:
        if r.get("tag_name") and r.get("location"):
            places[r["tag_name"]] = r["location"]
    return places


def alert_board(kpi: dict[str, Any], start: datetime, end: datetime) -> dict[str, Any]:
    """The Response board: the plant's alert messages in [start, end) as events, and who must act.

    Reads the one alert source set in Settings (alert_messages.py), whatever
    table the block's figures come from. Each alert is routed by the response
    roles: the row's own role tag first, else the rule for its location, else a
    catch-all — and `via` says which, so an alert that only reached the
    catch-all because its location is spelled differently from its rule ("L13"
    against "Line 13") is visible rather than quietly mis-assigned. Never an
    error for "nothing to show": no source or an unreachable one answers with
    `available: false` and a reason, as the report trend does.
    """
    source = db.get_alert_source()
    if source is None:
        return {"configured": False, "available": False, "reason": "not_configured"}
    base = {"configured": True, "table": source["table_name"], "connection": source.get("datasource_name"),
            "routed_by": source.get("match_filter"), "role_col": source.get("role_col")}
    try:
        rows = db.read_alert_messages(source, start, end, [], MAX_ALERT_ROWS + 1)
    except ValueError as e:
        return {**base, "available": False, "reason": "missing", "detail": _first_line(e)}
    except (psycopg.Error, PoolTimeout) as e:
        return {**base, "available": False, "reason": "unreachable", "detail": _first_line(e)}
    try:
        rules = db.list_response_roles()
    except psycopg.Error:
        rules = []

    located = source.get("match_filter") == "location"
    where = kpi["response_location"]
    floor = kpi["alert_min_severity"]
    alerts, counts = [], {s: 0 for s in alert_events.SEVERITIES}
    # every place the alerts name, and those no rule names (they reach a catch-all)
    places: dict[str, str | None] = {}
    for r in rows[:MAX_ALERT_ROWS]:
        if r.get("ts") is None or not (r.get("message") or "").strip() or r["ts"] >= end:
            continue
        place = r.get("match_value") if located else None
        if place and place.strip() and place.strip() not in places:
            places[place.strip()] = db.route_response_role(rules, location=place)[1]
        if where is not None and not db.same_location(place, where):
            continue
        severity = db.severity_of(r.get("severity"))
        counts[severity] += 1
        if not alert_events.at_least(severity, floor):
            continue
        role, via = db.route_response_role(rules, location=place, explicit=r.get("role_value"))
        alerts.append({"ts": r["ts"], "message": r["message"].strip(), "severity": severity,
                       "location": place, "role": role, "via": via})
    events = alert_events.group_events(alerts)
    return {
        **base, "available": True,
        "min_severity": floor,
        "alerts": counts,
        "shown_alerts": len(alerts),
        "events": events[:MAX_ALERT_EVENTS],
        "event_count": len(events),
        "by_role": alert_events.by_role(events),
        "locations": sorted(places),
        "unmatched": sorted(p for p, via in places.items() if via != "location"),
        # who an unmatched location's alerts go to (None: nobody — they are unassigned)
        "catch_all": db.route_response_role(rules, location=None)[0],
        "truncated": len(rows) > MAX_ALERT_ROWS,
    }


def summarize_picked(table: str, datasource_id: int | None, kpi: dict[str, Any], cols: dict[str, Any],
                     now: datetime | None = None) -> dict[str, Any]:
    """The Loss meter's summary when it counts picked columns instead of machines.

    Defects are the picked columns summed over the rows stamped in the period —
    nothing is derived per minute, so there are no machines, stops or targets,
    and the summary carries only what the Loss meter reads.
    """
    try:
        bound = bind_picked(kpi, cols)
    except KpiOptionsError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    now = now or _now()
    start, prev_start, end = engine.period_bounds(kpi["period"], now)
    prev_end = prev_start + (end - start)
    flt_col, flt_val = bound["filter"] or (None, None)
    tally = _fetch_errors(lambda: db.kpi_tally(
        datasource_id, table, bound["ts_col"], bound["defect_cols"], array_mode=kpi["array_mode"],
        filter_col=flt_col, filter_val=flt_val, start=start, end=end, prev_start=prev_start,
        prev_end=prev_end, valid_max=kpi["valid_max"]))

    def figures(defects: float) -> dict[str, float]:
        return {"pieces": 0.0, "defects": defects, "good": 0.0, "stop_loss": 0.0, "slow_loss": 0.0,
                "pending": 0.0, "potential": 0.0, "lost": 0.0}

    price = kpi["cost_per_piece"]
    totals = figures(tally["cur"])
    out: dict[str, Any] = {
        "generated_at": now,
        "period": {"name": kpi["period"], "start": start, "end": end,
                   "full_end": _period_end(kpi["period"], start),
                   "elapsed_min": int((end - start).total_seconds() // 60)},
        "scope": "columns",
        "line_family": None,
        "families": [],
        "totals": totals,
        "rows_in_period": tally["cur_rows"],
        "unscheduled_min": 0,
        "cost_per_piece": price,
        "plan": None,
        "settings": {"max_loss_stop_min": kpi["max_loss_stop_min"], "run_ratio": kpi["run_ratio"],
                     "working_hours": kpi["working_hours"], "mode": "defects", "metrics": kpi["metrics"],
                     "flat_min": kpi["flat_min"]},
        "metrics": {"defects": tally["cur"]},
    }
    if (b := _baht(totals, price)) is not None:
        out["totals"]["baht"] = b
        out["metrics"]["baht"] = {"cost_total": tally["cur"] * price}
    if kpi["compare"]:
        out["compare"] = figures(tally["prev"])
        if (b := _baht(out["compare"], price)) is not None:
            out["compare"]["baht"] = b
    return out


def summarize(
    table: str | None,
    datasource_id: int | None,
    raw_options: Any,
    now: datetime | None = None,
    chart_type: str | None = None,
) -> dict[str, Any]:
    """The full (unstripped) summary for one block binding.

    `chart_type` picks the optional sections to compute; None gives the core
    only (families, totals, comparison).
    """
    want = {k for k, types in WANTS.items() if chart_type in types}
    if not table:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="This block isn't bound to a table yet")
    try:
        kpi = normalize_kpi_options(raw_options)
    except KpiOptionsError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    try:
        cols = db.describe_table(table, datasource_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Table not allowed: {table!r}")
    except psycopg.Error as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=f"Could not reach the selected connection: {_first_line(e)}")
    if counts_picked_columns(kpi, chart_type):
        return summarize_picked(table, datasource_id, kpi, cols)
    loc_tags = location_tags(kpi.get("location"), datasource_id)
    layout = columns_layout(kpi)
    try:
        families = bind_families(kpi, cols, loc_tags, machine_values(table, datasource_id, kpi), table)
        line_fam = line_family(kpi, families) if kpi["scope"] == "line" else None
        sensors = bind_sensors(kpi, cols, families, loc_tags) if "sensors" in want else []
    except KpiOptionsError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    now = now or _now()
    tz = now.tzinfo
    start, prev_start, end = engine.period_bounds(kpi["period"], now)
    elapsed = end - start
    pad = engine.context_pad(kpi)
    trend_start = end.replace(hour=0, minute=0) - timedelta(days=TREND_DAYS - 1)
    fetch_from = min(start, end - STRIP_WINDOW, end - TARGET_WINDOW) - pad
    if kpi["compare"]:
        fetch_from = min(fetch_from, prev_start - pad)
    if "trend" in want:
        fetch_from = min(fetch_from, trend_start - pad)

    ts_col = kpi["ts_col"]
    layout_key = None if layout is None else (
        layout["machine_col"], layout["value_kind"], layout["filter"])
    binding = (datasource_id, table, ts_col, kpi["stop_threshold"], kpi["valid_max"], kpi["sample_sec"],
               layout_key)

    def fetch(fams, lo, hi):
        return db.kpi_minute_buckets(
            datasource_id, table, ts_col, fams, lo, hi,
            stop_threshold=kpi["stop_threshold"], valid_max=kpi["valid_max"], sample_sec=kpi["sample_sec"],
            layout=layout,
        )

    buckets = _fetch_errors(lambda: CACHE.buckets(binding, families, fetch_from, end, fetch))

    settings = _engine_settings(kpi)
    price = kpi["cost_per_piece"]
    targets: dict[str, float | None] = {}
    accs: dict[str, dict[str, Any]] = {}
    family_list, unscheduled = [], 0
    for fam in families:
        series = buckets.get(fam["key"], [])
        typed = kpi["targets"].get(fam["key"])
        if typed is not None:
            target, source = float(typed), "set"
        else:
            history = [b for b in series if b["minute"] >= end - TARGET_WINDOW]
            target = CACHE.target((*binding, fam["key"], fam["speed"]), history)
            source = "auto" if target is not None else "none"
        targets[fam["key"]] = target

        acc = engine.family_summary(series, target, settings, start, end, True, (start - pad, end))
        accs[fam["key"]] = acc
        day_start = end - STRIP_WINDOW
        day = engine.family_summary(series, target, settings, day_start, end, True, (day_start - pad, end))
        state, since = engine.current_state(day["states"], day["grid"])
        last = day["grid"][-1] if day["grid"] else None
        figures = _figures(acc)
        if line_fam is None:
            unscheduled += acc["minutes"][engine.OFF]
        family = {
            "key": fam["key"],
            "label": fam["key"],
            "speed_col": fam["speed"],
            "defect_cols": fam["defects"],
            "is_line": line_fam is not None and fam["key"] == line_fam["key"],
            "state": state,
            "state_since": since,
            "speed": engine.mean_speed(last) if last and state in (engine.RUN, engine.SLOW) else 0,
            "target": target,
            "target_source": source,
            "run_pct": acc["run_pct"],
            "minutes": acc["minutes"],
            "strip": engine.strip(day["marks"], day["grid"]),
            **figures,
        }
        if (b := _baht(figures, price)) is not None:
            family["baht"] = b
        if not series:
            logger.info("KPI family %s on %s.%s has no rows in range", fam["key"], datasource_id, table)
        family_list.append(family)

    # --- the reference: the line, or the machines added up ----------------------
    line_series = None
    if line_fam is not None:
        line_series = engine.line_buckets(buckets.get(line_fam["key"], []),
                                          [buckets.get(f["key"], []) for f in families])

    def reference(lo: datetime, hi: datetime, live: bool, ctx: tuple[datetime, datetime]) -> dict[str, Any]:
        if line_series is not None:
            acc = engine.family_summary(line_series, targets[line_fam["key"]], settings, lo, hi, live, ctx)
            return {**_figures(acc), "grid": acc["grid"], "marks": acc["marks"],
                    "minute_loss": acc["minute_loss"], "minutes": acc["minutes"], "run_pct": acc["run_pct"]}
        parts = [engine.family_summary(buckets.get(f["key"], []), targets[f["key"]], settings, lo, hi, live, ctx)
                 for f in families]
        return _combine(parts)

    ref = reference(start, end, True, (start - pad, end)) if line_series is not None \
        else _combine(list(accs.values()))
    if line_series is not None:
        unscheduled = ref["minutes"][engine.OFF]
    totals = {k: ref[k] for k in ("pieces", "defects", "good", "stop_loss", "slow_loss", "pending",
                                  "potential", "lost")}

    # --- plan ----------------------------------------------------------------------
    full_end = _period_end(kpi["period"], start)
    hours = kpi["working_hours"]
    plan, planned = None, None
    if kpi["plan_pieces"] is not None:
        planned = _plan_clock(start, full_end, hours)
        planned_total = planned(full_end)
        to_date = kpi["plan_pieces"] * planned(end) / planned_total if planned_total else 0.0
        plan = {"total": kpi["plan_pieces"], "to_date": to_date}

    out: dict[str, Any] = {
        "generated_at": now,
        "period": {"name": kpi["period"], "start": start, "end": end, "full_end": full_end,
                   "elapsed_min": int(elapsed.total_seconds() // 60)},
        "scope": kpi["scope"],
        "line_family": line_fam["key"] if line_fam else None,
        "families": family_list,
        "totals": totals,
        "unscheduled_min": unscheduled,
        "cost_per_piece": price,
        "plan": plan,
        "settings": {"max_loss_stop_min": kpi["max_loss_stop_min"], "run_ratio": kpi["run_ratio"],
                     "working_hours": hours, "mode": kpi["mode"], "metrics": kpi["metrics"],
                     "flat_min": kpi["flat_min"], "response_location": kpi["response_location"]},
    }
    if (b := _baht(totals, price)) is not None:
        out["totals"]["baht"] = b
    if layout is not None and not any(start <= b["minute"] < end for series in buckets.values() for b in series):
        # An explicitly bound table with nothing in the period reads as a wall of "No data". Say why:
        # the usual cause is a table that keeps only each machine's latest row, which has no history
        # to judge run and stop from.
        out["notice"] = NO_READINGS_NOTICE

    if kpi["compare"]:
        prev_end = prev_start + elapsed
        ctx_end = min(prev_end + pad, end)
        prev = reference(prev_start, prev_end, ctx_end == end, (prev_start - pad, ctx_end))
        prev_totals = {k: prev[k] for k in totals if k != "baht"}
        out["compare"] = prev_totals
        if (b := _baht(prev_totals, price)) is not None:
            out["compare"]["baht"] = b

    # --- timelines: plan pace and hourly ---------------------------------------------
    if "timeline" in want:
        size = TIMELINE_MIN[kpi["period"]]
        rows = engine.timeline(ref["grid"], ref["marks"], ref["minute_loss"], size)
        good = potential = 0.0
        for r in rows:
            good += r["good"]
            potential += r["potential"]
            r["good_cum"], r["potential_cum"] = good, potential
            r_end = r["start"] + timedelta(minutes=r["minutes"])
            if plan:
                total_min = planned(full_end)
                r["plan_cum"] = plan["total"] * planned(r_end) / total_min if total_min else 0.0
        out["timeline"] = {"size_min": size, "rows": rows}
        hourly = engine.timeline(ref["grid"], ref["marks"], ref["minute_loss"], HOURLY_MIN[kpi["period"]])
        out["hourly"] = {"size_min": HOURLY_MIN[kpi["period"]], "rows": [
            {**h, "rate": _ratio(h["defects"], h["pieces"])} for h in hourly]}

    # --- sensors, incidents, responses ----------------------------------------------
    risk_pieces = blind_min = None
    incident_list: list[dict[str, Any]] = []
    sensor_minutes: dict[str, list[dict[str, Any]]] = {}
    if sensors:
        flat_pad = timedelta(minutes=kpi["flat_min"])
        s_from = min(start, trend_start if "trend" in want else start) - flat_pad
        s_binding = ("sensors", datasource_id, table, ts_col, kpi["sample_sec"])
        pseudo = [{"key": c, "speed": c, "defects": []} for c in sensors]
        sensor_minutes = _fetch_errors(lambda: CACHE.buckets(
            s_binding, pseudo, s_from, end,
            lambda fams, lo, hi: db.kpi_sensor_minutes(datasource_id, table, ts_col, [f["key"] for f in fams],
                                                       lo, hi, sample_sec=kpi["sample_sec"])))

    def sensor_window(lo: datetime, hi: datetime, ref_marks: list[str], ref_grid: list[dict[str, Any]],
                      live: bool) -> tuple[list[dict[str, Any]], float, int, list[dict[str, Any]]]:
        """Per-sensor states over [lo, hi), and what they mean for the line there."""
        n = len(ref_grid)
        risky, blind = [False] * n, [False] * n
        rows, found = [], []
        for col in sensors:
            ctx = lo - timedelta(minutes=kpi["flat_min"])
            grid = engine.minute_grid(sensor_minutes.get(col, []), ctx, hi)
            states = engine.sensor_states(grid, kpi["flat_min"])
            k = int((lo - ctx).total_seconds() // 60)
            grid, states = grid[k:], states[k:]
            for i, st in enumerate(states[:n]):
                risky[i] |= st in (engine.OUT, engine.FLAT)
                blind[i] |= st in (engine.FLAT, engine.MISSING)
            last = next((g for g in reversed(grid) if g.get("last") is not None), None)
            counts = {st: states.count(st) for st in (engine.OK, engine.OUT, engine.FLAT, engine.MISSING)}
            rows.append({
                "key": col,
                "state": states[-1] if states else None,
                "minutes": counts,
                "strip": engine.strip(states, grid),
                "last": {k2: last.get(k2) for k2 in ("last", "setpoint", "high", "low")} if last else None,
            })
            for inc in engine.incidents(states, grid, ref_grid, live=live):
                found.append({"tag": col, **inc})
        # blind time counts only while the line's own state is known: a table
        # that logged nothing is already "No data" on the Andon board
        scheduled = [m in (engine.RUN, engine.SLOW, engine.STOP) for m in ref_marks]
        risk = sum((ref_grid[i].get("pieces") or 0) for i in range(n) if risky[i])
        blind_n = sum(1 for i in range(n) if blind[i] and scheduled[i])
        return rows, risk, blind_n, found

    if sensors:
        sensor_rows, risk_pieces, blind_min, incident_list = sensor_window(start, end, ref["marks"], ref["grid"], True)
        out["sensors"] = sensor_rows

    avg_response = None
    if "response" in want:
        events = []
        if sensors:
            events = _fetch_errors(lambda: db.kpi_event_rows(datasource_id, sensors, start - RESPONSE_WINDOW, end))
        try:
            rules = db.list_response_roles()
        except psycopg.Error:
            rules = []
        changes = []
        for e in events:
            at = _aware(e.get("at_date_time"), tz)
            changes.append({"tag": e.get("tag_name"), "at": at, "by": e.get("who"), "event": e.get("event"),
                            "location": e.get("location")})
        where = kpi["response_location"]
        tag_place = _tag_places(datasource_id, changes)
        if where is not None:
            incident_list = [x for x in incident_list if db.same_location(tag_place.get(x["tag"]), where)]
            changes = [c for c in changes if db.same_location(c["location"], where)]
        for inc in incident_list:
            reply = next((c for c in changes
                          if c["tag"] == inc["tag"] and c["at"] and inc["start"] <= c["at"] <= inc["start"] + RESPONSE_WINDOW),
                         None)
            inc["response_min"] = round((reply["at"] - inc["start"]).total_seconds() / 60) if reply else None
            inc["by"] = reply["by"] if reply else None
            inc["action"] = reply["event"] if reply else None
            inc["location"] = where or tag_place.get(inc["tag"])
            place = where or kpi.get("location") or (reply or {}).get("location") or inc["location"]
            inc["role"] = db.match_response_role(rules, location=place)
        incident_list.sort(key=lambda x: x["start"])
        answered = [x["response_min"] for x in incident_list if x.get("response_min") is not None]
        avg_response = sum(answered) / len(answered) if answered else None
        out["incidents"] = incident_list
        out["changes"] = [c for c in changes if c["at"] and c["at"] >= start][-50:]

    if "alerts" in want:
        out["alerts"] = alert_board(kpi, start, end)

    # --- headline metrics (the KPI strip) ----------------------------------------------
    metrics: dict[str, Any] = {
        "good": totals["good"], "pieces": totals["pieces"], "defects": totals["defects"],
        "lost": totals["lost"],
        "yield": _ratio(totals["good"], totals["pieces"]),
        "defect_rate": _ratio(totals["defects"], totals["pieces"]),
        "availability": ref["run_pct"] / 100 if ref["run_pct"] is not None else None,
        "plan_pct": _ratio(totals["good"], plan["to_date"]) if plan else None,
        "risk_pieces": risk_pieces, "blind_min": blind_min,
        "incidents": len(incident_list) if sensors else None,
        "avg_response_min": avg_response,
        "stop_min": ref["minutes"].get(engine.STOP),
    }
    if price is not None:
        metrics["baht"] = {"cost_total": (totals["defects"] + totals["lost"]) * price}
    out["metrics"] = metrics

    # --- 7-day trend ----------------------------------------------------------------------
    if "trend" in want:
        days = []
        for d in range(TREND_DAYS):
            lo = trend_start + timedelta(days=d)
            hi = min(lo + timedelta(days=1), end)
            if hi <= lo:
                continue
            live = hi == end
            r = reference(lo, hi, live, (lo - pad, min(hi + pad, end)))
            day = {"date": lo, "pieces": r["pieces"], "defects": r["defects"], "good": r["good"], "lost": r["lost"],
                   "yield": _ratio(r["good"], r["pieces"]),
                   "availability": r["run_pct"] / 100 if r["run_pct"] is not None else None}
            if sensors:
                _, _, day["blind_min"], _ = sensor_window(lo, hi, r["marks"], r["grid"], live)
            if price is not None:
                day["baht"] = {"lost": r["lost"] * price, "defects": r["defects"] * price}
            days.append(day)
        out["days"] = days

    # --- defect Pareto ---------------------------------------------------------------------
    if "pareto" in want:
        items = []
        for fam in families:
            for j, col in enumerate(fam["defects"]):
                n = sum((b.get("parts") or [0] * len(fam["defects"]))[j]
                        for b in buckets.get(fam["key"], []) if start <= b["minute"] < end)
                if n > 0:
                    kind = col[len(fam["key"]) + 1:] if col.startswith(f"{fam['key']}-") else col
                    items.append({"item": f"{fam['key']} · {kind}",
                                  "family": fam["key"], "column": col, "defects": n})
        items.sort(key=lambda x: -x["defects"])
        total = sum(x["defects"] for x in items)
        acc = 0.0
        for x in items:
            acc += x["defects"]
            x["cum_share"] = acc / total if total else 0.0
            if price is not None:
                x["baht"] = {"defects": x["defects"] * price}
        out["pareto"] = {"total": total, "items": items}
    return out


# A block's summary for the current minute, shared by every poll inside it.
_MINUTE_MEMO: dict[tuple, tuple[datetime, dict[str, Any]]] = {}
_MINUTE_MEMO_MAX = 256


def minute_summary(table: str | None, datasource_id: int | None, raw_options: Any,
                   chart_type: str | None, now: datetime | None = None) -> dict[str, Any]:
    """`summarize`, computed at most once per block per minute.

    Every figure stops at the start of the current minute (`period_bounds`: the
    open minute is still being written), and so does the alert board, so a
    block's answer cannot change until the next minute begins. A board polling
    every 5 or 10 s then costs one computation per block per minute rather than
    one per poll — 10 blocks at ~0.5 s each would otherwise outrun a 5 s poll.
    The key is the block's whole binding, so a changed setting is a new entry.
    Errors are not kept: the next poll tries again.
    """
    now = now or _now()
    minute = now.replace(second=0, microsecond=0)
    key = (table, datasource_id, json.dumps(raw_options, sort_keys=True, default=str), chart_type)
    hit = _MINUTE_MEMO.get(key)
    if hit and hit[0] == minute:
        return hit[1]
    out = summarize(table, datasource_id, raw_options, now=now, chart_type=chart_type)
    if len(_MINUTE_MEMO) >= _MINUTE_MEMO_MAX:
        for k in [k for k, (m, _) in _MINUTE_MEMO.items() if m != minute]:
            del _MINUTE_MEMO[k]
        if len(_MINUTE_MEMO) >= _MINUTE_MEMO_MAX:
            _MINUTE_MEMO.clear()
    _MINUTE_MEMO[key] = (minute, out)
    return out


def for_user(summary: dict[str, Any], user: dict) -> dict[str, Any]:
    """`summary` as `user` may see it."""
    if can_see_cost(user):
        return {**summary, "cost_visible": True}
    return {**engine.strip_cost(summary), "cost_visible": False}


@router.get("/summary")
def get_summary(panel_id: int = Query(..., ge=1), user: dict = Depends(get_current_user)) -> dict[str, Any]:
    panel = db.get_panel(panel_id)
    if panel is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Panel not found")
    if panel.get("source") != "kpi":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not a management block")
    options = panel.get("options") or {}
    return for_user(minute_summary(panel.get("table_name"), panel.get("datasource_id"), options.get("kpi"),
                                   panel.get("chart_type")), user)


@router.post("/preview")
def preview(body: KpiPreviewIn, admin: dict = Depends(require_admin)) -> dict[str, Any]:
    if body.chart_type not in KPI_CHART_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not a management block")
    return for_user(summarize(body.table_name, body.datasource_id, (body.options or {}).get("kpi"),
                              chart_type=body.chart_type), admin)
