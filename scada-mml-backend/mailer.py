"""Outbound email for password reset.

Delivery priority (first one configured wins):
    1. Brevo transactional HTTP API   — BREVO_API_KEY in .env (recommended)
    2. Generic SMTP relay              — SMTP_HOST in .env  (legacy fallback)
    3. Dev console / log mode          — neither set; reset link is logged

Brevo HTTP API is the recommended path because it authenticates with an API
key header and does NOT require IP allow-listing, which makes it immune to
dynamic-IP ISP environments where the public IP rotates frequently.

Sending failures are logged and swallowed so the API stays generic
("if that email is registered..."). The /api/auth/forgot-password handler
already runs this in a BackgroundTask — it must never raise.
"""
import json
import logging
import re
import smtplib
import ssl
import urllib.error
import urllib.request
from email.message import EmailMessage

import config

logger = logging.getLogger("mml-api.mailer")

_SUBJECT = "Reset your SCADA password"
_BREVO_URL = "https://api.brevo.com/v3/smtp/email"

# Parses "Display Name <addr@example.com>" or '"Display, Name" <addr@x.com>'
# into a Brevo {name, email} sender object. Bare addresses fall through.
_FROM_RE = re.compile(r'^\s*"?(?P<name>[^"<]*?)"?\s*<(?P<email>[^>]+)>\s*$')


def _build_body(reset_link: str) -> str:
    expire_min = config.RESET_EXPIRE_MIN
    return (
        "Link to reset your MML Portal account password.\n\n"
        f"กดที่ลิงค์นี้เพื่อเปลี่ยน password (valid for {expire_min} "
        "minutes):\n\n"
        f"{reset_link}\n\n"
        "If you did not request this, you can safely ignore this email.\n"
    )


# --- Brevo HTTP API path -----------------------------------------------------
def _parse_sender(from_value: str) -> dict:
    """Convert an RFC-5322 From header into Brevo's {name, email} object."""
    m = _FROM_RE.match(from_value or "")
    if m:
        name = m.group("name").strip()
        email = m.group("email").strip()
        return {"name": name or email, "email": email}
    return {"email": (from_value or "").strip()}


def _send_brevo(to_addr: str, reset_link: str) -> None:
    """POST one transactional email to Brevo. Raises on transport / HTTP error."""
    payload = {
        "sender": _parse_sender(config.SMTP_FROM),
        "to": [{"email": to_addr}],
        "subject": _SUBJECT,
        "textContent": _build_body(reset_link),
    }
    req = urllib.request.Request(
        _BREVO_URL,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "api-key": config.BREVO_API_KEY,
        },
    )
    with urllib.request.urlopen(req, timeout=config.SMTP_TIMEOUT) as resp:
        # Brevo returns 201 Created with {"messageId": "..."}.
        body = resp.read().decode("utf-8", errors="replace")
        logger.info(
            "Brevo accepted message for %s (status=%s body=%s)",
            to_addr, resp.status, body[:200],
        )


# --- Generic SMTP path (legacy fallback) ------------------------------------
def _build_message(to_addr: str, reset_link: str) -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = _SUBJECT
    msg["From"] = config.SMTP_FROM or config.SMTP_USER
    msg["To"] = to_addr
    msg.set_content(_build_body(reset_link))
    return msg


def _send_smtp(msg: EmailMessage) -> None:
    """Send via the configured SMTP relay. Raises on failure."""
    if config.SMTP_SECURITY == "ssl":
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(
            config.SMTP_HOST, config.SMTP_PORT, timeout=config.SMTP_TIMEOUT,
            context=context,
        ) as server:
            if config.SMTP_USER:
                server.login(config.SMTP_USER, config.SMTP_PASS)
            server.send_message(msg)
        return

    with smtplib.SMTP(
        config.SMTP_HOST, config.SMTP_PORT, timeout=config.SMTP_TIMEOUT
    ) as server:
        if config.SMTP_SECURITY == "starttls":
            server.starttls(context=ssl.create_default_context())
        if config.SMTP_USER:
            server.login(config.SMTP_USER, config.SMTP_PASS)
        server.send_message(msg)


# --- Public entry point ------------------------------------------------------
def send_password_reset(email: str, reset_link: str) -> None:
    """Deliver a password-reset link to `email`. Never raises."""
    # 1. Brevo HTTP API (preferred — no IP allow-list)
    if config.BREVO_API_KEY:
        try:
            _send_brevo(email, reset_link)
            return
        except urllib.error.HTTPError as exc:
            # Brevo returns JSON error bodies. Surface enough for diagnosis
            # without leaking key material into logs.
            try:
                err_body = exc.read().decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001
                err_body = ""
            logger.error(
                "Brevo rejected password-reset for %s: HTTP %s %s body=%s",
                email, exc.code, exc.reason, err_body[:500],
            )
            return
        except Exception:  # noqa: BLE001
            logger.exception(
                "Brevo HTTP API failed for password-reset to %s", email,
            )
            return

    # 2. Generic SMTP relay (legacy fallback)
    if config.SMTP_HOST:
        try:
            _send_smtp(_build_message(email, reset_link))
            logger.info(
                "Password-reset email sent to %s via %s",
                email, config.SMTP_HOST,
            )
        except Exception:  # noqa: BLE001 — never surface SMTP errors
            logger.exception(
                "Failed to send password-reset email to %s", email,
            )
        return

    # 3. Dev console / log mode
    logger.info("PASSWORD RESET for %s -> %s", email, reset_link)
