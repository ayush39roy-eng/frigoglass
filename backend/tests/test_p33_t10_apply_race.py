"""P33-T10 race: the R33-10 project row lock, with committed data and real
concurrent connections (DOMAIN_RULES "Category templates" §C: "after locking
the category's project rows FOR UPDATE in project_id order. The stage PATCH
and check-ins take the same lock.").

The shared test DB is savepoint-isolated: nothing is committed, so a second
connection cannot see a test's rows and no lock can be contended. This
module therefore creates its own database in the shared Postgres container
(`alembic upgrade head`), commits its rows, and drops the database at the
end. Each test holds the lock on one connection and drives the endpoint on
another:

1. a stage write holds the project row (as an in-flight stage PATCH does)
   and starts H; the apply waits on it, then evaluates under the lock, sees
   H reached and reports the ticked project in `not_applied`;
2. the apply's lock held: a stage PATCH waits until it is released;
3. the same for a check-in;
4. (orchestrator ruling on the apply's `FOR NO KEY UPDATE`) a registration
   or a category change started during an apply waits on the category's
   `FOR SHARE` and then copies the NEW template (OR-5).
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Iterator
from types import SimpleNamespace
from typing import Any

import asyncpg  # type: ignore[import-untyped]
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from api.db import get_db
from api.main import app
from models.engineer import Engineer
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    RoleName,
    WorkflowStepStatus,
)
from models.hub import Hub
from models.project import Project
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime
from services.project_steps import sync_project_steps
from services.template_apply import lock_projects
from services.template_editor import load_categories
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.conftest import run_alembic
from tests.factories import make_engineer, make_hub, make_project, make_user, registration_body

RACE_DB = f"p33_t10_race_{uuid.uuid4().hex[:8]}"
#: How long a request must stay blocked to count as "waiting on the lock".
BLOCKED_FOR = 0.6


def _asyncpg_dsn(url: str) -> str:
    return make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)


@pytest.fixture(scope="module")
def race_db_url(database_url: str, _apply_migrations: None) -> Iterator[str]:
    admin = _asyncpg_dsn(database_url)

    async def _sql(statement: str) -> None:
        conn = await asyncpg.connect(admin)
        try:
            await conn.execute(statement)
        finally:
            await conn.close()

    # A fixed identifier built here (letters, digits, underscore): no input
    # reaches this DDL.
    asyncio.run(_sql(f'CREATE DATABASE "{RACE_DB}"'))
    url = make_url(database_url).set(database=RACE_DB).render_as_string(hide_password=False)
    result = run_alembic(["upgrade", "head"], url)
    assert result.returncode == 0, result.stderr
    try:
        yield url
    finally:
        asyncio.run(_sql(f'DROP DATABASE IF EXISTS "{RACE_DB}" WITH (FORCE)'))


@pytest_asyncio.fixture
async def world(race_db_url: str) -> AsyncIterator[SimpleNamespace]:
    engine = create_async_engine(race_db_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async with sessions() as db:
        # Committed, so the hub is shared by the module's tests (unique name).
        hub = (
            await db.execute(select(Hub).where(Hub.name == HubName.RD_GREECE))
        ).scalar_one_or_none() or await make_hub(
            db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE
        )
        lead = await make_engineer(
            db, hub, name="Lead", allowed_categories=[EngineerAllowedCategory.B]
        )
        project = await make_project(
            db, hub, leader=lead, name=f"Race {uuid.uuid4().hex[:6]}",
            category=ProjectCategory.B, status=ProjectStatus.IN_DEVELOPMENT,
        )  # fmt: skip
        await sync_project_steps(db, project, False)
        e_row = (
            await db.execute(
                select(ProjectWorkflowStep).where(
                    ProjectWorkflowStep.project_id == project.id,
                    ProjectWorkflowStep.step_template_id == "PDD-E",
                )
            )
        ).scalar_one()
        e_row.status, e_row.percent_complete, e_row.actual_start_week = (
            WorkflowStepStatus.IN_PROGRESS, 50, 28,
        )  # fmt: skip
        user = await make_user(db, RoleName.ADMIN, hub_scope_all=True)
        await db.commit()
        project_id, user_id, email = project.id, user.id, user.email
        hub_id, lead_id = hub.id, lead.id

    async def _get_db() -> AsyncIterator[AsyncSession]:
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_db] = _get_db
    override_current_principal(
        make_principal(RoleName.ADMIN, user_id=user_id, email=email, hub_scope_all=True)
    )
    try:
        yield SimpleNamespace(
            engine=engine,
            sessions=sessions,
            project_id=project_id,
            hub_id=hub_id,
            lead_id=lead_id,
        )
    finally:
        clear_current_principal_override()
        app.dependency_overrides.pop(get_db, None)
        await engine.dispose()


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _template_version(w: SimpleNamespace) -> int:
    async with w.sessions() as db:
        from models.category import Category

        return int(
            (
                await db.execute(select(Category.template_version).where(Category.code == "B"))
            ).scalar_one()
        )


async def _blocked_then_released(
    task: asyncio.Task[Any], holder: AsyncSession, *, commit: bool
) -> Any:
    await asyncio.sleep(BLOCKED_FOR)
    assert not task.done(), "the request did not wait on the project row lock"
    if commit:
        await holder.commit()
    else:
        await holder.rollback()
    return await asyncio.wait_for(task, timeout=30)


async def test_apply_waits_on_a_stage_write_and_evaluates_under_the_lock(
    world: SimpleNamespace,
) -> None:
    """Race 1: the project reaches H while the apply waits; the ticked project
    is reported in `not_applied`, and nothing is written to it."""

    gap_only = {
        "changes": [{"workflow_id": "PDD", "category": "B",
                     "base_version": await _template_version(world),
                     "steps": [{"step_id": "PDD-H", "gap_weeks": 2}]}],
        "selection": {"mode": "selected", "project_ids": [str(world.project_id)]},
    }  # fmt: skip
    async with world.sessions() as holder:
        await lock_projects(holder, [world.project_id])  # an in-flight stage PATCH
        await holder.execute(
            update(ProjectWorkflowStep)
            .where(
                ProjectWorkflowStep.project_id == world.project_id,
                ProjectWorkflowStep.step_template_id == "PDD-H",
            )
            .values(status=WorkflowStepStatus.IN_PROGRESS, percent_complete=1,
                    actual_start_week=31)
        )  # fmt: skip
        async with _client() as client:
            task = asyncio.create_task(client.post("/workflow-templates/apply", json=gap_only))
            resp = await _blocked_then_released(task, holder, commit=True)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["not_applied"] == [{"project_id": str(world.project_id), "reason": "reached_stage"}]
    assert out["applied"]["selected"] == 0 and out["recalc_status"] == "not_needed"
    async with world.sessions() as db:
        h = (
            await db.execute(
                select(ProjectWorkflowStep).where(
                    ProjectWorkflowStep.project_id == world.project_id,
                    ProjectWorkflowStep.step_template_id == "PDD-H",
                )
            )
        ).scalar_one()
    assert (h.plan_gap_weeks, h.template_change_id) == (0, None)


async def _hold_and_freeze(holder: AsyncSession, project_id: uuid.UUID) -> None:
    """Take the R33-10 lock (as an apply does) and change the project inside
    that transaction (freeze it). A path that takes the same lock before it
    reads anything sees the committed change; one that reads first and only
    blocks later (on its own write of the project row) acts on stale state."""

    await lock_projects(holder, [project_id])
    await holder.execute(
        update(Project).where(Project.id == project_id).values(frozen=True, actual_start_week=20)
    )


async def test_stage_patch_waits_on_the_lock_before_reading(world: SimpleNamespace) -> None:
    async with world.sessions() as holder:
        await _hold_and_freeze(holder, world.project_id)
        async with _client() as client:
            task = asyncio.create_task(
                client.patch(
                    f"/projects/{world.project_id}/stages/PDD-E", json={"percent_complete": 60}
                )
            )
            resp = await _blocked_then_released(task, holder, commit=True)
    # Read after the lock: the project is frozen now (a PATCH that had read
    # first would have saved the progress: 200).
    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "PROJECT_FROZEN"


async def test_check_in_waits_on_the_lock_before_reading(world: SimpleNamespace) -> None:
    entry = {"project_id": str(world.project_id), "step_id": "PDD-E",
             "status": "In Progress", "percent_complete": 70}  # fmt: skip
    async with world.sessions() as holder:
        await _hold_and_freeze(holder, world.project_id)
        async with _client() as client:
            task = asyncio.create_task(client.post("/check-ins", json={"entries": [entry]}))
            resp = await _blocked_then_released(task, holder, commit=True)
    assert resp.status_code == 422, resp.text
    errors = resp.json()["detail"]["errors"]
    assert [e["code"] for e in errors] == ["PROJECT_FROZEN"]


async def _apply_in_flight(holder: AsyncSession, weeks: int) -> None:
    """What an apply holds until it commits: the category row `FOR NO KEY
    UPDATE` and the template already rewritten (B / PDD-E)."""

    await load_categories(holder, ["B"], lock=True)
    await holder.execute(
        update(WorkflowLeadTime)
        .where(
            WorkflowLeadTime.workflow_id == "PDD",
            WorkflowLeadTime.category == "B",
            WorkflowLeadTime.step_id == "PDD-E",
        )
        .values(weeks=weeks)
    )


async def _plan_weeks(w: SimpleNamespace, project_id: Any, step_id: str) -> int:
    async with w.sessions() as db:
        return int(
            (
                await db.execute(
                    select(ProjectWorkflowStep.plan_weeks).where(
                        ProjectWorkflowStep.project_id == project_id,
                        ProjectWorkflowStep.step_template_id == step_id,
                    )
                )
            ).scalar_one()
        )


async def _current_e_weeks(w: SimpleNamespace) -> int:
    async with w.sessions() as db:
        return int(
            (
                await db.execute(
                    select(WorkflowLeadTime.weeks).where(
                        WorkflowLeadTime.workflow_id == "PDD",
                        WorkflowLeadTime.category == "B",
                        WorkflowLeadTime.step_id == "PDD-E",
                    )
                )
            ).scalar_one()
        )


async def test_registration_during_an_apply_copies_the_new_template(world: SimpleNamespace) -> None:
    new_weeks = await _current_e_weeks(world) + 3
    async with world.sessions() as db:
        hub = await db.get(Hub, world.hub_id)
        lead = await db.get(Engineer, world.lead_id)
        assert hub is not None and lead is not None
        body = registration_body(
            hub, lead, name=f"Registered during apply {uuid.uuid4().hex[:6]}", category="B"
        )
    async with world.sessions() as holder:
        await _apply_in_flight(holder, new_weeks)
        async with _client() as client:
            task = asyncio.create_task(client.post("/projects", json=body))
            resp = await _blocked_then_released(task, holder, commit=True)
    assert resp.status_code == 201, resp.text
    assert await _plan_weeks(world, resp.json()["id"], "PDD-E") == new_weeks


async def test_category_change_during_an_apply_copies_the_new_template(
    world: SimpleNamespace,
) -> None:
    new_weeks = await _current_e_weeks(world) + 3
    async with world.sessions() as db:
        hub = await db.get(Hub, world.hub_id)
        assert hub is not None
        moved = await make_project(
            db, hub, name=f"Moves to B {uuid.uuid4().hex[:6]}", category=ProjectCategory.A,
            status=ProjectStatus.IN_QUEUE,
        )  # fmt: skip
        await sync_project_steps(db, moved, False)
        await db.commit()
        moved_id = moved.id
    async with world.sessions() as holder:
        await _apply_in_flight(holder, new_weeks)
        async with _client() as client:
            task = asyncio.create_task(
                client.patch(f"/projects/{moved_id}", json={"category": "B"})
            )
            resp = await _blocked_then_released(task, holder, commit=True)
    assert resp.status_code == 200, resp.text
    assert await _plan_weeks(world, moved_id, "PDD-E") == new_weeks


async def test_category_change_takes_the_category_before_the_project_row(
    world: SimpleNamespace,
) -> None:
    """Lock order (contract E3 ruling): `PATCH /projects/{id}` takes the
    target category `FOR SHARE` before any project-row lock. An apply over
    both categories holds them `FOR NO KEY UPDATE` and then locks the moving
    project's row: it must get that row at once (the PATCH is waiting on the
    category without holding the row). Had the PATCH locked the row first,
    this would deadlock."""

    new_weeks = await _current_e_weeks(world) + 3
    async with world.sessions() as db:
        hub = await db.get(Hub, world.hub_id)
        assert hub is not None
        moved = await make_project(
            db, hub, name=f"Ordering {uuid.uuid4().hex[:6]}", category=ProjectCategory.A,
            status=ProjectStatus.IN_QUEUE,
        )  # fmt: skip
        await sync_project_steps(db, moved, False)
        await db.commit()
        moved_id = moved.id
    async with world.sessions() as holder:
        await load_categories(holder, ["A", "B"], lock=True)  # the apply's step 1
        await _apply_in_flight(holder, new_weeks)
        async with _client() as client:
            task = asyncio.create_task(
                client.patch(f"/projects/{moved_id}", json={"category": "B"})
            )
            await asyncio.sleep(BLOCKED_FOR)
            assert not task.done()
            # The apply's step 2: the projects of its categories, in id order.
            await asyncio.wait_for(lock_projects(holder, [moved_id]), timeout=5)
            await holder.commit()
            resp = await asyncio.wait_for(task, timeout=30)
    assert resp.status_code == 200, resp.text
    assert await _plan_weeks(world, moved_id, "PDD-E") == new_weeks


async def test_figure_cleared_during_an_apply_copies_the_new_template(
    world: SimpleNamespace,
) -> None:
    """OR-5 "figure cleared": the PATCH that clears a project's design figure
    re-copies the template onto its not-reached design steps. Started during
    an apply it waits on the category's FOR SHARE (taken before the project
    row) and copies the apply's new template."""

    new_weeks = await _current_e_weeks(world) + 3
    async with world.sessions() as db:
        hub = await db.get(Hub, world.hub_id)
        assert hub is not None
        project = await make_project(
            db, hub, name=f"Own figure {uuid.uuid4().hex[:6]}", category=ProjectCategory.B,
            status=ProjectStatus.IN_QUEUE,
        )  # fmt: skip
        await sync_project_steps(db, project, False)
        await db.commit()
        project_id = project.id
    async with _client() as client:
        resp = await client.patch(f"/projects/{project_id}", json={"design_effort_weeks": 4})
        assert resp.status_code == 200, resp.text
    async with world.sessions() as holder:
        await _apply_in_flight(holder, new_weeks)
        async with _client() as client:
            task = asyncio.create_task(
                client.patch(f"/projects/{project_id}", json={"design_effort_weeks": None})
            )
            resp = await _blocked_then_released(task, holder, commit=True)
    assert resp.status_code == 200, resp.text
    assert await _plan_weeks(world, project_id, "PDD-E") == new_weeks
