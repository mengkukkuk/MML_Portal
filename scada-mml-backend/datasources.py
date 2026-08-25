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
import config
from auth import get_current_user, require_admin
from licensing import current_status, require_datasource_slot, require_valid_license

router = APIRouter(
    prefix="/api/datasources",
    tags=["datasources"],
    dependencies=[Depends(require_valid_license)],
)

VALID_TYPES = {"postgres", "timescaledb"}
VALID_SSLMODES = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}
CONNECT_TIMEOUT_S = config.DB_CONNECT_TIMEOUT


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
    db_schema: str = "public"
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
    db_schema: str = Field("public", min_length=1, max_length=120)


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


class SelectedDatasourceOut(BaseModel):
    id: int
    name: str
    host: str
    database: str
    position: int


class SelectionOut(BaseModel):
    selected: list[SelectedDatasourceOut]
    # True when nothing was explicitly chosen and the server picked a default.
    # The header renders an implicit choice muted, so an operator can tell the
    # difference between "I selected this plant" and "this is just what there is".
    implicit: bool


class SelectionIn(BaseModel):
    datasource_ids: list[int] = Field(default_factory=list)


# --- Helpers ---------------------------------------------------------------
def _selection_response(user_id: int) -> "SelectionOut":
    """Current selection, falling back to the implicit default.

    Mirrors auth.resolve_active_datasources so the header always shows exactly
    the sources the data endpoints are about to read. The [None] tier — no saved
    datasources at all — has nothing to name, so it renders as an empty list.
    """
    rows = db.get_user_selection(user_id)
    if rows:
        return SelectionOut(
            selected=[SelectedDatasourceOut(**r) for r in rows], implicit=False
        )
    fallback = db.default_datasource()
    return SelectionOut(
        selected=(
            [SelectedDatasourceOut(**fallback, position=0)] if fallback else []
        ),
        implicit=True,
    )


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


# --- Per-user selection ----------------------------------------------------
# Declared BEFORE /{datasource_id}: FastAPI matches in declaration order, and
# `PUT /api/datasources/selection` would otherwise be captured by
# `PUT /api/datasources/{datasource_id}` and 422 on the int conversion.
#
# Gated on get_current_user rather than require_admin: which plants an operator
# is looking at is personalisation, not configuration, and GET /api/datasources
# is already open to any authenticated user.
@router.get("/selection", response_model=SelectionOut)
def get_selection(current_user: dict = Depends(get_current_user)):
    return _selection_response(current_user["id"])


@router.put("/selection", response_model=SelectionOut)
def put_selection(body: SelectionIn, current_user: dict = Depends(get_current_user)):
    if len(body.datasource_ids) > 1:
        features = (current_status().payload or {}).get("entitlements", {}).get("features", [])
        if "multi_datasource" not in features:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"reason": "feature_not_entitled", "feature": "multi_datasource"},
            )
    try:
        db.set_user_selection(current_user["id"], body.datasource_ids)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return _selection_response(current_user["id"])


@router.delete("/selection", response_model=SelectionOut)
def clear_selection(current_user: dict = Depends(get_current_user)):
    """Drop the explicit selection and fall back to the implicit default."""
    db.set_user_selection(current_user["id"], [])
    return _selection_response(current_user["id"])


@router.post("", response_model=DatasourceOut, status_code=status.HTTP_201_CREATED)
def create_datasource(
    body: DatasourceIn,
    _admin: dict = Depends(require_admin),
    _slot: object = Depends(require_datasource_slot),
):
    _validate(body)
    try:
        return db.create_datasource(
            body.name.strip(), body.type, body.host.strip(), body.port,
            body.database.strip(), body.username.strip(), body.password or "",
            body.sslmode, body.db_schema.strip(),
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
            new_password, body.sslmode, body.db_schema.strip(),
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
