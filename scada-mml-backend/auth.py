"""Authentication endpoints: login, me, refresh, logout.

Token strategy
--------------
* access_token  – short-lived JWT returned in the JSON response body.
                  The frontend stores it in Pinia memory (NOT localStorage)
                  and attaches it as  Authorization: Bearer <token>.
* refresh_token – long-lived JWT set as an HttpOnly, SameSite=Strict cookie.
                  JavaScript cannot read it, which defeats XSS token theft.
                  The browser sends it automatically on /api/auth/refresh and
                  /api/auth/logout.
"""
import logging
import os

import jwt
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

import db
import security

logger = logging.getLogger("scada-api.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])
bearer_scheme = HTTPBearer(auto_error=True)

# In-memory denylist of revoked refresh-token JTIs (resets on restart — fine for dev).
_revoked_refresh: set[str] = set()

# Cookie settings — set Secure=True in production (HTTPS only)
_COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
_COOKIE_SAMESITE = "strict"
_REFRESH_COOKIE = "refresh_token"


# --- Schemas ---------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str
    password: str


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


def _set_refresh_cookie(response: Response, token: str) -> None:
    """Write the refresh token as an HttpOnly cookie."""
    import security as _sec
    import config
    max_age = config.REFRESH_EXPIRE_DAYS * 86_400
    response.set_cookie(
        key=_REFRESH_COOKIE,
        value=token,
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite=_COOKIE_SAMESITE,
        max_age=max_age,
        path="/api/auth",   # only sent to auth endpoints — not every API call
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=_REFRESH_COOKIE,
        path="/api/auth",
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite=_COOKIE_SAMESITE,
    )


# --- Dependency ------------------------------------------------------------
def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """Validate the Bearer access token from the Authorization header."""
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
def login(body: LoginRequest, response: Response):
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

    # Refresh token → HttpOnly cookie (not in response body)
    _set_refresh_cookie(response, refresh)

    logger.info("User %r logged in", user["username"])
    return {
        "access_token": access,
        "expires_in": security.access_expires_seconds(),
        "user": _user_out(user),
        # NOTE: refresh_token intentionally omitted from body
    }


@router.get("/me", response_model=UserOut)
def me(current_user: dict = Depends(get_current_user)):
    return _user_out(current_user)


@router.post("/refresh")
def refresh(
    response: Response,
    refresh_token: str | None = Cookie(default=None, alias=_REFRESH_COOKIE),
):
    """Issue a new access token using the HttpOnly refresh cookie."""
    if refresh_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No refresh token cookie",
        )
    try:
        payload = security.decode_token(refresh_token)
        if payload.get("type") != "refresh":
            raise jwt.InvalidTokenError("not a refresh token")
        if payload.get("jti") in _revoked_refresh:
            raise jwt.InvalidTokenError("refresh token revoked")
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        ) from exc

    user = db.get_user_by_id(user_id)
    if user is None:
        _clear_refresh_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found"
        )

    # Rotate refresh token (refresh token rotation — old one stays valid until expiry
    # in this simple in-memory implementation, but production should add to denylist)
    new_refresh = security.create_refresh_token(user_id)
    _set_refresh_cookie(response, new_refresh)

    access = security.create_access_token(user["id"], user["role"])
    return {
        "access_token": access,
        "expires_in": security.access_expires_seconds(),
        "user": _user_out(user),
    }


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    refresh_token: str | None = Cookie(default=None, alias=_REFRESH_COOKIE),
):
    """Revoke the refresh token and clear the cookie."""
    if refresh_token:
        try:
            payload = security.decode_token(refresh_token)
            jti = payload.get("jti")
            if jti:
                _revoked_refresh.add(jti)
        except jwt.PyJWTError:
            pass  # Already invalid — nothing to revoke

    _clear_refresh_cookie(response)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
