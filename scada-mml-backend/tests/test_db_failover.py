"""Tests for database failover in db.get_connection and degraded boot in main.

No database is involved: psycopg.connect is patched, so every case here is about
the decision logic, which is the part that is easy to get wrong and expensive to
get wrong in production.

The central assertion is the one in test_no_failover_on_*: failover must trigger
on "no server answered" only. psycopg maps several conditions reported *by a live
server* onto OperationalError too, and treating those as an outage would migrate
the app onto the fallback on a transient connection spike -- splitting writes
across two databases, which is worse than the outage failover exists to survive.
"""
import psycopg
import psycopg.errors
import pytest

import config
import db


def _candidates(n=2):
    return [
        {
            "name": "primary" if i == 0 else f"fallback{i}",
            "host": f"10.0.0.{i}",
            "port": "5432",
            "dbname": "app",
            "dsn": f"host=10.0.0.{i}",
        }
        for i in range(n)
    ]


@pytest.fixture
def two_dbs(monkeypatch):
    """Two candidates, failover state reset, DB_TARGET off."""
    monkeypatch.setattr(config, "DB_CANDIDATES", _candidates(2))
    monkeypatch.setattr(config, "DB_TARGET", "")
    monkeypatch.setattr(db, "_active_index", 0)
    monkeypatch.setattr(db, "_all_down_until", 0.0)
    monkeypatch.setattr(db, "_outage_logged", set())
    return config.DB_CANDIDATES


class FakeConn:
    def __init__(self, dsn):
        self.dsn = dsn


def unreachable(*_a, **_k):
    """What a connect to a powered-off host raises: no sqlstate."""
    raise psycopg.OperationalError("connection timeout expired")


def connect_map(mapping):
    """Patch target: dsn -> FakeConn, or a callable that raises."""
    def _connect(dsn, **_kw):
        outcome = mapping.get(dsn, unreachable)
        if callable(outcome):
            return outcome()
        return FakeConn(dsn)
    return _connect


# --- the discriminator ----------------------------------------------------

def test_connect_timeout_has_no_sqlstate_and_is_unreachable():
    # Pins the real-world behaviour the whole design rests on.
    assert db._is_unreachable(psycopg.OperationalError("connection timeout expired"))


@pytest.mark.parametrize(
    "exc_cls",
    [
        psycopg.errors.TooManyConnections,   # 53300 - plausible on a spike
        psycopg.errors.AdminShutdown,        # 57P01 - routine restart
        psycopg.errors.QueryCanceled,        # 57014
        psycopg.errors.InvalidPassword,      # 28P01 - misconfiguration
    ],
)
def test_server_errors_are_not_unreachable(exc_cls):
    assert not db._is_unreachable(exc_cls("server said no"))


# --- the walk -------------------------------------------------------------

def test_uses_primary_when_healthy(two_dbs, monkeypatch):
    monkeypatch.setattr(psycopg, "connect", connect_map({"host=10.0.0.0": True}))
    assert db.get_connection().dsn == "host=10.0.0.0"
    assert db._active_index == 0
    assert db.db_state()["is_fallback"] is False


def test_fails_over_to_fallback_when_primary_unreachable(two_dbs, monkeypatch):
    monkeypatch.setattr(psycopg, "connect", connect_map({"host=10.0.0.1": True}))
    assert db.get_connection().dsn == "host=10.0.0.1"
    assert db._active_index == 1
    state = db.db_state()
    assert state["is_fallback"] is True and state["ok"] is True


def test_stays_on_fallback_once_adopted(two_dbs, monkeypatch):
    """No automatic failback: the app has written to the fallback by now."""
    monkeypatch.setattr(psycopg, "connect", connect_map({"host=10.0.0.1": True}))
    db.get_connection()
    # Primary comes back...
    monkeypatch.setattr(
        psycopg, "connect", connect_map({"host=10.0.0.0": True, "host=10.0.0.1": True})
    )
    assert db.get_connection().dsn == "host=10.0.0.1"
    # ...and only an explicit failback returns.
    assert db.failback() == "primary"
    assert db.get_connection().dsn == "host=10.0.0.0"


@pytest.mark.parametrize(
    "exc_cls", [psycopg.errors.TooManyConnections, psycopg.errors.AdminShutdown]
)
def test_no_failover_on_server_originated_error(two_dbs, monkeypatch, exc_cls):
    """The most important negative test.

    Both hosts are up; the primary answers with a server error. The app must
    surface it and stay put -- a switch here would start splitting writes.
    """
    def _raise():
        raise exc_cls("server said no")

    monkeypatch.setattr(
        psycopg, "connect", connect_map({"host=10.0.0.0": _raise, "host=10.0.0.1": True})
    )
    with pytest.raises(psycopg.OperationalError):
        db.get_connection()
    assert db._active_index == 0


def test_no_failover_on_bad_password(two_dbs, monkeypatch):
    """A wrong fallback password must not be silently counted as 'host down'."""
    def _raise():
        raise psycopg.errors.InvalidPassword("password authentication failed")

    monkeypatch.setattr(
        psycopg, "connect", connect_map({"host=10.0.0.0": _raise, "host=10.0.0.1": True})
    )
    with pytest.raises(psycopg.errors.InvalidPassword):
        db.get_connection()
    assert db._active_index == 0


# --- total outage ---------------------------------------------------------

def test_all_down_raises_and_then_fails_fast(two_dbs, monkeypatch):
    calls = []

    def _connect(dsn, **_kw):
        calls.append(dsn)
        raise psycopg.OperationalError("connection timeout expired")

    monkeypatch.setattr(psycopg, "connect", _connect)

    with pytest.raises(psycopg.OperationalError):
        db.get_connection()
    assert len(calls) == 2, "should try every candidate once"

    # Within the cooldown the next call must not pay the connect timeout again.
    with pytest.raises(psycopg.OperationalError):
        db.get_connection()
    assert len(calls) == 2, "cooldown should short-circuit the walk"
    assert db.db_state()["ok"] is False


def test_recovers_after_cooldown_expires(two_dbs, monkeypatch):
    monkeypatch.setattr(psycopg, "connect", connect_map({}))
    with pytest.raises(psycopg.OperationalError):
        db.get_connection()
    monkeypatch.setattr(db, "_all_down_until", 0.0)   # cooldown elapsed
    monkeypatch.setattr(psycopg, "connect", connect_map({"host=10.0.0.0": True}))
    assert db.get_connection().dsn == "host=10.0.0.0"
    assert db.db_state()["ok"] is True


# --- DB_TARGET pinning ----------------------------------------------------

def test_db_target_pins_and_never_walks(two_dbs, monkeypatch):
    """seed_users.py relies on this: seeding the wrong database silently would
    be worse than a hard failure."""
    tried = []

    def _connect(dsn, **_kw):
        tried.append(dsn)
        if dsn == "host=10.0.0.0":
            return FakeConn(dsn)
        raise psycopg.OperationalError("connection timeout expired")

    monkeypatch.setattr(config, "DB_TARGET", "fallback1")
    monkeypatch.setattr(psycopg, "connect", _connect)
    with pytest.raises(psycopg.OperationalError):
        db.get_connection()   # must NOT fall back to the reachable primary
    assert tried == ["host=10.0.0.1"], "only the pinned candidate may be tried"


def test_db_target_unknown_name_raises(two_dbs, monkeypatch):
    monkeypatch.setattr(config, "DB_TARGET", "nope")
    with pytest.raises(RuntimeError, match="matches no candidate"):
        db.get_connection()


# --- degraded boot --------------------------------------------------------

def test_create_tables_survives_unreachable_db(monkeypatch):
    """The regression that caused the outage: a startup handler that raises
    aborts the lifespan and the process exits before binding /health."""
    import main

    monkeypatch.setattr(db, "init_panels_table", unreachable)
    assert main._create_tables() is False
    assert db.SCHEMA_READY is False


def test_health_stays_200_with_db_down(monkeypatch):
    """NSSM restarts the service on a failed /health, so a DB outage must not be
    reported as an unhealthy *service* -- that turns degraded into flapping.

    The route function is called directly rather than through TestClient: the
    lifespan would start the background loops, which is not what this asserts.
    """
    import asyncio

    import main

    monkeypatch.setattr(
        db, "_db_state", {"ok": False, "candidate": "primary", "checked_at": None}
    )
    body = asyncio.run(main.health())
    assert body["status"] == "ok"
    assert body["db"] == "unreachable"
    assert "db_error" not in body, "/health is unauthenticated - no error text"


def test_create_tables_survives_permission_error(monkeypatch):
    """A live server that refuses the DDL must not stop the service booting
    either -- InsufficientPrivilege is a ProgrammingError, not an
    OperationalError, so a narrower guard would let it abort the lifespan."""
    import psycopg.errors

    import main

    def _denied():
        raise psycopg.errors.InsufficientPrivilege("must be owner of table")

    monkeypatch.setattr(db, "init_panels_table", _denied)
    assert main._create_tables() is False


def test_outage_logging_is_per_candidate(two_dbs, monkeypatch):
    """With a fallback configured the health probe keeps succeeding on it, so a
    single global "already logged" flag would be cleared every cycle and the
    primary's outage would be re-logged forever."""
    monkeypatch.setattr(psycopg, "connect", connect_map({"host=10.0.0.1": True}))
    db.get_connection()                      # fails over, logs primary once
    assert "primary" in db._outage_logged
    db.get_connection()                      # succeeds on fallback again
    assert "primary" in db._outage_logged, "fallback success must not reset it"
