"""Create the users table and seed mock users for local auth testing.

Idempotent: safe to run multiple times. Run with:
    venv\\Scripts\\python.exe seed_users.py
"""
import db
import security

CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'operator',
    display_name  TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

# Idempotent migration for the optional email column (added for account management).
# Executed as separate statements — psycopg's extended protocol runs one command at a time.
MIGRATIONS = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;",
    """CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
       ON users (lower(email)) WHERE email IS NOT NULL;""",
]

# (username, password, role, display_name, email)
MOCK_USERS = [
    ("admin", "admin123", "admin", "Administrator", "admin@scada.local"),
    ("operator", "operator123", "operator", "Line Operator", "operator@scada.local"),
]

UPSERT = """
INSERT INTO users (username, password_hash, role, display_name, email)
VALUES (%s, %s, %s, %s, %s)
ON CONFLICT (username) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    role          = EXCLUDED.role,
    display_name  = EXCLUDED.display_name,
    email         = EXCLUDED.email;
"""


def main() -> None:
    with db.get_connection() as conn:
        conn.execute(CREATE_TABLE)
        for statement in MIGRATIONS:
            conn.execute(statement)
        for username, password, role, display_name, email in MOCK_USERS:
            conn.execute(
                UPSERT,
                (username, security.hash_password(password), role, display_name, email),
            )
        conn.commit()
        rows = conn.execute(
            "SELECT id, username, role, display_name, email FROM users ORDER BY id"
        ).fetchall()

    print(f"Seeded {len(rows)} user(s):")
    for r in rows:
        print(
            f"  #{r['id']} {r['username']} ({r['role']}) - "
            f"{r['display_name']} <{r['email'] or '-'}>"
        )


if __name__ == "__main__":
    main()
