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

# psycopg connection string (keyword/value format)
DATABASE_URL = (
    f"host={DB_HOST} port={DB_PORT} dbname={DB_NAME} "
    f"user={DB_USER} password={DB_PASSWORD}"
)

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
