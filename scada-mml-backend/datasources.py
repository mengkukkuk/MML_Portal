"""Saved-connection (datasource) endpoints.

Admins manage named PostgreSQL connections that Live panels can bind to
(dashboard_panels.datasource_id). Reads are open to any authenticated user so
the panel editor can list them; writes and the connection test require an admin
token. The test endpoint opens a real, short-lived libpq connection and reports
the outcome — it never persists anything.

Security: passwords are never returned (the public projection exposes only
`has_password`). The test endpoint can probe arbitrary hosts, so it is
admin-only.
"""
from datetime import datetime

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

import db
from auth import get_current_user, require_admin

router = APIRouter(prefix="/api/datasources", tags=["datasources"])

VALID_TYPES = {"postgres", "timescaledb"}
VALID_SSLMODES = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}
CONNECT_TIMEOUT_S = 5


# --- Schemas ---------------------------------------------------------------
class DatasourceOut(BaseModel):
    id: int
    name: str
    type: str
    host: str
    port: int
    database: str
    username: str
    sslmode: str
    has_password: bool
    created_at: datetime
    updated_at: datetime


class DatasourceIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    type: str = "postgres"
    host: str = Field("", max_length=255)
    port: int = Field(5432, ge=1, le=65535)
    database: str = Field("", max_length=255)
    username: str = Field("", max_length=255)
    # Omit / send null on update to keep the stored secret unchanged.
    password: str | None = None
    sslmode: str = "prefer"


class DatasourceTestIn(BaseModel):
    """Either reference a saved connection by id, supply raw fields, or both
    (provided fields override the saved ones — used by the 'retest while
    editing' flow). A null/blank password falls back to the stored secret."""
    datasource_id: int | None = None
    type: str | None = None
    host: str | None = None
    port: int | None = Field(None, ge=1, le=65535)
    database: str | None = None
    username: str | None = None
    password: str | None = None
    sslmode: str | None = None


class TestResult(BaseModel):
    ok: bool
    message: str
    server_version: str | None = None


# --- Helpers ---------------------------------------------------------------
def _validate(body: DatasourceIn) -> None:
    if body.type not in VALID_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"type must be one of: {', '.join(sorted(VALID_TYPES))}",
        )
    if body.sslmode not in VALID_SSLMODES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"sslmode must be one of: {', '.join(sorted(VALID_SSLMODES))}",
        )


# --- Endpoints -------------------------------------------------------------
@router.get("", response_model=list[DatasourceOut])
def list_datasources(_user: dict = Depends(get_current_user)):
    return db.list_datasources()


@router.post("", response_model=DatasourceOut, status_code=status.HTTP_201_CREATED)
def create_datasource(body: DatasourceIn, _admin: dict = Depends(require_admin)):
    _validate(body)
    try:
        return db.create_datasource(
            body.name.strip(), body.type, body.host.strip(), body.port,
            body.database.strip(), body.username.strip(), body.password or "",
            body.sslmode,
        )
    except psycopg.errors.UniqueViolation:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A connection named {body.name!r} already exists",
        )


@router.put("/{datasource_id}", response_model=DatasourceOut)
def update_datasource(datasource_id: int, body: DatasourceIn, _admin: dict = Depends(require_admin)):
    _validate(body)
    # password=None keeps the stored secret; a non-empty string replaces it.
    new_password = body.password if body.password else None
    try:
        ds = db.update_datasource(
            datasource_id, body.name.strip(), body.type, body.host.strip(),
            body.port, body.database.strip(), body.username.strip(),
            new_password, body.sslmode,
        )
    except psycopg.errors.UniqueViolation:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A connection named {body.name!r} already exists",
        )
    if ds is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Connection not found")
    return ds


@router.delete("/{datasource_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_datasource(datasource_id: int, _admin: dict = Depends(require_admin)):
    if not db.delete_datasource(datasource_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Connection not found")


@router.post("/test", response_model=TestResult)
def test_datasource(body: DatasourceTestIn, _admin: dict = Depends(require_admin)):
    """Open a real connection with the given params and report the result.

    Runs in FastAPI's threadpool (sync route), so the blocking libpq connect
    doesn't stall the event loop. Always returns 200 with ok=true/false — a
    failed probe is a normal outcome, not an HTTP error.
    """
    base = {}
    if body.datasource_id is not None:
        base = db.get_datasource_secret(body.datasource_id) or {}
        if not base:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Connection not found"
            )

    def pick(field: str, default=""):
        val = getattr(body, field)
        return val if val is not None else base.get(field, default)

    host = pick("host")
    port = int(pick("port", 5432) or 5432)
    database = pick("database")
    username = pick("username")
    sslmode = pick("sslmode", "prefer") or "prefer"
    # Typed password wins; otherwise reuse the stored secret.
    password = body.password if body.password else base.get("password", "")

    if not host or not database:
        return TestResult(ok=False, message="Host and database are required.")

    try:
        with psycopg.connect(
            host=host, port=port, dbname=database, user=username,
            password=password, sslmode=sslmode, connect_timeout=CONNECT_TIMEOUT_S,
        ) as conn:
            row = conn.execute("SELECT version() AS v").fetchone()
        version = (row[0] if row else "").split(",")[0] or None
        return TestResult(ok=True, message="Connection OK", server_version=version)
    except psycopg.OperationalError as e:
        # libpq surfaces host/auth/timeout failures here — trim the noisy prefix.
        msg = str(e).strip().splitlines()[0] if str(e).strip() else "Connection failed"
        return TestResult(ok=False, message=msg)
    except Exception as e:  # noqa: BLE001 — report any unexpected failure verbatim
        return TestResult(ok=False, message=f"{type(e).__name__}: {e}")
