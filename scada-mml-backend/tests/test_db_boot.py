"""Tests for degraded boot: the app must serve even with no database at all.

No database is involved -- the schema DDL is patched to raise. What is under
test is the decision to keep serving, which is the part that is expensive to get
wrong in production: an exception raised from a startup handler aborts
Starlette's lifespan, so uvicorn exits before binding a single route, taking
/health with it and leaving NSSM to restart-loop for the length of the outage.

There is no failover to test any more. The app/config database is hardcoded to
localhost, so "the config database is unreachable" now means "this machine's own
Postgres is down" -- a local fault with a local fix, not something to route
around. Plant databases fail independently and are covered by the fan-out tests.
"""
import psycopg
import psycopg.errors

import db


def unreachable(*_a, **_k):
    """What a connect to a powered-off host raises: no sqlstate."""
    raise psycopg.OperationalError("connection timeout expired")


def test_create_tables_survives_unreachable_db(monkeypatch):
    """The regression that caused the outage: a startup handler that raises
    aborts the lifespan and the process exits before binding /health."""
    import main

    monkeypatch.setattr(db, "init_users_table", unreachable)
    assert main._create_tables() is False
    assert db.SCHEMA_READY is False


def test_create_tables_survives_permission_error(monkeypatch):
    """A live server that refuses the DDL must not stop the service booting
    either -- InsufficientPrivilege is a ProgrammingError, not an
    OperationalError, so a narrower guard would let it abort the lifespan."""
    import main

    def _denied():
        raise psycopg.errors.InsufficientPrivilege("must be owner of table")

    monkeypatch.setattr(db, "init_users_table", _denied)
    assert main._create_tables() is False


def test_health_stays_200_with_db_down(monkeypatch):
    """NSSM restarts the service on a failed /health, so a DB outage must not be
    reported as an unhealthy *service* -- that turns degraded into flapping.

    The route function is called directly rather than through TestClient: the
    lifespan would start the background loops, which is not what this asserts.
    """
    import asyncio

    import main

    monkeypatch.setattr(db, "_db_state", {"ok": False, "checked_at": None})
    body = asyncio.run(main.health())
    assert body["status"] == "ok"
    assert body["db"] == "unreachable"
    assert "db_error" not in body, "/health is unauthenticated - no error text"


def test_health_exposes_no_hostnames(monkeypatch):
    """/health has no auth dependency and -BindHost 0.0.0.0 is a documented
    deployment, so nothing identifying a database may appear in the body.
    Per-datasource detail belongs behind the admin-gated /api/system/db."""
    import asyncio

    import main

    monkeypatch.setattr(db, "_db_state", {"ok": True, "checked_at": None})
    body = asyncio.run(main.health())
    assert set(body) == {"status", "db", "checked_at"}
