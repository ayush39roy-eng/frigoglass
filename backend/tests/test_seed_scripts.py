"""Scenario #8 — the seed scripts' duplicate-guard actually fires on a
second run without `--reset`, and `--reset` actually clears and allows a
clean reseed. Covers `seed.seed_demo_data` (P1-T03), `seed.seed_currency_rates`
(P1-T04), and `seed.seed_dev_users` (P3-T02).

Spins up its own dedicated, throwaway Postgres 17 container (not the shared
session-scoped one in `tests/conftest.py`): these seed scripts commit real
data via their own `run()` functions, and running the full 46-project demo
seed against the shared container would pollute every other test module's
row-count/query assumptions for the rest of the session. Also temporarily
overrides `RPD_DATABASE_URL` via `monkeypatch` (auto-restored after the
test) since the seed scripts read it from `os.environ` at call time.
"""

from __future__ import annotations

import asyncio
import importlib

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

from tests.conftest import run_alembic


@pytest.fixture(scope="module")
def seeded_schema_url():
    """One dedicated container + `alembic upgrade head`, reused by every test
    in this module (module-scoped, not function-scoped) — the tests
    themselves reset/reseed the data they need, so there's no cross-test
    schema-level dependency, only cheaper container reuse.
    """
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, f"alembic upgrade head failed:\n{r.stdout}\n{r.stderr}"
        yield url


def test_seed_demo_data_duplicate_guard_and_reset(seeded_schema_url, monkeypatch):
    monkeypatch.setenv("RPD_DATABASE_URL", seeded_schema_url)
    # Fresh import (not relying on any earlier module-level caching) — the
    # module reads RPD_DATABASE_URL at call time inside run(), not at import
    # time, so a plain import is sufficient; importlib.reload isn't required
    # but used defensively in case a prior test module already imported this
    # with a different env var in scope.
    seed_demo_data = importlib.import_module("seed.seed_demo_data")
    importlib.reload(seed_demo_data)

    # First run: table is empty, should succeed and load the full dataset.
    counts = asyncio.run(seed_demo_data.run(reset_first=False))
    assert counts["projects"] == 46
    assert counts["hubs"] == 6
    assert counts["hub_work_calendars"] == 6
    assert counts["chambers"] == 10
    # P9-T01: 28 templates (PDD + OEM) and the 98-row lead-time table — upserted
    # over the rows the migration already inserted, so still exactly 28 / 98.
    assert counts["workflow_step_templates"] == 28
    assert counts["workflow_lead_times"] == 98
    assert counts["_verified_from_db"]["projects"] == 46
    assert counts["_verified_from_db"]["workflow_step_templates"] == 28
    assert counts["_verified_from_db"]["workflow_lead_times"] == 98
    assert counts["_verified_from_db"]["hub_work_calendars"] == 6

    # Second run, no --reset: the duplicate-seed guard must fire loudly
    # (RuntimeError), not silently skip or silently duplicate rows.
    with pytest.raises(RuntimeError, match="already has"):
        asyncio.run(seed_demo_data.run(reset_first=False))

    # --reset: truncates every seeded table (children-first) and reseeds
    # cleanly back to the same row counts, not doubled/duplicated.
    counts_after_reset = asyncio.run(seed_demo_data.run(reset_first=True))
    assert counts_after_reset["projects"] == 46
    assert counts_after_reset["_verified_from_db"]["projects"] == 46
    assert counts_after_reset["_verified_from_db"]["project_workflow_steps"] == 46 * 14
    assert counts_after_reset["_verified_from_db"]["priority_scores"] == 46

    # --reset must have actually reset, not appended: re-running --reset a
    # second time in a row should give the identical counts again, not 92.
    counts_after_second_reset = asyncio.run(seed_demo_data.run(reset_first=True))
    assert counts_after_second_reset["_verified_from_db"]["projects"] == 46


def test_seed_currency_rates_duplicate_guard_and_reset(seeded_schema_url, monkeypatch):
    monkeypatch.setenv("RPD_DATABASE_URL", seeded_schema_url)
    seed_currency_rates = importlib.import_module("seed.seed_currency_rates")
    importlib.reload(seed_currency_rates)

    counts = asyncio.run(seed_currency_rates.run(reset_first=False))
    assert counts["_verified_from_db"]["currency_rates"] == 3

    with pytest.raises(RuntimeError, match="already has"):
        asyncio.run(seed_currency_rates.run(reset_first=False))

    counts_after_reset = asyncio.run(seed_currency_rates.run(reset_first=True))
    assert counts_after_reset["_verified_from_db"]["currency_rates"] == 3


def test_seed_dev_users_duplicate_guard_and_reset(seeded_schema_url, monkeypatch):
    monkeypatch.setenv("RPD_DATABASE_URL", seeded_schema_url)
    seed_dev_users = importlib.import_module("seed.seed_dev_users")
    importlib.reload(seed_dev_users)

    counts = asyncio.run(seed_dev_users.run(reset_first=False))
    assert counts["users"] == 7  # six matrix roles + Super Admin (P9-T01)
    assert counts["_verified_from_db"]["users"] == 7

    with pytest.raises(RuntimeError, match="already has"):
        asyncio.run(seed_dev_users.run(reset_first=False))

    counts_after_reset = asyncio.run(seed_dev_users.run(reset_first=True))
    assert counts_after_reset["_verified_from_db"]["users"] == 7


async def _fetch(url: str, stmt):
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            return (await session.execute(stmt)).scalars().all()
    finally:
        await engine.dispose()


def test_seed_dev_users_links_carol_to_engineer_and_scopes_bob_to_a_hub(
    seeded_schema_url, monkeypatch
):
    """P9-F04: when `seed_demo_data` HAS already populated `Engineer`/`Hub`
    rows (the documented, real dev workflow — `frontend/e2e/README.md`'s
    ordering), `seed_dev_users` links `carol.eng` to the real `Engineer`
    named `_CAROL_ENGINEER_NAME` and gives `bob.hub` a real, non-"all" hub
    scope (`_BOB_HUB_NAME`) rather than `hub_scope_all=True`. A `--reset`
    round-trip must not crash on the FK from `Engineer.user_id` /
    `UserHubScope.user_id` back to `User`, and must re-link cleanly.
    """
    from models import Engineer, Hub, User, UserHubScope

    monkeypatch.setenv("RPD_DATABASE_URL", seeded_schema_url)
    seed_demo_data = importlib.import_module("seed.seed_demo_data")
    importlib.reload(seed_demo_data)
    seed_dev_users = importlib.import_module("seed.seed_dev_users")
    importlib.reload(seed_dev_users)

    # `reset_first=True` regardless of whether an earlier test in this module
    # already seeded demo data (module-scoped `seeded_schema_url`) — this
    # test must not depend on execution order.
    asyncio.run(seed_demo_data.run(reset_first=True))
    counts = asyncio.run(seed_dev_users.run(reset_first=True))
    assert counts["users"] == 7

    carol_user = asyncio.run(
        _fetch(seeded_schema_url, select(User).where(User.email == "carol.eng@example.com"))
    )[0]
    bob_user = asyncio.run(
        _fetch(seeded_schema_url, select(User).where(User.email == "bob.hub@example.com"))
    )[0]
    carol_engineer = asyncio.run(
        _fetch(
            seeded_schema_url,
            select(Engineer).where(Engineer.name == seed_dev_users._CAROL_ENGINEER_NAME),
        )
    )[0]
    bob_hub = asyncio.run(
        _fetch(seeded_schema_url, select(Hub).where(Hub.name == seed_dev_users._BOB_HUB_NAME))
    )[0]

    assert carol_engineer.user_id == carol_user.id
    # P10-F01: the only Engineer in this seed must never get
    # `hub_scope_all=True` (the exact live-exploited bug shape the P10 gate
    # security-auditor found).
    assert carol_user.hub_scope_all is False
    assert bob_user.hub_scope_all is False
    bob_scopes = asyncio.run(
        _fetch(seeded_schema_url, select(UserHubScope).where(UserHubScope.user_id == bob_user.id))
    )
    assert [s.hub_id for s in bob_scopes] == [bob_hub.id]
    # Every other dev user is unaffected — still hub_scope_all=True.
    alice = asyncio.run(
        _fetch(seeded_schema_url, select(User).where(User.email == "alice.pm@example.com"))
    )[0]
    assert alice.hub_scope_all is True

    # --reset must not crash on the FKs this linkage introduced, and must
    # re-link cleanly rather than leaving the Engineer/hub-scope rows stale.
    counts_after_reset = asyncio.run(seed_dev_users.run(reset_first=True))
    assert counts_after_reset["_verified_from_db"]["users"] == 7

    carol_user_2 = asyncio.run(
        _fetch(seeded_schema_url, select(User).where(User.email == "carol.eng@example.com"))
    )[0]
    carol_engineer_2 = asyncio.run(
        _fetch(
            seeded_schema_url,
            select(Engineer).where(Engineer.name == seed_dev_users._CAROL_ENGINEER_NAME),
        )
    )[0]
    assert carol_engineer_2.user_id == carol_user_2.id
    assert carol_user_2.hub_scope_all is False
    bob_user_2 = asyncio.run(
        _fetch(seeded_schema_url, select(User).where(User.email == "bob.hub@example.com"))
    )[0]
    assert bob_user_2.hub_scope_all is False
    bob_scopes_2 = asyncio.run(
        _fetch(
            seeded_schema_url, select(UserHubScope).where(UserHubScope.user_id == bob_user_2.id)
        )
    )
    assert [s.hub_id for s in bob_scopes_2] == [bob_hub.id]
