"""One-shot migration for public.alarm_logs — adds severity + ack columns + index.

Idempotent. Run once after the table is created; safe to re-run.
Not committed long-term — once applied to the live DB this file can be deleted.
"""
import db


MIGRATIONS = [
    # Severity label: 'critical' | 'warning' | 'info'. Default 'info'.
    "ALTER TABLE public.alarm_logs "
    "ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info'",
    # Acknowledgement metadata
    "ALTER TABLE public.alarm_logs "
    "ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE public.alarm_logs "
    "ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP",
    "ALTER TABLE public.alarm_logs "
    "ADD COLUMN IF NOT EXISTS acknowledged_by INTEGER",
    # Window-function index for "last N per tag"
    "CREATE INDEX IF NOT EXISTS alarm_logs_loc_tag_time_idx "
    "ON public.alarm_logs (location, tag_name, created_at DESC)",
]


def main() -> None:
    with db.get_connection() as conn:
        for sql in MIGRATIONS:
            print(f"  >> {sql.splitlines()[0][:70]}")
            conn.execute(sql)
        conn.commit()
    # Verify
    with db.get_connection() as conn:
        rows = conn.execute(
            """SELECT column_name, data_type
                 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'alarm_logs'
                ORDER BY ordinal_position"""
        ).fetchall()
    print("=== alarm_logs columns after migration ===")
    for r in rows:
        print(f"  {r['column_name']:20} {r['data_type']}")


if __name__ == "__main__":
    main()
