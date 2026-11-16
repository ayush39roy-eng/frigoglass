"""Clearing manual step pins outside the pin batch write (P40, ADR 0054 R40-4 / R40-9).

A pin (`ProjectWorkflowStep.manual_start_week` / `manual_end_week`) governs a
Not Started step only. Two writers other than `PUT /gantt/step-pins` clear it
(I46 (c)), in the caller's transaction and under the caller's project row
lock (R33-10):

- a write that moves the stage out of Not Started (check-in, Workspace stage
  PATCH; the client re-import and the seed only ever insert fresh rows, which
  carry no pin) → `cause = "stage_started"`;
- a workflow re-point (`services.project_steps.sync_project_steps`) →
  `cause = "workflow_change"`.

Each cleared pair gets exactly one `project.step_pin_cleared` audit row with
before and after (I46 (d)). Nothing else writes a pin (I46 (a)).

Kept dependency-light (models only) so `services.project_steps` can import it.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from models.audit import AuditLogEntry
from models.enums import WorkflowStepStatus
from models.project import Project
from models.workflow import ProjectWorkflowStep

#: Audit actions (R40-11).
AUDIT_PINNED = "project.step_pinned"
AUDIT_PIN_CLEARED = "project.step_pin_cleared"

PinCause = Literal["manual", "stage_started", "workflow_change"]
CAUSE_MANUAL: PinCause = "manual"
CAUSE_STAGE_STARTED: PinCause = "stage_started"
CAUSE_WORKFLOW_CHANGE: PinCause = "workflow_change"


def has_pin(row: ProjectWorkflowStep) -> bool:
    return row.manual_start_week is not None or row.manual_end_week is not None


def pin_audit_state(
    project_id: uuid.UUID,
    step_id: str,
    stage: WorkflowStepStatus,
    start: int | None,
    end: int | None,
) -> dict[str, Any]:
    """One side of a pin audit row. No financial or personal field."""

    return {
        "project_id": str(project_id),
        "step_id": step_id,
        "stage": stage.value,
        "manual_start_week": start,
        "manual_end_week": end,
    }


def add_pin_audit(
    db: AsyncSession,
    *,
    project: Project,
    row: ProjectWorkflowStep,
    before: tuple[int | None, int | None],
    before_step_id: str | None = None,
    stage_before: WorkflowStepStatus | None = None,
    cause: PinCause,
    actor_user_id: uuid.UUID | None,
) -> None:
    """The one audit row for one changed stored pair (I46 (d))."""

    after = (row.manual_start_week, row.manual_end_week)
    action = AUDIT_PIN_CLEARED if after == (None, None) else AUDIT_PINNED
    db.add(
        AuditLogEntry(
            actor_user_id=actor_user_id,
            action=action,
            entity_type="ProjectWorkflowStep",
            entity_id=str(row.id),
            hub_id=project.hub_id,
            before_state=pin_audit_state(
                project.id,
                before_step_id or row.step_template_id,
                stage_before or row.status,
                *before,
            ),
            after_state={
                **pin_audit_state(project.id, row.step_template_id, row.status, *after),
                "cause": cause,
            },
        )
    )


def clear_pin_if_started(
    db: AsyncSession,
    project: Project,
    row: ProjectWorkflowStep,
    *,
    stage_before: WorkflowStepStatus,
    actor_user_id: uuid.UUID | None,
) -> bool:
    """R40-4: after the caller wrote the stage, clear the pin when the stage
    left Not Started. Returns whether a pin was cleared. The caller flushes
    (the CHECK allows null/null at any time)."""

    if row.status == WorkflowStepStatus.NOT_STARTED or not has_pin(row):
        return False
    before = (row.manual_start_week, row.manual_end_week)
    row.manual_start_week = None
    row.manual_end_week = None
    add_pin_audit(
        db,
        project=project,
        row=row,
        before=before,
        stage_before=stage_before,
        cause=CAUSE_STAGE_STARTED,
        actor_user_id=actor_user_id,
    )
    return True


def clear_pin_on_repoint(
    db: AsyncSession,
    project: Project,
    row: ProjectWorkflowStep,
    *,
    old_step_id: str,
    actor_user_id: uuid.UUID | None,
) -> bool:
    """R40-9: a re-pointed row (workflow change) loses its pin. The audit's
    `before` names the old step, `after` the new one."""

    if not has_pin(row):
        return False
    before = (row.manual_start_week, row.manual_end_week)
    row.manual_start_week = None
    row.manual_end_week = None
    add_pin_audit(
        db,
        project=project,
        row=row,
        before=before,
        before_step_id=old_step_id,
        cause=CAUSE_WORKFLOW_CHANGE,
        actor_user_id=actor_user_id,
    )
    return True


__all__ = [
    "AUDIT_PINNED",
    "AUDIT_PIN_CLEARED",
    "CAUSE_MANUAL",
    "CAUSE_STAGE_STARTED",
    "CAUSE_WORKFLOW_CHANGE",
    "PinCause",
    "add_pin_audit",
    "clear_pin_if_started",
    "clear_pin_on_repoint",
    "has_pin",
    "pin_audit_state",
]
