"""Plant-database target resolution for the standalone CLI helpers.

simulate_data.py, simulate_events.py, _seed_alarms.py and _probe_alarms.py all
write *plant* data -- sensor_readings, event_logs, alarm_logs. Since the app and
plant databases were split, those tables do not exist in the app/config database,
so these scripts cannot use db.get_connection(): it always returns localhost.

They must be pointed at a specific plant instead, either by saved-datasource id
or name (looked up in the local `datasources` table, password included) or by a
raw libpq DSN for a database that has not been saved yet.
"""
import argparse

import psycopg

import db


def add_target_args(parser: argparse.ArgumentParser) -> None:
    """Attach the mutually exclusive plant-target options to a parser."""
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--datasource", metavar="ID_OR_NAME",
        help="Saved datasource to write to, by id or name (see /api/datasources)",
    )
    group.add_argument(
        "--dsn", metavar="DSN",
        help="Raw libpq connection string, e.g. "
             "'host=10.0.0.5 port=5432 dbname=MMLData user=postgres password=…'",
    )


def resolve_dsn(args: argparse.Namespace) -> str:
    """Turn --datasource / --dsn into a libpq connection string.

    Raises SystemExit with a readable message rather than a traceback: these are
    operator-run scripts and a stack trace for a mistyped name is noise.
    """
    if args.dsn:
        return args.dsn

    target = str(args.datasource)
    row = None
    if target.isdigit():
        row = db.get_datasource_secret(int(target))
    if row is None:
        matches = [d for d in db.list_datasources() if d["name"] == target]
        if matches:
            row = db.get_datasource_secret(matches[0]["id"])
    if row is None:
        known = ", ".join(d["name"] for d in db.list_datasources()) or "(none saved)"
        raise SystemExit(f"No datasource matching {target!r}. Known: {known}")

    return psycopg.conninfo.make_conninfo(
        host=row["host"], port=row["port"], dbname=row["database"],
        user=row["username"], password=row["password"], sslmode=row["sslmode"],
    )


def connect(args: argparse.Namespace) -> psycopg.Connection:
    """Open a connection to the resolved plant database, rows as dicts."""
    return psycopg.connect(resolve_dsn(args), row_factory=psycopg.rows.dict_row)
