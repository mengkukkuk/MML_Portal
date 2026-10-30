"""Watches inbound TCP connections to this host and turns them into sessions.

Ported from the standalone conn_monitor_py. A session is keyed by
(local port, remote IP): the first poll that sees a key opens it, later polls
refresh `last_seen`, and it closes once the key has been missing for the port's
grace period. The recorded end is `last_seen`, so grace seconds are never counted
as usage.

Nothing here may stop the API from booting: callers build the monitor inside a
try/except and a failed tick is logged, not raised (see main.py).
"""
import ipaddress
import logging
import subprocess
import sys
import threading
from dataclasses import dataclass
from datetime import datetime

try:
    import psutil  # optional; netstat is used when it is not installed
except ImportError:  # pragma: no cover - exercised only where psutil is absent
    psutil = None

log = logging.getLogger("access.monitor")
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

DEFAULT_GRACE_SECONDS = 10.0


@dataclass(frozen=True)
class WatchedPort:
    port: int
    label: str
    grace_seconds: float


def parse_ports(spec: str) -> dict[int, WatchedPort]:
    """'443:HTTPS:120,3389:RDP:10' -> {443: WatchedPort(...), 3389: ...}

    The grace field is optional ('8080:Web' uses the default). Malformed entries
    are skipped with a warning rather than failing startup.
    """
    ports: dict[int, WatchedPort] = {}
    for item in (spec or "").split(","):
        item = item.strip()
        if not item:
            continue
        parts = [p.strip() for p in item.split(":")]
        try:
            port = int(parts[0])
            label = parts[1] if len(parts) > 1 and parts[1] else str(port)
            grace = float(parts[2]) if len(parts) > 2 and parts[2] else DEFAULT_GRACE_SECONDS
        except ValueError:
            log.warning("Ignoring bad ACCESS_PORTS entry %r", item)
            continue
        if not 0 < port < 65536 or grace < 0:
            log.warning("Ignoring out-of-range ACCESS_PORTS entry %r", item)
            continue
        ports[port] = WatchedPort(port, label, grace)
    return ports


@dataclass
class Session:
    port: int
    protocol: str
    ip: str
    start: datetime
    last_seen: datetime

    @property
    def key(self):
        return (self.port, self.ip)

    def to_dict(self):
        return {"port": self.port, "protocol": self.protocol, "ip": self.ip,
                "start": self.start.isoformat(), "last_seen": self.last_seen.isoformat()}

    @classmethod
    def from_dict(cls, d):
        return cls(int(d["port"]), d["protocol"], d["ip"],
                   datetime.fromisoformat(d["start"]), datetime.fromisoformat(d["last_seen"]))


# ---------------- connection snapshot ----------------
def snapshot_psutil():
    for c in psutil.net_connections(kind="tcp"):
        if c.status == psutil.CONN_ESTABLISHED and c.laddr and c.raddr:
            yield c.laddr.port, c.raddr.ip


def snapshot_netstat():
    out = subprocess.run(["netstat", "-an", "-p", "TCP"], capture_output=True, text=True,
                         timeout=20, creationflags=CREATE_NO_WINDOW).stdout
    for line in out.splitlines():
        p = line.split()
        if len(p) < 4 or p[0].upper() != "TCP" or p[3].upper() != "ESTABLISHED":
            continue
        _, _, lport = p[1].rpartition(":")
        rip, _, _ = p[2].rpartition(":")
        if lport.isdigit():
            yield int(lport), rip.strip("[]")


def _is_loopback(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


class Monitor:
    def __init__(self, ports: dict[int, WatchedPort], storage, names, *,
                 prefixes=(), interval=3.0, ignore_loopback=True, snapshot=None, clock=None):
        self.ports = ports
        self.prefixes = tuple(prefixes or ())
        self.interval = float(interval)
        self.ignore_loopback = ignore_loopback
        self.storage = storage
        self.names = names
        self.sessions: dict[tuple, Session] = {}
        self.lock = threading.Lock()
        self.heartbeat: datetime | None = None
        self._clock = clock or datetime.now
        self.started = self._now()
        self._snapshot = snapshot or (snapshot_psutil if psutil else snapshot_netstat)
        log.info("Access monitor using %s for connection snapshots",
                 "psutil" if (psutil and not snapshot) else "netstat" if not snapshot else "injected snapshot")

    def _now(self) -> datetime:
        return self._clock().replace(microsecond=0)

    # ---------- helpers ----------
    def current_keys(self):
        keys = set()
        for lport, rip in self._snapshot():
            if rip.startswith("::ffff:"):
                rip = rip[7:]
            if lport not in self.ports:
                continue
            if self.ignore_loopback and _is_loopback(rip):
                continue
            if self.prefixes and not rip.startswith(self.prefixes):
                continue
            keys.add((lport, rip))
        return keys

    def active(self):
        """Open sessions, oldest first, shaped for the API."""
        with self.lock:
            items = sorted(self.sessions.values(), key=lambda s: s.start)
        return [{"computer_name": self.names.get(s.ip), "remote_ip": s.ip,
                 "protocol": s.protocol, "port": s.port, "connected_since": s.start}
                for s in items]

    def is_running(self) -> bool:
        hb = self.heartbeat
        return hb is not None and (self._now() - hb).total_seconds() < self.interval * 5

    # ---------- lifecycle ----------
    def recover(self):
        """Close sessions left open by a crash / power cut."""
        state = self.storage.load_state()
        if not state:
            return
        try:
            hb = datetime.fromisoformat(state["heartbeat"])
        except (KeyError, ValueError):
            hb = None
        for d in state.get("sessions", []):
            try:
                s = Session.from_dict(d)
            except (KeyError, ValueError):
                continue
            end = min(s.last_seen, hb) if hb else s.last_seen
            line = self.storage.write_session(s, end, self.names.get(s.ip),
                                              note="Interrupted (PC off or monitor stopped)")
            log.info("RECOVERED  %s", line)
        self.storage.clear_state()

    def prepare(self):
        """Run once before the first tick."""
        self.recover()
        self.storage.ensure_today()

    def tick(self):
        now = self._now()
        keys = self.current_keys()
        with self.lock:
            for key in keys:
                s = self.sessions.get(key)
                if s:
                    s.last_seen = now
                    continue
                port, ip = key
                s = Session(port, self.ports[port].label, ip, now, now)
                self.sessions[key] = s
                self.names.request(ip)
                log.info("CONNECT     %-8s %-16s (%s)", s.protocol, ip, self.names.get(ip))

            for key, s in list(self.sessions.items()):
                grace = self.ports[s.port].grace_seconds if s.port in self.ports else DEFAULT_GRACE_SECONDS
                if key not in keys and (now - s.last_seen).total_seconds() >= grace:
                    del self.sessions[key]
                    self.storage.write_session(s, s.last_seen, self.names.get(s.ip))
                    log.info("DISCONNECT  %-8s %-16s (%s) duration %s", s.protocol, s.ip,
                             self.names.get(s.ip), s.last_seen - s.start)

            self.heartbeat = now
            sessions = list(self.sessions.values())

        self.storage.save_state(now, sessions)

    def shutdown(self):
        """Clean stop: close every open session."""
        with self.lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        for s in sessions:
            self.storage.write_session(s, s.last_seen, self.names.get(s.ip), note="Monitor stopped")
        self.storage.clear_state()
        log.info("Access monitor stopped (%d open session(s) closed)", len(sessions))
