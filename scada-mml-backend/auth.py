"""Authentication endpoints: login, me, refresh, logout."""
import logging

import jwt
from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

import db
import security

logger = logging.getLogger("scada-api.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])
bearer_scheme = HTTPBearer(auto_error=True)

# In-memory denylist of revoked refresh-token JTIs (resets on restart — fine for test).
_revoked_refresh: set[str] = set()


# --- Schemas ---------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    id: int
    username: str
    role: str
    display_name: str


def _user_out(row: dict) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "display_name": row["display_name"],
    }


# --- Dependency ------------------------------------------------------------
def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    try:
        payload = security.decode_token(creds.credentials)
        if payload.get("type") != "access":
            raise jwt.InvalidTokenError("not an access token")
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        ) from exc

    user = db.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )
    return user


# --- Endpoints -------------------------------------------------------------
@router.post("/login")
def login(body: LoginRequest):
    user = db.get_user_by_username(body.username)
    if user is None or not security.verify_password(
        body.password, user["password_hash"]
    ):
        logger.info("Failed login attempt for username=%r", body.username)
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"message": "Invalid username or password"},
        )

    access = security.create_access_token(user["id"], user["role"])
    refresh = security.create_refresh_token(user["id"])
    logger.info("User %r logged in", user["username"])
    return {
        "access_token": access,
        "refresh_token": refresh,
        "expires_in": security.access_expires_seconds(),
        "user": _user_out(user),
    }


@router.get("/me", response_model=UserOut)
def me(current_user: dict = Depends(get_current_user)):
    return _user_out(current_user)


@router.post("/refresh")
def refresh(body: RefreshRequest):
    try:
        payload = security.decode_token(body.refresh_token)
        if payload.get("type") != "refresh":
            raise jwt.InvalidTokenError("not a refresh token")
        if payload.get("jti") in _revoked_refresh:
            raise jwt.InvalidTokenError("refresh token revoked")
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        ) from exc

    user = db.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )

    access = security.create_access_token(user["id"], user["role"])
    return {
        "access_token": access,
        "expires_in": security.access_expires_seconds(),
    }


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(body: LogoutRequest):
    try:
        payload = security.decode_token(body.refresh_token)
        jti = payload.get("jti")
        if jti:
            _revoked_refresh.add(jti)
    except jwt.PyJWTError:
        # Already invalid/expired — nothing to revoke.
        pass
    return Response(status_code=status.HTTP_204_NO_CONTENT)
