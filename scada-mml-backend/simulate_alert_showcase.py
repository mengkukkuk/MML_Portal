"""Alert-message showcase — a mock Line 13 and the alerts its analysis raises.

Writes two tables into one plant schema and keeps them in step:

* ``sensor_log1`` — a stand-in for the real Line 13 table: one row every 10 s,
  each reading a ``float8[4]`` of [value, setpoint, high limit, low limit] the way
  the plant writes them, so the Reports signal trend draws its envelope. Two
  readings: ``CAM001-13-count_1`` (line speed) and ``CAM001-13-defect_1``
  (defect rate, %). The line runs with stops, speed dips, overspeed and defect
  bursts scripted in, so there is something to alert on.
* ``alert_messages`` — what an analysis job would write after reading those
  rows (see sch_vision_data.sql): a message the moment a reading leaves its
  band, and another when the line comes back. Each alert carries the timestamp
  of the row that raised it, so on the trend every flag lands on the excursion
  that caused it — and in ``--live`` mode both tables grow together, every 10 s.

The mock table is marked with a table comment and nothing here will write to,
or drop, a ``sensor_log1`` that does not carry it — the real one lives in the
plant database under the same name. Alerts are written with
``source = 'showcase'`` so ``--purge`` removes only this script's rows.

``--tick-alerts`` adds a condition check on *every* row as well — one message
every 10 s, rotating through speed band, defect limit, setpoint deviation and
defect trend, each with the severity the reading earns — so a live showcase
never goes quiet between incidents. With ``--seed`` the checks also cover the
last hour of the backfill (not all of it: 24 h of them is 8,640 rows). The
trend reads at most 2,000 messages per window, so after ~5 h of ticks a 24 h
window shows the newest 2,000 and says so.

Usage (datasource 569 "Mengkukkuk" is the local mmldata, schema vision_data):
    python simulate_alert_showcase.py --datasource 569 --seed 24          # 24 h, exit
    python simulate_alert_showcase.py --datasource 569 --seed 24 --live   # then keep going
    python simulate_alert_showcase.py --datasource 569 --seed 24 --live --tick-alerts
    python simulate_alert_showcase.py --datasource 569 --purge            # remove it all
    python simulate_alert_showcase.py --datasource 569 --live --maint-role 4   # stops tagged for role 4

Then Settings -> Alert messages (one source for every trend): connection =
the one written to here, table alert_messages, time created_at, message
message, severity severity, follows Location on location. Reports: table
sensor_log1, reading CAM001-13-count_1, time recorded_at. Pointing the source
here moves it off any real alert table — set it back afterwards.

``--maint-role ID`` tags the stop alerts ("Line 13 stopped" / "restarted") with
that Response-role ID in ``role_id`` — the way an analysis job that knows a
stop is a maintenance call would — so a Response board shows rows routed by
their own tag beside rows routed by location. It takes effect once the alert
source's Role ID column is set to ``role_id``.
"""
import argparse
import random
import time
from collections import deque
from pathlib import Path
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg import sql

import plant_cli

MARKER = "showcase mock (simulate_alert_showcase.py)"
SCHEMA_FILE = Path(__file__).with_name("sch_vision_data.sql")
SCHEMA_SECTION = "-- Alert messages: one row per alert"
SOURCE = "showcase"
STEP = timedelta(seconds=10)

LOCATION = "L13"
# Alerts a --maint-role tags: a stop is the maintenance team's call.
MAINT_PREFIXES = ("Line 13 stopped", "Line 13 restarted")
CAMERA = "CAM001-13"
SPEED = f"{CAMERA}-count_1"
DEFECT = f"{CAMERA}-defect_1"

# The speed envelope, pcs/min — as on the real line, where count_1 runs ~7.5k.
SPEED_SP, SPEED_HI, SPEED_LO = 7500.0, 8000.0, 7000.0
# Defect rate, %.
DEFECT_SP, DEFECT_HI, DEFECT_LO = 0.8, 2.0, 0.0

# A reading must stay out of its band this long before it is an alert, so one
# noisy sample does not raise a flag. Same rule live and in the backfill.
HOLD = timedelta(seconds=30)
# Under this share of the low limit the line is stopping, not running slow: the
# ramp down belongs to the stop. And a restart ramps up through the low band, so
# "below low limit" waits this long after one before it may be raised — without
# both, every stop arrives bracketed by a pair of false low-speed alerts.
STOP_SHARE = 0.3
RAMP_GRACE = timedelta(minutes=2)

# (kind, weight, minutes low..high). What the scripted line does between runs.
EPISODES = [
    ("stop", 1.0, (4, 20)),
    ("dip", 2.0, (3, 10)),
    ("overspeed", 1.0, (2, 6)),
    ("defects", 1.5, (3, 12)),
]
SHIFTS = {6: "A", 14: "B", 22: "C"}

# --tick-alerts: "near" a limit is within this share of the band's width of it,
# and the defect trend compares the newest reading with the one a minute back.
NEAR_SHARE = 0.1
TREND_ROWS = 6
TREND_RISE = 0.5  # percentage points per minute
TICK_HISTORY = timedelta(hours=1)


# --- the line -------------------------------------------------------------------
@dataclass
class Line:
    """The mock machine: runs, and now and then does one scripted thing."""
    rng: random.Random
    episode: str | None = None
    until: datetime | None = None
    next_at: datetime | None = None
    dip_to: float = 0.0
    speed: float = SPEED_SP

    def _schedule(self, ts: datetime) -> None:
        self.next_at = ts + timedelta(minutes=self.rng.uniform(25, 70))

    def sample(self, ts: datetime) -> tuple[list[float], list[float]]:
        if self.next_at is None:
            self._schedule(ts)
        if self.episode and ts >= self.until:
            self.episode = None
            self._schedule(ts)
        if not self.episode and ts >= self.next_at:
            kinds, weights, spans = zip(*EPISODES)
            i = self.rng.choices(range(len(kinds)), weights=weights)[0]
            self.episode = kinds[i]
            self.until = ts + timedelta(minutes=self.rng.uniform(*spans[i]))
            self.dip_to = self.rng.uniform(6200, 6850)

        target = {
            "stop": 0.0,
            "dip": self.dip_to,
            "overspeed": self.rng.uniform(8150, 8400),
        }.get(self.episode, SPEED_SP)
        # A machine ramps; it does not teleport between speeds.
        self.speed += (target - self.speed) * (0.6 if self.episode == "stop" else 0.35)
        speed = 0.0 if self.speed < 40 else self.speed + self.rng.gauss(0, 60) * (self.speed > 0)

        if speed <= 0:
            defect = 0.0
        elif self.episode == "defects":
            defect = self.rng.uniform(2.3, 4.5)
        else:
            defect = max(0.0, self.rng.gauss(DEFECT_SP, 0.25))
        return ([round(max(speed, 0.0), 1), SPEED_SP, SPEED_HI, SPEED_LO],
                [round(defect, 3), DEFECT_SP, DEFECT_HI, DEFECT_LO])


# --- the analysis -----------------------------------------------------------------
@dataclass
class Watch:
    """One condition: out since `since`, alerted yet, worst value seen."""
    since: datetime | None = None
    raised: datetime | None = None
    worst: float = 0.0


@dataclass
class Analyzer:
    """Reads rows in order and says what an operator would want flagged.

    A condition is raised once it has held for HOLD, stamped with the row where
    it began — that is the moment the flag should mark — and cleared with a
    closing message when it ends, so a stop reads as two flags bracketing it.
    """
    watches: dict = field(default_factory=lambda: {k: Watch() for k in ("stop", "low", "high", "defect")})
    restarted: datetime | None = None

    def feed(self, ts: datetime, speed: list[float], defect: list[float]) -> list[tuple]:
        out = []
        v, _, hi, lo = speed
        d, _, d_hi, _ = defect
        stopping = v < lo * STOP_SHARE
        if not stopping and self.watches["stop"].since is not None:
            self.restarted = ts
        ramping = self.restarted is not None and ts - self.restarted < RAMP_GRACE
        conditions = {
            "stop": stopping,
            "low": not stopping and not ramping and v < lo,
            "high": v > hi,
            "defect": d > d_hi,
        }
        for key, active in conditions.items():
            w = self.watches[key]
            value = d if key == "defect" else v
            if active:
                if w.since is None:
                    w.since, w.worst = ts, value
                w.worst = max(w.worst, value) if key in ("high", "defect") else min(w.worst, value)
                if w.raised is None and ts - w.since >= HOLD:
                    w.raised = w.since
                    out.append(self._opened(key, w.since, value, speed, defect))
            elif w.since is not None:
                if w.raised is not None:
                    out.append(self._closed(key, ts, w))
                self.watches[key] = Watch()
        return out

    @staticmethod
    def _opened(key, ts, value, speed, defect):
        _, sp, hi, lo = speed
        return {
            "stop": (ts, "Line 13 stopped", "crit"),
            "low": (ts, f"Speed below low limit: {value:,.0f} pcs/min (low {lo:,.0f})", "warn"),
            "high": (ts, f"Overspeed: {value:,.0f} pcs/min (high {hi:,.0f})", "warn"),
            "defect": (ts, f"Defect rate over limit: {value:.2f}% (limit {defect[2]:.1f}%)", "crit"),
        }[key]

    @staticmethod
    def _closed(key, ts, w):
        minutes = (ts - w.since).total_seconds() / 60
        return {
            "stop": (ts, f"Line 13 restarted after {minutes:.0f} min", "info"),
            "low": (ts, f"Speed back in band after {minutes:.0f} min (lowest {w.worst:,.0f})", "info"),
            "high": (ts, f"Speed back in band after {minutes:.0f} min (highest {w.worst:,.0f})", "info"),
            "defect": (ts, f"Defect rate back under limit — peaked at {w.worst:.2f}%", "info"),
        }[key]


@dataclass
class Ticker:
    """--tick-alerts: one condition check per row, every 10 s.

    Four checks in rotation, so the feed reads as an analysis working through
    its list rather than one sentence repeated. Each message's severity is what
    the reading actually earns — critical out of band, warning near a limit or
    drifting, info when fine — so the flags show all three colours.
    """
    n: int = 0
    defects: deque = field(default_factory=lambda: deque(maxlen=TREND_ROWS + 1))

    def feed(self, ts: datetime, speed: list[float], defect: list[float]) -> list[tuple]:
        self.defects.append(defect[0])
        check = (self._speed_band, self._defect_limit, self._setpoint, self._defect_trend)[self.n % 4]
        self.n += 1
        message, severity = check(speed, defect)
        return [(ts, message, severity)]

    @staticmethod
    def _speed_band(speed, defect):
        v, _, hi, lo = speed
        near = (hi - lo) * NEAR_SHARE
        if v < lo * STOP_SHARE:
            return "Check speed: line stopped", "crit"
        if v < lo or v > hi:
            return f"Check speed: {v:,.0f} pcs/min — outside {lo:,.0f}–{hi:,.0f}", "crit"
        if v > hi - near:
            return f"Check speed: {v:,.0f} pcs/min — near high limit {hi:,.0f}", "warn"
        if v < lo + near:
            return f"Check speed: {v:,.0f} pcs/min — near low limit {lo:,.0f}", "warn"
        return f"Check speed: {v:,.0f} pcs/min — in band", "info"

    @staticmethod
    def _defect_limit(speed, defect):
        d, _, hi, _ = defect
        if d > hi:
            return f"Check defect rate: {d:.2f}% — over limit {hi:.1f}%", "crit"
        if d > hi * 0.75:
            return f"Check defect rate: {d:.2f}% — approaching limit {hi:.1f}%", "warn"
        return f"Check defect rate: {d:.2f}% — OK (limit {hi:.1f}%)", "info"

    @staticmethod
    def _setpoint(speed, defect):
        v, sp, _, lo = speed
        if v < lo * STOP_SHARE:
            return f"Check setpoint: line stopped, {sp:,.0f} pcs/min not held", "crit"
        off = v - sp
        share = abs(off) / sp
        severity = "warn" if share > 0.05 else "info"
        return f"Check setpoint: {off:+,.0f} pcs/min from {sp:,.0f} ({share:.1%})", severity

    def _defect_trend(self, speed, defect):
        if len(self.defects) <= TREND_ROWS:
            return "Check defect trend: collecting the first minute", "info"
        then, now = self.defects[0], self.defects[-1]
        if now - then > TREND_RISE:
            return f"Check defect trend: rising {then:.2f}% → {now:.2f}% in 1 min", "warn"
        return f"Check defect trend: steady over 1 min ({then:.2f}% → {now:.2f}%)", "info"


def shift_notes(start: datetime, end: datetime) -> list[tuple]:
    """Operator-style notes at each shift change — the info flags between alarms."""
    notes = []
    t = start.replace(minute=0, second=0, microsecond=0)
    while t <= end:
        local = t.astimezone()
        if local.hour in SHIFTS and t >= start:
            notes.append((t, f"เริ่มกะ {SHIFTS[local.hour]} — ตรวจเช็คก่อนเดินเครื่อง", "info"))
        t += timedelta(hours=1)
    return notes


# --- tables -----------------------------------------------------------------------
def ensure_tables(conn, schema: str) -> None:
    sensor = sql.Identifier(schema, "sensor_log1")
    exists = conn.execute("SELECT to_regclass(%s) AS t", (f'"{schema}"."sensor_log1"',)).fetchone()["t"]
    if exists:
        comment = conn.execute("SELECT obj_description(%s::regclass, 'pg_class') AS c",
                               (f'"{schema}"."sensor_log1"',)).fetchone()["c"]
        if comment != MARKER:
            raise SystemExit(f'{schema}.sensor_log1 exists and is not the showcase mock — refusing to touch it.')
    else:
        conn.execute(sql.SQL(
            "CREATE TABLE {t} (recorded_at timestamptz NOT NULL, {s} float8[], {d} float8[])"
        ).format(t=sensor, s=sql.Identifier(SPEED), d=sql.Identifier(DEFECT)))
        conn.execute(sql.SQL("CREATE INDEX ON {t} (recorded_at)").format(t=sensor))
        conn.execute(sql.SQL("COMMENT ON TABLE {t} IS {c}").format(t=sensor, c=sql.Literal(MARKER)))
    # alert_messages exactly as sch_vision_data.sql defines it — table, indexes
    # and the insert guard — so the showcase writes through the same rules the
    # analysis team's inserts will meet. The section is idempotent.
    section = SCHEMA_FILE.read_text(encoding="utf-8")
    section = section[section.index(SCHEMA_SECTION):]
    if schema != "vision_data":
        section = section.replace("vision_data.", f"{schema}.")
    conn.execute(section)
    conn.commit()


def write_rows(conn, schema: str, rows: list[tuple]) -> None:
    with conn.cursor().copy(sql.SQL("COPY {t} (recorded_at, {s}, {d}) FROM STDIN").format(
            t=sql.Identifier(schema, "sensor_log1"), s=sql.Identifier(SPEED), d=sql.Identifier(DEFECT))) as cp:
        for row in rows:
            cp.write_row(row)


def role_of(message: str, maint_role: int | None) -> int | None:
    """The role_id an alert is tagged with: `maint_role` for a stop, else none (routed by location)."""
    return maint_role if maint_role is not None and message.startswith(MAINT_PREFIXES) else None


def write_alerts(conn, schema: str, alerts: list[tuple], maint_role: int | None = None) -> None:
    if not alerts:
        return
    conn.cursor().executemany(sql.SQL(
        "INSERT INTO {t} (created_at, message, severity, location, code, source, role_id) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s)"
    ).format(t=sql.Identifier(schema, "alert_messages")),
        [(ts, msg, sev, LOCATION, CAMERA, SOURCE, role_of(msg, maint_role)) for ts, msg, sev in alerts])


def tag_existing(conn, schema: str, maint_role: int) -> int:
    """Tag this script's stop alerts already written, so a backfill matches the live feed."""
    n = conn.execute(sql.SQL(
        "UPDATE {t} SET role_id = %s WHERE source = %s AND ({cond})"
    ).format(t=sql.Identifier(schema, "alert_messages"),
             cond=sql.SQL(" OR ").join(sql.SQL("message LIKE %s") for _ in MAINT_PREFIXES)),
        [maint_role, SOURCE, *(f"{p}%" for p in MAINT_PREFIXES)]).rowcount
    conn.commit()
    return n


def purge(conn, schema: str) -> None:
    exists = conn.execute("SELECT to_regclass(%s) AS t", (f'"{schema}"."sensor_log1"',)).fetchone()["t"]
    if exists:
        comment = conn.execute("SELECT obj_description(%s::regclass, 'pg_class') AS c",
                               (f'"{schema}"."sensor_log1"',)).fetchone()["c"]
        if comment != MARKER:
            raise SystemExit(f'{schema}.sensor_log1 is not the showcase mock — not dropping it.')
        conn.execute(sql.SQL("DROP TABLE {t}").format(t=sql.Identifier(schema, "sensor_log1")))
    if conn.execute("SELECT to_regclass(%s) AS t", (f'"{schema}"."alert_messages"',)).fetchone()["t"]:
        n = conn.execute(sql.SQL("DELETE FROM {t} WHERE source = %s").format(
            t=sql.Identifier(schema, "alert_messages")), (SOURCE,)).rowcount
        print(f"removed {n} showcase alerts")
    conn.commit()
    print("showcase purged")


# --- run --------------------------------------------------------------------------
def last_row_time(conn, schema: str) -> datetime | None:
    return conn.execute(sql.SQL("SELECT max(recorded_at) AS t FROM {t}").format(
        t=sql.Identifier(schema, "sensor_log1"))).fetchone()["t"]


def seed(conn, schema: str, hours: int, line: Line, analyzer: Analyzer,
         ticker: Ticker | None = None, maint_role: int | None = None) -> datetime:
    """Backfill `hours` up to now; returns the time of the last row written.

    With a `ticker`, the last TICK_HISTORY of it gets the per-row checks too.
    """
    end = datetime.now(timezone.utc).replace(microsecond=0)
    start = end - timedelta(hours=hours)
    last = last_row_time(conn, schema)
    if last is not None and last > start:
        start = last + STEP
    rows, alerts = [], []
    t = start
    while t <= end:
        speed, defect = line.sample(t)
        rows.append((t, speed, defect))
        alerts += analyzer.feed(t, speed, defect)
        if ticker is not None and end - t <= TICK_HISTORY:
            alerts += ticker.feed(t, speed, defect)
        t += STEP
    alerts += shift_notes(start, end)
    write_rows(conn, schema, rows)
    write_alerts(conn, schema, alerts, maint_role)
    conn.commit()
    print(f"seeded {len(rows)} rows and {len(alerts)} alerts, {start:%H:%M} -> {end:%H:%M} UTC")
    return t - STEP


def run_live(conn, schema: str, line: Line, analyzer: Analyzer, after: datetime | None,
             ticker: Ticker | None = None, maint_role: int | None = None) -> None:
    """One row every 10 s, analysed as it is written — the two tables in step."""
    t = (after or datetime.now(timezone.utc).replace(microsecond=0)) + STEP
    print("live: one row every 10 s (Ctrl+C to stop)", flush=True)
    while True:
        wait = (t - datetime.now(timezone.utc)).total_seconds()
        if wait > 0:
            time.sleep(wait)
        speed, defect = line.sample(t)
        alerts = analyzer.feed(t, speed, defect)
        if ticker is not None:
            alerts += ticker.feed(t, speed, defect)
        local = t.astimezone()
        if local.minute == 0 and local.second < STEP.total_seconds() and local.hour in SHIFTS:
            alerts += shift_notes(t, t)
        try:
            write_rows(conn, schema, [(t, speed, defect)])
            write_alerts(conn, schema, alerts, maint_role)
            conn.commit()
        except psycopg.errors.UndefinedTable:
            # Purged (or dropped) while running: nothing left to keep in step.
            raise SystemExit("showcase tables are gone (purged?) — live feed stopped")
        for ts, msg, sev in alerts:
            print(f"{ts.astimezone():%H:%M:%S} [{sev}] {msg}", flush=True)
        t += STEP


def main() -> None:
    parser = argparse.ArgumentParser(description="Alert-message showcase: mock sensor_log1 + its alerts")
    parser.add_argument("--seed", type=int, metavar="HOURS", help="Backfill this many hours up to now")
    parser.add_argument("--live", action="store_true", help="Keep writing a row every 10 s")
    parser.add_argument("--purge", action="store_true", help="Drop the mock table and the showcase alerts")
    parser.add_argument("--schema", default="vision_data",
                        help="Plant schema the app reads (the datasource's schema; default vision_data)")
    parser.add_argument("--random-seed", type=int, default=13, help="Make the scripted line repeatable")
    parser.add_argument("--tick-alerts", action="store_true",
                        help="Also write one condition-check message per row (every 10 s)")
    parser.add_argument("--maint-role", type=int, metavar="ROLE_ID",
                        help="Tag stop alerts with this Response-role ID (also tags ones already written)")
    plant_cli.add_target_args(parser)
    args = parser.parse_args()
    if not (args.seed or args.live or args.purge):
        parser.error("nothing to do — pass --seed HOURS, --live or --purge")

    with plant_cli.connect(args) as conn:
        if args.purge:
            purge(conn, args.schema)
            if not (args.seed or args.live):
                return
        ensure_tables(conn, args.schema)
        line, analyzer = Line(random.Random(args.random_seed)), Analyzer()
        ticker = Ticker() if args.tick_alerts else None
        if args.maint_role is not None:
            print(f"tagged {tag_existing(conn, args.schema, args.maint_role)} stop alerts with role {args.maint_role}")
        after = (seed(conn, args.schema, args.seed, line, analyzer, ticker, args.maint_role) if args.seed
                 else last_row_time(conn, args.schema))
        if args.live:
            try:
                run_live(conn, args.schema, line, analyzer, after, ticker, args.maint_role)
            except KeyboardInterrupt:
                print("stopped")


if __name__ == "__main__":
    main()
