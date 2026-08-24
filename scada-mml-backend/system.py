"""Database failover status and control.

Split from /health deliberately: /health is unauthenticated and must stay coarse,
while these routes expose hostnames and connection error text and so are gated on
an admin token, matching the pattern used for datasource writes.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel

import db
from auth import require_admin

router = APIRouter(prefix="/api/system", tags=["system"])


class CandidateOut(BaseModel):
    name: str
    host: str
    port: str
    database: str
    active: bool
    last_error: str | None = None


class DbStatusOut(BaseModel):
    active: str
    is_fallback: bool
    ok: bool
    schema_ready: bool
    checked_at: str | None = None
    candidates: list[CandidateOut]


@router.get("/db", response_model=DbStatusOut)
def db_status(_admin=Depends(require_admin)) -> DbStatusOut:
    """Which database the app is currently using, and why."""
    state = db.db_state()
    return DbStatusOut(
        active=state["active"],
        is_fallback=state["is_fallback"],
        ok=state["ok"],
        schema_ready=state["schema_ready"],
        checked_at=state["checked_at"],
        candidates=[CandidateOut(**c) for c in db.candidate_report()],
    )


class FailbackOut(BaseModel):
    active: str
    message: str


@router.post("/db/failback", response_model=FailbackOut)
def db_failback(_admin=Depends(require_admin)) -> FailbackOut:
    """Return to the primary database.

    Failover onto a fallback is automatic; coming back is not. While on a
    fallback the app writes panels, dashboards, mimic layouts and report
    templates *there*, and switching back silently would strand that work on the
    fallback while the app carried on against the primary. Making the return an
    explicit action keeps the operator aware that the two databases have
    diverged.
    """
    active = db.failback()
    return FailbackOut(
        active=active,
        message=(
            "Now using the primary database. Any changes saved while on the "
            "fallback remain there and are not copied over."
        ),
    )
