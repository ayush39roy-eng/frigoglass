"""Category template editing: shared validation and the C2 timeline payload
(P33-T09..T10; `docs/API_CONTRACT_P33.md` Parts C2, D, E1; DOMAIN_RULES
"Category templates" §A, §D "Template preview").

- `category_timeline_payload` builds one C2 category object from
  `scheduling.template_timeline` (called through
  `services.workflow_previews.template_timeline_for`, never reimplemented).
- `resolve_entry` validates one (workflow, category, steps) request against
  the template in force, with the contract's error codes:
  - unknown workflow / unknown category / a category of another workflow:
    422 in the enum-shaped envelope the category enum produced (contract B3,
    `services.categories.unknown_category_error`);
  - an unknown step, a step of another workflow or a step listed twice:
    422 `BAD_STEP`;
  - a non-zero resulting gap on the workflow's first step: 422
    `FIRST_STEP_GAP`;
  - (change sets only) a step whose given values all equal the saved ones:
    422 `NO_CHANGE`.
  Ranges (weeks 0..104, gap -104..104) are the request schema's.

Nothing here writes.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import HTTP_422, CodedHTTPException
from models.category import Category
from models.enums import WorkflowStepKind
from models.workflow import Workflow as WorkflowRow
from scheduling.template_timeline import TemplateTimeline
from schemas.workflow_settings import CategoryTimeline, TimelineStep
from schemas.workflow_templates import TemplateStepOverride
from services.categories import unknown_category_error
from services.workflow_previews import (
    TemplateCell,
    WorkflowInForce,
    load_template_cells,
    load_workflow_in_force,
    ordered_flags,
    template_timeline_for,
)


@dataclass(frozen=True)
class StepDelta:
    """One requested step of one (workflow, category): the saved template
    values and the values after the change."""

    step_id: str
    kind: str
    weeks_before: int
    weeks_after: int
    gap_before: int
    gap_after: int

    @property
    def length_changed(self) -> bool:
        return self.weeks_before != self.weeks_after

    @property
    def gap_changed(self) -> bool:
        return self.gap_before != self.gap_after


@dataclass(frozen=True)
class ResolvedEntry:
    """One validated (workflow, category) with its saved cells and deltas."""

    wf: WorkflowInForce
    category: Category
    cells: Mapping[str, TemplateCell]
    #: In the workflow's display order.
    deltas: tuple[StepDelta, ...]

    @property
    def overrides(self) -> dict[str, TemplateCell]:
        return {
            d.step_id: TemplateCell(weeks=d.weeks_after, gap_weeks=d.gap_after) for d in self.deltas
        }

    @property
    def changed(self) -> tuple[StepDelta, ...]:
        return tuple(d for d in self.deltas if d.length_changed or d.gap_changed)


def bad_step(message: str) -> CodedHTTPException:
    return CodedHTTPException(HTTP_422, "BAD_STEP", message)


async def load_categories(
    db: AsyncSession, codes: Sequence[str] | None = None, *, lock: bool = False
) -> dict[str, Category]:
    """Category rows by code (fresh). With `lock`, the rows are taken `FOR NO
    KEY UPDATE` in code order: the apply's version lock (contract E3 step 1).
    `NO KEY` because only `template_version` changes, so the FK checks of a
    concurrent registration or category change (`FOR KEY SHARE`) never wait
    on it, and it never waits on them."""

    stmt = select(Category).order_by(Category.code).execution_options(populate_existing=True)
    if codes is not None:
        stmt = stmt.where(Category.code.in_(list(codes)))
    if lock:
        stmt = stmt.with_for_update(key_share=True)
    return {c.code: c for c in (await db.execute(stmt)).scalars()}


async def resolve_entry(
    db: AsyncSession,
    *,
    workflow_id: str,
    category_code: str,
    steps: Sequence[TemplateStepOverride],
    loc: tuple[str | int, ...],
    categories: Mapping[str, Category],
    require_change: bool,
) -> ResolvedEntry:
    """Validate one entry (module docstring) and return its deltas.
    `categories` are the rows the caller loaded (locked, for the apply)."""

    workflow_ids = list(
        (await db.execute(select(WorkflowRow.id).order_by(WorkflowRow.id))).scalars()
    )
    if workflow_id not in workflow_ids:
        raise unknown_category_error([workflow_id], loc=(*loc, "workflow_id"), allowed=workflow_ids)
    category = categories.get(category_code)
    if category is None or category.workflow_id != workflow_id:
        allowed = sorted(
            (c for c in categories.values() if c.workflow_id == workflow_id),
            key=lambda c: (c.rank, c.code),
        )
        if category is None:
            # The caller loaded only the codes it was asked about; read the
            # workflow's codes for the message.
            rows = await db.execute(
                select(Category.code)
                .where(Category.workflow_id == workflow_id)
                .order_by(Category.rank, Category.code)
            )
            names = list(rows.scalars())
        else:
            names = [c.code for c in allowed]
        raise unknown_category_error([category_code], loc=(*loc, "category"), allowed=names)

    wf = await load_workflow_in_force(db, workflow_id)
    assert wf is not None  # the workflow row exists, and every workflow has steps
    cells = (await load_template_cells(db, workflow_id, [category_code])).get(category_code, {})

    seen: set[str] = set()
    by_id: dict[str, StepDelta] = {}
    for i, s in enumerate(steps):
        if s.step_id not in wf.workflow.steps_by_id:
            raise bad_step(f"steps[{i}]: {s.step_id!r} is not a step of workflow {workflow_id!r}")
        if s.step_id in seen:
            raise bad_step(f"steps[{i}]: {s.step_id!r} is listed more than once")
        seen.add(s.step_id)
        if s.step_id not in cells:
            raise bad_step(
                f"steps[{i}]: category {category_code!r} has no template row for {s.step_id!r}"
            )
        saved = cells[s.step_id]
        delta = StepDelta(
            step_id=s.step_id,
            kind=wf.workflow.steps_by_id[s.step_id].kind,
            weeks_before=saved.weeks,
            weeks_after=saved.weeks if s.weeks is None else s.weeks,
            gap_before=saved.gap_weeks,
            gap_after=saved.gap_weeks if s.gap_weeks is None else s.gap_weeks,
        )
        if delta.gap_after != 0 and s.step_id in wf.first_step_ids:
            raise CodedHTTPException(
                HTTP_422,
                "FIRST_STEP_GAP",
                f"{s.step_id!r} is the first step of workflow {workflow_id!r}; its gap must be 0",
            )
        if require_change and not (delta.length_changed or delta.gap_changed):
            raise CodedHTTPException(
                HTTP_422,
                "NO_CHANGE",
                f"{workflow_id}/{category_code} {s.step_id}: the values equal the saved template",
            )
        by_id[s.step_id] = delta
    ordered = tuple(by_id[s.step_id] for s in wf.workflow.steps if s.step_id in by_id)
    return ResolvedEntry(wf=wf, category=category, cells=cells, deltas=ordered)


def category_timeline_payload(
    wf: WorkflowInForce, category: Category, timeline: TemplateTimeline
) -> CategoryTimeline:
    """One C2 category object (contract P33 C2)."""

    kinds = {s.step_id: s.kind for s in wf.workflow.steps}
    return CategoryTimeline(
        category=category.code,
        label=category.label,
        workflow_id=category.workflow_id,
        rank=category.rank,
        template_version=category.template_version,
        total_weeks=timeline.total_weeks,
        design_weeks=timeline.design_weeks,
        lab_weeks=timeline.lab_weeks,
        note=timeline.note,
        steps=[
            TimelineStep(
                code=s.step_id,
                name=wf.names.get(s.step_id, s.step_id),
                resource_kind=WorkflowStepKind(kinds[s.step_id]),
                start_week=s.start_week,
                duration_weeks=s.duration_weeks,
                gap_weeks=s.requested_gap_weeks,
                effective_gap_weeks=s.effective_gap_weeks,
                flags=ordered_flags(s.flags),
                predecessor_ids=list(wf.workflow.steps_by_id[s.step_id].predecessor_ids),
            )
            for s in timeline.steps
        ],
    )


async def category_timelines(db: AsyncSession, workflow_id: str) -> list[CategoryTimeline]:
    """`GET /workflow-settings/category-timelines` (C2): every category of
    `workflow_id` in rank order, from the saved template."""

    wf = await load_workflow_in_force(db, workflow_id)
    if wf is None:
        return []
    cats = sorted(
        (c for c in (await load_categories(db)).values() if c.workflow_id == workflow_id),
        key=lambda c: (c.rank, c.code),
    )
    cells = await load_template_cells(db, workflow_id)
    return [
        category_timeline_payload(wf, c, template_timeline_for(wf, cells.get(c.code, {})))
        for c in cats
    ]
