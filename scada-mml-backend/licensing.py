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
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

import config
import db
from auth import require_admin

logger = logging.getLogger(__name__)

LICENSE_STATES = {"missing", "valid", "grace", "blocked"}

# Formats this build understands. A future v2 payload shape can be added here
# without breaking verification of licenses already issued under v1.
_SUPPORTED_FORMAT_VERSIONS = {1}

# 32-byte Ed25519 public key, hex-encoded. The matching private key is never
# committed to this repo — it lives only on the vendor's offline signing
# machine (see the ad-hoc sign_license.py reference script kept outside the repo).
_PUBLIC_KEY_HEX = "8c7794a5bad1087d158d8c2ffb0dae4b2a495e04f6840764ef0c45c129a15b3f"
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


# --- Dependency gate ----------------------------------------------------------
# Applied per-router via Depends(), never as ASGI middleware — matches the
# get_current_user / require_admin idiom in auth.py, and lets /health,
# auth.router, licensing.router and system.router stay reachable even while
# the app is otherwise blocked.
_HUMAN_MESSAGES = {
    "missing": "No valid license installed. Contact your administrator.",
    "blocked": "This license has expired and its grace period has ended. Contact your administrator to renew.",
}


def _human_message(status: LicenseStatus) -> str:
    return _HUMAN_MESSAGES.get(status.state, "This product is not licensed.")


def require_valid_license(_status: LicenseStatus = Depends(current_status)) -> LicenseStatus:
    """Blocks "missing" and "blocked" states; "valid" and "grace" pass through
    untouched (grace period means full functionality, per the licensing plan).
    Raises 402, not 403 — 403 stays reserved for role/feature-tier failures on
    an otherwise-active license, so the frontend can tell "unlicensed" apart
    from "unauthorized" without parsing the response body on every 403.
    """
    if _status.state in ("missing", "blocked"):
        raise HTTPException(
            status_code=402,
            detail={"reason": f"license_{_status.state}", "message": _human_message(_status)},
        )
    return _status


def require_entitlement(feature: str):
    """Dependency factory — gate a router/endpoint behind a named Pro-tier feature
    flag (e.g. "reports", "monitor_editor", "multi_datasource"). Deny-by-default:
    a payload with no `features` list, or one missing this entry, is not entitled.
    403, not 402 — the license itself is valid, just this feature isn't included.
    """
    def _dependency(_status: LicenseStatus = Depends(require_valid_license)) -> LicenseStatus:
        features = (_status.payload or {}).get("entitlements", {}).get("features", [])
        if feature not in features:
            raise HTTPException(
                status_code=403,
                detail={
                    "reason": "feature_not_entitled",
                    "feature": feature,
                    "tier": (_status.payload or {}).get("tier"),
                },
            )
        return _status

    return _dependency


def require_seat_available(_status: LicenseStatus = Depends(require_valid_license)) -> LicenseStatus:
    """Gate user creation behind `entitlements.limits.max_users`. Absent limit means
    unlimited. The seeded/initial admin counts toward this cap like any other user."""
    max_users = (_status.payload or {}).get("entitlements", {}).get("limits", {}).get("max_users")
    if max_users is not None and db.count_users() >= max_users:
        raise HTTPException(
            status_code=403,
            detail={"reason": "seat_limit_reached", "limit": max_users},
        )
    return _status


def require_datasource_slot(_status: LicenseStatus = Depends(require_valid_license)) -> LicenseStatus:
    """Gate datasource creation behind `entitlements.limits.max_datasources`. Absent
    limit means unlimited."""
    max_datasources = (_status.payload or {}).get("entitlements", {}).get("limits", {}).get("max_datasources")
    if max_datasources is not None and db.count_datasources() >= max_datasources:
        raise HTTPException(
            status_code=403,
            detail={"reason": "datasource_limit_reached", "limit": max_datasources},
        )
    return _status


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


@router.post("/activate", response_model=LicenseStatusOut)
async def activate(
    text: str | None = Form(None),
    file: UploadFile | None = File(None),
    admin: dict = Depends(require_admin),
) -> LicenseStatusOut:
    """Admin-only. Verifies the submitted license BEFORE writing anything to disk —
    a bad paste/upload must never clobber the last known-good license file. Accepts
    either a pasted token (`text`, multipart form field) or a `.lic` file upload;
    exactly one is expected.
    """
    if file is not None:
        raw = (await file.read()).decode("utf-8", errors="replace")
    elif text:
        raw = text
    else:
        raise HTTPException(
            status_code=400,
            detail={"reason": "NO_LICENSE_PROVIDED", "message": "Paste a license or choose a file."},
        )

    candidate = verify_license_string(raw)
    if candidate.state == "missing":
        db.insert_license_event(
            event_type="activation_failed",
            state=candidate.state,
            actor_user_id=admin["id"],
            detail=candidate.error,
        )
        raise HTTPException(
            status_code=400,
            detail={"reason": candidate.error or "INVALID_LICENSE", "message": "License could not be verified."},
        )

    os.makedirs(os.path.dirname(config.LICENSE_FILE_PATH), exist_ok=True)
    with open(config.LICENSE_FILE_PATH, "w", encoding="utf-8") as f:
        f.write(raw.strip() + "\n")

    new_status = refresh()
    payload = new_status.payload or {}
    db.insert_license_event(
        event_type="activated",
        state=new_status.state,
        license_id=payload.get("license_id"),
        tier=payload.get("tier"),
        expires_at=new_status.expires_at,
        actor_user_id=admin["id"],
    )
    return _to_status_out(new_status)
