"""The 14 live `ProjectWorkflowStep` rows of a project (P9-T03).

Before P9-T03 only the seed script created these rows. A project registered
through `POST /projects` had none, so its Project Workspace would have had no
stages to record progress on. `sync_project_steps` gives every project
exactly one row per step of its workflow:

- missing rows are created (status `Not Started`, percent 0);
- when the project's workflow changes (a hub move between an OEM and a
  non-OEM hub), existing rows are re-pointed to the new workflow's step with
  the same `sequence_order`, the same mapping the P9-T01 migration used.
  This is refused (`WorkflowChangeWithProgress`) once any stage has
  progress, because PDD-B and OEM-B are different activities and carrying
  their progress across would be wrong;
- `duration_weeks` is rewritten from the lead-time table for the project's
  current `(workflow, category)` (ADR 0007), 0 when there is no category yet.

Planned weeks are not touched here. They belong to schedule runs.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.enums import WorkflowStepStatus
from models.project import Project, workflow_id_for_hub
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime, WorkflowStepTemplate


class WorkflowChangeWithProgress(Exception):
    """Raised when a workflow change would drop recorded stage progress."""


async def sync_project_steps(db: AsyncSession, project: Project, hub_is_oem: bool) -> None:
    workflow_id = workflow_id_for_hub(hub_is_oem)
    templates = (
        (
            await db.execute(
                select(WorkflowStepTemplate)
                .where(WorkflowStepTemplate.workflow_id == workflow_id)
                .order_by(WorkflowStepTemplate.sequence_order)
            )
        )
        .scalars()
        .all()
    )
    by_seq = {t.sequence_order: t for t in templates}
    template_ids = {t.id for t in templates}

    lead_times: dict[str, int] = {}
    if project.category is not None:
        rows = await db.execute(
            select(WorkflowLeadTime.step_id, WorkflowLeadTime.weeks).where(
                WorkflowLeadTime.workflow_id == workflow_id,
                WorkflowLeadTime.category == project.category,
            )
        )
        lead_times = {step_id: int(weeks) for step_id, weeks in rows.all()}

    existing = (
        (
            await db.execute(
                select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id == project.id)
            )
        )
        .scalars()
        .all()
    )
    foreign = [row for row in existing if row.step_template_id not in template_ids]
    if foreign:
        if any(row.status != WorkflowStepStatus.NOT_STARTED for row in existing):
            raise WorkflowChangeWithProgress(
                "The project's workflow would change, but some stages already have progress."
            )
        for row in foreign:
            target = by_seq.get(row.sequence_order)
            if target is None:  # pragma: no cover - both workflows have 14 steps
                await db.delete(row)
                continue
            row.step_template_id = target.id

    present = {row.sequence_order for row in existing}
    for t in templates:
        if t.sequence_order not in present:
            db.add(
                ProjectWorkflowStep(
                    project_id=project.id,
                    step_template_id=t.id,
                    sequence_order=t.sequence_order,
                    duration_weeks=0,
                    status=WorkflowStepStatus.NOT_STARTED,
                    percent_complete=0,
                )
            )
    await db.flush()

    rows_now = (
        (
            await db.execute(
                select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id == project.id)
            )
        )
        .scalars()
        .all()
    )
    for row in rows_now:
        row.duration_weeks = lead_times.get(row.step_template_id, 0)
    await db.flush()
