"""A dashboard's pages — how many the Live page's arrows step through."""
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import dashboards
import db

ADMIN = {"username": "admin", "role": "admin"}
BOARD = {"id": 3, "title": "KPI test", "position": 1, "page_count": 1, "created_at": "2026-10-22T00:04:13+07:00"}


def test_page_count_is_set(monkeypatch):
    seen = {}

    def fake(dashboard_id, page_count):
        seen.update(id=dashboard_id, n=page_count)
        return {**BOARD, "page_count": page_count}
    monkeypatch.setattr(db, "set_dashboard_pages", fake)
    out = dashboards.set_dashboard_pages(3, dashboards.DashboardPagesIn(page_count=3), _admin=ADMIN)
    assert out["page_count"] == 3 and seen == {"id": 3, "n": 3}


@pytest.mark.parametrize("n", [0, db.MAX_DASHBOARD_PAGES + 1])
def test_page_count_out_of_range_is_refused(n):
    with pytest.raises(ValidationError):
        dashboards.DashboardPagesIn(page_count=n)


def test_unknown_dashboard(monkeypatch):
    monkeypatch.setattr(db, "set_dashboard_pages", lambda i, n: None)
    with pytest.raises(HTTPException) as e:
        dashboards.set_dashboard_pages(99, dashboards.DashboardPagesIn(page_count=2), _admin=ADMIN)
    assert e.value.status_code == 404


def test_storage_refuses_a_count_the_api_would_not_send():
    with pytest.raises(ValueError):
        db.set_dashboard_pages(3, 0)


def test_boards_listed_before_the_column_read_as_one_page():
    assert dashboards.DashboardOut(**{k: v for k, v in BOARD.items() if k != "page_count"}).page_count == 1
