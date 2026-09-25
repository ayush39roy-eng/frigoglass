"""Dataclass contract for the scheduling engine.

Every dataclass here is `@dataclass(frozen=True)` (per the `scheduling-algorithms`
skill's guidance) so instances are hashable/immutable and cannot be mutated by
accident inside the greedy loop or by a caller after construction — determinism
(Invariant I8) is much easier to reason about when nothing downstream of
`run_greedy_sgs` can silently rewrite a field.

These dataclasses are deliberately decoupled from `backend/models/` (no import
of that package anywhere in `backend/scheduling/`, per the purity constraint).
Field names intentionally *echo* the corresponding SQLAlchemy model fields
(`backend/models/project.py`, `engineer.py`, `chamber.py`, `workflow.py`) so a
future P3 service-layer adapter mapping ORM rows -> these dataclasses is a
straightforward 1:1 field copy, but nothing here imports or depends on those
models existing.

IDs (`project_id`, `engineer_id`, `chamber_id`) are typed as plain `str` rather
than `uuid.UUID` — a pure function has no reason to require a specific ID
representation; `str(uuid4())` round-trips fine, and it keeps golden-file test
fixtures (P2-T05) readable (`"proj-1"` instead of a real UUID literal).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import domain_constants as dc

# --- Workflow template ------------------------------------------------------


@dataclass(frozen=True)
class WorkflowStepTemplate:
    """One of the 14 PDD steps, per `docs/DOMAIN_RULES.md` "Workflow template"."""

    step_id: str  # "PDD-A" .. "PDD-N"
    name: str
    kind: str  # "design" | "lab"
    base_weeks: int
    sequence_order: int  # 1-based; steps are walked in ascending order


def default_workflow_template() -> tuple[WorkflowStepTemplate, ...]:
    """The canonical 14-step template from `domain_constants.WORKFLOW_STEP_TEMPLATE_SEED`.

    `ScheduleInput.workflow_steps` defaults to this, but callers (in particular
    P2-T05's golden-file fixtures) may supply a smaller/different template to
    exercise a single rule in isolation without needing all 14 steps present.
    """

    return tuple(
        WorkflowStepTemplate(
            step_id=sid, name=name, kind=kind, base_weeks=base_weeks, sequence_order=seq
        )
        for sid, name, kind, base_weeks, seq in dc.WORKFLOW_STEP_TEMPLATE_SEED
    )


# --- Resources ---------------------------------------------------------------


@dataclass(frozen=True)
class EngineerInput:
    """A design-step scheduling resource and the pool of eligible project leaders.

    `fte` is accepted and carried through purely for reporting parity with
    `Engineer.fte` — per ADR 0002 it has **no** effect on booking. An engineer
    is fully available every week they are not already booked to a design step.
    """

    engineer_id: str
    name: str
    hub: str
    allowed_categories: tuple[str, ...]  # subset of {"A+","A","B","C","OEM"}
    fte: float = 1.0


@dataclass(frozen=True)
class ChamberInput:
    """A lab-step scheduling resource.

    `efficiency` and `weeks_per_chamber` are accepted purely for reporting
    parity with `Chamber.efficiency`/`weeks_per_chamber` — per ADR 0003 neither
    constrains booking. Only `max_concurrent` gates lab-step capacity.
    """

    chamber_id: str
    code: str
    lab_region: str  # "Greece" | "India" | "Romania"
    max_concurrent: int
    allowed_stages: tuple[str, ...]  # workflow step_ids this chamber may host
    efficiency: float = 1.0
    weeks_per_chamber: float = 0.0


@dataclass(frozen=True)
class ProjectInput:
    """One project to be scheduled (or excluded/left out).

    `category`/`priority` are `str | None` to mirror `Project.category`/
    `Project.priority`'s nullability (a `Draft` project may have neither set)
    but MUST be non-`None` for any project whose `status` participates in
    scheduling (`run_greedy_sgs` raises `ValueError` at input-validation time
    otherwise, rather than crashing deep inside the sort key or silently
    defaulting).

    `actual_start_week` is the frozen-lock date when `frozen=True` (required,
    non-`None` in that case) and is otherwise unused by scheduling — see the
    P2-T01 MEMORY.md entry's "earliest-start floor" resolution for why a
    non-frozen project's `actual_start_week` (if ever populated) is *not*
    treated as a soft scheduling hint the way the prototype treats it.
    """

    project_id: str
    name: str
    hub: str
    status: str
    category: str | None
    priority: str | None
    frozen: bool
    leader_engineer_id: str | None
    actual_start_week: int | None = None
    delay_weeks: int = 0


# --- Output --------------------------------------------------------------


@dataclass(frozen=True)
class StepSchedule:
    """One booked (or partially-booked, if the project was later LEFT_OUT) step."""

    step_id: str
    sequence_order: int
    kind: str
    start_week: int
    end_week: int  # inclusive
    duration_weeks: int
    assigned_engineer_id: str | None  # design steps only
    assigned_chamber_id: str | None  # lab steps only


@dataclass(frozen=True)
class ProjectScheduleOutcome:
    """The scheduling result for exactly one input project.

    `excluded` and `left_out` are deliberately distinct booleans (never both
    `True`) so a caller can tell "this project's status
    (Commercialized/On Hold/anything outside the four schedulable statuses)
    means it was never fed into the greedy walk at all" apart from "it *was*
    fed in, sorted, and the algorithm searched but found no feasible window
    before the horizon." `steps` is empty for `excluded` projects and for
    `left_out` projects that failed on their very first step; a `left_out`
    project that got partway through its 14 steps before hitting an
    infeasible step keeps whatever steps it successfully booked (matching the
    prototype's behaviour: already-consumed capacity is not un-booked) —
    resolved via prototype per the P2-T01 MEMORY.md entry, since
    DOMAIN_RULES.md's Invariant I5 ("complete 14-step schedule OR
    LEFT_OUT=true") is silent on whether partial steps are retained.
    """

    project_id: str
    excluded: bool
    left_out: bool
    eng_conflict: bool  # Invariant I1 — only possible when frozen=True
    overlap: bool  # Invariant I2 — only possible when frozen=True
    cat_not_allowed: bool  # CAT_NOT_ALLOWED — warning only, never blocks scheduling
    spillover: bool  # !within_year and not left_out and not excluded
    within_year: bool
    no_leader: bool  # diagnostic: True if leader_engineer_id didn't resolve to an engineer
    no_chamber_step_id: str | None  # diagnostic: step_id with zero eligible chambers, if any
    steps: tuple[StepSchedule, ...]
    start_week: int | None
    end_week: int | None


@dataclass(frozen=True)
class ScheduleInput:
    """Everything `run_greedy_sgs` needs. No DB session, no ORM objects."""

    projects: tuple[ProjectInput, ...]
    engineers: tuple[EngineerInput, ...]
    chambers: tuple[ChamberInput, ...]
    workflow_steps: tuple[WorkflowStepTemplate, ...] = field(
        default_factory=default_workflow_template
    )
    current_week: int = dc.CURRENT_WEEK
    horizon_weeks: int = dc.HORIZON_WEEKS
    within_year_week: int = dc.WITHIN_YEAR_WEEK


@dataclass(frozen=True)
class ScheduleOutput:
    """Result of one `run_greedy_sgs` call.

    `project_outcomes` contains exactly one entry per `ScheduleInput.projects`
    entry, sorted by `project_id` ascending (a stable, caller-order-independent
    sort — see the P2-T01 MEMORY.md entry's determinism note) so that
    byte-identical re-runs (Invariant I8) don't depend on the order projects
    were supplied in.

    `scheduling_order` is the exact sequence `project_id`s were processed in
    by the greedy walk (frozen desc, priority, status, category, project_id
    tiebreak) — excludes `excluded` projects entirely, since those are never
    fed into the walk. Useful for P2-T02's differential oracle and for
    debugging without needing to re-derive the sort independently.
    """

    project_outcomes: tuple[ProjectScheduleOutcome, ...]
    scheduling_order: tuple[str, ...]
