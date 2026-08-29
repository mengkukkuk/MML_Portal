"""`_table_source_conn` against a real saved datasource.

The datasource points back at localhost, so no remote host is needed, but the
row goes through the same path a plant would: get_datasource_secret -> pool ->
memoised db_schema. The schema half is the point. Every plant query used to
hardcode `public.`, silently ignoring the `db_schema` an admin configured, so a
plant on a non-public schema returned "relation does not exist" — or worse, read
a same-named table from the wrong schema.
"""
import time
from time import monotonic

import psycopg
import pytest

import db


@pytest.fixture(scope="module", autouse=True)
def _schema():
    db.init_datasources_table()


@pytest.fixture
def plant_schema():
    """A throwaway schema holding an event_logs that `public` does not."""
    name = f"plant_{int(time.time() * 1000)}"
    with db.get_connection() as conn:
        conn.execute(f'CREATE SCHEMA "{name}"')
        conn.execute(
            f'''CREATE TABLE "{name}".event_logs (
                    location TEXT, tag_name TEXT, event TEXT,
                    at_date_time TIMESTAMP)'''
        )
        conn.execute(
            f'''INSERT INTO "{name}".event_logs VALUES
                ('Line 9', 'M1', 'RUN', now())'''
        )
        conn.commit()
    yield name
    with db.get_connection() as conn:
        conn.execute(f'DROP SCHEMA "{name}" CASCADE')
        conn.commit()


@pytest.fixture
def source(plant_schema):
    import config
    ds = db.create_datasource(
        f"conn_test_{plant_schema}", "postgres",
        config.APP_DB_HOST, config.APP_DB_PORT, config.APP_DB_NAME,
        config.APP_DB_USER, config.APP_DB_PASSWORD, "prefer", plant_schema,
    )
    yield ds
    db.delete_datasource(ds["id"])


def test_yields_the_configured_schema(source, plant_schema):
    with db._table_source_conn(source["id"]) as (conn, schema):
        assert schema == plant_schema
        assert conn.execute("SELECT 1 AS n").fetchone()["n"] == 1


def test_plant_query_reads_the_configured_schema(source):
    """The regression: with a hardcoded `public.` this raises UndefinedTable."""
    rows = db.list_recent_events(10, datasource_id=source["id"])
    assert [r["location"] for r in rows] == ["Line 9"]


def test_none_is_the_app_db_on_public():
    with db._table_source_conn(None) as (_conn, schema):
        assert schema == "public"


def test_unknown_datasource_raises_rather_than_falling_back():
    """Falling back to the app DB would serve config-database rows to a panel
    that asked for a plant — wrong data is worse than an error.

    It must also leave no claim behind: an id that raises before the connection
    is attempted, then reappears (an admin re-creating a deleted datasource),
    would otherwise be fast-failed for the life of the process.
    """
    with pytest.raises(ValueError):
        with db._table_source_conn(987654321):
            pass
    assert 987654321 not in db._ds_probing
    assert 987654321 not in db._ds_down_until


def test_deleting_a_datasource_drops_its_pool(source):
    ds_id = source["id"]
    with db._table_source_conn(ds_id):
        pass
    assert ds_id in db._pools
    db.delete_datasource(ds_id)
    assert ds_id not in db._pools, "a stale pool would keep serving the old host"
    assert ds_id not in db._pool_schemas


def test_updating_a_datasource_drops_its_pool(source):
    """An admin repointing a connection must take effect without a restart."""
    ds_id = source["id"]
    with db._table_source_conn(ds_id):
        pass
    db.update_datasource(
        ds_id, source["name"], "postgres", source["host"], source["port"],
        source["database"], source["username"], None, "prefer", "public",
    )
    assert ds_id not in db._pools
    with db._table_source_conn(ds_id) as (_conn, schema):
        assert schema == "public", "the memoised schema outlived the update"


def test_fan_out_over_a_real_source(source):
    rows, sources = db.fan_out_rows(
        [source["id"]], lambda ds: db.list_recent_events(10, datasource_id=ds)
    )
    assert sources[0]["ok"] is True
    assert rows[0]["datasource_id"] == source["id"]
    assert rows[0]["datasource_name"] == source["name"]


# --- fast-fail window: what keeps one dead plant from stalling the whole page --

@pytest.fixture
def dead_source():
    """A datasource pointing at a closed port on localhost."""
    import config
    ds = db.create_datasource(
        f"dead_test_{int(time.time() * 1000)}", "postgres",
        config.APP_DB_HOST, 5, config.APP_DB_NAME,
        config.APP_DB_USER, config.APP_DB_PASSWORD, "prefer", "public",
    )
    yield ds
    db.delete_datasource(ds["id"])


def _attempt(ds_id):
    with db._table_source_conn(ds_id):
        pass


def test_a_failure_opens_a_fast_fail_window(dead_source):
    """The second caller must not pay the connect timeout again. A Monitor poll
    issues one request per bound symbol; N independent timeouts against the same
    dead host fill the fan-out workers and stall panels bound to healthy ones."""
    ds_id = dead_source["id"]
    with pytest.raises(psycopg.OperationalError):
        _attempt(ds_id)
    assert db._ds_down_until[ds_id] > monotonic()
    with pytest.raises(psycopg.OperationalError):
        _attempt(ds_id)


def test_only_one_caller_probes_once_the_window_expires():
    """The probe is the reconnection attempt, so it must happen — but exactly
    once per window, however many panels are asking.

    Driven through the window bookkeeping rather than a real dead host: every
    genuine attempt costs a full DB_CONNECT_TIMEOUT, and nothing here is an
    assertion about libpq."""
    ds_id = -1
    try:
        assert db._claim_probe(ds_id) is True, "an untried source is not fast-failed"
        db._probe_done(ds_id, ok=False)
        assert db._claim_probe(ds_id) is False, "inside the window everyone waits"

        db._ds_down_until[ds_id] = monotonic() - 1      # window expired
        assert db._claim_probe(ds_id) is True           # this caller probes
        assert db._claim_probe(ds_id) is False          # the rest still wait
        db._probe_done(ds_id, ok=True)
        assert db._claim_probe(ds_id) is True, "a success reopens the source"
    finally:
        db._ds_down_until.pop(ds_id, None)
        db._ds_probing.discard(ds_id)


def test_a_recovered_source_clears_the_window(source):
    """Recovery must cost one poll, not a restart."""
    ds_id = source["id"]
    db._ds_down_until[ds_id] = monotonic() - 1
    _attempt(ds_id)
    assert ds_id not in db._ds_down_until
    assert db.datasource_reachable(ds_id) is True


def test_a_query_fault_does_not_open_a_window(source):
    """A missing table says nothing about reachability — the host answered.
    Fast-failing on it would let one bad panel blind every other one."""
    ds_id = source["id"]
    _attempt(ds_id)
    with pytest.raises(psycopg.errors.UndefinedTable):
        with db._table_source_conn(ds_id) as (conn, _schema):
            conn.execute("SELECT * FROM does_not_exist")
    assert ds_id not in db._ds_down_until


# --- password encryption at rest -------------------------------------------

def test_password_is_encrypted_at_rest_when_key_configured(monkeypatch, plant_schema):
    """create_datasource must store ciphertext, and the round trip through a
    real connection must still work -- encryption has to be invisible to
    every existing caller of get_datasource_secret."""
    from cryptography.fernet import Fernet
    import config

    monkeypatch.setattr(config, "ENCRYPTION_KEY", Fernet.generate_key().decode())
    ds = db.create_datasource(
        f"enc_test_{plant_schema}", "postgres",
        config.APP_DB_HOST, config.APP_DB_PORT, config.APP_DB_NAME,
        config.APP_DB_USER, config.APP_DB_PASSWORD, "prefer", plant_schema,
    )
    try:
        with db.get_connection() as conn:
            raw = conn.execute(
                "SELECT password FROM datasources WHERE id = %s", (ds["id"],)
            ).fetchone()["password"]
        assert raw.startswith("fernet$")
        assert raw != config.APP_DB_PASSWORD

        with db._table_source_conn(ds["id"]) as (conn, schema):
            assert schema == plant_schema
            assert conn.execute("SELECT 1 AS n").fetchone()["n"] == 1
    finally:
        db.delete_datasource(ds["id"])


def test_legacy_plaintext_password_still_works(plant_schema):
    """A row saved before ENCRYPTION_KEY existed (or while it was unset) has no
    fernet$ prefix. get_datasource_secret must return it unchanged, and a real
    connection must still succeed -- upgrading must not strand old rows."""
    import config

    with db.get_connection() as conn:
        row = conn.execute(
            """INSERT INTO datasources
                   (name, type, host, port, dbname, username, password, sslmode, db_schema)
               VALUES (%s, 'postgres', %s, %s, %s, %s, %s, 'prefer', %s)
               RETURNING id""",
            (f"legacy_test_{plant_schema}", config.APP_DB_HOST, config.APP_DB_PORT,
             config.APP_DB_NAME, config.APP_DB_USER, config.APP_DB_PASSWORD, plant_schema),
        ).fetchone()
        conn.commit()
    ds_id = row["id"]
    try:
        secret = db.get_datasource_secret(ds_id)
        assert secret["password"] == config.APP_DB_PASSWORD

        with db._table_source_conn(ds_id) as (conn, schema):
            assert schema == plant_schema
            assert conn.execute("SELECT 1 AS n").fetchone()["n"] == 1
    finally:
        db.delete_datasource(ds_id)


def test_encrypt_legacy_datasource_passwords_migrates_and_is_idempotent(monkeypatch, plant_schema):
    from cryptography.fernet import Fernet
    import config

    with db.get_connection() as conn:
        row = conn.execute(
            """INSERT INTO datasources
                   (name, type, host, port, dbname, username, password, sslmode, db_schema)
               VALUES (%s, 'postgres', %s, %s, %s, %s, %s, 'prefer', %s)
               RETURNING id""",
            (f"sweep_test_{plant_schema}", config.APP_DB_HOST, config.APP_DB_PORT,
             config.APP_DB_NAME, config.APP_DB_USER, config.APP_DB_PASSWORD, plant_schema),
        ).fetchone()
        conn.commit()
    ds_id = row["id"]
    try:
        monkeypatch.setattr(config, "ENCRYPTION_KEY", Fernet.generate_key().decode())

        migrated = db.encrypt_legacy_datasource_passwords()
        assert migrated >= 1

        with db.get_connection() as conn:
            first = conn.execute(
                "SELECT password FROM datasources WHERE id = %s", (ds_id,)
            ).fetchone()["password"]
        assert first.startswith("fernet$")
        assert db.get_datasource_secret(ds_id)["password"] == config.APP_DB_PASSWORD

        db.encrypt_legacy_datasource_passwords()
        with db.get_connection() as conn:
            second = conn.execute(
                "SELECT password FROM datasources WHERE id = %s", (ds_id,)
            ).fetchone()["password"]
        assert second == first, "an already-migrated row must not be re-encrypted"
    finally:
        db.delete_datasource(ds_id)


def test_test_datasource_reports_decrypt_failure_as_ok_false(monkeypatch):
    """A RuntimeError from get_datasource_secret (key mismatch) must degrade to
    a normal failed-test response, not an unhandled 500."""
    import datasources as datasources_router

    def _raise(_id):
        raise RuntimeError("Stored password could not be decrypted - key mismatch")

    monkeypatch.setattr(db, "get_datasource_secret", _raise)
    result = datasources_router.test_datasource(
        datasources_router.DatasourceTestIn(datasource_id=1)
    )
    assert result.ok is False
    assert "decrypted" in result.message
