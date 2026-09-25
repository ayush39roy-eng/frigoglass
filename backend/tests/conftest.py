"""Shared pytest fixtures for the P1-T05 backend test suite.

Per the `qa-testing` skill: one `testcontainers` Postgres instance per test
*session* (not per test), with each test wrapped in a transaction (using a
SAVEPOINT via `join_transaction_mode="create_savepoint"`) that rolls back at
teardown, so tests stay isolated from each other without paying
container-startup cost repeatedly.

A handful of tests need their *own* dedicated, throwaway Postgres container
instead of the shared one (migration up/down/up-again cycle, seed-script
duplicate-guard/--reset behaviour) because those tests need to run real DDL
(`alembic downgrade`) or commit real data outside of any savepoint that could
be rolled back — those tests build their own `PostgresContainer` locally
rather than using these session fixtures. See `tests/test_migrations.py` and
`tests/test_seed_scripts.py`.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
import pytest_asyncio
from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

# A fixed, valid Fernet key for the whole test session. Must be set before
# any encrypted column is read/written (`models/types.py`'s `_fernet()` reads
# it lazily via `os.environ`, cached with `lru_cache`) so setting it once
# here, before any test module imports `models`, is sufficient.
os.environ.setdefault("RPD_FIELD_ENCRYPTION_KEY", Fernet.generate_key().decode())

# Same "fail loudly in prod, painless-default in tests" pattern as the
# Fernet key above (P3-T06): `workers/celery_app.py::celery_app` is built at
# MODULE IMPORT time (`celery_app = _build_celery_app()`), and
# `api/routers/schedule_runs.py` imports it, and `api/main.py` imports that
# router — so `RPD_REDIS_URL` must already be a syntactically valid value
# before pytest even finishes COLLECTING test modules (most of which import
# `api.main` at module scope), not merely before the first test that
# actually needs Redis runs. `core.celery_config.RedisSettings` itself still
# has no default (fails loudly outside tests) — this `setdefault` only
# affects this test process. Constructing a `celery.Celery(...)` app object
# with an unreachable broker URL does not itself raise (Celery connects
# lazily, on first actual broker operation) — this placeholder value is
# never dialled by most tests. Tests that need a REAL, reachable Redis
# (`tests/test_workers_progress.py`) spin up their own dedicated
# `testcontainers` Redis and reset `workers.progress`'s lazy client / call
# `core.celery_config.get_redis_settings.cache_clear()` to point at it,
# rather than relying on this placeholder — mirroring
# `tests/test_migrations.py`'s "own dedicated throwaway container" pattern.
os.environ.setdefault("RPD_REDIS_URL", "redis://localhost:6379/0")


def run_alembic(args: list[str], database_url: str) -> subprocess.CompletedProcess:
    """Run `python -m alembic <args>` against `database_url`, from `backend/`.

    Used both by the shared-container migration-application fixture below and
    by `tests/test_migrations.py` / `tests/test_seed_scripts.py`'s own
    dedicated containers. Subprocess (not the Alembic Python API in-process)
    deliberately mirrors exactly how P1-T02 was verified by hand, and avoids
    any event-loop nesting issues between Alembic's own `asyncio.run()` calls
    and pytest-asyncio's loop.
    """
    env = os.environ.copy()
    env["RPD_DATABASE_URL"] = database_url
    return subprocess.run(
        [sys.executable, "-m", "alembic"] + args,
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
    )


@pytest.fixture(scope="session")
def postgres_container():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        yield pg


@pytest.fixture(scope="session")
def database_url(postgres_container: PostgresContainer) -> str:
    return postgres_container.get_connection_url()


@pytest.fixture(scope="session", autouse=True)
def _apply_migrations(database_url: str) -> None:
    """Runs `alembic upgrade head` once against the shared session container,
    and sets `RPD_DATABASE_URL` for the rest of the process (seed scripts /
    `api.db` read it at call time) so tests that don't spin their own
    container can rely on it being set correctly.
    """
    os.environ["RPD_DATABASE_URL"] = database_url
    result = run_alembic(["upgrade", "head"], database_url)
    assert result.returncode == 0, (
        f"alembic upgrade head failed:\nstdout={result.stdout}\nstderr={result.stderr}"
    )


@pytest_asyncio.fixture
async def db_session(database_url: str, _apply_migrations: None) -> AsyncSession:
    """Function-scoped `AsyncSession` bound to its own connection + outer
    transaction, using SAVEPOINTs for the session's own begin/commit calls
    (`join_transaction_mode="create_savepoint"`) so that even code under test
    that calls `session.commit()` (e.g. `api/routers/currency_rates.py`'s
    `PUT` handler) doesn't actually commit outside this test — the outer
    transaction is rolled back unconditionally at teardown, isolating every
    test from every other regardless of scope/table involved.

    Deliberately creates its own `AsyncEngine` per test (rather than reusing
    one shared session-scoped engine) and disposes it at teardown: asyncpg
    connections/pools are bound to the event loop they were created in, and
    pytest-asyncio's default "auto" mode gives each test function its own
    event loop — sharing one engine's connection pool across per-test loops
    caused exactly the `InterfaceError: cannot perform operation: another
    operation is in progress` failures this fixture's first version hit
    (confirmed empirically while building this suite). The Postgres
    *container* itself is still shared for the whole session (see
    `postgres_container` above) — only the SQLAlchemy engine object is
    per-test, which is cheap (no new container/process, just a fresh asyncpg
    connection to the already-running database).
    """
    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as conn:
            trans = await conn.begin()
            session_factory = async_sessionmaker(
                bind=conn, expire_on_commit=False, join_transaction_mode="create_savepoint"
            )
            async with session_factory() as session:
                yield session
            await trans.rollback()
    finally:
        await engine.dispose()
