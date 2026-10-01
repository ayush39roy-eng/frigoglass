"""P9-R02 / security S-01: the last-Super-Admin guard under real concurrency.

The P9-T07 reproduction: Super Admins A and B at the same moment send
`PATCH /users/{other}` with `{"roles": []}`. Before the fix, 9 of 10 runs
left zero active Super Admins, and the other variants' loser got a 500 from a
deadlock.

This test runs the real app and the real `api.deps` auth (dev mode +
`X-Dev-User-Email`, so each thread acts as a different Super Admin) on a
dedicated Postgres 17 with committed rows. Each request runs in its own
thread with its own event loop and connection (NullPool engine), released
together by a barrier. Every round must leave at least one active Super
Admin, and every response must be 200 or 409 (never 500).
"""

from __future__ import annotations

import asyncio
import threading
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from testcontainers.postgres import PostgresContainer

from api.db import get_db
from api.main import app
from models.enums import RoleName
from models.user import Role, User, UserRole
from tests.conftest import run_alembic

ROUNDS = 10
VARIANTS = [
    {"roles": []},
    {"roles": ["Portfolio Manager"]},
    {"is_active": False},
]


@pytest.fixture(scope="module")
def pg_url():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        result = run_alembic(["upgrade", "head"], url)
        assert result.returncode == 0, result.stderr
        yield url


@pytest.fixture
def real_db(pg_url, monkeypatch):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    engine = create_async_engine(pg_url, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def _get_db():
        async with factory() as session:
            yield session

    app.dependency_overrides[get_db] = _get_db
    yield factory
    app.dependency_overrides.pop(get_db, None)
    asyncio.run(engine.dispose())


async def _make_two_super_admins(
    factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str, str]:
    async with factory() as db:
        role = (
            await db.execute(select(Role).where(Role.name == RoleName.SUPER_ADMIN.value))
        ).scalar_one()
        for other in (await db.execute(select(User))).scalars():
            other.is_active = False  # retire earlier rounds' admins
        tag = uuid.uuid4().hex[:8]
        a = User(email=f"a-{tag}@example.com", full_name="A", is_active=True, hub_scope_all=True)
        b = User(email=f"b-{tag}@example.com", full_name="B", is_active=True, hub_scope_all=True)
        db.add_all([a, b])
        await db.flush()
        db.add_all(
            [UserRole(user_id=a.id, role_id=role.id), UserRole(user_id=b.id, role_id=role.id)]
        )
        await db.commit()
        return a.email, str(a.id), b.email, str(b.id)


async def _active_super_admins(factory: async_sessionmaker[AsyncSession]) -> int:
    async with factory() as db:
        rows = await db.execute(
            select(User.id)
            .join(UserRole, UserRole.user_id == User.id)
            .join(Role, Role.id == UserRole.role_id)
            .where(Role.name == RoleName.SUPER_ADMIN.value, User.is_active.is_(True))
        )
        return len(rows.all())


def _patch_in_thread(barrier, results, idx, actor_email, target_id, body):
    async def _go():
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            barrier.wait()
            r = await c.patch(
                f"/users/{target_id}", json=body, headers={"X-Dev-User-Email": actor_email}
            )
            results[idx] = r.status_code

    asyncio.run(_go())


@pytest.mark.parametrize("body", VARIANTS, ids=["roles-empty", "roles-pm", "deactivate"])
def test_concurrent_mutual_demotion_never_leaves_zero_super_admins(real_db, body):
    outcomes = []
    for _ in range(ROUNDS):
        a_email, a_id, b_email, b_id = asyncio.run(_make_two_super_admins(real_db))
        barrier = threading.Barrier(2)
        results: list[int | None] = [None, None]
        threads = [
            threading.Thread(
                target=_patch_in_thread, args=(barrier, results, 0, a_email, b_id, body)
            ),
            threading.Thread(
                target=_patch_in_thread, args=(barrier, results, 1, b_email, a_id, body)
            ),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        remaining = asyncio.run(_active_super_admins(real_db))
        outcomes.append((tuple(results), remaining))
        assert remaining >= 1, f"zero Super Admins left: {outcomes}"
        assert set(results) <= {200, 409}, f"unexpected status: {outcomes}"
        assert sorted(results) == [200, 409], f"exactly one demotion must win: {outcomes}"
