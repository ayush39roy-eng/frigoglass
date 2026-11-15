"""The per-project copy of the category template (P33-T08; ADR 0046 §B and
owner ruling OR-5, R33-10; DOMAIN_RULES "Category templates" §B/§C;
contract P33 E4).

Every project step carries its own copy of the template row of its
workflow × category × step: `plan_weeks` (the length) and `plan_gap_weeks`
(the signed gap). A template change never reaches a project by itself; the
copy is written only:

- at **registration** (`services.project_steps.sync_project_steps` creates
  the 14 rows with the template's `weeks` / `gap_weeks`);
- on a **category change** or a **workflow change** (a hub move between a
  PDD and an OEM hub): the not-reached steps are re-copied (a workflow change
  is refused once any stage has progress, so every step is not reached);
- when a kind **loses its own effort figure** (OR-5 "figure cleared";
  `services.project_effort.rederive_project_effort`): the current template
  `weeks` are re-copied onto the not-reached steps of that kind, so the
  project then follows the template;
- by a template **apply** (P33-T10, not here).

**Not reached** (R33-10), on stored stage statuses (never the scheduler's
"skipped ⇒ Done"):

    reached(p, S) ⟺ stage(S) ∈ {In Progress, Blocked, Done}
                    ∨ ∃ t ∈ succ⁺(S) in the DAG in force: stage(t) ≠ Not Started

i.e. S is reached iff S itself or one of its transitive successors has
started. The DAG in force is `workflow_step_templates.predecessor_ids`.

Nothing here writes `effort_weeks` (R33-2) or a progress field, and nothing
commits: the caller owns the transaction and the audit row (the per-step
copy before / after is returned for it).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.category import Category
from models.enums import WorkflowStepStatus
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime, WorkflowStepTemplate


@dataclass(frozen=True)
class TemplateRow:
    """One template row's copyable values."""

    weeks: int
    gap_weeks: int


#: `{step_id: {"plan_weeks": [before, after], "plan_gap_weeks": [before, after]}}`
#: for every step whose copy changed (only the changed fields are listed).
CopyChanges = dict[str, dict[str, list[int]]]


async def load_template(
    db: AsyncSession, workflow_id: str, category: str | None
) -> dict[str, TemplateRow]:
    """The template rows of `workflow_id` × `category` by step id (empty when
    the project has no category: every copy is then 0, as `duration_weeks`
    is)."""

    if category is None:
        return {}
    rows = await db.execute(
        select(WorkflowLeadTime.step_id, WorkflowLeadTime.weeks, WorkflowLeadTime.gap_weeks).where(
            WorkflowLeadTime.workflow_id == workflow_id,
            WorkflowLeadTime.category == category,
        )
    )
    return {
        step_id: TemplateRow(weeks=int(weeks), gap_weeks=int(gap))
        for step_id, weeks, gap in rows.all()
    }


async def load_predecessors(db: AsyncSession, workflow_id: str) -> dict[str, tuple[str, ...]]:
    """The DAG in force of one workflow: step id -> its predecessor ids."""

    rows = await db.execute(
        select(WorkflowStepTemplate.id, WorkflowStepTemplate.predecessor_ids).where(
            WorkflowStepTemplate.workflow_id == workflow_id
        )
    )
    return {step_id: tuple(preds or ()) for step_id, preds in rows.all()}


async def share_lock_categories(db: AsyncSession, codes: Iterable[str | None]) -> None:
    """Take `FOR SHARE` on the given category rows (code order) before a
    template copy is read (P33-T10 orchestrator ruling on the apply's lock).

    An apply holds its categories `FOR NO KEY UPDATE` until it commits; `FOR
    SHARE` conflicts with that, so a registration or a category change that
    starts during an apply waits and then copies the NEW template (OR-5:
    projects registered later start from the template). The FK checks of
    those writes take only `FOR KEY SHARE` and never wait on an apply.

    Callers take it before they hold any project row lock (the apply locks
    categories, then projects), so the two never wait on each other in a
    cycle."""

    wanted = sorted({c for c in codes if c is not None})
    if not wanted:
        return
    await db.execute(
        select(Category.code)
        .where(Category.code.in_(wanted))
        .order_by(Category.code)
        .with_for_update(read=True)
    )


def reached_step_ids(
    statuses: Mapping[str, WorkflowStepStatus],
    predecessors: Mapping[str, Sequence[str]],
) -> frozenset[str]:
    """R33-10 `reached(p, S)` for every step of one project: the started steps
    (stored status ≠ Not Started) and every transitive predecessor of one.
    `statuses` holds the stored stage status by step id; `predecessors` the
    DAG in force."""

    reached: set[str] = set()
    stack = [sid for sid, st in statuses.items() if st != WorkflowStepStatus.NOT_STARTED]
    while stack:
        sid = stack.pop()
        if sid in reached:
            continue
        reached.add(sid)
        stack.extend(p for p in predecessors.get(sid, ()) if p not in reached)
    return frozenset(reached)


def copy_template(
    rows: Iterable[ProjectWorkflowStep],
    template: Mapping[str, TemplateRow],
    *,
    lengths: bool = True,
    gaps: bool = True,
) -> CopyChanges:
    """Write the template's `weeks` (when `lengths`) and `gap_weeks` (when
    `gaps`) onto `rows` (0 for a step the template has no row for). Returns
    the changes; the caller has already chosen the rows (R33-10)."""

    changes: CopyChanges = {}
    for row in rows:
        t = template.get(row.step_template_id, TemplateRow(weeks=0, gap_weeks=0))
        diff: dict[str, list[int]] = {}
        if lengths and row.plan_weeks != t.weeks:
            diff["plan_weeks"] = [row.plan_weeks, t.weeks]
            row.plan_weeks = t.weeks
        if gaps and row.plan_gap_weeks != t.gap_weeks:
            diff["plan_gap_weeks"] = [row.plan_gap_weeks, t.gap_weeks]
            row.plan_gap_weeks = t.gap_weeks
        if diff:
            changes[row.step_template_id] = diff
    return dict(sorted(changes.items()))


def not_reached_rows(
    rows: Sequence[ProjectWorkflowStep], predecessors: Mapping[str, Sequence[str]]
) -> list[ProjectWorkflowStep]:
    """The rows of one project with `¬reached` (R33-10)."""

    reached = reached_step_ids({r.step_template_id: r.status for r in rows}, predecessors)
    return [r for r in rows if r.step_template_id not in reached]


def merge_copy_changes(*parts: CopyChanges) -> CopyChanges:
    """One per-step before/after map from several successive copies (the
    first `before`, the last `after`), dropping fields that ended unchanged."""

    out: dict[str, dict[str, list[int]]] = {}
    for part in parts:
        for sid, fields in part.items():
            slot = out.setdefault(sid, {})
            for name, (before, after) in fields.items():
                slot[name] = [slot[name][0] if name in slot else before, after]
    return {
        sid: {n: v for n, v in fields.items() if v[0] != v[1]}
        for sid, fields in sorted(out.items())
        if any(v[0] != v[1] for v in fields.values())
    }
