"""Password hashing (stdlib scrypt) and JWT creation/verification (PyJWT)."""
import hashlib
import hmac
import os
import uuid
from datetime import datetime, timedelta, timezone

import jwt

import config

# scrypt parameters (interactive-login friendly)
_SCRYPT_N = 16384
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 64


# --- Password hashing -------------------------------------------------------
def hash_password(password: str) -> str:
    """Return a self-describing hash: ``scrypt$<salt_hex>$<hash_hex>``."""
    salt = os.urandom(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_DKLEN,
    )
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, hash_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = bytes.fromhex(hash_hex)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=_SCRYPT_N,
            r=_SCRYPT_R,
            p=_SCRYPT_P,
            dklen=len(expected),
        )
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


# --- JWT --------------------------------------------------------------------
def _encode(payload: dict, expires: timedelta) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        **payload,
        "iat": now,
        "exp": now + expires,
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, config.JWT_SECRET, algorithm=config.JWT_ALGORITHM)


def create_access_token(user_id: int, role: str) -> str:
    return _encode(
        {"sub": str(user_id), "role": role, "type": "access"},
        timedelta(minutes=config.ACCESS_EXPIRE_MIN),
    )


def create_refresh_token(user_id: int) -> str:
    return _encode(
        {"sub": str(user_id), "type": "refresh"},
        timedelta(days=config.REFRESH_EXPIRE_DAYS),
    )


def create_reset_token(user_id: int) -> str:
    """Short-lived single-use token for password reset (carries a jti for denylisting)."""
    return _encode(
        {"sub": str(user_id), "type": "reset"},
        timedelta(minutes=config.RESET_EXPIRE_MIN),
    )


def decode_token(token: str) -> dict:
    """Decode and validate a JWT. Raises jwt.PyJWTError on failure."""
    return jwt.decode(token, config.JWT_SECRET, algorithms=[config.JWT_ALGORITHM])


def access_expires_seconds() -> int:
    return config.ACCESS_EXPIRE_MIN * 60
