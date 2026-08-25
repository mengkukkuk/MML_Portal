"""The tag buffer's recovery behaviour when a plant database goes down and back.

Two mechanisms, one story:

* the **skip list** stops one broken plant flooding the log. A plant with no
  `variables_tag` raises UndefinedTable on every poll, and at
  TAG_BUFFER_POLL_SECONDS=5 that is 720 tracebacks an hour, per source, for a
  condition that will not fix itself. A *transient* failure must never be parked,
  and a parked source must come back on its own.
* the **freshness gate** (`db.is_tag_buffered`) decides whether a Live tile or a
  mimic symbol reads variables_tag from memory or from the plant. Once the buffer
  stops being refreshed it must stop answering, or the last sample taken before
  an outage is served as a valid 200 forever and nothing downstream ever learns
  the source went away.

`_park` and `_tag_buffer_targets` read the running loop's clock, so each test runs
inside asyncio.run rather than monkeypatching time.
"""
import asyncio
from time import monotonic

import pytest

import config
import db
import main


@pytest.fixture(autouse=True)
def _clean():
    main._tag_skip.clear()
    main._tag_fails.clear()
    main._tag_park_transient.clear()
    yield
    main._tag_skip.clear()
    main._tag_fails.clear()
    main._tag_park_transient.clear()


def _run(fn):
    async def wrapper():
        return fn()
    return asyncio.run(wrapper())


def test_a_few_failures_do_not_park():
    """Below the limit nothing is parked: a plant that blips during a restart
    must not lose an hour of sampling over it."""
    def body():
        for _ in range(config.TAG_BUFFER_FAIL_LIMIT - 1):
            main._park(3, "boom")
        assert 3 not in main._tag_skip
        assert main._tag_buffer_targets([3]) == [3]
    _run(body)


def test_reaching_the_limit_parks_the_source():
    def body():
        for _ in range(config.TAG_BUFFER_FAIL_LIMIT):
            main._park(3, "relation \"variables_tag\" does not exist")
        assert main._tag_skip[3][1] == main._TAG_SKIP_MIN_S
        assert main._tag_buffer_targets([3, 4]) == [4]
    _run(body)


def test_backoff_doubles_and_stops_at_the_ceiling():
    def body():
        for _ in range(config.TAG_BUFFER_FAIL_LIMIT):
            main._park(3, "x")
        delays = [main._tag_skip[3][1]]
        for _ in range(20):
            main._park(3, "x")
            delays.append(main._tag_skip[3][1])
        assert delays[0] == main._TAG_SKIP_MIN_S
        assert delays[1] == main._TAG_SKIP_MIN_S * 2
        assert delays[-1] == main._TAG_SKIP_MAX_S
    _run(body)


def test_a_parked_source_returns_once_its_delay_expires():
    """Recovery must not need a restart — the park is a delay, not a blacklist."""
    def body():
        for _ in range(config.TAG_BUFFER_FAIL_LIMIT):
            main._park(3, "x")
        main._tag_skip[3] = (0.0, main._TAG_SKIP_MIN_S)  # deadline in the past
        assert main._tag_buffer_targets([3]) == [3]
    _run(body)


def test_the_source_cap_bites_and_is_applied_after_parking():
    """The ceiling counts *live* sources. Parked ones must not consume a slot,
    or one broken plant would silently push a healthy one out of the buffer."""
    def body():
        for _ in range(config.TAG_BUFFER_FAIL_LIMIT):
            main._park(0, "x")
        selected = list(range(config.TAG_BUFFER_MAX_SOURCES + 1))
        targets = main._tag_buffer_targets(selected)
        assert 0 not in targets
        assert len(targets) == config.TAG_BUFFER_MAX_SOURCES
    _run(body)


def test_the_app_db_is_a_valid_target():
    """A fresh install with no saved datasources samples [None]; a None id must
    survive the dict lookups in the skip list."""
    def body():
        assert main._tag_buffer_targets([None]) == [None]
        for _ in range(config.TAG_BUFFER_FAIL_LIMIT):
            main._park(None, "x")
        assert main._tag_buffer_targets([None]) == []
    _run(body)


def test_a_connection_park_is_cut_short_once_traffic_proves_the_host_is_back(monkeypatch):
    """The panels polling every few seconds see a plant recover long before the
    backoff expires. Ignoring that leaves the charts empty for up to an hour
    while the tiles beside them already show live values."""
    def body():
        monkeypatch.setattr(db, "datasource_reachable", lambda _id: False)
        for _ in range(config.TAG_BUFFER_FAIL_LIMIT):
            main._park(3, "connection refused")
        assert main._tag_buffer_targets([3]) == []

        monkeypatch.setattr(db, "datasource_reachable", lambda _id: True)
        assert main._tag_buffer_targets([3]) == [3]
        # The level survives so a relapse resumes doubling, not restarts.
        assert main._tag_skip[3][1] == main._TAG_SKIP_MIN_S
    _run(body)


def test_a_missing_table_park_is_not_cut_short_by_reachability(monkeypatch):
    """A plant with no variables_tag answers every query perfectly. Treating
    "reachable" as recovery there would unpark it every tick and hand back the
    720-lines-an-hour log flood the park exists to stop."""
    def body():
        monkeypatch.setattr(db, "datasource_reachable", lambda _id: True)
        for _ in range(config.TAG_BUFFER_FAIL_LIMIT):
            main._park(3, 'relation "variables_tag" does not exist')
        assert main._tag_buffer_targets([3]) == []
        assert main._tag_buffer_targets([3]) == []
    _run(body)


def test_a_successful_poll_clears_the_failure_count(monkeypatch):
    """Consecutive, not cumulative: five failures spread over a working day are
    not the same condition as five in a row."""
    def body():
        for _ in range(config.TAG_BUFFER_FAIL_LIMIT - 1):
            main._park(3, "x")
        # what _tag_buffer_loop does on report["ok"]
        main._tag_fails.pop(3, None)
        main._tag_skip.pop(3, None)
        main._park(3, "x")
        assert 3 not in main._tag_skip
    _run(body)


# --- the freshness gate ------------------------------------------------------

@pytest.fixture(autouse=True)
def _clean_buffer():
    db._tag_sampled_at.clear()
    yield
    db._tag_sampled_at.clear()


def test_an_unsampled_source_is_never_served_from_memory():
    """A source the loop does not poll has an empty buffer; answering from it
    draws a permanently blank chart, where the live query at least shows the one
    row variables_tag holds."""
    assert db.is_tag_buffered(7) is False


def test_a_freshly_sampled_source_is_served_from_memory():
    db._tag_sampled_at[7] = monotonic()
    assert db.is_tag_buffered(7) is True


def test_a_buffer_that_stopped_being_refreshed_stops_answering():
    """The bug this gate exists for: during an outage the buffer still holds the
    last pre-outage sample. Served unconditionally it is a perfectly good 200
    forever, so the tile shows a frozen value, no error is ever raised, and
    nothing retries when the plant comes back."""
    db._tag_sampled_at[7] = monotonic() - db.tag_buffer_stale_after() - 1
    assert db.is_tag_buffered(7) is False


def test_the_gate_outlasts_a_merely_late_poll():
    """One slow tick must not bounce every panel onto live queries."""
    db._tag_sampled_at[7] = monotonic() - config.TAG_BUFFER_POLL_SECONDS * 2
    assert db.is_tag_buffered(7) is True
