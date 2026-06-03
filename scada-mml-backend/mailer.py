"""Outbound email — dev console/log sink.

Dev mode (the default) does NOT send real email: the password-reset link is
written to the application log so you can copy it during local testing.

To enable real delivery later, add an SMTP branch inside ``send_password_reset``
(read host/port/user/pass/from from ``config``) — callers don't need to change.
"""
import logging

logger = logging.getLogger("scada-api.mailer")


def send_password_reset(email: str, reset_link: str) -> None:
    """Deliver a password-reset link to ``email``.

    Dev mode: log the link instead of sending. Swap in SMTP here when ready.
    """
    logger.info("PASSWORD RESET for %s -> %s", email, reset_link)
