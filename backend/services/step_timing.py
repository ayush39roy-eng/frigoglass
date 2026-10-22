"""ADR 0019: a Gantt drag sets a step's duration and earliest start, then
recalculates (docs/API_CONTRACT_P12.md §3, DOMAIN_RULES "Step timing from the
Gantt").

`apply_step_timing` is the one implementation behind
`PATCH /projects/{project_id}/steps/{step_id}/timing`. Order:

    unknown step for the project's workflow, or a range error: 422 VALIDATION_ERROR
    project frozen:                                            409 PROJECT_FROZEN
    project status not schedulable:                            409 NOT_SCHEDULABLE
    step lead time 0 (skipped):                                409 STEP_SKIPPED
    effort-zeroed step (ADR 0041 R4/R5) and a NEW non-null value:
                                                               409 STEP_SKIPPED
    requested values equal the stored ones:                    unchanged (nothing written)
    step Done (any change):                                    409 STEP_DONE
    a non-null start_not_before_week on In Progress / Blocked: 409 STEP_STARTED
    write fields, set schedule_stale, audit project.step_timing, then
    lab step of a project without certification testing:      not_needed (no run)
    a run is queued/running:                                   deferred   (stays stale; registers
                                                                           the one coalesced
                                                                           follow-up run, ADR 0023)
    else:                                                      queued     (greedy, activate=True,
                                                                           trigger_reason="step_timing")

Every 409/422 is raised before anything is written. Clearing
`start_not_before_week` (an explicit null) on an In Progress / Blocked step is
allowed: the floor only applies to Not Started steps, so clearing it is the
"Reset timing" gesture, not a move.

`not_needed`: a lab step is skipped by the scheduler while the project's
`certification_testing_required` is false (DOMAIN_RULES "Lead times"), and the
scheduler ignores timing on skipped steps, so the run would not change. The
values are kept for when certification testing is turned back on; until then
`effective_duration_weeks` answers 0, because the step books no weeks (an
override never revives a skipped step; P12-F04).

The queued path is the priority move's lifecycle
(`services/priority_move.py`, ADR 0015): `find_in_flight_run` (which takes the
dispatch advisory lock), `create_queued_schedule_run` (its commit lands the
fields, the stale flag, the audit row and the QUEUED run together, so the
worker's input carries the new timing), `run_greedy_schedule.delay(...,
activate=True, recalc_project_id=...)`, a `project.recalculate_requested`
audit row, a commit and the SSE "queued" event. Greedy only (OQ #10).
Scheduling itself stays in `backend/scheduling/`, run by the worker.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.errors import HTTP_422, CodedHTTPException, field_error
from core.principal import Principal
from models.audit import AuditLogEntry
from models.enums import (
    NON_SCHEDULABLE_STATUSES,
    SolverType,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from models.project import Project
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from schemas.project import RecalcStatus
from schemas.step_timing import DURATION_OVERRIDE_MAX_WEEKS, TimingEditable
from services.active_run import get_active_run
from services.run_dispatch import enqueue_or_fail, find_in_flight_run
from services.schedule_persistence import create_queued_schedule_run
from services.workflow_durations import live_step_effective_weeks
from services.workspace import row_is_skipped
from workers.progress import publish_progress
from workers.schedule_tasks import run_greedy_schedule

#: `ScheduleRun.trigger_reason` of a run started by a Gantt drag.
TRIGGER_REASON = "step_timing"
#: Audit action of the timing change itself.
AUDIT_ACTION = "project.step_timing"

TIMING_FIELDS = ("duration_override_weeks", "start_not_before_week")
_RANGES: dict[str, tuple[int, int]] = {
    "duration_override_weeks": (1, DURATION_OVERRIDE_MAX_WEEKS),
    "start_not_before_week": (1, dc.HORIZON_WEEKS),
}
_STARTED = (WorkflowStepStatus.IN_PROGRESS, WorkflowStepStatus.BLOCKED)


@dataclass(frozen=True)
class StepTimingResult:
    project_id: uuid.UUID
    step_id: str
    duration_override_weeks: int | None
    start_not_before_week: int | None
    effective_duration_weeks: int
    #: ADR 0041 R4: the derived effort value the step falls back to when the
    #: user override is cleared, and the lead-time value.
    effort_weeks: int | None
    lead_time_weeks: int
    recalc_status: RecalcStatus
    schedule_run_id: uuid.UUID | None = None
    baseline_run_id: uuid.UUID | None = None
    task_id: str | None = None


def timing_editable(
    *,
    can_write: bool,
    frozen: bool,
    schedulable: bool,
    skipped: bool,
    step_status: WorkflowStepStatus,
) -> TimingEditable:
    """ADR 0019 §4, plus the caller's GANTT write permission on the project.
    `skipped` covers a lead time of 0 and a step the active run skipped (a
    lab step without certification testing): neither is drawn, so neither
    can be dragged.
    """

    if not can_write or frozen or not schedulable or skipped:
        return "none"
    if step_status == WorkflowStepStatus.DONE:
        return "none"
    if step_status in _STARTED:
        return "resize"
    return "move_resize"


def validate_timing_changes(changes: dict[str, Any]) -> None:
    """422 `VALIDATION_ERROR` for an empty body or an out-of-range value.
    The detail is a FastAPI-style `[{loc, msg, type}]` list.
    """

    if not changes:
        raise CodedHTTPException(
            HTTP_422,
            "VALIDATION_ERROR",
            [
                {
                    "loc": ["body"],
                    "msg": "Send duration_override_weeks, start_not_before_week or both.",
                    "type": "value_error",
                }
            ],
        )
    errors = []
    for name, value in changes.items():
        low, high = _RANGES[name]
        if value is not None and not low <= value <= high:
            errors.append(field_error(name, f"{name} must be between {low} and {high}."))
    if errors:
        raise CodedHTTPException(HTTP_422, "VALIDATION_ERROR", errors)


def _served_effective(
    row: ProjectWorkflowStep,
    kind: WorkflowStepKind,
    cert_required: bool,
    duration_override_weeks: int | None,
) -> int:
    """The response's `effective_duration_weeks`: `eff` of the step with the
    given user override (ADR 0041 R4: `user ?? effort ?? lead`), 0 for any
    skipped step (lead 0, lab without certification testing: P12-F04, or an
    effort-zeroed step). The scheduler's own predicate."""

    return live_step_effective_weeks(
        lead_weeks=row.duration_weeks,
        kind=kind,
        certification_testing_required=cert_required,
        user_override_weeks=duration_override_weeks,
        effort_weeks=row.effort_weeks,
    )


def _conflict(code: str, message: str) -> CodedHTTPException:
    return CodedHTTPException(status.HTTP_409_CONFLICT, code, message)


def _timing_state(
    project_id: uuid.UUID, step_id: str, values: dict[str, int | None]
) -> dict[str, Any]:
    return {"project_id": str(project_id), "step_id": step_id, **values}


async def apply_step_timing(
    db: AsyncSession,
    project: Project,
    step_id: str,
    changes: dict[str, int | None],
    principal: Principal,
) -> StepTimingResult:
    """Apply one timing change and commit (see module docstring).

    The caller has already resolved the project through the hub-scoped
    lookup and authorised the GANTT write. `changes` holds only the fields
    the request sent (an explicit null included).
    """

    validate_timing_changes(changes)
    row = (
        await db.execute(
            select(ProjectWorkflowStep).where(
                ProjectWorkflowStep.project_id == project.id,
                ProjectWorkflowStep.step_template_id == step_id,
            )
        )
    ).scalar_one_or_none()
    template = await db.get(WorkflowStepTemplate, step_id)
    if row is None or template is None or template.workflow_id != project.workflow_id:
        raise CodedHTTPException(
            HTTP_422,
            "VALIDATION_ERROR",
            [
                {
                    "loc": ["path", "step_id"],
                    "msg": "Not a step of this project's workflow.",
                    "type": "value_error",
                }
            ],
        )

    if project.frozen:
        raise _conflict(
            "PROJECT_FROZEN", "The project is frozen. Unfreeze it on the Gantt to change timing."
        )
    if project.status in NON_SCHEDULABLE_STATUSES:
        raise _conflict(
            "NOT_SCHEDULABLE",
            "The project's status is not scheduled, so its step timing cannot be changed.",
        )
    if row.duration_weeks == 0:
        raise _conflict(
            "STEP_SKIPPED", "This step is skipped for the project (0 weeks) and has no timing."
        )

    # A lab step is skipped while the project has no certification testing
    # (DOMAIN_RULES "Lead times"); the scheduler ignores timing on it, but
    # the values are kept for when it is turned back on (P12-F04).
    cert_skipped = (
        template.kind == WorkflowStepKind.LAB and not project.certification_testing_required
    )
    cert_required = project.certification_testing_required
    before: dict[str, int | None] = {
        "duration_override_weeks": row.duration_override_weeks,
        "start_not_before_week": row.start_not_before_week,
    }
    after = {name: changes.get(name, before[name]) for name in TIMING_FIELDS}
    # ADR 0041 R4/R5: a step the client's effort split zeroed (effective 0,
    # the one skip predicate) is skipped: a NEW user value cannot be set on
    # it (409 STEP_SKIPPED). Clearing values ("Reset timing") stays allowed,
    # and a step that already carries a user override is not skipped (the
    # override keeps it).
    if not cert_skipped and row_is_skipped(row, template.kind, cert_required):
        if any(after[name] is not None and after[name] != before[name] for name in TIMING_FIELDS):
            raise _conflict(
                "STEP_SKIPPED",
                "This step is skipped for the project (its effort share is 0 weeks) and "
                "cannot be given timing.",
            )
    if after == before:
        return StepTimingResult(
            project_id=project.id,
            step_id=step_id,
            duration_override_weeks=before["duration_override_weeks"],
            start_not_before_week=before["start_not_before_week"],
            effective_duration_weeks=_served_effective(
                row, template.kind, cert_required, before["duration_override_weeks"]
            ),
            effort_weeks=row.effort_weeks,
            lead_time_weeks=row.duration_weeks,
            recalc_status="unchanged",
        )
    if row.status == WorkflowStepStatus.DONE:
        raise _conflict("STEP_DONE", "A Done step is history; its timing cannot change.")
    new_floor = after["start_not_before_week"]
    if (
        row.status in _STARTED
        and new_floor is not None
        and new_floor != before["start_not_before_week"]
    ):
        raise _conflict(
            "STEP_STARTED",
            "The step has started, so its start is fixed. Only its duration can change.",
        )

    row.duration_override_weeks = after["duration_override_weeks"]
    row.start_not_before_week = after["start_not_before_week"]
    project.schedule_stale = True

    recalc: RecalcStatus
    if cert_skipped:
        recalc = "not_needed"
    elif await find_in_flight_run(db, trigger_reason=TRIGGER_REASON) is not None:
        recalc = "deferred"
    else:
        recalc = "queued"
    baseline_id: uuid.UUID | None = None
    if recalc == "queued":
        active = await get_active_run(db)
        baseline_id = active.id if active is not None else None

    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action=AUDIT_ACTION,
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state=_timing_state(project.id, step_id, before),
            after_state={
                **_timing_state(project.id, step_id, after),
                "recalc_status": recalc,
                "baseline_run_id": str(baseline_id) if baseline_id is not None else None,
            },
        )
    )
    effective = _served_effective(
        row, template.kind, cert_required, after["duration_override_weeks"]
    )

    if recalc != "queued":
        await db.commit()
        return StepTimingResult(
            project_id=project.id,
            step_id=step_id,
            duration_override_weeks=after["duration_override_weeks"],
            start_not_before_week=after["start_not_before_week"],
            effective_duration_weeks=effective,
            effort_weeks=row.effort_weeks,
            lead_time_weeks=row.duration_weeks,
            recalc_status=recalc,
        )

    # Commits the fields, the stale flag, the audit row and the QUEUED run
    # together, before the worker can read them.
    run = await create_queued_schedule_run(
        db,
        solver_type=SolverType.GREEDY,
        trigger_reason=TRIGGER_REASON,
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
        # P14-T01 (M3): the timing is saved and stays stale; no run.
        return StepTimingResult(
            project_id=project.id,
            step_id=step_id,
            duration_override_weeks=after["duration_override_weeks"],
            start_not_before_week=after["start_not_before_week"],
            effective_duration_weeks=effective,
            effort_weeks=row.effort_weeks,
            lead_time_weeks=row.duration_weeks,
            recalc_status="dispatch_failed",
            baseline_run_id=baseline_id,
        )
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
                "trigger_reason": TRIGGER_REASON,
            },
        )
    )
    await db.commit()
    publish_progress(str(run.id), status="queued")
    return StepTimingResult(
        project_id=project.id,
        step_id=step_id,
        duration_override_weeks=after["duration_override_weeks"],
        start_not_before_week=after["start_not_before_week"],
        effective_duration_weeks=effective,
        effort_weeks=row.effort_weeks,
        lead_time_weeks=row.duration_weeks,
        recalc_status="queued",
        schedule_run_id=run.id,
        baseline_run_id=baseline_id,
        task_id=task_id,
    )
