"""One-shot seed of public.alarm_logs for the /alarms page verification."""
import db


ROWS = [
    ("Line1", "Pressure2", "Pressure 2 above safety threshold",     "critical",  "30 seconds"),
    ("Line1", "Pressure2", "Pressure 2 climbing",                   "warning",   "5 minutes"),
    ("Line1", "Pressure2", "Pressure 2 stable",                     "info",      "30 minutes"),
    ("Line1", "Tank01_Level", "Tank 01 level high",                 "warning",   "2 minutes"),
    ("Line2", "Pump03_Temp", "Pump 03 motor warm",                  "info",      "10 minutes"),
    ("Line2", "Pump03_Temp", "Pump 03 motor hot",                   "critical",  "1 minute"),
]


def main() -> None:
    with db.get_connection() as conn:
        for location, tag, msg, sev, ago in ROWS:
            conn.execute(
                """INSERT INTO public.alarm_logs
                     (location, tag_name, alarm_events, severity, created_at, updated_at)
                   VALUES (%s, %s, %s, %s,
                           now() - (%s)::interval, now() - (%s)::interval)""",
                (location, tag, msg, sev, ago, ago),
            )
        conn.commit()
    with db.get_connection() as conn:
        n = conn.execute("SELECT count(*) AS n FROM public.alarm_logs").fetchone()
        print(f"alarm_logs row count: {n['n']}")


if __name__ == "__main__":
    main()
