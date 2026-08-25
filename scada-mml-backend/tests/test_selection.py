"""Per-user datasource selection, against the real local app database.

The app database is localhost by construction now, so there is nothing to mock:
these run against it directly and clean up after themselves. What matters here
is the fallback ladder in auth.resolve_active_datasources and the cascade
behaviour of user_datasource_selection — both are the kind of thing that looks
obviously right and is quietly wrong.
"""
import time

import pytest

import auth
import config
import db


@pytest.fixture(scope="module", autouse=True)
def _schema():
    db.init_users_table()
    db.init_datasources_table()
    db.init_user_datasource_selection_table()


@pytest.fixture
def user():
    name = f"sel_test_{int(time.time() * 1000)}"
    row = db.create_user(name, "hash", "operator", "Selection Test", None)
    yield row["id"]
    db.delete_user(row["id"])


@pytest.fixture
def sources():
    """Two throwaway datasources. Never connected to — only their rows matter."""
    made = []
    for i in (1, 2):
        made.append(db.create_datasource(
            f"sel_test_ds_{int(time.time() * 1000)}_{i}", "postgres",
            f"10.255.255.{i}", 5432, "nowhere", "nobody", "", "prefer", "public",
        ))
    yield made
    for ds in made:
        db.delete_datasource(ds["id"])


def test_new_user_has_no_explicit_selection(user):
    assert db.get_user_selection(user) == []


def test_resolver_falls_back_to_lowest_id_datasource(user, sources):
    """Not "all datasources": one powered-off plant would then cost a connect
    timeout on every request for a choice nobody made."""
    resolved = auth.resolve_active_datasources(user)
    assert len(resolved) == 1
    assert resolved[0] == min(d["id"] for d in db.list_datasources())


def test_explicit_selection_wins_and_keeps_order(user, sources):
    ids = [sources[1]["id"], sources[0]["id"]]
    db.set_user_selection(user, ids)
    assert [r["id"] for r in db.get_user_selection(user)] == ids
    assert auth.resolve_active_datasources(user) == ids


def test_position_zero_is_the_first_id_given(user, sources):
    """Mimic symbols and the legacy single-value fields resolve to position 0,
    so the order the operator picked has to survive the round trip."""
    db.set_user_selection(user, [sources[1]["id"], sources[0]["id"]])
    rows = db.get_user_selection(user)
    assert rows[0]["position"] == 0 and rows[0]["id"] == sources[1]["id"]


def test_duplicate_ids_are_collapsed_first_wins(user, sources):
    a, b = sources[0]["id"], sources[1]["id"]
    db.set_user_selection(user, [b, a, b])
    assert [r["id"] for r in db.get_user_selection(user)] == [b, a]


def test_unknown_id_is_rejected_not_silently_dropped(user, sources):
    with pytest.raises(ValueError, match="unknown datasource"):
        db.set_user_selection(user, [sources[0]["id"], 987654321])
    assert db.get_user_selection(user) == [], "a rejected write must not partially apply"


def test_selection_is_capped(user, sources):
    too_many = [sources[0]["id"]] * (config.MAX_SELECTED_DATASOURCES + 1)
    # Distinct ids are needed for the cap to be the thing that trips, and only
    # two exist -- assert on the raw list length check instead.
    with pytest.raises(ValueError, match="at most"):
        db.set_user_selection(user, too_many)


def test_clearing_returns_to_implicit(user, sources):
    db.set_user_selection(user, [sources[0]["id"]])
    db.set_user_selection(user, [])
    assert db.get_user_selection(user) == []
    assert auth.resolve_active_datasources(user) == [
        min(d["id"] for d in db.list_datasources())
    ]


def test_deleting_a_datasource_cascades_out_of_the_selection(user, sources):
    """Without the cascading FK every read path would have to defend against
    ids that no longer exist."""
    db.set_user_selection(user, [sources[0]["id"], sources[1]["id"]])
    db.delete_datasource(sources[0]["id"])
    assert [r["id"] for r in db.get_user_selection(user)] == [sources[1]["id"]]


def test_all_selected_ids_is_the_union_across_users(user, sources):
    db.set_user_selection(user, [sources[1]["id"]])
    assert sources[1]["id"] in db.all_selected_datasource_ids()


def test_datasource_names_labels_the_app_db_and_unknown_ids():
    names = db.datasource_names([None, 987654321])
    assert names[None] == "Local"
    assert names[987654321] == "datasource 987654321"
