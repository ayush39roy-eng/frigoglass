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


@dataclass(frozen=True)
class CategoryInput:
    """One project category (ADR 0047 §3 as ruled, R33-8): its wire `code`,
    the workflow it belongs to and its `rank`, scheduling order key 5 (the
    rank *value*, ascending). Mirrors a `categories` row."""

    code: str
    workflow_id: str  # "PDD" | "OEM"
    rank: int  # >= 1, unique within a ScheduleInput


def default_categories() -> tuple[CategoryInput, ...]:
    """The seven seeded categories at ranks 1..7, in `CATEGORY_RANK` order
    (A+, A, B, C, A-OEM, B-OEM, C-OEM). The default of
    `ScheduleInput.categories`; the canonical / hashed input and the run
    snapshot omit a list equal to this one (R33-7)."""

    return tuple(
        CategoryInput(code=code, workflow_id="OEM" if code in OEM_CATEGORIES else "PDD", rank=rank)
        for rank, code in enumerate(CATEGORY_RANK, start=1)
    )


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

    `fte` gates speed (ADR 0032, supersedes ADR 0002): a design step of a
    non-frozen project this engineer leads books `ceil(duration / fte)`
    consecutive weeks of them; they still do one step at a time. `fte` must
    be > 0 for any project with design work to place, else the project is a
    `data_error`.

    `allowed_categories` is a subset of `{"A+","A","B","C","OEM","A-OEM","B-OEM","C-OEM"}`.

    `counts_in_capacity` (2026-10-22, ADR 0042 §5–6, P29-T05; mirrors
    `engineers.counts_in_capacity`): `False` for a leader who is on no client
    capacity roster (Theoni, Dipak, Antonis, Sailesh — OQ #52). Such an
    engineer is still **booked** wherever they are a project's assigned leader
    (greedy / CP-SAT ignore this field entirely), but is never summed into
    supply and never *chosen* as a leader for a new or re-assigned project (the
    what-if planner). The default `True` keeps every pre-P29 caller and golden
    file byte-identical.
    """

    engineer_id: str
    name: str
    hub: str
    allowed_categories: tuple[str, ...]
    fte: float = 1.0
    counts_in_capacity: bool = True


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
class StepTimingInput:
    """Per-project step timing set from the Gantt (ADR 0019, P12).

    One row per step that has a planner-set duration and/or earliest start;
    steps absent from `ProjectInput.step_timing` use the lead-time table and
    have no floor. Mirrors `ProjectWorkflowStep.duration_override_weeks` /
    `.start_not_before_week`.

    - `duration_override_weeks` (1..104 or None): this project's effective
      duration for the step (`override ?? lead_time[...]`). Ignored for a step
      whose lead time is 0 (the step stays skipped).
    - `start_not_before_week` (1..HORIZON_WEEKS or None): a `Not Started`
      step may not start before this week. Ignored for In Progress / Blocked /
      Done steps and for frozen projects.
    - `overlap_weeks` (0..104, ADR 0043, P32): the step may start up to this
      many weeks before the work it waits for has ended (release/gate rules
      in `workflow.release_week` / `workflow.step_gate`). 0 = no overlap.
      Rejected on a workflow's first step; ignored in a frozen project and on
      a skipped step. The canonical / hashed form omits it when 0
      (`workflow.canonical_step_timing_dict`), so every pre-P32 hash and
      golden file is byte-identical.

    P33 (ADR 0046 as ruled, R33-1/R33-4/R33-7; DOMAIN_RULES "Category
    templates" §B/§D):

    - `wait_weeks` (0..104): the positive part of the project's signed
      template gap. A Not Started step may not start before `release(s) + 1 +
      wait_weeks`. It books nothing and is ignored on a started step, a
      skipped step and in a frozen project. At most one of `overlap_weeks`
      and `wait_weeks` is non-zero, and neither on a first step.
    - `lead_weeks` (0..104 or None): the project's own lead time for the step
      (`lead = lead_weeks ?? lead_time_table`), then `eff = 0` if `lead = 0`
      or lab with certification testing off, else
      `duration_override_weeks ?? lead`. A frozen project honours it.

    Both are omitted from the canonical / hashed form at their defaults (0 /
    None), so every pre-P33 hash, golden file and stored run is
    byte-identical.
    """

    step_id: str
    duration_override_weeks: int | None  # 1..104, None = lead-time table
    start_not_before_week: int | None  # 1..HORIZON_WEEKS, None = no floor
    overlap_weeks: int = 0  # ADR 0043: 0..104, 0 = no overlap
    wait_weeks: int = 0  # P33 (ADR 0046 §4, R33-4): 0..104, 0 = no wait
    lead_weeks: int | None = None  # P33 (R33-1): 0..104, None = the input's lead-time table


@dataclass(frozen=True)
class StepPinInput:
    """A manual step pin (ADR 0054 as ruled at P40-T02, R40-1 / R40-12;
    DOMAIN_RULES "Manual step weeks"). Mirrors
    `ProjectWorkflowStep.manual_start_week` / `.manual_end_week`.

    - `start_week` / `end_week`: the pinned window, **end inclusive** (the
      same convention as `StepSchedule.end_week`); the pin length is
      `end_week - start_week + 1 >= 1`. Scheduler input domain:
      `1 <= start_week <= end_week <= ScheduleInput.horizon_weeks`, else
      `ValueError` at validation (`workflow.validate_step_pins`).
    - A pin is a **placement, not effort** (R40-3): the step occupies exactly
      its effective window (R40-5: the pin, or `cw .. cw + L - 1` when a
      non-frozen pin has lapsed) and its row still reports `eff` as
      `duration_weeks`.
    - Never carried in `StepTimingInput` (Monte Carlo perturbs that; it never
      perturbs a pin). The canonical / hashed input omits an empty
      `ProjectInput.step_pins` (`workflow.canonical_schedule_input_asdict`).
    """

    step_id: str
    start_week: int
    end_week: int  # inclusive


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

    `capacity_hub` (2026-10-22, ADR 0042 "Capacity hubs"): the hub whose
    engineers form this project's **engineer pool** and whose supply its design
    load counts against. `OEM-HCK` / `OEM-Seitek` (formerly `OEM-Seltek`) projects carry
    `capacity_hub="R&D-Greece"` (`hubs.capacity_hub_id`); every other hub is
    its own capacity hub. It defaults to `hub` (an empty string at construction
    is replaced by `hub` in `__post_init__`), so every pre-P29 caller and
    golden file is unchanged. What it governs inside this package:

    - engineer *selection* — the what-if leader picker and its "designers of
      the hub" figures choose from `engineer.hub == capacity_hub`;
    - the capacity-hub load aggregate (`compute_design_load_by_capacity_hub`),
      which is Σ over the capacity hub's own and member projects (ADR 0042 §3).

    What it does **not** change: the workflow (still `OEM` for an OEM hub,
    selected by `hub`), the lab region (`HUB_LAB_REGION[hub]`), and the
    booking of an already-assigned `leader_engineer_id` — the greedy / CP-SAT
    walks book the assigned leader wherever that engineer sits, exactly as
    before (the client's own data has leaders outside the project's hub, e.g.
    an R&D-India engineer leading PD-India projects). Because a dataclass
    `replace(p, hub=...)` re-passes the already-resolved value, a caller that
    re-hubs a project must set `capacity_hub` explicitly too.
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
    # ADR 0019 (P12): Gantt-set per-step duration override / earliest start.
    # The default `()` keeps every pre-P12 caller and golden file byte-identical.
    step_timing: tuple[StepTimingInput, ...] = ()
    # ADR 0040 (2026-10-22): manual VIP pin (`projects.is_vip`). Second key of
    # the scheduling order (after `frozen`, before priority). The default
    # `False` keeps every pre-ADR-0040 caller and golden file byte-identical.
    is_vip: bool = False
    # ADR 0042 (2026-10-22, P29): the capacity hub (see the docstring). `""`
    # means "same as `hub`" and is resolved in `__post_init__`, so the field is
    # always a real hub name after construction.
    capacity_hub: str = ""
    # ADR 0050 (P36, R36-1..R36-10): the planner-set position inside the
    # project's priority band (`projects.band_rank`, dense 1..n per band in
    # live state). Scheduling order key 3a: ascending, `None` last. `None` =
    # unranked (What-if added / overridden-band projects, imported rows). The
    # canonical / hashed form omits it when `None`
    # (`workflow.canonical_schedule_input_asdict`), so every pre-P36 golden
    # file, hash and stored run is byte-identical.
    band_rank: int | None = None
    # ADR 0054 (P40, R40-12): manual step pins, one per step at most, sorted
    # by `step_id` by the builder (the scheduler sorts again). The default
    # `()` is omitted from the canonical / hashed form, so every pre-P40
    # caller, golden file, hash and stored run is byte-identical (I48(a)).
    step_pins: tuple[StepPinInput, ...] = ()

    def __post_init__(self) -> None:
        if self.capacity_hub == "":
            # Frozen dataclass: the documented idiom for a derived default.
            object.__setattr__(self, "capacity_hub", self.hub)


# --- Output --------------------------------------------------------------


@dataclass(frozen=True)
class StepSchedule:
    """One step row of a project's schedule.

    `duration_weeks` is always the step's *effective* duration, in effort
    weeks, never stretched by FTE (ADR 0032; a design row of a non-frozen
    project spans `ceil(duration_weeks / fte)` weeks) (ADR 0019:
    the project's `duration_override_weeks` if set, else the lead-time-table
    duration; 0 when `skipped`), so that Σ over design/lab kinds reconciles
    with the Capacity surface's process-derived load (I6/I7) when that side
    uses the same effective duration. For a `Done` / `In
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
    # ADR 0054 (P40, R40-12, I45 / I47): `pinned` is True exactly on the row of
    # a step placed on its manual pin's effective window; `manual_overlap` on a
    # pinned row whose start `a < release(s) + 1 - o(s)` (a warning only).
    # Both default to False and are omitted from every serialised / hashed
    # form at that default (`workflow.canonical_schedule_output_asdict`).
    pinned: bool = False
    manual_overlap: bool = False


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
    # ADR 0054 (P40, R40-5 / R40-7 / R40-12): `manual_overlap` is the OR over
    # the project's rows; `pin_lapsed` is True iff some applied pin's
    # effective window differs from the pin (a non-frozen pin whose start
    # week has passed). Warnings only; default False, omitted at the default.
    manual_overlap: bool = False
    pin_lapsed: bool = False
    # ADR 0056 as ruled at P42-T01 (R42-3 / R42-4, I49 / I50).
    # `not_scheduled_priority`: True exactly on a non-frozen P4/Q project in a
    # schedulable status, excluded before validation (`excluded` is True, no
    # rows, null weeks, never within year / spillover / left out / blocked).
    # `counts_toward_year`: `domain_constants.counts_toward_year(priority,
    # status)` on the run input; `within_year` and `spillover` are AND-ed with
    # it (`greedy.year_flags`). A queued P3 (In Queue) is scheduled with spare
    # capacity only and is False. Both are omitted from the canonical /
    # hashed form at their default (False / True), so a run with no P4/Q and
    # no queued P3 serialises exactly as before P42.
    not_scheduled_priority: bool = False
    counts_toward_year: bool = True


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
    # P37-T03 (ADR 0052, I38): the week the plan is solved from. REQUIRED and
    # keyword-only: there is no default, so no value is ever bound at import
    # (the old `dc.CURRENT_WEEK` default is gone). `kw_only` changes only the
    # `__init__` signature: `dataclasses.fields()` / `asdict()` keep the
    # declaration order and the field set, so `canonical_schedule_input_asdict`
    # and every hash over it are byte-identical (ADR 0052 pin condition (ii)).
    # `__post_init__` rejects anything that is not a week (see there).
    current_week: int = field(kw_only=True)
    horizon_weeks: int = dc.HORIZON_WEEKS
    within_year_week: int = dc.WITHIN_YEAR_WEEK
    # ADR 0047 §3 / R33-8 (P33-T03): the category list, scheduling order key 5
    # (rank value) and the workflow each category belongs to. The default is
    # the seven seeded categories, so every pre-P33 caller is unchanged.
    categories: tuple[CategoryInput, ...] = field(default_factory=default_categories)

    def __post_init__(self) -> None:
        validate_current_week(self.current_week, self.horizon_weeks)


#: I41: the domain of a served / stored plan week (DOMAIN_RULES "The current
#: week follows the calendar"). Literal, not read from the environment.
PLAN_WEEK_MIN: int = 1
PLAN_WEEK_MAX: int = 52


def validate_current_week(week: object, horizon_weeks: int) -> None:
    """Structural check on `ScheduleInput.current_week` (P37-T03).

    Rejects a bool, any non-`int`, and a week outside `1..horizon_weeks`: a
    week before W1 or past the search horizon cannot be solved from. Raised
    as `ValueError` (`TypeError` for a wrong type) at construction, so no
    solver ever sees such an input.

    The narrower I41 domain `1..52` (`PLAN_WEEK_MIN..PLAN_WEEK_MAX`) is a
    property of the clock, enforced by `require_plan_week` (the builders'
    check) and by the validator's I41 check, not here: the engine's
    edge-case golden scenarios solve from weeks past 52 (horizon overflow
    to LEFT_OUT, e.g. W77 / W60) and must stay byte-identical."""

    if isinstance(week, bool) or not isinstance(week, int):
        raise TypeError(f"current_week must be an int week, got {week!r}")
    if week < 1 or week > horizon_weeks:
        raise ValueError(f"current_week {week} is outside 1..{horizon_weeks} (horizon_weeks)")


def require_plan_week(week: object) -> int:
    """I41 / API_CONTRACT_P37: a plan week is an int in 1..52. Returns it,
    or raises (`TypeError` for a non-int or bool, `ValueError` out of
    range). The check every caller that builds a live, What-if, plan-import
    or Monte Carlo input from the clock or a stored run applies."""

    if isinstance(week, bool) or not isinstance(week, int):
        raise TypeError(f"plan week must be an int, got {week!r}")
    if not PLAN_WEEK_MIN <= week <= PLAN_WEEK_MAX:
        raise ValueError(f"plan week {week} is outside {PLAN_WEEK_MIN}..{PLAN_WEEK_MAX} (I41)")
    return week


@dataclass(frozen=True)
class ScheduleOutput:
    """Result of one `run_greedy_sgs` call.

    `project_outcomes` contains exactly one entry per `ScheduleInput.projects`
    entry, sorted by `project_id` ascending (a stable, caller-order-independent
    sort) so that byte-identical re-runs (Invariant I8) don't depend on the
    order projects were supplied in.

    `scheduling_order` is the exact sequence `project_id`s were processed in
    by the greedy walk (frozen desc, is_vip desc (ADR 0040), priority, status,
    category rank from `ScheduleInput.categories` (ADR 0047 §3, I30),
    project_id tiebreak) — excludes `excluded` projects entirely.
    """

    project_outcomes: tuple[ProjectScheduleOutcome, ...]
    scheduling_order: tuple[str, ...]
    # DOMAIN_RULES "Gate remediation rulings" #6: CP-SAT records whether its
    # portfolio (pass-1, ADR 0005) objective was proven "OPTIMAL" or only
    # "FEASIBLE" within the deterministic budget. None for greedy.
    solver_status: str | None = None
