"""Database status for operators.

Split from /health deliberately: /health is unauthenticated and must stay coarse,
while these routes expose hostnames and connection error text and so are gated on
an admin token, matching the pattern used for datasource writes.
"""
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

import db
from auth import require_admin

router = APIRouter(prefix="/api/system", tags=["system"])


class CredentialSecurityOut(BaseModel):
    """Whether saved datasource passwords are actually encrypted at rest.

    `unconfigured` means no usable key, so passwords sit in plaintext and saving
    a new one is refused. `recovery_required` means stored ciphertext cannot be
    read with the configured key -- an admin has to re-enter those passwords or
    restore the original key.
    """
    state: Literal["unknown", "secure", "unconfigured", "recovery_required"]
    message: str | None = None
    migrated: int = 0
    plaintext_count: int = 0
    encrypted_count: int = 0
    recovery_required_count: int = 0


class DatasourceHealthOut(BaseModel):
    id: int
    name: str
    in_use: bool
    ok: bool
    last_error: str | None = None
    credential_state: Literal[
        "unknown", "empty", "plaintext", "encrypted", "recovery_required"
    ] = "unknown"


class DbStatusOut(BaseModel):
    ok: bool
    schema_ready: bool
    checked_at: str | None = None
    host: str
    database: str
    credential_security: CredentialSecurityOut
    # Aliased: `schema` shadows a deprecated BaseModel.schema() method in
    # Pydantic v2, which only warns rather than breaking, but the alias avoids
    # the warning while keeping the wire field named "schema".
    db_schema: str = Field(serialization_alias="schema")
    datasources: list[DatasourceHealthOut]

    model_config = {"populate_by_name": True}


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
        db_schema=state["schema"],
        credential_security=CredentialSecurityOut(
            **db.datasource_credential_security()
        ),
        datasources=[DatasourceHealthOut(**d) for d in db.datasource_health()],
    )
