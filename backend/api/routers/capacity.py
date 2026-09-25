"""RPD Capacity surface — read models only (`docs/PROJECT_AND_STACK.md` §2).
No mutations in this file.

**RBAC (P3-T02)**: every endpoint requires a validated OIDC token (401) and
`CAPACITY`/`READ` (Portfolio Manager, Hub Planner, Executive Viewer, Admin —
Engineer/Auditor get 403).

**Hub-scoped (P3-T03)**: every endpoint below is filtered to the caller's
own hub(s) via `services.hub_scope` unless `current_user.hub_scope_all` —
`hub_load_vs_capacity` filters the `Hub` rows themselves (so a Hub Planner's
response only contains their own hub(s)' rows); `class_breakdown` filters
the underlying `Project` join; `utilization_matrix` filters `Engineer` by
hub and `Chamber` by the caller's scoped lab region(s)
(`services.hub_scope.scoped_lab_regions` — see `api/routers/chambers.py`'s
module docstring for why Chamber can't be filtered by hub_id directly).

Per `docs/DOMAIN_RULES.md`'s known-defects list (FTE not applied in
scheduling; chamber efficiency/weeks_per_chamber display-only, ADR 0002/0003):
this router's *capacity supply* figures (how many engineer-weeks/chamber-weeks
exist) are FTE-/efficiency-scaled for REPORTING ONLY. They must never be
confused with what the scheduler itself booked — the *load* figures
(`design_load_weeks`, `lab_load_units`) are the ones sourced from the active
`ScheduleRun` snapshot and reconcile with Invariants I6/I7; the *capacity*
figures are this router's own documented formula (see `schemas/capacity.py`),
not a DOMAIN_RULES.md-defined quantity, and not a claim that the scheduler
already accounts for FTE/efficiency (it does not, per ADR 0002/0003).
"""

from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

import domain_constants as dc
from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.chamber import Chamber
from models.engineer import Engineer
from models.enums import ProjectCategory, WorkflowStepKind
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import WorkflowStepTemplate
from schemas.capacity import (
    ChamberWeekLoad,
    ClassBreakdown,
    ClassBreakdownRow,
    EngineerWeekLoad,
    HubCapacityRow,
    HubCapacitySummary,
    UtilizationMatrix,
)
from services.hub_scope import hub_scope_filter, scoped_lab_regions

router = APIRouter(prefix="/capacity", tags=["capacity"])

_read = require_permission(Surface.CAPACITY, Action.READ)


async def _active_run(db: AsyncSession) -> ScheduleRun | None:
    return (
        await db.execute(select(ScheduleRun).where(ScheduleRun.is_active.is_(True)))
    ).scalar_one_or_none()


@router.get("/hub-load", response_model=HubCapacitySummary)
async def hub_load_vs_capacity(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> HubCapacitySummary:
    hub_stmt = select(Hub)
    hub_filter = hub_scope_filter(current_user, Hub.id)
    if hub_filter is not None:
        hub_stmt = hub_stmt.where(hub_filter)
    hubs = (await db.execute(hub_stmt)).scalars().all()
    active_run = await _active_run(db)

    if active_run is None:
        empty_rows = [
            HubCapacityRow(
                hub=h.name,
                design_load_weeks=0,
                design_capacity_weeks=0.0,
                lab_load_units=0.0,
                lab_capacity_units=0.0,
            )
            for h in hubs
        ]
        return HubCapacitySummary(
            has_active_schedule_run=False,
            schedule_run_version=None,
            remaining_weeks=dc.HORIZON_WEEKS - dc.CURRENT_WEEK,
            rows=empty_rows,
        )

    remaining_weeks = active_run.horizon_weeks - active_run.current_week

    steps = (
        await db.execute(
            select(
                Project.hub_id,
                WorkflowStepTemplate.kind,
                ScheduleRunProjectStep.duration_weeks,
            )
            .join(Project, ScheduleRunProjectStep.project_id == Project.id)
            .join(
                WorkflowStepTemplate,
                ScheduleRunProjectStep.step_template_id == WorkflowStepTemplate.id,
            )
            .where(ScheduleRunProjectStep.schedule_run_id == active_run.id)
        )
    ).all()

    design_load: dict = defaultdict(int)
    lab_load: dict = defaultdict(float)
    for hub_id, kind, duration in steps:
        if kind == WorkflowStepKind.DESIGN:
            design_load[hub_id] += duration
        else:
            lab_load[hub_id] += duration * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK

    engineers = (await db.execute(select(Engineer))).scalars().all()
    design_capacity: dict = defaultdict(float)
    for e in engineers:
        design_capacity[e.hub_id] += float(e.fte) * remaining_weeks

    chambers = (await db.execute(select(Chamber))).scalars().all()
    lab_capacity_by_region: dict = defaultdict(float)
    for c in chambers:
        lab_capacity_by_region[c.lab_region] += (
            c.max_concurrent * remaining_weeks * float(c.efficiency)
        )

    rows = [
        HubCapacityRow(
            hub=h.name,
            design_load_weeks=design_load.get(h.id, 0),
            design_capacity_weeks=round(design_capacity.get(h.id, 0.0), 2),
            lab_load_units=round(lab_load.get(h.id, 0.0), 2),
            lab_capacity_units=round(lab_capacity_by_region.get(h.lab_region, 0.0), 2),
        )
        for h in hubs
    ]

    return HubCapacitySummary(
        has_active_schedule_run=True,
        schedule_run_version=active_run.version,
        remaining_weeks=remaining_weeks,
        rows=rows,
    )


@router.get("/class-breakdown", response_model=ClassBreakdown)
async def class_breakdown(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> ClassBreakdown:
    """A+/A/B/C deliverable (not left-out) vs. left-out counts, from the
    active ScheduleRun's outcomes.
    """

    active_run = await _active_run(db)
    if active_run is None:
        empty_rows = [
            ClassBreakdownRow(category=c, deliverable_count=0, left_out_count=0)
            for c in ProjectCategory
        ]
        return ClassBreakdown(
            has_active_schedule_run=False, schedule_run_version=None, rows=empty_rows
        )

    stmt = (
        select(Project.category, ScheduleRunProjectOutcome.left_out)
        .join(Project, ScheduleRunProjectOutcome.project_id == Project.id)
        .where(ScheduleRunProjectOutcome.schedule_run_id == active_run.id)
        .where(Project.category.is_not(None))
    )
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = (await db.execute(stmt)).all()

    deliverable: dict = defaultdict(int)
    left_out: dict = defaultdict(int)
    for category, is_left_out in result:
        if is_left_out:
            left_out[category] += 1
        else:
            deliverable[category] += 1

    rows = [
        ClassBreakdownRow(
            category=cat,
            deliverable_count=deliverable.get(cat, 0),
            left_out_count=left_out.get(cat, 0),
        )
        for cat in ProjectCategory
    ]
    return ClassBreakdown(
        has_active_schedule_run=True, schedule_run_version=active_run.version, rows=rows
    )


@router.get("/utilization-matrix", response_model=UtilizationMatrix)
async def utilization_matrix(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> UtilizationMatrix:
    """Engineer × week and chamber × week matrices, from the active
    ScheduleRun's step snapshot. See `schemas.capacity.EngineerWeekLoad`/
    `ChamberWeekLoad` for the sparse response shape.
    """

    active_run = await _active_run(db)
    if active_run is None:
        return UtilizationMatrix(
            has_active_schedule_run=False, schedule_run_version=None, engineers=[], chambers=[]
        )

    eng_stmt = select(Engineer).options(selectinload(Engineer.hub))
    eng_hub_filter = hub_scope_filter(current_user, Engineer.hub_id)
    if eng_hub_filter is not None:
        eng_stmt = eng_stmt.where(eng_hub_filter)
    engineers = (await db.execute(eng_stmt)).scalars().all()

    chamber_stmt = select(Chamber)
    regions = await scoped_lab_regions(db, current_user)
    if regions is not None:
        chamber_stmt = chamber_stmt.where(Chamber.lab_region.in_(regions))
    chambers = (await db.execute(chamber_stmt)).scalars().all()

    eng_steps = (
        await db.execute(
            select(ScheduleRunProjectStep).where(
                ScheduleRunProjectStep.schedule_run_id == active_run.id,
                ScheduleRunProjectStep.assigned_engineer_id.is_not(None),
            )
        )
    ).scalars().all()
    chamber_steps = (
        await db.execute(
            select(ScheduleRunProjectStep).where(
                ScheduleRunProjectStep.schedule_run_id == active_run.id,
                ScheduleRunProjectStep.assigned_chamber_id.is_not(None),
            )
        )
    ).scalars().all()

    busy_weeks_by_engineer: dict = defaultdict(set)
    for step in eng_steps:
        for week in range(step.start_week, step.end_week + 1):
            busy_weeks_by_engineer[step.assigned_engineer_id].add(week)

    week_counts_by_chamber: dict = defaultdict(lambda: defaultdict(int))
    for step in chamber_steps:
        for week in range(step.start_week, step.end_week + 1):
            week_counts_by_chamber[step.assigned_chamber_id][week] += 1

    # P3-T09 (security remediation, finding #1 / OQ#8 dependency): `name` is
    # deliberately NOT included — see `schemas.capacity.EngineerWeekLoad`'s
    # docstring. Only `engineer_id`/`hub`/`busy_weeks` are served pending DPO
    # sign-off on `docs/OPEN_QUESTIONS.md` #8.
    engineer_rows = [
        EngineerWeekLoad(
            engineer_id=e.id,
            hub=e.hub.name,
            busy_weeks=sorted(busy_weeks_by_engineer.get(e.id, set())),
        )
        for e in engineers
    ]
    chamber_rows = [
        ChamberWeekLoad(
            chamber_id=c.id,
            code=c.code,
            lab_region=c.lab_region.value,
            max_concurrent=c.max_concurrent,
            week_counts=dict(sorted(week_counts_by_chamber.get(c.id, {}).items())),
        )
        for c in chambers
    ]

    return UtilizationMatrix(
        has_active_schedule_run=True,
        schedule_run_version=active_run.version,
        engineers=engineer_rows,
        chambers=chamber_rows,
    )
