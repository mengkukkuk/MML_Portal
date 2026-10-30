"""The /api/access routes and their failure behaviour.

Route functions are called directly (as in test_router_envelopes.py); the admin
and licence dependencies are FastAPI-level and are checked by inspecting the
router rather than by spinning up a client.
"""
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

import access
import access_monitor
from access_log import AccessLog
from access_monitor import Monitor, Session, WatchedPort
from auth import require_admin
from licensing import require_valid_license


@pytest.fixture
def store(tmp_path, monkeypatch):
    s = AccessLog(str(tmp_path))
    monkeypatch.setattr(access, "_store", s)
    monkeypatch.setattr(access, "_monitor", None)
    return s


class _Names:
    def get(self, ip):
        return "QC-PC"

    def request(self, ip):
        pass


def _monitor(store, monkeypatch, visible):
    m = Monitor({443: WatchedPort(443, "HTTPS", 120.0)}, store, _Names(),
                snapshot=lambda: iter(visible))
    monkeypatch.setattr(access, "_monitor", m)
    return m


def _history(**kw):
    args = dict(start=None, end=None, protocol=None, q=None, limit=5000, _admin={})
    args.update(kw)
    return access.history(**args)


def test_every_route_requires_admin_and_a_valid_license():
    assert any(d.dependency is require_valid_license for d in access.router.dependencies)
    for route in access.router.routes:
        deps = [d.call for d in route.dependant.dependencies]
        assert require_admin in deps, route.path


def test_status_when_monitor_is_not_running(store):
    out = access.status({})
    assert out.running is False and out.ports == [] and out.since is None


def test_status_and_active_reflect_the_monitor(store, monkeypatch):
    m = _monitor(store, monkeypatch, [(443, "10.0.0.5")])
    m.tick()
    st = access.status({})
    assert st.running is True and [p.label for p in st.ports] == ["HTTPS"]
    act = access.active({})
    assert [(s.remote_ip, s.protocol, s.computer_name) for s in act.sessions] == [("10.0.0.5", "HTTPS", "QC-PC")]


def test_active_is_empty_without_a_monitor(store):
    assert access.active({}).sessions == []


def test_history_defaults_to_today_and_returns_rows(store):
    now = datetime.now().replace(microsecond=0)
    start = now.replace(hour=0, minute=0, second=0)
    store.write_session(Session(443, "HTTPS", "10.0.0.5", start, start), start + timedelta(seconds=90), "QC-PC")
    out = _history()
    assert out.total == 1 and out.rows[0].duration == "00:01:30" and out.rows[0].seconds == 90
    assert out.files == [f"{start:%Y-%m-%d}/conn_monitor.log"]


def test_history_rejects_inverted_and_oversized_ranges(store):
    t = datetime(2026, 10, 30, 12, 0)
    with pytest.raises(HTTPException) as e:
        _history(start=t, end=t - timedelta(hours=1))
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        _history(start=t - timedelta(days=access.MAX_RANGE_DAYS + 1), end=t)
    assert e.value.status_code == 400


def test_history_accepts_timezone_aware_bounds(store):
    from datetime import timezone
    out = _history(start=datetime(2026, 10, 30, 0, 0, tzinfo=timezone.utc),
                   end=datetime(2026, 10, 30, 6, 0, tzinfo=timezone.utc))
    assert out.start.tzinfo is None and out.end.tzinfo is None


def test_history_maps_unreadable_log_folder_to_503(store, monkeypatch):
    def boom(*a, **k):
        raise PermissionError("denied")
    monkeypatch.setattr(store, "read_range", boom)
    with pytest.raises(HTTPException) as e:
        _history()
    assert e.value.status_code == 503


def test_start_monitor_is_disabled_by_flag(monkeypatch):
    monkeypatch.setattr(access.config, "NETACCESS_ENABLED", False)
    monkeypatch.setattr(access, "_monitor", None)
    assert access.start_monitor() is None


def test_start_monitor_never_raises_when_the_log_root_is_unusable(monkeypatch, tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    monkeypatch.setattr(access.config, "NETACCESS_ENABLED", True)
    monkeypatch.setattr(access.config, "NETACCESS_LOG_ROOT", str(blocker / "sub"))
    monkeypatch.setattr(access, "_store", None)
    monkeypatch.setattr(access, "_monitor", None)
    assert access.start_monitor() is None


def test_stop_monitor_closes_open_sessions(store, monkeypatch):
    m = _monitor(store, monkeypatch, [(443, "10.0.0.5")])
    m.tick()
    access.stop_monitor()
    assert access._monitor is None
    rows, total, *_ = store.read_range(datetime.now() - timedelta(days=1), datetime.now() + timedelta(days=1))
    assert total == 1 and rows[0]["note"] == "Monitor stopped"
