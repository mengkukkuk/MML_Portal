import os

from dotenv import load_dotenv

# Explicit path, not load_dotenv()'s default frame-walking discovery: that walks the call
# stack looking for the first frame whose co_filename exists on disk, which breaks when this
# module ships as sourceless bytecode (offline installer) -- co_filename is baked in at
# compile time on the build machine and never exists on the target device, so the walk skips
# past every one of our own frames and finds .env (if at all) relative to some unrelated
# third-party package instead of this backend's own directory.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

def _get(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if value is None:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value

_DPAPI_PREFIX = "dpapi:"

def _dpapi_unprotect(blob: bytes) -> bytes:
    """Windows DPAPI CryptUnprotectData via raw ctypes -- no pywin32, since the offline
    installer's embeddable Python bundle only carries what requirements.txt lists. Only
    ever called when a dpapi: prefix is actually present (see _resolve_secret), so
    ctypes.WinDLL("crypt32") is never touched by a plaintext .env on a dev/non-Windows box.
    """
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.c_void_p)]

    buf = ctypes.create_string_buffer(blob, len(blob))
    in_blob = DATA_BLOB(len(blob), ctypes.cast(buf, ctypes.c_void_p))
    out_blob = DATA_BLOB()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # Without explicit argtypes, ctypes guesses a plain C int for pointer-sized
    # arguments -- LocalFree's HLOCAL then overflows on 64-bit (address > 2**31).
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)
    )
    if not ok:
        err = ctypes.get_last_error()
        raise RuntimeError(
            f"DPAPI CryptUnprotectData failed (Win32 error {err}). This usually means "
            ".env was copied from a different machine -- DPAPI LocalMachine-scope secrets "
            "are tied to the machine that encrypted them and do not travel. Re-run "
            "tools\\protect-secret.ps1 on THIS machine to produce a new dpapi: value."
        )
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        kernel32.LocalFree(out_blob.pbData)

def _resolve_secret(name: str, default: str = "") -> str:
    """Read an env var, transparently decrypting a dpapi:-prefixed value (produced by the
    offline installer's postinstall.ps1 for JWT_SECRET, or by tools\\protect-secret.ps1 for
    anything typed in by hand). Self-describing prefix, mirrors security.py's "fernet$"
    convention for datasource passwords: anything without the prefix -- unset, empty, or
    plain text -- passes through unchanged, so existing plaintext .env files need no
    migration."""
    value = os.getenv(name, default)
    if not value.startswith(_DPAPI_PREFIX):
        return value
    import base64
    encoded = value[len(_DPAPI_PREFIX):]
    try:
        blob = base64.b64decode(encoded)
    except Exception as e:
        raise RuntimeError(
            f"{name} has a dpapi: prefix but its base64 payload is malformed -- .env may be corrupted."
        ) from e
    return _dpapi_unprotect(blob).decode("utf-8")

DB_CONNECT_TIMEOUT = int(os.getenv("DB_CONNECT_TIMEOUT", "5"))

# --- Application / configuration database ----------------------------------
APP_DB_HOST = "localhost"
APP_DB_PORT = 5432
APP_DB_NAME = os.getenv("APP_DB_NAME", "postgres")
APP_DB_USER = "postgres"
APP_DB_PASSWORD = _resolve_secret("APP_DB_PASSWORD", "P@ssw0rd")
APP_DB_SCHEMA = os.getenv("APP_DB_SCHEMA", "public")

APP_DB_KWARGS = dict(
    host=APP_DB_HOST, port=APP_DB_PORT, dbname=APP_DB_NAME,
    user=APP_DB_USER, password=APP_DB_PASSWORD,
    connect_timeout=DB_CONNECT_TIMEOUT,
    options=f"-c search_path={APP_DB_SCHEMA}",
)

# --- Connection pooling -----------------------------------------------------
APP_DB_POOL_MIN = int(os.getenv("APP_DB_POOL_MIN", "2"))
APP_DB_POOL_MAX = int(os.getenv("APP_DB_POOL_MAX", "10"))
DS_POOL_MAX = int(os.getenv("DS_POOL_MAX", "5"))

# --- Multi-datasource fan-out ----------------------------------------------

FANOUT_MAX_WORKERS = int(os.getenv("FANOUT_MAX_WORKERS", "8"))
FANOUT_TIMEOUT_S = int(os.getenv("FANOUT_TIMEOUT_S", "12"))
MAX_SELECTED_DATASOURCES = int(os.getenv("MAX_SELECTED_DATASOURCES", "8"))

# --- Secrets at rest ---------------------------------------------------------
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
ENCRYPTION_KEY = _resolve_secret("ENCRYPTION_KEY", "")

# --- Camera image folder ----------------------------------------------------
# <root>/<camera code>/NG/defect_<slot>/*.png

CAMERA_IMAGE_ROOT = os.getenv("CAMERA_IMAGE_ROOT", "")

# --- JWT ---
JWT_SECRET = _resolve_secret("JWT_SECRET", "dev-insecure-change-me")
JWT_ALGORITHM = "HS256"
ACCESS_EXPIRE_MIN = int(os.getenv("ACCESS_EXPIRE_MIN", "30"))
REFRESH_EXPIRE_DAYS = int(os.getenv("REFRESH_EXPIRE_DAYS", "7"))
RESET_EXPIRE_MIN = int(os.getenv("RESET_EXPIRE_MIN", "30"))

_INSECURE_JWT_SECRETS = {
    "dev-insecure-change-me",
    "change-me-to-a-long-random-string",
    "",
}

def jwt_secret_is_insecure() -> bool:
    return JWT_SECRET in _INSECURE_JWT_SECRETS

# --- Account management ---
# Base URL of the frontend, used to build password-reset links.
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:5173")
# Minimum length enforced on new passwords (change-password / reset / admin create).
MIN_PASSWORD_LEN = int(os.getenv("MIN_PASSWORD_LEN", "8"))

# --- Outbound email for password reset ---
BREVO_API_KEY = _resolve_secret("BREVO_API_KEY", "")

# --- SMTP relay (legacy fallback — only used when BREVO_API_KEY is empty) ---
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = _resolve_secret("SMTP_PASS", "")
# From header; defaults to SMTP_USER when blank.
SMTP_FROM = os.getenv("SMTP_FROM", "") or SMTP_USER
# "starttls" (default, port 587), "ssl" (port 465), or "none" (plaintext).
SMTP_SECURITY = os.getenv("SMTP_SECURITY", "starttls").lower()
SMTP_TIMEOUT = int(os.getenv("SMTP_TIMEOUT", "10"))

# --- Tag history buffer (in-memory substitute for variables_tag's missing
# row history — see db.snapshot_variables_tag) ---
TAG_BUFFER_POLL_SECONDS = int(os.getenv("TAG_BUFFER_POLL_SECONDS", "5"))
TAG_BUFFER_RETENTION_MINUTES = int(os.getenv("TAG_BUFFER_RETENTION_MINUTES", "60"))

# The buffer is now keyed per datasource, so its footprint scales with how many
# sources users have selected. At the defaults one series holds ~730 samples of
# ~64 bytes (~47 KB), so 5000 keys is roughly 235 MB — the key cap, not the
# source cap, is the real bound. Size it to
# MAX_SELECTED_DATASOURCES x expected tags x numeric fields.
TAG_BUFFER_MAX_SOURCES = int(os.getenv("TAG_BUFFER_MAX_SOURCES", "8"))
TAG_BUFFER_MAX_KEYS = int(os.getenv("TAG_BUFFER_MAX_KEYS", "5000"))
# Consecutive sampling failures before a source is parked. A plant DB with no
# `variables_tag` would otherwise raise every poll forever — 720 log lines/hour.
TAG_BUFFER_FAIL_LIMIT = int(os.getenv("TAG_BUFFER_FAIL_LIMIT", "5"))

# --- Licensing (offline, signed license file; no phone-home) ---------------
LICENSE_FILE_PATH = os.getenv(
    "LICENSE_FILE_PATH",
    r"C:\TBCLC\tbclicense.lic",
)

LICENSE_WARNING_WINDOW_DAYS = int(os.getenv("LICENSE_WARNING_WINDOW_DAYS", "14"))

# --- Bundled SPA (single-service deployment) -------------------------------
STATIC_DIR = os.getenv(
    "STATIC_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"),
)
