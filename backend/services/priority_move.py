"""ADR 0015: moving a project's priority recalculates the timeline.

`apply_priority_change` is the one implementation, used by
`POST /projects/{id}/priority` and by `PATCH /projects/{id}` whenever the
PATCH changes `priority` (docs/DOMAIN_RULES.md "Priority moves"):

    if new == old:                        unchanged  (nothing written)
    if hard_gates non-empty and new != P1: 409 HARD_GATE_FORCES_P1
    write priority, audit project.priority_move, set schedule_stale
    if status not schedulable:            not_needed (no run)
    elif a run is queued/running:         deferred   (stays stale; registers the one
                                                      coalesced follow-up run, ADR 0023)
    else:                                 queued     (greedy, activate=True,
                                                      trigger_reason="priority_move")

The queued path is the Workspace "Recalculate schedule" lifecycle
(`api/routers/workspace.py::recalculate`): `create_queued_schedule_run`
(which commits, so the priority, the stale flag, the `project.priority_move`
audit row and the QUEUED run land together and the worker reads the new
priority, I20), then `run_greedy_schedule.delay(..., activate=True,
recalc_project_id=...)`, the Celery task id, a `project.recalculate_requested`
audit row (as on the Workspace path), a commit and the SSE "queued" event.
Greedy only: docs/OPEN_QUESTIONS.md #10 keeps CP-SAT out of user actions.
Scheduling itself stays in `backend/scheduling/`, run by the worker.

The in-flight check is `services.run_dispatch.find_in_flight_run`, the same
window the Workspace recalc uses. A run in flight answers `deferred`, not
409: the priority is still saved and the project stays `schedule_stale`.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import CodedHTTPException
from core.principal import Principal
from models.audit import AuditLogEntry
from models.enums import (
    NON_SCHEDULABLE_STATUSES,
    HardGateReason,
    ProjectPriority,
    SolverType,
)
from models.priority import PriorityScore
from models.project import Project
from schemas.project import RecalcStatus
from services.active_run import get_active_run
from services.run_dispatch import enqueue_or_fail, find_in_flight_run
from services.schedule_persistence import create_queued_schedule_run
from workers.progress import publish_progress
from workers.schedule_tasks import run_greedy_schedule

#: `ScheduleRun.trigger_reason` of a run started by a priority move.
TRIGGER_REASON = "priority_move"
#: Audit action of the move itself.
AUDIT_ACTION = "project.priority_move"

#: PATCH response headers (docs/API_CONTRACT_P11.md §2). Also listed in the
#: CORS `expose_headers` in `api/main.py`. They carry ids and a status word
#: only, never project data.
RECALC_HEADER = "X-Schedule-Recalc"
RUN_ID_HEADER = "X-Schedule-Run-Id"
BASELINE_RUN_ID_HEADER = "X-Schedule-Baseline-Run-Id"


@dataclass(frozen=True)
class PriorityMoveResult:
    project_id: uuid.UUID
    priority_before: ProjectPriority | None
    priority_after: ProjectPriority | None
    recalc_status: RecalcStatus
    schedule_run_id: uuid.UUID | None = None
    baseline_run_id: uuid.UUID | None = None
    task_id: str | None = None

    def response_headers(self) -> dict[str, str]:
        """The PATCH headers. None when the priority did not change; the run
        id only when queued; the baseline id only when queued and a run was
        active.
        """

        if self.recalc_status == "unchanged":
            return {}
        headers: dict[str, str] = {RECALC_HEADER: self.recalc_status}
        if self.schedule_run_id is not None:
            headers[RUN_ID_HEADER] = str(self.schedule_run_id)
        if self.baseline_run_id is not None:
            headers[BASELINE_RUN_ID_HEADER] = str(self.baseline_run_id)
        return headers


async def project_hard_gates(db: AsyncSession, project_id: uuid.UUID) -> list[HardGateReason]:
    gates = (
        await db.execute(
            select(PriorityScore.hard_gates).where(PriorityScore.project_id == project_id)
        )
    ).scalar_one_or_none()
    return list(gates or [])


async def ensure_priority_move_allowed(
    db: AsyncSession, project: Project, new_priority: ProjectPriority | None
) -> None:
    """DOMAIN_RULES "Hard gates": a project with any hard gate is pinned to
    P1. Any other target is 409 `HARD_GATE_FORCES_P1`. Raises before anything
    is written. The gate names are fixed domain labels, not project data.
    """

    if new_priority == ProjectPriority.P1:
        return
    gates = await project_hard_gates(db, project.id)
    if gates:
        raise CodedHTTPException(
            status.HTTP_409_CONFLICT,
            "HARD_GATE_FORCES_P1",
            "This project has hard gates ("
            + "; ".join(g.value for g in gates)
            + "), so its priority is pinned to P1.",
        )


def _priority_value(priority: ProjectPriority | None) -> str | None:
    return priority.value if priority is not None else None


def add_priority_move_audit(
    db: AsyncSession,
    project: Project,
    before: ProjectPriority | None,
    new_priority: ProjectPriority | None,
    principal: Principal,
    *,
    recalc: RecalcStatus,
    baseline_id: uuid.UUID | None,
    schedule_run_id: uuid.UUID | None = None,
) -> None:
    """The one `project.priority_move` audit row. `schedule_run_id` is only
    passed by the P14 in-process confirm (`applied`), whose run exists by the
    time the row is written; the ADR 0015 paths keep their exact shape.
    """

    after_state: dict[str, str | None] = {
        "project_id": str(project.id),
        "priority": _priority_value(new_priority),
        "recalc_status": recalc,
        "baseline_run_id": str(baseline_id) if baseline_id is not None else None,
    }
    if schedule_run_id is not None:
        after_state["schedule_run_id"] = str(schedule_run_id)
    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action=AUDIT_ACTION,
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state={"project_id": str(project.id), "priority": _priority_value(before)},
            after_state=after_state,
        )
    )


async def apply_priority_change(
    db: AsyncSession,
    project: Project,
    new_priority: ProjectPriority | None,
    principal: Principal,
) -> PriorityMoveResult:
    """Apply one priority move and commit (see module docstring).

    The caller has already resolved the project through the hub-scoped
    lookup and authorised the write. On the PATCH path the caller may have
    staged other field changes on `project` in the same session; they are
    committed together with the move. `unchanged` writes and commits nothing.
    """

    before = project.priority
    if new_priority == before:
        return PriorityMoveResult(
            project_id=project.id,
            priority_before=before,
            priority_after=before,
            recalc_status="unchanged",
        )
    await ensure_priority_move_allowed(db, project, new_priority)

    project.priority = new_priority
    project.schedule_stale = True

    recalc, baseline_id = await decide_auto_recalc(db, project, trigger_reason=TRIGGER_REASON)
    add_priority_move_audit(
        db, project, before, new_priority, principal, recalc=recalc, baseline_id=baseline_id
    )
    outcome = await dispatch_auto_recalc(
        db, project, principal,
        recalc=recalc, baseline_id=baseline_id, trigger_reason=TRIGGER_REASON,
    )
    return PriorityMoveResult(
        project_id=project.id,
        priority_before=before,
        priority_after=new_priority,
        recalc_status=outcome.recalc_status,
        schedule_run_id=outcome.schedule_run_id,
        baseline_run_id=outcome.baseline_run_id,
        task_id=outcome.task_id,
    )


# --- the shared auto-recalc lifecycle (ADR 0015; reused by ADR 0040) ----------------


@dataclass(frozen=True)
class AutoRecalcOutcome:
    recalc_status: RecalcStatus
    schedule_run_id: uuid.UUID | None = None
    baseline_run_id: uuid.UUID | None = None
    task_id: str | None = None

    def response_headers(self) -> dict[str, str]:
        """The `X-Schedule-*` headers, same rules as `PriorityMoveResult`."""

        if self.recalc_status == "unchanged":
            return {}
        headers: dict[str, str] = {RECALC_HEADER: self.recalc_status}
        if self.schedule_run_id is not None:
            headers[RUN_ID_HEADER] = str(self.schedule_run_id)
        if self.baseline_run_id is not None:
            headers[BASELINE_RUN_ID_HEADER] = str(self.baseline_run_id)
        return headers


async def decide_auto_recalc(
    db: AsyncSession, project: Project, *, trigger_reason: str
) -> tuple[RecalcStatus, uuid.UUID | None]:
    """Step 1 of the auto-recalc lifecycle, after the caller has written the
    scheduler input and set `schedule_stale`: `not_needed` for a
    non-schedulable status, `deferred` when a run is in flight (the ADR 0023
    follow-up flag is set under the dispatch lock), else `queued` with the
    active run as the baseline. Holds the dispatch lock until the caller's
    next commit (`dispatch_auto_recalc` commits on every path).
    """

    recalc: RecalcStatus
    if project.status in NON_SCHEDULABLE_STATUSES:
        recalc = "not_needed"
    elif await find_in_flight_run(db, trigger_reason=trigger_reason) is not None:
        recalc = "deferred"
    else:
        recalc = "queued"
    baseline_id: uuid.UUID | None = None
    if recalc == "queued":
        active = await get_active_run(db)
        baseline_id = active.id if active is not None else None
    return recalc, baseline_id


async def dispatch_auto_recalc(
    db: AsyncSession,
    project: Project,
    principal: Principal,
    *,
    recalc: RecalcStatus,
    baseline_id: uuid.UUID | None,
    trigger_reason: str,
) -> AutoRecalcOutcome:
    """Step 2, after the caller has staged its own audit row: commit, and
    when `queued` create the QUEUED greedy run (committed together with the
    input change, the stale flag and the audit row, I20), enqueue
    `run_greedy_schedule` (`activate=True`, `recalc_project_id`) on the
    solver worker, audit `project.recalculate_requested`, commit and publish
    the SSE "queued" event. A broker failure answers `dispatch_failed` (the
    change is saved and stays stale). Never solves in-process.
    """

    if recalc != "queued":
        await db.commit()
        return AutoRecalcOutcome(recalc_status=recalc)

    # Commits the input change, the stale flag, the audit row and the QUEUED
    # run together, before the worker can read them.
    run = await create_queued_schedule_run(
        db,
        solver_type=SolverType.GREEDY,
        trigger_reason=trigger_reason,
        triggered_by_user_id=principal.user_id,
    )
    task_id = await enqueue_or_fail(
        db,
        run,
        lambda: run_greedy_schedule.delay(
            str(run.id),
            triggered_by_user_id=str(principal.user_id),
            activate=True,
            recalc_project_id=str(project.id),
        ),
        actor_user_id=principal.user_id,
    )
    if task_id is None:
        # P14-T01 (M3): the change is saved and the project stays stale; the
        # run row is FAILED (`DISPATCH_FAILED`), audited, committed.
        return AutoRecalcOutcome(recalc_status="dispatch_failed", baseline_run_id=baseline_id)
    run.celery_task_id = task_id
    db.add(run)
    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action="project.recalculate_requested",
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state=None,
            after_state={
                "project_id": str(project.id),
                "schedule_run_id": str(run.id),
                "schedule_run_version": run.version,
                "celery_task_id": run.celery_task_id,
                "trigger_reason": trigger_reason,
            },
        )
    )
    await db.commit()
    publish_progress(str(run.id), status="queued")
    return AutoRecalcOutcome(
        recalc_status="queued",
        schedule_run_id=run.id,
        baseline_run_id=baseline_id,
        task_id=task_id,
    )
