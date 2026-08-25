"""Tests for offline license verification (licensing.py).

Every fixture here is signed with a throwaway test keypair (NOT the real
signing key — that never appears in this repo) so these tests are fully
self-contained: no file I/O, no real license needed, nothing that could leak
a production private key into version control.

The recurring thing under test is the state machine driven purely by
expires_at / grace_period_days relative to "now", and that tampering with
any payload byte is caught by signature verification rather than silently
accepted.
"""
import base64
import json
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import licensing

# Throwaway keypair used only by this test module.
_TEST_PRIVATE_KEY = Ed25519PrivateKey.generate()
_TEST_PUBLIC_KEY = _TEST_PRIVATE_KEY.public_key()


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _sign(payload: dict, private_key=_TEST_PRIVATE_KEY) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    signature = private_key.sign(canonical)
    return f"{_b64url(canonical)}.{_b64url(signature)}"


def _payload(**overrides):
    now = datetime.now(timezone.utc)
    base = {
        "format_version": 1,
        "license_id": "TEST-0001",
        "customer_name": "Test Customer",
        "site_name": "Test Site",
        "install_id": "test-install",
        "issued_at": now.isoformat(),
        "expires_at": (now + timedelta(days=365)).isoformat(),
        "grace_period_days": 14,
        "tier": "pro",
        "entitlements": {
            "limits": {"max_users": 25, "max_datasources": 8},
            "features": ["reports", "monitor_editor", "multi_datasource"],
        },
        "issuer": "Test Issuer",
        "notes": "",
    }
    base.update(overrides)
    return base


@pytest.fixture(autouse=True)
def _use_test_public_key(monkeypatch):
    """Point licensing.py's verifier at the throwaway test key for every test
    in this module, instead of the real hardcoded production public key."""
    monkeypatch.setattr(licensing, "_PUBLIC_KEY", _TEST_PUBLIC_KEY)


def test_valid_license_far_from_expiry():
    token = _sign(_payload(expires_at=(datetime.now(timezone.utc) + timedelta(days=365)).isoformat()))
    status = licensing.verify_license_string(token)
    assert status.state == "valid"
    assert status.error is None
    assert status.payload["tier"] == "pro"
    assert status.days_to_expiry > 300


def test_valid_license_within_warning_window():
    token = _sign(_payload(expires_at=(datetime.now(timezone.utc) + timedelta(days=5)).isoformat()))
    status = licensing.verify_license_string(token)
    assert status.state == "valid"
    assert 0 <= status.days_to_expiry <= 5


def test_grace_period_after_expiry():
    token = _sign(_payload(
        expires_at=(datetime.now(timezone.utc) - timedelta(days=3)).isoformat(),
        grace_period_days=14,
    ))
    status = licensing.verify_license_string(token)
    assert status.state == "grace"
    assert status.error is None
    assert status.days_until_hard_block == 10 or status.days_until_hard_block == 11


def test_blocked_after_grace_elapses():
    token = _sign(_payload(
        expires_at=(datetime.now(timezone.utc) - timedelta(days=30)).isoformat(),
        grace_period_days=14,
    ))
    status = licensing.verify_license_string(token)
    assert status.state == "blocked"
    assert status.error == "EXPIRED"
    assert status.days_until_hard_block == 0


def test_tampered_payload_fails_signature():
    token = _sign(_payload())
    payload_b64, sig_b64 = token.split(".")
    # Flip the case of the first character of the payload segment — any byte
    # change must invalidate the signature, proving expiry can't be edited.
    corrupted = (payload_b64[0].swapcase() + payload_b64[1:]) if payload_b64[0].isalpha() else "A" + payload_b64[1:]
    tampered_token = f"{corrupted}.{sig_b64}"
    status = licensing.verify_license_string(tampered_token)
    assert status.state == "missing"
    assert status.error == "INVALID_SIGNATURE"


def test_wrong_key_signature_rejected():
    other_key = Ed25519PrivateKey.generate()
    token = _sign(_payload(), private_key=other_key)
    status = licensing.verify_license_string(token)
    assert status.state == "missing"
    assert status.error == "INVALID_SIGNATURE"


def test_unsupported_format_version():
    token = _sign(_payload(format_version=99))
    status = licensing.verify_license_string(token)
    assert status.state == "missing"
    assert status.error == "UNSUPPORTED_VERSION"


def test_malformed_garbage_string():
    status = licensing.verify_license_string("not-a-valid-license-token")
    assert status.state == "missing"
    assert status.error == "INVALID_FORMAT"


def test_empty_string():
    status = licensing.verify_license_string("")
    assert status.state == "missing"
    assert status.error == "INVALID_FORMAT"


def test_leading_comment_line_is_ignored():
    token = _sign(_payload())
    text_with_comment = f"# Test Customer — issued today\n{token}\n"
    status = licensing.verify_license_string(text_with_comment)
    assert status.state == "valid"


def test_missing_limits_key_means_unlimited():
    token = _sign(_payload(entitlements={"limits": {}, "features": ["reports"]}))
    status = licensing.verify_license_string(token)
    assert status.state == "valid"
    assert status.payload["entitlements"]["limits"].get("max_users") is None


def test_missing_features_means_not_entitled():
    token = _sign(_payload(entitlements={"limits": {"max_users": 5}, "features": []}))
    status = licensing.verify_license_string(token)
    assert status.state == "valid"
    assert "reports" not in status.payload["entitlements"]["features"]
