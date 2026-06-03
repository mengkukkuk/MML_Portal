"""Outbound email for password reset.

Real delivery via an SMTP relay when "config.SMTP_HOST" is set; otherwise the
reset link is logged (dev console mode). Configure the relay in ".env":

    SMTP_HOST=smtp.example.com
    SMTP_PORT=587
    SMTP_USER=apikey-or-username
    SMTP_PASS=secret
    SMTP_FROM="SCADA <no-reply@example.com>"
    SMTP_SECURITY=starttls # starttls | ssl | none

Sending failures are logged and swallowed, so the API still returns its generic
"if that email is registered…" response (no information leak, no. 500).
"""
import logging
import smtplib
import ssl
from email.message import EmailMessage

import config

logger = logging.getLogger("scada-api.mailer")

_SUBJECT = "Reset your SCADA password"


def _build_message(to_addr: str, reset_link: str) -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = _SUBJECT
    msg["From"] = config.SMTP_FROM or config.SMTP_USER
    msg["To"] = to_addr
    expire_min = config.RESET_EXPIRE_MIN
    msg.set_content(
        "We received a request to reset your SCADA account password.\n\n"
        f"Open this link to choose a new password (valid for {expire_min} minutes):\n\n"
        f"{reset_link}\n\n"
        "If you did not request this, you can safely ignore this email.\n"
    )
    return msg


def _send_smtp(msg: EmailMessage) -> None:
    """Send it via the configured SMTP relay. Rise on failure."""
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
        if config.SMTP_SECURITY == "STARTTLS":
            server.starttls(context=ssl.create_default_context())
        if config.SMTP_USER:
            server.login(config.SMTP_USER, config.SMTP_PASS)
        server.send_message(msg)


def send_password_reset(email: str, reset_link: str) -> None:
    """Deliver a password-reset link to `email`.

    Send via SMTP when configured; otherwise logs the link (dev mode).
    Never raises — delivery problems log so the endpoint stays generic.
    """
    if not config.SMTP_HOST:
        logger.info("PASSWORD RESET for %s -> %s", email, reset_link)
        return

    try:
        _send_smtp(_build_message(email, reset_link))
        logger.info("Password-reset email sent to %s via %s", email, config.SMTP_HOST)
    except Exception:  # noqa: BLE001 — never surface SMTP errors to the caller
        logger.exception("Failed to send password-reset email to %s", email)
