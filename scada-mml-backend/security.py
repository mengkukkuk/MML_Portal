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

# Every decryption failure message starts with this so callers upstack can tell
# "an admin must re-enter this password" apart from "the plant is offline" without
# pattern-matching on prose.
CREDENTIAL_RECOVERY_PREFIX = "Datasource credential recovery required:"


class SecretConfigurationError(RuntimeError):
    """A non-empty secret cannot be encrypted because no valid key is available.

    Raised on the WRITE path only. This used to silently store plaintext instead,
    which is how cleartext plant passwords shipped unnoticed -- the single warning
    it logged was indistinguishable from ordinary startup noise.
    """


class SecretDecryptionError(RuntimeError):
    """Stored ciphertext cannot be decrypted; an operator has to recover it.

    There is no plaintext to fall back to. Callers must treat this as "this one
    datasource is unusable", never as a reason to fail unrelated work.
    """


def encryption_key_problem() -> str | None:
    """Return None when a usable Fernet key is configured, else a safe
    explanation of what is wrong with it. Never includes key material."""
    if config.ENCRYPTION_KEY_LOAD_ERROR:
        return config.ENCRYPTION_KEY_LOAD_ERROR
    if not config.ENCRYPTION_KEY:
        return (
            "ENCRYPTION_KEY is not configured - datasource passwords cannot be "
            "encrypted. Run the installer's provisioning step to create one."
        )
    try:
        Fernet(config.ENCRYPTION_KEY)
    except (ValueError, TypeError):
        return "The configured encryption key is not a valid Fernet key."
    return None


def is_encrypted_secret(stored: str) -> bool:
    """True when the value was written by encrypt_secret (as opposed to legacy
    plaintext saved before a key existed)."""
    return stored.startswith(_FERNET_PREFIX)


def encrypt_secret(plain: str) -> str:
    """Encrypt for storage.

    Empty passes through unchanged -- it is the sentinel db.py's has_password
    column depends on, and storing "no password" needs no key.

    Fails CLOSED for anything non-empty: without a valid key this raises rather
    than quietly writing the plant password to the database in cleartext.
    """
    if not plain:
        return plain
    problem = encryption_key_problem()
    if problem:
        raise SecretConfigurationError(
            f"Cannot encrypt datasource password: {problem}"
        )
    f = Fernet(config.ENCRYPTION_KEY)
    return _FERNET_PREFIX + f.encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_secret(stored: str) -> str:
    """Decrypt a value read from storage. A value without the fernet$ prefix
    is legacy plaintext (or encryption was never turned on) and is returned
    unchanged -- what makes turning ENCRYPTION_KEY on non-disruptive for rows
    saved before it existed.

    Raises SecretDecryptionError if the value IS prefixed but cannot be decrypted
    -- the key is unset/invalid, or the ciphertext was made under a different key.
    There is no plaintext to fall back to. Every caller of db.get_datasource_secret
    is expected to treat this as "this one source is unreachable", not to crash
    unrelated work. The message always begins with CREDENTIAL_RECOVERY_PREFIX so
    callers can distinguish it from an ordinary connection failure.
    """
    if not is_encrypted_secret(stored):
        return stored
    problem = encryption_key_problem()
    if problem:
        raise SecretDecryptionError(
            f"{CREDENTIAL_RECOVERY_PREFIX} this password is encrypted but "
            f"cannot be read. {problem}"
        )
    f = Fernet(config.ENCRYPTION_KEY)
    try:
        return f.decrypt(stored[len(_FERNET_PREFIX):].encode("ascii")).decode("utf-8")
    except InvalidToken as e:
        raise SecretDecryptionError(
            f"{CREDENTIAL_RECOVERY_PREFIX} the configured encryption key does not "
            "match the key this password was encrypted with. An administrator must "
            "re-enter it, or restore the original key."
        ) from e
