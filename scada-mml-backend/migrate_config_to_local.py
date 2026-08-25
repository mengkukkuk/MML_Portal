"""One-shot copy of MMLPortal's configuration from the old shared database to
the local app database.

Background: until now the app read *everything* -- its own configuration and the
plant's live data -- from the one database named in `.env`. That database is now
split in two. Configuration (users, dashboards, panels, mimic layouts, report
templates, saved connections) lives on localhost so the app can always boot and
always log in. Plant data stays where it is and is read through a row in
`datasources` that the operator selects in the header.

This script moves the first half. It is **copy-only**: nothing is ever deleted
from the source, so the old database remains a complete backup of the
pre-migration state. The risk runs the other way -- configuration written to
localhost *after* the cutover exists only there, so put localhost into the backup
rotation on day one.

Run it twice and nothing happens the second time: every table has a natural key
or a preserved id, and every insert is ON CONFLICT DO NOTHING.

    venv/Scripts/python migrate_config_to_local.py            # dry run, the default
    venv/Scripts/python migrate_config_to_local.py --apply

The source is read from the `DB_*` variables still present in `.env`, deliberately
via os.getenv rather than config.py -- config.py no longer exposes them, because
nothing in the running application may point at a remote host for configuration.
"""
from __future__ import annotations

import argparse
import os
import sys

import psycopg
from dotenv import load_dotenv
from psycopg import sql
from psycopg.types.json import Json

import config
import db

load_dotenv()

#: FK-driven, and it mirrors main._create_tables(). dashboard_panels references
#: dashboards, mimic_symbols references mimic_assets, and user_datasource_selection
#: references both users and datasources -- so the parents come first. Deliberately
#: NOT copied: devices, sensor_readings, variables_tag, event_logs, alarm_logs,
#: mmldatabuffer. That is plant data; it stays on the plant and is read through a
#: datasource.
TABLES = (
    "users",
    "datasources",
    "dashboards",
    "dashboard_panels",
    "mimic_layouts",
    "mimic_assets",
    "mimic_symbols",
    "report_templates",
    "report_settings",
)

CHUNK = 500


def source_kwargs() -> dict[str, object]:
    host = os.getenv("DB_HOST")
    if not host:
        sys.exit(
            "No DB_HOST in .env -- nothing to migrate from. If the old database is "
            "gone, there is nothing to do; the app already runs against localhost."
        )
    return dict(
        host=host,
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "postgres"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", ""),
        connect_timeout=config.DB_CONNECT_TIMEOUT,
    )


def _columns(conn: psycopg.Connection, table: str) -> list[tuple[str, str]]:
    """(name, data_type) in the table's own column order, or [] if absent."""
    return [
        (r[0], r[1])
        for r in conn.execute(
            """SELECT column_name, data_type
                 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = %s
                ORDER BY ordinal_position""",
            (table,),
        ).fetchall()
    ]


def _shared_columns(src: psycopg.Connection, dst: psycopg.Connection, table: str):
    """The intersection of both sides, in the *target's* order.

    Never `SELECT *`: the source may sit on an older schema, and a column that
    exists on only one side would otherwise abort the whole table. Returning the
    target's order also means the INSERT column list and the SELECT agree without
    a second lookup.
    """
    source_names = {name for name, _ in _columns(src, table)}
    return [(n, t) for n, t in _columns(dst, table) if n in source_names]


def _adapt(value, data_type: str):
    """Make a value psycopg read back from the source insertable again.

    Two shapes do not round-trip on their own:

    * json/jsonb comes back as a Python dict or list, and re-inserting one raises
      `cannot adapt type 'dict'`. The columns are detected from the target's
      data_type rather than hardcoded -- dashboard_panels, mimic_layouts,
      mimic_symbols and report_templates all carry JSON config today and that set
      will keep growing.
    * bytea comes back as a memoryview (mimic_assets holds raw SVG/PNG bytes).
    """
    if value is None:
        return None
    if data_type in ("json", "jsonb"):
        return Json(value)
    if data_type == "bytea":
        return bytes(value)
    return value


def _reset_sequence(conn: psycopg.Connection, table: str) -> str | None:
    """Point the table's id sequence past the highest copied id.

    Without this every later insert collides on the primary key: the copy carries
    ids verbatim, but the sequence on a freshly created table still reads 1.
    Returns a human-readable note, or None when the table has no serial id --
    report_settings is a singleton and setval(NULL, ...) is an error, not a no-op.
    """
    row = conn.execute(
        sql.SQL(
            "SELECT pg_get_serial_sequence('public.{}', 'id'), COALESCE(MAX(id), 0) "
            "FROM {}"
        ).format(sql.SQL(table), sql.Identifier(table))
    ).fetchone()
    seq, high = row[0], row[1]
    if not seq:
        return None
    conn.execute("SELECT setval(%s, %s, false)", (seq, high + 1))
    return f"{seq} -> {high + 1}"


def _collisions(src, dst, table: str) -> list[int]:
    """Ids present on both sides — every one of them is a silently dropped row.

    Ids are copied verbatim, because dashboard_panels.dashboard_id,
    mimic_symbols.asset_id, bookmarked URLs and localStorage dashboard ids all
    depend on it. That is safe only into an empty target. If both databases were
    seeded independently then id 2 is `admin` on one and `operator` on the other,
    ON CONFLICT DO NOTHING skips the incoming row, and its children copy anyway
    and attach themselves to the wrong parent. The result looks like a successful
    migration and is wrong, so refuse instead.
    """
    def ids(conn):
        if not any(n == "id" for n, _ in _columns(conn, table)):
            return set()
        return {
            r[0] for r in conn.execute(
                sql.SQL("SELECT id FROM {}").format(sql.Identifier("public", table))
            ).fetchall()
        }
    return sorted(ids(src) & ids(dst))


def _copy_table(src, dst, table: str, apply: bool) -> dict:
    """One table, one transaction. A failure here leaves earlier tables committed,
    which is what makes a partial run resumable rather than a puzzle."""
    columns = _shared_columns(src, dst, table)
    if not columns:
        return {"table": table, "skipped": "not present on both sides"}

    names = [n for n, _ in columns]
    types = [t for _, t in columns]
    select = sql.SQL("SELECT {} FROM {}").format(
        sql.SQL(", ").join(sql.Identifier(n) for n in names),
        sql.Identifier("public", table),
    )
    rows = src.execute(select).fetchall()
    before = dst.execute(
        sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier("public", table))
    ).fetchone()[0]

    if not apply or not rows:
        return {"table": table, "read": len(rows), "before": before,
                "inserted": 0, "columns": names}

    insert = sql.SQL("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT DO NOTHING").format(
        sql.Identifier("public", table),
        sql.SQL(", ").join(sql.Identifier(n) for n in names),
        sql.SQL(", ").join(sql.Placeholder() * len(names)),
    )
    with dst.cursor() as cur:
        for start in range(0, len(rows), CHUNK):
            cur.executemany(
                insert,
                [
                    tuple(_adapt(v, t) for v, t in zip(row, types))
                    for row in rows[start:start + CHUNK]
                ],
            )
        note = _reset_sequence(dst, table)
    after = dst.execute(
        sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier("public", table))
    ).fetchone()[0]
    dst.commit()
    return {"table": table, "read": len(rows), "before": before,
            "inserted": after - before, "sequence": note, "columns": names}


def _register_source(dst, kwargs: dict, name: str, apply: bool) -> int | None:
    """Save the old database as a selectable datasource, and pre-select it for
    everyone.

    This is what makes the cutover invisible. Without it, the first login after
    migration shows every dashboard intact but every panel empty, because nothing
    is pointing at the plant any more. ON CONFLICT UPDATE so re-running after
    editing .env corrects the row rather than failing.
    """
    if not apply:
        return None
    row = dst.execute(
        """INSERT INTO datasources
               (name, type, host, port, dbname, username, password, sslmode, db_schema)
           VALUES (%s, 'postgres', %s, %s, %s, %s, %s, 'prefer', 'public')
           ON CONFLICT (name) DO UPDATE SET
               host = EXCLUDED.host, port = EXCLUDED.port,
               dbname = EXCLUDED.dbname, username = EXCLUDED.username,
               password = EXCLUDED.password, updated_at = now()
           RETURNING id""",
        (name, kwargs["host"], kwargs["port"], kwargs["dbname"],
         kwargs["user"], kwargs["password"]),
    ).fetchone()[0]
    dst.execute(
        """INSERT INTO user_datasource_selection (user_id, datasource_id, position)
           SELECT id, %s, 0 FROM users
           ON CONFLICT DO NOTHING""",
        (row,),
    )
    dst.commit()
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="actually write; without it the run only reports")
    parser.add_argument("--name", default="MMLData (plant)",
                        help="name for the datasources row created for the source")
    parser.add_argument("--no-register", action="store_true",
                        help="skip saving the source as a selectable datasource")
    parser.add_argument("--force", action="store_true",
                        help="copy even though ids collide; the colliding rows "
                             "will be dropped and their children mis-parented")
    args = parser.parse_args()

    kwargs = source_kwargs()
    print(f"source: {kwargs['user']}@{kwargs['host']}:{kwargs['port']}/{kwargs['dbname']}")
    print(f"target: {config.APP_DB_USER}@{config.APP_DB_HOST}:"
          f"{config.APP_DB_PORT}/{config.APP_DB_NAME}")
    if kwargs["host"] in ("localhost", "127.0.0.1") and \
            kwargs["dbname"] == config.APP_DB_NAME:
        sys.exit("Source and target are the same database -- nothing to migrate.")
    if not args.apply:
        print("DRY RUN -- nothing will be written. Re-run with --apply.\n")

    # The target must already have its schema: the app creates it on startup, and
    # inventing it here would mean two definitions of every table to keep in sync.
    db.init_users_table()
    db.init_panels_table()
    db.init_dashboards_table()
    db.init_datasources_table()
    db.init_user_datasource_selection_table()
    db.init_mimic_table()
    db.init_mimic_assets_table()
    db.init_mimic_symbols_table()
    db.init_report_tables()

    with psycopg.connect(**kwargs) as src, psycopg.connect(**config.APP_DB_KWARGS) as dst:
        clashes = {t: c for t in TABLES if (c := _collisions(src, dst, t))}
        if clashes and not args.force:
            print("\nRefusing to copy: the target already holds rows at these ids.\n")
            for table, ids in clashes.items():
                print(f"  {table:<18} {ids}")
            print(
                "\nIds are copied verbatim, so this is not a merge -- the incoming\n"
                "rows would be dropped while their children copied anyway and\n"
                "attached to whatever happens to hold that id locally.\n\n"
                "Empty the target's config tables first (they are seed data on a\n"
                "fresh install), then re-run. --force overrides, and should only be\n"
                "used when you know the ids mean the same thing on both sides."
            )
            return 1

        results = [_copy_table(src, dst, t, args.apply) for t in TABLES]
        ds_id = None
        if not args.no_register:
            ds_id = _register_source(dst, kwargs, args.name, args.apply)

    width = max(len(t) for t in TABLES)
    for r in results:
        if "skipped" in r:
            print(f"  {r['table']:<{width}}  skipped ({r['skipped']})")
            continue
        line = (f"  {r['table']:<{width}}  read {r['read']:>5}  "
                f"target {r['before']:>5} -> {r['before'] + r['inserted']:>5}")
        if r.get("sequence"):
            line += f"  seq {r['sequence']}"
        print(line)

    if ds_id is not None:
        print(f"\nRegistered source as datasource id {ds_id} "
              f"and selected it for every user.")
    elif args.apply and args.no_register:
        print("\nSource NOT registered (--no-register): Live/Events/Alarms will "
              "have no plant to read from until one is added in Settings.")
    if not args.apply:
        print("\nDry run complete. Re-run with --apply to write.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
