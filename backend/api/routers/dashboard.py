"""Global RPD Dashboard surface — read models only (`docs/PROJECT_AND_STACK.md`
§2). No mutations in this router.

**RBAC (P3-T02)**: every endpoint requires a validated OIDC token (401) and
`DASHBOARD`/`READ` (Portfolio Manager, Hub Planner, Executive Viewer, Admin —
Engineer/Auditor get 403).

**Hub-scoped (P3-T03)**: every endpoint below is filtered to the caller's
own hub(s) via `services.hub_scope` unless `current_user.hub_scope_all` —
per `docs/PROJECT_AND_STACK.md` §5, only Hub Planner carries the "(own hub)"
qualifier on Dashboard; Portfolio Manager/Executive Viewer/Admin are
unrestricted (`hub_scope_all=True`) and continue to see portfolio-wide
totals unchanged.

Per Invariant I9 ("`within_year` count on the Dashboard equals the count of
projects satisfying the within-year rule in the current schedule run. No
independent calculation anywhere"): `completing_within_year` below is the only
endpoint in this file whose numbers come from a `ScheduleRun` snapshot table
(`ScheduleRunProjectOutcome`) — it does not recompute the within-year rule.
Every other endpoint here (pipeline totals, status overview, hub×type
summary, filtered project list) is portfolio-*composition* data straight off
the live `Project` table, not a scheduling outcome, so I9 does not apply to
them.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.enums import ProjectCategory, ProjectPriority, ProjectStatus
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome
from schemas.dashboard import (
    CompletingWithinYear,
    CompletingWithinYearRow,
    HubTypePipelineRow,
    PipelineTotals,
    ProjectFilterResult,
    ProjectFilterRow,
    StatusOverview,
)
from services.hub_scope import hub_scope_filter

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

_read = require_permission(Surface.DASHBOARD, Action.READ)

_FOUR_SCHEDULABLE_STATUSES = (
    ProjectStatus.IN_BUYOFF,
    ProjectStatus.UNDER_INDUSTRIALIZATION,
    ProjectStatus.IN_DEVELOPMENT,
    ProjectStatus.IN_QUEUE,
)


@router.get("/pipeline-totals", response_model=PipelineTotals)
async def pipeline_totals(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PipelineTotals:
    """See `schemas.dashboard.PipelineTotals`'s docstring for the
    spillover/new interpretation. Scope: all projects except Commercialized,
    hub-scoped (P3-T03) to the caller's own hub(s) unless `hub_scope_all`.
    """

    base = select(Project).where(Project.status != ProjectStatus.COMMERCIALIZED)
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        base = base.where(hub_filter)
    spillover_count = (
        await db.execute(
            select(func.count()).select_from(
                base.where(Project.carry_over.is_(True)).subquery()
            )
        )
    ).scalar_one()
    new_count = (
        await db.execute(
            select(func.count()).select_from(base.where(Project.carry_over.is_(False)).subquery())
        )
    ).scalar_one()
    return PipelineTotals(
        spillover_count=spillover_count,
        new_count=new_count,
        total_count=spillover_count + new_count,
    )


@router.get("/status-overview", response_model=StatusOverview)
async def status_overview(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> StatusOverview:
    stmt = select(Project.status, func.count())
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = await db.execute(stmt.group_by(Project.status))
    counts_by_status = {row[0]: row[1] for row in result.all()}
    other_counts = {
        status.value: count
        for status, count in counts_by_status.items()
        if status not in _FOUR_SCHEDULABLE_STATUSES
    }
    return StatusOverview(
        in_buyoff=counts_by_status.get(ProjectStatus.IN_BUYOFF, 0),
        under_industrialization=counts_by_status.get(ProjectStatus.UNDER_INDUSTRIALIZATION, 0),
        in_development=counts_by_status.get(ProjectStatus.IN_DEVELOPMENT, 0),
        in_queue=counts_by_status.get(ProjectStatus.IN_QUEUE, 0),
        other_counts=other_counts,
    )


@router.get("/hub-type-pipeline", response_model=list[HubTypePipelineRow])
async def hub_type_pipeline(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[HubTypePipelineRow]:
    """Hub × type cross-tab, scope: all projects except Commercialized (same
    "pipeline" scope as `pipeline_totals` above), hub-scoped (P3-T03) — a
    Hub Planner's cross-tab naturally only shows rows for their own hub(s),
    since the query is driven off `Project.hub_id`.
    """

    stmt = (
        select(Hub.name, Project.type, func.count())
        .join(Project, Project.hub_id == Hub.id)
        .where(Project.status != ProjectStatus.COMMERCIALIZED)
    )
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = await db.execute(
        stmt.group_by(Hub.name, Project.type)
        .order_by(Hub.name)
    )
    return [
        HubTypePipelineRow(hub=hub_name, type=project_type, count=count)
        for hub_name, project_type, count in result.all()
    ]


@router.get("/completing-within-year", response_model=CompletingWithinYear)
async def completing_within_year(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> CompletingWithinYear:
    """Invariant I9: sourced ENTIRELY from the active `ScheduleRun`'s
    `ScheduleRunProjectOutcome` snapshot rows. If no `ScheduleRun` is active
    yet, returns a zeroed, `has_active_schedule_run=False` response rather
    than a 404 or a recomputed guess — the Dashboard surface must be able to
    render "no schedule computed yet" as a normal state.
    """

    active_run = (
        await db.execute(select(ScheduleRun).where(ScheduleRun.is_active.is_(True)))
    ).scalar_one_or_none()
    if active_run is None:
        return CompletingWithinYear(
            has_active_schedule_run=False,
            schedule_run_version=None,
            within_year_count=0,
            spillover_count=0,
            left_out_count=0,
            rows=[],
        )

    stmt = (
        select(ScheduleRunProjectOutcome, Project)
        .join(Project, ScheduleRunProjectOutcome.project_id == Project.id)
        .options(selectinload(Project.hub))
        .where(ScheduleRunProjectOutcome.schedule_run_id == active_run.id)
    )
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = await db.execute(stmt)
    rows: list[CompletingWithinYearRow] = []
    within_year_count = spillover_count = left_out_count = 0
    for outcome, project in result.all():
        if outcome.within_year:
            within_year_count += 1
        if outcome.spillover:
            spillover_count += 1
        if outcome.left_out:
            left_out_count += 1
        rows.append(
            CompletingWithinYearRow(
                project_id=project.id,
                project_name=project.name,
                hub=project.hub.name,
                category=project.category,
                priority=project.priority,
                within_year=outcome.within_year,
                spillover=outcome.spillover,
                left_out=outcome.left_out,
                cat_not_allowed=outcome.cat_not_allowed,
                last_step_end_week=outcome.last_step_end_week,
            )
        )

    return CompletingWithinYear(
        has_active_schedule_run=True,
        schedule_run_version=active_run.version,
        within_year_count=within_year_count,
        spillover_count=spillover_count,
        left_out_count=left_out_count,
        rows=rows,
    )


@router.get("/projects", response_model=ProjectFilterResult)
async def analytics_projects(
    hub_id: uuid.UUID | None = None,
    category: ProjectCategory | None = None,
    status_: ProjectStatus | None = None,
    priority: ProjectPriority | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> ProjectFilterResult:
    """"An analytics breakdown with filters (by hub, category, status,
    priority)" (`docs/PROJECT_AND_STACK.md` §2), hub-scoped (P3-T03).
    """

    stmt = select(Project).options(selectinload(Project.hub))
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    if hub_id is not None:
        stmt = stmt.where(Project.hub_id == hub_id)
    if category is not None:
        stmt = stmt.where(Project.category == category)
    if status_ is not None:
        stmt = stmt.where(Project.status == status_)
    if priority is not None:
        stmt = stmt.where(Project.priority == priority)

    projects = (await db.execute(stmt.order_by(Project.name))).scalars().all()
    rows = [
        ProjectFilterRow(
            project_id=p.id,
            project_name=p.name,
            hub=p.hub.name,
            category=p.category,
            status=p.status,
            priority=p.priority,
        )
        for p in projects
    ]
    return ProjectFilterResult(total_count=len(rows), rows=rows)
