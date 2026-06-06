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
import psycopg
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

import config
import db
import mailer
import security

# Public self-registration always creates an operator — never an admin.
SELF_REGISTER_ROLE = "operator"

logger = logging.getLogger("mml-api.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])
bearer_scheme = HTTPBearer(auto_error=True)

# In-memory denylist of revoked refresh-token JTIs (resets on restart — fine for dev).
_revoked_refresh: set[str] = set()
# In-memory set of consumed reset-token JTIs, for single-use reset links.
# Dev-only: resets on restart and assumes a single worker process.
_used_reset: set[str] = set()

# Cookie settings — set Secure=True in production (HTTPS only)
_COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
_COOKIE_SAMESITE = "strict"
_REFRESH_COOKIE = "refresh_token"


# --- Schemas ---------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str
    display_name: str
    email: str | None = None


class UserOut(BaseModel):
    id: int
    username: str
    role: str
    display_name: str


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


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


def require_admin(current_user: dict = Depends(get_current_user)) -> dict:
    """Allow only admins through. Use as a dependency on admin-only endpoints."""
    if current_user["role"] != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required"
        )
    return current_user


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


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest, response: Response):
    """Public self-registration. Always creates an operator (never an admin),
    then signs the new user in (same response shape as /login)."""
    username = body.username.strip()
    display_name = body.display_name.strip()
    if not username or not display_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username and display name are required",
        )
    if len(body.password) < config.MIN_PASSWORD_LEN:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Password must be at least {config.MIN_PASSWORD_LEN} characters",
        )
    email = (body.email or "").strip() or None
    try:
        user = db.create_user(
            username,
            security.hash_password(body.password),
            SELF_REGISTER_ROLE,
            display_name,
            email,
        )
    except psycopg.errors.UniqueViolation as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username or email already exists",
        ) from exc

    access = security.create_access_token(user["id"], user["role"])
    _set_refresh_cookie(response, security.create_refresh_token(user["id"]))
    logger.info("New user %r self-registered (role=%s)", username, user["role"])
    return {
        "access_token": access,
        "expires_in": security.access_expires_seconds(),
        "user": _user_out(user),
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


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    current_user: dict = Depends(get_current_user),
):
    """Change the logged-in user's own password (verifies the old password)."""
    if not security.verify_password(body.old_password, current_user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )
    if len(body.new_password) < config.MIN_PASSWORD_LEN:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"New password must be at least {config.MIN_PASSWORD_LEN} characters",
        )
    db.set_password(current_user["id"], security.hash_password(body.new_password))
    logger.info("User %r changed their password", current_user["username"])
    return {"message": "Password changed"}


@router.post("/forgot-password")
def forgot_password(body: ForgotPasswordRequest):
    """Email a reset link if the address matches a user.

    Always returns 200 with a generic message so the response does not reveal
    whether an email is registered.
    """
    generic = {
        "message": "If that email is registered, a reset link has been sent.",
    }
    email = body.email.strip()
    if not email:
        return generic

    user = db.get_user_by_email(email)
    if user is not None:
        token = security.create_reset_token(user["id"])
        reset_link = f"{config.APP_BASE_URL}/reset-password?token={token}"
        mailer.send_password_reset(user["email"], reset_link)
    else:
        logger.info("Forgot-password requested for unknown email=%r", email)
    return generic


@router.post("/reset-password")
def reset_password(body: ResetPasswordRequest):
    """Consume a single-use reset token and set a new password.

    Invalid/expired tokens return 400 (NOT 401) so the public reset page's
    error is shown instead of triggering the axios refresh-on-401 interceptor.
    """
    if len(body.new_password) < config.MIN_PASSWORD_LEN:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"New password must be at least {config.MIN_PASSWORD_LEN} characters",
        )
    try:
        payload = security.decode_token(body.token)
        if payload.get("type") != "reset":
            raise jwt.InvalidTokenError("not a reset token")
        jti = payload.get("jti")
        if not jti or jti in _used_reset:
            raise jwt.InvalidTokenError("reset token already used")
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset link",
        ) from exc

    if not db.set_password(user_id, security.hash_password(body.new_password)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset link",
        )
    _used_reset.add(jti)
    logger.info("Password reset completed for user id=%s", user_id)
    return {"message": "Password has been reset"}
