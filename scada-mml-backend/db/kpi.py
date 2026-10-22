"""Minute buckets for the Live management blocks (kpi_engine.py's input).

One query per table and range reduces raw plant rows to one row per minute with
every machine family's figures side by side, so only minutes cross the
(often VPN) link — never the 10-second rows themselves.

Each row covers the time since the row before it (`lag(ts)`), capped at three
sample intervals: a longer silence is a gap, and the row then covers one
interval only. A row is *valid* for a family when that family's speed lies in
[0, valid_max]; anything else — NULL, a negative, a ±2.78M glitch — covers
nothing, so it turns into gap rather than into production. Speeds and defect
columns are rates per minute, so pieces = rate × covered seconds / 60.
"""
from datetime import datetime
from typing import Any

from psycopg import sql

from . import tables as _tables

__all__ = [
    "KPI_STATEMENT_TIMEOUT_MS", "_kpi_value", "kpi_event_rows", "kpi_minute_buckets", "kpi_minute_query",
    "kpi_minute_query_long", "kpi_sensor_minutes", "kpi_sensor_query", "kpi_tally", "kpi_tally_query",
]

# A cold month over the VPN must fail loudly rather than pin a worker.
KPI_STATEMENT_TIMEOUT_MS = 20_000


def _kpi_value(columns: dict[str, str], col: str) -> sql.Composable:
    """A column's reading as float8 — slot 0 of a numeric array, the value itself otherwise."""
    if columns[col].startswith("_"):
        return sql.SQL("({}[1])::float8").format(sql.Identifier(col))
    return sql.SQL("({})::float8").format(sql.Identifier(col))


def _family_aggs(i: int, sp: sql.Composable, df: sql.Composable, parts: list[sql.Composable],
                 member: sql.Composable | None = None) -> list[sql.Composable]:
    """The per-minute aggregates of family `i`, from its speed, defect and per-defect columns.

    `member`, when given, restricts every aggregate to the rows that belong to
    the family — the machine column names it in a long table, where one row
    holds one machine's reading rather than every machine's side by side.
    """
    def only(cond: sql.Composable) -> sql.Composable:
        return sql.SQL("{} AND {}").format(member, cond) if member is not None else cond

    valid = only(sql.SQL("{} BETWEEN 0 AND %(vmax)s").format(sp))
    running = only(sql.SQL("{sp} > %(stop)s AND {sp} <= %(vmax)s").format(sp=sp))
    stopped = only(sql.SQL("{} BETWEEN 0 AND %(stop)s").format(sp))
    aggs = [
        sql.SQL("coalesce(sum(cov) FILTER (WHERE {}), 0) AS {}").format(valid, sql.Identifier(f"valid_{i}")),
        sql.SQL("coalesce(sum(cov) FILTER (WHERE {}), 0) AS {}").format(stopped, sql.Identifier(f"stop_{i}")),
        sql.SQL("coalesce(sum({sp}) FILTER (WHERE {r}), 0) AS {out}").format(
            sp=sp, r=running, out=sql.Identifier(f"ssum_{i}")),
        sql.SQL("count(*) FILTER (WHERE {r}) AS {out}").format(r=running, out=sql.Identifier(f"sn_{i}")),
        sql.SQL("coalesce(sum({sp} * cov / 60) FILTER (WHERE {v}), 0) AS {out}").format(
            sp=sp, v=valid, out=sql.Identifier(f"pcs_{i}")),
        sql.SQL("coalesce(sum({df} * cov / 60) FILTER (WHERE {v}), 0) AS {out}").format(
            df=df, v=valid, out=sql.Identifier(f"def_{i}")),
    ]
    return aggs + [
        sql.SQL("coalesce(sum({df} * cov / 60) FILTER (WHERE {v}), 0) AS {out}").format(
            df=part, v=valid, out=sql.Identifier(f"part_{i}_{j}"))
        for j, part in enumerate(parts)
    ]


def kpi_minute_query(
    columns: dict[str, str],
    schema: str,
    table: str,
    ts_col: str,
    families: list[dict[str, Any]],
) -> sql.Composed:
    """The bucket query for `families` ([{key, speed, defects: [...]}]).

    Parameters, by name: lo, hi (aware bounds), cap_s, sample_s, stop, vmax.
    Every identifier is checked against `columns` first; values never enter the
    SQL text.
    """
    for fam in families:
        for col in [fam["speed"], *fam["defects"]]:
            if col not in columns:
                raise ValueError(f"Unknown column {col!r} in {table!r}")
    if ts_col not in columns:
        raise ValueError(f"Unknown timestamp column {ts_col!r} in {table!r}")

    naive = columns[ts_col] == "timestamp without time zone"
    clock = sql.Identifier(ts_col)
    ts = sql.SQL("({} AT TIME ZONE current_setting('TimeZone'))").format(clock) if naive else clock
    lo = sql.SQL("(%(lo)s::timestamptz AT TIME ZONE current_setting('TimeZone'))") if naive else sql.SQL("%(lo)s")
    hi = sql.SQL("(%(hi)s::timestamptz AT TIME ZONE current_setting('TimeZone'))") if naive else sql.SQL("%(hi)s")

    picks = [sql.SQL("{} AS ts").format(ts)]
    aggs = []
    for i, fam in enumerate(families):
        sp, df = sql.Identifier(f"sp_{i}"), sql.Identifier(f"df_{i}")
        picks.append(sql.SQL("{} AS {}").format(_kpi_value(columns, fam["speed"]), sp))
        defect_terms = [
            sql.SQL("CASE WHEN {v} BETWEEN 0 AND %(vmax)s THEN {v} ELSE 0 END").format(v=_kpi_value(columns, c))
            for c in fam["defects"]
        ] or [sql.SQL("0")]
        picks.append(sql.SQL("({}) AS {}").format(sql.SQL(" + ").join(defect_terms), df))
        # each defect column on its own too, for the Pareto (which camera, which type)
        for j, term in enumerate(defect_terms if fam["defects"] else []):
            picks.append(sql.SQL("({}) AS {}").format(term, sql.Identifier(f"df_{i}_{j}")))
        aggs += _family_aggs(
            i, sp, df, [sql.Identifier(f"df_{i}_{j}") for j in range(len(fam["defects"]))])

    return sql.SQL(
        "WITH r AS (SELECT {picks} FROM {tbl} "
        "WHERE {clock} >= {lo_pad} AND {clock} < {hi}), "
        "c AS (SELECT *, extract(epoch FROM ts - lag(ts) OVER (ORDER BY ts)) AS delta FROM r), "
        "d AS (SELECT *, CASE WHEN delta <= %(cap_s)s THEN delta ELSE %(sample_s)s END AS cov "
        "FROM c WHERE delta IS NOT NULL AND ts >= %(lo)s) "
        "SELECT date_trunc('minute', ts) AS minute, {aggs} FROM d GROUP BY 1 ORDER BY 1"
    ).format(
        picks=sql.SQL(", ").join(picks),
        tbl=sql.Identifier(schema, table),
        clock=clock,
        lo_pad=sql.SQL("{} - make_interval(secs => %(cap_s)s)").format(lo),
        hi=hi,
        aggs=sql.SQL(", ").join(aggs),
    )


def kpi_minute_query_long(
    columns: dict[str, str],
    schema: str,
    table: str,
    ts_col: str,
    families: list[dict[str, Any]],
    layout: dict[str, Any],
) -> sql.Composed:
    """The bucket query for a *long* table: one row per reading, the machine named in a column.

    Every family shares the output and defect columns (`families[0]`); a family
    is the rows whose `layout["machine_col"]` equals its key (all rows when the
    table is one machine). The gap to the previous reading is measured within a
    machine — rows of other machines interleave — and each family's aggregates
    only see its own rows, so the buckets come out exactly as `kpi_minute_query`'s.

    `layout["value_kind"]` "rate" reads the columns as pieces per minute;
    "total" reads running counters, whose positive change over the covered time is
    the rate, so a counter reset or glitch counts as nothing. Parameters, by name:
    the wide query's, plus mkeys and mk_<i> (a family's machine value) and, with a
    row filter, fval.
    """
    first = families[0]
    machine_col, kind, flt = layout.get("machine_col"), layout.get("value_kind", "rate"), layout.get("filter")
    used = [ts_col, first["speed"], *first["defects"], *([machine_col] if machine_col else []),
            *([flt[0]] if flt else [])]
    for col in used:
        if col not in columns:
            raise ValueError(f"Unknown column {col!r} in {table!r}")
    ts, clock, lo, hi = _clock_terms(columns, ts_col)
    machine = sql.SQL("({})::text").format(sql.Identifier(machine_col)) if machine_col else sql.SQL("'x'::text")

    value_cols = [first["speed"], *first["defects"]]
    picks = [sql.SQL("{} AS ts").format(ts), sql.SQL("{} AS m").format(machine)]
    picks += [sql.SQL("{} AS {}").format(_kpi_value(columns, c), sql.Identifier(f"v_{k}"))
              for k, c in enumerate(value_cols)]
    lags = [sql.SQL("lag({v}) OVER w AS {p}").format(v=sql.Identifier(f"v_{k}"), p=sql.Identifier(f"p_{k}"))
            for k in range(len(value_cols))] if kind == "total" else []

    def rate(k: int) -> sql.Composable:
        v, p = sql.Identifier(f"v_{k}"), sql.Identifier(f"p_{k}")
        if kind == "total":
            return sql.SQL("CASE WHEN {v} >= {p} THEN ({v} - {p}) / cov * 60 END").format(v=v, p=p)
        return v

    rates = [sql.SQL("{} AS {}").format(rate(k), sql.Identifier(f"r_{k}")) for k in range(len(value_cols))]
    defect_terms = [
        sql.SQL("CASE WHEN {r} BETWEEN 0 AND %(vmax)s THEN {r} ELSE 0 END").format(r=sql.Identifier(f"r_{k}"))
        for k in range(1, len(value_cols))
    ] or [sql.SQL("0")]
    d_extra = [sql.SQL("({}) AS df").format(sql.SQL(" + ").join(defect_terms))]
    d_extra += [sql.SQL("({}) AS {}").format(t, sql.Identifier(f"df_{j}")) for j, t in enumerate(defect_terms)
                if first["defects"]]

    aggs = []
    for i, fam in enumerate(families):
        member = sql.SQL("m = %(mk_{})s").format(sql.SQL(str(i)))
        aggs += _family_aggs(i, sql.Identifier("r_0"), sql.Identifier("df"),
                             [sql.Identifier(f"df_{j}") for j in range(len(first["defects"]))], member)

    where = [sql.SQL("{c} >= {lo_pad} AND {c} < {hi}").format(
        c=clock, lo_pad=sql.SQL("{} - make_interval(secs => %(cap_s)s)").format(lo), hi=hi)]
    if machine_col:
        where.append(sql.SQL("{} = ANY(%(mkeys)s::text[])").format(machine))
    if flt:
        where.append(sql.SQL("{}::text = %(fval)s").format(sql.Identifier(flt[0])))
    return sql.SQL(
        "WITH r AS (SELECT {picks} FROM {tbl} WHERE {where}), "
        "c AS (SELECT *, extract(epoch FROM ts - lag(ts) OVER w) AS delta{lags} FROM r "
        "WINDOW w AS (PARTITION BY m ORDER BY ts)), "
        "k AS (SELECT *, CASE WHEN delta <= %(cap_s)s THEN delta ELSE %(sample_s)s END AS cov "
        "FROM c WHERE delta IS NOT NULL AND ts >= %(lo)s), "
        "d AS (SELECT *, {rates} FROM k), "
        "e AS (SELECT *, {d_extra} FROM d) "
        "SELECT date_trunc('minute', ts) AS minute, {aggs} FROM e GROUP BY 1 ORDER BY 1"
    ).format(
        picks=sql.SQL(", ").join(picks),
        tbl=sql.Identifier(schema, table),
        where=sql.SQL(" AND ").join(where),
        lags=sql.SQL("").join(sql.SQL(", {}").format(l) for l in lags),
        rates=sql.SQL(", ").join(rates),
        d_extra=sql.SQL(", ").join(d_extra),
        aggs=sql.SQL(", ").join(aggs),
    )


def kpi_minute_buckets(
    datasource_id: int | None,
    table: str,
    ts_col: str,
    families: list[dict[str, Any]],
    start: datetime,
    end: datetime,
    *,
    stop_threshold: float = 0.0,
    valid_max: float,
    sample_sec: float = 10.0,
    layout: dict[str, Any] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """{family key: [bucket, ...]} for minutes in [start, end).

    `layout` (kpi_options.columns_layout) says the table is long — read by
    `kpi_minute_query_long` — rather than wide.

    Only minutes with at least one row come back; kpi_engine.minute_grid fills
    the rest as gap.
    """
    if not families:
        return {}
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        columns = _tables._table_columns(conn, schema, table)
        params = {
            "lo": start, "hi": end, "cap_s": 3 * sample_sec, "sample_s": sample_sec,
            "stop": stop_threshold, "vmax": valid_max,
        }
        if layout:
            query = kpi_minute_query_long(columns, schema, table, ts_col, families, layout)
            params["mkeys"] = [fam["key"] for fam in families]
            params.update({f"mk_{i}": fam["key"] if layout.get("machine_col") else "x"
                           for i, fam in enumerate(families)})
            if layout.get("filter"):
                params["fval"] = layout["filter"][1]
        else:
            query = kpi_minute_query(columns, schema, table, ts_col, families)
        with conn.transaction():
            conn.execute(sql.SQL("SET LOCAL statement_timeout = {}").format(sql.Literal(KPI_STATEMENT_TIMEOUT_MS)))
            rows = conn.execute(query, params).fetchall()
    out: dict[str, list[dict[str, Any]]] = {fam["key"]: [] for fam in families}
    for row in rows:
        for i, fam in enumerate(families):
            valid = min(60.0, float(row[f"valid_{i}"]))
            out[fam["key"]].append({
                "minute": row["minute"],
                "valid_s": valid,
                "stop_s": min(valid, float(row[f"stop_{i}"])),
                "gap_s": max(0.0, 60.0 - valid),
                "speed_sum": float(row[f"ssum_{i}"]),
                "speed_n": int(row[f"sn_{i}"]),
                "pieces": float(row[f"pcs_{i}"]),
                "defects": float(row[f"def_{i}"]),
                "parts": [float(row[f"part_{i}_{j}"]) for j in range(len(fam["defects"]))],
            })
    return out


def _tally_term(columns: dict[str, str], col: str, array_mode: str) -> sql.Composable:
    """One picked column's count for a row, as float8 and never negative or a glitch.

    A numeric array adds all its elements ("sum") or reads element 1 ("first");
    a flag counts as 0 or 1. Values outside [0, vmax] count as nothing, the same
    rule the minute buckets apply to a ±2.78M sensor glitch.
    """
    ident = sql.Identifier(col)
    kind = columns[col]
    if kind.startswith("_"):
        if array_mode == "first":
            v = sql.SQL("({}[1])::float8").format(ident)
            return sql.SQL("CASE WHEN {v} BETWEEN 0 AND %(vmax)s THEN {v} ELSE 0 END").format(v=v)
        return sql.SQL(
            "(SELECT coalesce(sum(CASE WHEN e::float8 BETWEEN 0 AND %(vmax)s THEN e::float8 ELSE 0 END), 0) "
            "FROM unnest({}) AS e)"
        ).format(ident)
    if kind == "boolean":
        return sql.SQL("(CASE WHEN {} THEN 1 ELSE 0 END)::float8").format(ident)
    v = sql.SQL("({})::float8").format(ident)
    return sql.SQL("CASE WHEN {v} BETWEEN 0 AND %(vmax)s THEN {v} ELSE 0 END").format(v=v)


def kpi_tally_query(
    columns: dict[str, str],
    schema: str,
    table: str,
    ts_col: str,
    cols: list[str],
    array_mode: str,
    filter_col: str | None,
) -> sql.Composed:
    """Sum of `cols` over rows stamped in the current and the previous range.

    Parameters, by name: lo, hi, plo, phi (aware bounds), vmax, and fval when
    `filter_col` is set. Every identifier is checked against `columns`.
    """
    for col in [ts_col, *cols, *([filter_col] if filter_col else [])]:
        if col not in columns:
            raise ValueError(f"Unknown column {col!r} in {table!r}")
    if not cols:
        raise ValueError("Nothing to count")
    ts, clock, lo, hi = _clock_terms(columns, ts_col)
    plo = sql.SQL("(%(plo)s::timestamptz AT TIME ZONE current_setting('TimeZone'))")         if columns[ts_col] == "timestamp without time zone" else sql.SQL("%(plo)s")
    phi = sql.SQL("(%(phi)s::timestamptz AT TIME ZONE current_setting('TimeZone'))")         if columns[ts_col] == "timestamp without time zone" else sql.SQL("%(phi)s")
    total = sql.SQL(" + ").join([_tally_term(columns, c, array_mode) for c in cols])
    where = [sql.SQL("({c} >= {lo} AND {c} < {hi}) OR ({c} >= {plo} AND {c} < {phi})").format(
        c=clock, lo=lo, hi=hi, plo=plo, phi=phi)]
    if filter_col:
        where.append(sql.SQL("{}::text = %(fval)s").format(sql.Identifier(filter_col)))
    cur = sql.SQL("{c} >= {lo} AND {c} < {hi}").format(c=clock, lo=lo, hi=hi)
    prev = sql.SQL("{c} >= {plo} AND {c} < {phi}").format(c=clock, plo=plo, phi=phi)
    return sql.SQL(
        "SELECT coalesce(sum(t) FILTER (WHERE is_cur), 0) AS cur, "
        "coalesce(sum(t) FILTER (WHERE is_prev), 0) AS prev, "
        "count(*) FILTER (WHERE is_cur) AS cur_rows "
        "FROM (SELECT ({total}) AS t, ({cur}) AS is_cur, ({prev}) AS is_prev FROM {tbl} WHERE {where}) q"
    ).format(
        total=total, cur=cur, prev=prev, tbl=sql.Identifier(schema, table),
        where=sql.SQL(" AND ").join(sql.SQL("({})").format(w) for w in where),
    )


def kpi_tally(
    datasource_id: int | None,
    table: str,
    ts_col: str,
    cols: list[str],
    *,
    array_mode: str,
    filter_col: str | None,
    filter_val: str | None,
    start: datetime,
    end: datetime,
    prev_start: datetime,
    prev_end: datetime,
    valid_max: float,
) -> dict[str, float]:
    """{cur, prev, cur_rows}: the picked columns summed over the two ranges."""
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        columns = _tables._table_columns(conn, schema, table)
        query = kpi_tally_query(columns, schema, table, ts_col, cols, array_mode, filter_col)
        params = {"lo": start, "hi": end, "plo": prev_start, "phi": prev_end, "vmax": valid_max}
        if filter_col:
            params["fval"] = filter_val
        with conn.transaction():
            conn.execute(sql.SQL("SET LOCAL statement_timeout = {}").format(sql.Literal(KPI_STATEMENT_TIMEOUT_MS)))
            row = conn.execute(query, params).fetchone()
    return {"cur": float(row["cur"]), "prev": float(row["prev"]), "cur_rows": int(row["cur_rows"])}


def _clock_terms(columns: dict[str, str], ts_col: str):
    """(ts select, clock column, lo bound, hi bound) — naive columns in the connection's zone."""
    naive = columns[ts_col] == "timestamp without time zone"
    clock = sql.Identifier(ts_col)
    tz = "current_setting('TimeZone')"
    ts = sql.SQL("({} AT TIME ZONE " + tz + ")").format(clock) if naive else clock
    lo = sql.SQL("(%(lo)s::timestamptz AT TIME ZONE " + tz + ")") if naive else sql.SQL("%(lo)s")
    hi = sql.SQL("(%(hi)s::timestamptz AT TIME ZONE " + tz + ")") if naive else sql.SQL("%(hi)s")
    return ts, clock, lo, hi


def kpi_sensor_query(columns: dict[str, str], schema: str, table: str, ts_col: str,
                     sensors: list[str]) -> sql.Composed:
    """Per minute, per sensor: coverage, value range, last reading and limits, out-of-band time.

    A numeric array reads [value, setpoint, high, low] from slots 1..4 — the
    plant's own layout. A scalar column has no limits, so it can be missing or
    frozen but never out of band. Parameters: lo, hi, cap_s, sample_s.
    """
    for col in [ts_col, *sensors]:
        if col not in columns:
            raise ValueError(f"Unknown column {col!r} in {table!r}")
    ts, clock, lo, hi = _clock_terms(columns, ts_col)

    def slot(col: str, n: int) -> sql.Composable:
        if columns[col].startswith("_"):
            return sql.SQL("({}[{}])::float8").format(sql.Identifier(col), sql.Literal(n))
        return sql.SQL("({})::float8").format(sql.Identifier(col)) if n == 1 else sql.SQL("NULL::float8")

    picks, aggs = [sql.SQL("{} AS ts").format(ts)], []
    for i, col in enumerate(sensors):
        v, sp, hi_c, lo_c = (sql.Identifier(f"{k}_{i}") for k in ("v", "sp", "hi", "lo"))
        picks += [sql.SQL("{} AS {}").format(slot(col, n), name)
                  for n, name in ((1, v), (2, sp), (3, hi_c), (4, lo_c))]

        def last(name, v=v):
            return sql.SQL("(array_agg({x} ORDER BY ts DESC) FILTER (WHERE {v} IS NOT NULL))[1]").format(x=name, v=v)

        aggs += [
            sql.SQL("coalesce(sum(cov) FILTER (WHERE {v} IS NOT NULL), 0) AS {o}").format(
                v=v, o=sql.Identifier(f"valid_{i}")),
            sql.SQL("coalesce(sum(cov) FILTER (WHERE {v} > {h} OR {v} < {l}), 0) AS {o}").format(
                v=v, h=hi_c, l=lo_c, o=sql.Identifier(f"out_{i}")),
            sql.SQL("min({v}) AS {o}").format(v=v, o=sql.Identifier(f"vmin_{i}")),
            sql.SQL("max({v}) AS {o}").format(v=v, o=sql.Identifier(f"vmax_{i}")),
            sql.SQL("{} AS {}").format(last(v), sql.Identifier(f"last_{i}")),
            sql.SQL("{} AS {}").format(last(sp), sql.Identifier(f"sp_{i}")),
            sql.SQL("{} AS {}").format(last(hi_c), sql.Identifier(f"hi_{i}")),
            sql.SQL("{} AS {}").format(last(lo_c), sql.Identifier(f"lo_{i}")),
        ]
    return sql.SQL(
        "WITH r AS (SELECT {picks} FROM {tbl} WHERE {clock} >= {lo_pad} AND {clock} < {hi}), "
        "c AS (SELECT *, extract(epoch FROM ts - lag(ts) OVER (ORDER BY ts)) AS delta FROM r), "
        "d AS (SELECT *, CASE WHEN delta <= %(cap_s)s THEN delta ELSE %(sample_s)s END AS cov "
        "FROM c WHERE delta IS NOT NULL AND ts >= %(lo)s) "
        "SELECT date_trunc('minute', ts) AS minute, {aggs} FROM d GROUP BY 1 ORDER BY 1"
    ).format(
        picks=sql.SQL(", ").join(picks), tbl=sql.Identifier(schema, table), clock=clock,
        lo_pad=sql.SQL("{} - make_interval(secs => %(cap_s)s)").format(lo), hi=hi,
        aggs=sql.SQL(", ").join(aggs),
    )


def kpi_sensor_minutes(datasource_id: int | None, table: str, ts_col: str, sensors: list[str],
                       start: datetime, end: datetime, *, sample_sec: float = 10.0,
                       ) -> dict[str, list[dict[str, Any]]]:
    """{sensor column: [minute bucket, ...]} for [start, end) — kpi_engine.sensor_states' input."""
    if not sensors:
        return {}
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        columns = _tables._table_columns(conn, schema, table)
        query = kpi_sensor_query(columns, schema, table, ts_col, sensors)
        with conn.transaction():
            conn.execute(sql.SQL("SET LOCAL statement_timeout = {}").format(sql.Literal(KPI_STATEMENT_TIMEOUT_MS)))
            rows = conn.execute(query, {"lo": start, "hi": end, "cap_s": 3 * sample_sec,
                                        "sample_s": sample_sec}).fetchall()

    def num(v):
        return None if v is None else float(v)

    out: dict[str, list[dict[str, Any]]] = {col: [] for col in sensors}
    for row in rows:
        for i, col in enumerate(sensors):
            valid = min(60.0, float(row[f"valid_{i}"]))
            out[col].append({
                "minute": row["minute"], "valid_s": valid, "gap_s": max(0.0, 60.0 - valid),
                "out_s": min(valid, float(row[f"out_{i}"])),
                "vmin": num(row[f"vmin_{i}"]), "vmax": num(row[f"vmax_{i}"]), "last": num(row[f"last_{i}"]),
                "setpoint": num(row[f"sp_{i}"]), "high": num(row[f"hi_{i}"]), "low": num(row[f"lo_{i}"]),
            })
    return out


def kpi_event_rows(datasource_id: int | None, tags: list[str], start: datetime, end: datetime,
                   limit: int = 500) -> list[dict[str, Any]]:
    """Parameter-change rows for `tags` from the plant's event_logs, oldest first.

    The Response board pairs each out-of-band incident with the first change
    someone made to that tag afterwards. A plant without event_logs — or without
    a `user` column — is normal: it gives no rows, or rows without a name.
    """
    if not tags:
        return []
    with _tables._table_source_conn(datasource_id) as (conn, schema):
        try:
            columns = _tables._table_columns(conn, schema, "event_logs")
        except ValueError:
            return []
        who = sql.Identifier("user") if "user" in columns else sql.SQL("NULL")
        return conn.execute(
            sql.SQL(
                "SELECT location, tag_name, event, at_date_time, {who} AS who FROM {tbl} "
                "WHERE tag_name = ANY(%s) AND at_date_time >= %s AND at_date_time < %s "
                "ORDER BY at_date_time LIMIT %s"
            ).format(who=who, tbl=sql.Identifier(schema, "event_logs")),
            (tags, start, end, limit),
        ).fetchall()
