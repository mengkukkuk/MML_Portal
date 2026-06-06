import time
import traceback

import db

username = f"test_user_{int(time.time())}"
email = f"{username}@example.com"

try:
    print('Creating user', username)
    row = db.create_user(username, 'pw_hash', 'user', 'Test User', email)
    print('Created:', row)

    user_id = row['id']
    print('Updating user', user_id)
    updated = db.update_user(user_id, 'user', 'Updated Name', f"{username}+upd@example.com")
    print('Updated:', updated)

    print('Deleting user', user_id)
    deleted = db.delete_user(user_id)
    print('Deleted:', deleted)

    print('SUCCESS')
except Exception as e:
    print('ERROR', type(e).__name__, e)
    traceback.print_exc()
    raise
