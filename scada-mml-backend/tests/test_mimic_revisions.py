from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

import db
import mimic

ADMIN = {"id": 1, "role": "admin"}
DOC = {"version": 2, "viewBox": {"w": 1600, "h": 900}, "nodes": [], "edges": []}
ROW = {
    "slug": "plant-1", "name": "Plant 1", "doc": DOC,
    "updated_at": datetime(2026, 8, 25, tzinfo=timezone.utc),
}


class FakeConnection:
    def __init__(self, row):
        self.row = row
        self.sql = None
        self.params = None
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params):
        self.sql = " ".join(sql.split())
        self.params = params
        return self

    def fetchone(self):
        return self.row

    def commit(self):
        self.committed = True


@pytest.fixture(autouse=True)
def _skip_layout_validation(monkeypatch):
    monkeypatch.setattr(mimic, "_validate", lambda _doc: None)


def test_legacy_request_omitting_revision_remains_unconditional(monkeypatch):
    seen = {}
    monkeypatch.setattr(db, "upsert_mimic_layout", lambda *args, **kwargs: (
        seen.update(kwargs) or ROW
    ))
    mimic.save_layout("plant-1", mimic.MimicIn(name="Plant 1", doc=DOC), ADMIN)
    assert seen["enforce_revision"] is False


def test_new_layout_may_send_an_explicit_null_revision(monkeypatch):
    seen = {}
    monkeypatch.setattr(db, "upsert_mimic_layout", lambda *args, **kwargs: (
        seen.update(kwargs) or ROW
    ))
    body = mimic.MimicIn(name="Plant 1", doc=DOC, base_updated_at=None)
    mimic.save_layout("plant-1", body, ADMIN)
    assert seen == {"base_updated_at": None, "enforce_revision": True}


def test_matching_revision_is_forwarded(monkeypatch):
    revision = ROW["updated_at"]
    seen = {}
    monkeypatch.setattr(db, "upsert_mimic_layout", lambda *args, **kwargs: (
        seen.update(kwargs) or ROW
    ))
    mimic.save_layout(
        "plant-1", mimic.MimicIn(name="Plant 1", doc=DOC, base_updated_at=revision), ADMIN
    )
    assert seen["base_updated_at"] == revision
    assert seen["enforce_revision"] is True


def test_stale_revision_returns_409(monkeypatch):
    monkeypatch.setattr(db, "upsert_mimic_layout", lambda *args, **kwargs: None)
    with pytest.raises(HTTPException) as exc:
        mimic.save_layout(
            "plant-1",
            mimic.MimicIn(name="Plant 1", doc=DOC, base_updated_at=ROW["updated_at"]),
            ADMIN,
        )
    assert exc.value.status_code == 409
    assert "changed on the server" in exc.value.detail


def test_persistence_legacy_save_uses_unconditional_upsert(monkeypatch):
    conn = FakeConnection(ROW)
    monkeypatch.setattr(db, "get_connection", lambda: conn)

    assert db.upsert_mimic_layout("plant-1", "Plant 1", DOC) == ROW
    assert "ON CONFLICT (slug) DO UPDATE" in conn.sql
    assert "updated_at = now()" in conn.sql
    assert conn.params[:2] == ("plant-1", "Plant 1")
    assert conn.committed is True


def test_persistence_explicit_null_is_insert_only(monkeypatch):
    conn = FakeConnection(None)
    monkeypatch.setattr(db, "get_connection", lambda: conn)

    result = db.upsert_mimic_layout(
        "plant-1", "Plant 1", DOC, base_updated_at=None, enforce_revision=True
    )
    assert result is None
    assert "ON CONFLICT (slug) DO NOTHING" in conn.sql
    assert "DO UPDATE" not in conn.sql


def test_persistence_revision_update_matches_slug_and_timestamp(monkeypatch):
    revision = ROW["updated_at"]
    conn = FakeConnection(ROW)
    monkeypatch.setattr(db, "get_connection", lambda: conn)

    assert db.upsert_mimic_layout(
        "plant-1", "Plant 1", DOC,
        base_updated_at=revision, enforce_revision=True,
    ) == ROW
    assert "WHERE slug = %s AND updated_at = %s" in conn.sql
    assert conn.params[2:] == ("plant-1", revision)
