"""Admin-only user management: list / create / update / delete users.

All endpoints require an admin access token (``require_admin``). Guards prevent
an admin from locking everyone out (no self-delete, no removing the last admin).
"""
import logging
from datetime import datetime

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

import config
import db
import security
from auth import require_admin

logger = logging.getLogger("mml-api.users")

router = APIRouter(prefix="/api/users", tags=["users"])

VALID_ROLES = {"admin", "operator"}


# --- Schemas ---------------------------------------------------------------
class UserAdminOut(BaseModel):
    id: int
    username: str
    role: str
    display_name: str
    email: str | None = None
    created_at: datetime


class UserCreate(BaseModel):
    username: str
    password: str
    role: str
    display_name: str
    email: str | None = None


class UserUpdate(BaseModel):
    role: str
    display_name: str
    email: str | None = None


# --- Helpers ---------------------------------------------------------------
def _norm_email(email: str | None) -> str | None:
    """Trim and treat blank as NULL so the partial unique index behaves."""
    if email is None:
        return None
    email = email.strip()
    return email or None


def _validate_role(role: str) -> None:
    if role not in VALID_ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Role must be one of: {', '.join(sorted(VALID_ROLES))}",
        )


def _validate_password(password: str) -> None:
    if len(password) < config.MIN_PASSWORD_LEN:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Password must be at least {config.MIN_PASSWORD_LEN} characters",
        )


# --- Endpoints -------------------------------------------------------------
@router.get("", response_model=list[UserAdminOut])
def list_all_users(_admin: dict = Depends(require_admin)):
    return db.list_users()


@router.post("", response_model=UserAdminOut, status_code=status.HTTP_201_CREATED)
def create_user(body: UserCreate, _admin: dict = Depends(require_admin)):
    username = body.username.strip()
    display_name = body.display_name.strip()
    if not username or not display_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username and display name are required",
        )
    _validate_role(body.role)
    _validate_password(body.password)
    try:
        user = db.create_user(
            username,
            security.hash_password(body.password),
            body.role,
            display_name,
            _norm_email(body.email),
        )
    except psycopg.errors.UniqueViolation as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username or email already exists",
        ) from exc
    logger.info("Admin created user %r (role=%s)", username, body.role)
    return user


@router.put("/{user_id}", response_model=UserAdminOut)
def update_user(user_id: int, body: UserUpdate, _admin: dict = Depends(require_admin)):
    display_name = body.display_name.strip()
    if not display_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Display name is required",
        )
    _validate_role(body.role)

    target = db.get_user_by_id(user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # Last-admin guard: don't allow demoting the final admin.
    if target["role"] == "admin" and body.role != "admin" and db.count_admins() <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove the last remaining admin",
        )

    try:
        user = db.update_user(user_id, body.role, display_name, _norm_email(body.email))
    except psycopg.errors.UniqueViolation as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Email already exists"
        ) from exc
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    logger.info("Admin updated user id=%s (role=%s)", user_id, body.role)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: int, admin: dict = Depends(require_admin)):
    if user_id == admin["id"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot delete your own account",
        )
    target = db.get_user_by_id(user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if target["role"] == "admin" and db.count_admins() <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete the last remaining admin",
        )
    db.delete_user(user_id)
    logger.info("Admin deleted user id=%s (%r)", user_id, target["username"])
