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

**Global hub filter (P12, ADR 0020).** Every GET here takes an optional
`hub_id`, ANDed with the RBAC scope (`services.hub_scope.narrowed_hub_filter`)
so it never widens it: an out-of-scope `hub_id` answers empty rows and zero
totals, not 403. Totals are computed here for the filtered set (I9, I23).

**Country filter (P13, ADR 0025).** Every GET here also takes an optional
`region` (`LabRegion`), ANDed with the scope and `hub_id` the same way.
`/region-summary` serves the per-country KPI chips; `/projects` is the
"All registered projects" register and `/projects/facets` its dropdowns.

**Multi-select (ADR 0051, `docs/API_CONTRACT_MULTISELECT.md`).** `hub_id` and
`region` are repeatable and UNIONED (hub listed OR its lab region listed),
always ANDed with the scope; an out-of-scope value contributes nothing. The
register's `status_`, `priority`, `leader_engineer_id` and `current_step` are
repeatable too (OR within a param, AND across). At most 50 values per param.

**Category / type selection (P31, `docs/API_CONTRACT_P31.md`).** Every GET
here also takes repeatable `category` and `type` params (OR within a param,
AND across params and with the hub / country filter; absent = all; one
value = the pre-P31 behaviour; `Unmapped` = IS NULL). One predicate,
`_dashboard_filter`, builds the set for every card, chart, count and the
register, so they reconcile for any selection (I9, I23).

Per Invariant I9 ("`within_year` count on the Dashboard equals the count of
projects satisfying the within-year rule in the current schedule run. No
independent calculation anywhere"): `completing_within_year` below is the only
endpoint in this file whose numbers come from a `ScheduleRun` snapshot table
(`ScheduleRunProjectOutcome`) — it does not recompute the within-year rule.
Every other endpoint here (pipeline totals, status overview, hub×type
summary, filtered project list) is portfolio-*composition* data straight off
the live `Project` table, not a scheduling outcome, so I9 does not apply to
them. P13-T10: `/analytics`'s `completing_*` lists read the same snapshot
rows (the exclusive `WITHIN_YEAR` bucket); its composition lists are live
`Project` data like pipeline totals.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import ColumnElement, Select, and_, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import require_permission
from api.errors import HTTP_422, CodedHTTPException
from api.query_params import (
    CurrentStepListQuery,
    DashboardCategoryListQuery,
    DashboardCategoryValue,
    DashboardTypeListQuery,
    DashboardTypeValue,
    HubIdListQuery,
    LeaderListQuery,
    PriorityListQuery,
    RegionListQuery,
    StatusListQuery,
)
from core.principal import Principal
from core.rbac import Action, Surface
from models.enums import (
    HubName,
    LabRegion,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    WorkflowStepStatus,
)
from models.hub import Hub
from models.project import Project
from models.schedule import PRE_P53_RULES_LABEL, ScheduleRun, ScheduleRunProjectOutcome
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from scheduling.weeks import year_of
from schemas.dashboard import (
    AnalyticsBucket,
    CompletingByHubRow,
    CompletingByTypeRow,
    CompletingHubTypeRow,
    CompletingWithinYear,
    CompletingWithinYearRow,
    DashboardAnalytics,
    DeliveryRegionRow,
    HubTypePipelineRow,
    NamedId,
    PipelineTotals,
    PriorityDeliveryBand,
    ProjectFacets,
    ProjectFilterResult,
    ProjectFilterRow,
    RegionSummary,
    RegionSummaryRow,
    ScheduleOutcome,
    StatusOverview,
    StepFacet,
)
from schemas.delivery import DeliveryDrillResponse, DeliveryDrillRow, DeliveryRowKind
from services.active_run import get_active_run
from services.band_rank import band_sizes
from services.capacity_supply import round2
from services.categories import load_catalog
from services.category_type_filter import any_of, category_type_filter
from services.delivery_serving import (
    delivery_year_of,
    is_p53_run,
    stored_delivery,
    stored_far_finish,
    stored_left_out_reason,
    tail_warning_counts,
)
from services.expected_status import expected_status_for, status_mismatch
from services.hub_scope import HubIdsArg, RegionsArg, narrowed_hub_filter
from services.outcome_buckets import (
    OutcomeBucket,
    outcome_bucket,
    priority_label,
    sql_bucket_within_year,
    sql_counting,
)
from services.plan_clock import PlanClock, get_plan_clock
from services.project_cards import build_project_cards
from services.text_search import project_search_filter

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

_read = require_permission(Surface.DASHBOARD, Action.READ)

#: ADR 0025 / contract §2: the chips' fixed order.
_REGION_ORDER = (LabRegion.GREECE, LabRegion.INDIA, LabRegion.ROMANIA)

#: P17-T03: statuses with no card of their own in the five-card overview.
_STATUS_CARD_REMAINDER = (
    ProjectStatus.IN_BUYOFF,
    ProjectStatus.DRAFT,
    ProjectStatus.CANCELLED,
)
_FOUR_SCHEDULABLE_STATUSES = (
    ProjectStatus.IN_BUYOFF,
    ProjectStatus.UNDER_INDUSTRIALIZATION,
    ProjectStatus.IN_DEVELOPMENT,
    ProjectStatus.IN_QUEUE,
)


def _dashboard_filter(
    current_user: Principal,
    hub_id: HubIdsArg,
    region: RegionsArg,
    category: list[DashboardCategoryValue] | None,
    type_: list[DashboardTypeValue] | None,
) -> ColumnElement[bool] | None:
    """The Dashboard's project filter: RBAC scope AND hub / country (ADR
    0020 / 0025, `narrowed_hub_filter`, never widens) AND the P31 category /
    type selection (OR within a param, AND across, `Unmapped` = IS NULL).
    `None` when nothing restricts the set."""

    clauses = [
        c
        for c in (
            narrowed_hub_filter(current_user, Project.hub_id, hub_id, region),
            category_type_filter(category, type_),
        )
        if c is not None
    ]
    if not clauses:
        return None
    return clauses[0] if len(clauses) == 1 else and_(*clauses)


@router.get("/pipeline-totals", response_model=PipelineTotals)
async def pipeline_totals(
    hub_id: HubIdListQuery = None,
    region: RegionListQuery = None,
    category: DashboardCategoryListQuery = None,
    type_: DashboardTypeListQuery = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PipelineTotals:
    """See `schemas.dashboard.PipelineTotals` (ADR 0030). Scope: every
    project (Commercialized included), hub-scoped (P3-T03) to the caller's own
    hub(s) unless `hub_scope_all`. One grouped query; the three buckets are
    mutually exclusive by construction.
    """

    stmt = select(Project.carry_over, Project.reg_year.is_(None), func.count())
    hub_filter = _dashboard_filter(current_user, hub_id, region, category, type_)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = await db.execute(stmt.group_by(Project.carry_over, Project.reg_year.is_(None)))
    spillover_count = new_count = unregistered_count = 0
    for carry_over, no_reg_year, count in result.all():
        if carry_over:
            spillover_count += count
        elif no_reg_year:
            unregistered_count += count
        else:
            new_count += count
    total = spillover_count + new_count + unregistered_count
    return PipelineTotals(
        spillover_count=spillover_count,
        new_count=new_count,
        unregistered_count=unregistered_count,
        total_count=total,
        spillover_share_pct=_share(spillover_count, total),
        new_share_pct=_share(new_count, total),
        unregistered_share_pct=_share(unregistered_count, total),
    )


@router.get("/status-overview", response_model=StatusOverview)
async def status_overview(
    hub_id: HubIdListQuery = None,
    region: RegionListQuery = None,
    category: DashboardCategoryListQuery = None,
    type_: DashboardTypeListQuery = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> StatusOverview:
    stmt = select(Project.status, func.count())
    hub_filter = _dashboard_filter(current_user, hub_id, region, category, type_)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = await db.execute(stmt.group_by(Project.status))
    counts_by_status = {row[0]: row[1] for row in result.all()}
    other_counts = {
        status.value: count
        for status, count in counts_by_status.items()
        if status not in _FOUR_SCHEDULABLE_STATUSES
    }
    in_development = counts_by_status.get(ProjectStatus.IN_DEVELOPMENT, 0)
    under_industrialization = counts_by_status.get(ProjectStatus.UNDER_INDUSTRIALIZATION, 0)
    in_queue = counts_by_status.get(ProjectStatus.IN_QUEUE, 0)
    commercialized = counts_by_status.get(ProjectStatus.COMMERCIALIZED, 0)
    on_hold = counts_by_status.get(ProjectStatus.ON_HOLD, 0)
    total = sum(counts_by_status.values())
    # Remainder = every status without a card (In Buyoff, Draft, Cancelled),
    # so the five cards + remainder == total exactly.
    remainder = {
        status.value: counts_by_status.get(status, 0)
        for status in _STATUS_CARD_REMAINDER
        if counts_by_status.get(status, 0)
    }
    other_statuses = sum(remainder.values())
    return StatusOverview(
        in_buyoff=counts_by_status.get(ProjectStatus.IN_BUYOFF, 0),
        under_industrialization=under_industrialization,
        in_development=in_development,
        in_queue=in_queue,
        other_counts=other_counts,
        commercialized_count=commercialized,
        on_hold_count=on_hold,
        total_count=total,
        in_development_share_pct=_share(in_development, total),
        under_industrialization_share_pct=_share(under_industrialization, total),
        in_queue_share_pct=_share(in_queue, total),
        commercialized_share_pct=_share(commercialized, total),
        on_hold_share_pct=_share(on_hold, total),
        other_statuses_count=other_statuses,
        other_statuses_counts=remainder,
        other_statuses_share_pct=_share(other_statuses, total),
    )


@router.get("/hub-type-pipeline", response_model=list[HubTypePipelineRow])
async def hub_type_pipeline(
    hub_id: HubIdListQuery = None,
    region: RegionListQuery = None,
    category: DashboardCategoryListQuery = None,
    type_: DashboardTypeListQuery = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[HubTypePipelineRow]:
    """Hub × type cross-tab, scope: every project (same "pipeline" scope as
    `pipeline_totals` above, ADR 0030), hub-scoped (P3-T03) — a
    Hub Planner's cross-tab naturally only shows rows for their own hub(s),
    since the query is driven off `Project.hub_id`.
    """

    stmt = select(Hub.name, Project.type, func.count()).join(Project, Project.hub_id == Hub.id)
    hub_filter = _dashboard_filter(current_user, hub_id, region, category, type_)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    # P30-R02 (gate N3 / QA 1b): fully deterministic order (hub name, then
    # type, NULL type last) so the row order never follows the query plan.
    result = await db.execute(
        stmt.group_by(Hub.name, Project.type).order_by(Hub.name, Project.type.asc().nulls_last())
    )
    return [
        HubTypePipelineRow(hub=hub_name, type=project_type, count=count)
        for hub_name, project_type, count in result.all()
    ]


def _has_stage_progress():  # type: ignore[no-untyped-def]
    """Correlated EXISTS: some stage of the project is not "Not Started". This
    is the scheduler's `progress_tracked` rule (`scheduling.workflow`), read
    from the stored stage rows."""

    return exists().where(
        ProjectWorkflowStep.project_id == Project.id,
        ProjectWorkflowStep.status != WorkflowStepStatus.NOT_STARTED,
    )


def _is_not_started(status: ProjectStatus, has_progress: bool) -> bool:
    return status == ProjectStatus.IN_QUEUE and not has_progress


_DELIVERY_BANDS = (
    ProjectPriority.P1,
    ProjectPriority.P2,
    ProjectPriority.P3,
    ProjectPriority.P4,
    ProjectPriority.Q,
)
_OTHER_STATUSES = {ProjectStatus.ON_HOLD, ProjectStatus.CANCELLED, ProjectStatus.DRAFT}


async def _priority_delivery(
    db: AsyncSession,
    run_id: uuid.UUID | None,
    current_user: Principal,
    hub_id: HubIdsArg,
    region: RegionsArg,
    category: list[DashboardCategoryValue] | None = None,
    type_: list[DashboardTypeValue] | None = None,
) -> list[PriorityDeliveryBand]:
    """P17-R03: per-band delivery split, counted over EVERY project in scope
    and filter (LEFT JOIN to the active run's outcome for `within_year`, the
    same `within_year AND NOT blocked` bucket as the counts). Delivered =
    Commercialized; other = On Hold / Cancelled / Draft (they never complete,
    so never count as within-year); the rest is in flight or not started.
    """

    stmt = select(
        Project.priority,
        Project.status,
        _has_stage_progress(),
        # P42 (R42-6): the exclusive WITHIN_YEAR bucket, counting rows only.
        func.coalesce(sql_bucket_within_year(), False),
        # P42: the stored flags; no outcome row = counting (the column default).
        func.coalesce(ScheduleRunProjectOutcome.not_scheduled_priority, False),
        func.coalesce(ScheduleRunProjectOutcome.counts_toward_year, True),
    ).select_from(Project)
    stmt = stmt.outerjoin(
        ScheduleRunProjectOutcome,
        (ScheduleRunProjectOutcome.project_id == Project.id)
        & (ScheduleRunProjectOutcome.schedule_run_id == run_id),
    )
    hub_filter = _dashboard_filter(current_user, hub_id, region, category, type_)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    grouped = (await db.execute(stmt)).all()

    acc = {
        p: dict.fromkeys(("if", "ifw", "ns", "nsw", "dl", "dlw", "ot", "q", "nsp", "ifc", "nsc"), 0)
        for p in _DELIVERY_BANDS
    }
    for priority, status, has_progress, wy, nsp, counts in grouped:
        count = 1
        if priority is None:
            continue
        a = acc[priority]
        counting = counts and not nsp
        if nsp:
            a["nsp"] += count
        elif not counts:
            a["q"] += count
        if status == ProjectStatus.COMMERCIALIZED:
            a["dl"] += count
            a["dlw"] += count if wy else 0
        elif status in _OTHER_STATUSES:
            a["ot"] += count
        elif _is_not_started(status, has_progress):
            a["ns"] += count
            a["nsw"] += count if wy else 0
            a["nsc"] += count if counting else 0
        else:
            a["if"] += count
            a["ifw"] += count if wy else 0
            a["ifc"] += count if counting else 0

    bands: list[PriorityDeliveryBand] = []
    for priority in _DELIVERY_BANDS:
        a = acc[priority]
        total = a["if"] + a["ns"] + a["dl"] + a["ot"]
        within = a["ifw"] + a["nsw"] + a["dlw"]
        counting_total = total - a["q"] - a["nsp"]
        bands.append(
            PriorityDeliveryBand(
                priority=priority,
                priority_label=priority_label(priority) or priority.value,
                total=total,
                within_year=within,
                in_flight_total=a["if"],
                in_flight_within_year=a["ifw"],
                not_started_total=a["ns"],
                not_started_within_year=a["nsw"],
                delivered_total=a["dl"],
                delivered_within_year=a["dlw"],
                other_total=a["ot"],
                queued_total=a["q"],
                not_scheduled_priority_total=a["nsp"],
                counting_total=counting_total,
                in_flight_counting_total=a["ifc"],
                not_started_counting_total=a["nsc"],
                within_year_share_pct=_share(within, counting_total),
                in_flight_within_year_share_pct=_share(a["ifw"], a["ifc"]),
                not_started_within_year_share_pct=_share(a["nsw"], a["nsc"]),
                in_flight_share_pct=_share(a["if"], total),
                not_started_share_pct=_share(a["ns"], total),
                delivered_share_pct=_share(a["dl"], total),
                other_share_pct=_share(a["ot"], total),
            )
        )
    return bands


@router.get("/completing-within-year", response_model=CompletingWithinYear)
async def completing_within_year(
    hub_id: HubIdListQuery = None,
    region: RegionListQuery = None,
    category: DashboardCategoryListQuery = None,
    type_: DashboardTypeListQuery = None,
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
            blocked_count=0,
            queued_count=0,
            not_scheduled_priority_count=0,
            excluded_count=0,
            counting_outcome_count=0,
            within_year_share_pct=0.0,
            rows=[],
            priority_delivery=await _priority_delivery(
                db, None, current_user, hub_id, region, category, type_
            ),
            regions=_delivery_regions({}),
            delivery_by_year_unavailable="no_active_run",
        )

    stmt = (
        select(ScheduleRunProjectOutcome, Project, _has_stage_progress())
        .join(Project, ScheduleRunProjectOutcome.project_id == Project.id)
        .options(selectinload(Project.hub))
        .where(ScheduleRunProjectOutcome.schedule_run_id == active_run.id)
    )
    hub_filter = _dashboard_filter(current_user, hub_id, region, category, type_)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    # P30-R02 (gate N3): deterministic row order (project name, then id).
    result = await db.execute(stmt.order_by(Project.name, Project.id))
    rows: list[CompletingWithinYearRow] = []
    # P42 (R42-6): one exclusive bucket per row, precedence
    # NOT_SCHEDULED_PRIORITY > QUEUED > BLOCKED > WITHIN_YEAR > SPILLOVER >
    # LEFT_OUT (`services.outcome_buckets`). P9-F02's "Blocked wins over the
    # year flags" is kept below the two non-counting buckets.
    totals: dict[str, int] = dict.fromkeys(_BUCKET_KEYS.values(), 0)
    excluded_count = 0
    # Owner request 2026-11-16: the same buckets per lab region (the hub's
    # `lab_region`, as ADR 0025's country filter and /region-summary use).
    by_region: dict[LabRegion, dict[str, int]] = {}
    kept_outcomes: list[ScheduleRunProjectOutcome] = []
    run_week = active_run.current_week
    for outcome, project, has_progress in result.all():
        kept_outcomes.append(outcome)
        row_bucket = outcome_bucket(outcome)
        if row_bucket is None:
            excluded_count += 1
        else:
            key = _BUCKET_KEYS[row_bucket]
            totals[key] += 1
            counts = by_region.setdefault(project.hub.lab_region, {})
            counts[key] = counts.get(key, 0) + 1
        rows.append(
            CompletingWithinYearRow(
                project_id=project.id,
                project_name=project.name,
                hub=project.hub.name,
                category=project.category,
                priority=project.priority,
                type=project.type,
                within_year=outcome.within_year,
                spillover=outcome.spillover,
                left_out=outcome.left_out,
                blocked=outcome.blocked,
                cat_not_allowed=outcome.cat_not_allowed,
                last_step_end_week=outcome.last_step_end_week,
                status=project.status,
                not_started=_is_not_started(project.status, has_progress),
                counts_toward_year=outcome.counts_toward_year,
                not_scheduled_priority=outcome.not_scheduled_priority,
                outcome=row_bucket,
                priority_label=priority_label(project.priority),
                projected_end_week=outcome.projected_end_week,
                priority_at_run=outcome.priority_at_run,
                delivery_year=delivery_year_of(outcome, run_week),
                left_out_reason=stored_left_out_reason(outcome, active_run),
                far_finish=stored_far_finish(outcome, run_week),
            )
        )

    counting = (
        totals["within_year_count"]
        + totals["spillover_count"]
        + totals["left_out_count"]
        + totals["blocked_count"]
    )
    return CompletingWithinYear(
        has_active_schedule_run=True,
        schedule_run_version=active_run.version,
        within_year_count=totals["within_year_count"],
        spillover_count=totals["spillover_count"],
        left_out_count=totals["left_out_count"],
        blocked_count=totals["blocked_count"],
        queued_count=totals["queued_count"],
        not_scheduled_priority_count=totals["not_scheduled_priority_count"],
        excluded_count=excluded_count,
        counting_outcome_count=counting,
        within_year_share_pct=_share(totals["within_year_count"], counting),
        rows=rows,
        priority_delivery=await _priority_delivery(
            db, active_run.id, current_user, hub_id, region, category, type_
        ),
        regions=_delivery_regions(by_region),
        # P53 (R53-3, I59): over exactly the rows above.
        delivery_by_year=stored_delivery(active_run, kept_outcomes),
        delivery_by_year_unavailable=None if is_p53_run(active_run) else "pre_p53_run",
        rules_epoch=active_run.rules_epoch,
        rules_label=None if is_p53_run(active_run) else PRE_P53_RULES_LABEL,
        tail_warnings=await tail_warning_counts(db, active_run, kept_outcomes),
    )


@router.get("/delivery-by-year/projects", response_model=DeliveryDrillResponse)
async def delivery_by_year_projects(
    kind: DeliveryRowKind,
    year: int | None = Query(default=None, ge=2026, le=2126),
    band: Literal["P1", "P2", "P3"] | None = None,
    hub_id: HubIdListQuery = None,
    region: RegionListQuery = None,
    category: DashboardCategoryListQuery = None,
    type_: DashboardTypeListQuery = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> DeliveryDrillResponse:
    """P53 (R53-3) drill-in: the projects of one delivery-table cell, over the
    same hub scope and filters as `/completing-within-year`. 404
    `NO_ACTIVE_RUN` without an active run; empty for a pre-P53 run."""

    if kind in ("by_end_of_year", "year") and year is None:
        raise CodedHTTPException(HTTP_422, "YEAR_REQUIRED", "year is required for a by-year row.")
    active_run = await get_active_run(db)
    if active_run is None:
        raise CodedHTTPException(404, "NO_ACTIVE_RUN", "There is no active schedule run.")
    if not is_p53_run(active_run):
        return DeliveryDrillResponse(
            schedule_run_version=active_run.version,
            kind=kind,
            year=year,
            band=band,
            delivery_by_year_unavailable="pre_p53_run",
            rows=[],
        )
    stmt = (
        select(ScheduleRunProjectOutcome, Project)
        .join(Project, ScheduleRunProjectOutcome.project_id == Project.id)
        .options(selectinload(Project.hub))
        .where(ScheduleRunProjectOutcome.schedule_run_id == active_run.id)
    )
    hub_filter = _dashboard_filter(current_user, hub_id, region, category, type_)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    run_week = active_run.current_week
    y0 = year_of(run_week)
    rows: list[DeliveryDrillRow] = []
    for outcome, project in (await db.execute(stmt.order_by(Project.name, Project.id))).all():
        if outcome.not_scheduled_priority or not outcome.counts_toward_year:
            continue
        band_key = outcome.priority_at_run
        if band is not None and band_key != band:
            continue
        d_year = delivery_year_of(outcome, run_week)
        if kind == "blocked":
            keep = outcome.blocked
        elif kind == "not_placed":
            keep = outcome.left_out and not outcome.blocked
        elif kind == "by_end_of_year":
            keep = d_year is not None and d_year == y0 and year == y0
        else:
            keep = d_year is not None and d_year == year and d_year != y0
        if not keep:
            continue
        rows.append(
            DeliveryDrillRow(
                project_id=project.id,
                project_name=project.name,
                hub=project.hub.name.value,
                band=band_key,
                completion_week=outcome.projected_end_week,
                delivery_year=d_year,
                far_finish=stored_far_finish(outcome, run_week),
                left_out_reason=stored_left_out_reason(outcome, active_run),
            )
        )
    return DeliveryDrillResponse(
        schedule_run_version=active_run.version,
        kind=kind,
        year=year,
        band=band,
        rows=rows,
    )


def _delivery_regions(by_region: dict[LabRegion, dict[str, int]]) -> list[DeliveryRegionRow]:
    """`CompletingWithinYear.regions`: Greece, India, Romania in that order
    (`_REGION_ORDER`, as /region-summary), zero rows included."""

    return [
        DeliveryRegionRow(
            region=r,
            within_year_count=by_region.get(r, {}).get("within_year_count", 0),
            spillover_count=by_region.get(r, {}).get("spillover_count", 0),
            left_out_count=by_region.get(r, {}).get("left_out_count", 0),
            blocked_count=by_region.get(r, {}).get("blocked_count", 0),
            queued_count=by_region.get(r, {}).get("queued_count", 0),
            not_scheduled_priority_count=by_region.get(r, {}).get(
                "not_scheduled_priority_count", 0
            ),
        )
        for r in _REGION_ORDER
    ]


@router.get("/region-summary", response_model=RegionSummary)
async def region_summary(
    hub_id: HubIdListQuery = None,
    region: RegionListQuery = None,
    category: DashboardCategoryListQuery = None,
    type_: DashboardTypeListQuery = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> RegionSummary:
    """P13 (ADR 0025 §4): per-country counts for the KPI-card chips. Same
    scope and filter as `/pipeline-totals` and `/status-overview`; the
    pipeline figures use `PipelineTotals`' basis (every project, ADR 0030)
    and `status_counts` the `StatusOverview` basis (every status), so each
    chip row reconciles with the card it sits under. The browser never sums.
    """

    no_reg_year = Project.reg_year.is_(None)
    stmt = select(
        Hub.lab_region, Project.status, Project.carry_over, no_reg_year, func.count()
    ).join(Hub, Project.hub_id == Hub.id)
    hub_filter = _dashboard_filter(current_user, hub_id, region, category, type_)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = await db.execute(
        stmt.group_by(Hub.lab_region, Project.status, Project.carry_over, no_reg_year)
    )

    status_counts: dict[LabRegion, dict[str, int]] = {
        r: {s.value: 0 for s in ProjectStatus} for r in LabRegion
    }
    spillover: dict[LabRegion, int] = dict.fromkeys(LabRegion, 0)
    new: dict[LabRegion, int] = dict.fromkeys(LabRegion, 0)
    unregistered: dict[LabRegion, int] = dict.fromkeys(LabRegion, 0)
    for lab_region, status, carry_over, is_unregistered, count in result.all():
        status_counts[lab_region][status.value] += count
        if carry_over:
            spillover[lab_region] += count
        elif is_unregistered:
            unregistered[lab_region] += count
        else:
            new[lab_region] += count

    spillover_total = sum(spillover.values())
    new_total = sum(new.values())
    unregistered_total = sum(unregistered.values())
    total = spillover_total + new_total + unregistered_total
    status_totals = {
        s.value: sum(status_counts[r][s.value] for r in LabRegion) for s in ProjectStatus
    }
    rows = [
        RegionSummaryRow(
            region=r,
            total_count=spillover[r] + new[r] + unregistered[r],
            share_pct=_share(spillover[r] + new[r] + unregistered[r], total),
            spillover_count=spillover[r],
            newly_registered_count=new[r],
            unregistered_count=unregistered[r],
            spillover_share_pct=_share(spillover[r], spillover_total),
            newly_registered_share_pct=_share(new[r], new_total),
            unregistered_share_pct=_share(unregistered[r], unregistered_total),
            status_counts=status_counts[r],
            status_share_pct={
                key: _share(count, status_totals[key]) for key, count in status_counts[r].items()
            },
        )
        for r in _REGION_ORDER
    ]
    return RegionSummary(total_count=total, regions=rows)


#: P13-T10: bucket key for a null type / category, and for a null reg_year.
_UNMAPPED = "Unmapped"
_UNKNOWN_YEAR = "Unknown"


@router.get("/analytics", response_model=DashboardAnalytics)
async def dashboard_analytics(
    hub_id: HubIdListQuery = None,
    region: RegionListQuery = None,
    category: DashboardCategoryListQuery = None,
    type_: DashboardTypeListQuery = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> DashboardAnalytics:
    """P13-T10 (`docs/API_CONTRACT_P13.md` §5): the composition charts (by
    type, category, hub, registration year) and the "completing within
    year" Hub × Type cross-tab.

    Basis: the `/pipeline-totals` basis (every project, ADR 0030), scoped and
    filtered by `narrowed_hub_filter`, so every list sums to that card's
    `total_count`. "Completing" is the active run's exclusive `WITHIN_YEAR`
    bucket (`within_year AND NOT blocked`, as `/completing-within-year`
    counts it), read from the run's snapshot rows (I9), never recomputed.
    Two grouped aggregate queries plus one hub query; every share is computed
    here (I19).
    """

    hub_filter = _dashboard_filter(current_user, hub_id, region, category, type_)
    pipeline_stmt = select(
        Hub.name, Project.type, Project.category, Project.reg_year, func.count()
    ).join(Hub, Project.hub_id == Hub.id)
    if hub_filter is not None:
        pipeline_stmt = pipeline_stmt.where(hub_filter)
    grouped = (
        await db.execute(
            pipeline_stmt.group_by(Hub.name, Project.type, Project.category, Project.reg_year)
        )
    ).all()

    hub_names_filter = narrowed_hub_filter(current_user, Hub.id, hub_id, region)
    hubs_stmt = select(Hub.name).order_by(Hub.name)
    if hub_names_filter is not None:
        hubs_stmt = hubs_stmt.where(hub_names_filter)
    hub_names = list((await db.execute(hubs_stmt)).scalars().all())

    by_type: dict[ProjectType | None, int] = dict.fromkeys(ProjectType, 0)
    # P33-T07 (ADR 0047 §4): every category of the table, in rank order.
    category_codes = (await load_catalog(db)).codes
    by_category: dict[str | None, int] = dict.fromkeys(category_codes, 0)
    by_hub: dict[str, int] = {h.value: 0 for h in hub_names}
    by_year: dict[int | None, int] = {}
    hub_type: dict[tuple[str, ProjectType | None], int] = {}
    total = 0
    # Loop names differ from the `category` / `type_` filter params on purpose.
    for hub_name, row_type, row_category, reg_year, count in grouped:
        total += count
        by_type[row_type] = by_type.get(row_type, 0) + count
        by_category[row_category] = by_category.get(row_category, 0) + count
        by_hub[hub_name.value] = by_hub.get(hub_name.value, 0) + count
        by_year[reg_year] = by_year.get(reg_year, 0) + count
        key = (hub_name.value, row_type)
        hub_type[key] = hub_type.get(key, 0) + count

    def _buckets(counts: dict[str, int]) -> list[AnalyticsBucket]:
        return [
            AnalyticsBucket(key=k, count=c, share_pct=_share(c, total)) for k, c in counts.items()
        ]

    type_counts = {t.value: by_type[t] for t in ProjectType}
    if by_type.get(None):
        type_counts[_UNMAPPED] = by_type[None]
    category_counts = {c: by_category[c] for c in category_codes}
    if by_category.get(None):
        category_counts[_UNMAPPED] = by_category[None]
    year_counts = {str(y): by_year[y] for y in sorted(y for y in by_year if y is not None)}
    if by_year.get(None):
        year_counts[_UNKNOWN_YEAR] = by_year[None]

    active_run = await get_active_run(db)
    completing_hub_type: list[CompletingHubTypeRow] = []
    completing_by_type: list[CompletingByTypeRow] = []
    completing_by_hub: list[CompletingByHubRow] = []
    if active_run is not None:
        completing_stmt = (
            select(Hub.name, Project.type, func.count())
            .select_from(ScheduleRunProjectOutcome)
            .join(Project, ScheduleRunProjectOutcome.project_id == Project.id)
            .join(Hub, Project.hub_id == Hub.id)
            .where(
                ScheduleRunProjectOutcome.schedule_run_id == active_run.id,
                # P42 (R42-6): the exclusive WITHIN_YEAR bucket, counting only.
                sql_bucket_within_year(),
            )
        )
        if hub_filter is not None:
            completing_stmt = completing_stmt.where(hub_filter)
        completing: dict[tuple[str, ProjectType | None], int] = {
            (done_hub.value, done_type): done_count
            for done_hub, done_type, done_count in (
                await db.execute(completing_stmt.group_by(Hub.name, Project.type))
            ).all()
        }
        # P42 (I53): the cell's non-counting projects (QUEUED or
        # NOT_SCHEDULED_PRIORITY in the active run) leave the denominator.
        non_counting_stmt = (
            select(Hub.name, Project.type, func.count())
            .select_from(ScheduleRunProjectOutcome)
            .join(Project, ScheduleRunProjectOutcome.project_id == Project.id)
            .join(Hub, Project.hub_id == Hub.id)
            .where(
                ScheduleRunProjectOutcome.schedule_run_id == active_run.id,
                ~sql_counting(),
            )
        )
        if hub_filter is not None:
            non_counting_stmt = non_counting_stmt.where(hub_filter)
        non_counting: dict[tuple[str, ProjectType | None], int] = {
            (nc_hub.value, nc_type): nc_count
            for nc_hub, nc_type, nc_count in (
                await db.execute(non_counting_stmt.group_by(Hub.name, Project.type))
            ).all()
        }
        type_order: dict[ProjectType | None, int] = {t: i for i, t in enumerate(ProjectType)}
        type_order[None] = len(type_order)
        hub_order = {h: i for i, h in enumerate(by_hub)}
        for cell in sorted(
            hub_type, key=lambda k: (hub_order.get(k[0], len(hub_order)), type_order[k[1]])
        ):
            pipeline = hub_type[cell]
            done = completing.get(cell, 0)
            cell_counting = pipeline - non_counting.get(cell, 0)
            completing_hub_type.append(
                CompletingHubTypeRow(
                    hub=HubName(cell[0]),
                    type=cell[1],
                    pipeline_count=pipeline,
                    completing_count=done,
                    counting_count=cell_counting,
                    completing_pct=_share(done, cell_counting),
                )
            )
        done_by_type: dict[str, int] = {}
        for (_, done_type), done_count in completing.items():
            type_key = done_type.value if done_type is not None else _UNMAPPED
            done_by_type[type_key] = done_by_type.get(type_key, 0) + done_count
        nc_by_type: dict[str, int] = {}
        for (_, nc_type), nc_count in non_counting.items():
            type_key = nc_type.value if nc_type is not None else _UNMAPPED
            nc_by_type[type_key] = nc_by_type.get(type_key, 0) + nc_count
        completing_by_type = [
            CompletingByTypeRow(
                key=type_key,
                pipeline_count=type_pipeline,
                completing_count=done_by_type.get(type_key, 0),
                counting_count=type_pipeline - nc_by_type.get(type_key, 0),
                completing_pct=_share(
                    done_by_type.get(type_key, 0), type_pipeline - nc_by_type.get(type_key, 0)
                ),
            )
            for type_key, type_pipeline in type_counts.items()
        ]
        # The per-hub Total column: the sum of each hub's cells above.
        hub_totals: dict[str, list[int]] = {}
        for cell_row in completing_hub_type:
            totals = hub_totals.setdefault(cell_row.hub.value, [0, 0, 0])
            totals[0] += cell_row.pipeline_count
            totals[1] += cell_row.completing_count
            totals[2] += cell_row.counting_count
        completing_by_hub = [
            CompletingByHubRow(
                key=HubName(hub_key),
                pipeline_count=hub_pipeline,
                completing_count=hub_done,
                counting_count=hub_counting,
                completing_pct=_share(hub_done, hub_counting),
            )
            for hub_key, (hub_pipeline, hub_done, hub_counting) in hub_totals.items()
        ]

    return DashboardAnalytics(
        by_type=_buckets(type_counts),
        by_category=_buckets(category_counts),
        by_hub=_buckets(by_hub),
        by_reg_year=_buckets(year_counts),
        completing_hub_type=completing_hub_type,
        completing_by_type=completing_by_type,
        completing_by_hub=completing_by_hub,
        has_active_schedule_run=active_run is not None,
    )


def _share(part: int, whole: int) -> float:
    return round2(part / whole * 100) if whole else 0.0


def _register_stmt(
    current_user: Principal,
    *,
    hub_id: HubIdsArg,
    region: RegionsArg,
    category: list[DashboardCategoryValue] | None = None,
    status_: Sequence[ProjectStatus] | None = None,
    priority: Sequence[ProjectPriority] | None = None,
    q: str | None = None,
    type_: list[DashboardTypeValue] | None = None,
    leader_engineer_id: Sequence[uuid.UUID] | None = None,
) -> Select[Project]:
    """The register's scoped, filtered project set. Every predicate is a
    SQLAlchemy expression with bound parameters; nothing is interpolated.

    P17-R09: `type_ == "Unmapped"` (the analytics bucket key, `_UNMAPPED`)
    selects `Project.type IS NULL`, so the list equals the `/analytics`
    `by_type` "Unmapped" bucket for the same scope and filter.

    P31: `category` and `type_` are lists (OR within, AND across, empty =
    all); the same predicate as every Dashboard aggregate
    (`_dashboard_filter`), so the register reconciles with the cards."""

    stmt = select(Project).options(selectinload(Project.hub), selectinload(Project.leader_engineer))
    hub_filter = _dashboard_filter(current_user, hub_id, region, category, type_)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    # ADR 0051: each list is ORed (`IN`), the lists ANDed; empty = no filter.
    for column, values in (
        (Project.status, status_),
        (Project.priority, priority),
        (Project.leader_engineer_id, leader_engineer_id),
    ):
        predicate = any_of(column, values)
        if predicate is not None:
            stmt = stmt.where(predicate)
    search = project_search_filter(q)
    if search is not None:
        stmt = stmt.where(search)
    return stmt


def _leader_name_if_self(project: Project, current_user: Principal) -> str | None:
    """ADR 0028: the leader's name is served to any caller who can read the project."""

    leader = project.leader_engineer
    return leader.name if leader is not None else None


def _outcome_bucket(outcome: ScheduleRunProjectOutcome | None) -> ScheduleOutcome | None:
    """The exclusive bucket `/completing-within-year` counts (P9-F02; P42
    R42-6 precedence, `services.outcome_buckets`)."""

    return outcome_bucket(outcome)


#: `OutcomeBucket` → the `CompletingWithinYear` count field it feeds.
_BUCKET_KEYS: dict[OutcomeBucket, str] = {
    "NOT_SCHEDULED_PRIORITY": "not_scheduled_priority_count",
    "QUEUED": "queued_count",
    "BLOCKED": "blocked_count",
    "WITHIN_YEAR": "within_year_count",
    "SPILLOVER": "spillover_count",
    "LEFT_OUT": "left_out_count",
}


@router.get("/projects", response_model=ProjectFilterResult)
async def analytics_projects(
    hub_id: HubIdListQuery = None,
    category: DashboardCategoryListQuery = None,
    status_: StatusListQuery = None,
    priority: PriorityListQuery = None,
    region: RegionListQuery = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    type_: DashboardTypeListQuery = None,
    leader_engineer_id: LeaderListQuery = None,
    current_step: CurrentStepListQuery = None,
    sort: Literal["name", "priority"] = "name",
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> ProjectFilterResult:
    """ "An analytics breakdown with filters (by hub, category, status,
    priority)" (`docs/PROJECT_AND_STACK.md` §2), hub-scoped (P3-T03), upgraded
    to the "All registered projects" register in P13 (ADR 0025 §5,
    `docs/API_CONTRACT_P13.md` §3). Every filter is ANDed server-side.
    `type` is a `ProjectType` or the sentinel "Unmapped" (null type,
    P17-R09); any other value is 422. P31: `category` and `type` are
    repeatable (OR within a param, AND across; `Unmapped` also on
    `category`); `total_count` is the full filtered set.

    Bulk loads only: hub and leader by `selectinload`, then one
    `build_project_cards` pass (scores, live steps, run steps, outcomes,
    due stages) and one outcome query for the whole set. No financial field
    is read into the row.

    P35-T01 (D35-1/D35-3): rows also carry `actual_start_week`,
    `actual_end_week`, the effort figures and `design_weeks_calculated` /
    `lab_weeks_calculated`, summed by the card builder from the live step
    rows it already loads (no extra query).
    """

    stmt = _register_stmt(
        current_user,
        hub_id=hub_id,
        region=region,
        category=category,
        status_=status_,
        priority=priority,
        q=q,
        type_=type_,
        leader_engineer_id=leader_engineer_id,
    )
    projects = list((await db.execute(stmt.order_by(Project.name, Project.id))).scalars().all())
    active_run = await get_active_run(db)
    # P12 (ADR 0021 §4): tracking status comes from the card builder, which
    # calls the one tracking-status implementation (`services.tracking`).
    cards = await build_project_cards(db, projects, active_run, current_week=clock.week)
    if current_step:
        steps = set(current_step)
        projects = [
            p
            for p in projects
            if (stage := cards[p.id].current_stage) is not None and stage.step_id in steps
        ]

    outcomes: dict[uuid.UUID, ScheduleRunProjectOutcome] = {}
    if active_run is not None and projects:
        outcomes = {
            o.project_id: o
            for o in (
                await db.execute(
                    select(ScheduleRunProjectOutcome).where(
                        ScheduleRunProjectOutcome.schedule_run_id == active_run.id,
                        ScheduleRunProjectOutcome.project_id.in_([p.id for p in projects]),
                    )
                )
            ).scalars()
        }

    scored = sorted(
        (p for p in projects if cards[p.id].score is not None),
        key=lambda p: (-(cards[p.id].score or 0.0), p.name, str(p.id)),
    )
    rank = {p.id: i for i, p in enumerate(scored, start=1)}
    if sort == "priority":
        projects.sort(key=lambda p: (rank.get(p.id, len(rank) + 1), p.name, str(p.id)))

    # P54 (ADR 0064 R1): one grouped count (full band, all hubs) per request.
    sizes = await band_sizes(db)
    rows: list[ProjectFilterRow] = []
    for p in projects:
        card = cards[p.id]
        outcome = outcomes.get(p.id)
        stage = card.current_stage
        # P35-T08b (OQ #84 assumption): from the same current stage served
        # as `current_step_code`; display only.
        expected = expected_status_for(p.status, stage.step_id if stage is not None else None)
        rows.append(
            ProjectFilterRow(
                project_id=p.id,
                project_name=p.name,
                hub=p.hub.name,
                category=p.category,
                status=p.status,
                priority=p.priority,
                is_vip=p.is_vip,
                tracking_status=card.tracking_status,
                external_code=p.external_code,
                type=p.type,
                region=p.hub.lab_region,
                leader_name=_leader_name_if_self(p, current_user),
                leader_engineer_id=p.leader_engineer_id,
                current_step_code=stage.step_id if stage is not None else None,
                current_step_name=stage.step_name if stage is not None else None,
                end_week=outcome.projected_end_week if outcome is not None else None,
                outcome=_outcome_bucket(outcome),
                priority_label=priority_label(p.priority),
                counts_toward_year=outcome.counts_toward_year if outcome is not None else None,
                not_scheduled_priority=(
                    outcome.not_scheduled_priority if outcome is not None else None
                ),
                reg_year=p.reg_year,
                carry_over=p.carry_over,
                plant=p.plant,
                requesting_department=p.requesting_department,
                product_type=p.product_type,
                priority_rank=rank.get(p.id),
                actual_start_week=p.actual_start_week,
                actual_end_week=p.actual_end_week,
                design_effort_weeks=_figure(p.design_effort_weeks),
                lab_effort_weeks=_figure(p.lab_effort_weeks),
                design_weeks_calculated=card.design_weeks_calculated,
                lab_weeks_calculated=card.lab_weeks_calculated,
                expected_status=expected,
                status_mismatch=status_mismatch(p.status, expected),
                band_rank=p.band_rank,
                band_size=(
                    sizes.get(p.priority, 0)
                    if p.band_rank is not None and p.priority is not None
                    else None
                ),
            )
        )
    return ProjectFilterResult(total_count=len(rows), rows=rows)


def _figure(value: Decimal | None) -> float | None:
    """ADR 0041 effort figure (`Numeric(6, 2)`) as served by `ProjectRead`."""

    return float(value) if value is not None else None


@router.get("/projects/facets", response_model=ProjectFacets)
async def analytics_project_facets(
    hub_id: HubIdListQuery = None,
    region: RegionListQuery = None,
    category: DashboardCategoryListQuery = None,
    type_: DashboardTypeListQuery = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> ProjectFacets:
    """P13 §3: the leader and current-step values present in the caller's
    scoped, hub/region-filtered set, so the register's dropdowns only offer
    values that exist. Leader names follow OQ#8 (null unless the caller)."""

    stmt = _register_stmt(
        current_user, hub_id=hub_id, region=region, category=category, type_=type_
    )
    projects = list((await db.execute(stmt)).scalars().all())
    cards = await build_project_cards(
        db, projects, await get_active_run(db), current_week=clock.week
    )

    leaders: dict[uuid.UUID, NamedId] = {}
    for p in projects:
        if p.leader_engineer_id is not None and p.leader_engineer_id not in leaders:
            leaders[p.leader_engineer_id] = NamedId(
                id=p.leader_engineer_id, name=_leader_name_if_self(p, current_user)
            )

    step_ids = {stage.step_id for c in cards.values() if (stage := c.current_stage) is not None}
    templates = (
        (
            await db.execute(
                select(WorkflowStepTemplate)
                .where(WorkflowStepTemplate.id.in_(step_ids))
                .order_by(WorkflowStepTemplate.workflow_id, WorkflowStepTemplate.sequence_order)
            )
        )
        .scalars()
        .all()
        if step_ids
        else []
    )
    return ProjectFacets(
        # Ordered by id, not by name: a withheld name must not leak through
        # the ordering either (OQ#8).
        leaders=sorted(leaders.values(), key=lambda n: str(n.id)),
        steps=[StepFacet(code=t.id, name=t.name) for t in templates],
    )
