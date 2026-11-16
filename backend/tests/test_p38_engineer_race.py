"""P38-T04: migration round-trip and the lock tests (R38-5), on their own
Postgres container.

The shared `db_session` fixture never commits, so a second connection cannot
see (or lock) its rows. These tests therefore run against a throwaway
container where the data is really committed and every request gets its own
session, and a second raw connection plays the other writer:

- migration `p38a_engineer_deactivation` up / down / up (from `p40a_step_pins`);
- lock timeout: an engineer row held `FOR UPDATE` elsewhere → deactivate and
  a leader PATCH naming the engineer both answer 503 `ENGINEER_STATUS_BUSY`
  and write nothing;
- deactivation first: a leader PATCH naming the engineer waits on its
  `FOR SHARE`, then sees the engineer inactive → 422 `LEADER_INACTIVE`;
- leader PATCH first: the deactivation waits on its `FOR UPDATE`, then finds
  the new project in the open set → 409 `LED_PROJECTS_CHANGED`.

Each test uses its own hub name (hubs are unique and the data is committed).
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from types import SimpleNamespace

import asyncpg  # type: ignore[import-untyped]
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

import api.routers.engineers as engineers_router
import services.engineer_status as engineer_status
import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.engineer import Engineer
from models.enums import EngineerAllowedCategory, HubName, LabRegion, ProjectCategory, RoleName
from models.project import Project
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.conftest import run_alembic
from tests.factories import make_engineer, make_hub, make_project, make_user
from workers.schedule_tasks import run_greedy_schedule

_BEFORE = "p40a_step_pins"
_REV = "p38a_engineer_deactivation"


def _dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


@pytest.fixture(scope="module")
def race_db_url() -> str:  # type: ignore[misc]
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        yield pg.get_connection_url()


async def _tables(url: str) -> set[str]:
    conn = await asyncpg.connect(_dsn(url))
    try:
        rows = await conn.fetch(
            "SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1::text[])",
            ["engineer_inactive_periods", "project_leader_history"],
        )
        cols = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'engineers' AND column_name = 'active'"
        )
    finally:
        await conn.close()
    return {r["table_name"] for r in rows} | {f"engineers.{r['column_name']}" for r in cols}


@pytest.fixture(scope="module")
def migrated(race_db_url: str) -> str:
    """Up / down / up, then at head for the lock tests."""

    r = run_alembic(["upgrade", _BEFORE], race_db_url)
    assert r.returncode == 0, r.stderr
    assert asyncio.run(_tables(race_db_url)) == set()
    r = run_alembic(["upgrade", _REV], race_db_url)
    assert r.returncode == 0, r.stderr
    assert asyncio.run(_tables(race_db_url)) == {
        "engineer_inactive_periods",
        "project_leader_history",
        "engineers.active",
    }
    r = run_alembic(["downgrade", _BEFORE], race_db_url)
    assert r.returncode == 0, r.stderr
    assert asyncio.run(_tables(race_db_url)) == set()
    r = run_alembic(["upgrade", "head"], race_db_url)
    assert r.returncode == 0, r.stderr
    return race_db_url


def test_migration_round_trip_backfills_active(migrated: str) -> None:
    async def go() -> None:
        conn = await asyncpg.connect(_dsn(migrated))
        try:
            hub = uuid.uuid4()
            await conn.execute(
                "INSERT INTO hubs (id, name, lab_region, is_oem) "
                "VALUES ($1, 'OEM-Seitek', 'Romania', true)",
                hub,
            )
            eid = uuid.uuid4()
            await conn.execute(
                "INSERT INTO engineers (id, name, hub_id, fte, allowed_categories) "
                "VALUES ($1, 'Plain', $2, 1.0, '{}')",
                eid,
                hub,
            )
            row = await conn.fetchrow(
                "SELECT active, deactivated_week, deactivation_reason FROM engineers WHERE id = $1",
                eid,
            )
            assert tuple(row) == (True, None, None)
            await conn.execute("DELETE FROM engineers WHERE id = $1", eid)
            await conn.execute("DELETE FROM hubs WHERE id = $1", hub)
        finally:
            await conn.close()

    asyncio.run(go())


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    calls: list[object] = []
    monkeypatch.setattr(
        run_greedy_schedule,
        "delay",
        lambda *a, **k: calls.append(a) or SimpleNamespace(id=f"task-{len(calls)}"),
    )
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    engineers_router.ENGINEER_STATUS_RATE_LIMIT.reset()
    engineers_router.DEACTIVATION_PREVIEW_RATE_LIMIT.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _world(migrated: str, hub_name: HubName) -> tuple[SimpleNamespace, object]:
    engine = create_async_engine(migrated)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        hub = await make_hub(s, name=hub_name, lab_region=LabRegion.GREECE)
        c = [EngineerAllowedCategory.C]
        target = await make_engineer(s, hub, name="Target", allowed_categories=c)
        other = await make_engineer(s, hub, name="Other", allowed_categories=c)
        led = await make_project(s, hub, leader=target, name="Led", category=ProjectCategory.C)
        free = await make_project(s, hub, leader=other, name="Free", category=ProjectCategory.C)
        user = await make_user(s, RoleName.ADMIN, hub_scope_all=True)
        await s.commit()
        w = SimpleNamespace(
            hub=hub.id,
            target=target.id,
            other=other.id,
            led=led.id,
            free=free.id,
            user=user.id,
            email=user.email,
        )

    async def _get_db() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_db] = _get_db
    override_current_principal(make_principal(RoleName.ADMIN, user_id=w.user, email=w.email))
    return w, engine


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _scalar(engine, stmt):
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        return (await s.execute(stmt)).scalar_one()


async def test_lock_timeout_is_503_engineer_status_busy(migrated, monkeypatch):
    monkeypatch.setattr(engineer_status, "ENGINEER_STATUS_LOCK_TIMEOUT", "200ms")
    w, engine = await _world(migrated, HubName.RD_GREECE)
    try:
        async with _client() as client:
            token = (await client.get(f"/engineers/{w.target}/deactivation-preview")).json()[
                "led_projects_token"
            ]
            async with engine.connect() as conn:
                trans = await conn.begin()
                await conn.execute(
                    select(Engineer.id).where(Engineer.id == w.target).with_for_update()
                )
                deactivate = await client.post(
                    f"/engineers/{w.target}/deactivate",
                    json={
                        "reason": "other",
                        "led_projects_token": token,
                        "reassignments": [
                            {"project_id": str(w.led), "leader_engineer_id": str(w.other)}
                        ],
                    },
                )
                patch = await client.patch(
                    f"/projects/{w.free}", json={"leader_engineer_id": str(w.target)}
                )
                await trans.rollback()
        for resp in (deactivate, patch):
            assert resp.status_code == 503, resp.text
            assert resp.json()["code"] == "ENGINEER_STATUS_BUSY"
            assert resp.headers["Retry-After"] == "5"
        assert await _scalar(engine, select(Engineer.active).where(Engineer.id == w.target))
        assert (
            await _scalar(engine, select(Project.leader_engineer_id).where(Project.id == w.free))
            == w.other
        )
    finally:
        await engine.dispose()


async def test_deactivate_first_then_leader_patch_gets_leader_inactive(migrated):
    w, engine = await _world(migrated, HubName.PD_INDIA)
    try:
        async with engine.connect() as conn:
            trans = await conn.begin()
            # The other writer: a deactivation in progress (engineer row FOR
            # UPDATE, open project reassigned, period opened), not committed.
            await conn.execute(select(Engineer.id).where(Engineer.id == w.target).with_for_update())
            await conn.execute(
                text("UPDATE projects SET leader_engineer_id = :l WHERE id = :p"),
                {"l": w.other, "p": w.led},
            )
            await conn.execute(
                text(
                    "INSERT INTO engineer_inactive_periods (id, engineer_id, from_plan_year, "
                    "from_week) VALUES (:id, :e, 2026, 31)"
                ),
                {"id": uuid.uuid4(), "e": w.target},
            )
            await conn.execute(
                text(
                    "UPDATE engineers SET active = false, deactivated_at = now(), "
                    "deactivated_week = 31, deactivated_plan_year = 2026, "
                    "deactivation_reason = 'other' WHERE id = :e"
                ),
                {"e": w.target},
            )
            async with _client() as client:
                patch_task = asyncio.create_task(
                    client.patch(f"/projects/{w.free}", json={"leader_engineer_id": str(w.target)})
                )
                await asyncio.sleep(0.5)
                assert not patch_task.done()  # waiting on FOR SHARE
                await trans.commit()
                patch = await patch_task
        assert patch.status_code == 422, patch.text
        assert patch.json()["code"] == "LEADER_INACTIVE"
        assert (
            await _scalar(engine, select(Project.leader_engineer_id).where(Project.id == w.free))
            == w.other
        )
    finally:
        await engine.dispose()


async def test_leader_patch_first_then_deactivate_gets_led_projects_changed(migrated):
    w, engine = await _world(migrated, HubName.PD_ROMANIA)
    try:
        async with _client() as client:
            token = (await client.get(f"/engineers/{w.target}/deactivation-preview")).json()[
                "led_projects_token"
            ]
            async with engine.connect() as conn:
                trans = await conn.begin()
                # The other writer: a leader PATCH naming the engineer, holding
                # its FOR SHARE and the new project row, not yet committed.
                await conn.execute(
                    select(Engineer.id).where(Engineer.id == w.target).with_for_update(read=True)
                )
                await conn.execute(
                    text("UPDATE projects SET leader_engineer_id = :l WHERE id = :p"),
                    {"l": w.target, "p": w.free},
                )
                task = asyncio.create_task(
                    client.post(
                        f"/engineers/{w.target}/deactivate",
                        json={
                            "reason": "other",
                            "led_projects_token": token,
                            "reassignments": [
                                {"project_id": str(w.led), "leader_engineer_id": str(w.other)}
                            ],
                        },
                    )
                )
                await asyncio.sleep(0.5)
                assert not task.done()  # waiting on FOR UPDATE
                await trans.commit()
                resp = await task
        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "LED_PROJECTS_CHANGED"
        fresh = {r["project_id"] for r in resp.json()["detail"]["open_projects"]}
        assert fresh == {str(w.led), str(w.free)}
        assert await _scalar(engine, select(Engineer.active).where(Engineer.id == w.target))
    finally:
        await engine.dispose()
