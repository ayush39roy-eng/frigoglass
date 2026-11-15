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
  Since P33 it is only that mirror; no `eff` reader uses it.
- **P33 (ADR 0046 §B, OR-5, R33-10; `services.template_copy`)**: a created
  row and a re-pointed row take the category template's `weeks` / `gap_weeks`
  as their copy (`plan_weeks` / `plan_gap_weeks`); with
  `recopy_template=True` (a category change) every not-reached row is
  re-copied too. Otherwise an existing row's copy is never touched: a
  template edit reaches a project only through the apply (P33-T10). The
  per-step copy before / after is returned for the caller's audit row.
- a re-pointed row loses its derived effort (`effort_weeks`, ADR 0041);
  every other row keeps it. (The Gantt-set timing fields, ADR 0019 / 0043,
  are retired and always null since p33c, ADR 0048.) The caller re-derives
  the effort split afterwards (`services.project_effort.rederive_project_effort`,
  ADR 0041 R6).

Planned weeks are not touched here. They belong to schedule runs.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.enums import WorkflowStepStatus
from models.project import Project, workflow_id_for_hub
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from services.template_copy import (
    CopyChanges,
    copy_template,
    load_template,
    not_reached_rows,
)


class WorkflowChangeWithProgress(Exception):
    """Raised when a workflow change would drop recorded stage progress."""


async def sync_project_steps(
    db: AsyncSession, project: Project, hub_is_oem: bool, *, recopy_template: bool = False
) -> CopyChanges:
    """See the module docstring. Returns the template-copy changes
    (`services.template_copy.CopyChanges`) of the existing rows; a created
    row's first copy is not a change."""

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

    template = await load_template(db, workflow_id, project.category)
    lead_times = {step_id: t.weeks for step_id, t in template.items()}

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
    repointed: set[int] = set()
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
            # ADR 0048 (p33c): the Gantt-set timing fields are always null
            # (CHECK), so nothing of them carries across.
            # ADR 0041 R6: the derived effort belonged to the old step too;
            # the caller re-derives it (`services.project_effort`).
            row.effort_weeks = None
            # P33 (OR-5): and so did its template copy; re-copied below.
            repointed.add(row.sequence_order)

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
    # P33: created rows take their first copy (not a change); re-pointed
    # rows, and on a category change every not-reached row, are re-copied.
    copy_template([r for r in rows_now if r.sequence_order not in present], template)
    to_recopy = {id(r): r for r in rows_now if r.sequence_order in repointed}
    if recopy_template:
        predecessors = {t.id: tuple(t.predecessor_ids or ()) for t in templates}
        kept = [r for r in rows_now if r.sequence_order in present]
        for r in not_reached_rows(kept, predecessors):
            to_recopy[id(r)] = r
    changes = copy_template(sorted(to_recopy.values(), key=lambda r: r.sequence_order), template)
    await db.flush()
    return changes
