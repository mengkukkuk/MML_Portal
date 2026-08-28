"""Application configuration loaded from environment / .env file."""
import os

from dotenv import load_dotenv

load_dotenv()


def _get(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if value is None:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


# Seconds libpq waits for a TCP connect before giving up. Without this a host
# that is powered off (rather than actively refusing) blocks on the OS-level
# timeout — tens of seconds per attempt — which is what turned a downed DB into
# a dead service.
DB_CONNECT_TIMEOUT = int(os.getenv("DB_CONNECT_TIMEOUT", "5"))

# --- Application / configuration database ----------------------------------
# Host, user, and password are deliberately hardcoded and always local. This
# database holds *only* MMLPortal's own configuration: users, dashboards,
# panels, mimic layouts and assets, report templates, saved datasources, and
# each user's source selection. Keeping it on localhost with fixed credentials
# is what lets the app boot and log in even when every plant is unreachable —
# the failure this separation exists to survive, and it must not itself depend
# on a value that could be wrong or missing at a customer site.
#
# The database *name* and *schema* are the one exception: a customer's DBA may
# already have provisioned e.g. "mmllocal"/"localbase" instead of the default
# "postgres"/"public", so those two are read from .env with today's values as
# the default — nothing changes for an existing install that leaves them unset.
#
# Plant data never comes from here. It comes from the rows in `datasources`
# that the operator selects in the header.
APP_DB_HOST = "localhost"
APP_DB_PORT = 5432
APP_DB_NAME = os.getenv("APP_DB_NAME", "postgres")
APP_DB_USER = "postgres"
APP_DB_PASSWORD = "P@ssw0rd"
APP_DB_SCHEMA = os.getenv("APP_DB_SCHEMA", "public")

APP_DB_KWARGS = dict(
    host=APP_DB_HOST, port=APP_DB_PORT, dbname=APP_DB_NAME,
    user=APP_DB_USER, password=APP_DB_PASSWORD,
    connect_timeout=DB_CONNECT_TIMEOUT,
    # Every app-config table is queried with an unqualified name (db.py relies
    # on this), so the configured schema has to be resolved by the connection
    # itself. No "public" fallback appended: if APP_DB_SCHEMA doesn't exist yet,
    # an unqualified CREATE TABLE must fail loudly rather than silently landing
    # in "public" — see db.ensure_app_schema, which creates it up front.
    options=f"-c search_path={APP_DB_SCHEMA}",
)

# --- Connection pooling -----------------------------------------------------
# The app DB is on the hot path of every authenticated request, so it keeps a
# warm floor. A saved datasource keeps min_size=0: a configured-but-unselected
# plant must hold zero sockets.
APP_DB_POOL_MIN = int(os.getenv("APP_DB_POOL_MIN", "2"))
APP_DB_POOL_MAX = int(os.getenv("APP_DB_POOL_MAX", "10"))
DS_POOL_MAX = int(os.getenv("DS_POOL_MAX", "5"))

# --- Multi-datasource fan-out ----------------------------------------------
# Reads spread across every selected datasource concurrently. The worker cap
# also bounds total concurrent remote connections independently of DS_POOL_MAX.
FANOUT_MAX_WORKERS = int(os.getenv("FANOUT_MAX_WORKERS", "8"))
FANOUT_TIMEOUT_S = int(os.getenv("FANOUT_TIMEOUT_S", "12"))
# Every fan-out is O(N) remote connections; without a ceiling one user's
# selection can stall the shared threadpool for everyone.
MAX_SELECTED_DATASOURCES = int(os.getenv("MAX_SELECTED_DATASOURCES", "8"))

# --- Camera image folder ----------------------------------------------------
# Where the vision system drops categorized inspection frames, laid out as
# <root>/<camera code>/NG/defect_<slot>/*.png. Read-only to this app; see
# camera_files.py for the traversal rules that guard it.
#
# Empty by default, and an unset or missing root is a supported state rather
# than a misconfiguration — the camera panel simply shows no frames. Baking in
# any real path would ship one workstation's layout to every install, and under
# NSSM the service account often cannot read a user-profile directory anyway.
CAMERA_IMAGE_ROOT = os.getenv("CAMERA_IMAGE_ROOT", "")

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
# ProgramData survives an app-directory wipe/reinstall, unlike a path next to
# .env. The service account (NSSM) must have write access here; licensing.py
# creates the directory on first use if it doesn't exist yet.
LICENSE_FILE_PATH = os.getenv(
    "LICENSE_FILE_PATH",
    r"C:\ProgramData\MMLPortal\license.lic",
)
# Cosmetic-only pre-expiry heads-up window (NOT part of the signed payload —
# grace_period_days in the license itself is the trust boundary, see licensing.py).
LICENSE_WARNING_WINDOW_DAYS = int(os.getenv("LICENSE_WARNING_WINDOW_DAYS", "14"))

# --- Bundled SPA (single-service deployment) -------------------------------
# When the compiled frontend is present, main.py serves it from the same
# uvicorn process, so a packaged install needs no IIS/ARR reverse proxy. Left
# empty in dev (Vite serves the SPA on :5173 and proxies /api here), which is
# why the mount is conditional on the directory actually existing.
STATIC_DIR = os.getenv(
    "STATIC_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"),
)
