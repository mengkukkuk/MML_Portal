# Fix: datasource passwords stored unencrypted at rest

**Status:** approved, not yet implemented
**Date:** 2026-08-30
**Branch:** build_dist
**Workflow:** `/multi-backend` — Codex (session `01a05160-9b75-7dc2-aabe-6b4213e9ef30`) led analysis and architecture; Claude implements.

---

## Problem

Plant-connection passwords in the `datasources` table are stored in cleartext on
production installs, and one existing row is encrypted under a key that no longer
exists.

Root cause is lifecycle, not cryptography. The Fernet implementation
(`security.py`, `fernet$` prefix) is sound. What fails:

1. **The packaged installer never provisions a key.**
   `installer/scripts/postinstall.ps1` generates, DPAPI-protects and preserves
   `JWT_SECRET` and `APP_DB_PASSWORD`, but has no `ENCRYPTION_KEY` logic at all.
   It copies `.env.example`, which ships the value blank. The manual installer
   `scada-mml-backend/install.ps1:163-180` *does* generate one — so a box installed
   manually and later reinstalled from the package silently loses its key.
2. **Writes fail open.** With no key, `encrypt_secret()` logs one warning and
   returns the plaintext (`security.py:121-135`). Two tests actively assert this
   (`tests/test_security_secrets.py:44-46`, `:58-60`), so the behaviour was locked in.
3. **Key loss is undetectable.** Nothing at startup compares stored ciphertext
   against the configured key.

### Confirmed live damage

`datasources` id 1 "Tobacco Line 9" holds a `fernet$` value; `.env` has no
`ENCRYPTION_KEY` line. `db.get_datasource_secret(1)` raises
`RuntimeError: Stored password is encrypted but ENCRYPTION_KEY is not set`.
Every `.env` on local drives was searched — **the former key does not exist.**
That password is unrecoverable and must be re-entered by an admin. It is the
first real test case for the recovery flow.

### Three further defects found during analysis

| Defect | Location | Effect |
|---|---|---|
| Sweep reports false success | `db.py:1835-1848` | Guards only `if not ENCRYPTION_KEY`. A *malformed* non-empty key passes the guard, `encrypt_secret` returns plaintext, and the function still returns `len(rows)` — "migrated N" while storing cleartext. |
| Health check hides breakage | `db.py:291-315`, `db.py:1320-1348` | Decryption fails while building the pool, *before* `_ds_errors` is populated, so `/api/system/db` can report a broken credential as healthy/untried. |
| Recovery dead-end | `datasources.py:236-257` | `/datasources/test` decrypts the stored password before applying supplied overrides, so an admin cannot validate replacement credentials on a broken row — blocking the only recovery path. |

---

## Decisions (settled — do not re-litigate)

- **Solution A**: keep Fernet and the `fernet$` format. Not per-password DPAPI.
- **Fail closed on write.** `encrypt_secret` raises when asked to store a
  non-empty secret with no valid key. The two fail-open tests get rewritten.
- **Degraded-but-available boot.** No JWT-style hard abort: an upgrade must not
  brick installs currently running on plaintext, and the API has to stay up to
  *perform* the recovery. Legacy plaintext reads keep working.
- **`C:\ProgramData\MMLPortal\datasource-encryption.key`** is authoritative,
  DPAPI-wrapped, ACL'd to SYSTEM + Administrators. It survives reinstall because
  it lives outside the application directory.
- **Keep a DPAPI copy in `.env` too.** Authority order is ProgramData first.
  The `.env` copy exists solely so a rollback to the current binary (which only
  reads `ENCRYPTION_KEY`) can still decrypt. Both are machine-bound, so this is
  not meaningful extra exposure.
- **No `fernet$v1$` versioning yet.** The current decoder treats everything after
  `fernet$` as the token (`security.py:150-165`), so a versioned writer would
  break rollback. Rotation needs reader-first/writer-later across two releases;
  deferred for the POC.
- **Scope: backend + installer only.** Frontend recovery messaging, Settings
  health badges, doc rewrites and the PowerShell smoke-test harness are deferred
  (see Deferred below).

---

## Files in scope

| # | Path | Change |
|---|---|---|
| 1 | `scada-mml-backend/config.py` | Add `ENCRYPTION_KEY_FILE` + `ENCRYPTION_KEY_LOAD_ERROR`. Load the authoritative key file; on failure degrade to unavailable rather than raising at import. When `ENCRYPTION_KEY_FILE` is set it wins and does **not** fall back to `ENCRYPTION_KEY`. |
| 2 | `scada-mml-backend/security.py` | Add `SecretConfigurationError`, `SecretDecryptionError`, `CREDENTIAL_RECOVERY_PREFIX`, `encryption_key_problem()`, `is_encrypted_secret()`. Make `encrypt_secret` fail closed for non-empty input. Empty string still passes through both ways (it is the sentinel `has_password` depends on). |
| 3 | `scada-mml-backend/db.py` | Add `reconcile_datasource_credentials()` and `datasource_credential_security()`. Fix the sweep to report the count actually changed and to raise on a malformed key. Record `SecretDecryptionError` into `_ds_errors` inside `_build_pool` before re-raising. Refresh state after datasource mutations. |
| 4 | `scada-mml-backend/main.py` | Replace the direct sweep call at `main.py:101` with reconciliation. Log secure / unconfigured / recovery-required. Must not raise — `_create_tables` only catches `psycopg.Error`, so an escaping `RuntimeError` would abort the lifespan. |
| 5 | `scada-mml-backend/datasources.py` | Map `SecretConfigurationError` to HTTP 503 on create/update. Reorder `/test` so a supplied password is used without touching the stored secret. |
| 6 | `scada-mml-backend/system.py` | Add `credential_security` block and per-row `credential_state` to `/api/system/db` (already admin-gated). |
| 7 | `scada-mml-backend/.env.example` | Add `ENCRYPTION_KEY_FILE`; stop describing plaintext as acceptable. |
| 8 | `installer/scripts/provision-encryption-key.ps1` | **New.** Idempotent shared provisioning. |
| 9 | `installer/MMLPortal.iss` | One `Source:` line so the script ships to `{app}\scripts` (only `postinstall.ps1`/`uninstall.ps1` ship today). |
| 10 | `installer/scripts/postinstall.ps1` | Invoke provisioning after `.env` reconciliation, before service start. Warn the operator to back the key up. |
| 11 | `scada-mml-backend/install.ps1` | Invoke the same provisioning on every run, including when `.env` already exists. Stop printing generated JWT/encryption secrets to console (`install.ps1:156-168`). |
| 12 | `tests/test_security_secrets.py` | Replace fail-open assertions with fail-closed; cover typed errors and key loading. |
| 13 | `tests/test_datasource_conn.py` | Reconciliation, wrong-key, fail-closed-write, recovery tests. Also fix line 72 to compare against `config.APP_DB_SCHEMA` (pre-existing failure — this machine sets `APP_DB_SCHEMA=localbase`). |
| 14 | `tests/test_db_boot.py`, `tests/test_fanout.py` | Prove credential errors never escape `_create_tables`, `/health` stays coarse, and fan-out isolates a broken source with recovery wording. |

No SQL/schema migration. Existing plaintext and `fernet$` values stay valid.

---

## Key interfaces

```python
# security.py
class SecretConfigurationError(RuntimeError): ...   # cannot encrypt: no valid key
class SecretDecryptionError(RuntimeError): ...      # cannot decrypt: operator recovery needed

CREDENTIAL_RECOVERY_PREFIX = "Datasource credential recovery required:"

def encryption_key_problem() -> str | None      # None when the key is usable
def is_encrypted_secret(stored: str) -> bool
def encrypt_secret(plain: str) -> str           # "" -> ""; no key + non-empty -> raises
def decrypt_secret(stored: str) -> str          # unprefixed -> unchanged (legacy plaintext)
```

```python
# db.py
CredentialState = Literal["empty", "plaintext", "encrypted", "recovery_required"]
CredentialSecurityState = Literal["unknown", "secure", "unconfigured", "recovery_required"]

def reconcile_datasource_credentials() -> dict[str, Any]
```

`reconcile_datasource_credentials` invariants:
- Never raises `SecretConfigurationError` / `SecretDecryptionError`.
- **Propagates `psycopg.Error`** so `_create_tables` keeps its DB-degraded behaviour.
- If *any* encrypted row is unreadable → migrate **zero** plaintext rows.
  (Prevents a mixed-key database: old rows dead, new rows under a new key.)
- If the key is missing or invalid → migrate zero.
- Valid matching key → encrypt all non-empty plaintext rows transactionally.

Provisioning precedence in `provision-encryption-key.ps1`:
1. Existing non-empty ProgramData key → validate, preserve byte-for-byte.
2. Else non-empty legacy `.env ENCRYPTION_KEY` → adopt it.
3. Else generate one Fernet key.
4. DPAPI-protect and sync both `ENCRYPTION_KEY_FILE` and `ENCRYPTION_KEY` in `.env`.

Exit 0 on success; exit 1 on unreadable/invalid existing key, DPAPI failure, or
validation failure — **never overwrite an existing key on failure**, never print
key material.

---

## Build order

Each step leaves the tree runnable.

1. **config + security fail-closed**, and update the pure tests in the same step
   (fixtures need a valid key or non-empty-password tests break immediately).
   → `pytest tests/test_security_secrets.py`
2. **db reconciliation + exact sweep counts**; fold in the `APP_DB_SCHEMA` fix.
   → `pytest tests/test_datasource_conn.py`
3. **Wire into startup + `/api/system/db`.** Verify no `RuntimeError` escapes and
   `/health` still returns only `status`/`db`/`checked_at`.
   → `pytest tests/test_db_boot.py tests/test_startup_guard.py`
4. **Write 503 + replacement-password testing.**
   → `pytest tests/test_datasource_conn.py tests/test_router_envelopes.py`
5. **Pre-pool error recording + fan-out isolation.**
   → `pytest tests/test_fanout.py`
6. **Provisioning script + both installers + `.iss`.**
   → run provisioning twice, assert the key file is byte-identical; grep that no
   installer prints `Generated ... SECRET`.
7. **Full suite.** Baseline to beat: 309 passed / 1 failed → target 0 failed.

---

## Expected state on this machine after deploy

```
credential_security.state   = recovery_required
recovery_required_count     = 1        # Tobacco Line 9
migrated                    = 0        # blocked on purpose while a broken row exists
```

Id 1's old ciphertext is left untouched until an admin re-enters the password via
Settings → Edit → Test → Save. `/test` will use the supplied password without
decrypting the dead stored value.

---

## Rollout

1. Stop service → 2. deploy backend + script → 3. provision → 4. start →
5. let startup audit run before any backfill → 6. recover broken rows in Settings.

**Back up `C:\ProgramData\MMLPortal\datasource-encryption.key`.** It is
machine-bound: copying it plus PostgreSQL to another computer is *not* sufficient,
because DPAPI unwrapping requires that Windows install. Without the original
Fernet key every datasource password must be re-entered. Cross-machine restore is
out of scope for the POC but must be stated in installer output.

---

## Deferred (follow-up)

- Frontend: `sourceHealth.js`, `SourceStatus.jsx`, `ConnectionAlarmStrip.jsx`,
  `SettingsPage.jsx` health badges, new `api/system.js`. Until then a non-admin
  whose selected datasource is broken sees a generic connection error; the
  distinguishing detail is admin-only via `/api/system/db`.
- Docs: `README.md:334-342`, `CLAUDE.md`, `MML_DEVELOPMENT.md:1199-1212` still
  describe encryption as optional with plaintext acceptable.
- `provision-encryption-key.test.ps1` installer smoke-test harness.
- Key rotation (reader-first/writer-later, two releases).
