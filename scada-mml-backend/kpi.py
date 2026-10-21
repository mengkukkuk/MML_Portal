"""Management-block figures for the Live grid (`/api/kpi`).

One summary feeds all three block types — Loss meter, Andon board and Loss
waterfall — so they can never disagree: the same buckets, the same states, the
same losses, read three ways.

* `GET /summary?panel_id=` — for a saved block. The binding and settings are
  read from the stored panel, never from the query, so a viewer cannot point
  the server at another table or try settings of their own.
* `POST /preview` — admin only, for the inspector's unsaved settings. Validated
  exactly as a save would be (kpi_options.py).

Cost is money the management board reads; `strip_cost` removes every ฿ figure
and the price for roles that may not see it, here on the server rather than in
the browser.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

import db
import kpi_engine as engine
from auth import can_see_cost, get_current_user, require_admin
from kpi_cache import CACHE, TARGET_WINDOW
from kpi_options import KPI_CHART_TYPES, KpiOptionsError, bind_families, normalize_kpi_options
from licensing import require_valid_license
from panels import location_tags

logger = logging.getLogger("mml-api.kpi")

router = APIRouter(
    prefix="/api/kpi",
    tags=["kpi"],
    dependencies=[Depends(require_valid_license)],
)

STRIP_WINDOW = timedelta(hours=24)


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


def summarize(
    table: str | None,
    datasource_id: int | None,
    raw_options: Any,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The full (unstripped) summary for one block binding."""
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
    try:
        families = bind_families(kpi, cols, location_tags(kpi.get("location"), datasource_id))
    except KpiOptionsError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    now = now or _now()
    start, prev_start, end = engine.period_bounds(kpi["period"], now)
    elapsed = end - start
    pad = engine.context_pad(kpi)
    fetch_from = min(start, end - STRIP_WINDOW, end - TARGET_WINDOW) - pad
    if kpi["compare"]:
        fetch_from = min(fetch_from, prev_start - pad)

    ts_col = kpi["ts_col"]
    binding = (datasource_id, table, ts_col, kpi["stop_threshold"], kpi["valid_max"], kpi["sample_sec"])

    def fetch(fams, lo, hi):
        return db.kpi_minute_buckets(
            datasource_id, table, ts_col, fams, lo, hi,
            stop_threshold=kpi["stop_threshold"], valid_max=kpi["valid_max"], sample_sec=kpi["sample_sec"],
        )

    try:
        buckets = CACHE.buckets(binding, families, fetch_from, end, fetch)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except psycopg.errors.QueryCanceled:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="The plant database took too long to answer — try a shorter period")
    except psycopg.Error as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail=f"Could not reach the selected connection: {_first_line(e)}")

    settings = _engine_settings(kpi)
    price = kpi["cost_per_piece"]
    rows, prev_rows, family_list, unscheduled = [], [], [], 0
    for fam in families:
        series = buckets.get(fam["key"], [])
        typed = kpi["targets"].get(fam["key"])
        if typed is not None:
            target, source = float(typed), "set"
        else:
            history = [b for b in series if b["minute"] >= end - TARGET_WINDOW]
            target = CACHE.target((*binding, fam["key"], fam["speed"]), history)
            source = "auto" if target is not None else "none"

        acc = engine.family_summary(series, target, settings, start, end, True, (start - pad, end))
        day_start = end - STRIP_WINDOW
        day = engine.family_summary(series, target, settings, day_start, end, True, (day_start - pad, end))
        state, since = engine.current_state(day["states"], day["grid"])
        last = day["grid"][-1] if day["grid"] else None
        figures = _figures(acc)
        unscheduled += acc["minutes"][engine.OFF]
        rows.append(figures)
        family = {
            "key": fam["key"],
            "label": fam["key"],
            "speed_col": fam["speed"],
            "defect_cols": fam["defects"],
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
        if kpi["compare"]:
            prev_end = prev_start + elapsed
            ctx_end = min(prev_end + pad, end)
            prev = engine.family_summary(series, target, settings, prev_start, prev_end,
                                         ctx_end == end, (prev_start - pad, ctx_end))
            prev_rows.append(_figures(prev))
        if not series:
            logger.info("KPI family %s on %s.%s has no rows in range", fam["key"], datasource_id, table)
        family_list.append(family)

    totals = _sum(rows)
    out: dict[str, Any] = {
        "generated_at": now,
        "period": {"name": kpi["period"], "start": start, "end": end,
                   "elapsed_min": int(elapsed.total_seconds() // 60)},
        "families": family_list,
        "totals": totals,
        "unscheduled_min": unscheduled,
        "cost_per_piece": price,
        "settings": {"max_loss_stop_min": kpi["max_loss_stop_min"], "run_ratio": kpi["run_ratio"],
                     "working_hours": kpi["working_hours"], "mode": kpi["mode"]},
    }
    if (b := _baht(totals, price)) is not None:
        out["totals"]["baht"] = b
    if kpi["compare"]:
        prev_totals = _sum(prev_rows) if prev_rows else None
        out["compare"] = prev_totals
        if prev_totals is not None and (b := _baht(prev_totals, price)) is not None:
            out["compare"]["baht"] = b
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
    return for_user(summarize(panel.get("table_name"), panel.get("datasource_id"), options.get("kpi")), user)


@router.post("/preview")
def preview(body: KpiPreviewIn, admin: dict = Depends(require_admin)) -> dict[str, Any]:
    if body.chart_type not in KPI_CHART_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not a management block")
    return for_user(summarize(body.table_name, body.datasource_id, (body.options or {}).get("kpi")), admin)
