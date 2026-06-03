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
