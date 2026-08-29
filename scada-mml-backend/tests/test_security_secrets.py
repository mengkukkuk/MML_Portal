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


def test_encrypt_falls_back_to_plaintext_when_key_unset(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "")
    assert security.encrypt_secret("hunter2") == "hunter2"


def test_decrypt_raises_when_key_unset(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", REAL_KEY)
    stored = security.encrypt_secret("hunter2")
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "")
    with pytest.raises(RuntimeError):
        security.decrypt_secret(stored)


def test_encrypt_falls_back_to_plaintext_when_key_malformed(monkeypatch):
    monkeypatch.setattr(config, "ENCRYPTION_KEY", "not-a-valid-fernet-key")
    assert security.encrypt_secret("hunter2") == "hunter2"


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
    with pytest.raises(RuntimeError):
        security.decrypt_secret(stored)
