"""P13-T16: Workflow Settings previews (docs/API_CONTRACT_P13.md §5).

Two read-only derived views of the served lead-time table and precedence
DAG, computed here so the browser never derives a figure (I9/I19):

- **Category timeline**: per category, each step's earliest start assuming
  unlimited engineers and chambers (no capacity), walking the DAG with the
  table durations only. Weeks are 0-based offsets from the project's start,
  end-exclusive: `start = max(end of predecessors)` (0 for the first step),
  `end = start + duration`. A zero-duration step is skipped (DOMAIN_RULES
  "Lead times"): `start = end = max(predecessor end)`, transparent to its
  successors. `total_weeks` is the longest path (the critical path),
  equivalent to DOMAIN_RULES' inclusive `earliest_start = max(pred.end) + 1`.
- **B-equivalent workload**: per category, the process-derived `design_weeks`
  (Σ design-step durations) and `lab_weeks` (Σ lab-step durations), and
  their ratio to the reference category (`B` for PDD, `B-OEM` for OEM).

**P33-T09.** The category timeline served by `GET
/workflow-settings/category-timelines` and `POST
/workflow-templates/timeline-preview` is now `scheduling.template_timeline`
(signed gaps, one-leader rule; contract P33 C2/F3), through
`template_timeline_for`. `category_preview` below is kept for the
B-equivalent view (its design / lab sums are the same) and its own tests.

The DAG is validated and walked by the scheduler's own
`scheduling.workflow.build_workflows` (called, not reimplemented), so the
preview uses exactly the walk order the solver uses. The per-project
`certification_testing_required` flag and duration overrides are project
inputs, not template inputs, so the preview uses the table as served.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from models.enums import WorkflowStepKind
from models.workflow import WorkflowLeadTime, WorkflowStepTemplate
from scheduling.template_timeline import TEMPLATE_FLAGS, TemplateTimeline, template_timeline
from scheduling.types import WorkflowStepTemplate as SchedWorkflowStepTemplate
from scheduling.workflow import Workflow, build_workflows
from services.capacity_supply import round2
from services.categories import CategoryCatalog, default_catalog, load_catalog

#: The ratio reference per workflow (contract §5).
REFERENCE_CATEGORY: Mapping[str, str] = {
    dc.WORKFLOW_ID_FOR_NON_OEM_HUB: "B",
    dc.WORKFLOW_ID_FOR_OEM_HUB: "B-OEM",
}


@dataclass(frozen=True)
class StepSpan:
    step_id: str
    name: str
    kind: WorkflowStepKind
    start_week: int
    duration_weeks: int


@dataclass(frozen=True)
class CategoryPreview:
    category: str
    total_weeks: int
    design_weeks: int
    lab_weeks: int
    #: In the workflow's `sequence_order` (display order).
    steps: tuple[StepSpan, ...]


def categories_for(
    workflow_id: str, catalog: CategoryCatalog | None = None
) -> tuple[str, ...]:
    """The workflow's categories in rank order (P33-T07: the `categories`
    table; without a catalog, the seeded seven)."""

    return (catalog or default_catalog()).codes_for_workflow(workflow_id)


def category_preview(
    workflow: Workflow, category: str, weeks: Mapping[str, int]
) -> CategoryPreview:
    """Pure: earliest-start timeline for one category. `weeks` maps step id →
    lead-time weeks; a missing cell counts as 0 (skipped)."""

    ends: dict[str, int] = {}
    starts: dict[str, int] = {}
    for sid in workflow.walk_order:
        step = workflow.steps_by_id[sid]
        start = max((ends[p] for p in step.predecessor_ids), default=0)
        starts[sid] = start
        ends[sid] = start + weeks.get(sid, 0)

    design = lab = 0
    spans: list[StepSpan] = []
    for step in workflow.steps:
        duration = weeks.get(step.step_id, 0)
        kind = WorkflowStepKind(step.kind)
        if kind is WorkflowStepKind.DESIGN:
            design += duration
        elif kind is WorkflowStepKind.LAB:
            lab += duration
        spans.append(
            StepSpan(
                step_id=step.step_id,
                name=step.name,
                kind=kind,
                start_week=starts[step.step_id],
                duration_weeks=duration,
            )
        )
    return CategoryPreview(
        category=category,
        total_weeks=max(ends.values(), default=0),
        design_weeks=design,
        lab_weeks=lab,
        steps=tuple(spans),
    )


def ratio(value: int, reference: int) -> float | None:
    """`value / reference`, 2 dp; `None` when the reference is 0 (no ratio
    exists — never a misleading 0)."""

    return round2(value / reference) if reference else None


# --- P33-T09: the category template timeline (contract P33 C2 / D, F3) ------------


@dataclass(frozen=True)
class TemplateCell:
    """One template row's editable values (`workflow_lead_times`)."""

    weeks: int
    gap_weeks: int


@dataclass(frozen=True)
class WorkflowInForce:
    """One workflow as the scheduler validates it, plus the display names."""

    workflow: Workflow
    #: step id -> `WorkflowStepTemplate.name` (display).
    names: Mapping[str, str]

    @property
    def first_step_ids(self) -> frozenset[str]:
        """Steps with no predecessor (the workflow's first step): a non-zero
        gap there is rejected (`FIRST_STEP_GAP`)."""
        return frozenset(s.step_id for s in self.workflow.steps if not s.predecessor_ids)


async def load_workflow_in_force(db: AsyncSession, workflow_id: str) -> WorkflowInForce | None:
    """The workflow's DAG in force (`workflow_step_templates`), validated by
    `scheduling.workflow.build_workflows`; None for an unknown workflow."""

    templates = (
        (
            await db.execute(
                select(WorkflowStepTemplate).where(WorkflowStepTemplate.workflow_id == workflow_id)
            )
        )
        .scalars()
        .all()
    )
    if not templates:
        return None
    workflow = build_workflows(
        tuple(
            SchedWorkflowStepTemplate(
                workflow_id=t.workflow_id,
                step_id=t.id,
                code=t.code,
                name=t.name,
                kind=t.kind.value,
                sequence_order=t.sequence_order,
                predecessor_ids=tuple(t.predecessor_ids or ()),
            )
            for t in templates
        )
    )[workflow_id]
    return WorkflowInForce(workflow=workflow, names={t.id: t.name for t in templates})


async def load_template_cells(
    db: AsyncSession, workflow_id: str, categories: Sequence[str] | None = None
) -> dict[str, dict[str, TemplateCell]]:
    """`{category: {step_id: TemplateCell}}` of `workflow_id` (optionally only
    `categories`), read fresh (`populate_existing`)."""

    stmt = select(WorkflowLeadTime).where(WorkflowLeadTime.workflow_id == workflow_id)
    if categories is not None:
        stmt = stmt.where(WorkflowLeadTime.category.in_(list(categories)))
    out: dict[str, dict[str, TemplateCell]] = {}
    for lt in (await db.execute(stmt.execution_options(populate_existing=True))).scalars():
        out.setdefault(lt.category, {})[lt.step_id] = TemplateCell(
            weeks=lt.weeks, gap_weeks=lt.gap_weeks
        )
    return out


def template_timeline_for(
    wf: WorkflowInForce,
    cells: Mapping[str, TemplateCell],
    overrides: Mapping[str, TemplateCell] | None = None,
) -> TemplateTimeline:
    """`scheduling.template_timeline` (called, never reimplemented) on the
    saved cells with `overrides` laid over them. A step without a template row
    has length 0 and gap 0 (skipped), as the pre-P33 preview did. The caller
    has validated the ranges and the first-step gap."""

    merged = {**cells, **(overrides or {})}
    lengths = {sid: c.weeks for sid, c in merged.items() if sid in wf.workflow.steps_by_id}
    gaps = {sid: c.gap_weeks for sid, c in merged.items() if sid in wf.workflow.steps_by_id}
    return template_timeline(workflow=wf.workflow, lengths=lengths, gaps=gaps)


def ordered_flags(flags: frozenset[str]) -> list[str]:
    """The template flags in the contract's fixed order (deterministic wire
    form, I8)."""

    return [f for f in TEMPLATE_FLAGS if f in flags]


async def load_category_previews(
    db: AsyncSession, workflow_id: str
) -> tuple[CategoryPreview, ...]:
    """Every category of `workflow_id`, from the served templates and lead
    times. Two queries."""

    templates = (
        (
            await db.execute(
                select(WorkflowStepTemplate).where(WorkflowStepTemplate.workflow_id == workflow_id)
            )
        )
        .scalars()
        .all()
    )
    if not templates:
        return ()
    workflow = build_workflows(
        tuple(
            SchedWorkflowStepTemplate(
                workflow_id=t.workflow_id,
                step_id=t.id,
                code=t.code,
                name=t.name,
                kind=t.kind.value,
                sequence_order=t.sequence_order,
                predecessor_ids=tuple(t.predecessor_ids or ()),
            )
            for t in templates
        )
    )[workflow_id]
    weeks: dict[str, dict[str, int]] = {}
    lead_stmt = select(WorkflowLeadTime).where(WorkflowLeadTime.workflow_id == workflow_id)
    for lt in (await db.execute(lead_stmt)).scalars():
        weeks.setdefault(lt.category, {})[lt.step_id] = lt.weeks
    return tuple(
        category_preview(workflow, c, weeks.get(c, {}))
        for c in categories_for(workflow_id, await load_catalog(db))
    )
