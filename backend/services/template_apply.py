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
field (R33-2, I31 iii) — except the ADR 0070 revive below. A pair is
"written" when one of its copy fields actually changes value; only written
pairs get `template_change_id`, an audit before/after and count as changed
for staleness and dispatch.

**Revive (ADR 0070, owner 2026-11-24 "Split the figure", amends OR-4 and
R33-2).** A length change `0 → N > 0` on a step whose template
`effort_weight_weeks` is 0 also sets that weight to N
(`revived_weights`). An own-effort pair `(p, S)` of such a step that is
received (¬never) gets the copy `plan_weeks = N` like any other pair AND its
project's effort is re-derived over the new weights
(`services.project_effort.rederive_project_effort`, audit
`project.effort_rederived`, trigger `template_revive`); the step is then no
longer skipped unless its share is 0. `plan_effort_revive` predicts that
re-derivation for the preview and gates it: when the re-split would change
the share of a reached step (started, or before a started step), or R7
rejects it, the pair falls back to `own_effort_length_not_applied` and
nothing is written for it (the copy stays 0, so the held-back rule keeps the
step out of every later split). Steps of the project whose effective
duration the re-split changes are listed too, with no flag.

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
from scheduling.effort_split import EffortSplitRejected
from services.hub_scope import hub_scope_filter
from services.project_effort import derive_for, effort_weights
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
    #: ADR 0070: the predicted `effort_weeks` after the revive re-derivation
    #: (None = this project receives no revive and is not re-derived).
    effort_after: dict[str, int | None] | None = None

    @property
    def needs_rederive(self) -> bool:
        return self.effort_after is not None

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
        if self.written_steps or self.needs_rederive:
            return "automatic" if self.all_not_started else "choosable"
        if self.own_effort_steps:
            return "own_effort"
        return None


@dataclass
class Evaluation:
    """Every project of the change set's categories, ordered by name, id."""

    outcomes: list[ProjectOutcome] = field(default_factory=list)
    #: ADR 0070: category code -> {step id: new weight} of the revived
    #: template weights (`revived_weights`, read under the apply's lock).
    revived: dict[str, dict[str, int]] = field(default_factory=dict)

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
    revive: bool = False,
    effort_after: Mapping[str, int | None] | None = None,
    own_effort_after: bool | None = None,
) -> StepOutcome | None:
    """OR-4 for one receivable pair; None when nothing is received or
    flagged. ADR 0070: with `revive`, an own-effort length is received (the
    copy is written) and `eff_after` reads the predicted re-split
    (`effort_after`, `own_effort_after`)."""

    flags: set[str] = set()
    new_plan = row.plan_weeks
    new_gap = row.plan_gap_weeks
    if delta.length_changed:
        if own_effort and revive:
            new_plan = delta.weeks_after
        elif own_effort:
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

    def eff(plan_weeks: int, *, after: bool) -> int:
        resplit = after and effort_after is not None
        return live_step_effective_weeks(
            plan_weeks=plan_weeks,
            kind=delta.kind,
            certification_testing_required=certification_testing_required,
            own_effort=(
                bool(own_effort_after) if resplit and own_effort_after is not None else own_effort
            ),
            effort_weeks=(
                effort_after.get(delta.step_id)
                if resplit and effort_after is not None
                else row.effort_weeks
            ),
            excluded=row.excluded,
        )

    eff_before, eff_after = eff(row.plan_weeks, after=False), eff(new_plan, after=True)
    if eff_before == 0 and eff_after > 0:
        flags.add(FLAG_REVIVED)
    if eff_before > 0 and eff_after == 0:
        flags.add(FLAG_SKIPPED_NOW)
    if delta.gap_changed and eff_after == 0:
        flags.add(FLAG_GAP_IGNORED_SKIPPED)
    write_plan = new_plan if new_plan != row.plan_weeks else None
    write_gap = new_gap if new_gap != row.plan_gap_weeks else None
    if (
        write_plan is None
        and write_gap is None
        and FLAG_OWN_EFFORT_LENGTH_NOT_APPLIED not in flags
        and not (revive and eff_before != eff_after)
    ):
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


def revived_weights(entry: ResolvedEntry, weights: Mapping[str, int]) -> dict[str, int]:
    """ADR 0070 (amends R33-2): the template weights an apply of `entry`
    revives — every step whose length changes to N > 0 while its stored
    `effort_weight_weeks` is 0 gets weight N. Every other weight is left
    alone (the DB trigger allows exactly this change, migration p70a)."""

    return {
        d.step_id: d.weeks_after
        for d in entry.changed
        if d.length_changed and d.weeks_after > 0 and weights.get(d.step_id, 0) == 0
    }


@dataclass(frozen=True)
class RevivePlan:
    """What a revive does to one project (`plan_effort_revive`)."""

    #: The revived steps the project receives (copy written, effort re-split).
    step_ids: tuple[str, ...]
    #: Copy writes: step id -> `plan_weeks` (only values that change).
    plan_writes: dict[str, int]
    #: The predicted `effort_weeks` of every row after the re-derivation;
    #: None when nothing is received.
    effort_after: dict[str, int | None] | None
    #: Revived own-effort steps NOT received: step id -> reason
    #: (`reached_stage`, `started_share`, `split_rejected`).
    not_applied: dict[str, str]


def plan_effort_revive(
    project: Project,
    rows: Sequence[ProjectWorkflowStep],
    kinds: Mapping[str, str],
    reached: frozenset[str],
    weights_after: Mapping[str, int],
    revive: Mapping[str, int],
) -> RevivePlan:
    """ADR 0070 for one project that is not frozen / Cancelled /
    Commercialized: of the revived steps (`revive`, step id -> N), the ones
    whose kind follows the project's own figure (OR-1) and that are not
    reached (R33-10) are received: the copy becomes N and the effort is
    re-derived over `weights_after` (`derive_for`, the held-back rule seeing
    the new copies). The whole revive is refused (`started_share`) when the
    re-split would change the effort of a reached step (owner: never touch
    Done / In Progress / reached steps), or (`split_rejected`) when R7
    rejects it. Pure: nothing is written."""

    own = own_effort_kinds(((r.step_template_id, r.effort_weeks) for r in rows), kinds)
    by_step = {r.step_template_id: r for r in rows}
    received: dict[str, int] = {}
    not_applied: dict[str, str] = {}
    for step_id, weeks in sorted(revive.items()):
        if kinds.get(step_id, "elapsed") not in own or step_id not in by_step:
            continue
        if step_id in reached:
            not_applied[step_id] = "reached_stage"
            continue
        received[step_id] = weeks
    if not received:
        return RevivePlan((), {}, None, not_applied)
    try:
        derivation = derive_for(
            project, list(rows), dict(kinds), weights_after, plan_overrides=received
        )
    except EffortSplitRejected:
        refused = dict.fromkeys(received, "split_rejected")
        return RevivePlan((), {}, None, {**not_applied, **refused})
    wanted = derivation.effort_weeks_by_step()
    after = {r.step_template_id: wanted.get(r.step_template_id) for r in rows}
    if any(after[sid] != by_step[sid].effort_weeks for sid in reached if sid in by_step):
        return RevivePlan((), {}, None, {**not_applied, **dict.fromkeys(received, "started_share")})
    plan_writes = {sid: w for sid, w in received.items() if by_step[sid].plan_weeks != w}
    return RevivePlan(tuple(sorted(received)), plan_writes, after, not_applied)


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
    project: Project,
    entry: ResolvedEntry,
    rows: Sequence[ProjectWorkflowStep],
    *,
    weights: Mapping[str, int] | None = None,
) -> ProjectOutcome:
    """DOMAIN_RULES §C and OR-4 for one project (pure over loaded rows), with
    the ADR 0070 revive when `weights` (the category's current
    `effort_weight_weeks`) are given."""

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
    revive = revived_weights(entry, weights) if weights is not None else {}
    plan = (
        plan_effort_revive(project, rows, kinds, reached, {**(weights or {}), **revive}, revive)
        if revive
        else None
    )
    effort_after = plan.effort_after if plan is not None else None
    own_after = own_effort_kinds(effort_after.items(), kinds) if effort_after is not None else None
    received = set(plan.step_ids) if plan is not None else set()
    listed: set[str] = set()
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
            revive=delta.step_id in received,
            effort_after=effort_after,
            own_effort_after=(delta.kind in own_after) if own_after is not None else None,
        )
        if step is not None:
            outcome.steps.append(step)
            listed.add(step.step_id)
    if effort_after is not None and own_after is not None:
        outcome.effort_after = effort_after
        # R33-11 honesty: the other steps whose eff the re-split changes.
        for r in rows:
            sid = r.step_template_id
            if sid in listed:
                continue
            kind = kinds.get(sid, "elapsed")
            cert = project.certification_testing_required
            before = live_step_effective_weeks(
                plan_weeks=r.plan_weeks, kind=kind, certification_testing_required=cert,
                own_effort=kind in own, effort_weeks=r.effort_weeks, excluded=r.excluded,
            )  # fmt: skip
            after = live_step_effective_weeks(
                plan_weeks=r.plan_weeks, kind=kind, certification_testing_required=cert,
                own_effort=kind in own_after, effort_weeks=effort_after.get(sid),
                excluded=r.excluded,
            )  # fmt: skip
            if before != after:
                outcome.steps.append(
                    StepOutcome(
                        step_id=sid, kind=kind, eff_before=before, eff_after=after,
                        gap_before=r.plan_gap_weeks, gap_after=r.plan_gap_weeks,
                        flags=[], write_plan_weeks=None, write_plan_gap_weeks=None,
                    )
                )  # fmt: skip
        order = {s.step_id: i for i, s in enumerate(workflow.steps)}
        outcome.steps.sort(key=lambda st: order.get(st.step_id, len(order)))
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
    # ADR 0070: the categories' current weights (read after the caller's
    # category lock, so the revive decided here is the one written).
    weights = {
        code: await effort_weights(db, e.category.workflow_id, code)
        for code, e in by_category.items()
    }
    revived = {
        code: rv for code, e in by_category.items() if (rv := revived_weights(e, weights[code]))
    }
    id_stmt = select(Project.id).where(Project.category.in_(sorted(by_category)))
    scope = hub_scope_filter(principal, Project.hub_id)
    if scope is not None:
        id_stmt = id_stmt.where(scope)
    project_ids = sorted((await db.execute(id_stmt)).scalars())
    if lock:
        await lock_projects(db, project_ids)
    if not project_ids:
        return Evaluation(revived=revived)
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
        outcomes.append(
            evaluate_project(p, entry, rows.get(p.id, []), weights=weights[entry.category.code])
        )
    outcomes.sort(key=lambda o: (o.project.name, str(o.project.id)))
    return Evaluation(outcomes=outcomes, revived=revived)


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


def change_summary(
    entry: ResolvedEntry, new_version: int, revived: Mapping[str, int] | None = None
) -> dict[str, Any]:
    """The `template_changes.changes` / audit form of one entry (before and
    after per changed field; ADR 0070: a revived weight as
    `effort_weight_weeks: [0, N]`)."""

    steps = []
    for d in entry.changed:
        item: dict[str, Any] = {"step_id": d.step_id}
        if d.length_changed:
            item["weeks"] = [d.weeks_before, d.weeks_after]
        if d.gap_changed:
            item["gap_weeks"] = [d.gap_before, d.gap_after]
        if revived and d.step_id in revived:
            item["effort_weight_weeks"] = [0, revived[d.step_id]]
        steps.append(item)
    return {
        "workflow_id": entry.category.workflow_id,
        "category": entry.category.code,
        "template_version": [new_version - 1, new_version],
        "steps": steps,
    }
