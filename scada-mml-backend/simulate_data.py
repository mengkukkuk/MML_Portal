"""
SCADA Data Simulator
====================
Continuously inserts realistic sensor readings into PostgreSQL
so Grafana has live time-series data to display.

Usage:
    python simulate_data.py           # run forever (Ctrl+C to stop)
    python simulate_data.py --seed    # insert 2 hours of historical data first, then run live
"""

import argparse
import math
import random
import time
from datetime import datetime, timedelta, timezone

import psycopg

import config

# ---------------------------------------------------------------------------
# Sensor definitions per device
# { device_name: [(metric, unit, base, amplitude, noise, min, max)] }
# ---------------------------------------------------------------------------
SENSORS: dict[str, list[tuple]] = {
    "Boiler-01": [
        ("temperature", "°C",  78, 8,  1.5, 40, 120),
        ("pressure",    "bar",  4,  1,  0.2,  0,  10),
        ("flow_rate",   "L/min", 30, 5, 1.0,  0,  60),
    ],
    "Compressor-01": [
        ("pressure",    "PSI", 92, 6,  1.0,  0, 150),
        ("rpm",         "RPM", 1450, 50, 10, 0, 3000),
        ("temperature", "°C",  65, 5,  1.0, 20, 100),
    ],
    "Tank-03": [
        ("level",       "%",   60, 15, 1.0,  0, 100),
        ("temperature", "°C",  22, 3,  0.5, 10,  50),
    ],
    "Pump-02": [
        ("flow_rate",   "L/min", 45, 8, 1.5,  0,  80),
        ("pressure",    "bar",   3,  1, 0.3,  0,  10),
        ("rpm",         "RPM", 1200, 100, 20, 0, 3000),
    ],
    "Cooling-01": [
        ("temperature", "°C",  18, 4,  0.8,  5,  40),
        ("flow_rate",   "L/min", 25, 5, 1.0,  0,  50),
    ],
}

# How often to insert a new row per device (seconds)
INTERVAL_SECONDS = 5


def wave_value(
    t: float,
    base: float,
    amplitude: float,
    noise: float,
    min_val: float,
    max_val: float,
) -> float:
    """Sinusoidal value with random noise, clamped to [min, max]."""
    val = base + amplitude * math.sin(t / 60.0) + random.gauss(0, noise)
    return round(max(min_val, min(max_val, val)), 2)


def get_device_ids(conn: psycopg.Connection) -> dict[str, int]:
    with conn.cursor() as cur:
        cur.execute("SELECT id, name FROM devices")
        rows = cur.fetchall()
    return {r["name"]: r["id"] for r in rows}


def ensure_devices(conn: psycopg.Connection) -> None:
    """Create any devices referenced by the simulator if they do not yet exist."""
    device_defs = []
    for device_name in SENSORS:
        if "Boiler" in device_name:
            dev_type = "boiler"
        elif "Compressor" in device_name:
            dev_type = "compressor"
        elif "Tank" in device_name:
            dev_type = "tank"
        elif "Pump" in device_name:
            dev_type = "pump"
        elif "Cooling" in device_name:
            dev_type = "cooling"
        else:
            dev_type = "device"
        device_defs.append((device_name, dev_type, "Main plant", "online"))

    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO devices (name, type, location, status) VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (name) DO NOTHING",
            device_defs,
        )
    conn.commit()


def insert_readings(
    conn: psycopg.Connection,
    device_ids: dict[str, int],
    t: float,
    ts: datetime,
) -> int:
    rows = []
    for device_name, sensors in SENSORS.items():
        dev_id = device_ids.get(device_name)
        if dev_id is None:
            continue
        for metric, unit, base, amp, noise, mn, mx in sensors:
            val = wave_value(t, base, amp, noise, mn, mx)
            rows.append((dev_id, metric, val, unit, ts))

    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO sensor_readings (device_id, metric, value, unit, ts) "
            "VALUES (%s, %s, %s, %s, %s)",
            rows,
        )
    conn.commit()
    return len(rows)


def seed_history(conn: psycopg.Connection, device_ids: dict[str, int], hours: int = 2) -> None:
    """Insert historical data so Grafana panels show a full chart immediately."""
    print(f"Seeding {hours}h of historical data …", flush=True)
    now = datetime.now(timezone.utc)
    steps = (hours * 3600) // INTERVAL_SECONDS
    for i in range(steps):
        ts = now - timedelta(seconds=(steps - i) * INTERVAL_SECONDS)
        t = ts.timestamp()
        insert_readings(conn, device_ids, t, ts)
        if i % 200 == 0:
            print(f"  {i}/{steps} rows inserted", flush=True)
    print("Historical seed complete.", flush=True)


def run_live(conn: psycopg.Connection, device_ids: dict[str, int]) -> None:
    print(f"Live simulation started — inserting every {INTERVAL_SECONDS}s (Ctrl+C to stop)", flush=True)
    while True:
        t = time.time()
        ts = datetime.now(timezone.utc)
        n = insert_readings(conn, device_ids, t, ts)
        print(f"[{ts.strftime('%H:%M:%S')}] Inserted {n} readings", flush=True)
        time.sleep(INTERVAL_SECONDS)


def main() -> None:
    parser = argparse.ArgumentParser(description="SCADA sensor data simulator")
    parser.add_argument(
        "--seed", action="store_true",
        help="Insert 2 hours of historical data before going live",
    )
    args = parser.parse_args()

    print("Connecting to PostgreSQL …", flush=True)
    with psycopg.connect(config.DATABASE_URL, row_factory=psycopg.rows.dict_row) as conn:
        ensure_devices(conn)
        device_ids = get_device_ids(conn)
        print(f"Found devices: {list(device_ids.keys())}", flush=True)

        if args.seed:
            seed_history(conn, device_ids)

        run_live(conn, device_ids)


if __name__ == "__main__":
    main()
