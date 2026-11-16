"""Applying a category template change (P33-T10; DOMAIN_RULES "Category
templates" §C; ADR 0045 as amended; ADR 0046 owner ruling OR-4 > R33-10 /
R33-11 / R33-12; contract P33 E2 / E3; I31, I32).

Evaluation is per (project `p`, changed step `S`) on **stored** stage
statuses, after (for the apply) locking the category rows and then the
category's project rows `FOR UPDATE` in `project_id` order. The stage PATCH
and the check-in take the same project row lock (`lock_projects`):

    reached(p,S)   ⟺ stage(S) ∈ {In Progress, Blocked, Done}
                      ∨ ∃ t ∈ succ⁺(S): stage(t) ≠ Not Started
    never(p,S)     ⟺ p.frozen ∨ p.status ∈ {Cancelled, Commercialized} ∨ reached(p,S)
    automatic(p,S) ⟺ ¬never(p,S) ∧ every stored stage of p is Not Started
    choosable(p,S) ⟺ ¬never(p,S) ∧ ¬automatic(p,S)

`reached` is `services.template_copy.reached_step_ids` (T08). What a
receiving pair gets (OR-4):

- a gap change → `plan_gap_weeks`, for every project;
- a length change → `plan_weeks` only if `¬ownEffort(p, kind(S))`; otherwise
  nothing, flagged `own_effort_length_not_applied`.

Nothing here writes `effort_weeks`, re-derives effort or touches a progress
field (R33-2, I31 iii). A pair is "written" when one of its copy fields
actually changes value; only written pairs get `template_change_id`, an
audit before/after and count as changed for staleness and dispatch.

Listing (R33-11): a project's `steps` holds every receivable changed step
that is written, plus every own-effort length that is not applied (with the
flag, `eff_before == eff_after`). A project with no written step but an
own-effort length not applied is in `own_effort`; one with nothing at all to
receive (its copy already equals the new template) is in no list.

The apply evaluates the projects in the caller's hub scope
(`hub_scope_filter`); only global roles can call it today (Admin, Super
Admin), so in practice every project of the category.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.principal import Principal
from models.enums import ProjectStatus, WorkflowStepStatus
from models.project import Project
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from services.hub_scope import hub_scope_filter
from services.template_copy import reached_step_ids
from services.template_editor import ResolvedEntry, StepDelta
from services.workflow_durations import live_step_effective_weeks, own_effort_kinds

FLAG_REVIVED = "revived"
FLAG_SKIPPED_NOW = "skipped_now"
FLAG_GAP_IGNORED_SKIPPED = "gap_ignored_skipped"
FLAG_CERT_OFF_NO_EFFECT = "cert_off_no_effect"
FLAG_OWN_EFFORT_LENGTH_NOT_APPLIED = "own_effort_length_not_applied"
#: P35 (R35-8): the pair is received (the copy is written, so a re-include
#: gets the current copy) but the step is excluded for this project.
FLAG_EXCLUDED_NO_EFFECT = "excluded_no_effect"
#: Contract order of the step flags (deterministic wire form).
STEP_FLAGS: tuple[str, ...] = (
    FLAG_REVIVED,
    FLAG_SKIPPED_NOW,
    FLAG_GAP_IGNORED_SKIPPED,
    FLAG_CERT_OFF_NO_EFFECT,
    FLAG_OWN_EFFORT_LENGTH_NOT_APPLIED,
    FLAG_EXCLUDED_NO_EFFECT,
)

_STARTED_STAGES = frozenset(
    {WorkflowStepStatus.IN_PROGRESS, WorkflowStepStatus.BLOCKED, WorkflowStepStatus.DONE}
)
_CLOSED_REASON: Mapping[ProjectStatus, str] = {
    ProjectStatus.CANCELLED: "cancelled",
    ProjectStatus.COMMERCIALIZED: "commercialized",
}

ListName = Literal["automatic", "choosable", "own_effort"]


async def lock_projects(db: AsyncSession, project_ids: Iterable[uuid.UUID]) -> None:
    """The R33-10 project row lock: `SELECT … FOR UPDATE` on `projects`, in
    `project_id` order (the apply, the stage PATCH and the check-in all take
    it, so no stage can cross Not Started between an apply's evaluation and
    its write). Held until the caller's transaction ends.

    It selects ids only and loads no entity, so callers take it **before**
    reading the project or its stage rows (a row read earlier in the session
    would be stale; the apply re-reads with `populate_existing`). Locking an
    id the caller may not see, or one that does not exist, reveals nothing
    and is harmless."""

    ids = sorted(set(project_ids))
    if not ids:
        return
    await db.execute(
        select(Project.id).where(Project.id.in_(ids)).order_by(Project.id).with_for_update()
    )


async def lock_projects_in_scope(
    db: AsyncSession,
    project_ids: Iterable[uuid.UUID],
    scope: ColumnElement[bool] | None,
) -> set[uuid.UUID]:
    """The scoped variant of `lock_projects` (P40-F01, security S40-L1):
    the same `SELECT id … FOR UPDATE` in `project_id` order, but only on the
    rows `scope` admits (`services.hub_scope.hub_scope_filter(...)` on
    `Project.hub_id`; `None` = unrestricted), so a scoped caller never locks
    a row it may not see. Returns the ids actually locked; a caller should
    treat any other id as not found (an out-of-scope id and a nonexistent
    one then read the same). `lock_projects` itself is unchanged."""

    ids = sorted(set(project_ids))
    if not ids:
        return set()
    stmt = select(Project.id).where(Project.id.in_(ids))
    if scope is not None:
        stmt = stmt.where(scope)
    locked = (await db.execute(stmt.order_by(Project.id).with_for_update())).scalars().all()
    return set(locked)


@dataclass
class StepOutcome:
    """One listed step of one project."""

    step_id: str
    kind: str
    eff_before: int
    eff_after: int
    gap_before: int
    gap_after: int
    flags: list[str]
    #: The copy values to write (None = that field unchanged).
    write_plan_weeks: int | None
    write_plan_gap_weeks: int | None

    @property
    def written(self) -> bool:
        return self.write_plan_weeks is not None or self.write_plan_gap_weeks is not None


@dataclass
class ProjectOutcome:
    """The evaluation of one project against its category's change."""

    project: Project
    entry: ResolvedEntry
    #: frozen / cancelled / commercialized, or None.
    closed_reason: str | None
    all_not_started: bool
    #: Changed steps the project has reached (never).
    reached_step_ids: list[str]
    steps: list[StepOutcome]
    rows: dict[str, ProjectWorkflowStep]
    current_stage: tuple[str, WorkflowStepStatus] | None = None

    @property
    def written_steps(self) -> list[StepOutcome]:
        return [s for s in self.steps if s.written]

    @property
    def own_effort_steps(self) -> list[StepOutcome]:
        return [s for s in self.steps if FLAG_OWN_EFFORT_LENGTH_NOT_APPLIED in s.flags]

    @property
    def list_name(self) -> ListName | None:
        """`automatic` / `choosable` when something is written; `own_effort`
        when only own-effort lengths would be received; None otherwise
        (never, or nothing to receive)."""

        if self.closed_reason is not None:
            return None
        if self.written_steps:
            return "automatic" if self.all_not_started else "choosable"
        if self.own_effort_steps:
            return "own_effort"
        return None


@dataclass
class Evaluation:
    """Every project of the change set's categories, ordered by name, id."""

    outcomes: list[ProjectOutcome] = field(default_factory=list)

    def in_list(self, name: ListName) -> list[ProjectOutcome]:
        return [o for o in self.outcomes if o.list_name == name]

    def never(self) -> list[tuple[ProjectOutcome, str, list[str]]]:
        """`(outcome, reason, step_ids)` for every never entry."""

        out: list[tuple[ProjectOutcome, str, list[str]]] = []
        for o in self.outcomes:
            changed = [d.step_id for d in o.entry.changed]
            if o.closed_reason is not None:
                if changed:
                    out.append((o, o.closed_reason, changed))
            elif o.reached_step_ids:
                out.append((o, "reached_stage", list(o.reached_step_ids)))
        return out


def _step_outcome(
    delta: StepDelta,
    row: ProjectWorkflowStep,
    *,
    own_effort: bool,
    certification_testing_required: bool,
) -> StepOutcome | None:
    """OR-4 for one receivable pair; None when nothing is received or
    flagged."""

    flags: set[str] = set()
    new_plan = row.plan_weeks
    new_gap = row.plan_gap_weeks
    if delta.length_changed:
        if own_effort:
            flags.add(FLAG_OWN_EFFORT_LENGTH_NOT_APPLIED)
        else:
            new_plan = delta.weeks_after
            if delta.kind == "lab" and not certification_testing_required:
                flags.add(FLAG_CERT_OFF_NO_EFFECT)
    if delta.gap_changed:
        new_gap = delta.gap_after
    if row.excluded and (delta.length_changed or delta.gap_changed):
        # R35-8: an apply never touches `excluded`; the copy still lands.
        flags.add(FLAG_EXCLUDED_NO_EFFECT)

    def eff(plan_weeks: int) -> int:
        return live_step_effective_weeks(
            plan_weeks=plan_weeks,
            kind=delta.kind,
            certification_testing_required=certification_testing_required,
            own_effort=own_effort,
            effort_weeks=row.effort_weeks,
            excluded=row.excluded,
        )

    eff_before, eff_after = eff(row.plan_weeks), eff(new_plan)
    if eff_before == 0 and eff_after > 0:
        flags.add(FLAG_REVIVED)
    if eff_before > 0 and eff_after == 0:
        flags.add(FLAG_SKIPPED_NOW)
    if delta.gap_changed and eff_after == 0:
        flags.add(FLAG_GAP_IGNORED_SKIPPED)
    write_plan = new_plan if new_plan != row.plan_weeks else None
    write_gap = new_gap if new_gap != row.plan_gap_weeks else None
    if write_plan is None and write_gap is None and FLAG_OWN_EFFORT_LENGTH_NOT_APPLIED not in flags:
        return None
    return StepOutcome(
        step_id=delta.step_id,
        kind=delta.kind,
        eff_before=eff_before,
        eff_after=eff_after,
        gap_before=row.plan_gap_weeks,
        gap_after=new_gap,
        flags=[f for f in STEP_FLAGS if f in flags],
        write_plan_weeks=write_plan,
        write_plan_gap_weeks=write_gap,
    )


def _current_stage(
    rows: Iterable[ProjectWorkflowStep],
) -> tuple[str, WorkflowStepStatus] | None:
    """Contract E2: the In Progress / Blocked stage with the lowest
    `sequence_order`, else the last Done one."""

    ordered = sorted(rows, key=lambda r: r.sequence_order)
    active = [
        r
        for r in ordered
        if r.status in (WorkflowStepStatus.IN_PROGRESS, WorkflowStepStatus.BLOCKED)
    ]
    if active:
        return active[0].step_template_id, active[0].status
    done = [r for r in ordered if r.status == WorkflowStepStatus.DONE]
    if done:
        return done[-1].step_template_id, done[-1].status
    return None


def evaluate_project(
    project: Project, entry: ResolvedEntry, rows: Sequence[ProjectWorkflowStep]
) -> ProjectOutcome:
    """DOMAIN_RULES §C and OR-4 for one project (pure over loaded rows)."""

    by_step = {r.step_template_id: r for r in rows}
    workflow = entry.wf.workflow
    preds = {s.step_id: s.predecessor_ids for s in workflow.steps}
    statuses = {r.step_template_id: r.status for r in rows}
    reached = reached_step_ids(statuses, preds)
    kinds = {s.step_id: s.kind for s in workflow.steps}
    own = own_effort_kinds(((r.step_template_id, r.effort_weeks) for r in rows), kinds)
    closed: str | None = None
    if project.frozen:
        closed = "frozen"
    elif project.status in _CLOSED_REASON:
        closed = _CLOSED_REASON[project.status]

    outcome = ProjectOutcome(
        project=project,
        entry=entry,
        closed_reason=closed,
        all_not_started=all(r.status == WorkflowStepStatus.NOT_STARTED for r in rows),
        reached_step_ids=[],
        steps=[],
        rows=by_step,
        current_stage=_current_stage(rows),
    )
    if closed is not None:
        return outcome
    for delta in entry.changed:
        if delta.step_id in reached:
            outcome.reached_step_ids.append(delta.step_id)
            continue
        row = by_step.get(delta.step_id)
        if row is None:  # pragma: no cover - every project carries its 14 rows
            continue
        step = _step_outcome(
            delta,
            row,
            own_effort=delta.kind in own,
            certification_testing_required=project.certification_testing_required,
        )
        if step is not None:
            outcome.steps.append(step)
    return outcome


async def evaluate(
    db: AsyncSession,
    entries: Sequence[ResolvedEntry],
    principal: Principal,
    *,
    lock: bool,
) -> Evaluation:
    """Evaluate every project (in the caller's hub scope) of the entries'
    categories. With `lock`, the project rows are first locked `FOR UPDATE`
    in `project_id` order (contract E3 step 2) and everything is read after
    the lock."""

    by_category = {e.category.code: e for e in entries}
    if not by_category:
        return Evaluation()
    id_stmt = select(Project.id).where(Project.category.in_(sorted(by_category)))
    scope = hub_scope_filter(principal, Project.hub_id)
    if scope is not None:
        id_stmt = id_stmt.where(scope)
    project_ids = sorted((await db.execute(id_stmt)).scalars())
    if lock:
        await lock_projects(db, project_ids)
    if not project_ids:
        return Evaluation()
    projects = (
        (
            await db.execute(
                select(Project)
                .options(selectinload(Project.hub))
                .where(Project.id.in_(project_ids))
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    rows: dict[uuid.UUID, list[ProjectWorkflowStep]] = {}
    for r in (
        await db.execute(
            select(ProjectWorkflowStep)
            .where(ProjectWorkflowStep.project_id.in_(project_ids))
            .execution_options(populate_existing=True)
        )
    ).scalars():
        rows.setdefault(r.project_id, []).append(r)

    outcomes = []
    for p in projects:
        # A category change racing this read moves the project out of the
        # change set; evaluate it only if it is still of a changed category.
        entry = by_category.get(p.category or "")
        if entry is None:
            continue
        outcomes.append(evaluate_project(p, entry, rows.get(p.id, [])))
    outcomes.sort(key=lambda o: (o.project.name, str(o.project.id)))
    return Evaluation(outcomes=outcomes)


async def step_names(db: AsyncSession, step_ids: Iterable[str]) -> dict[str, str]:
    ids = sorted(set(step_ids))
    if not ids:
        return {}
    rows = await db.execute(
        select(WorkflowStepTemplate.id, WorkflowStepTemplate.name).where(
            WorkflowStepTemplate.id.in_(ids)
        )
    )
    return {sid: name for sid, name in rows.all()}


def write_copies(
    outcome: ProjectOutcome, template_change_id: uuid.UUID
) -> tuple[dict[str, dict[str, int]], dict[str, dict[str, int]]]:
    """Write the OR-4 copies of one receiving project (never `effort_weeks`,
    never a progress field). Returns the audit `(before, after)` per written
    step and field."""

    before: dict[str, dict[str, int]] = {}
    after: dict[str, dict[str, int]] = {}
    for s in outcome.written_steps:
        row = outcome.rows[s.step_id]
        b: dict[str, int] = {}
        a: dict[str, int] = {}
        if s.write_plan_weeks is not None:
            b["plan_weeks"], a["plan_weeks"] = row.plan_weeks, s.write_plan_weeks
            row.plan_weeks = s.write_plan_weeks
        if s.write_plan_gap_weeks is not None:
            b["plan_gap_weeks"], a["plan_gap_weeks"] = row.plan_gap_weeks, s.write_plan_gap_weeks
            row.plan_gap_weeks = s.write_plan_gap_weeks
        row.template_change_id = template_change_id
        before[s.step_id], after[s.step_id] = b, a
    return before, after


def change_summary(entry: ResolvedEntry, new_version: int) -> dict[str, Any]:
    """The `template_changes.changes` / audit form of one entry (before and
    after per changed field)."""

    steps = []
    for d in entry.changed:
        item: dict[str, Any] = {"step_id": d.step_id}
        if d.length_changed:
            item["weeks"] = [d.weeks_before, d.weeks_after]
        if d.gap_changed:
            item["gap_weeks"] = [d.gap_before, d.gap_after]
        steps.append(item)
    return {
        "workflow_id": entry.category.workflow_id,
        "category": entry.category.code,
        "template_version": [new_version - 1, new_version],
        "steps": steps,
    }
