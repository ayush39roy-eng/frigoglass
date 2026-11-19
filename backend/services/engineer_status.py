"""Engineer deactivation: locks, leader-write rules, leader history and the
preview read model (P38-T04, ADR 0053 as ruled at P38-T01, R38-1..R38-9;
docs/API_CONTRACT_P38.md; DOMAIN_RULES "Engineer deactivation").

**Lock order (R38-5).** The engineer row first: `FOR UPDATE` in deactivate
and reactivate, `FOR SHARE` in every leader write that names an engineer;
then project rows in `project_id` order. A path that writes band ranks keeps
the band-rank advisory lock first (R36-8). Every wait here is bounded by a
transaction-local `lock_timeout`; a timeout or a deadlock rolls the
transaction back and answers 503 `ENGINEER_STATUS_BUSY` (the
`BAND_RANK_BUSY` pattern). Callers look up and authorise with plain SELECTs
before taking any of these locks (P36-R01).

**I42.** No project whose status is not Commercialized / Cancelled is led by
an inactive engineer. `check_leader_write` is the API-side rule for every
project write path (registration, PATCH, register batch / bulk edit): naming
an inactive leader, or reopening a closed project whose stored leader is
inactive without setting a leader in the same write, is 422
`LEADER_INACTIVE` (R38-4). Deferred constraint triggers
(`p38a_engineer_deactivation`) back it for every other writer.

**Leader history (R38-6).** `record_leader_change` writes one
`project_leader_history` row for every leader change, on every path.
"""

from __future__ import annotations

import hashlib
import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from fastapi import status as http_status
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from models.engineer import Engineer, EngineerInactivePeriod, ProjectLeaderHistory
from models.enums import (
    NON_SCHEDULABLE_STATUSES,
    ProjectStatus,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from models.hub import HubWorkCalendar
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from scheduling import InactivePeriod
from scheduling.greedy import _cat_not_allowed
from scheduling.types import EngineerInput, ProjectInput
from schemas.engineer import (
    BeforeAfter,
    DeactivationCandidate,
    DeactivationEngineer,
    DeactivationOpenProject,
    DeactivationPreview,
    DeactivationSupplyEffect,
)
from services.active_run import get_active_run, step_kinds_for_run
from services.capacity_hubs import CapacityHubMap
from services.capacity_supply import round2
from services.categories import load_catalog
from services.engineer_supply import (
    SupplyMember,
    covered_weeks_for,
    hub_design_supply,
    load_inactive_periods,
)
from services.hub_scope import is_hub_in_scope
from services.plan_clock import PlanClock
from services.run_step_effort import effort_from, weekly_effort_for_rows

#: A project the engineer leads in one of these statuses is not "open": it
#: keeps its (inactive) leader as history (ADR 0053 §3).
CLOSED_STATUSES: frozenset[ProjectStatus] = frozenset(
    {ProjectStatus.COMMERCIALIZED, ProjectStatus.CANCELLED}
)

#: `ScheduleRun.trigger_reason` of the deactivation's recalculation (R38-5).
ENGINEER_DEACTIVATED_TRIGGER = "engineer_deactivated"

#: `project_leader_history.cause` values (DB CHECK in p38a).
CAUSE_REGISTRATION = "registration"
CAUSE_PROJECT_UPDATE = "project_update"
CAUSE_REGISTER_EDIT = "register_edit"
CAUSE_ENGINEER_DEACTIVATED = ENGINEER_DEACTIVATED_TRIGGER

#: How long a writer waits for an engineer / project row lock before 503.
ENGINEER_STATUS_LOCK_TIMEOUT = "5s"
ENGINEER_STATUS_BUSY_RETRY_AFTER = 5
_LOCK_NOT_AVAILABLE = "55P03"
_DEADLOCK_DETECTED = "40P01"


# --- Errors ---------------------------------------------------------------------------


def engineer_status_busy() -> CodedHTTPException:
    return CodedHTTPException(
        http_status.HTTP_503_SERVICE_UNAVAILABLE,
        "ENGINEER_STATUS_BUSY",
        "Another change to this engineer or their projects is being saved. "
        "Nothing was changed. Please try again in a moment.",
        headers={"Retry-After": str(ENGINEER_STATUS_BUSY_RETRY_AFTER)},
    )


def leader_inactive_error(
    message: str, loc: Sequence[str | int] | None = None
) -> CodedHTTPException:
    return CodedHTTPException(
        HTTP_422,
        "LEADER_INACTIVE",
        [
            {
                "loc": list(loc) if loc is not None else ["body", "leader_engineer_id"],
                "msg": message,
                "type": "leader_inactive",
            }
        ],
    )


def unknown_leader_error(loc: Sequence[str | int] | None = None) -> CodedHTTPException:
    return CodedHTTPException(
        HTTP_422,
        "UNKNOWN_LEADER",
        [
            {
                "loc": list(loc) if loc is not None else ["body", "leader_engineer_id"],
                "msg": "Unknown leader_engineer_id",
                "type": "unknown_leader",
            }
        ],
    )


def _sqlstate(exc: DBAPIError) -> str | None:
    orig = exc.orig
    return getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)


# --- Locks ----------------------------------------------------------------------------


async def _with_lock_timeout(db: AsyncSession, stmt: Any) -> Any:
    """Run a locking SELECT under `ENGINEER_STATUS_LOCK_TIMEOUT` (transaction
    local, restored straight after). Timeout or deadlock → rollback + 503."""

    previous: str = (await db.execute(select(func.current_setting("lock_timeout")))).scalar_one()
    await db.execute(select(func.set_config("lock_timeout", ENGINEER_STATUS_LOCK_TIMEOUT, True)))
    try:
        result = await db.execute(stmt)
    except DBAPIError as exc:
        if _sqlstate(exc) not in (_LOCK_NOT_AVAILABLE, _DEADLOCK_DETECTED):
            raise
        await db.rollback()
        raise engineer_status_busy() from None
    await db.execute(select(func.set_config("lock_timeout", previous, True)))
    return result


async def lock_engineers(
    db: AsyncSession, engineer_ids: Iterable[uuid.UUID], *, share: bool
) -> dict[uuid.UUID, Engineer]:
    """Lock the engineer rows (`FOR SHARE` or `FOR UPDATE`) in id order and
    return them re-read. Unknown ids are simply absent from the result."""

    ids = sorted(set(engineer_ids))
    if not ids:
        return {}
    stmt = (
        select(Engineer)
        .where(Engineer.id.in_(ids))
        .order_by(Engineer.id)
        .with_for_update(read=share)
        .execution_options(populate_existing=True)
    )
    result = await _with_lock_timeout(db, stmt)
    return {e.id: e for e in result.scalars().all()}


def open_projects_stmt(engineer_id: uuid.UUID) -> Any:
    return (
        select(Project)
        .where(
            Project.leader_engineer_id == engineer_id,
            Project.status.not_in(list(CLOSED_STATUSES)),
        )
        .order_by(Project.id)
    )


async def open_projects(
    db: AsyncSession, engineer_id: uuid.UUID, *, lock: bool = False
) -> list[Project]:
    """The engineer's open projects, by id. With `lock`, `FOR UPDATE` in id
    order under the lock timeout (after the engineer row, R38-5)."""

    stmt = open_projects_stmt(engineer_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
        result = await _with_lock_timeout(db, stmt)
    else:
        result = await db.execute(stmt)
    return list(result.scalars().all())


def led_projects_token(project_ids: Iterable[uuid.UUID]) -> str:
    """An opaque hash of the sorted open-project id set (not a secret)."""

    joined = ",".join(sorted(str(pid) for pid in project_ids))
    return hashlib.sha256(f"p38-led:{joined}".encode()).hexdigest()


# --- Leader writes (I42, R38-4) ------------------------------------------------------


async def check_leader_write(
    db: AsyncSession, project: Project | None, updates: Mapping[str, Any]
) -> None:
    """The I42 rule for a project write (registration when `project` is
    None). Locks the leader that the written project will be open with
    `FOR SHARE` (R38-5), so a concurrent deactivation either sees this write
    in its open set or this write sees the engineer inactive.

    - a written leader that differs from the stored one must exist (422
      `UNKNOWN_LEADER`) and be active (422 `LEADER_INACTIVE`);
    - a write that moves the project out of Commercialized / Cancelled and
      keeps a leader (stored, or written equal to it) needs that leader
      active: otherwise 422 `LEADER_INACTIVE` — set a leader, active or null,
      in the same write (R38-4).
    """

    stored_status = project.status if project is not None else None
    stored_leader = project.leader_engineer_id if project is not None else None
    new_status = updates.get("status", stored_status)
    leader_written = "leader_engineer_id" in updates
    new_leader = updates["leader_engineer_id"] if leader_written else stored_leader
    if new_leader is None:
        return
    reopen = (
        project is not None
        and stored_status in CLOSED_STATUSES
        and new_status is not None
        and new_status not in CLOSED_STATUSES
    )
    changed = leader_written and new_leader != stored_leader
    if not (changed or reopen or project is None):
        return
    engineer = (await lock_engineers(db, [new_leader], share=True)).get(new_leader)
    if engineer is None:
        raise unknown_leader_error()
    if not engineer.active:
        if changed or project is None:
            raise leader_inactive_error(
                "This engineer is inactive and cannot lead a project. Choose an active engineer."
            )
        raise leader_inactive_error(
            "This project's leader is inactive. Set a new leader (or none) in the same "
            "change that reopens it."
        )


async def record_leader_change(
    db: AsyncSession,
    *,
    project_id: uuid.UUID,
    old_leader_id: uuid.UUID | None,
    new_leader_id: uuid.UUID | None,
    cause: str,
    actor_user_id: uuid.UUID | None,
    clock: PlanClock,
) -> ProjectLeaderHistory | None:
    """One `project_leader_history` row for a leader change (R38-6); no row
    when the leader did not change. `from_week` is the week the former
    leader's tenure began when an earlier row of this plan year recorded it."""

    if old_leader_id == new_leader_id:
        return None
    from_week: int | None = None
    if old_leader_id is not None:
        started = (
            await db.execute(
                select(ProjectLeaderHistory.plan_year, ProjectLeaderHistory.to_week)
                .where(
                    ProjectLeaderHistory.project_id == project_id,
                    ProjectLeaderHistory.new_engineer_id == old_leader_id,
                )
                .order_by(ProjectLeaderHistory.created_at.desc(), ProjectLeaderHistory.id)
                .limit(1)
            )
        ).first()
        if started is not None and started.plan_year == clock.plan_year:
            from_week = started.to_week
    row = ProjectLeaderHistory(
        id=uuid.uuid4(),
        project_id=project_id,
        engineer_id=old_leader_id,
        new_engineer_id=new_leader_id,
        plan_year=clock.plan_year,
        from_week=from_week,
        to_week=clock.week_of_year,
        cause=cause,
        changed_by_user_id=actor_user_id,
    )
    db.add(row)
    return row


# --- Preview read model ---------------------------------------------------------------


def _project_input(project: Project, hub_name: str) -> ProjectInput:
    return ProjectInput(
        project_id=str(project.id),
        name="",
        hub=hub_name,
        status=project.status.value,
        category=project.category,
        priority=project.priority.value if project.priority is not None else None,
        frozen=project.frozen,
        leader_engineer_id=None,
    )


def _engineer_input(engineer: Engineer, hub_name: str) -> EngineerInput:
    return EngineerInput(
        engineer_id=str(engineer.id),
        name="",
        hub=hub_name,
        allowed_categories=tuple(engineer.allowed_categories or ()),
        fte=float(engineer.fte),
        counts_in_capacity=engineer.counts_in_capacity,
    )


def category_not_allowed(
    project: Project,
    engineer: Engineer,
    cmap: CapacityHubMap,
    category_workflow: Mapping[str, str],
) -> bool:
    """The scheduler's own predicate (`greedy._cat_not_allowed`, R38-3)."""

    return _cat_not_allowed(
        _project_input(project, cmap.name(project.hub_id).value),
        _engineer_input(engineer, cmap.name(engineer.hub_id).value),
        category_workflow,
    )


async def _stage_facts(
    db: AsyncSession, project_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, tuple[bool, int, bool]]:
    """`{project_id: (progress_tracked, done_stages, in_flight_lab)}` from the
    stored stage rows (progress tracked = some stage not "Not Started", the
    scheduler's rule)."""

    facts: dict[uuid.UUID, list[Any]] = {pid: [False, 0, False] for pid in project_ids}
    if not project_ids:
        return {}
    rows = await db.execute(
        select(
            ProjectWorkflowStep.project_id, ProjectWorkflowStep.status, WorkflowStepTemplate.kind
        )
        .join(WorkflowStepTemplate, WorkflowStepTemplate.id == ProjectWorkflowStep.step_template_id)
        .where(ProjectWorkflowStep.project_id.in_(list(project_ids)))
    )
    for pid, stage_status, kind in rows.all():
        f = facts[pid]
        if stage_status != WorkflowStepStatus.NOT_STARTED:
            f[0] = True
        if stage_status == WorkflowStepStatus.DONE:
            f[1] += 1
        if kind == WorkflowStepKind.LAB and stage_status in (
            WorkflowStepStatus.IN_PROGRESS,
            WorkflowStepStatus.BLOCKED,
        ):
            f[2] = True
    return {pid: (bool(f[0]), int(f[1]), bool(f[2])) for pid, f in facts.items()}


async def _remaining_design_load(
    db: AsyncSession, engineer_ids: Sequence[uuid.UUID], current_week: int
) -> dict[uuid.UUID, float]:
    """Σ design effort the active run books on each engineer after the
    calendar week (the utilization views' weekly spread)."""

    out: dict[uuid.UUID, float] = defaultdict(float)
    run = await get_active_run(db)
    if run is None or not engineer_ids:
        return out
    kinds = await step_kinds_for_run(db, run)
    rows = [
        r
        for r in (
            await db.execute(
                select(ScheduleRunProjectStep).where(
                    ScheduleRunProjectStep.schedule_run_id == run.id,
                    ScheduleRunProjectStep.assigned_engineer_id.in_(list(engineer_ids)),
                    ScheduleRunProjectStep.skipped.is_(False),
                )
            )
        )
        .scalars()
        .all()
        if kinds.get(r.step_template_id) == WorkflowStepKind.DESIGN
    ]
    effort = await weekly_effort_for_rows(db, run, rows)
    for r in rows:
        assert r.assigned_engineer_id is not None
        out[r.assigned_engineer_id] += effort_from(effort.get(r.id, {}), current_week + 1)
    return out


async def active_run_books_after(db: AsyncSession, engineer_id: uuid.UUID, week: int) -> bool:
    """R38-5 (b): the active run has a design row of this engineer that ends
    after `week`."""

    run: ScheduleRun | None = await get_active_run(db)
    if run is None:
        return False
    kinds = await step_kinds_for_run(db, run)
    rows = (
        (
            await db.execute(
                select(ScheduleRunProjectStep.step_template_id).where(
                    ScheduleRunProjectStep.schedule_run_id == run.id,
                    ScheduleRunProjectStep.assigned_engineer_id == engineer_id,
                    ScheduleRunProjectStep.skipped.is_(False),
                    ScheduleRunProjectStep.end_week > week,
                )
            )
        )
        .scalars()
        .all()
    )
    return any(kinds.get(step_id) == WorkflowStepKind.DESIGN for step_id in rows)


def projects_out_of_scope(principal: Principal, projects: Iterable[Project]) -> bool:
    return any(not is_hub_in_scope(principal, p.hub_id) for p in projects)


async def open_project_rows(
    db: AsyncSession,
    principal: Principal,
    engineer: Engineer,
    projects: Sequence[Project],
    cmap: CapacityHubMap,
    clock: PlanClock,
) -> list[DeactivationOpenProject]:
    """The preview rows (contract §2): per-row facts and the eligible
    candidates of each project's capacity hub, least loaded first."""

    if not projects:
        return []
    catalog = await load_catalog(db)
    category_workflow = catalog.workflow_by_code
    capacity_hubs = {cmap.resolve(p.hub_id) for p in projects}
    pool = [
        e
        for e in (
            await db.execute(
                select(Engineer)
                .where(
                    Engineer.hub_id.in_([h for h in capacity_hubs if h is not None]),
                    Engineer.active.is_(True),
                    Engineer.fte > 0,
                    Engineer.id != engineer.id,
                )
                .order_by(Engineer.name, Engineer.id)
            )
        )
        .scalars()
        .all()
        if is_hub_in_scope(principal, e.hub_id)
    ]
    load = await _remaining_design_load(db, [e.id for e in pool], clock.week)
    facts = await _stage_facts(db, [p.id for p in projects])
    rows: list[DeactivationOpenProject] = []
    for p in projects:
        cap = cmap.resolve(p.hub_id)
        eligible = [
            e
            for e in pool
            if e.hub_id == cap and not category_not_allowed(p, e, cmap, category_workflow)
        ]
        eligible.sort(key=lambda e: (load.get(e.id, 0.0) / float(e.fte), e.name, str(e.id)))
        tracked, done, lab = facts.get(p.id, (False, 0, False))
        rows.append(
            DeactivationOpenProject(
                project_id=p.id,
                name=p.name,
                hub=cmap.name(p.hub_id).value,
                status=p.status.value,
                priority=p.priority.value if p.priority is not None else None,
                category=p.category,
                schedulable=p.status not in NON_SCHEDULABLE_STATUSES,
                frozen=p.frozen,
                progress_tracked=tracked,
                done_stages=done,
                in_flight_lab=lab,
                candidates=[
                    DeactivationCandidate(
                        engineer_id=e.id,
                        name=e.name,
                        fte=float(e.fte),
                        load_weeks=round2(load.get(e.id, 0.0)),
                    )
                    for e in eligible
                ],
            )
        )
    return rows


async def supply_effect(
    db: AsyncSession, engineer: Engineer, cmap: CapacityHubMap, clock: PlanClock
) -> DeactivationSupplyEffect | None:
    """R38-1 before / after for the engineer's capacity hub, at the response's
    calendar week; None when the engineer does not count in capacity."""

    if not engineer.counts_in_capacity:
        return None
    members = (
        (
            await db.execute(
                select(Engineer).where(
                    Engineer.hub_id == engineer.hub_id, Engineer.counts_in_capacity.is_(True)
                )
            )
        )
        .scalars()
        .all()
    )
    periods = await load_inactive_periods(db, [m.id for m in members])
    calendar = (
        await db.execute(select(HubWorkCalendar).where(HubWorkCalendar.hub_id == engineer.hub_id))
    ).scalar_one_or_none()
    new_period = InactivePeriod(from_plan_year=clock.plan_year, from_week=clock.week_of_year)

    def _members(with_new: bool) -> list[SupplyMember]:
        out: list[SupplyMember] = []
        for m in members:
            own = list(periods.get(m.id, []))
            if with_new and m.id == engineer.id:
                own.append(new_period)
            out.append(
                SupplyMember(fte=m.fte, covered_weeks=covered_weeks_for(own, clock.plan_year))
            )
        return out

    year_b, rem_b = hub_design_supply(calendar, _members(False), clock.week)
    year_a, rem_a = hub_design_supply(calendar, _members(True), clock.week)
    return DeactivationSupplyEffect(
        capacity_hub=cmap.name(engineer.hub_id).value,
        yearly_design_capacity=BeforeAfter(before=round2(year_b), after=round2(year_a)),
        remaining_design_capacity=BeforeAfter(before=round2(rem_b), after=round2(rem_a)),
    )


async def build_preview(
    db: AsyncSession,
    principal: Principal,
    engineer: Engineer,
    projects: Sequence[Project],
    cmap: CapacityHubMap,
    clock: PlanClock,
) -> DeactivationPreview:
    return DeactivationPreview(
        engineer=DeactivationEngineer(
            id=engineer.id,
            name=engineer.name,
            hub=cmap.name(engineer.hub_id).value,
            active=engineer.active,
        ),
        deactivation_week=clock.week,
        has_linked_login=engineer.user_id is not None,
        open_projects=await open_project_rows(db, principal, engineer, projects, cmap, clock),
        supply_effect=await supply_effect(db, engineer, cmap, clock),
        led_projects_token=led_projects_token(p.id for p in projects),
    )


async def open_period(db: AsyncSession, engineer_id: uuid.UUID) -> EngineerInactivePeriod | None:
    return (
        await db.execute(
            select(EngineerInactivePeriod).where(
                EngineerInactivePeriod.engineer_id == engineer_id,
                EngineerInactivePeriod.to_week.is_(None),
            )
        )
    ).scalar_one_or_none()


__all__ = [
    "CAUSE_ENGINEER_DEACTIVATED",
    "CAUSE_PROJECT_UPDATE",
    "CAUSE_REGISTER_EDIT",
    "CAUSE_REGISTRATION",
    "CLOSED_STATUSES",
    "ENGINEER_DEACTIVATED_TRIGGER",
    "active_run_books_after",
    "build_preview",
    "category_not_allowed",
    "check_leader_write",
    "engineer_status_busy",
    "led_projects_token",
    "lock_engineers",
    "open_period",
    "open_projects",
    "projects_out_of_scope",
    "record_leader_change",
]
