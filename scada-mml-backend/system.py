"""Database status for operators.

Split from /health deliberately: /health is unauthenticated and must stay coarse,
while these routes expose hostnames and connection error text and so are gated on
an admin token, matching the pattern used for datasource writes.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel

import db
from auth import require_admin

router = APIRouter(prefix="/api/system", tags=["system"])


class DatasourceHealthOut(BaseModel):
    id: int
    name: str
    in_use: bool
    ok: bool
    last_error: str | None = None


class DbStatusOut(BaseModel):
    ok: bool
    schema_ready: bool
    checked_at: str | None = None
    host: str
    database: str
    datasources: list[DatasourceHealthOut]


@router.get("/db", response_model=DbStatusOut)
def db_status(_admin=Depends(require_admin)) -> DbStatusOut:
    """Health of the app/config database, plus each saved plant datasource.

    The app database is fixed at localhost and has no failover: it is the one
    database the process cannot run without, and it lives on the same machine.
    Plant connectivity is per-datasource and degrades independently, which is
    what `datasources` reports. A source with `in_use=false` has simply never
    been opened this process lifetime — that is not an error.
    """
    state = db.db_state()
    return DbStatusOut(
        ok=state["ok"],
        schema_ready=state["schema_ready"],
        checked_at=state["checked_at"],
        host=state["host"],
        database=state["database"],
        datasources=[DatasourceHealthOut(**d) for d in db.datasource_health()],
    )
