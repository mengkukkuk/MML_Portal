"""Password hashing (stdlib scrypt), JWT creation/verification (PyJWT), and
secret-at-rest encryption (cryptography.fernet)."""
import hashlib
import hmac
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from cryptography.fernet import Fernet, InvalidToken

import config

logger = logging.getLogger("mml-api.security")

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


# --- Secret-at-rest encryption (datasources.password) -----------------------
# Self-describing like the scrypt$ hash above: a "fernet$"-prefixed value is
# unambiguous ciphertext from this code; anything else is legacy plaintext (or
# ENCRYPTION_KEY was never configured) and passes through unchanged on read.
# Empty string always passes through unchanged both directions -- it is the
# sentinel db.py's has_password column depends on.
_FERNET_PREFIX = "fernet$"
_warned_plaintext = False


def _warn_plaintext_once(reason: str) -> None:
    global _warned_plaintext
    if not _warned_plaintext:
        logger.warning(
            "%s - datasource passwords will be stored in plaintext. Set "
            "ENCRYPTION_KEY (see .env.example) to encrypt them.", reason,
        )
        _warned_plaintext = True


def encrypt_secret(plain: str) -> str:
    """Encrypt for storage. Returns plaintext unchanged if empty, or if
    ENCRYPTION_KEY is unset/invalid -- a degrade, not a failure, so creating or
    editing a datasource never breaks because of this."""
    if not plain:
        return plain
    if not config.ENCRYPTION_KEY:
        _warn_plaintext_once("ENCRYPTION_KEY is not set")
        return plain
    try:
        f = Fernet(config.ENCRYPTION_KEY)
    except ValueError:
        _warn_plaintext_once("ENCRYPTION_KEY is not a valid Fernet key")
        return plain
    return _FERNET_PREFIX + f.encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_secret(stored: str) -> str:
    """Decrypt a value read from storage. A value without the fernet$ prefix
    is legacy plaintext (or encryption was never turned on) and is returned
    unchanged -- what makes turning ENCRYPTION_KEY on non-disruptive for rows
    saved before it existed.

    Raises RuntimeError if the value IS prefixed but cannot be decrypted --
    ENCRYPTION_KEY is unset/invalid, or the ciphertext was made under a
    different key. There is no plaintext to fall back to. Every caller of
    db.get_datasource_secret is expected to treat this as "this one source is
    unreachable", not to crash unrelated work.
    """
    if not stored.startswith(_FERNET_PREFIX):
        return stored
    if not config.ENCRYPTION_KEY:
        raise RuntimeError(
            "Stored password is encrypted but ENCRYPTION_KEY is not set - "
            "cannot decrypt it."
        )
    try:
        f = Fernet(config.ENCRYPTION_KEY)
    except ValueError as e:
        raise RuntimeError(
            "Stored password is encrypted but ENCRYPTION_KEY is not a valid "
            "Fernet key - cannot decrypt it."
        ) from e
    try:
        return f.decrypt(stored[len(_FERNET_PREFIX):].encode("ascii")).decode("utf-8")
    except InvalidToken as e:
        raise RuntimeError(
            "Stored password could not be decrypted - ENCRYPTION_KEY does "
            "not match the key it was encrypted with."
        ) from e
