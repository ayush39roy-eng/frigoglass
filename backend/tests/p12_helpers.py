"""Shared fixtures for the P12-T03 tests (check-ins, tracking, board, VIP).

Builds small worlds on the shared savepoint-isolated test DB: projects with
their 14 live stage rows (`sync_project_steps`, PDD category A lead times
from the migration seed), an active run with planned step windows, and
check-in rows. Nothing here reaches Celery or Redis.
"""

from __future__ import annotations

import uuid

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from models.checkin import StageCheckin
from models.engineer import Engineer
from models.enums import ProjectPriority, ProjectStatus, RoleName, WorkflowStepStatus
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.user import User
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from services.project_steps import sync_project_steps
from tests.auth_helpers import make_principal, override_current_principal
from tests.factories import make_project, make_user

CW = 31


def client_for(db_session: AsyncSession) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def act_as(
    db_session: AsyncSession,
    *roles: RoleName,
    hub_ids: list[uuid.UUID] | None = None,
    hub_scope_all: bool | None = None,
) -> User:
    if hub_scope_all is None:
        hub_scope_all = hub_ids is None and RoleName.ENGINEER not in roles
    user = await make_user(
        db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=hub_scope_all
    )
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=hub_scope_all,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def link_engineer(db_session: AsyncSession, engineer: Engineer, user: User) -> None:
    engineer.user_id = user.id
    await db_session.flush()


async def stepped_project(
    db_session: AsyncSession,
    hub: Hub,
    *,
    name: str,
    leader: Engineer | None = None,
    status: ProjectStatus = ProjectStatus.IN_DEVELOPMENT,
    priority: ProjectPriority | None = ProjectPriority.P2,
    **overrides,
) -> Project:
    project = await make_project(
        db_session,
        hub,
        leader=leader,
        name=name,
        status=status,
        priority=priority,
        schedule_stale=False,
        **overrides,
    )
    await sync_project_steps(db_session, project, hub.is_oem)
    return project


async def live_step(
    db_session: AsyncSession, project: Project, step_id: str
) -> ProjectWorkflowStep:
    return (
        await db_session.execute(
            select(ProjectWorkflowStep).where(
                ProjectWorkflowStep.project_id == project.id,
                ProjectWorkflowStep.step_template_id == step_id,
            )
        )
    ).scalar_one()


async def set_progress(
    db_session: AsyncSession,
    project: Project,
    step_id: str,
    status: WorkflowStepStatus,
    *,
    percent: int,
    start: int | None = None,
    end: int | None = None,
    reason: str | None = None,
    engineer: Engineer | None = None,
) -> ProjectWorkflowStep:
    row = await live_step(db_session, project, step_id)
    row.status = status
    row.percent_complete = percent
    row.actual_start_week = start
    row.actual_end_week = end
    row.blocked_reason = reason
    if engineer is not None:
        row.assigned_engineer_id = engineer.id
    await db_session.flush()
    return row


async def plan_step(
    db_session: AsyncSession,
    run: ScheduleRun,
    project: Project,
    step_id: str,
    start: int,
    end: int,
    *,
    engineer: Engineer | None = None,
    skipped: bool = False,
) -> ScheduleRunProjectStep:
    template = await db_session.get(WorkflowStepTemplate, step_id)
    assert template is not None
    step = ScheduleRunProjectStep(
        schedule_run_id=run.id,
        project_id=project.id,
        step_template_id=step_id,
        sequence_order=template.sequence_order,
        duration_weeks=end - start + 1,
        start_week=start,
        end_week=end,
        assigned_engineer_id=engineer.id if engineer is not None else None,
        skipped=skipped,
    )
    db_session.add(step)
    await db_session.flush()
    return step


async def add_outcome(
    db_session: AsyncSession,
    run: ScheduleRun,
    project: Project,
    *,
    projected: int | None = 44,
    expected: int | None = 46,
    within_year: bool = True,
    left_out: bool = False,
    blocked: bool = False,
) -> ScheduleRunProjectOutcome:
    outcome = ScheduleRunProjectOutcome(
        schedule_run_id=run.id,
        project_id=project.id,
        left_out=left_out,
        within_year=within_year,
        last_step_end_week=projected,
        projected_end_week=projected,
        expected_end_week=expected,
        blocked=blocked,
    )
    db_session.add(outcome)
    await db_session.flush()
    return outcome


async def add_checkin(
    db_session: AsyncSession,
    project: Project,
    step_id: str,
    week: int,
    user: User,
    *,
    status: WorkflowStepStatus = WorkflowStepStatus.IN_PROGRESS,
    percent: int = 10,
    note: str | None = None,
) -> StageCheckin:
    row = StageCheckin(
        project_id=project.id,
        step_template_id=step_id,
        week=week,
        user_id=user.id,
        status=status,
        percent_complete=percent,
        note=note,
    )
    db_session.add(row)
    await db_session.flush()
    return row
