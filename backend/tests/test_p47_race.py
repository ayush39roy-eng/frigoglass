"""P47-T02 (ADR 0059 C1): the `base` check runs under the row lock.

The shared `db_session` fixture never commits, so a second connection cannot
race it. These tests run on a throwaway container where the data is really
committed, every request gets its own session, and a raw connection plays the
first writer (Alice): it locks the project row `FOR UPDATE`, writes and
audits, and commits only after Bob's request has started.

- same field: Bob's PATCH waits on the lock, then reads Alice's value and
  answers 409 `EDIT_CONFLICT` naming her; Alice's value stays;
- different field: Bob's PATCH waits, then succeeds; both values are kept.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from testcontainers.postgres import PostgresContainer

import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, ProjectCategory, RoleName
from models.project import Project
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.conftest import run_alembic
from tests.factories import make_engineer, make_hub, make_project, make_user
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(scope="module")
def race_db_url() -> Iterator[str]:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        result = run_alembic(["upgrade", "head"], url)
        assert result.returncode == 0, result.stderr
        yield url


@pytest.fixture(autouse=True)
def _reset(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(
        run_greedy_schedule, "delay", lambda *a, **k: SimpleNamespace(id="task-1")
    )
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _world(url: str, hub_name: HubName) -> tuple[SimpleNamespace, AsyncEngine]:
    engine = create_async_engine(url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        hub = await make_hub(s, name=hub_name, lab_region=LabRegion.GREECE)
        leader = await make_engineer(s, hub, name=f"Lead {hub_name.value}")
        project = await make_project(
            s, hub, leader=leader, name=f"Race {hub_name.value}",
            category=ProjectCategory.B, actual_start_week=20, delay_weeks=0,
        )
        alice = await make_user(s, RoleName.ADMIN, full_name="Alice Writer", hub_scope_all=True)
        bob = await make_user(s, RoleName.ADMIN, full_name="Bob Writer", hub_scope_all=True)
        await s.commit()
        w = SimpleNamespace(
            hub=hub.id, project=project.id, alice=alice.id, bob=bob.id, bob_email=bob.email
        )

    async def _get_db() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_db] = _get_db
    override_current_principal(
        make_principal(RoleName.ADMIN, user_id=w.bob, email=w.bob_email, hub_scope_all=True)
    )
    return w, engine


async def _alice_writes(conn: Any, w: SimpleNamespace, field: str, old: int, new: int) -> None:
    await conn.execute(select(Project.id).where(Project.id == w.project).with_for_update())
    await conn.execute(update(Project).where(Project.id == w.project).values({field: new}))
    await conn.execute(
        insert(AuditLogEntry).values(
            id=uuid.uuid4(),
            actor_user_id=w.alice,
            action="project.update",
            entity_type="Project",
            entity_id=str(w.project),
            hub_id=w.hub,
            before_state={field: old},
            after_state={field: new},
        )
    )


async def _stored(engine: AsyncEngine, w: SimpleNamespace) -> tuple[int, int]:
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        row = (
            await s.execute(
                select(Project.actual_start_week, Project.delay_weeks).where(
                    Project.id == w.project
                )
            )
        ).one()
        return row[0], row[1]


async def test_same_field_waits_for_the_lock_then_conflicts(race_db_url: str) -> None:
    w, engine = await _world(race_db_url, HubName.RD_GREECE)
    try:
        async with engine.connect() as conn:
            trans = await conn.begin()
            await _alice_writes(conn, w, "actual_start_week", 20, 22)
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                bob = asyncio.create_task(
                    c.patch(
                        f"/projects/{w.project}",
                        json={"actual_start_week": 25, "base": {"actual_start_week": 20}},
                    )
                )
                await asyncio.sleep(0.5)
                assert not bob.done(), "Bob's PATCH must wait on Alice's row lock"
                await trans.commit()
                resp = await asyncio.wait_for(bob, timeout=10)
        assert resp.status_code == 409, resp.text
        (conflict,) = resp.json()["conflicts"]
        assert (conflict["your_value"], conflict["current_value"]) == (25, 22)
        assert conflict["changed_by"] == "Alice Writer"
        assert await _stored(engine, w) == (22, 0)
    finally:
        await engine.dispose()


async def test_different_field_waits_then_both_values_are_kept(race_db_url: str) -> None:
    w, engine = await _world(race_db_url, HubName.PD_INDIA)
    try:
        async with engine.connect() as conn:
            trans = await conn.begin()
            await _alice_writes(conn, w, "delay_weeks", 0, 3)
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                bob = asyncio.create_task(
                    c.patch(
                        f"/projects/{w.project}",
                        json={"actual_start_week": 25, "base": {"actual_start_week": 20,
                                                                "delay_weeks": 0}},
                    )
                )
                await asyncio.sleep(0.5)
                assert not bob.done()
                await trans.commit()
                resp = await asyncio.wait_for(bob, timeout=10)
        assert resp.status_code == 200, resp.text
        assert await _stored(engine, w) == (25, 3)
    finally:
        await engine.dispose()
