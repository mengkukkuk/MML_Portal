"""The Access monitor's session rules, with no sockets and no real clock.

The snapshot and the clock are injected, so each test scripts exactly which
(port, ip) pairs are visible at which instant. What is pinned down:

* a gap shorter than the port's grace merges into one session; a longer one splits
* the recorded end is last_seen, so grace seconds are never counted as usage
* grace is per port (web is long, RDP short)
* a crash is closed on next boot at min(last_seen, heartbeat); a clean stop says so
* loopback and IPv4-mapped addresses are normalised before keying
* range reads honour overlap, protocol and text filters, and the lookback day
"""
from datetime import datetime, timedelta

import pytest

from access_log import AccessLog
from access_monitor import Monitor, WatchedPort, parse_ports

T0 = datetime(2026, 10, 30, 9, 0, 0)


class FakeNames:
    def get(self, ip):
        return {"10.0.0.5": "QC-PC"}.get(ip, "Unknown")

    def request(self, ip):
        pass


class Rig:
    """A monitor whose clock and visible connections are driven by the test."""

    def __init__(self, tmp_path, ports=None, **kw):
        self.now = T0
        self.visible = set()
        self.store = AccessLog(str(tmp_path))
        self.ports = ports or {443: WatchedPort(443, "HTTPS", 10.0),
                               3389: WatchedPort(3389, "RDP", 10.0)}
        self.monitor = Monitor(self.ports, self.store, FakeNames(),
                               snapshot=lambda: iter(sorted(self.visible)),
                               clock=lambda: self.now, **kw)

    def tick(self, seconds=3, visible=None):
        self.now += timedelta(seconds=seconds)
        if visible is not None:
            self.visible = set(visible)
        self.monitor.tick()

    def lines(self, day=None):
        day = day or self.now.date()
        path = self.store.log_path(day)
        return [l for l in open(path, encoding="utf-8").read().splitlines() if l]


def conn(ip="10.0.0.5", port=443):
    return (port, ip)


# --- parse_ports -------------------------------------------------------------
def test_parse_ports_reads_label_and_grace_and_skips_junk():
    ports = parse_ports("443:HTTPS:120, 3389:RDP:10, 8080:Web, nope, 99999:Big, 25:Mail:abc")
    assert ports[443].grace_seconds == 120 and ports[443].label == "HTTPS"
    assert ports[3389].label == "RDP" and ports[8080].grace_seconds == 10.0
    assert set(ports) == {443, 3389, 8080}


# --- grace: merge vs split ---------------------------------------------------
def test_short_gap_merges_into_one_session(tmp_path):
    r = Rig(tmp_path)
    r.tick(visible=[conn()])                    # open at 09:00:03
    for _ in range(3):                          # missing 3, 6, 9 s: still inside grace
        r.tick(visible=[])
    r.tick(visible=[conn()])                    # back at 12 s: same session
    assert len(r.monitor.sessions) == 1
    assert r.monitor.sessions[conn()].start == T0 + timedelta(seconds=3)
    assert not (tmp_path / "2026-10-30" / "conn_monitor.log").exists()      # nothing finished yet


def test_long_gap_splits_and_end_is_last_seen(tmp_path):
    r = Rig(tmp_path)
    r.tick(visible=[conn()])                    # +3  start
    r.tick(visible=[conn()])                    # +6  last_seen
    for _ in range(4):                          # +9,+12,+15,+18: 12 s since last_seen -> closes
        r.tick(visible=[])
    assert r.monitor.sessions == {}
    (line,) = r.lines()
    assert "Start Time: 09:00:03" in line and "End Time: 09:00:06" in line
    assert "Duration: 00:00:03" in line and "Computer Name: QC-PC" in line
    r.tick(visible=[conn()])                    # reappears: a brand new session
    assert r.monitor.sessions[conn()].start == r.now


def test_grace_is_per_port(tmp_path):
    ports = {443: WatchedPort(443, "HTTPS", 120.0), 3389: WatchedPort(3389, "RDP", 10.0)}
    r = Rig(tmp_path, ports=ports)
    r.tick(visible=[conn(port=443), conn(port=3389)])
    for _ in range(5):                          # 15 s with both gone
        r.tick(visible=[])
    assert set(r.monitor.sessions) == {conn(port=443)}      # web still open, RDP closed
    (line,) = r.lines()
    assert "Protocol: RDP" in line and "Port: 3389" in line


def test_many_sockets_from_one_ip_are_one_session(tmp_path):
    r = Rig(tmp_path)
    r.visible = {conn()}
    r.tick()
    r.tick()
    assert len(r.monitor.sessions) == 1


# --- filtering ---------------------------------------------------------------
def test_unwatched_ports_and_prefixes_are_dropped(tmp_path):
    r = Rig(tmp_path, prefixes=("10.0.",))
    r.tick(visible=[conn("10.0.0.5", 443), conn("192.168.1.9", 443), conn("10.0.0.5", 8088)])
    assert set(r.monitor.sessions) == {conn("10.0.0.5", 443)}


def test_loopback_ignored_by_default_and_ipv4_mapped_is_normalised(tmp_path):
    r = Rig(tmp_path)
    r.tick(visible=[conn("127.0.0.1"), conn("::1"), conn("::ffff:127.0.0.1"), conn("::ffff:10.0.0.5")])
    assert set(r.monitor.sessions) == {conn("10.0.0.5")}


def test_loopback_can_be_kept(tmp_path):
    r = Rig(tmp_path, ignore_loopback=False)
    r.tick(visible=[conn("127.0.0.1")])
    assert set(r.monitor.sessions) == {conn("127.0.0.1")}


# --- shutdown and recovery ---------------------------------------------------
def test_clean_shutdown_closes_open_sessions_with_note(tmp_path):
    r = Rig(tmp_path)
    r.tick(visible=[conn()])
    r.tick(visible=[conn()])
    r.monitor.shutdown()
    (line,) = r.lines()
    assert "Note: Monitor stopped" in line and "End Time: 09:00:06" in line
    assert r.store.load_state() is None


def test_crash_is_closed_on_next_boot_at_min_of_last_seen_and_heartbeat(tmp_path):
    r = Rig(tmp_path)
    r.tick(visible=[conn()])
    r.tick(visible=[conn()])                    # state.json now holds the open session
    # process dies here; a new monitor boots on the same folder
    fresh = Rig(tmp_path)
    fresh.now = T0 + timedelta(hours=1)
    fresh.monitor.recover()
    (line,) = fresh.lines(T0.date())
    assert "Note: Interrupted" in line and "End Time: 09:00:06" in line
    assert fresh.store.load_state() is None


def test_recover_with_no_state_is_a_noop(tmp_path):
    r = Rig(tmp_path)
    r.monitor.recover()
    assert not (tmp_path / "state.json").exists()


def test_session_crossing_midnight_is_filed_under_its_start_day(tmp_path):
    r = Rig(tmp_path)
    r.now = datetime(2026, 10, 30, 23, 59, 50)
    r.tick(visible=[conn()])
    r.tick(seconds=30, visible=[conn()])        # 00:00:23 next day
    r.monitor.shutdown()
    assert len(r.lines(datetime(2026, 10, 30).date())) == 1
    assert not (tmp_path / "2026-10-31").exists()


def test_active_lists_open_sessions_oldest_first(tmp_path):
    r = Rig(tmp_path)
    r.tick(visible=[conn("10.0.0.5")])
    r.tick(visible=[conn("10.0.0.5"), conn("10.0.0.9", 3389)])
    rows = r.monitor.active()
    assert [(x["remote_ip"], x["protocol"]) for x in rows] == [("10.0.0.5", "HTTPS"), ("10.0.0.9", "RDP")]
    assert rows[0]["computer_name"] == "QC-PC"


def test_is_running_depends_on_a_recent_heartbeat(tmp_path):
    r = Rig(tmp_path)
    assert r.monitor.is_running() is False
    r.tick(visible=[])
    assert r.monitor.is_running() is True
    r.now += timedelta(seconds=60)
    assert r.monitor.is_running() is False


# --- range reads -------------------------------------------------------------
def _write(store, start, secs, ip="10.0.0.5", proto="HTTPS", port=443, name="QC-PC"):
    from access_monitor import Session
    store.write_session(Session(port, proto, ip, start, start + timedelta(seconds=secs)),
                        start + timedelta(seconds=secs), name)


def test_read_range_overlap_filters_and_orders_newest_first(tmp_path):
    store = AccessLog(str(tmp_path))
    _write(store, datetime(2026, 10, 30, 8, 0, 0), 600)                       # 08:00-08:10
    _write(store, datetime(2026, 10, 30, 9, 0, 0), 600, ip="10.0.0.9", proto="RDP", port=3389, name="IT-PC")
    _write(store, datetime(2026, 10, 30, 10, 0, 0), 600)                      # 10:00-10:10
    rows, total, truncated, files = store.read_range(
        datetime(2026, 10, 30, 8, 5), datetime(2026, 10, 30, 9, 30))
    assert [r["start"].hour for r in rows] == [9, 8]                           # newest first, 10:00 excluded
    assert total == 2 and truncated is False and files == ["2026-10-30/conn_monitor.log"]

    rows, *_ = store.read_range(datetime(2026, 10, 30), datetime(2026, 10, 31), protocol="rdp")
    assert [r["computer_name"] for r in rows] == ["IT-PC"]
    rows, *_ = store.read_range(datetime(2026, 10, 30), datetime(2026, 10, 31), q="10.0.0.9")
    assert len(rows) == 1 and rows[0]["port"] == 3389


def test_read_range_finds_a_session_that_started_the_day_before(tmp_path):
    store = AccessLog(str(tmp_path))
    _write(store, datetime(2026, 10, 29, 23, 50, 0), 1800)                    # runs to 00:20 on the 30th
    rows, total, *_ = store.read_range(datetime(2026, 10, 30, 0, 10), datetime(2026, 10, 30, 12, 0))
    assert total == 1
    rows, total, *_ = store.read_range(datetime(2026, 10, 30, 0, 10), datetime(2026, 10, 30, 12, 0),
                                       lookback_days=0)
    assert total == 0


def test_read_range_truncates_but_reports_the_true_total(tmp_path):
    store = AccessLog(str(tmp_path))
    for i in range(5):
        _write(store, datetime(2026, 10, 30, 8, i, 0), 30)
    rows, total, truncated, _ = store.read_range(
        datetime(2026, 10, 30), datetime(2026, 10, 31), limit=3)
    assert (len(rows), total, truncated) == (3, 5, True)


def test_read_range_skips_corrupt_lines(tmp_path):
    store = AccessLog(str(tmp_path))
    _write(store, datetime(2026, 10, 30, 8, 0, 0), 60)
    with open(store.log_path(datetime(2026, 10, 30).date()), "a", encoding="utf-8") as f:
        f.write("garbage without fields\n")
        f.write("Start Date: 30/10/2026 | Start Time: 09:00:00 | End Date: x\n")   # power cut mid-write
    rows, total, *_ = store.read_range(datetime(2026, 10, 30), datetime(2026, 10, 31))
    assert total == 1
