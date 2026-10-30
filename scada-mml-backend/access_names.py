"""IP -> computer name for the Access monitor.

1) ACCESS_NAMES_FILE   optional "IP  name" table you maintain; reloaded when edited
2) auto_names.txt      cache of names found automatically
3) ask the remote PC   NetBIOS via nbtstat, then reverse DNS, on a background thread
"""
import logging
import os
import re
import socket
import subprocess
import sys
import threading

log = logging.getLogger("access.names")

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
NBT_RE = re.compile(r"^\s*(\S+)\s+<00>\s+UNIQUE", re.IGNORECASE | re.MULTILINE)


def _read_text(path: str) -> str:
    with open(path, "rb") as f:
        raw = f.read()
    for enc in ("utf-8-sig", "cp874", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _parse_names(path: str | None) -> dict:
    names = {}
    if not path or not os.path.exists(path):
        return names
    for line in _read_text(path).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) == 2:
            names[parts[0]] = parts[1].strip()
    return names


class NameBook:
    def __init__(self, names_path: str | None, cache_path: str, auto_resolve: bool = True):
        self.names_path = names_path or None
        self.cache_path = cache_path
        self.auto_resolve = auto_resolve
        self._lock = threading.Lock()
        self._static = {}
        self._mtime = None
        self._cache = _parse_names(cache_path)
        self._pending = set()
        self._reload()
        if self.names_path and not os.path.exists(self.names_path):
            log.warning("Names file not found: %s", self.names_path)

    def _reload(self) -> None:
        if not self.names_path:
            return
        try:
            mtime = os.path.getmtime(self.names_path)
        except OSError:
            mtime = None
        if mtime != self._mtime:
            self._static = _parse_names(self.names_path)
            self._mtime = mtime

    def get(self, ip: str) -> str:
        with self._lock:
            self._reload()
            return self._static.get(ip) or self._cache.get(ip) or "Unknown"

    def request(self, ip: str) -> None:
        """Start a background lookup if the name is not known yet."""
        if not self.auto_resolve:
            return
        with self._lock:
            if ip in self._static or ip in self._cache or ip in self._pending:
                return
            self._pending.add(ip)
        threading.Thread(target=self._resolve, args=(ip,), daemon=True).start()

    def _resolve(self, ip: str) -> None:
        try:
            name = self._nbtstat(ip) or self._reverse_dns(ip)
            if name:
                with self._lock:
                    self._cache[ip] = name
                    with open(self.cache_path, "a", encoding="utf-8") as f:
                        f.write(f"{ip} {name}\n")
                log.info("Resolved %s -> %s", ip, name)
        except Exception:
            log.exception("Name lookup failed for %s", ip)
        finally:
            with self._lock:
                self._pending.discard(ip)

    @staticmethod
    def _nbtstat(ip: str):
        if sys.platform != "win32":
            return None
        try:
            out = subprocess.run(["nbtstat", "-A", ip], capture_output=True, text=True,
                                 timeout=15, creationflags=CREATE_NO_WINDOW).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        m = NBT_RE.search(out or "")
        return m.group(1) if m else None

    @staticmethod
    def _reverse_dns(ip: str):
        try:
            host = socket.gethostbyaddr(ip)[0]
        except OSError:
            return None
        if not host or host == ip:
            return None
        return host.split(".")[0]
