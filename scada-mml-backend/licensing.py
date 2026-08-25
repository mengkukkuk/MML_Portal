"""Offline signed-license verification (no phone-home).

A license is a single token: base64url(canonical_payload_json).base64url(signature),
Ed25519-signed by a private key that never ships with this application. There is no
license server and no network call anywhere in this module — verification is a pure
function of the license text and the hardcoded public key below.

State machine (see LicenseStatus.state):
    missing  — no file on disk, or file present but signature/format invalid
    valid    — now < expires_at
    grace    — expires_at <= now < expires_at + grace_period_days (full function,
               grace_period_days is itself signed so a customer cannot extend it
               by editing plaintext)
    blocked  — now >= expires_at + grace_period_days

Binding model: site_name/install_id in the payload are free-text/opaque labels for
display and support tickets only — this is a site/install license, not a hardware-
fingerprint lock. Nothing here cryptographically prevents copying a .lic file between
two installs; that is a licensing-terms control, not a technical one, by design.
"""
import base64
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter
from pydantic import BaseModel

import config

logger = logging.getLogger(__name__)

LICENSE_STATES = {"missing", "valid", "grace", "blocked"}

# Formats this build understands. A future v2 payload shape can be added here
# without breaking verification of licenses already issued under v1.
_SUPPORTED_FORMAT_VERSIONS = {1}

# 32-byte Ed25519 public key, hex-encoded. The matching private key is never
# committed to this repo — it lives only on the vendor's offline signing
# machine (see the ad-hoc sign_license.py reference script kept outside the repo).
_PUBLIC_KEY_HEX = "8aa9eef6babfca36b94a134e8e54b0170e54be38ebe9df9d2ef5fc5d6e2e4ba8"
_PUBLIC_KEY = Ed25519PublicKey.from_public_bytes(bytes.fromhex(_PUBLIC_KEY_HEX))


@dataclass(frozen=True)
class LicenseStatus:
    state: str                       # one of LICENSE_STATES
    payload: dict | None             # parsed license payload, None unless valid/grace/blocked
    error: str | None                # machine-readable reason, set whenever state != "valid"/"grace"
    expires_at: datetime | None
    grace_ends_at: datetime | None
    days_to_expiry: int | None       # negative once past expires_at
    days_until_hard_block: int | None  # only meaningful in "grace"
    checked_at: datetime


def _missing(error: str) -> LicenseStatus:
    return LicenseStatus(
        state="missing",
        payload=None,
        error=error,
        expires_at=None,
        grace_ends_at=None,
        days_to_expiry=None,
        days_until_hard_block=None,
        checked_at=datetime.now(timezone.utc),
    )


def _b64url_decode(s: str) -> bytes:
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


def _canonical_bytes(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _parse_datetime(value: str) -> datetime:
    """Parse an ISO-8601 UTC timestamp. Payloads are hand-authored, so be
    forgiving of a trailing 'Z' rather than requiring '+00:00'."""
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def verify_license_string(text: str) -> LicenseStatus:
    """Pure function: parse + verify a license token, no disk I/O. Never raises —
    any malformed/tampered/expired input is reflected in the returned state."""
    text = text.strip()
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        text = line
        break
    else:
        return _missing("INVALID_FORMAT")

    parts = text.split(".")
    if len(parts) != 2:
        return _missing("INVALID_FORMAT")

    try:
        payload_bytes = _b64url_decode(parts[0])
        signature_bytes = _b64url_decode(parts[1])
    except (ValueError, TypeError):
        return _missing("INVALID_FORMAT")

    try:
        _PUBLIC_KEY.verify(signature_bytes, payload_bytes)
    except InvalidSignature:
        return _missing("INVALID_SIGNATURE")

    try:
        payload = json.loads(payload_bytes)
    except (ValueError, TypeError):
        # Should not happen once the signature has verified, but the payload
        # bytes are still attacker/typo-controlled input until parsed.
        return _missing("INVALID_FORMAT")

    if not isinstance(payload, dict):
        return _missing("INVALID_FORMAT")

    format_version = payload.get("format_version")
    if format_version not in _SUPPORTED_FORMAT_VERSIONS:
        return _missing("UNSUPPORTED_VERSION")

    try:
        expires_at = _parse_datetime(payload["expires_at"])
        grace_period_days = int(payload.get("grace_period_days", 0))
    except (KeyError, ValueError, TypeError):
        return _missing("INVALID_FORMAT")

    grace_ends_at = expires_at + timedelta(days=grace_period_days)
    now = datetime.now(timezone.utc)
    days_to_expiry = (expires_at - now).days

    if now < expires_at:
        state = "valid"
        days_until_hard_block = None
    elif now < grace_ends_at:
        state = "grace"
        days_until_hard_block = (grace_ends_at - now).days
    else:
        state = "blocked"
        days_until_hard_block = 0

    return LicenseStatus(
        state=state,
        payload=payload,
        error=None if state != "blocked" else "EXPIRED",
        expires_at=expires_at,
        grace_ends_at=grace_ends_at,
        days_to_expiry=days_to_expiry,
        days_until_hard_block=days_until_hard_block,
        checked_at=now,
    )


def load_license_from_disk() -> LicenseStatus:
    """Read config.LICENSE_FILE_PATH and verify it. A missing file is a normal,
    expected state (fresh install / not yet activated) — not an error condition."""
    path = config.LICENSE_FILE_PATH
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except OSError:
        logger.warning("Could not create license directory for %s", path, exc_info=True)

    if not os.path.isfile(path):
        return _missing("FILE_NOT_FOUND")

    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        logger.warning("Could not read license file at %s", path, exc_info=True)
        return _missing("FILE_UNREADABLE")

    return verify_license_string(text)


_current: LicenseStatus = _missing("NOT_YET_CHECKED")


def refresh() -> LicenseStatus:
    """Re-read the license file from disk, update the module-level cache, return it."""
    global _current
    _current = load_license_from_disk()
    return _current


def current_status() -> LicenseStatus:
    """Cheap cached accessor — does not touch disk. Call refresh() to update it."""
    return _current


# --- HTTP surface -------------------------------------------------------------
router = APIRouter(prefix="/api/license", tags=["license"])


class LicenseStatusOut(BaseModel):
    state: str                              # "missing" | "valid" | "grace" | "blocked"
    tier: str | None = None
    site_name: str | None = None
    customer_name: str | None = None
    expires_at: datetime | None = None
    days_to_expiry: int | None = None
    grace_period_days: int | None = None
    days_until_hard_block: int | None = None
    entitlements: dict | None = None        # limits/features only — no license_id/notes
    warn: bool = False


def _to_status_out(status: LicenseStatus) -> LicenseStatusOut:
    payload = status.payload or {}
    within_warning_window = (
        status.state == "valid"
        and status.days_to_expiry is not None
        and status.days_to_expiry <= config.LICENSE_WARNING_WINDOW_DAYS
    )
    return LicenseStatusOut(
        state=status.state,
        tier=payload.get("tier"),
        site_name=payload.get("site_name"),
        customer_name=payload.get("customer_name"),
        expires_at=status.expires_at,
        days_to_expiry=status.days_to_expiry,
        grace_period_days=payload.get("grace_period_days"),
        days_until_hard_block=status.days_until_hard_block,
        entitlements=payload.get("entitlements"),
        warn=within_warning_window or status.state == "grace",
    )


@router.get("/status", response_model=LicenseStatusOut)
def get_status() -> LicenseStatusOut:
    """Unauthenticated, mirrors /health (main.py) — the frontend boot gate and
    the persistent banner both need this before a user can log in, since a
    hard-blocked install must still be able to reach /login and then the
    activation screen. No secrets in the response: license_id, install_id and
    notes stay server-side / for admin-only surfaces added later.
    """
    return _to_status_out(current_status())
