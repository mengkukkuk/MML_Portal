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

# (username, password, role, display_name)
MOCK_USERS = [
    ("admin", "admin123", "admin", "Administrator"),
    ("operator", "operator123", "operator", "Line Operator"),
]

UPSERT = """
INSERT INTO users (username, password_hash, role, display_name)
VALUES (%s, %s, %s, %s)
ON CONFLICT (username) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    role          = EXCLUDED.role,
    display_name  = EXCLUDED.display_name;
"""


def main() -> None:
    with db.get_connection() as conn:
        conn.execute(CREATE_TABLE)
        for username, password, role, display_name in MOCK_USERS:
            conn.execute(
                UPSERT,
                (username, security.hash_password(password), role, display_name),
            )
        conn.commit()
        rows = conn.execute(
            "SELECT id, username, role, display_name FROM users ORDER BY id"
        ).fetchall()

    print(f"Seeded {len(rows)} user(s):")
    for r in rows:
        print(f"  #{r['id']} {r['username']} ({r['role']}) - {r['display_name']}")


if __name__ == "__main__":
    main()
