"""main._check_secure_config -- the one startup handler allowed to abort boot.

Calls the handler function directly with monkeypatch, same style as
test_db_boot.py: no TestClient, no real lifespan.
"""
import pytest

import config


def test_default_placeholder_is_rejected(monkeypatch):
    import main
    monkeypatch.setattr(config, "JWT_SECRET", "dev-insecure-change-me")
    with pytest.raises(RuntimeError):
        main._check_secure_config()


def test_env_example_placeholder_is_rejected(monkeypatch):
    import main
    monkeypatch.setattr(config, "JWT_SECRET", "change-me-to-a-long-random-string")
    with pytest.raises(RuntimeError):
        main._check_secure_config()


def test_empty_secret_is_rejected(monkeypatch):
    import main
    monkeypatch.setattr(config, "JWT_SECRET", "")
    with pytest.raises(RuntimeError):
        main._check_secure_config()


def test_a_real_secret_passes(monkeypatch):
    import main
    monkeypatch.setattr(config, "JWT_SECRET", "a1b2c3" * 12)
    main._check_secure_config()  # must not raise
