"""Tiny installer helper: verify a license file/string offline, no server needed.

Used by install.ps1 (Step 5b) right after an operator pastes a license, so a bad
paste is caught while they're watching rather than surfacing later as a silent
"missing" state on first login. Runs the exact same verification code path
(licensing.verify_license_string) the running service uses, via the venv Python.

Usage:
    python verify_license.py <path-to-license-file>

Exit code 0 = valid/grace/blocked (a real, signed license — state machine says
whether it's currently usable). Exit code 1 = missing (bad format/signature/
unsupported version) or the file could not be read. Prints one line describing
the result either way.
"""
import sys

import licensing


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify_license.py <path-to-license-file>")
        return 1

    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        print(f"Could not read {path}: {e}")
        return 1

    status = licensing.verify_license_string(text)
    if status.state == "missing":
        print(f"INVALID license: {status.error}")
        return 1

    payload = status.payload or {}
    print(
        f"OK: state={status.state} tier={payload.get('tier')} "
        f"customer={payload.get('customer_name')} expires_at={status.expires_at}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
