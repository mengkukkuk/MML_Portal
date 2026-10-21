"""Management-block showcase — a scripted Line 13 for the Live Loss meter, Andon
board and Loss waterfall.

Writes one table, ``zz_kpi_demo``, shaped exactly like the real ``sensor_log1``:
a row every 10 s, every reading a ``float8[4]`` of [value, 0, 10, -1], five
camera families ``CAM00{1-5}-13`` each with ``count_1..5`` and ``defect_1..5``
(rates per minute), plus ``Temparature1-4``. The clock column is a *naive*
``timestamp`` on purpose, so the plant-timezone path is exercised too.

Every loss rule has a case you can see:

* nights idle 17:30–07:00 (speed 0): long stops → not scheduled, never ฿
* CAM001 clean, ~7,500/min
* CAM002 runs slow, ~5,200/min → Slow, slow loss
* CAM003 a 54-min lunch stop daily (loss), a 3 h breakdown two days ago
  (09:00–12:00: not scheduled without working hours, loss with them), and a
  stop today 14:18–14:40
* CAM004 40-second dips every quarter hour → stay Run
* CAM005 its readings NULL 10:00–10:06 daily → No data, never Stop
* the whole table silent 15:00–15:05 today → No data everywhere
* ±2.78M glitches and negative defect values sprinkled in → filtered

Usage (datasource 569 "Mengkukkuk" is the local mmldata, schema vision_data):
    python simulate_kpi_showcase.py --datasource 569 --seed 8            # 8 days, exit
    python simulate_kpi_showcase.py --datasource 569 --seed 8 --follow   # then a row every 10 s
    python simulate_kpi_showcase.py --datasource 569 --drop              # remove it

Then on the Live page: Edit Layout → drag a management block → Block settings:
connection 569, table zz_kpi_demo, time recorded_at, ฿ per piece e.g. 12.
"""
from __future__ import annotations

import argparse
import random
import time
from datetime import datetime, time as clock, timedelta

from psycopg import sql

import plant_cli

TABLE = "zz_kpi_demo"
MARKER = "kpi showcase mock (simulate_kpi_showcase.py)"
STEP = timedelta(seconds=10)
CAMS = [f"CAM00{i}-13" for i in range(1, 6)]
REJECT_SHARE = [0.4, 0.25, 0.15, 0.12, 0.08]  # how a camera's rejects split across defect_1..5
REJECT_RATE = {"CAM001-13": 0.04, "CAM002-13": 0.05, "CAM003-13": 0.09, "CAM004-13": 0.05, "CAM005-13": 0.06}


def columns() -> list[str]:
    cols = []
    for cam in CAMS:
        cols += [f"{cam}-count_{n}" for n in range(1, 6)] + [f"{cam}-defect_{n}" for n in range(1, 6)]
    return cols + [f"Temparature{n}" for n in range(1, 5)]


def between(t: datetime, start: str, end: str) -> bool:
    return clock.fromisoformat(start) <= t.time() < clock.fromisoformat(end)


def speed_of(cam: str, t: datetime, today: datetime, rng: random.Random) -> float | None:
    """Pieces per minute for `cam` at `t` — the script every rule is checked against."""
    if not between(t, "07:00", "17:30"):
        return 0.0
    if cam == "CAM003-13":
        if between(t, "12:00", "12:54"):
            return 0.0
        if t.date() == (today - timedelta(days=2)).date() and between(t, "09:00", "12:00"):
            return 0.0
        if t.date() == today.date() and between(t, "14:18", "14:40"):
            return 0.0
    if cam == "CAM004-13" and t.minute % 15 == 7 and t.second < 40:
        return 0.0
    if cam == "CAM005-13" and between(t, "10:00", "10:06"):
        return None
    base = 5200 if cam == "CAM002-13" else 7500
    return max(0.0, rng.gauss(base, 120))


def row_at(t: datetime, today: datetime, rng: random.Random) -> list | None:
    """One table row, or None when the whole table is silent (a dropped link)."""
    if t.date() == today.date() and between(t, "15:00", "15:05"):
        return None
    out: list = [t]
    for cam in CAMS:
        speed = speed_of(cam, t, today, rng)
        if speed is not None and rng.random() < 0.0008:
            speed = rng.choice([2_780_000.0, -2_780_000.0])  # the real table's glitches
        counts = [[speed, 0.0, 10.0, -1.0] if speed is not None else None] + [[0.0, 0.0, 10.0, -1.0]] * 4
        defects = []
        for share in REJECT_SHARE:
            if speed is None:
                defects.append(None)
                continue
            rate = max(0.0, min(speed, 50_000)) * REJECT_RATE[cam] * share * rng.uniform(0.6, 1.4)
            if rng.random() < 0.0005:
                rate = -abs(rng.gauss(30_000, 5_000))  # negative junk
            defects.append([round(rate, 2), 0.0, 10.0, -1.0])
        out += counts + defects
    out += [[round(rng.gauss(26, 1.5), 1), 0.0, 10.0, -1.0] for _ in range(4)]
    return out


def is_mock(conn, schema: str) -> bool:
    row = conn.execute(
        "SELECT obj_description(c.oid) AS note FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = %s AND c.relname = %s", (schema, TABLE),
    ).fetchone()
    return row is not None and row["note"] == MARKER


def drop(conn, schema: str) -> None:
    exists = conn.execute("SELECT to_regclass(%s) AS t", (f"{schema}.{TABLE}",)).fetchone()["t"]
    if exists is None:
        print("nothing to drop")
        return
    if not is_mock(conn, schema):
        raise SystemExit(f"{schema}.{TABLE} is not this script's mock — refusing to drop it")
    conn.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(schema, TABLE)))
    conn.commit()
    print(f"dropped {schema}.{TABLE}")


def create(conn, schema: str) -> None:
    cols = [sql.SQL("recorded_at timestamp NOT NULL")] + [
        sql.SQL("{} float8[]").format(sql.Identifier(c)) for c in columns()
    ]
    conn.execute(sql.SQL("CREATE TABLE {} ({})").format(sql.Identifier(schema, TABLE), sql.SQL(", ").join(cols)))
    conn.execute(sql.SQL("CREATE INDEX ON {} (recorded_at)").format(sql.Identifier(schema, TABLE)))
    conn.execute(sql.SQL("COMMENT ON TABLE {} IS {}").format(sql.Identifier(schema, TABLE), sql.Literal(MARKER)))
    conn.commit()


def write(conn, schema: str, rows: list[list]) -> None:
    target = sql.SQL("COPY {} ({}) FROM STDIN").format(
        sql.Identifier(schema, TABLE),
        sql.SQL(", ").join(sql.Identifier(c) for c in ["recorded_at", *columns()]),
    )
    with conn.cursor() as cur, cur.copy(target) as copy:
        for r in rows:
            copy.write_row(r)
    conn.commit()


def seed(conn, schema: str, days: int, rng: random.Random) -> datetime:
    now = datetime.now().replace(microsecond=0)
    today = now.replace(hour=0, minute=0, second=0)
    t = today - timedelta(days=days)
    t -= timedelta(seconds=t.second % 10)
    batch, total = [], 0
    while t <= now:
        if (r := row_at(t, today, rng)) is not None:
            batch.append(r)
        if len(batch) >= 5000:
            write(conn, schema, batch)
            total += len(batch)
            batch = []
        t += STEP
    write(conn, schema, batch)
    total += len(batch)
    print(f"seeded {total} rows into {schema}.{TABLE}")
    return t


def follow(conn, schema: str, after: datetime, rng: random.Random) -> None:
    t = after
    while True:
        now = datetime.now()
        while t <= now:
            today = now.replace(hour=0, minute=0, second=0, microsecond=0)
            if (r := row_at(t, today, rng)) is not None:
                write(conn, schema, [r])
            t += STEP
        time.sleep(max(0.5, (t - datetime.now()).total_seconds()))


def main() -> None:
    parser = argparse.ArgumentParser(description="Management-block showcase: scripted zz_kpi_demo")
    parser.add_argument("--seed", type=int, metavar="DAYS", help="Recreate the table with this many days up to now")
    parser.add_argument("--follow", action="store_true", help="Keep writing a row every 10 s")
    parser.add_argument("--drop", action="store_true", help="Drop the mock table")
    parser.add_argument("--schema", default="vision_data", help="Plant schema the app reads (default vision_data)")
    parser.add_argument("--random-seed", type=int, default=13)
    plant_cli.add_target_args(parser)
    args = parser.parse_args()
    if not (args.seed or args.follow or args.drop):
        parser.error("nothing to do — pass --seed DAYS, --follow or --drop")
    rng = random.Random(args.random_seed)
    with plant_cli.connect(args) as conn:
        if args.drop or args.seed:
            drop(conn, args.schema)
            if not args.seed and not args.follow:
                return
        if args.seed:
            create(conn, args.schema)
            after = seed(conn, args.schema, args.seed, rng)
        else:
            last = conn.execute(sql.SQL("SELECT max(recorded_at) AS last FROM {}").format(
                sql.Identifier(args.schema, TABLE))).fetchone()["last"]
            after = (last or datetime.now()) + STEP
        if args.follow:
            try:
                follow(conn, args.schema, after, rng)
            except KeyboardInterrupt:
                print("stopped")


if __name__ == "__main__":
    main()
