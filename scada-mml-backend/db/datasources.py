"""Saved datasources, their credentials and credential encryption state."""

import logging
from typing import Any

import psycopg

import security

from . import pool as _pool

logger = logging.getLogger("mml-api.db")

__all__ = [
    "_DS_PUBLIC_COLS",
    "_credential_states",
    "_is_recovery_error",
    "_migrate_plaintext_passwords",
    "_refresh_credential_state_after_write",
    "count_datasources",
    "create_datasource",
    "datasource_credential_security",
    "datasource_credential_state",
    "delete_datasource",
    "encrypt_legacy_datasource_passwords",
    "get_datasource",
    "get_datasource_secret",
    "init_datasources_table",
    "list_datasources",
    "reconcile_datasource_credentials",
    "update_datasource",
]

# --- Saved connections (datasources) ----------------------------------------
# Admin-managed named Postgres connections. Panels reference one via
# dashboard_panels.datasource_id. Passwords are stored as-is (parity with the
# app's own .env credential) and are NEVER returned by the public API — callers
# get a `has_password` flag instead. `database` is stored in column `dbname`
# (avoids the reserved-ish identifier) and aliased back on read.
def init_datasources_table() -> None:
    """Create the datasources table if it doesn't exist. Idempotent."""
    with _pool.get_connection() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS datasources (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL UNIQUE,
                type       TEXT NOT NULL DEFAULT 'postgres',
                host       TEXT NOT NULL DEFAULT '',
                port       INTEGER NOT NULL DEFAULT 5432,
                dbname     TEXT NOT NULL DEFAULT '',
                username   TEXT NOT NULL DEFAULT '',
                password   TEXT NOT NULL DEFAULT '',
                sslmode    TEXT NOT NULL DEFAULT 'prefer',
                db_schema  TEXT NOT NULL DEFAULT 'public',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )"""
        )
        # Added after initial release — idempotent so existing tables pick it up.
        conn.execute(
            "ALTER TABLE datasources "
            "ADD COLUMN IF NOT EXISTS db_schema TEXT NOT NULL DEFAULT 'public'"
        )
        conn.commit()


def count_datasources() -> int:
    with _pool.get_connection() as conn:
        row = conn.execute("SELECT count(*) AS n FROM datasources").fetchone()
    return int(row["n"])


# Public projection — everything the frontend needs minus the secret.
_DS_PUBLIC_COLS = (
    "id, name, type, host, port, dbname AS database, username, sslmode, "
    "db_schema, (password <> '') AS has_password, created_at, updated_at"
)


def list_datasources() -> list[dict[str, Any]]:
    """All saved connections, password-free, ordered by name."""
    with _pool.get_connection() as conn:
        rows = conn.execute(
            f"SELECT {_DS_PUBLIC_COLS} FROM datasources ORDER BY name"
        ).fetchall()
    return rows


def get_datasource(datasource_id: int) -> dict[str, Any] | None:
    """One saved connection, password-free. None if it doesn't exist."""
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"SELECT {_DS_PUBLIC_COLS} FROM datasources WHERE id = %s",
            (datasource_id,),
        ).fetchone()
    return row


def get_datasource_secret(datasource_id: int) -> dict[str, Any] | None:
    """One saved connection WITH its password — for opening connections only.
    Never expose the result of this directly through the API."""
    with _pool.get_connection() as conn:
        row = conn.execute(
            "SELECT id, name, type, host, port, dbname AS database, username, "
            "password, sslmode, db_schema FROM datasources WHERE id = %s",
            (datasource_id,),
        ).fetchone()
    if row is not None:
        row["password"] = security.decrypt_secret(row["password"])
    return row


def create_datasource(
    name: str,
    type: str,
    host: str,
    port: int,
    database: str,
    username: str,
    password: str,
    sslmode: str,
    db_schema: str = "public",
) -> dict[str, Any]:
    """Insert a connection. Raises psycopg.errors.UniqueViolation on dup name."""
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"""INSERT INTO datasources
                (name, type, host, port, dbname, username, password, sslmode, db_schema)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_DS_PUBLIC_COLS}""",
            (name, type, host, port, database, username,
             security.encrypt_secret(password), sslmode, db_schema),
        ).fetchone()
        conn.commit()
    _refresh_credential_state_after_write()
    return row


def update_datasource(
    datasource_id: int,
    name: str,
    type: str,
    host: str,
    port: int,
    database: str,
    username: str,
    password: str | None,
    sslmode: str,
    db_schema: str = "public",
) -> dict[str, Any] | None:
    """Update a connection. A None password keeps the stored one (so the editor
    need not round-trip the secret). Returns None if no such datasource."""
    stored_password = password if password is None else security.encrypt_secret(password)
    with _pool.get_connection() as conn:
        row = conn.execute(
            f"""UPDATE datasources
            SET name = %s, type = %s, host = %s, port = %s, dbname = %s,
                username = %s, password = COALESCE(%s, password),
                sslmode = %s, db_schema = %s, updated_at = now()
            WHERE id = %s
            RETURNING {_DS_PUBLIC_COLS}""",
            (name, type, host, port, database, username, stored_password, sslmode,
             db_schema, datasource_id),
        ).fetchone()
        conn.commit()
    # The pool holds the *old* host/credentials/schema. Drop it so the next read
    # rebuilds against what was just saved, rather than silently querying the
    # previous server until the process restarts.
    _pool.drop_pool(datasource_id)
    _refresh_credential_state_after_write()
    return row


def _refresh_credential_state_after_write() -> None:
    """Re-audit after a committed datasource write so the admin status page and
    _ds_errors reflect the save immediately -- in particular so replacing a
    broken password clears its recovery flag without a service restart.

    Best-effort by design: the write is already committed, so a failure here must
    not be reported to the caller as a failed save.
    """
    try:
        reconcile_datasource_credentials()
    except psycopg.Error as e:
        logger.warning("Could not refresh datasource credential state: %s", e)


def encrypt_legacy_datasource_passwords() -> int:
    """One-time upgrade sweep: encrypt any plaintext password left over from
    before an encryption key was configured, or from before this feature existed.

    Safe on every boot -- already-encrypted rows are excluded by the NOT LIKE
    filter, so a repeat call is a no-op.

    Raises SecretConfigurationError when no usable key is configured. It used to
    guard on `if not config.ENCRYPTION_KEY: return 0`, which a *malformed* but
    non-empty key sailed straight through; encrypt_secret then returned the
    plaintext unchanged and this function still reported len(rows) migrated. It
    claimed to have encrypted rows it had just rewritten in cleartext. Callers
    that must not raise should go through reconcile_datasource_credentials().
    """
    problem = security.encryption_key_problem()
    if problem:
        raise security.SecretConfigurationError(
            f"Cannot encrypt legacy datasource passwords: {problem}"
        )
    with _pool.get_connection() as conn:
        rows = conn.execute(
            "SELECT id, password FROM datasources "
            "WHERE password <> '' AND password NOT LIKE 'fernet$%'"
        ).fetchall()
        for row in rows:
            conn.execute(
                "UPDATE datasources SET password = %s WHERE id = %s",
                (security.encrypt_secret(row["password"]), row["id"]),
            )
        conn.commit()
    return len(rows)


# Cached result of the last reconciliation, served to the admin status route so
# it reports the audited state rather than re-decrypting on every page load.
_credential_security: dict[str, Any] = {
    "state": "unknown",
    "message": None,
    "migrated": 0,
    "plaintext_count": 0,
    "encrypted_count": 0,
    "recovery_required_count": 0,
}
_credential_states: dict[int, str] = {}


def datasource_credential_security() -> dict[str, Any]:
    """Global credential-encryption posture from the last reconciliation."""
    return dict(_credential_security)


def datasource_credential_state(datasource_id: int) -> str:
    """Per-row state: empty | plaintext | encrypted | recovery_required."""
    return _credential_states.get(datasource_id, "unknown")


def reconcile_datasource_credentials() -> dict[str, Any]:
    """Audit every stored datasource password, then migrate plaintext ones if —
    and only if — that is safe.

    Never raises for key problems: this runs from the startup path, which only
    catches psycopg.Error, and the operator needs the API up to *perform* the
    recovery. psycopg.Error is deliberately propagated so a database outage keeps
    its existing degraded-boot behaviour.

    The migrate-nothing-when-anything-is-unreadable rule is the important part.
    If old ciphertext cannot be read, the configured key is not the key that wrote
    it; encrypting the plaintext rows anyway would leave the table split across
    two keys, one of which nobody has. Better to stay uniformly recoverable.
    """
    global _credential_security

    with _pool.get_connection() as conn:
        rows = conn.execute(
            "SELECT id, password FROM datasources ORDER BY id"
        ).fetchall()

    problem = security.encryption_key_problem()
    states: dict[int, str] = {}
    plaintext_ids: list[int] = []
    encrypted = recovery = 0

    for row in rows:
        stored = row["password"] or ""
        if not stored:
            states[row["id"]] = "empty"
        elif not security.is_encrypted_secret(stored):
            states[row["id"]] = "plaintext"
            plaintext_ids.append(row["id"])
        else:
            try:
                security.decrypt_secret(stored)
            except security.SecretDecryptionError:
                states[row["id"]] = "recovery_required"
                recovery += 1
            else:
                states[row["id"]] = "encrypted"
                encrypted += 1

    migrated = 0
    if problem:
        state = "unconfigured"
        message = problem
    elif recovery:
        state = "recovery_required"
        message = (
            f"{recovery} datasource password(s) cannot be decrypted with the "
            "configured key. An administrator must re-enter them, or restore the "
            "original key. Plaintext migration is paused until then to avoid "
            "splitting the table across two keys."
        )
    else:
        migrated = _migrate_plaintext_passwords(plaintext_ids)
        for ds_id in plaintext_ids:
            states[ds_id] = "encrypted"
        encrypted += migrated
        state = "secure"
        message = None

    _credential_states.clear()
    _credential_states.update(states)
    for ds_id, ds_state in states.items():
        if ds_state == "recovery_required":
            _pool._ds_errors[ds_id] = (
                f"{security.CREDENTIAL_RECOVERY_PREFIX} an administrator must "
                "re-enter this password, or restore the original encryption key."
            )
        elif _is_recovery_error(_pool._ds_errors.get(ds_id)):
            # Recovered: drop the stale marker so the source reads as untried
            # again rather than staying red until something reconnects.
            _pool._ds_errors.pop(ds_id, None)

    _credential_security = {
        "state": state,
        "message": message,
        "migrated": migrated,
        "plaintext_count": len(plaintext_ids) - migrated,
        "encrypted_count": encrypted,
        "recovery_required_count": recovery,
    }
    return dict(_credential_security)


def _is_recovery_error(error: str | None) -> bool:
    return bool(error) and error.startswith(security.CREDENTIAL_RECOVERY_PREFIX)


def _migrate_plaintext_passwords(datasource_ids: list[int]) -> int:
    """Encrypt the named plaintext rows in one transaction. Returns the count
    actually changed -- re-read inside the transaction so a row edited between
    the audit and here is not double-encrypted or miscounted."""
    if not datasource_ids:
        return 0
    changed = 0
    with _pool.get_connection() as conn:
        rows = conn.execute(
            "SELECT id, password FROM datasources "
            "WHERE id = ANY(%s) AND password <> '' AND password NOT LIKE 'fernet$%%'",
            (datasource_ids,),
        ).fetchall()
        for row in rows:
            conn.execute(
                "UPDATE datasources SET password = %s WHERE id = %s",
                (security.encrypt_secret(row["password"]), row["id"]),
            )
            changed += 1
        conn.commit()
    return changed


def delete_datasource(datasource_id: int) -> bool:
    """Delete a connection. Returns True if a row was removed. Panels keep their
    (now-dangling) datasource_id; routing falls back to the app database."""
    with _pool.get_connection() as conn:
        cur = conn.execute("DELETE FROM datasources WHERE id = %s", (datasource_id,))
        conn.commit()
        removed = cur.rowcount > 0
    if removed:
        _pool.drop_pool(datasource_id)
    return removed
