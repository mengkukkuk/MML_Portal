"""Machine-state event simulator — feeds the Report page.

The real ``public.event_logs`` on this deployment holds only "parameter change
setpoint 136 -> 137" rows, which carry no state information at all. A report run
against them shows every machine as 100% UNKNOWN, which is correct but useless
for developing or demonstrating the feature. This writes the RUN / STOP / IDLE /
PLANNED_DOWN transitions a real line would emit, plus the ``alarm_logs`` rows
that explain each stop.

event_logs and alarm_logs are *plant* data and do not live in the app/config
database, so a target must be named explicitly with --datasource or --dsn.

Usage:
    python simulate_events.py --datasource 1 --seed 14   # backfill 14 days, exit
    python simulate_events.py --datasource 1 --live      # emit in real time
    python simulate_events.py --datasource 1 --seed 14 --live
    python simulate_events.py --datasource 1 --purge     # remove this script's rows

Timestamps are naive local, matching the column type and report_engine's model.
Simulated machines use their own location/tag names, so nothing here collides
with the rows the SCADA writes.
"""
import argparse
import random
import time
from datetime import datetime, timedelta

import psycopg

import plant_cli

#: Simulated machines, kept clearly distinct from the real Line1 tags so a purge
#: can never touch SCADA-written history.
MACHINES: list[tuple[str, str]] = [
    ("Line 1", "SIM-Filler-01"),
    ("Line 1", "SIM-Capper-02"),
    ("Line 1", "SIM-Labeller-03"),
    ("Line 2", "SIM-Mixer-01"),
    ("Line 2", "SIM-Packer-02"),
]

#: (event text, weight, mean duration minutes). The text is what `classify()`
#: has to recognise, so these are deliberately phrased the way a PLC would.
STOPS: list[tuple[str, float, float]] = [
    ("Emergency stop pressed", 1.0, 12),
    ("Motor overload fault", 1.5, 18),
    ("Conveyor jam - stop", 2.5, 8),
    ("Infeed starved - stop", 2.0, 6),
    ("Drive trip", 1.0, 25),
]

IDLES: list[tuple[str, float, float]] = [
    ("Idle - waiting for upstream", 3.0, 7),
    ("Standby", 1.5, 10),
]

PLANNED: list[tuple[str, float, float]] = [
    ("Changeover to next SKU", 1.0, 35),
    ("Scheduled maintenance", 0.6, 55),
    ("CIP cleaning cycle", 0.8, 40),
    ("Operator break", 1.2, 20),
]

RUN_EVENT = "Machine running - auto"

#: Alarms are written slightly *before* the stop they explain, which is what the
#: engine's `alarm_lead_seconds` window exists to absorb.
ALARM_LEAD_RANGE = (5, 45)

ALARMS_FOR_STOP: dict[str, tuple[str, str]] = {
    "Emergency stop pressed": ("E-STOP circuit opened", "critical"),
    "Motor overload fault": ("Main drive motor overload", "critical"),
    "Conveyor jam - stop": ("Product jam detected at outfeed", "warning"),
    "Infeed starved - stop": ("Infeed sensor no product", "warning"),
    "Drive trip": ("VFD fault code F007", "critical"),
}

#: Mean minutes of production between interruptions. Higher = a healthier line.
MEAN_RUN_MINUTES = 95


def _pick(options: list[tuple[str, float, float]]) -> tuple[str, float]:
    """Weighted choice of (event text, duration minutes)."""
    text, _, mean = random.choices(options, weights=[o[1] for o in options])[0]
    # Exponential-ish spread around the mean, floored so nothing is instant.
    return text, max(1.0, random.expovariate(1.0 / mean))


def _next_interruption() -> tuple[str, float, bool]:
    """Choose what ends the current run. Returns (event, minutes, is_stop)."""
    roll = random.random()
    if roll < 0.55:
        text, mins = _pick(STOPS)
        return text, mins, True
    if roll < 0.85:
        text, mins = _pick(IDLES)
        return text, mins, False
    text, mins = _pick(PLANNED)
    return text, mins, False


def build_history(
    location: str,
    tag: str,
    start: datetime,
    end: datetime,
) -> tuple[list[tuple], list[tuple]]:
    """Generate one machine's transitions across [start, end).

    Returns (event rows, alarm rows) ready for executemany. The machine always
    opens in RUN at `start` so the report has a carry-in state to find.
    """
    events: list[tuple] = [(location, tag, RUN_EVENT, start)]
    alarms: list[tuple] = []

    at = start
    while at < end:
        at += timedelta(minutes=random.expovariate(1.0 / MEAN_RUN_MINUTES))
        if at >= end:
            break

        text, minutes, is_stop = _next_interruption()
        events.append((location, tag, text, at))

        if is_stop and text in ALARMS_FOR_STOP:
            alarm_text, severity = ALARMS_FOR_STOP[text]
            fired = at - timedelta(seconds=random.randint(*ALARM_LEAD_RANGE))
            alarms.append((location, tag, alarm_text, severity, fired))

        at += timedelta(minutes=minutes)
        if at >= end:
            break
        events.append((location, tag, RUN_EVENT, at))

    return events, alarms


def insert(conn: psycopg.Connection, events: list[tuple], alarms: list[tuple]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO public.event_logs (location, tag_name, event, at_date_time) "
            "VALUES (%s, %s, %s, %s)",
            events,
        )
        cur.executemany(
            "INSERT INTO public.alarm_logs "
            "(location, tag_name, alarm_events, severity, created_at) "
            "VALUES (%s, %s, %s, %s, %s)",
            alarms,
        )
    conn.commit()


def purge(conn: psycopg.Connection) -> None:
    """Delete only rows this script could have written."""
    tags = [t for _, t in MACHINES]
    with conn.cursor() as cur:
        cur.execute("DELETE FROM public.event_logs WHERE tag_name = ANY(%s)", (tags,))
        events_gone = cur.rowcount
        cur.execute("DELETE FROM public.alarm_logs WHERE tag_name = ANY(%s)", (tags,))
        alarms_gone = cur.rowcount
    conn.commit()
    print(f"Purged {events_gone} event rows and {alarms_gone} alarm rows.", flush=True)


def seed(conn: psycopg.Connection, days: int) -> None:
    now = datetime.now()
    start = now - timedelta(days=days)
    print(f"Seeding {days} days for {len(MACHINES)} machines …", flush=True)

    for location, tag in MACHINES:
        events, alarms = build_history(location, tag, start, now)
        insert(conn, events, alarms)
        print(f"  {location} / {tag}: {len(events)} events, {len(alarms)} alarms",
              flush=True)
    print("Seed complete.", flush=True)


def run_live(conn: psycopg.Connection) -> None:
    """Emit one transition per machine per tick, so an open report keeps moving."""
    print("Live mode — one transition per machine per minute (Ctrl+C to stop)",
          flush=True)
    running = {m: True for m in MACHINES}
    while True:
        now = datetime.now()
        events, alarms = [], []
        for machine in MACHINES:
            location, tag = machine
            if running[machine]:
                if random.random() < 0.25:
                    text, _, is_stop = _next_interruption()
                    events.append((location, tag, text, now))
                    running[machine] = False
                    if is_stop and text in ALARMS_FOR_STOP:
                        alarm_text, severity = ALARMS_FOR_STOP[text]
                        alarms.append((location, tag, alarm_text, severity,
                                       now - timedelta(seconds=10)))
            elif random.random() < 0.5:
                events.append((location, tag, RUN_EVENT, now))
                running[machine] = True

        if events:
            insert(conn, events, alarms)
            print(f"[{now:%H:%M:%S}] {len(events)} transitions, {len(alarms)} alarms",
                  flush=True)
        time.sleep(60)


def main() -> None:
    parser = argparse.ArgumentParser(description="SCADA machine-state simulator")
    parser.add_argument("--seed", type=int, metavar="DAYS",
                        help="Backfill this many days of history")
    parser.add_argument("--live", action="store_true",
                        help="Keep emitting transitions in real time")
    parser.add_argument("--purge", action="store_true",
                        help="Delete previously simulated rows first")
    plant_cli.add_target_args(parser)
    args = parser.parse_args()

    if not (args.seed or args.live or args.purge):
        parser.error("nothing to do — pass --seed DAYS, --live or --purge")

    with plant_cli.connect(args) as conn:
        if args.purge:
            purge(conn)
        if args.seed:
            seed(conn, args.seed)
        if args.live:
            run_live(conn)


if __name__ == "__main__":
    main()
