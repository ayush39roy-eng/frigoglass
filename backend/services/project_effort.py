"""Per-project effort split onto the steps (ADR 0041 §3, R2-R7; P30-T02).

A project's typed effort figure (`Project.design_effort_weeks`, workbook col
16; `Project.lab_effort_weeks`, col 21) is apportioned over its workflow's
steps of that kind by `scheduling.effort_split.derive_project_effort` (the
only split implementation: exact rationals, R2 tie order, R3 `max(1, ·)` on
started steps, R7 edge cases). The result is written to
`ProjectWorkflowStep.effort_weeks` and nowhere else (R4): the user's
`duration_override_weeks` is never touched, so "a table edit never clears an
override" holds and "Reset timing" restores the effort value.

Effective duration everywhere = `user ?? effort ?? lead`
(`scheduling.merged_step_override` + `step_effective_weeks`); a step whose
effective duration is 0 is skipped (R5).

**Re-derivation** (`rederive_project_effort`, R6) runs, in the same
transaction, on:

- a figure edit (`design_effort_weeks` / `lab_effort_weeks`), and a change
  of `category` or `certification_testing_required` (the split depends on
  both) — `POST /projects`, `PATCH /projects/{id}`;
- a workflow change (a hub move between a PDD and an OEM hub;
  `sync_project_steps` re-points the rows and clears their timing);
- a lead-time table edit and a step-kind edit on Workflow Settings
  (`rederive_all_projects`);
- unfreezing a project (the Gantt freeze toggle);
- a stage status crossing `Not Started` (Workspace stage PATCH, weekly
  check-in), because R3's `started` flag is an input of the split.

Scope: every project with a figure or a stored effort value, non-schedulable
ones included (R6). A **frozen** project is a no-op (I10; it is re-derived on
unfreeze). A re-derivation that changes any step writes one
`project.effort_rederived` audit row (before/after per step, the figures,
the trigger) and sets `schedule_stale`; it never runs a solve.

R7: a split that would put a step above 104 weeks raises
`EffortSplitRejected`; the API turns it into a 422 `EFFORT_SPLIT_REJECTED`
and nothing is written (the caller rolls back). A figure whose category has
no non-zero step of the kind, or a lab figure with certification testing off,
is *not applied* (no effort written; reported in the audit row).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import HTTP_422, CodedHTTPException, field_error
from models.audit import AuditLogEntry
from models.enums import ProjectCategory, WorkflowStepStatus
from models.project import Project, workflow_id_for_hub
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime, WorkflowStepTemplate
from scheduling.effort_split import (
    EffortSplitRejected,
    EffortStepInput,
    ProjectEffortDerivation,
    derive_project_effort,
)

#: Audit action of a re-derivation that changed at least one step (R6).
AUDIT_ACTION = "project.effort_rederived"

#: `trigger` values recorded on the audit row.
TRIGGER_FIGURE = "effort_figure"
TRIGGER_PROJECT_FIELDS = "project_fields"
TRIGGER_WORKFLOW_CHANGE = "workflow_change"
TRIGGER_LEAD_TIME_EDIT = "lead_time_edit"
TRIGGER_STEP_KIND_EDIT = "step_kind_edit"
TRIGGER_UNFREEZE = "unfreeze"
TRIGGER_STAGE_STATUS = "stage_status"
TRIGGER_CREATE = "project_create"
TRIGGER_IMPORT = "import"


@dataclass(frozen=True)
class EffortRederivation:
    """What one re-derivation did."""

    project_id: uuid.UUID
    changed: bool
    before: dict[str, int | None]
    after: dict[str, int | None]
    derivation: ProjectEffortDerivation


def _figure_str(value: object) -> str | None:
    return None if value is None else str(value)


def effort_inputs(
    rows: Iterable[ProjectWorkflowStep], kinds: dict[str, str]
) -> tuple[EffortStepInput, ...]:
    """The split's step inputs from live rows: lead = the row's lead-time
    duration (`duration_weeks`, kept equal to the table by
    `sync_project_steps` / `recompute_step_durations`), kind = the template's
    kind on Workflow Settings, started = stored status ≠ Not Started (R3)."""

    return tuple(
        EffortStepInput(
            step_id=r.step_template_id,
            sequence_order=r.sequence_order,
            kind=kinds.get(r.step_template_id, "elapsed"),
            lead_weeks=r.duration_weeks,
            started=r.status != WorkflowStepStatus.NOT_STARTED,
        )
        for r in rows
    )


def derive_for(
    project: Project, rows: Sequence[ProjectWorkflowStep], kinds: dict[str, str]
) -> ProjectEffortDerivation:
    """`derive_project_effort` of a project's live rows. Raises
    `EffortSplitRejected` (R7)."""

    return derive_project_effort(
        design_effort_weeks=project.design_effort_weeks,
        lab_effort_weeks=project.lab_effort_weeks,
        certification_testing_required=project.certification_testing_required,
        steps=effort_inputs(rows, kinds),
    )


async def _template_kinds(db: AsyncSession) -> dict[str, str]:
    return {
        step_id: kind.value
        for step_id, kind in (
            await db.execute(select(WorkflowStepTemplate.id, WorkflowStepTemplate.kind))
        ).all()
    }


def split_rejected_error(
    exc: EffortSplitRejected, kinds: dict[str, str] | None = None
) -> CodedHTTPException:
    """R7 at write: 422 `EFFORT_SPLIT_REJECTED`, on the figure whose split
    exceeds 104 weeks on a step (`design_effort_weeks` or
    `lab_effort_weeks`, by the step's kind)."""

    kind = (kinds or {}).get(exc.step_id)
    field = "lab_effort_weeks" if kind == "lab" else "design_effort_weeks"
    return CodedHTTPException(HTTP_422, "EFFORT_SPLIT_REJECTED", [field_error(field, str(exc))])


async def validate_effort_split(
    db: AsyncSession,
    *,
    hub_is_oem: bool,
    category: ProjectCategory | None,
    design_effort_weeks: object,
    lab_effort_weeks: object,
    certification_testing_required: bool,
    project_id: uuid.UUID | None = None,
) -> None:
    """R7 BEFORE anything is written: the split the target state would get
    (the workflow of `hub_is_oem`, the lead times of `category`, the stored
    stage statuses of `project_id` for R3). Raises `EffortSplitRejected`; the
    write paths call it first so a rejection leaves the session untouched."""

    if design_effort_weeks is None and lab_effort_weeks is None:
        return
    workflow_id = workflow_id_for_hub(hub_is_oem)
    templates = (
        await db.execute(
            select(
                WorkflowStepTemplate.id,
                WorkflowStepTemplate.sequence_order,
                WorkflowStepTemplate.kind,
            ).where(WorkflowStepTemplate.workflow_id == workflow_id)
        )
    ).all()
    lead: dict[str, int] = {}
    if category is not None:
        lead = {
            step_id: int(weeks)
            for step_id, weeks in (
                await db.execute(
                    select(WorkflowLeadTime.step_id, WorkflowLeadTime.weeks).where(
                        WorkflowLeadTime.workflow_id == workflow_id,
                        WorkflowLeadTime.category == category,
                    )
                )
            ).all()
        }
    started: set[str] = set()
    if project_id is not None:
        started = {
            step_id
            for step_id, status in (
                await db.execute(
                    select(ProjectWorkflowStep.step_template_id, ProjectWorkflowStep.status).where(
                        ProjectWorkflowStep.project_id == project_id
                    )
                )
            ).all()
            if status != WorkflowStepStatus.NOT_STARTED
        }
    derive_project_effort(
        design_effort_weeks=design_effort_weeks,  # type: ignore[arg-type]
        lab_effort_weeks=lab_effort_weeks,  # type: ignore[arg-type]
        certification_testing_required=certification_testing_required,
        steps=tuple(
            EffortStepInput(
                step_id=step_id,
                sequence_order=seq,
                kind=kind.value,
                lead_weeks=lead.get(step_id, 0),
                started=step_id in started,
            )
            for step_id, seq, kind in templates
        ),
    )


async def template_kinds(db: AsyncSession) -> dict[str, str]:
    """Step id -> its kind on Workflow Settings (`design` / `lab` / `elapsed`)."""

    return await _template_kinds(db)


async def rederive_project_effort(
    db: AsyncSession,
    project: Project,
    *,
    trigger: str,
    actor_user_id: uuid.UUID | None,
    kinds: dict[str, str] | None = None,
    rows: Sequence[ProjectWorkflowStep] | None = None,
    audit: bool = True,
) -> EffortRederivation | None:
    """Re-derive one project's `effort_weeks` (module docstring). `None` for a
    frozen project (no-op, R6/I10; its figures are still validated). Raises
    `EffortSplitRejected` before anything is written (R7). Flushes; the
    caller commits."""

    if kinds is None:
        kinds = await _template_kinds(db)
    if rows is None:
        rows = (
            (
                await db.execute(
                    select(ProjectWorkflowStep)
                    .where(ProjectWorkflowStep.project_id == project.id)
                    .order_by(ProjectWorkflowStep.sequence_order)
                )
            )
            .scalars()
            .all()
        )
    # R7 is checked for a frozen project too, so a figure stored while frozen
    # can always be applied on unfreeze; nothing is written for it (I10).
    derivation = derive_for(project, rows, kinds)
    if project.frozen:
        return None
    wanted = derivation.effort_weeks_by_step()
    before = {r.step_template_id: r.effort_weeks for r in rows}
    after = {r.step_template_id: wanted.get(r.step_template_id) for r in rows}
    changed = before != after
    if changed:
        for r in rows:
            r.effort_weeks = after[r.step_template_id]
        project.schedule_stale = True
        if audit:
            db.add(
                AuditLogEntry(
                    actor_user_id=actor_user_id,
                    action=AUDIT_ACTION,
                    entity_type="Project",
                    entity_id=str(project.id),
                    hub_id=project.hub_id,
                    before_state=_state(project, before, None),
                    after_state=_state(project, after, derivation, trigger=trigger),
                )
            )
        await db.flush()
    return EffortRederivation(
        project_id=project.id,
        changed=changed,
        before=before,
        after=after,
        derivation=derivation,
    )


def _state(
    project: Project,
    effort: dict[str, int | None],
    derivation: ProjectEffortDerivation | None,
    *,
    trigger: str | None = None,
) -> dict[str, Any]:
    """Audit snapshot: figures and the per-step effort (never a financial
    field)."""

    out: dict[str, Any] = {
        "project_id": str(project.id),
        "design_effort_weeks": _figure_str(project.design_effort_weeks),
        "lab_effort_weeks": _figure_str(project.lab_effort_weeks),
        "certification_testing_required": project.certification_testing_required,
        "category": project.category.value if project.category else None,
        "effort_weeks": dict(sorted(effort.items())),
    }
    if derivation is not None:
        out["design_split"] = {
            "applied": derivation.design.applied,
            "not_applied_reason": derivation.design.not_applied_reason,
            "target_weeks": derivation.design.target_weeks,
            "raised_step_ids": list(derivation.design.raised_step_ids),
        }
        out["lab_split"] = {
            "applied": derivation.lab.applied,
            "not_applied_reason": derivation.lab.not_applied_reason,
            "target_weeks": derivation.lab.target_weeks,
            "raised_step_ids": list(derivation.lab.raised_step_ids),
        }
    if trigger is not None:
        out["trigger"] = trigger
    return out


async def rederive_all_projects(
    db: AsyncSession, *, trigger: str, actor_user_id: uuid.UUID | None
) -> list[EffortRederivation]:
    """R6 for a Workflow Settings edit (lead time or step kind): every
    non-frozen project with a figure or a stored effort value. Raises
    `EffortSplitRejected` for the first project whose new split exceeds 104
    weeks on a step (the edit is then rejected as a whole)."""

    kinds = await _template_kinds(db)
    has_effort = select(ProjectWorkflowStep.project_id).where(
        ProjectWorkflowStep.effort_weeks.is_not(None)
    )
    projects = (
        (
            await db.execute(
                select(Project)
                .execution_options(populate_existing=True)
                .where(
                    Project.frozen.is_(False),
                    or_(
                        Project.design_effort_weeks.is_not(None),
                        Project.lab_effort_weeks.is_not(None),
                        Project.id.in_(has_effort),
                    ),
                )
                .order_by(Project.id)
            )
        )
        .scalars()
        .all()
    )
    if not projects:
        return []
    rows_by_project: dict[uuid.UUID, list[ProjectWorkflowStep]] = {}
    for r in (
        await db.execute(
            select(ProjectWorkflowStep)
            .execution_options(populate_existing=True)
            .where(ProjectWorkflowStep.project_id.in_([p.id for p in projects]))
            .order_by(ProjectWorkflowStep.project_id, ProjectWorkflowStep.sequence_order)
        )
    ).scalars():
        rows_by_project.setdefault(r.project_id, []).append(r)
    out: list[EffortRederivation] = []
    for p in projects:
        result = await rederive_project_effort(
            db,
            p,
            trigger=trigger,
            actor_user_id=actor_user_id,
            kinds=kinds,
            rows=rows_by_project.get(p.id, []),
        )
        if result is not None:
            out.append(result)
    return out
