"""Per-project effort split onto the steps (ADR 0041 §3, R2-R7; P30-T02).

A project's typed effort figure (`Project.design_effort_weeks`, workbook col
16; `Project.lab_effort_weeks`, col 21) is apportioned over its workflow's
steps of that kind by `scheduling.effort_split.derive_project_effort` (the
only split implementation: exact rationals, R2 tie order, R3 `max(1, ·)` on
started steps, R7 edge cases). The result is written to
`ProjectWorkflowStep.effort_weeks` and nowhere else (R4): the user's
`duration_override_weeks` is never touched, so "a table edit never clears an
override" holds and "Reset timing" restores the effort value.

Effective duration everywhere: DOMAIN_RULES "Category templates" §B (ADR
0046 OR-2) — the effort share on a kind that has the project's own figure,
else the project's template copy `plan_weeks`
(`services.workflow_durations.live_step_effective_weeks`); a step whose
effective duration is 0 is skipped (R5).

**Weights (P33-T08, R33-2; amended by ADR 0070).** R2 splits a figure over
the category template's `effort_weight_weeks` (backfilled = `weeks`), never
over `weeks` or a project's `plan_weeks`, so a template edit never reshapes a
project's split. The one exception (owner 2026-11-24, "Split the figure",
ADR 0070): a template step revived from 0 to N weeks whose weight is 0 gets
weight N (the template apply, and the Super-Admin effort-weight sync).

**Held back (ADR 0070).** A revived weight reaches a project only through
its copy: a step is held out of the split (treated as outside S′, exactly
like an excluded step, R35-3) when it is Not Started, carries no effort
share (`effort_weeks` null), its kind already follows the project's own
figure, it has a weight, and the project's copy `plan_weeks` is 0
(`held_out_step_ids`). The apply / sync writes `plan_weeks` on the pairs
that receive the revive, so only those projects re-split; a project that
had reached the step, was not selected, or was frozen / closed keeps its
split on every later re-derivation. Never applied when it would leave the
kind's S′ empty. Category and workflow changes re-derive without it
(`hold_back=False`, ADR 0041 R6 as before).

**Re-derivation** (`rederive_project_effort`, R6) runs, in the same
transaction, on:

- a figure edit (`design_effort_weeks` / `lab_effort_weeks`), and a change
  of `category` or `certification_testing_required` (the split depends on
  both) — `POST /projects`, `PATCH /projects/{id}`;
- a workflow change (a hub move between a PDD and an OEM hub;
  `sync_project_steps` re-points the rows and clears their timing);
- a step-kind edit on Workflow Settings (`rederive_all_projects`). Since
  P33 (DOMAIN_RULES §B: "R6 triggers minus the lead-time edit") a lead-time
  / template edit is no trigger: the weights are immutable — except (ADR
  0070) a template apply that revives a step's weight, which re-derives the
  receiving pairs' projects (`TRIGGER_TEMPLATE_REVIVE`), and the one-time
  Super-Admin sync (`TRIGGER_EFFORT_WEIGHT_SYNC`);
- unfreezing a project (the Gantt freeze toggle);
- a stage status crossing `Not Started` (Workspace stage PATCH, weekly
  check-in), because R3's `started` flag is an input of the split.

**A kind that loses its own figure** (OR-5, "figure cleared": a figure
blanked or 0, certification testing off for lab, or a category / step-kind
change that leaves the figure no weighted step) has the current template
`weeks` re-copied onto its not-reached steps (R33-10) in the same
transaction (`services.template_copy`), so the project then follows the
template; reached steps keep their copies. The copy before / after is in the
same audit row (`template_copy`) and on the returned result.

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
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from fastapi import status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import HTTP_422, CodedHTTPException, field_error
from models.audit import AuditLogEntry
from models.enums import WorkflowStepStatus
from models.hub import Hub
from models.project import Project, workflow_id_for_hub
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime, WorkflowStepTemplate
from scheduling.effort_split import (
    NOT_APPLIED_ALL_EXCLUDED,
    EffortSplitRejected,
    EffortStepInput,
    ProjectEffortDerivation,
    derive_project_effort,
)
from services.template_copy import (
    CopyChanges,
    copy_template,
    load_predecessors,
    load_template,
    not_reached_rows,
    share_lock_categories,
)
from services.workflow_durations import own_effort_kinds

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
#: P35 (R35-6): an exclusion or re-inclusion re-derives the split over S′.
TRIGGER_STEP_EXCLUSION = "step_exclusion"
#: ADR 0070: a template apply that revived a step's weight (the project
#: received the revived length).
TRIGGER_TEMPLATE_REVIVE = "template_revive"
#: ADR 0070: the Super-Admin one-time effort-weight sync.
TRIGGER_EFFORT_WEIGHT_SYNC = "effort_weight_sync"


@dataclass(frozen=True)
class EffortRederivation:
    """What one re-derivation did."""

    project_id: uuid.UUID
    changed: bool
    before: dict[str, int | None]
    after: dict[str, int | None]
    derivation: ProjectEffortDerivation
    #: OR-5: the template copy re-written because a kind lost its own figure
    #: (`services.template_copy.CopyChanges`; empty when none).
    template_copy: CopyChanges | None = None


def _figure_str(value: object) -> str | None:
    return None if value is None else str(value)


@dataclass(frozen=True)
class HoldBackStep:
    """One step as `held_out` reads it (live row or a target state)."""

    step_id: str
    kind: str
    weight: int
    excluded: bool
    not_started: bool
    effort_weeks: int | None
    plan_weeks: int


def held_out(steps: Iterable[HoldBackStep]) -> frozenset[str]:
    """ADR 0070 (module docstring, "Held back"): the steps held out of the
    split. A step is held out when it is Not Started, has no effort share,
    its kind already has the project's own effort (OR-1), it carries a
    weight, it is not excluded, and its copy `plan_weeks` is 0. A kind whose
    every S′ member would be held out holds none (S′ is never emptied here).

    Before ADR 0070 no such step exists (a weighted step of an own-effort
    kind always carries a share, I26), so this changes nothing on data that
    predates a revive."""

    steps = list(steps)
    own = own_effort_kinds(
        ((s.step_id, s.effort_weeks) for s in steps), {s.step_id: s.kind for s in steps}
    )
    if not own:
        return frozenset()
    members: dict[str, set[str]] = {}
    candidates: dict[str, set[str]] = {}
    for s in steps:
        if s.kind not in own or s.weight <= 0 or s.excluded:
            continue
        members.setdefault(s.kind, set()).add(s.step_id)
        if s.not_started and s.effort_weeks is None and s.plan_weeks == 0:
            candidates.setdefault(s.kind, set()).add(s.step_id)
    out: set[str] = set()
    for kind, held in candidates.items():
        if members[kind] - held:
            out |= held
    return frozenset(out)


def held_out_step_ids(
    rows: Iterable[ProjectWorkflowStep],
    kinds: Mapping[str, str],
    weights: Mapping[str, int],
    *,
    plan_overrides: Mapping[str, int] | None = None,
) -> frozenset[str]:
    """`held_out` on live rows (`plan_overrides`: copies about to be written,
    for a preview of an apply / sync)."""

    plan = plan_overrides or {}
    return held_out(
        HoldBackStep(
            step_id=r.step_template_id,
            kind=kinds.get(r.step_template_id, "elapsed"),
            weight=weights.get(r.step_template_id, 0),
            excluded=bool(r.excluded),
            not_started=r.status == WorkflowStepStatus.NOT_STARTED,
            effort_weeks=r.effort_weeks,
            plan_weeks=plan.get(r.step_template_id, r.plan_weeks),
        )
        for r in rows
    )


def effort_inputs(
    rows: Iterable[ProjectWorkflowStep],
    kinds: dict[str, str],
    weights: Mapping[str, int],
    held: frozenset[str] = frozenset(),
) -> tuple[EffortStepInput, ...]:
    """The split's step inputs from live rows: lead = the category template's
    `effort_weight_weeks` of the step (R33-2; `weights`, 0 when the template
    has no row), kind = the template's kind on Workflow Settings, started =
    stored status ≠ Not Started (R3), excluded = the row's P35 flag (R35-3:
    the split runs over S′, the weighted steps that are not excluded) or a
    held-back step (`held`, ADR 0070)."""

    return tuple(
        EffortStepInput(
            step_id=r.step_template_id,
            sequence_order=r.sequence_order,
            kind=kinds.get(r.step_template_id, "elapsed"),
            lead_weeks=weights.get(r.step_template_id, 0),
            started=r.status != WorkflowStepStatus.NOT_STARTED,
            excluded=bool(r.excluded) or r.step_template_id in held,
        )
        for r in rows
    )


def derive_for(
    project: Project,
    rows: Sequence[ProjectWorkflowStep],
    kinds: dict[str, str],
    weights: Mapping[str, int],
    *,
    hold_back: bool = True,
    plan_overrides: Mapping[str, int] | None = None,
) -> ProjectEffortDerivation:
    """`derive_project_effort` of a project's live rows over the R2 weights
    of its category (`effort_weights`), with the ADR 0070 held-back steps
    outside S′ (unless `hold_back` is False). Raises `EffortSplitRejected`
    (R7)."""

    held = (
        held_out_step_ids(rows, kinds, weights, plan_overrides=plan_overrides)
        if hold_back
        else frozenset()
    )
    return derive_project_effort(
        design_effort_weeks=project.design_effort_weeks,
        lab_effort_weeks=project.lab_effort_weeks,
        certification_testing_required=project.certification_testing_required,
        steps=effort_inputs(rows, kinds, weights, held),
    )


async def effort_weights(
    db: AsyncSession, workflow_id: str, category: str | None
) -> dict[str, int]:
    """R33-2: the `effort_weight_weeks` of `workflow_id` × `category`
    by step id (empty without a category: no split applies)."""

    if category is None:
        return {}
    return {
        step_id: int(w)
        for step_id, w in (
            await db.execute(
                select(WorkflowLeadTime.step_id, WorkflowLeadTime.effort_weight_weeks).where(
                    WorkflowLeadTime.workflow_id == workflow_id,
                    WorkflowLeadTime.category == category,
                )
            )
        ).all()
    }


async def _project_workflow_id(db: AsyncSession, project: Project) -> str:
    return workflow_id_for_hub(
        (await db.execute(select(Hub.is_oem).where(Hub.id == project.hub_id))).scalar_one()
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
    category: str | None,
    design_effort_weeks: object,
    lab_effort_weeks: object,
    certification_testing_required: bool,
    project_id: uuid.UUID | None = None,
    excluded_step_ids: Iterable[str] | None = None,
    started_step_ids: Iterable[str] | None = None,
    hold_back: bool = True,
) -> ProjectEffortDerivation | None:
    """R7 BEFORE anything is written: the split the target state would get
    (the workflow of `hub_is_oem`, the lead times of `category`, the stored
    stage statuses of `project_id` for R3). Raises `EffortSplitRejected`; the
    write paths call it first so a rejection leaves the session untouched.

    P35 (R35-3 / R35-5): the split runs over S′. The excluded steps are the
    stored flags of `project_id` (only those of the target workflow: a
    workflow change clears them, R35-11) unless `excluded_step_ids` gives the
    final state of a Save; `started_step_ids` likewise overrides the stored
    R3 flags. Returns the derivation (None without a figure), so the caller
    can apply `exclusion_guard_error` (R35-5 (a)).

    ADR 0070: with `project_id` and `hold_back`, the held-back steps of the
    stored rows (`held_out`) are outside S′, exactly as the re-derivation
    will treat them; a category or workflow change passes
    `hold_back=False`."""

    if design_effort_weeks is None and lab_effort_weeks is None:
        return None
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
    # R33-2: the split's weights are the template's immutable
    # `effort_weight_weeks`, never `weeks`.
    lead = await effort_weights(db, workflow_id, category)
    started: set[str] = set()
    excluded: set[str] = set()
    stored: dict[str, tuple[int | None, int]] = {}
    if project_id is not None:
        for step_id, status, is_excluded, effort, plan in (
            await db.execute(
                select(
                    ProjectWorkflowStep.step_template_id,
                    ProjectWorkflowStep.status,
                    ProjectWorkflowStep.excluded,
                    ProjectWorkflowStep.effort_weeks,
                    ProjectWorkflowStep.plan_weeks,
                ).where(ProjectWorkflowStep.project_id == project_id)
            )
        ).all():
            if status != WorkflowStepStatus.NOT_STARTED:
                started.add(step_id)
            if is_excluded:
                excluded.add(step_id)
            stored[step_id] = (effort, plan)
    if excluded_step_ids is not None:
        excluded = set(excluded_step_ids)
    if started_step_ids is not None:
        started = set(started_step_ids)
    held: frozenset[str] = frozenset()
    if hold_back and stored:
        held = held_out(
            HoldBackStep(
                step_id=step_id,
                kind=kind.value,
                weight=lead.get(step_id, 0),
                excluded=step_id in excluded,
                not_started=step_id not in started,
                effort_weeks=stored[step_id][0],
                plan_weeks=stored[step_id][1],
            )
            for step_id, _seq, kind in templates
            if step_id in stored
        )
    return derive_project_effort(
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
                excluded=step_id in excluded or step_id in held,
            )
            for step_id, seq, kind in templates
        ),
    )


def exclusion_guard_error(derivation: ProjectEffortDerivation | None) -> CodedHTTPException | None:
    """R35-5 (a) on a derivation of the project's final state: a figure in
    force (`inForce(p, k)`) whose every weighted step is excluded (S′ empty,
    `scheduling.effort_split.NOT_APPLIED_ALL_EXCLUDED`) is a 409
    `EFFORT_NEEDS_A_STEP` naming the kind. None when the state is allowed."""

    if derivation is None:
        return None
    for split, field in (
        (derivation.design, "design_effort_weeks"),
        (derivation.lab, "lab_effort_weeks"),
    ):
        if split.not_applied_reason == NOT_APPLIED_ALL_EXCLUDED:
            label = "design" if split.kind == "design" else "lab"
            return CodedHTTPException(
                status.HTTP_409_CONFLICT,
                "EFFORT_NEEDS_A_STEP",
                [
                    field_error(
                        field,
                        f"The project's {label} time needs at least one {label} step. "
                        f"Clear the {label} time or keep one {label} step.",
                    )
                ],
            )
    return None


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
    hold_back: bool = True,
) -> EffortRederivation | None:
    """Re-derive one project's `effort_weeks` (module docstring). `None` for a
    frozen project (no-op, R6/I10; its figures are still validated). Raises
    `EffortSplitRejected` before anything is written (R7). Flushes; the
    caller commits. `hold_back=False` (a category or workflow change)
    ignores the ADR 0070 held-back rule."""

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
    workflow_id = await _project_workflow_id(db, project)
    # R7 is checked for a frozen project too, so a figure stored while frozen
    # can always be applied on unfreeze; nothing is written for it (I10).
    derivation = derive_for(
        project,
        rows,
        kinds,
        await effort_weights(db, workflow_id, project.category),
        hold_back=hold_back,
    )
    if project.frozen:
        return None
    wanted = derivation.effort_weeks_by_step()
    before = {r.step_template_id: r.effort_weeks for r in rows}
    after = {r.step_template_id: wanted.get(r.step_template_id) for r in rows}
    changed = before != after
    recopied: CopyChanges = {}
    if changed:
        # OR-5 "figure cleared": a kind that loses its own effort follows the
        # template again on its not-reached steps (R33-10).
        lost = own_effort_kinds(before.items(), kinds) - own_effort_kinds(after.items(), kinds)
        for r in rows:
            r.effort_weeks = after[r.step_template_id]
        if lost:
            # P33-T10 ruling (OR-5): wait for an in-flight template apply of
            # the category, then copy its new template. Every caller that can
            # clear a figure takes this lock BEFORE any project-row lock
            # (PATCH, register batch, unfreeze, `rederive_all_projects`), so
            # here it is already held and re-taking it never waits.
            await share_lock_categories(db, [project.category])
            predecessors = await load_predecessors(db, workflow_id)
            recopied = copy_template(
                [
                    r
                    for r in not_reached_rows(rows, predecessors)
                    if kinds.get(r.step_template_id, "elapsed") in lost
                ],
                await load_template(db, workflow_id, project.category),
                gaps=False,
            )
        project.schedule_stale = True
        if audit:
            after_state = _state(project, after, derivation, trigger=trigger)
            if recopied:
                after_state["template_copy"] = recopied
            db.add(
                AuditLogEntry(
                    actor_user_id=actor_user_id,
                    action=AUDIT_ACTION,
                    entity_type="Project",
                    entity_id=str(project.id),
                    hub_id=project.hub_id,
                    before_state=_state(project, before, None),
                    after_state=after_state,
                )
            )
        await db.flush()
    return EffortRederivation(
        project_id=project.id,
        changed=changed,
        before=before,
        after=after,
        derivation=derivation,
        template_copy=recopied or None,
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
        "category": project.category,
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
    # P33-T10 ruling (OR-5): the categories' FOR SHARE before this loop writes
    # any project row (a re-derivation may re-copy the template).
    await share_lock_categories(db, [p.category for p in projects])
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
