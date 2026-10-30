"""Daily files for finished network-access sessions (backs the Access page).

Layout under ACCESS_LOG_ROOT:
    YYYY-MM-DD/conn_monitor.log   one line per finished session, filed under the day it STARTED
    state.json                    heartbeat + open sessions, so a crash can be closed on next boot
    auto_names.txt                IP -> computer name cache (written by access_names)

A line looks like the standalone conn_monitor_py's access_log.txt:
    Start Date: 30/10/2026 | Start Time: 09:03:49 | End Date: ... | Duration: 01:11:13 | ...
"""
import json
import logging
import os
import re
import threading
from datetime import date, datetime, timedelta

log = logging.getLogger("access")

DATE_FMT = "%d/%m/%Y"
TIME_FMT = "%H:%M:%S"
DAY_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LOG_NAME = f"conn_monitor.log"


def fmt_duration(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def format_fields(fields) -> str:
    return " | ".join(f"{k}: {v}" for k, v in fields)


def parse_line(line: str) -> dict:
    """'Key: Value | Key: Value' -> dict"""
    row = {}
    for part in line.strip().split(" | "):
        key, sep, value = part.partition(": ")
        if sep:
            row[key.strip()] = value.strip()
    return row


def _parse_dt(date_s: str | None, time_s: str | None) -> datetime | None:
    try:
        return datetime.strptime(f"{date_s} {time_s}", f"{DATE_FMT} {TIME_FMT}")
    except (TypeError, ValueError):
        return None


def _row_from_fields(f: dict) -> dict | None:
    """Turn one parsed log line into the shape the API returns, or None if the
    line is not a usable session (hand-edited or truncated by a power cut)."""
    start = _parse_dt(f.get("Start Date"), f.get("Start Time"))
    end = _parse_dt(f.get("End Date"), f.get("End Time"))
    if start is None or end is None:
        return None
    try:
        port = int(f.get("Port", ""))
    except ValueError:
        port = None
    return {
        "computer_name": f.get("Computer Name", "Unknown"),
        "remote_ip": f.get("Remote IP", ""),
        "protocol": f.get("Protocol", ""),
        "port": port,
        "start": start,
        "end": end,
        "seconds": max(0, int((end - start).total_seconds())),
        "duration": f.get("Duration") or fmt_duration((end - start).total_seconds()),
        "note": f.get("Note", ""),
    }


class AccessLog:
    def __init__(self, root: str):
        self.root = root
        self.state_path = os.path.join(root, "state.json")
        self.cache_path = os.path.join(root, "auto_names.txt")
        self._lock = threading.Lock()
        os.makedirs(self.root, exist_ok=True)

    # ---------- paths ----------
    def day_dir(self, d: date) -> str:
        path = os.path.join(self.root, d.strftime("%Y-%m-%d"))
        os.makedirs(path, exist_ok=True)
        return path

    def log_path(self, d: date) -> str:
        return os.path.join(self.day_dir(d), LOG_NAME)

    # ---------- writing ----------
    def write_session(self, session, end: datetime, name: str, note: str | None = None) -> str:
        start = session.start
        seconds = (end - start).total_seconds()
        fields = [
            ("Start Date", start.strftime(DATE_FMT)),
            ("Start Time", start.strftime(TIME_FMT)),
            ("End Date", end.strftime(DATE_FMT)),
            ("End Time", end.strftime(TIME_FMT)),
            ("Duration", fmt_duration(seconds)),
            ("Total Minutes", max(0, int(seconds)) // 60),
            ("Protocol", session.protocol),
            ("Port", session.port),
            ("Remote IP", session.ip),
            ("Computer Name", name),
        ]
        if note:
            fields.append(("Note", note))
        line = format_fields(fields)
        with self._lock:
            # folder = start date: a session crossing midnight stays in its start day
            with open(self.log_path(start.date()), "a", encoding="utf-8") as f:
                f.write(line + "\n")
        return line

    def ensure_today(self) -> None:
        path = self.log_path(date.today())
        if not os.path.exists(path):
            open(path, "a", encoding="utf-8").close()

    # ---------- reading ----------
    def days_for_range(self, start: datetime, end: datetime, lookback_days: int = 1) -> list[str]:
        """Existing day folders that can hold sessions overlapping [start, end].

        Sessions are filed under the day they started, so one that began before
        `start` and was still running at it lives in an earlier folder; that is
        what `lookback_days` reaches back for.
        """
        first = start.date() - timedelta(days=max(0, lookback_days))
        days, d = [], first
        while d <= end.date():
            name = d.strftime("%Y-%m-%d")
            if os.path.exists(os.path.join(self.root, name, LOG_NAME)):
                days.append(name)
            d += timedelta(days=1)
        return days

    def read_range(self, start: datetime, end: datetime, protocol: str | None = None,
                   q: str | None = None, limit: int = 5000, lookback_days: int = 1):
        """Sessions overlapping [start, end], newest first.

        Returns (rows, total, truncated, files). `total` counts every match, so
        the page can say "showing 5000 of 7312" instead of silently clipping.
        """
        needle = (q or "").strip().lower()
        proto = (protocol or "").strip().lower()
        files = self.days_for_range(start, end, lookback_days)
        matches = []
        for day in files:
            path = os.path.join(self.root, day, LOG_NAME)
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()
            except OSError:
                log.warning("Could not read %s", path)
                continue
            for ln in lines:
                if not ln.strip():
                    continue
                row = _row_from_fields(parse_line(ln))
                if row is None or row["end"] < start or row["start"] > end:
                    continue
                if proto and row["protocol"].lower() != proto:
                    continue
                if needle and needle not in " ".join(
                        (row["computer_name"], row["remote_ip"], row["protocol"])).lower():
                    continue
                matches.append(row)
        matches.sort(key=lambda r: r["start"], reverse=True)
        total = len(matches)
        return matches[:limit], total, total > limit, [f"{d}/{LOG_NAME}" for d in files]

    # ---------- state (survives crashes and power cuts) ----------
    def save_state(self, heartbeat: datetime, sessions) -> None:
        data = {"heartbeat": heartbeat.isoformat(), "sessions": [s.to_dict() for s in sessions]}
        self._atomic_write(self.state_path, json.dumps(data))

    def load_state(self):
        try:
            with open(self.state_path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def clear_state(self) -> None:
        try:
            os.remove(self.state_path)
        except OSError:
            pass

    @staticmethod
    def _atomic_write(path: str, text: str) -> None:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
