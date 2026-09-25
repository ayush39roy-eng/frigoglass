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
    assert counts["workflow_step_templates"] == 14
    assert counts["_verified_from_db"]["projects"] == 46

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
    assert counts["users"] == 6
    assert counts["_verified_from_db"]["users"] == 6

    with pytest.raises(RuntimeError, match="already has"):
        asyncio.run(seed_dev_users.run(reset_first=False))

    counts_after_reset = asyncio.run(seed_dev_users.run(reset_first=True))
    assert counts_after_reset["_verified_from_db"]["users"] == 6
