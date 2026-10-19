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

**Booked % and areas (P11, ADR 0016).** Every hub row also carries
`booked_pct = load / capacity × 100` and an `available` / `near_full` /
`full` status, for year and remaining, design and lab, plus its `area`. The
summary adds the Europe / India roll-up (`areas`), built from the in-scope
hub rows only, with each lab region counted once (I19). Reporting figures:
they never gate booking.

**Global hub filter (P12, ADR 0020).** Every GET here takes an optional
`hub_id`, ANDed with the RBAC scope (never widening; out of scope → empty
rows / zero totals, not 403). `/capacity/hubs` then serves only that hub's
row, and `areas[]` only the area containing it (its design figures are that
hub's; its lab figures stay region-wide, ADR 0020 §4).

**Country filter (P13, ADR 0025).** Every GET here also takes an optional
`region` (`LabRegion`), ANDed the same way: hub rows are reduced to the
region's hubs, so `areas[]` reduces to the containing area (Greece/Romania →
Europe, India → India) and the lab figures/chambers to that lab region.

**Priority split (P13-T11, `docs/API_CONTRACT_P13.md` §6).** Each hub row
carries `design_load_by_priority` / `lab_load_by_priority` (`P1`..`P4`,
`Queue`), built in the same loop and on the same basis as `design_load_weeks`
/ `lab_load_weeks`, so they sum to them (`services.capacity_priority`). Each
class row carries the same split of its counts plus `by_hub`. The
utilization matrix is engineer × week and chamber × week, not the hub table,
so per §6 it gains nothing: the hub-level split is served on the hub rows,
and no engineer-level figure is added (OQ #8).
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

import domain_constants as dc
from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.engineer import Engineer
from models.enums import (
    NON_SCHEDULABLE_STATUSES,
    HubName,
    LabRegion,
    ProjectCategory,
    WorkflowStepKind,
)
from models.hub import Hub, HubWorkCalendar
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from schemas.capacity import (
    CapacityArea,
    CapacityChamberRow,
    CapacityTotals,
    ChamberWeekLoad,
    ClassBreakdown,
    ClassBreakdownHubRow,
    ClassBreakdownRow,
    EngineerUtilizationResponse,
    EngineerUtilizationRow,
    EngineerWeekLoad,
    EngineerWeekUtilization,
    HubCapacityRow,
    HubCapacitySummary,
    PriorityCountSplit,
    PriorityLoadSplit,
    UtilizationMatrix,
)
from services.active_run import get_active_run, step_kinds_for_run
from services.capacity_priority import (
    PRIORITY_BUCKETS,
    SCHEDULABLE_STATUSES,
    count_split,
    priority_bucket,
    split_to_total,
)
from services.capacity_supply import (
    area_for_region,
    booking,
    calendar_figures,
    chamber_figures,
    gap_and_completion,
    lab_remaining_fraction,
    load_calendars_by_region,
    region_holiday_weeks,
    round2,
)
from services.hub_scope import (
    is_engineer_self_scoped,
    narrowed_hub_filter,
    narrowed_lab_regions,
)

router = APIRouter(prefix="/capacity", tags=["capacity"])

_read = require_permission(Surface.CAPACITY, Action.READ)


async def _active_run(db: AsyncSession) -> ScheduleRun | None:
    return await get_active_run(db)


@router.get("/hub-load", response_model=HubCapacitySummary)
@router.get("/hubs", response_model=HubCapacitySummary)
async def hub_load_vs_capacity(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
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
    hub_filter = narrowed_hub_filter(current_user, Hub.id, hub_id, region)
    if hub_filter is not None:
        hub_stmt = hub_stmt.where(hub_filter)
    hubs = (await db.execute(hub_stmt)).scalars().all()
    active_run = await _active_run(db)
    current_week = dc.CURRENT_WEEK

    # --- Load (I6/I7), from the active run only ----------------------------
    design_load: dict[uuid.UUID, int] = defaultdict(int)
    lab_load_by_hub: dict[uuid.UUID, float] = defaultdict(float)
    lab_load_by_region: dict[LabRegion, float] = defaultdict(float)
    # P13 (contract §6): the same loads, split by the project's priority bucket.
    design_by_priority: dict[uuid.UUID, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    lab_by_priority: dict[LabRegion, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    if active_run is not None:
        kinds = await step_kinds_for_run(db, active_run)
        steps = (
            await db.execute(
                select(
                    Project.hub_id,
                    Hub.lab_region,
                    Project.priority,
                    ScheduleRunProjectStep.step_template_id,
                    ScheduleRunProjectStep.duration_weeks,
                    ScheduleRunProjectStep.skipped,
                )
                .join(Project, ScheduleRunProjectStep.project_id == Project.id)
                .join(Hub, Project.hub_id == Hub.id)
                .where(ScheduleRunProjectStep.schedule_run_id == active_run.id)
            )
        ).all()
        for step_hub_id, step_region, step_priority, step_id, duration, skipped in steps:
            # I6/I7 (revised 2026-09-27, ADR 0007): design-kind → design load,
            # lab-kind → lab load (× 1.0); elapsed and skipped steps add 0.
            if skipped:
                continue
            kind = kinds.get(step_id)
            bucket = priority_bucket(step_priority)
            if kind == WorkflowStepKind.DESIGN:
                design_load[step_hub_id] += duration
                design_by_priority[step_hub_id][bucket] += duration
            elif kind == WorkflowStepKind.LAB:
                weeks = duration * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK
                lab_load_by_hub[step_hub_id] += weeks
                lab_load_by_region[step_region] += weeks
                lab_by_priority[step_region][bucket] += weeks

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
    for est_hub_id, est_region, est_d, est_l, cert_required in est_rows:
        if est_d is not None:
            est_design[est_hub_id] += float(est_d)
        if est_l is not None and cert_required:
            est_lab_by_region[est_region] += float(est_l)

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
        # ADR 0016 / I19: booked % on the row's *served* (2 dp) figures.
        d_book_y = booking(d_load, round2(design_year))
        d_book_r = booking(d_load, round2(design_remaining))
        l_book_y = booking(round2(l_load), round2(lab_year))
        l_book_r = booking(round2(l_load), round2(lab_remaining))
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
                design_booked_pct_year=d_book_y[0],
                design_booked_pct_remaining=d_book_r[0],
                lab_booked_pct_year=l_book_y[0],
                lab_booked_pct_remaining=l_book_r[0],
                design_booking_status_year=d_book_y[1],
                design_booking_status_remaining=d_book_r[1],
                lab_booking_status_year=l_book_y[1],
                lab_booking_status_remaining=l_book_r[1],
                area=area_for_region(h.lab_region),
                design_load_by_priority=PriorityLoadSplit(
                    **split_to_total(design_by_priority.get(h.id, {}), d_load)
                ),
                lab_load_by_priority=PriorityLoadSplit(
                    **split_to_total(lab_by_priority.get(h.lab_region, {}), l_load)
                ),
            )
        )

    # ADR 0024: weeks left in the 52-week planning year (the same basis as
    # the "remaining" capacity figures), not the scheduler's internal horizon.
    remaining_weeks = max(
        0,
        dc.WITHIN_YEAR_WEEK
        - (active_run.current_week if active_run is not None else dc.CURRENT_WEEK),
    )
    return HubCapacitySummary(
        has_active_schedule_run=active_run is not None,
        schedule_run_version=active_run.version if active_run is not None else None,
        remaining_weeks=remaining_weeks,
        rows=rows,
        near_full_threshold_pct=dc.BOOKING_NEAR_FULL_PCT,
        full_threshold_pct=dc.BOOKING_FULL_PCT,
        areas=_area_rows(rows),
        totals=_totals(rows),
    )


def _totals(rows: list[HubCapacityRow]) -> CapacityTotals:
    """P13-T11 addendum: the total over the served hub rows (I9/I19).

    Design: Σ over every hub row. Lab: Σ over ONE row per distinct lab
    region (the region figure is repeated on each hub of the region). Inputs
    are the rows' served 2 dp figures, as in `_area_rows`.
    """

    region_rows: dict[LabRegion, HubCapacityRow] = {}
    for row in rows:
        region_rows.setdefault(row.lab_region, row)
    regions = sorted(region_rows, key=lambda r: r.value)
    lab_rows = [region_rows[r] for r in regions]

    d_load = sum(r.design_load_weeks for r in rows)
    d_year = round2(sum(r.design_capacity_year for r in rows))
    d_rem = round2(sum(r.design_capacity_remaining for r in rows))
    l_load = round2(sum(r.lab_load_weeks for r in lab_rows))
    l_year = round2(sum(r.lab_capacity_year for r in lab_rows))
    l_rem = round2(sum(r.lab_capacity_remaining for r in lab_rows))
    d_split: dict[str, float] = {
        b: sum(getattr(r.design_load_by_priority, b) for r in rows) for b in PRIORITY_BUCKETS
    }
    l_split: dict[str, float] = {
        b: sum(getattr(r.lab_load_by_priority, b) for r in lab_rows) for b in PRIORITY_BUCKETS
    }
    d_book_y, d_book_r = booking(d_load, d_year), booking(d_load, d_rem)
    l_book_y, l_book_r = booking(l_load, l_year), booking(l_load, l_rem)
    return CapacityTotals(
        hubs=[r.hub for r in rows],
        lab_regions=regions,
        design_load_weeks=d_load,
        design_capacity_year=d_year,
        design_capacity_remaining=d_rem,
        design_booked_pct_year=d_book_y[0],
        design_booked_pct_remaining=d_book_r[0],
        design_booking_status_year=d_book_y[1],
        design_booking_status_remaining=d_book_r[1],
        design_load_by_priority=PriorityLoadSplit(**split_to_total(d_split, d_load)),
        lab_load_weeks=l_load,
        lab_capacity_year=l_year,
        lab_capacity_remaining=l_rem,
        lab_booked_pct_year=l_book_y[0],
        lab_booked_pct_remaining=l_book_r[0],
        lab_booking_status_year=l_book_y[1],
        lab_booking_status_remaining=l_book_r[1],
        lab_load_by_priority=PriorityLoadSplit(**split_to_total(l_split, l_load)),
    )


def _pct(value: float | None) -> float | None:
    return None if value is None else round2(value)


def _area_rows(rows: list[HubCapacityRow]) -> list[CapacityArea]:
    """ADR 0016 §3: roll the in-scope hub rows up into Europe and India.

    Design figures are summed over the area's hub rows. Lab figures are
    region-level and repeated on every hub row of the region, so they are
    taken from ONE row per region and summed over distinct regions. Every
    input is the row's served (2 dp) figure, so an area equals the sum of
    what the client sees on the hub rows. Areas are ordered Europe, then
    India; an area with no in-scope hub is omitted.
    """

    by_area: dict[str, list[HubCapacityRow]] = defaultdict(list)
    for row in rows:
        by_area[row.area].append(row)

    areas: list[CapacityArea] = []
    for area in dc.AREA_ORDER:
        hub_rows = by_area.get(area)
        if not hub_rows:
            continue
        region_rows: dict[LabRegion, HubCapacityRow] = {}
        for row in hub_rows:
            region_rows.setdefault(row.lab_region, row)
        regions = sorted(region_rows, key=lambda r: r.value)
        d_load = sum(r.design_load_weeks for r in hub_rows)
        d_year = round2(sum(r.design_capacity_year for r in hub_rows))
        d_rem = round2(sum(r.design_capacity_remaining for r in hub_rows))
        l_load = round2(sum(region_rows[r].lab_load_weeks for r in regions))
        l_year = round2(sum(region_rows[r].lab_capacity_year for r in regions))
        l_rem = round2(sum(region_rows[r].lab_capacity_remaining for r in regions))
        d_book_y, d_book_r = booking(d_load, d_year), booking(d_load, d_rem)
        l_book_y, l_book_r = booking(l_load, l_year), booking(l_load, l_rem)
        areas.append(
            CapacityArea(
                area=hub_rows[0].area,
                hubs=[r.hub for r in hub_rows],
                lab_regions=regions,
                design_load_weeks=d_load,
                design_capacity_year=d_year,
                design_capacity_remaining=d_rem,
                lab_load_weeks=l_load,
                lab_capacity_year=l_year,
                lab_capacity_remaining=l_rem,
                design_booked_pct_year=d_book_y[0],
                design_booked_pct_remaining=d_book_r[0],
                lab_booked_pct_year=l_book_y[0],
                lab_booked_pct_remaining=l_book_r[0],
                design_booking_status_year=d_book_y[1],
                design_booking_status_remaining=d_book_r[1],
                lab_booking_status_year=l_book_y[1],
                lab_booking_status_remaining=l_book_r[1],
            )
        )
    return areas


@router.get("/class-breakdown", response_model=ClassBreakdown)
async def class_breakdown(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> ClassBreakdown:
    """A+/A/B/C deliverable (not left-out) vs. left-out counts, from the
    active ScheduleRun's outcomes.

    P13-F06: only projects whose live status is schedulable
    (`SCHEDULABLE_STATUSES`) are counted at all, so Commercialized, On Hold,
    Cancelled and Draft projects are in neither column, nor in the priority
    splits, `by_hub` or `total_count`.
    """

    active_run = await _active_run(db)
    if active_run is None:
        empty_rows = [
            ClassBreakdownRow(
                category=c,
                deliverable_count=0,
                left_out_count=0,
                total_count=0,
                deliverable_by_priority=PriorityCountSplit(**count_split({})),
                left_out_by_priority=PriorityCountSplit(**count_split({})),
                by_hub=[],
            )
            for c in ProjectCategory
        ]
        return ClassBreakdown(
            has_active_schedule_run=False, schedule_run_version=None, rows=empty_rows
        )

    stmt = (
        select(
            Project.category,
            ScheduleRunProjectOutcome.left_out,
            Project.priority,
            Hub.name,
        )
        .join(Project, ScheduleRunProjectOutcome.project_id == Project.id)
        .join(Hub, Project.hub_id == Hub.id)
        .where(ScheduleRunProjectOutcome.schedule_run_id == active_run.id)
        .where(Project.category.is_not(None))
        .where(Project.status.in_(SCHEDULABLE_STATUSES))
    )
    hub_filter = narrowed_hub_filter(current_user, Project.hub_id, hub_id, region)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = (await db.execute(stmt)).all()

    deliverable: dict[ProjectCategory, int] = defaultdict(int)
    left_out: dict[ProjectCategory, int] = defaultdict(int)
    # P13 (contract §6): the same counts per priority bucket and per hub.
    deliverable_prio: dict[ProjectCategory, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    left_out_prio: dict[ProjectCategory, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    by_hub: dict[ProjectCategory, dict[HubName, list[int]]] = defaultdict(
        lambda: defaultdict(lambda: [0, 0])
    )
    for category, is_left_out, priority, hub_name in result:
        if category is None:  # excluded by the query; narrows the type
            continue
        bucket = priority_bucket(priority)
        if is_left_out:
            left_out[category] += 1
            left_out_prio[category][bucket] += 1
            by_hub[category][hub_name][1] += 1
        else:
            deliverable[category] += 1
            deliverable_prio[category][bucket] += 1
            by_hub[category][hub_name][0] += 1

    rows = [
        ClassBreakdownRow(
            category=cat,
            deliverable_count=deliverable.get(cat, 0),
            left_out_count=left_out.get(cat, 0),
            total_count=deliverable.get(cat, 0) + left_out.get(cat, 0),
            deliverable_by_priority=PriorityCountSplit(**count_split(deliverable_prio[cat])),
            left_out_by_priority=PriorityCountSplit(**count_split(left_out_prio[cat])),
            by_hub=[
                ClassBreakdownHubRow(hub=name, deliverable=counts[0], left_out=counts[1])
                for name, counts in sorted(by_hub[cat].items(), key=lambda kv: kv[0].value)
            ],
        )
        for cat in ProjectCategory
    ]
    return ClassBreakdown(
        has_active_schedule_run=True, schedule_run_version=active_run.version, rows=rows
    )


@router.get("/utilization-matrix", response_model=UtilizationMatrix)
async def utilization_matrix(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
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
    eng_hub_filter = narrowed_hub_filter(current_user, Engineer.hub_id, hub_id, region)
    if eng_hub_filter is not None:
        eng_stmt = eng_stmt.where(eng_hub_filter)
    engineers = (await db.execute(eng_stmt)).scalars().all()

    chamber_stmt = select(Chamber)
    # ADR 0020 §4 / ADR 0025: a hub narrows the chambers to its own lab
    # region, a country to that region (the week counts stay region-wide:
    # chambers are shared across a region). Out of scope → no chambers.
    regions = await narrowed_lab_regions(db, current_user, hub_id, region)
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


@router.get("/engineer-utilization", response_model=EngineerUtilizationResponse)
async def engineer_utilization(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> EngineerUtilizationResponse:
    """Engineers x Weeks utilization (ADR 0028, P4-T08).

    Booked = the active run's non-skipped design-kind step durations, one
    booked week per week of `[start_week, start_week + duration_weeks - 1]`
    on the assigned engineer; the same basis as the hub design load, so the
    hub's engineers' `booked_total` sums to it (I6). Capacity per week =
    `working_weeks_per_engineer * fte / 52` (ADR 0008). Hub scope is ANDed
    with the `hub_id` / `region` filters; an Engineer-role caller gets only
    their own row. Every read writes `capacity.engineer_utilization.read`
    (caller, filters, row count; never the figures).
    """

    active_run = await _active_run(db)
    eng_stmt = select(Engineer).options(selectinload(Engineer.hub)).order_by(Engineer.name)
    hub_filter = narrowed_hub_filter(current_user, Engineer.hub_id, hub_id, region)
    if hub_filter is not None:
        eng_stmt = eng_stmt.where(hub_filter)
    if is_engineer_self_scoped(current_user):
        eng_stmt = eng_stmt.where(Engineer.user_id == current_user.user_id)
    engineers = (await db.execute(eng_stmt)).scalars().all()

    booked: dict[uuid.UUID, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    if active_run is not None and engineers:
        kinds = await step_kinds_for_run(db, active_run)
        steps = (
            await db.execute(
                select(ScheduleRunProjectStep).where(
                    ScheduleRunProjectStep.schedule_run_id == active_run.id,
                    ScheduleRunProjectStep.assigned_engineer_id.in_([e.id for e in engineers]),
                    ScheduleRunProjectStep.skipped.is_(False),
                )
            )
        ).scalars().all()
        for step in steps:
            if kinds.get(step.step_template_id) != WorkflowStepKind.DESIGN:
                continue
            for week in range(step.start_week, step.start_week + step.duration_weeks):
                booked[step.assigned_engineer_id][week] += 1

    calendar_by_hub = {
        c.hub_id: c for c in (await db.execute(select(HubWorkCalendar))).scalars().all()
    }
    def _pct(booked_weeks: float, capacity_weeks: float) -> float:
        if capacity_weeks > 0:
            return round2(booked_weeks / capacity_weeks * 100)
        return 100.0 if booked_weeks > 0 else 0.0

    rows: list[EngineerUtilizationRow] = []
    for e in engineers:
        cal = calendar_figures(calendar_by_hub.get(e.hub_id), dc.CURRENT_WEEK)
        weekly_cap = cal.working_weeks_per_engineer * float(e.fte) / dc.WITHIN_YEAR_WEEK
        mine = booked.get(e.id, {})
        weeks = [
            EngineerWeekUtilization(
                week=w,
                booked=float(mine.get(w, 0)),
                capacity=round2(weekly_cap),
                utilization_pct=_pct(mine.get(w, 0), weekly_cap),
            )
            for w in range(1, dc.WITHIN_YEAR_WEEK + 1)
        ]
        year_cap = weekly_cap * dc.WITHIN_YEAR_WEEK
        total_booked = float(sum(mine.values()))
        rows.append(
            EngineerUtilizationRow(
                id=e.id,
                name=e.name,
                hub=e.hub.name,
                role=", ".join(c.value for c in e.allowed_categories),
                total_booked=total_booked,
                total_capacity=round2(year_cap),
                utilization_pct=_pct(total_booked, year_cap),
                weeks=weeks,
            )
        )

    # Coalesce: one audit row per user per filter set per minute (a burst of reloads
    # must not grow the append-only table without bound).
    hub_text = str(hub_id) if hub_id else None
    region_text = region.value if region else None
    recent = (
        await db.execute(
            select(AuditLogEntry.id)
            .where(
                AuditLogEntry.actor_user_id == current_user.user_id,
                AuditLogEntry.action == "capacity.engineer_utilization.read",
                AuditLogEntry.occurred_at >= datetime.now(UTC) - timedelta(minutes=1),
                AuditLogEntry.after_state["hub_id"].astext.is_not_distinct_from(hub_text),
                AuditLogEntry.after_state["region"].astext.is_not_distinct_from(region_text),
            )
            .limit(1)
        )
    ).first()
    if recent is None:
        db.add(
            AuditLogEntry(
                actor_user_id=current_user.user_id,
                action="capacity.engineer_utilization.read",
                entity_type="EngineerUtilization",
                entity_id="engineer-utilization",
                hub_id=hub_id,
                before_state=None,
                after_state={
                    "hub_id": hub_text,
                    "region": region_text,
                    "row_count": len(rows),
                },
            )
        )
    await db.commit()
    return EngineerUtilizationResponse(
        week_range=(1, dc.WITHIN_YEAR_WEEK),
        current_week=active_run.current_week if active_run is not None else dc.CURRENT_WEEK,
        engineers=rows,
    )
