"""Application configuration loaded from environment / .env file."""
import os

from dotenv import load_dotenv

load_dotenv()


def _get(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if value is None:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


# --- Database (local PostgreSQL) ---
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")

# Seconds libpq waits for a TCP connect before giving up. Without this a host
# that is powered off (rather than actively refusing) blocks on the OS-level
# timeout — tens of seconds per attempt — which is what turned a downed DB into
# a dead service. Matches the 5s already used for saved datasources.
DB_CONNECT_TIMEOUT = int(os.getenv("DB_CONNECT_TIMEOUT", "5"))

# After every candidate has failed, how long db.get_connection() fails fast
# instead of re-walking the whole list on each request.
DB_FAILOVER_COOLDOWN = int(os.getenv("DB_FAILOVER_COOLDOWN", "10"))

# Pin one candidate by name and disable failover entirely. Used by seed_users.py
# to seed a specific database ("DB_TARGET=fallback1 python seed_users.py") — a
# walk there could silently seed the wrong host.
DB_TARGET = os.getenv("DB_TARGET", "").strip()


def _quote(value: str) -> str:
    """Quote a libpq keyword/value component.

    Unquoted, a password containing a space silently truncates the connection
    string and the failure surfaces far from its cause.
    """
    escaped = value.replace("\\", "\\\\").replace("'", "\'")
    return f"'{escaped}'"


def _dsn(host: str, port: str, dbname: str, user: str, password: str) -> str:
    """Build a psycopg keyword/value connection string."""
    return (
        f"host={_quote(host)} port={_quote(port)} dbname={_quote(dbname)} "
        f"user={_quote(user)} password={_quote(password)} "
        f"connect_timeout={DB_CONNECT_TIMEOUT}"
    )


def _discover_candidates() -> list[dict]:
    """Ordered list of databases to try: the primary, then any fallbacks.

    Fallbacks are declared as DB_FALLBACK_<n>_HOST (n = 1, 2, ...) and inherit
    every unset key from the primary, so the common case is a single line in
    .env. Scanning stops at the first gap in the numbering.
    """
    candidates = [{
        "name": "primary",
        "host": DB_HOST,
        "port": DB_PORT,
        "dbname": DB_NAME,
        "dsn": _dsn(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD),
    }]
    n = 1
    while True:
        host = os.getenv(f"DB_FALLBACK_{n}_HOST")
        if not host:
            break
        port = os.getenv(f"DB_FALLBACK_{n}_PORT", DB_PORT)
        dbname = os.getenv(f"DB_FALLBACK_{n}_NAME", DB_NAME)
        user = os.getenv(f"DB_FALLBACK_{n}_USER", DB_USER)
        password = os.getenv(f"DB_FALLBACK_{n}_PASSWORD", DB_PASSWORD)
        candidates.append({
            "name": f"fallback{n}",
            "host": host,
            "port": port,
            "dbname": dbname,
            "dsn": _dsn(host, port, dbname, user, password),
        })
        n += 1
    return candidates


DB_CANDIDATES = _discover_candidates()

# Kept for backwards compatibility — the primary's DSN. Runtime code should go
# through db.get_connection(), which honours failover.
DATABASE_URL = DB_CANDIDATES[0]["dsn"]

# --- JWT ---
JWT_SECRET = os.getenv("JWT_SECRET", "dev-insecure-change-me")
JWT_ALGORITHM = "HS256"
ACCESS_EXPIRE_MIN = int(os.getenv("ACCESS_EXPIRE_MIN", "30"))
REFRESH_EXPIRE_DAYS = int(os.getenv("REFRESH_EXPIRE_DAYS", "7"))
RESET_EXPIRE_MIN = int(os.getenv("RESET_EXPIRE_MIN", "30"))

# --- Account management ---
# Base URL of the frontend, used to build password-reset links.
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:5173")
# Minimum length enforced on new passwords (change-password / reset / admin create).
MIN_PASSWORD_LEN = int(os.getenv("MIN_PASSWORD_LEN", "8"))

# --- Outbound email for password reset ---
# Delivery priority in mailer.py:
#   1. Brevo HTTP API   — when BREVO_API_KEY is set (recommended; no IP allow-list)
#   2. Generic SMTP     — when SMTP_HOST is set (legacy fallback)
#   3. Dev console mode — neither set; reset link is logged
# Generate a Brevo v3 key at: dashboard → SMTP & API → API Keys → Generate.
BREVO_API_KEY = os.getenv("BREVO_API_KEY", "")

# --- SMTP relay (legacy fallback — only used when BREVO_API_KEY is empty) ---
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
# From header; defaults to SMTP_USER when blank.
SMTP_FROM = os.getenv("SMTP_FROM", "") or SMTP_USER
# "starttls" (default, port 587), "ssl" (port 465), or "none" (plaintext).
SMTP_SECURITY = os.getenv("SMTP_SECURITY", "starttls").lower()
SMTP_TIMEOUT = int(os.getenv("SMTP_TIMEOUT", "10"))

# --- Tag history buffer (in-memory substitute for variables_tag's missing
# row history — see db.snapshot_variables_tag) ---
TAG_BUFFER_POLL_SECONDS = int(os.getenv("TAG_BUFFER_POLL_SECONDS", "5"))
TAG_BUFFER_RETENTION_MINUTES = int(os.getenv("TAG_BUFFER_RETENTION_MINUTES", "60"))
