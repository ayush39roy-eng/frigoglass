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

**Supply (P9-T03, ADR 0008).** The capacity *supply* figures are the
client's formulas from docs/DOMAIN_RULES.md "Capacity supply", computed by
`services.capacity_supply` from the stored hub calendars and chamber
downtime (I17). They are reporting figures: per ADR 0002, FTE and downtime
still do not gate week-level booking. The *load* figures come from the
active `ScheduleRun` snapshot and reconcile with Invariants I6/I7. Step
kinds are read from that run's `workflow_snapshot` (`services.active_run`).
"""

from __future__ import annotations

import uuid
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
from models.enums import NON_SCHEDULABLE_STATUSES, LabRegion, ProjectCategory, WorkflowStepKind
from models.hub import Hub, HubWorkCalendar
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from schemas.capacity import (
    CapacityChamberRow,
    ChamberWeekLoad,
    ClassBreakdown,
    ClassBreakdownRow,
    EngineerWeekLoad,
    HubCapacityRow,
    HubCapacitySummary,
    UtilizationMatrix,
)
from services.active_run import get_active_run, step_kinds_for_run
from services.capacity_supply import (
    calendar_figures,
    chamber_figures,
    gap_and_completion,
    lab_remaining_fraction,
    load_calendars_by_region,
    region_holiday_weeks,
    round2,
)
from services.hub_scope import hub_scope_filter, scoped_lab_regions

router = APIRouter(prefix="/capacity", tags=["capacity"])

_read = require_permission(Surface.CAPACITY, Action.READ)


async def _active_run(db: AsyncSession) -> ScheduleRun | None:
    return await get_active_run(db)


@router.get("/hub-load", response_model=HubCapacitySummary)
@router.get("/hubs", response_model=HubCapacitySummary)
async def hub_load_vs_capacity(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> HubCapacitySummary:
    """Per-hub load vs. supply (docs/API_CONTRACT_P9.md §4, ADR 0008).

    Served at `/capacity/hub-load` (the pre-P9 path the frontend calls) and at
    `/capacity/hubs` (the path named in the contract doc). Same handler.

    Rows are hub-scoped (P3-T03). The region-level lab figures sum over every
    project and chamber of the row's lab region, including hubs outside the
    caller's scope, because lab capacity is shared across a region. Only the
    aggregate leaves this function.
    """

    hub_stmt = select(Hub).order_by(Hub.name)
    hub_filter = hub_scope_filter(current_user, Hub.id)
    if hub_filter is not None:
        hub_stmt = hub_stmt.where(hub_filter)
    hubs = (await db.execute(hub_stmt)).scalars().all()
    active_run = await _active_run(db)
    current_week = dc.CURRENT_WEEK

    # --- Load (I6/I7), from the active run only ----------------------------
    design_load: dict[uuid.UUID, int] = defaultdict(int)
    lab_load_by_hub: dict[uuid.UUID, float] = defaultdict(float)
    lab_load_by_region: dict[LabRegion, float] = defaultdict(float)
    if active_run is not None:
        kinds = await step_kinds_for_run(db, active_run)
        steps = (
            await db.execute(
                select(
                    Project.hub_id,
                    Hub.lab_region,
                    ScheduleRunProjectStep.step_template_id,
                    ScheduleRunProjectStep.duration_weeks,
                    ScheduleRunProjectStep.skipped,
                )
                .join(Project, ScheduleRunProjectStep.project_id == Project.id)
                .join(Hub, Project.hub_id == Hub.id)
                .where(ScheduleRunProjectStep.schedule_run_id == active_run.id)
            )
        ).all()
        for hub_id, region, step_id, duration, skipped in steps:
            # I6/I7 (revised 2026-09-27, ADR 0007): design-kind → design load,
            # lab-kind → lab load (× 1.0); elapsed and skipped steps add 0.
            if skipped:
                continue
            kind = kinds.get(step_id)
            if kind == WorkflowStepKind.DESIGN:
                design_load[hub_id] += duration
            elif kind == WorkflowStepKind.LAB:
                weeks = duration * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK
                lab_load_by_hub[hub_id] += weeks
                lab_load_by_region[region] += weeks

    # --- Estimated load (OQ #12): live project fields, schedulable projects --
    est_design: dict[uuid.UUID, float] = defaultdict(float)
    est_lab_by_region: dict[LabRegion, float] = defaultdict(float)
    est_rows = (
        await db.execute(
            select(
                Project.hub_id,
                Hub.lab_region,
                Project.estimated_design_weeks,
                Project.estimated_lab_weeks,
                Project.certification_testing_required,
            )
            .join(Hub, Project.hub_id == Hub.id)
            .where(Project.status.not_in(list(NON_SCHEDULABLE_STATUSES)))
        )
    ).all()
    for hub_id, region, est_d, est_l, cert_required in est_rows:
        if est_d is not None:
            est_design[hub_id] += float(est_d)
        if est_l is not None and cert_required:
            est_lab_by_region[region] += float(est_l)

    # --- Supply (ADR 0008) ---------------------------------------------------
    fte_by_hub: dict[uuid.UUID, float] = defaultdict(float)
    for hub_id, fte in (await db.execute(select(Engineer.hub_id, Engineer.fte))).all():
        fte_by_hub[hub_id] += float(fte)
    calendar_by_hub = {
        c.hub_id: c for c in (await db.execute(select(HubWorkCalendar))).scalars().all()
    }
    calendars = await load_calendars_by_region(db)
    chambers_by_region: dict[LabRegion, list[CapacityChamberRow]] = defaultdict(list)
    lab_year_by_region: dict[LabRegion, float] = defaultdict(float)
    for c in (await db.execute(select(Chamber).order_by(Chamber.code))).scalars().all():
        figures = chamber_figures(c, region_holiday_weeks(calendars, c.lab_region))
        lab_year_by_region[c.lab_region] += figures.efficient_lab_weeks
        chambers_by_region[c.lab_region].append(
            CapacityChamberRow(
                chamber_id=c.id,
                code=c.code,
                platforms=c.platforms,
                efficiency=float(c.efficiency),
                working_weeks_per_chamber=round2(figures.working_weeks_per_chamber),
                efficient_lab_weeks=round2(figures.efficient_lab_weeks),
            )
        )
    lab_fraction = lab_remaining_fraction(current_week)

    rows: list[HubCapacityRow] = []
    for h in hubs:
        cal = calendar_figures(calendar_by_hub.get(h.id), current_week)
        fte = fte_by_hub.get(h.id, 0.0)
        design_year = cal.working_weeks_per_engineer * fte
        design_remaining = cal.remaining_working_weeks * fte
        lab_year = lab_year_by_region.get(h.lab_region, 0.0)
        lab_remaining = lab_year * lab_fraction
        d_load = design_load.get(h.id, 0)
        l_load = lab_load_by_region.get(h.lab_region, 0.0)
        d_gap_y, d_pct_y = gap_and_completion(d_load, design_year)
        d_gap_r, d_pct_r = gap_and_completion(d_load, design_remaining)
        l_gap_y, l_pct_y = gap_and_completion(l_load, lab_year)
        l_gap_r, l_pct_r = gap_and_completion(l_load, lab_remaining)
        rows.append(
            HubCapacityRow(
                hub=h.name,
                lab_region=h.lab_region,
                design_load_weeks=d_load,
                design_load_estimated_weeks=round2(est_design.get(h.id, 0.0)),
                lab_load_weeks=round2(l_load),
                lab_load_estimated_weeks=round2(est_lab_by_region.get(h.lab_region, 0.0)),
                engineer_fte_total=round2(fte),
                working_weeks_per_engineer=round2(cal.working_weeks_per_engineer),
                design_capacity_year=round2(design_year),
                design_capacity_remaining=round2(design_remaining),
                lab_capacity_year=round2(lab_year),
                lab_capacity_remaining=round2(lab_remaining),
                design_gap_year=round2(d_gap_y),
                design_completion_pct_year=_pct(d_pct_y),
                design_gap_remaining=round2(d_gap_r),
                design_completion_pct_remaining=_pct(d_pct_r),
                lab_gap_year=round2(l_gap_y),
                lab_completion_pct_year=_pct(l_pct_y),
                lab_gap_remaining=round2(l_gap_r),
                lab_completion_pct_remaining=_pct(l_pct_r),
                remaining_fraction=round(cal.remaining_fraction, 4),
                chambers=chambers_by_region.get(h.lab_region, []),
                design_capacity_weeks=round2(design_remaining),
                lab_capacity_units=round2(lab_remaining),
                lab_load_units=round2(lab_load_by_hub.get(h.id, 0.0)),
            )
        )

    remaining_weeks = (
        active_run.horizon_weeks - active_run.current_week
        if active_run is not None
        else dc.HORIZON_WEEKS - dc.CURRENT_WEEK
    )
    return HubCapacitySummary(
        has_active_schedule_run=active_run is not None,
        schedule_run_version=active_run.version if active_run is not None else None,
        remaining_weeks=remaining_weeks,
        rows=rows,
    )


def _pct(value: float | None) -> float | None:
    return None if value is None else round2(value)


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

    deliverable: dict[ProjectCategory, int] = defaultdict(int)
    left_out: dict[ProjectCategory, int] = defaultdict(int)
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

    busy_weeks_by_engineer: dict[uuid.UUID | None, set[int]] = defaultdict(set)
    for step in eng_steps:
        for week in range(step.start_week, step.end_week + 1):
            busy_weeks_by_engineer[step.assigned_engineer_id].add(week)

    week_counts_by_chamber: dict[uuid.UUID | None, dict[int, int]] = defaultdict(
        lambda: defaultdict(int)
    )
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
