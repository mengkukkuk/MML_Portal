"""encrypt_secret / decrypt_secret -- the datasources.password at-rest scheme.

Pure unit tests: no database, no network. ENCRYPTION_KEY is monkeypatched
directly on the config module rather than via the environment, since
config.py reads it once at import time.
"""
import pytest
from cryptography.fernet import Fernet

import config
import security

REAL_KEY = Fernet.generate_key().decode()
OTHER_KEY = Fernet.generate_key().decode()


@pytest.fixture(autouse=True)
def _no_key_load_error(monkeypatch):
    """Isolate from the host's real config: a key-file load error would otherwise
    make every key monkeypatched below look unusable."""
    monkeypatch.setattr(config, "ENCRYPTION_KEY_LOAD_ERROR", None)


def test_round_trip_under_a_real_key(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    stored = security.encrypt_secret("hunter2")
    assert stored.startswith("fernet$")
    assert stored != "hunter2"
    assert security.decrypt_secret(stored) == "hunter2"


def test_empty_string_passes_through_with_key_configured(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    assert security.encrypt_secret("") == ""
    assert security.decrypt_secret("") == ""


def test_empty_string_passes_through_without_key(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "")
    assert security.encrypt_secret("") == ""
    assert security.decrypt_secret("") == ""


def test_legacy_plaintext_passes_through_regardless_of_key_state(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    assert security.decrypt_secret("plain-old-password") == "plain-old-password"
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "")
    assert security.decrypt_secret("plain-old-password") == "plain-old-password"


def test_encrypt_fails_closed_when_key_unset(monkeypatch):
    """The whole point of the fix: never silently store the plant password."""
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "")
    with pytest.raises(security.SecretConfigurationError):
        security.encrypt_secret("hunter2")


def test_encrypt_fails_closed_when_key_malformed(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "not-a-valid-fernet-key")
    with pytest.raises(security.SecretConfigurationError):
        security.encrypt_secret("hunter2")


def test_encrypt_fails_closed_when_key_file_failed_to_load(monkeypatch):
    """A configured-but-unreadable ENCRYPTION_KEY_FILE must not fall through to
    encrypting under whatever stale value ENCRYPTION_KEY happens to hold."""
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "")
    monkeypatch.setattr(
        config, "ENCRYPTION_KEY_LOAD_ERROR", "key file could not be read"
    )
    with pytest.raises(security.SecretConfigurationError):
        security.encrypt_secret("hunter2")


def test_encrypt_error_never_leaks_the_secret(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "")
    with pytest.raises(security.SecretConfigurationError) as excinfo:
        security.encrypt_secret("hunter2")
    assert "hunter2" not in str(excinfo.value)


def test_decrypt_raises_when_key_unset(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    stored = security.encrypt_secret("hunter2")
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "")
    with pytest.raises(security.SecretDecryptionError):
        security.decrypt_secret(stored)


def test_decrypt_raises_when_key_malformed(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    stored = security.encrypt_secret("hunter2")
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "not-a-valid-fernet-key")
    with pytest.raises(RuntimeError):
        security.decrypt_secret(stored)


def test_decrypt_raises_on_corrupted_ciphertext(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    stored = security.encrypt_secret("hunter2")
    corrupted = stored[:-4] + "abcd"
    with pytest.raises(RuntimeError):
        security.decrypt_secret(corrupted)


def test_decrypt_raises_under_the_wrong_key(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    stored = security.encrypt_secret("hunter2")
    monkeypatch.setattr(config, "ENCRYPTION_KEY", OTHER_KEY)
    with pytest.raises(security.SecretDecryptionError):
        security.decrypt_secret(stored)


@pytest.mark.parametrize("bad_key", ["", "not-a-valid-fernet-key", OTHER_KEY])
def test_every_decrypt_failure_is_tagged_for_recovery(monkeypatch, bad_key):
    """Callers (fan-out, /datasources/test, system health) key off this prefix to
    tell 'an admin must re-enter this' apart from 'the plant is offline'."""
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    stored = security.encrypt_secret("hunter2")
    monkeypatch.setattr(config, "ENCRYPTION_KEY", bad_key)
    with pytest.raises(security.SecretDecryptionError) as excinfo:
        security.decrypt_secret(stored)
    assert str(excinfo.value).startswith(security.CREDENTIAL_RECOVERY_PREFIX)


def test_is_encrypted_secret_distinguishes_legacy_plaintext(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    assert security.is_encrypted_secret(security.encrypt_secret("hunter2"))
    assert not security.is_encrypted_secret("plain-old-password")
    assert not security.is_encrypted_secret("")


def test_encryption_key_problem_reports_usable_key(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    assert security.encryption_key_problem() is None
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "")
    assert security.encryption_key_problem() is not None
