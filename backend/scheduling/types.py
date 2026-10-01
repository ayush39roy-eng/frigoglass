"""Dataclass contract for the scheduling engine.

Every dataclass here is `@dataclass(frozen=True)` (per the `scheduling-algorithms`
skill's guidance) so instances are hashable/immutable and cannot be mutated by
accident inside the greedy loop or by a caller after construction — determinism
(Invariant I8) is much easier to reason about when nothing downstream of
`run_greedy_sgs` can silently rewrite a field.

These dataclasses are deliberately decoupled from `backend/models/` (no import
of that package anywhere in `backend/scheduling/`, per the purity constraint).
Field names intentionally *echo* the corresponding SQLAlchemy model fields so
the service-layer adapter mapping ORM rows -> these dataclasses is a
straightforward field copy, but nothing here imports or depends on those models.

IDs (`project_id`, `engineer_id`, `chamber_id`) are typed as plain `str` rather
than `uuid.UUID` — a pure function has no reason to require a specific ID
representation, and it keeps golden-file fixtures readable.

Revised 2026-09-27 (P9-T02, ADRs 0006/0007/0009): the workflow template carries
`workflow_id` / `code` / `kind in {design, lab, elapsed}` / `predecessor_ids`;
durations come from a `LeadTime` table (no multiplier, no `max(1, …)`); projects
carry `workflow_id`, `certification_testing_required`, `target_end_week` and a
per-step progress tuple; outcomes carry the expected/projected/unconstrained
completion weeks, `blocked`, `progress_pct` and `data_error`. The default
template and lead-time table below are **literal data transcribed from
`docs/DOMAIN_RULES.md`** ("Workflow templates", "Lead times") — they are not
imported from `domain_constants` (which is being reshaped concurrently in
P9-T01).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import domain_constants as dc

# --- Constants owned by the scheduling package ------------------------------

#: DOMAIN_RULES.md "Scheduling order" key 4 (OEM tail added 2026-09-27). Defined
#: here rather than read from `domain_constants.CATEGORY_ORDER` so the package
#: is correct regardless of whether P9-T01 has already appended the OEM tail.
CATEGORY_RANK: tuple[str, ...] = ("A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM")

#: Categories that belong to the `PDD` / `OEM` workflow respectively.
PDD_CATEGORIES: tuple[str, ...] = ("A+", "A", "B", "C")
OEM_CATEGORIES: tuple[str, ...] = ("A-OEM", "B-OEM", "C-OEM")

#: ADR 0007 decision 6: one platform-week per project-week (the prototype's 0.5
#: is retired). Defined locally so the package does not depend on when
#: `domain_constants.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK` is updated.
LAB_CONSUMPTION_PER_PROJECT_WEEK: float = 1.0

STEP_KINDS: tuple[str, ...] = ("design", "lab", "elapsed")

PROGRESS_STATUSES: tuple[str, ...] = ("Not Started", "In Progress", "Blocked", "Done")


# --- Workflow template ------------------------------------------------------


@dataclass(frozen=True)
class WorkflowStepTemplate:
    """One step of one workflow (`PDD` or `OEM`), per DOMAIN_RULES.md
    "Workflow templates" and "Precedence".

    `sequence_order` is the display order and the deterministic tie-break when
    the scheduler walks the DAG; it is **not** a dependency statement.
    `predecessor_ids` is: `()` only for the workflow's first step.
    """

    workflow_id: str  # "PDD" | "OEM"
    step_id: str  # "PDD-A".."PDD-N" / "OEM-A".."OEM-N"
    code: str  # "MKTG_BRF", ...
    name: str
    kind: str  # "design" | "lab" | "elapsed"
    sequence_order: int  # 1..14
    predecessor_ids: tuple[str, ...]  # same-workflow step_ids


@dataclass(frozen=True)
class LeadTime:
    """One cell of the lead-time table: `duration_weeks = lead_time[workflow][category][step]`."""

    workflow_id: str
    category: str  # "A+","A","B","C","A-OEM","B-OEM","C-OEM"
    step_id: str
    weeks: int  # >= 0; 0 means "step is skipped for this category"


# (step_id, code, name, kind) — DOMAIN_RULES.md "PDD workflow" table, verbatim.
_PDD_STEPS: tuple[tuple[str, str, str, str], ...] = (
    ("PDD-A", "MKTG_BRF", "Marketing Brief", "design"),
    ("PDD-B", "FEAS_STD", "Feasibility Study (Conceptual Design)", "design"),
    ("PDD-C", "BUS_CASE", "Business Case Approval", "elapsed"),
    ("PDD-D", "TECH_BRIEF", "Final Technical Brief & Project Kick-off", "design"),
    ("PDD-E", "DESIGN", "Design Detailing", "design"),
    ("PDD-F", "POC", "Proof of Concept", "lab"),
    ("PDD-G", "CAPEX", "Online CAPEX Approval", "elapsed"),
    ("PDD-H", "CERT", "Certification Testing & Compliance", "lab"),
    ("PDD-I", "TF_1", "TF-1", "design"),
    ("PDD-J", "PROD_PR", "Pre-Production (Pr. Pr)", "design"),
    ("PDD-K", "TF_2", "TF-2", "design"),
    ("PDD-L", "PILOT", "Pilot", "elapsed"),
    ("PDD-M", "TF_3", "TF-3", "design"),
    ("PDD-N", "COMM", "Commercialization", "elapsed"),
)

# DOMAIN_RULES.md "OEM workflow" table, verbatim.
_OEM_STEPS: tuple[tuple[str, str, str, str], ...] = (
    ("OEM-A", "COMM_BRF", "Commercial Brief", "design"),
    ("OEM-B", "TECH_BRIEF", "Final Technical Brief & Project Kick-off", "design"),
    ("OEM-C", "BUS_CASE", "Business Case Approval", "elapsed"),
    ("OEM-D", "DESIGN", "Design Detailing", "design"),
    ("OEM-E", "POC", "Proof of Concept", "lab"),
    ("OEM-F", "CAPEX", "Online CAPEX Approval", "elapsed"),
    ("OEM-G", "TST_ANAL", "Test Results Analysis", "design"),
    ("OEM-H", "CERT", "Certification Testing & Compliance", "lab"),
    ("OEM-I", "TF_1", "TF-1", "design"),
    ("OEM-J", "PROD_PR", "Pre-Production (Pr. Pr)", "design"),
    ("OEM-K", "TF_2", "TF-2", "design"),
    ("OEM-L", "PILOT", "Pilot", "elapsed"),
    ("OEM-M", "TF_3", "TF-3", "design"),
    ("OEM-N", "COMM", "Commercialization", "elapsed"),
)

# DOMAIN_RULES.md "Lead times" table, verbatim: workflow -> category -> 14 weeks (A..N).
_LEAD_TIME_ROWS: tuple[tuple[str, str, tuple[int, ...]], ...] = (
    ("PDD", "A+", (1, 8, 4, 1, 6, 6, 2, 6, 2, 1, 2, 3, 1, 1)),  # Σ 44
    ("PDD", "A", (1, 4, 4, 1, 6, 4, 2, 6, 2, 1, 2, 3, 1, 1)),  # Σ 38
    ("PDD", "B", (1, 0, 0, 1, 4, 0, 0, 6, 0, 1, 2, 1, 1, 1)),  # Σ 18
    ("PDD", "C", (1, 0, 0, 1, 2, 0, 0, 1, 0, 1, 1, 0, 0, 1)),  # Σ 8
    ("OEM", "A-OEM", (1, 1, 1, 2, 2, 2, 4, 6, 0, 1, 0, 0, 0, 1)),  # Σ 21
    ("OEM", "B-OEM", (1, 1, 1, 0, 0, 2, 2, 6, 0, 1, 0, 0, 0, 0)),  # Σ 14
    ("OEM", "C-OEM", (0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0)),  # Σ 4
)


def _chain(
    workflow_id: str, rows: tuple[tuple[str, str, str, str], ...]
) -> tuple[WorkflowStepTemplate, ...]:
    out: list[WorkflowStepTemplate] = []
    prev: str | None = None
    for seq, (step_id, code, name, kind) in enumerate(rows, start=1):
        out.append(
            WorkflowStepTemplate(
                workflow_id=workflow_id,
                step_id=step_id,
                code=code,
                name=name,
                kind=kind,
                sequence_order=seq,
                predecessor_ids=() if prev is None else (prev,),
            )
        )
        prev = step_id
    return tuple(out)


def default_workflow_templates() -> tuple[WorkflowStepTemplate, ...]:
    """Both workflows (28 rows) with the seeded strict-chain predecessors
    (`X-B <- X-A`, `X-C <- X-B`, …), per DOMAIN_RULES.md "Precedence".
    """

    return _chain("PDD", _PDD_STEPS) + _chain("OEM", _OEM_STEPS)


def default_lead_times() -> tuple[LeadTime, ...]:
    """The 98-row lead-time table from DOMAIN_RULES.md "Lead times"."""

    steps_by_wf = {"PDD": _PDD_STEPS, "OEM": _OEM_STEPS}
    out: list[LeadTime] = []
    for workflow_id, category, weeks in _LEAD_TIME_ROWS:
        step_rows = steps_by_wf[workflow_id]
        assert len(weeks) == len(step_rows) == 14
        for (step_id, _code, _name, _kind), w in zip(step_rows, weeks, strict=True):
            out.append(
                LeadTime(workflow_id=workflow_id, category=category, step_id=step_id, weeks=w)
            )
    return tuple(out)


# --- Resources ---------------------------------------------------------------


@dataclass(frozen=True)
class EngineerInput:
    """A design-step scheduling resource and the pool of eligible project leaders.

    `fte` is accepted and carried through purely for reporting parity with
    `Engineer.fte` — per ADR 0002 it has **no** effect on booking. An engineer
    is fully available every week they are not already booked to a design step.

    `allowed_categories` is a subset of `{"A+","A","B","C","OEM","A-OEM","B-OEM","C-OEM"}`.
    """

    engineer_id: str
    name: str
    hub: str
    allowed_categories: tuple[str, ...]
    fte: float = 1.0


@dataclass(frozen=True)
class ChamberInput:
    """A lab-step scheduling resource.

    `max_concurrent` is the platform count and the only field that gates
    booking (ADR 0007/0008). `efficiency` is carried for reporting parity only;
    `weeks_per_chamber` was retired on 2026-09-27 (ADR 0008).
    """

    chamber_id: str
    code: str
    lab_region: str  # "Greece" | "India" | "Romania"
    max_concurrent: int
    allowed_stages: tuple[str, ...]  # workflow step_ids this chamber may host
    efficiency: float = 1.0


@dataclass(frozen=True)
class StepProgressInput:
    """Per-stage progress captured on the Project Workspace (DOMAIN_RULES.md
    "Per-stage progress capture", ADR 0006). One row per step that has
    progress state; steps absent from `ProjectInput.step_progress` are
    `Not Started`.
    """

    step_id: str
    status: str  # "Not Started" | "In Progress" | "Blocked" | "Done"
    percent_complete: int  # 0..100
    actual_start_week: int | None
    actual_end_week: int | None
    remaining_weeks_override: int | None


@dataclass(frozen=True)
class ProjectInput:
    """One project to be scheduled (or excluded/left out).

    `category`/`priority` are `str | None` to mirror `Project.category`/
    `Project.priority`'s nullability (a `Draft` project may have neither set)
    but MUST be non-`None` for any project whose `status` participates in
    scheduling (`run_greedy_sgs` raises `ValueError` at input-validation time
    otherwise).

    `actual_start_week` is the frozen-lock date when `frozen=True` (required,
    non-`None` in that case) and is otherwise only a lower bound on the first
    step's start (see the P2-T01 MEMORY.md entry's "earliest-start floor").

    `workflow_id` selects the template (`PDD` for non-OEM hubs, `OEM` for OEM
    hubs); the lead-time table is keyed by `(workflow_id, category, step_id)`
    so a mismatched workflow/category pair fails input validation.
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
    workflow_id: str = "PDD"
    certification_testing_required: bool = True
    target_end_week: int | None = None
    step_progress: tuple[StepProgressInput, ...] = ()


# --- Output --------------------------------------------------------------


@dataclass(frozen=True)
class StepSchedule:
    """One step row of a project's schedule.

    `duration_weeks` is always the lead-time-table duration for the step (0
    when `skipped`), so that Σ over design/lab kinds reconciles with the
    Capacity surface's process-derived load (I6/I7). For a `Done` / `In
    Progress` step `start_week`/`end_week` reflect the recorded actuals plus
    the booked tail, so the span may differ from `duration_weeks`.

    A skipped step has `start_week == end_week == max(predecessor end)` (or
    the project frontier − 1 for a first step) and books nothing.
    """

    step_id: str
    sequence_order: int
    kind: str
    start_week: int
    end_week: int  # inclusive
    duration_weeks: int
    assigned_engineer_id: str | None  # design steps only
    assigned_chamber_id: str | None  # lab steps only
    skipped: bool = False


@dataclass(frozen=True)
class ProjectScheduleOutcome:
    """The scheduling result for exactly one input project.

    `excluded` and `left_out` are deliberately distinct booleans (never both
    `True`). `steps` is empty for `excluded` projects and for `left_out`
    projects that failed on their very first step; a `left_out` project that
    got partway through its steps keeps whatever it successfully booked (P2-T01
    resolution, unchanged).

    2026-09-27 additions: `unconstrained_end_week` (earliest finish with
    unlimited resources), `expected_end_week` (`target_end_week` if set, else
    the unconstrained finish), `projected_end_week` (`end_week + delay_weeks`,
    `None` when left_out / excluded / blocked / data_error), `blocked` (a
    `Blocked` stage holds the project), `progress_pct` (duration-weighted
    roll-up, I12) and `data_error` (the project was rejected for inconsistent
    progress data and was not scheduled).
    """

    project_id: str
    excluded: bool
    left_out: bool
    eng_conflict: (
        bool  # Invariant I1 — only possible for frozen / anchored (Done, In Progress) steps
    )
    overlap: bool  # Invariant I2 — same
    cat_not_allowed: bool  # CAT_NOT_ALLOWED — warning only, never blocks scheduling
    spillover: bool  # !within_year and not left_out and not excluded and not blocked
    within_year: bool
    no_leader: bool  # diagnostic: True if leader_engineer_id didn't resolve to an engineer
    no_chamber_step_id: str | None  # diagnostic: step_id with zero eligible chambers, if any
    steps: tuple[StepSchedule, ...]
    start_week: int | None
    end_week: int | None
    unconstrained_end_week: int | None = None
    expected_end_week: int | None = None
    projected_end_week: int | None = None
    blocked: bool = False
    progress_pct: int | None = None
    data_error: str | None = None


@dataclass(frozen=True)
class ScheduleInput:
    """Everything `run_greedy_sgs` needs. No DB session, no ORM objects.

    `workflow_steps` carries both workflows (28 rows by default);
    `lead_times` the 98-row table. Both are part of the deterministic input
    (I8): the scheduler sorts them by key before use and never depends on the
    order they were supplied in.
    """

    projects: tuple[ProjectInput, ...]
    engineers: tuple[EngineerInput, ...]
    chambers: tuple[ChamberInput, ...]
    workflow_steps: tuple[WorkflowStepTemplate, ...] = field(
        default_factory=default_workflow_templates
    )
    lead_times: tuple[LeadTime, ...] = field(default_factory=default_lead_times)
    current_week: int = dc.CURRENT_WEEK
    horizon_weeks: int = dc.HORIZON_WEEKS
    within_year_week: int = dc.WITHIN_YEAR_WEEK


@dataclass(frozen=True)
class ScheduleOutput:
    """Result of one `run_greedy_sgs` call.

    `project_outcomes` contains exactly one entry per `ScheduleInput.projects`
    entry, sorted by `project_id` ascending (a stable, caller-order-independent
    sort) so that byte-identical re-runs (Invariant I8) don't depend on the
    order projects were supplied in.

    `scheduling_order` is the exact sequence `project_id`s were processed in
    by the greedy walk (frozen desc, priority, status, category, project_id
    tiebreak) — excludes `excluded` projects entirely.
    """

    project_outcomes: tuple[ProjectScheduleOutcome, ...]
    scheduling_order: tuple[str, ...]
    # DOMAIN_RULES "Gate remediation rulings" #6: CP-SAT records whether its
    # portfolio (pass-1, ADR 0005) objective was proven "OPTIMAL" or only
    # "FEASIBLE" within the deterministic budget. None for greedy.
    solver_status: str | None = None
