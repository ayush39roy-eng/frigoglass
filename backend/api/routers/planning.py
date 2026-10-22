"""Capacity Planning surface — capacity figures (P19-T03,
docs/API_CONTRACT_P19.md §4-§6). Read models only; no mutation.

**RBAC.** Every endpoint needs `CAPACITY_PLANNING`/`READ` (Portfolio Manager,
Hub Planner, Admin, Super Admin; Engineer, Executive Viewer and Auditor 403),
the same dependency as `GET /engineers` and `GET /chambers`.

**Hub scope.** Hubs and engineers are filtered by `narrowed_hub_filter`
(RBAC scope AND the optional `hub_id` / `region`, never widening, ADR
0020/0025). Chambers are filtered by `narrowed_lab_regions` (a Hub Planner
sees the chambers of their hubs' lab regions). As on `/capacity/hub-load`, a
region's lab capacity and a chamber's load are region-wide: chambers are
shared, and only aggregates leave this module.

**Capacity hubs (P29, ADR 0042).** Design supply rows are the four capacity
hubs (`services.capacity_hubs`), over engineers with `counts_in_capacity`;
R&D-Greece's row lists `members` (OEM-HCK, OEM-Seitek in scope). Engineer
lists resolve a member-hub `hub_id` to its capacity hub; the engineer totals'
capacity skips non-counted engineers.

**Supply** is ADR 0008 (`services.capacity_supply`), the same code path as
`/capacity/hub-load`, `/engineers` and `/chambers`, so the figures agree to
2 dp (I17). **Load** is the active run's non-skipped step durations (I6/I7).

**GDPR (OQ #8, ADR 0028).** `GET /planning/resource-load` serves per-engineer
load; every read writes `planning.resource_load.read` (filters and row
counts, never a figure), coalesced to one row per user per filter set per
minute, like `/capacity/engineer-utilization`.
"""

from __future__ import annotations

import json
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import ColumnElement, and_, select
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
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    ProjectType,
    WorkflowStepKind,
)
from models.hub import Hub, HubWorkCalendar
from models.project import Project
from models.schedule import ScheduleRunProjectStep
from schemas.capacity import YearRemaining
from schemas.planning import (
    CapacityBasis,
    CapacitySummaryResponse,
    ChamberResourceLoad,
    DesignHubSummary,
    DesignSummary,
    DesignTotal,
    EngineerOption,
    EngineerResourceLoad,
    LabRegionSummary,
    LabSummary,
    LabTotal,
    ResourceLoadFilters,
    ResourceLoadOptions,
    ResourceLoadResponse,
    ResourceLoadTotal,
    ResourceLoadTotals,
)
from services.active_run import get_active_run, step_kinds_for_run
from services.capacity_hubs import (
    capacity_rows_for_request,
    counted_fte_by_capacity_hub,
    engineer_hub_filter,
    load_capacity_hub_map,
)
from services.capacity_supply import (
    booked_pct,
    chamber_figures,
    design_capacity,
    fte_sum,
    hub_weekdays_per_week,
    lab_remaining_fraction,
    load_calendars_by_region,
    region_holiday_weeks,
    region_weekdays_per_week,
    round2,
    to_days,
)
from services.hub_scope import hub_scope_filter, narrowed_hub_filter, narrowed_lab_regions

router = APIRouter(prefix="/planning", tags=["capacity-planning"])

_read = require_permission(Surface.CAPACITY_PLANNING, Action.READ)

AUDIT_ACTION = "planning.resource_load.read"
#: Bounds on the repeatable filters (a filter bar never sends more; keeps the
#: IN lists small).
MAX_LIST_FILTER = 50
MAX_ENGINEER_FILTER = 500
MAX_DEPARTMENT_LENGTH = 100


def _share(part: float, total: float) -> float:
    return round2(part / total * 100) if total else 0.0


def _days(weeks: YearRemaining, weekdays: float) -> YearRemaining:
    return YearRemaining(
        year=to_days(weeks.year, weekdays), remaining=to_days(weeks.remaining, weekdays)
    )


def _sum(pairs: list[YearRemaining]) -> YearRemaining:
    return YearRemaining(
        year=round2(sum(p.year for p in pairs)),
        remaining=round2(sum(p.remaining for p in pairs)),
    )


# --- §4 -------------------------------------------------------------------------------


@router.get("/capacity-summary", response_model=CapacitySummaryResponse)
async def capacity_summary(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> CapacitySummaryResponse:
    """Design supply per visible hub and lab supply per lab region of those
    hubs, with shares of the visible total. Same basis and same served
    figures as `GET /capacity/hub-load` for the same filters."""

    current_week = dc.CURRENT_WEEK
    # ADR 0042: one design row per CAPACITY hub with a hub in scope AND the
    # filter (an OEM hub selects R&D-Greece); supply over counted engineers.
    cmap, row_scopes = await capacity_rows_for_request(db, current_user, hub_id, region)
    hubs = [cmap.hubs[r.capacity_hub_id] for r in row_scopes]
    fte_by_hub, counted, not_counted = await counted_fte_by_capacity_hub(db, cmap)
    calendar_by_hub = {
        c.hub_id: c for c in (await db.execute(select(HubWorkCalendar))).scalars().all()
    }

    design_rows: list[DesignHubSummary] = []
    for scope in row_scopes:
        h = cmap.hubs[scope.capacity_hub_id]
        fte = fte_by_hub.get(h.id, 0.0)
        cal = calendar_by_hub.get(h.id)
        year, remaining = design_capacity(cal, fte, current_week)
        wd = hub_weekdays_per_week(cal)
        weeks = YearRemaining(year=round2(year), remaining=round2(remaining))
        design_rows.append(
            DesignHubSummary(
                hub=h.name,
                engineer_count=counted.get(h.id, 0),
                not_counted_engineer_count=not_counted.get(h.id, 0),
                fte_total=round2(fte),
                weekdays_per_week=wd,
                capacity_weeks=weeks,
                capacity_days=_days(weeks, wd),
                share_pct=YearRemaining(year=0.0, remaining=0.0),
                members=[cmap.name(m) for m in scope.member_ids if m != h.id],
                selected_member=(
                    cmap.name(scope.selected_member) if scope.selected_member is not None else None
                ),
            )
        )
    d_weeks = _sum([r.capacity_weeks for r in design_rows])
    for r in design_rows:
        r.share_pct = YearRemaining(
            year=_share(r.capacity_weeks.year, d_weeks.year),
            remaining=_share(r.capacity_weeks.remaining, d_weeks.remaining),
        )
    design_total = DesignTotal(
        engineer_count=sum(r.engineer_count for r in design_rows),
        fte_total=round2(sum(r.fte_total for r in design_rows)),
        capacity_weeks=d_weeks,
        capacity_days=_sum([r.capacity_days for r in design_rows]),
    )

    # Lab: the lab regions of the visible hubs (as hub-load's rows), each
    # region's chambers summed in code order exactly as hub-load does.
    regions = sorted({h.lab_region for h in hubs}, key=lambda r: r.value)
    calendars = await load_calendars_by_region(db)
    fraction = lab_remaining_fraction(current_week)
    lab_year: dict[LabRegion, float] = defaultdict(float)
    chamber_count: dict[LabRegion, int] = defaultdict(int)
    if regions:
        for c in (
            await db.execute(
                select(Chamber).where(Chamber.lab_region.in_(regions)).order_by(Chamber.code)
            )
        ).scalars().all():
            lab_year[c.lab_region] += chamber_figures(
                c, region_holiday_weeks(calendars, c.lab_region)
            ).efficient_lab_weeks
            chamber_count[c.lab_region] += 1
    lab_rows: list[LabRegionSummary] = []
    for region_value in regions:
        wd = region_weekdays_per_week(calendars, region_value)
        year = lab_year.get(region_value, 0.0)
        weeks = YearRemaining(year=round2(year), remaining=round2(year * fraction))
        lab_rows.append(
            LabRegionSummary(
                lab_region=region_value,
                chamber_count=chamber_count.get(region_value, 0),
                weekdays_per_week=wd,
                capacity_weeks=weeks,
                capacity_days=_days(weeks, wd),
                share_pct=YearRemaining(year=0.0, remaining=0.0),
            )
        )
    l_weeks = _sum([r.capacity_weeks for r in lab_rows])
    for lr in lab_rows:
        lr.share_pct = YearRemaining(
            year=_share(lr.capacity_weeks.year, l_weeks.year),
            remaining=_share(lr.capacity_weeks.remaining, l_weeks.remaining),
        )
    lab_total = LabTotal(
        chamber_count=sum(r.chamber_count for r in lab_rows),
        capacity_weeks=l_weeks,
        capacity_days=_sum([r.capacity_days for r in lab_rows]),
    )
    return CapacitySummaryResponse(
        current_week=current_week,
        design=DesignSummary(hubs=design_rows, total=design_total),
        lab=LabSummary(regions=lab_rows, total=lab_total),
    )


# --- §5 -------------------------------------------------------------------------------


def _check_len(name: str, values: list[object], limit: int) -> None:
    if len(values) > limit:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"At most {limit} values for {name}.",
        )


async def _in_scope_engineer_ids(
    db: AsyncSession, principal: Principal, requested: list[uuid.UUID]
) -> list[uuid.UUID]:
    """The requested engineer ids the caller may see (RBAC hub scope,
    `hub_scope_filter`), sorted as before. Unknown and out-of-scope ids are
    both dropped, so the two are indistinguishable (P19-R01, S19-M1). The
    optional `hub_id` / `region` filter is not applied here: it narrows the
    listed rows, not who the caller may filter by (unchanged semantics for
    an in-scope engineer of another hub)."""

    if not requested:
        return []
    stmt = select(Engineer.id).where(Engineer.id.in_(set(requested)))
    scope = hub_scope_filter(principal, Engineer.hub_id)
    if scope is not None:
        stmt = stmt.where(scope)
    visible = set((await db.execute(stmt)).scalars().all())
    return sorted(visible, key=str)


def _project_predicate(
    project_type: list[ProjectType],
    project_status: list[ProjectStatus],
    requesting_department: list[str],
    category: list[ProjectCategory],
    engineer_id: list[uuid.UUID],
    run_id: uuid.UUID,
) -> ColumnElement[bool] | None:
    """The project filters, ANDed. Bound parameters only.

    - `requesting_department`: exact match on `Project.requesting_department`
      (ADR 0035; the client workbook's value as written). A project with no
      department never matches a department filter.
    - `engineer_id`: projects with at least one step of the active run booked
      on one of the engineers. Callers pass only in-scope ids
      (`_in_scope_engineer_ids`, P19-R01), never the raw query values.
    """

    parts: list[ColumnElement[bool]] = []
    if project_type:
        parts.append(Project.type.in_(project_type))
    if project_status:
        parts.append(Project.status.in_(project_status))
    if category:
        parts.append(Project.category.in_(category))
    if requesting_department:
        parts.append(Project.requesting_department.in_(requesting_department))
    if engineer_id:
        parts.append(
            Project.id.in_(
                select(ScheduleRunProjectStep.project_id).where(
                    ScheduleRunProjectStep.schedule_run_id == run_id,
                    ScheduleRunProjectStep.assigned_engineer_id.in_(engineer_id),
                )
            )
        )
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else and_(*parts)


def _total(rows: list[EngineerResourceLoad] | list[ChamberResourceLoad]) -> ResourceLoadTotal:
    """Σ of the served rows. P29 (ADR 0042 §5): an engineer row with
    `counts_in_capacity` false adds its load but not its capacity (supply)."""

    supply = [r for r in rows if getattr(r, "counts_in_capacity", True)]
    cap = round2(sum(r.capacity_weeks for r in supply))
    load = round2(sum(r.load_weeks for r in rows))
    return ResourceLoadTotal(
        capacity_weeks=cap,
        load_weeks=load,
        utilization_pct=booked_pct(load, cap),
        capacity_days=round2(sum(r.capacity_days for r in supply)),
        load_days=round2(sum(r.load_days for r in rows)),
    )


@router.get("/resource-load", response_model=ResourceLoadResponse)
async def resource_load(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    project_type: list[ProjectType] = Query(default=[]),
    project_status: list[ProjectStatus] = Query(default=[]),
    requesting_department: list[str] = Query(default=[]),
    category: list[ProjectCategory] = Query(default=[]),
    engineer_id: list[uuid.UUID] = Query(default=[]),
    basis: CapacityBasis = "year",
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> ResourceLoadResponse:
    """Engineer and chamber load vs. capacity on `basis` (§5).

    `hub_id` / `region` choose which engineers and chambers are listed (RBAC
    scope ANDed, ADR 0020/0025). The project filters (`project_type`,
    `project_status`, `requesting_department`, `category`, `engineer_id`)
    restrict which projects' booked steps count as load; `engineer_id` also
    restricts the engineer rows. Capacity never depends on the project
    filters.

    P19-R01 (S19-M1): `engineer_id` is first intersected with the caller's
    hub scope; only in-scope ids filter anything or appear in
    `filters_applied`. If ids were sent and none is in scope (unknown and
    out-of-scope alike), the answer is the out-of-scope-hub shape: empty
    engineer and chamber lists and zero totals.

    Load has no basis: it is every booked week of the active run (I6/I7,
    spillover included), as on `/capacity/hub-load`.
    """

    _check_len("project_type", list(project_type), MAX_LIST_FILTER)
    _check_len("project_status", list(project_status), MAX_LIST_FILTER)
    _check_len("category", list(category), MAX_LIST_FILTER)
    _check_len("requesting_department", list(requesting_department), MAX_LIST_FILTER)
    _check_len("engineer_id", list(engineer_id), MAX_ENGINEER_FILTER)
    if any(len(d) > MAX_DEPARTMENT_LENGTH for d in requesting_department):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"requesting_department values are at most {MAX_DEPARTMENT_LENGTH} characters.",
        )
    types = sorted(set(project_type), key=list(ProjectType).index)
    statuses = sorted(set(project_status), key=list(ProjectStatus).index)
    categories = sorted(set(category), key=list(ProjectCategory).index)
    departments = sorted({d.strip() for d in requesting_department if d.strip()})
    # P19-R01 (S19-M1): the engineer filter is intersected with the caller's
    # RBAC scope BEFORE any predicate is built. An out-of-scope id must not
    # re-slice the region-wide chamber load (a per-engineer workload signal,
    # OQ #8), must not be echoed, and must behave exactly like an unknown id.
    engineer_ids = await _in_scope_engineer_ids(db, current_user, engineer_id)
    #: Ids were sent and none is visible: answer like an out-of-scope hub
    #: (empty lists, zero totals), never like "no engineer filter".
    no_visible_engineer = bool(engineer_id) and not engineer_ids

    current_week = dc.CURRENT_WEEK
    active_run = await get_active_run(db)

    # --- Engineers (hub scope AND hub/region, AND the engineer filter) --------
    eng_stmt = (
        select(Engineer)
        .join(Hub, Engineer.hub_id == Hub.id)
        .options(selectinload(Engineer.hub))
        .order_by(Hub.name, Engineer.name, Engineer.id)
    )
    # ADR 0042: engineers sit on capacity hubs, so a member-hub filter
    # (OEM-HCK) lists its capacity hub's engineers; the RBAC scope is unchanged.
    cmap = await load_capacity_hub_map(db)
    eng_filter = engineer_hub_filter(current_user, cmap, hub_id, region)
    if eng_filter is not None:
        eng_stmt = eng_stmt.where(eng_filter)
    if engineer_ids:
        eng_stmt = eng_stmt.where(Engineer.id.in_(engineer_ids))
    engineers: list[Engineer] = (
        [] if no_visible_engineer else list((await db.execute(eng_stmt)).scalars().all())
    )

    # --- Chambers (lab regions in scope, narrowed by hub/region) -------------
    ch_stmt = select(Chamber).order_by(Chamber.lab_region, Chamber.code)
    lab_regions = await narrowed_lab_regions(db, current_user, hub_id, region)
    if lab_regions is not None:
        ch_stmt = ch_stmt.where(Chamber.lab_region.in_(lab_regions))
    chambers: list[Chamber] = (
        [] if no_visible_engineer else list((await db.execute(ch_stmt)).scalars().all())
    )

    # --- Load from the active run --------------------------------------------
    eng_load: dict[uuid.UUID, float] = defaultdict(float)
    ch_load: dict[uuid.UUID, float] = defaultdict(float)
    if active_run is not None and (engineers or chambers):
        kinds = await step_kinds_for_run(db, active_run)
        predicate = _project_predicate(
            types, statuses, departments, categories, engineer_ids, active_run.id
        )
        base = (
            select(
                ScheduleRunProjectStep.step_template_id,
                ScheduleRunProjectStep.duration_weeks,
                ScheduleRunProjectStep.assigned_engineer_id,
                ScheduleRunProjectStep.assigned_chamber_id,
            )
            .join(Project, ScheduleRunProjectStep.project_id == Project.id)
            .where(
                ScheduleRunProjectStep.schedule_run_id == active_run.id,
                ScheduleRunProjectStep.skipped.is_(False),
            )
        )
        if predicate is not None:
            base = base.where(predicate)
        if engineers:
            for step_id, duration, eng_id, _ in (
                await db.execute(
                    base.where(
                        ScheduleRunProjectStep.assigned_engineer_id.in_([e.id for e in engineers])
                    )
                )
            ).all():
                if eng_id is not None and kinds.get(step_id) == WorkflowStepKind.DESIGN:
                    eng_load[eng_id] += duration
        if chambers:
            for step_id, duration, _, ch_id in (
                await db.execute(
                    base.where(
                        ScheduleRunProjectStep.assigned_chamber_id.in_([c.id for c in chambers])
                    )
                )
            ).all():
                if ch_id is not None and kinds.get(step_id) == WorkflowStepKind.LAB:
                    ch_load[ch_id] += duration * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK

    # --- Capacity (ADR 0008), same figures as /engineers and /chambers -------
    calendar_by_hub = {
        c.hub_id: c for c in (await db.execute(select(HubWorkCalendar))).scalars().all()
    }
    eng_rows: list[EngineerResourceLoad] = []
    for e in engineers:
        cal = calendar_by_hub.get(e.hub_id)
        year, remaining = design_capacity(cal, fte_sum([e.fte]), current_week)
        cap = round2(year if basis == "year" else remaining)
        load = round2(eng_load.get(e.id, 0.0))
        wd = hub_weekdays_per_week(cal)
        eng_rows.append(
            EngineerResourceLoad(
                engineer_id=e.id,
                name=e.name,
                hub=e.hub.name,
                counts_in_capacity=e.counts_in_capacity,
                weekdays_per_week=wd,
                capacity_weeks=cap,
                load_weeks=load,
                utilization_pct=booked_pct(load, cap),
                capacity_days=to_days(cap, wd),
                load_days=to_days(load, wd),
            )
        )

    calendars = await load_calendars_by_region(db)
    fraction = lab_remaining_fraction(current_week)
    ch_rows: list[ChamberResourceLoad] = []
    for c in chambers:
        eff = chamber_figures(c, region_holiday_weeks(calendars, c.lab_region)).efficient_lab_weeks
        cap = round2(eff if basis == "year" else eff * fraction)
        load = round2(ch_load.get(c.id, 0.0))
        wd = region_weekdays_per_week(calendars, c.lab_region)
        ch_rows.append(
            ChamberResourceLoad(
                chamber_id=c.id,
                code=c.code,
                lab_region=c.lab_region,
                weekdays_per_week=wd,
                capacity_weeks=cap,
                load_weeks=load,
                utilization_pct=booked_pct(load, cap),
                capacity_days=to_days(cap, wd),
                load_days=to_days(load, wd),
            )
        )

    filters = ResourceLoadFilters(
        hub_id=hub_id,
        region=region,
        project_type=types,
        project_status=statuses,
        requesting_department=departments,
        category=categories,
        engineer_id=engineer_ids,
        basis=basis,
    )
    await _audit_read(db, current_user, filters, len(eng_rows), len(ch_rows))
    return ResourceLoadResponse(
        has_active_schedule_run=active_run is not None,
        schedule_run_version=active_run.version if active_run is not None else None,
        current_week=active_run.current_week if active_run is not None else current_week,
        basis=basis,
        engineers=eng_rows,
        chambers=ch_rows,
        totals=ResourceLoadTotals(engineers=_total(eng_rows), chambers=_total(ch_rows)),
        filters_applied=filters,
    )


async def _audit_read(
    db: AsyncSession,
    principal: Principal,
    filters: ResourceLoadFilters,
    engineer_rows: int,
    chamber_rows: int,
) -> None:
    """One `planning.resource_load.read` row per user per filter set per
    minute (a burst of reloads must not grow the append-only table without
    bound). Records the filters and row counts, never a figure."""

    filter_key = json.dumps(filters.model_dump(mode="json"), sort_keys=True)
    recent = (
        await db.execute(
            select(AuditLogEntry.id)
            .where(
                AuditLogEntry.actor_user_id == principal.user_id,
                AuditLogEntry.action == AUDIT_ACTION,
                AuditLogEntry.occurred_at >= datetime.now(UTC) - timedelta(minutes=1),
                AuditLogEntry.after_state["filter_key"].astext == filter_key,
            )
            .limit(1)
        )
    ).first()
    if recent is None:
        db.add(
            AuditLogEntry(
                actor_user_id=principal.user_id,
                action=AUDIT_ACTION,
                entity_type="ResourceLoad",
                entity_id="resource-load",
                hub_id=filters.hub_id,
                before_state=None,
                after_state={
                    "filter_key": filter_key,
                    "engineer_rows": engineer_rows,
                    "chamber_rows": chamber_rows,
                },
            )
        )
    await db.commit()


# --- §6 -------------------------------------------------------------------------------


@router.get("/resource-load/options", response_model=ResourceLoadOptions)
async def resource_load_options(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> ResourceLoadOptions:
    """Filter-bar values from the caller's visible data (hub scope AND the
    optional `hub_id` / `region`): hubs, their lab regions, the distinct
    project types / statuses / categories of visible projects, and the
    visible engineers. Names only, no load figure, so not audit-logged
    (the same names `GET /engineers` serves). ADR 0035: the distinct
    requesting departments of the visible projects, sorted;
    `requesting_department_available` is true when there is at least one."""

    hub_stmt = select(Hub).order_by(Hub.name)
    hub_filter = narrowed_hub_filter(current_user, Hub.id, hub_id, region)
    if hub_filter is not None:
        hub_stmt = hub_stmt.where(hub_filter)
    hubs = (await db.execute(hub_stmt)).scalars().all()

    proj_stmt = select(
        Project.type, Project.status, Project.category, Project.requesting_department
    ).distinct()
    proj_filter = narrowed_hub_filter(current_user, Project.hub_id, hub_id, region)
    if proj_filter is not None:
        proj_stmt = proj_stmt.where(proj_filter)
    types: set[ProjectType] = set()
    statuses: set[ProjectStatus] = set()
    categories: set[ProjectCategory] = set()
    departments: set[str] = set()
    for p_type, p_status, p_category, p_department in (await db.execute(proj_stmt)).all():
        if p_type is not None:
            types.add(p_type)
        statuses.add(p_status)
        if p_category is not None:
            categories.add(p_category)
        if p_department is not None and p_department.strip():
            departments.add(p_department)

    eng_stmt = (
        select(Engineer.id, Engineer.name, Hub.name)
        .join(Hub, Engineer.hub_id == Hub.id)
        .order_by(Hub.name, Engineer.name, Engineer.id)
    )
    cmap = await load_capacity_hub_map(db)
    eng_filter = engineer_hub_filter(current_user, cmap, hub_id, region)
    if eng_filter is not None:
        eng_stmt = eng_stmt.where(eng_filter)
    engineers = [
        EngineerOption(engineer_id=e_id, name=e_name, hub=h_name)
        for e_id, e_name, h_name in (await db.execute(eng_stmt)).all()
    ]
    return ResourceLoadOptions(
        hubs=[h.name for h in hubs],
        lab_regions=sorted({h.lab_region for h in hubs}, key=lambda r: r.value),
        project_types=[t for t in ProjectType if t in types],
        project_statuses=[s for s in ProjectStatus if s in statuses],
        categories=[c for c in ProjectCategory if c in categories],
        requesting_departments=sorted(departments),
        requesting_department_available=bool(departments),
        engineers=engineers,
    )
