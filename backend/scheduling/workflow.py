"""Workflow DAG, lead-time lookup and progress-aware per-project planning.

Shared by `greedy.py`, `cp_sat.py` and `invariants.py` so the three agree, by
construction, on:

  - which steps a project has and in what deterministic order they are walked
    (topological order of the precedence DAG, `sequence_order` as tie-break —
    ADR 0009: "sequence_order is … the deterministic tie-break when the
    scheduler walks steps; it is no longer a dependency statement");
  - each step's lead-time duration (`lead_time[workflow][category][step]`,
    ADR 0007 — no multiplier, no `max(1, …)`), its *effective* duration and
    whether it is *skipped* — ONE predicate (ADR 0041 R5, `step_effective_weeks`
    / `is_step_skipped`): `eff = 0` when the lead time is 0 or it is a `lab`
    step with `certification_testing_required` false, else the merged
    override `user ?? effort` (0..104, merged by the caller) `?? lead`; a
    step is skipped exactly when `eff == 0`;
  - the per-project step timing (ADR 0019, ADR 0041 R4): the merged
    `duration_override_weeks` (never reviving a skipped step) and a Not
    Started step's `start_not_before_week` search floor;
  - the per-step progress state (DOMAIN_RULES.md "Per-stage progress
    capture"): normalised status, derived `remaining`, the `data_error` that
    rejects a project with inconsistent actuals, the `Blocked` hold set;
  - the two pure by-products of a run that need no solve: the
    *unconstrained* finish week (with the R33-6 one-leader rule) and the
    duration-weighted `progress_pct` (I12);
  - P33 (ADR 0046 as ruled): the per-project lead (`lead_weeks ?? table`,
    R33-1), the wait in the gate (R33-4), the category list (`CategoryMaps`,
    R33-8) and the canonical forms that omit every P33 default (R33-7);
  - the FTE stretch (ADR 0032): a design step of a non-frozen project led by
    an engineer with FTE `f` books `ceil(duration / f)` elapsed weeks (its
    `span`); an In Progress / Blocked tail books `ceil(remaining / f)`. The
    effort figures (`duration`, `remaining`) are unchanged and remain what
    load (I6), progress weights (I12) and `duration_weeks` report.

Pure, deterministic, no I/O. Every mapping built here is keyed and every
iteration is over an explicitly sorted sequence (Invariant I8).
"""

from __future__ import annotations

import dataclasses
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any

from scheduling.types import (
    PROGRESS_STATUSES,
    STEP_KINDS,
    CategoryInput,
    LeadTime,
    ProjectInput,
    ScheduleInput,
    ScheduleOutput,
    StepPinInput,
    StepProgressInput,
    StepSchedule,
    StepTimingInput,
    WorkflowStepTemplate,
    default_categories,
)

STATUS_NOT_STARTED = "Not Started"
STATUS_IN_PROGRESS = "In Progress"
STATUS_BLOCKED = "Blocked"
STATUS_DONE = "Done"

#: Statuses whose steps are *anchored*: their placement is fixed by recorded
#: actuals (Done) or by the "book the remaining tail from the current week"
#: rule (In Progress / Blocked), never searched for. Capacity is consumed
#: regardless of conflict, so an ENG_CONFLICT / OVERLAP may be raised.
ANCHORED_STATUSES: frozenset[str] = frozenset({STATUS_IN_PROGRESS, STATUS_BLOCKED, STATUS_DONE})

#: ADR 0019 / ADR 0041 R4: domain of a *user-entered* override
#: (`project_workflow_steps.duration_override_weeks`, Gantt / Workspace): 1..104.
#: Unchanged by ADR 0041. The solver does not see this column on its own; see
#: `STEP_DURATION_MIN_WEEKS`.
DURATION_OVERRIDE_MIN_WEEKS = 1
DURATION_OVERRIDE_MAX_WEEKS = 104

#: ADR 0041 R4 / R14: domain of the solver input's merged per-project duration
#: (`StepTimingInput.duration_override_weeks` = `user_override ?? effort_weeks`,
#: merged outside the solver): 0..104, where 0 means "skipped" (R5). The
#: floor's domain is `1..ScheduleInput.horizon_weeks`.
STEP_DURATION_MIN_WEEKS = 0
STEP_DURATION_MAX_WEEKS = DURATION_OVERRIDE_MAX_WEEKS

#: ADR 0043 (P32): domain of `StepTimingInput.overlap_weeks`; 0 = no overlap
#: (the DB stores 0 as NULL, check 1..104).
OVERLAP_MIN_WEEKS = 0
OVERLAP_MAX_WEEKS = 104

#: P33 (ADR 0046 §4, R33-4): domain of `StepTimingInput.wait_weeks`; 0 = no wait.
WAIT_MIN_WEEKS = 0
WAIT_MAX_WEEKS = 104

#: P33 (R33-1): domain of `StepTimingInput.lead_weeks` (None = the input table).
LEAD_MIN_WEEKS = 0
LEAD_MAX_WEEKS = 104


def effective_lead_weeks(row: StepTimingInput | None, table_weeks: int) -> int:
    """R33-1: a project's own lead time for a step, `lead_weeks ?? table`.
    `row` is the project's timing row for the step (None when it has none)."""

    if row is None or row.lead_weeks is None:
        return table_weeks
    return row.lead_weeks


# --- The one skip predicate (ADR 0041 R5) -----------------------------------------


def is_partial_room(*, kind: str, lab_hold_weeks: int | None) -> bool:
    """ADR 0071: `partialRoom(p, s) ⟺ kind(s) = lab ∧ plan_lab_hold_weeks(p,
    s) IS NOT NULL`. A hold on a non-lab step is stored but not read."""

    return kind == "lab" and lab_hold_weeks is not None


def merged_step_override(
    user_override_weeks: int | None,
    effort_weeks: int | None,
    *,
    kind: str | None = None,
    lab_hold_weeks: int | None = None,
) -> int | None:
    """ADR 0041 R4 precedence for the solver input: `user ?? effort`. The
    result goes into `StepTimingInput.duration_override_weeks`; `None` means
    "use the lead time". Pure; no range check (see `validate_step_timing`).

    ADR 0071 R62-1 / I67: a `partialRoom` step (pass `kind` and
    `lab_hold_weeks`) takes no effort share, so its merged value is the
    user's override only (`eff = user_override ?? plan_weeks`), whatever a
    stale `effort_weeks` says. Without `kind` the result is the pre-P62 one."""

    if kind is not None and is_partial_room(kind=kind, lab_hold_weeks=lab_hold_weeks):
        return user_override_weeks
    return user_override_weeks if user_override_weeks is not None else effort_weeks


def certification_off_skips(
    *, kind: str, certification_testing_required: bool, lab_hold_weeks: int | None = None
) -> bool:
    """ADR 0041 R5 second line as amended by ADR 0071 **R62-2** (owner Q2):
    certification testing off skips the **full-room** lab steps only,
    `kind = lab ∧ ¬certification_testing_required ∧ ¬partialRoom`. Pr. Pr /
    Pilot (room weeks set) run whether or not certification testing is
    required. Kept as its own function so R62-2 can be reverted alone (drop
    the `¬partialRoom` term)."""

    return (
        kind == "lab"
        and not certification_testing_required
        and not is_partial_room(kind=kind, lab_hold_weeks=lab_hold_weeks)
    )


def partial_room_zero_length_skips(
    *, kind: str, lead_weeks: int, lab_hold_weeks: int | None = None
) -> bool:
    """ADR 0071 **R62-11** / I67 (owner Q2, "C has no Pr. Pr / Pilot"): a
    `partialRoom` step whose length (`lead = plan_weeks`) is 0 is skipped,
    and nothing revives it: not an override, not a figure (it is outside the
    lab split, R62-1), not a hold. In the engine R62-11 is carried by data
    (C/PDD-J and C/PDD-L get length 0 and room weeks 0 in migration p71a), so
    this rule is implied by the general `lead = 0` skip; it is named here so
    I67 is checkable on its own and R62-11 can be reverted (data revert, then
    this function) without touching R62-2."""

    return is_partial_room(kind=kind, lab_hold_weeks=lab_hold_weeks) and lead_weeks == 0


def step_effective_weeks(
    *,
    lead_weeks: int,
    kind: str,
    certification_testing_required: bool,
    override_weeks: int | None,
    lab_hold_weeks: int | None = None,
) -> int:
    """ADR 0041 "Invariant wording", `eff(p, s)`, as amended by ADR 0071:

        eff = 0                       if lead = 0              (R62-11 for partialRoom)
        eff = 0                       if kind = lab ∧ ¬cert ∧ ¬partialRoom      (R62-2)
        eff = override ?? lead        otherwise

    `override_weeks` is the merged per-project value (`merged_step_override`:
    user ?? effort, 0..104; for a `partialRoom` step the user's override
    only). An override never revives a lead-0 step or a full-room lab step
    with certification testing off (ADR 0019, R7); an override of 0 zeroes
    (skips) a step whose lead time is not 0 (ADR 0041 §3). `lab_hold_weeks`
    is the step's room weeks (None = full, the pre-P62 predicate)."""

    if partial_room_zero_length_skips(
        kind=kind, lead_weeks=lead_weeks, lab_hold_weeks=lab_hold_weeks
    ):
        return 0
    if lead_weeks == 0 or certification_off_skips(
        kind=kind,
        certification_testing_required=certification_testing_required,
        lab_hold_weeks=lab_hold_weeks,
    ):
        return 0
    return lead_weeks if override_weeks is None else override_weeks


def is_step_skipped(
    *,
    lead_weeks: int,
    kind: str,
    certification_testing_required: bool,
    override_weeks: int | None,
    lab_hold_weeks: int | None = None,
) -> bool:
    """ADR 0041 R5 — the ONE skip predicate, used by `analyse_project` and
    meant for every service-side caller (`services.workspace.is_step_skipped`,
    step timing `STEP_SKIPPED`, the stage PATCH `STAGE_SKIPPED`, Gantt
    `timing_editable`, project cards, tracking and the demand query):

        skipped  ⟺  lead = 0  ∨  (kind = lab ∧ ¬cert ∧ ¬partialRoom)
                              ∨  effective = 0

    i.e. `step_effective_weeks(...) == 0`. Same keyword arguments as
    `step_effective_weeks`; ADR 0071: pass the step's `lab_hold_weeks`
    (`plan_lab_hold_weeks`, None = full) so a `partialRoom` step is not
    skipped by certification off (R62-2)."""

    return (
        step_effective_weeks(
            lead_weeks=lead_weeks,
            kind=kind,
            certification_testing_required=certification_testing_required,
            override_weeks=override_weeks,
            lab_hold_weeks=lab_hold_weeks,
        )
        == 0
    )


# --- Lab hold weeks (ADR 0071, R62-0 / R62-4 / R62-5) ------------------------------


#: ADR 0071 / I65: domain of `StepTimingInput.lab_hold_weeks` (None = full).
LAB_HOLD_MIN_WEEKS = 0
LAB_HOLD_MAX_WEEKS = 104


def booked_hold_weeks(lab_hold_weeks: int | None, n: int) -> int:
    """R62-0: `h = min(hold, n)` on a booked interval of `n` weeks; `None`
    (full) holds all `n`. Never negative; 0 when `n <= 0`."""

    if n <= 0:
        return 0
    if lab_hold_weeks is None:
        return n
    return max(0, min(lab_hold_weeks, n))


def hold_window(start: int, end: int, lab_hold_weeks: int | None) -> range:
    """R62-0: the weeks a lab step booked on `start..end` (inclusive) holds
    its chamber, the **last** `h` of them: `range(end - h + 1, end + 1)`.
    With `None` (full) this is `range(start, end + 1)`, the pre-P62 rule;
    with `h = 0` it is empty."""

    h = booked_hold_weeks(lab_hold_weeks, end - start + 1)
    return range(end - h + 1, end + 1)


def row_lab_hold_weeks(lab_hold_weeks: int | None, n: int) -> int | None:
    """The value a lab row reports in `StepSchedule.lab_hold_weeks`: `None`
    for a full-hold step (every booked week, as a pre-P62 row), else the
    booked `h = min(hold, n)` over the row's booked interval of `n` weeks."""

    return None if lab_hold_weeks is None else booked_hold_weeks(lab_hold_weeks, n)


def row_held_weeks(row: StepSchedule) -> range | None:
    """The held weeks of a lab row with a hold, `end - h + 1 .. end`
    (`range(0)` when `h = 0`); `None` when the row reports no hold (full:
    every week the row books, whatever rule the caller already applies)."""

    if row.lab_hold_weeks is None:
        return None
    h = max(0, row.lab_hold_weeks)
    return range(row.end_week - h + 1, row.end_week + 1)


def row_lab_load_weeks(row: StepSchedule) -> int:
    """I66: the lab load of one non-skipped lab row, `h` with NULL read as
    `duration_weeks` (the pre-P62 load). 0 for a skipped or non-lab row."""

    if row.kind != "lab" or row.skipped:
        return 0
    return row.duration_weeks if row.lab_hold_weeks is None else row.lab_hold_weeks


def build_lab_hold_table(
    lead_times: Iterable[LeadTime],
) -> dict[tuple[str, str, str], int | None]:
    """`(workflow_id, category, step_id) -> template room weeks` (None =
    full) from the input's lead-time rows; the first row per key wins in
    sorted order (`build_lead_time_table` rejects duplicates)."""

    out: dict[tuple[str, str, str], int | None] = {}
    for lt in sorted(
        lead_times,
        key=lambda r: (
            r.workflow_id,
            r.category,
            r.step_id,
            -1 if r.lab_hold_weeks is None else r.lab_hold_weeks,
        ),
    ):
        out.setdefault((lt.workflow_id, lt.category, lt.step_id), lt.lab_hold_weeks)
    return out


def template_lab_hold_rows(
    workflow: Workflow,
    category: str,
    hold_table: Mapping[tuple[str, str, str], int | None],
) -> tuple[StepTimingInput, ...]:
    """R62-9: the step-timing rows that give a project built from its
    category template (a What-if added project, a plan-import file project)
    the template's room weeks: one `StepTimingInput(step_id, None, None,
    lab_hold_weeks=h)` per `lab` step whose template hold is not None,
    sorted by step id. `()` when every hold is full, so such inputs are
    byte-identical to before P62."""

    return tuple(
        StepTimingInput(sid, None, None, lab_hold_weeks=hold)
        for sid in sorted(workflow.steps_by_id)
        if workflow.steps_by_id[sid].kind == "lab"
        and (hold := hold_table.get((workflow.workflow_id, category, sid))) is not None
    )


# --- FTE stretch (ADR 0032) -------------------------------------------------------


def is_valid_fte(fte: float) -> bool:
    """An FTE a design step can be scheduled at: finite and strictly positive
    (ADR 0032). `0`, a negative value, NaN and infinity are not."""

    return math.isfinite(fte) and fte > 0


def fte_span(effort_weeks: int, fte: float) -> int:
    """ADR 0032: elapsed weeks for `effort_weeks` of design work by an engineer
    at `fte`: `ceil(effort_weeks / fte)`. Evaluated in exact rational
    arithmetic on the FTE's decimal value (`Engineer.fte` is `Numeric(3, 2)`),
    so `21 / 0.7` is 30, never the 31 a binary-float division would give.
    `0` effort is 0 weeks. Raises `ValueError` for an FTE that is not
    `is_valid_fte` (never divides by zero)."""

    if not is_valid_fte(fte):
        raise ValueError(f"fte {fte!r} is not a positive finite number")
    if effort_weeks <= 0:
        return 0
    return math.ceil(Fraction(effort_weeks) / Fraction(str(fte)))


def leader_fte_of(project: ProjectInput, fte_by_engineer: Mapping[str, float]) -> float | None:
    """The FTE of the project's leader, or `None` when the leader is unset or
    does not resolve (the scheduler reports that as `no_leader`)."""

    if project.leader_engineer_id is None:
        return None
    return fte_by_engineer.get(project.leader_engineer_id)


# --- Workflow (DAG) -------------------------------------------------------------


@dataclass(frozen=True)
class Workflow:
    """One validated workflow: its steps (sorted by `sequence_order`), the
    deterministic walk order, and the direct successor map."""

    workflow_id: str
    steps: tuple[WorkflowStepTemplate, ...]
    steps_by_id: Mapping[str, WorkflowStepTemplate]
    walk_order: tuple[str, ...]
    successors: Mapping[str, tuple[str, ...]]

    @property
    def first_step_id(self) -> str:
        return self.steps[0].step_id


def build_workflows(templates: tuple[WorkflowStepTemplate, ...]) -> dict[str, Workflow]:
    """Group `templates` by `workflow_id` and validate each DAG. Raises
    `ValueError` (input validation, never a silent default) on: unknown
    `kind`, duplicate `step_id`, a self-reference, a predecessor outside the
    same workflow, an empty predecessor set on any step but the first, or a
    cycle (DOMAIN_RULES.md "Precedence", I15).
    """

    by_wf: dict[str, list[WorkflowStepTemplate]] = {}
    for t in templates:
        if t.kind not in STEP_KINDS:
            raise ValueError(
                f"workflow step {t.step_id!r}: kind {t.kind!r} is not one of {STEP_KINDS}"
            )
        by_wf.setdefault(t.workflow_id, []).append(t)

    workflows: dict[str, Workflow] = {}
    for workflow_id in sorted(by_wf):
        steps = tuple(sorted(by_wf[workflow_id], key=lambda s: (s.sequence_order, s.step_id)))
        steps_by_id: dict[str, WorkflowStepTemplate] = {}
        for s in steps:
            if s.step_id in steps_by_id:
                raise ValueError(f"workflow {workflow_id!r}: duplicate step_id {s.step_id!r}")
            steps_by_id[s.step_id] = s

        first_id = steps[0].step_id
        for s in steps:
            if s.step_id != first_id and not s.predecessor_ids:
                raise ValueError(
                    f"workflow {workflow_id!r}: step {s.step_id!r} has an empty predecessor "
                    f"set but is not the first step ({first_id!r})"
                )
            for p in s.predecessor_ids:
                if p == s.step_id:
                    raise ValueError(
                        f"workflow {workflow_id!r}: step {s.step_id!r} references itself"
                    )
                if p not in steps_by_id:
                    raise ValueError(
                        f"workflow {workflow_id!r}: step {s.step_id!r} has predecessor {p!r} "
                        "which is not a step of the same workflow"
                    )

        # Kahn's algorithm with the ready set drained in (sequence_order, step_id)
        # order — deterministic, and identical to plain sequence order whenever
        # sequence order is itself topological (always true for the seeded chain).
        indegree = {s.step_id: len(set(s.predecessor_ids)) for s in steps}
        successors: dict[str, list[str]] = {s.step_id: [] for s in steps}
        for s in steps:
            for p in sorted(set(s.predecessor_ids)):
                successors[p].append(s.step_id)
        seq_of = {s.step_id: s.sequence_order for s in steps}
        ready = sorted((sid for sid, d in indegree.items() if d == 0), key=lambda x: (seq_of[x], x))
        walk: list[str] = []
        while ready:
            sid = ready.pop(0)
            walk.append(sid)
            for succ in sorted(successors[sid], key=lambda x: (seq_of[x], x)):
                indegree[succ] -= 1
                if indegree[succ] == 0:
                    ready.append(succ)
            ready.sort(key=lambda x: (seq_of[x], x))
        if len(walk) != len(steps):
            stuck = sorted(sid for sid, d in indegree.items() if d > 0)
            raise ValueError(
                f"workflow {workflow_id!r}: precedence graph has a cycle among {stuck}"
            )

        workflows[workflow_id] = Workflow(
            workflow_id=workflow_id,
            steps=steps,
            steps_by_id=steps_by_id,
            walk_order=tuple(walk),
            successors={
                sid: tuple(sorted(succs, key=lambda x: (seq_of[x], x)))
                for sid, succs in successors.items()
            },
        )
    return workflows


def transitive_successors(workflow: Workflow, step_id: str) -> frozenset[str]:
    """Every step reachable from `step_id` along predecessor -> successor edges."""

    seen: set[str] = set()
    frontier = list(workflow.successors[step_id])
    while frontier:
        sid = frontier.pop()
        if sid in seen:
            continue
        seen.add(sid)
        frontier.extend(workflow.successors[sid])
    return frozenset(seen)


# --- Categories (ADR 0047 §3, R33-8) --------------------------------------------


@dataclass(frozen=True)
class CategoryMaps:
    """The validated category list of a run: `rank[code]` (sort key 5, the
    rank value) and `workflow[code]` (the workflow the category belongs to).
    `codes` lists the codes in rank order."""

    rank: Mapping[str, int]
    workflow: Mapping[str, str]
    codes: tuple[str, ...]

    def codes_of_workflow(self, workflow_id: str) -> tuple[str, ...]:
        """The categories of `workflow_id`, in rank order."""

        return tuple(c for c in self.codes if self.workflow[c] == workflow_id)


def build_category_maps(
    categories: Iterable[CategoryInput], workflow_ids: Iterable[str] | None = None
) -> CategoryMaps:
    """Validate `ScheduleInput.categories` (R33-8) and index it. `ValueError`
    for a duplicate code, a duplicate rank, a rank that is not an integer
    >= 1, an empty code, or (when `workflow_ids` is given) a `workflow_id`
    that is not one of them. The caller passes `workflow_ids` only for a
    non-default list: the seeded default names both seeded workflows, and a
    fixture that carries only one of them must keep running unchanged (no
    project can use a category whose workflow is absent, because the project
    check below — category of the project's workflow — still applies)."""

    known = None if workflow_ids is None else frozenset(workflow_ids)
    rank: dict[str, int] = {}
    workflow: dict[str, str] = {}
    seen_ranks: dict[int, str] = {}
    for c in sorted(categories, key=lambda c: (c.code, c.workflow_id, repr(c.rank))):
        if not isinstance(c.code, str) or not c.code:
            raise ValueError(f"category code {c.code!r} must be a non-empty string")
        if c.code in rank:
            raise ValueError(f"category {c.code!r} appears more than once")
        if isinstance(c.rank, bool) or not isinstance(c.rank, int) or c.rank < 1:
            raise ValueError(f"category {c.code!r}: rank {c.rank!r} must be an integer >= 1")
        if c.rank in seen_ranks:
            raise ValueError(
                f"category {c.code!r}: rank {c.rank} is also the rank of "
                f"{seen_ranks[c.rank]!r} (ranks must be unique)"
            )
        if known is not None and c.workflow_id not in known:
            raise ValueError(
                f"category {c.code!r}: workflow_id {c.workflow_id!r} is not one of {sorted(known)}"
            )
        rank[c.code] = c.rank
        workflow[c.code] = c.workflow_id
        seen_ranks[c.rank] = c.code
    codes = tuple(sorted(rank, key=lambda code: rank[code]))
    return CategoryMaps(rank=rank, workflow=workflow, codes=codes)


# --- Lead times ------------------------------------------------------------------


def build_lead_time_table(lead_times: tuple[LeadTime, ...]) -> dict[tuple[str, str, str], int]:
    table: dict[tuple[str, str, str], int] = {}
    for lt in lead_times:
        if lt.weeks < 0:
            raise ValueError(
                f"lead time ({lt.workflow_id!r}, {lt.category!r}, {lt.step_id!r}) is negative"
            )
        key = (lt.workflow_id, lt.category, lt.step_id)
        if key in table and table[key] != lt.weeks:
            raise ValueError(f"conflicting duplicate lead-time rows for {key}")
        table[key] = lt.weeks
    return table


# --- Per-project plan -----------------------------------------------------------


@dataclass(frozen=True)
class StepPlan:
    """Everything the schedulers need to know about one step of one project
    *before* any capacity is consulted."""

    step: WorkflowStepTemplate
    # Effective duration (ADR 0019): `duration_override_weeks ?? lead time`;
    # 0 when skipped (an override never revives a skipped step).
    duration: int
    skipped: bool
    status: str  # normalised; skipped steps are always "Done" (treated as complete)
    percent_complete: int
    actual_start_week: int | None
    actual_end_week: int | None
    remaining: int  # derived per DOMAIN_RULES.md (0 when skipped / Done / Not Started)
    # ADR 0032: elapsed weeks the step books when placed (`ceil(duration / fte)`
    # for a design step of a non-frozen project, else `duration`), and the
    # elapsed weeks of an In Progress / Blocked tail (`ceil(remaining / fte)`,
    # else `remaining`). `duration` / `remaining` stay the effort figures.
    span: int
    remaining_span: int
    # ADR 0019 earliest start: set only for a non-skipped `Not Started` step of
    # a non-frozen project (In Progress / Blocked / Done and frozen ignore it).
    start_not_before_week: int | None = None
    # ADR 0043 overlap: how many weeks before its release the step may start.
    # Always 0 for a frozen project, a skipped step and a first step. Kept on
    # a started (In Progress / Blocked / Done) step, so a step the planner ran
    # in parallel and then started keeps running in parallel.
    overlap_weeks: int = 0
    # P33 (ADR 0046 §4, R33-4) wait: the step may not start before
    # `release(s) + 1 + wait_weeks`. Set only on a non-skipped Not Started step
    # of a non-frozen project with predecessors; 0 everywhere else (a started
    # step's wait is over, a skipped step and a frozen project ignore it).
    wait_weeks: int = 0
    # ADR 0071 (R62-0): the step's room weeks, read only on a `lab` step
    # (None on every other kind and on a full-hold lab step). A booked
    # interval of `n` weeks holds the chamber for its last
    # `booked_hold_weeks(lab_hold_weeks, n)` weeks. A frozen project honours
    # it (it is room, not timing).
    lab_hold_weeks: int | None = None

    @property
    def anchored(self) -> bool:
        return not self.skipped and self.status in ANCHORED_STATUSES


@dataclass(frozen=True)
class ProjectPlan:
    project: ProjectInput
    workflow: Workflow
    steps: Mapping[str, StepPlan]
    data_error: str | None
    progress_tracked: bool  # any non-skipped step with status != Not Started
    blocked: bool  # any non-skipped step with status == Blocked
    held_step_ids: frozenset[str]  # Blocked steps with remaining > 0 + their transitive successors
    # ADR 0054 (P40, R40-4 / R40-9): the manual pins that apply, `step_id ->
    # (ms, me)` as given (not yet lapsed, see `pin_windows`). A pin applies to
    # a non-skipped step of a frozen project whatever its stage (frozen ignores
    # progress, ADR 0006), and to a non-skipped Not Started step of a
    # non-frozen project. A pin on a skipped step is inert (I33); on a started
    # step of a non-frozen project it is ignored. A Blocked hold still wins:
    # see `pinned_step_ids`. Empty for every project without pins.
    pins: Mapping[str, tuple[int, int]] = field(default_factory=dict)

    @property
    def pinned_step_ids(self) -> frozenset[str]:
        """The steps the schedulers place on a pin: `pins` minus the steps of
        a Blocked hold (R40-4: a held pinned step is held as today, not placed
        and nothing booked; the pin stays stored)."""

        return frozenset(self.pins) - self.held_step_ids

    def step_plans_in_walk_order(self) -> tuple[StepPlan, ...]:
        return tuple(self.steps[sid] for sid in self.workflow.walk_order)

    @property
    def has_overlap(self) -> bool:
        """True when any step carries a non-zero overlap (ADR 0043)."""

        return any(sp.overlap_weeks > 0 for sp in self.steps.values())

    def start_anchor_ids(self, step_id: str) -> tuple[str, ...]:
        """ADR 0043 `SG(s)`: the nearest non-skipped predecessors of
        `step_id`, walking through skipped steps. Sorted (I8)."""

        found: set[str] = set()
        seen: set[str] = set()
        stack = list(self.steps[step_id].step.predecessor_ids)
        while stack:
            q = stack.pop()
            if q in seen:
                continue
            seen.add(q)
            if self.steps[q].skipped:
                stack.extend(self.steps[q].step.predecessor_ids)
            else:
                found.add(q)
        return tuple(sorted(found))

    def release_sources(self) -> dict[str, tuple[str, ...]]:
        """ADR 0043 / contract A2 static set `R(q)` behind `G(q)`, per step:
        `{q}` if `o(q) = 0`; `{q} ∪ ⋃R(p)` if `o(q) > 0`; `⋃R(p)` if `q` is
        skipped. `FRONTIER_SOURCE` stands for `frontier - 1` (a skipped first
        step), so `G(q) = max(end(r) for r in R(q))` with that convention.
        Each tuple is sorted (I8). ADR 0054 (R40-7): a pinned step (in
        `pinned_step_ids`) is treated like an overlapping one, `{q} ∪ ⋃R(p)`,
        since it passes on `max(end, release)`; with no pin this is unchanged."""

        pinned = self.pinned_step_ids
        out: dict[str, tuple[str, ...]] = {}
        for sid in self.workflow.walk_order:
            sp = self.steps[sid]
            preds = sp.step.predecessor_ids
            upstream: set[str] = set()
            if preds:
                for p in preds:
                    upstream.update(out[p])
            else:
                upstream.add(FRONTIER_SOURCE)
            if sp.skipped:
                out[sid] = tuple(sorted(upstream))
            elif sp.overlap_weeks == 0 and sid not in pinned:
                out[sid] = (sid,)
            else:
                # ADR 0043 overlap, or an ADR 0054 pin (R40-7): `G(q) =
                # max(end(q), release(q))` passes the upstream ends on.
                out[sid] = tuple(sorted(upstream | {sid}))
        return out


#: Marker inside `ProjectPlan.release_sources` for `frontier - 1`.
FRONTIER_SOURCE = ""


# --- ADR 0043 release / gate (shared by greedy, CP-SAT, unconstrained, I27) ----------


def release_week(step: WorkflowStepTemplate, g: Mapping[str, int], frontier: int) -> int:
    """`release(s) = max(G(q) for q in P(s))`, `frontier - 1` with no
    predecessors. With every overlap 0 this is today's `max(pred.end)`."""

    preds = step.predecessor_ids
    return max(g[p] for p in preds) if preds else frontier - 1


def passed_release(sp: StepPlan, end: int, release: int) -> int:
    """`G(q)`, the week by which everything `q`'s successors wait for is done:
    `release(q)` for a skipped step (where it is emitted), `end(q)` with no
    overlap, `max(end(q), release(q))` for a step that overlapped its
    predecessors (it passes their end on)."""

    if sp.skipped:
        return release
    if sp.overlap_weeks == 0:
        return end
    return max(end, release)


def step_gate(sp: StepPlan, release: int, anchor_starts: Iterable[int], frontier: int) -> int:
    """`gate(s)`, contract P32 A2 as amended by R33-4 (DOMAIN_RULES
    "Category templates" §D). With `o(s) = 0` it is `release(s) + 1 + w(s)`;
    with `w(s) = 0` that is exactly today's `pred_end + 1` (no extra frontier
    floor, so every pre-P32 schedule is unchanged). `w(s)` is
    `StepPlan.wait_weeks`, 0 on every started / skipped / frozen step, so an
    In Progress / Blocked tail and a Blocked hold never wait. With `o(s) > 0`
    (`o` and `w` are exclusive, so a wait never meets the anchor):
    `max(release(s) + 1 - o(s), max start of SG(s), frontier)` — the step
    never starts before the step it runs in parallel with has started, nor
    before the project frontier. `anchor_starts` are the starts of
    `ProjectPlan.start_anchor_ids(s)`."""

    if sp.overlap_weeks == 0:
        return release + 1 + sp.wait_weeks
    return max(release + 1 - sp.overlap_weeks, frontier, *anchor_starts)


def validate_schedulable_project(
    project: ProjectInput,
    workflows: Mapping[str, Workflow],
    lead_time_table: Mapping[tuple[str, str, str], int],
    *,
    hub_lab_region: Mapping[str, str],
    priority_order: tuple[str, ...],
    horizon_weeks: int,
    category_workflow: Mapping[str, str],
) -> None:
    """Fail loudly (`ValueError`) on malformed *configuration-level* input for a
    project whose status participates in scheduling. Inconsistent *progress
    data* is not a `ValueError` — it is a per-project `data_error` outcome
    (see `analyse_project`)."""

    if project.priority not in priority_order:
        raise ValueError(
            f"project {project.project_id!r}: priority {project.priority!r} is not one of "
            f"{priority_order} (required for any project whose status participates in "
            "scheduling)"
        )
    if project.category not in category_workflow:
        # ADR 0047 §3 / R33-8: the category list comes from the input.
        raise ValueError(
            f"project {project.project_id!r}: category {project.category!r} is not one of "
            f"{tuple(category_workflow)}"
        )
    if project.hub not in hub_lab_region:
        raise ValueError(
            f"project {project.project_id!r}: hub {project.hub!r} is not one of "
            f"{sorted(hub_lab_region)}"
        )
    if project.capacity_hub not in hub_lab_region:
        # ADR 0042: the capacity hub is a hub (R&D-Greece for the OEM hubs,
        # the hub itself otherwise). Configuration-level, so it fails loudly.
        raise ValueError(
            f"project {project.project_id!r}: capacity_hub {project.capacity_hub!r} is not "
            f"one of {sorted(hub_lab_region)}"
        )
    if project.workflow_id not in workflows:
        raise ValueError(
            f"project {project.project_id!r}: workflow_id {project.workflow_id!r} is not one of "
            f"{sorted(workflows)}"
        )
    if project.frozen and project.actual_start_week is None:
        raise ValueError(
            f"project {project.project_id!r}: frozen=True but actual_start_week is None "
            "(DOMAIN_RULES.md: frozen projects' dates are locked at actual_start)"
        )
    wf = workflows[project.workflow_id]
    for s in wf.steps:
        if (project.workflow_id, project.category, s.step_id) not in lead_time_table:
            raise ValueError(
                f"project {project.project_id!r}: no lead-time row for "
                f"({project.workflow_id!r}, {project.category!r}, {s.step_id!r})"
            )
    # R33-8, after the lead-time row check (whose message pre-P33 callers match):
    # the category must belong to the project's workflow.
    if category_workflow[project.category] != project.workflow_id:  # type: ignore[index]
        raise ValueError(
            f"project {project.project_id!r}: category {project.category!r} belongs to "
            f"workflow {category_workflow[project.category]!r}, not the project's "  # type: ignore[index]
            f"{project.workflow_id!r}"
        )
    validate_step_timing(project, wf, horizon_weeks=horizon_weeks)
    validate_step_pins(project, wf, horizon_weeks=horizon_weeks)


def validate_step_timing(project: ProjectInput, workflow: Workflow, *, horizon_weeks: int) -> None:
    """ADR 0019 / API contract P12 §1 input validation for `project.step_timing`
    (`ValueError`, never a silent default): a duplicate `step_id`, a `step_id`
    that is not a step of the project's workflow, a merged duration outside
    0..104 (ADR 0041 R4: 0 is a valid input and means "skipped", R5), or a
    floor outside 1..`horizon_weeks`."""

    seen: set[str] = set()
    for row in sorted(project.step_timing, key=_step_timing_sort_key):
        where = f"project {project.project_id!r}: step_timing for step {row.step_id!r}"
        if row.step_id in seen:
            raise ValueError(f"{where} appears more than once")
        seen.add(row.step_id)
        if row.step_id not in workflow.steps_by_id:
            raise ValueError(f"{where}: not a step of workflow {workflow.workflow_id!r}")
        override = row.duration_override_weeks
        if override is not None and not (
            STEP_DURATION_MIN_WEEKS <= override <= STEP_DURATION_MAX_WEEKS
        ):
            raise ValueError(
                f"{where}: duration_override_weeks={override} is outside "
                f"{STEP_DURATION_MIN_WEEKS}..{STEP_DURATION_MAX_WEEKS}"
            )
        floor = row.start_not_before_week
        if floor is not None and not 1 <= floor <= horizon_weeks:
            raise ValueError(
                f"{where}: start_not_before_week={floor} is outside 1..{horizon_weeks}"
            )
        # ADR 0043: overlap 0..104; never on the workflow's first step (it has
        # no predecessor to run in parallel with).
        overlap = row.overlap_weeks
        if (
            isinstance(overlap, bool)
            or not isinstance(overlap, int)
            or not OVERLAP_MIN_WEEKS <= overlap <= OVERLAP_MAX_WEEKS
        ):
            raise ValueError(
                f"{where}: overlap_weeks={overlap!r} is outside "
                f"{OVERLAP_MIN_WEEKS}..{OVERLAP_MAX_WEEKS}"
            )
        if overlap != 0 and not workflow.steps_by_id[row.step_id].predecessor_ids:
            raise ValueError(
                f"{where}: overlap_weeks={overlap} on the workflow's first step (it has no "
                "predecessor to overlap)"
            )
        # P33 (R33-4): wait 0..104, never on a first step, never with an overlap.
        wait = row.wait_weeks
        if (
            isinstance(wait, bool)
            or not isinstance(wait, int)
            or not WAIT_MIN_WEEKS <= wait <= WAIT_MAX_WEEKS
        ):
            raise ValueError(
                f"{where}: wait_weeks={wait!r} is outside {WAIT_MIN_WEEKS}..{WAIT_MAX_WEEKS}"
            )
        if wait != 0 and not workflow.steps_by_id[row.step_id].predecessor_ids:
            raise ValueError(
                f"{where}: wait_weeks={wait} on the workflow's first step (a first step's "
                "gap must be 0)"
            )
        if overlap != 0 and wait != 0:
            raise ValueError(
                f"{where}: overlap_weeks={overlap} and wait_weeks={wait} are both non-zero "
                "(one signed gap: at most one of them may be set)"
            )
        # P33 (R33-1): the project's own lead time, 0..104 (None = the table).
        lead = row.lead_weeks
        if lead is not None and (
            isinstance(lead, bool)
            or not isinstance(lead, int)
            or not LEAD_MIN_WEEKS <= lead <= LEAD_MAX_WEEKS
        ):
            raise ValueError(
                f"{where}: lead_weeks={lead!r} is outside {LEAD_MIN_WEEKS}..{LEAD_MAX_WEEKS}"
            )
        # P62 (ADR 0071, I65): room weeks 0..104 (None = full). The `<= length`
        # half of I65 is a storage CHECK; the engine clamps `h = min(hold, n)`.
        hold = row.lab_hold_weeks
        if hold is not None and (
            isinstance(hold, bool)
            or not isinstance(hold, int)
            or not LAB_HOLD_MIN_WEEKS <= hold <= LAB_HOLD_MAX_WEEKS
        ):
            raise ValueError(
                f"{where}: lab_hold_weeks={hold!r} is outside "
                f"{LAB_HOLD_MIN_WEEKS}..{LAB_HOLD_MAX_WEEKS}"
            )


def _step_timing_sort_key(row: StepTimingInput) -> tuple[str, int, int, int, int, int, int]:
    """Total, deterministic order over timing rows (I8): by `step_id`, then the
    values (None sorts first), so even duplicate rows order identically. The
    P33 fields come last, so rows without them order exactly as before; the
    P62 hold after them."""

    return (
        row.step_id,
        -1 if row.duration_override_weeks is None else row.duration_override_weeks,
        -1 if row.start_not_before_week is None else row.start_not_before_week,
        row.overlap_weeks,
        row.wait_weeks,
        -1 if row.lead_weeks is None else row.lead_weeks,
        -1 if row.lab_hold_weeks is None else row.lab_hold_weeks,
    )


def canonical_step_timing(rows: Iterable[StepTimingInput]) -> tuple[StepTimingInput, ...]:
    """The canonical form of a project's `step_timing` for the hashed /
    snapshotted solver input (I8, contract P12 §1): rows with no field set
    (no duration, no floor, overlap 0) are dropped and the rest are sorted by
    `step_id`. A project with no timing therefore canonicalises to `()`,
    exactly the pre-P12 input, so every existing input hash and golden file
    stays byte-identical. ADR 0043: a row carrying only an overlap is kept.
    P33 (R33-7): so is a row carrying only a non-zero `wait_weeks` or a
    non-null `lead_weeks`.

    The scheduler itself does not require canonical input: it sorts the rows
    by `step_id` before use, so their supplied order never affects output.
    """

    return tuple(
        sorted(
            (
                r
                for r in rows
                if r.duration_override_weeks is not None
                or r.start_not_before_week is not None
                or r.overlap_weeks != 0
                or r.wait_weeks != 0
                or r.lead_weeks is not None
                or r.lab_hold_weeks is not None
            ),
            key=_step_timing_sort_key,
        )
    )


def canonical_step_timing_dict(row: StepTimingInput) -> dict[str, int | str | None]:
    """The serialised form of one timing row for an input hash / snapshot
    (ADR 0043, contract P32 A1): the three pre-P32 keys always, and
    `overlap_weeks` **only when it is non-zero**, so a row without an overlap
    serialises exactly as it did before P32 and every existing hash, golden
    file and stored run stays byte-identical (I8, I14). Use this (not
    `dataclasses.asdict`) wherever a `StepTimingInput` is hashed.

    P33 (R33-7): `wait_weeks` only when non-zero and `lead_weeks` only when
    non-null, for the same reason."""

    out: dict[str, int | str | None] = {
        "step_id": row.step_id,
        "duration_override_weeks": row.duration_override_weeks,
        "start_not_before_week": row.start_not_before_week,
    }
    if row.overlap_weeks != 0:
        out["overlap_weeks"] = row.overlap_weeks
    if row.wait_weeks != 0:
        out["wait_weeks"] = row.wait_weeks
    if row.lead_weeks is not None:
        out["lead_weeks"] = row.lead_weeks
    # P62 (ADR 0071, R62-5): room weeks only when set.
    if row.lab_hold_weeks is not None:
        out["lab_hold_weeks"] = row.lab_hold_weeks
    return out


# --- Manual step pins (ADR 0054 as ruled at P40-T02, R40-1..R40-8, R40-12) ---------------


def _step_pin_sort_key(pin: StepPinInput) -> tuple[str, str, str]:
    """Total, deterministic order over pins (I8), even for malformed values
    (compared by `repr`, so a bool or float never breaks the sort)."""

    return (str(pin.step_id), repr(pin.start_week), repr(pin.end_week))


def _is_week_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_step_pins(project: ProjectInput, workflow: Workflow, *, horizon_weeks: int) -> None:
    """R40-12 input validation for `project.step_pins` (`ValueError`, never a
    silent default): a `step_id` that is not a step of the project's
    workflow, a step pinned more than once, or a pair outside the R40-1
    scheduler domain `1 <= start_week <= end_week <= horizon_weeks` (ints, not
    bools; the end is inclusive). The scheduler does not check `start_week >=
    current_week`: R40-5 lapses such a pin instead."""

    seen: set[str] = set()
    for pin in sorted(project.step_pins, key=_step_pin_sort_key):
        where = f"project {project.project_id!r}: step_pins for step {pin.step_id!r}"
        if pin.step_id in seen:
            raise ValueError(f"{where} appears more than once")
        seen.add(pin.step_id)
        if pin.step_id not in workflow.steps_by_id:
            raise ValueError(f"{where}: not a step of workflow {workflow.workflow_id!r}")
        start, end = pin.start_week, pin.end_week
        if not (_is_week_int(start) and _is_week_int(end) and 1 <= start <= end <= horizon_weeks):
            raise ValueError(
                f"{where}: ({start!r}, {end!r}) is outside 1 <= start_week <= end_week <= "
                f"{horizon_weeks} (the end week is inclusive)"
            )


def _applicable_pins(
    project: ProjectInput, workflow: Workflow, plans: Mapping[str, StepPlan]
) -> dict[str, tuple[int, int]]:
    """`ProjectPlan.pins` (R40-4, R40-9): the first well-formed pin per known
    step (sorted, so the choice is deterministic), kept only on a non-skipped
    step that is Not Started or belongs to a frozen project. Tolerant like
    the rest of `analyse_project` (the validator analyses any input); the run
    rejects malformed pins earlier with `validate_step_pins`."""

    out: dict[str, tuple[int, int]] = {}
    for pin in sorted(project.step_pins, key=_step_pin_sort_key):
        sid = pin.step_id
        if sid in out or sid not in workflow.steps_by_id:
            continue
        start, end = pin.start_week, pin.end_week
        if not (_is_week_int(start) and _is_week_int(end) and 1 <= start <= end):
            continue
        sp = plans.get(sid)
        if sp is None or sp.skipped:
            continue
        if not project.frozen and sp.status != STATUS_NOT_STARTED:
            continue
        out[sid] = (start, end)
    return dict(sorted(out.items()))


@dataclass(frozen=True)
class PinWindow:
    """A pin's effective window in a run (R40-5): `start_week..end_week`
    (inclusive) and whether it `lapsed` (differs from the stored pin)."""

    step_id: str
    start_week: int
    end_week: int
    lapsed: bool


def pin_window(project: ProjectInput, pin: tuple[int, int], current_week: int) -> tuple[int, int]:
    """R40-5 effective window of a pin `(ms, me)` at run week `cw`:
    `(ms, me)` when the project is frozen or `ms >= cw`, else `(cw, cw + L -
    1)` with `L = me - ms + 1` (a lapsed pin keeps its length)."""

    ms, me = pin
    if project.frozen or ms >= current_week:
        return ms, me
    return current_week, current_week + (me - ms)


def pin_windows(
    plan: ProjectPlan, current_week: int, *, include_held: bool = False
) -> dict[str, PinWindow]:
    """The effective windows of the pins the schedulers place
    (`plan.pinned_step_ids`; with `include_held`, every applicable pin, which
    is what the unconstrained finish uses), keyed and ordered by step id. A
    window may end past the horizon: the caller makes the project LEFT_OUT."""

    ids = frozenset(plan.pins) if include_held else plan.pinned_step_ids
    out: dict[str, PinWindow] = {}
    for sid in sorted(ids):
        ms_me = plan.pins[sid]
        a, b = pin_window(plan.project, ms_me, current_week)
        out[sid] = PinWindow(sid, a, b, (a, b) != ms_me)
    return out


def pins_lapsed(plan: ProjectPlan, current_week: int) -> bool:
    """`ProjectScheduleOutcome.pin_lapsed` (R40-5, I45): some placed pin's
    effective window differs from the pin."""

    return any(w.lapsed for w in pin_windows(plan, current_week).values())


def pinned_release(end: int, release: int) -> int:
    """R40-7: the release a pinned step passes on, `G(q) = max(end(q),
    release(q))`, so successors still wait for every upstream step (F5)."""

    return max(end, release)


def is_manual_overlap(sp: StepPlan, start: int, release: int) -> bool:
    """R40-7 / I47(a): a pinned row starting at `start` is `MANUAL_OVERLAP`
    iff `start < release(s) + 1 - o(s)`, `o(s)` the step's template overlap
    (0 in a frozen project). A wait is not part of it: a pin inside a wait
    overrides the gap and is not flagged."""

    return start < release + 1 - sp.overlap_weeks


def manual_overlap_by_row(
    plan: ProjectPlan, rows: Mapping[str, StepSchedule], frontier: int
) -> dict[str, bool]:
    """I47(a) evaluated on a solver's own rows: for every row with `pinned`
    set, whether it is `MANUAL_OVERLAP`. `release` is recomputed from the
    rows in walk order, with `G(q)` = a skipped row's week, a pinned row's
    `max(end, release)`, an overlapping row's `max(end, release)` and any
    other row's end. A pinned row whose release cannot be computed (a
    predecessor row is missing: a LEFT_OUT project) is not flagged. Shared by
    greedy and CP-SAT, so each evaluates the flag on its own rows."""

    g: dict[str, int] = {}
    out: dict[str, bool] = {}
    for sid in plan.workflow.walk_order:
        sp = plan.steps[sid]
        preds = sp.step.predecessor_ids
        release: int | None = None
        if all(p in g for p in preds):
            release = max((g[p] for p in preds), default=frontier - 1)
        row = rows.get(sid)
        if row is None:
            continue
        if row.pinned:
            out[sid] = release is not None and is_manual_overlap(sp, row.start_week, release)
            if release is not None:
                g[sid] = pinned_release(row.end_week, release)
        elif row.skipped or sp.skipped or sp.overlap_weeks == 0:
            g[sid] = row.end_week
        elif release is not None:
            g[sid] = max(row.end_week, release)
    return out


def _category_triples(categories: Iterable[CategoryInput]) -> tuple[tuple[int, str, str], ...]:
    return tuple(sorted((c.rank, c.code, c.workflow_id) for c in categories))


def is_default_categories(categories: Iterable[CategoryInput]) -> bool:
    """True when `categories` is the seeded seven at ranks 1..7 (in any
    supplied order): the list the canonical form and the run snapshot omit
    (R33-7)."""

    return _category_triples(categories) == _category_triples(default_categories())


def canonical_categories(
    categories: Iterable[CategoryInput],
) -> list[dict[str, int | str]] | None:
    """The serialised category list for an input hash / the run snapshot's
    `workflow_snapshot["categories"]` (R33-7, I30): `None` (omit the key)
    when the list equals the seeded default, else one
    `{"code", "workflow_id", "rank"}` object per category in rank order."""

    rows = list(categories)
    if is_default_categories(rows):
        return None
    return [
        {"code": code, "workflow_id": workflow_id, "rank": rank}
        for rank, code, workflow_id in _category_triples(rows)
    ]


def canonical_schedule_input_asdict(schedule_input: ScheduleInput) -> dict[str, Any]:
    """`dataclasses.asdict(schedule_input)` with the P33 defaults removed
    (R33-7): `wait_weeks` when 0 and `lead_weeks` when None on every step
    timing row, and `categories` when it equals the seeded default; the
    P36 default (R36-1(g)): a project's `band_rank` when None; and the P40
    default (R40-12): a project's `step_pins` when empty. On an
    input that uses none of them the result equals the pre-P33 `asdict`
    exactly, so a hash over it (e.g. `services.priority_preview`'s token) is
    unchanged by the deploy. Non-default values are kept as `asdict` writes
    them. Pure; the caller sorts / serialises."""

    data = dataclasses.asdict(schedule_input)
    for project in data["projects"]:
        # P36 (ADR 0050, R36-1(g)): an unranked project serialises exactly as
        # before the field existed.
        if project.get("band_rank") is None:
            project.pop("band_rank", None)
        # P53 (R53-2b): no recorded actual end serialises as before the field.
        if "actual_end_week" in project and project["actual_end_week"] is None:
            del project["actual_end_week"]
        # P40 (ADR 0054, R40-12, I48(a)): a project without pins serialises
        # exactly as before the field existed; set pins are sorted by step id.
        if "step_pins" in project:
            if not project["step_pins"]:
                del project["step_pins"]
            else:
                project["step_pins"] = tuple(
                    sorted(
                        project["step_pins"],
                        key=lambda r: (
                            str(r["step_id"]),
                            repr(r["start_week"]),
                            repr(r["end_week"]),
                        ),
                    )
                )
        for row in project["step_timing"]:
            if row.get("wait_weeks") == 0:
                del row["wait_weeks"]
            if "lead_weeks" in row and row["lead_weeks"] is None:
                del row["lead_weeks"]
            # P62 (ADR 0071, R62-5): a full hold serialises as before P62.
            if "lab_hold_weeks" in row and row["lab_hold_weeks"] is None:
                del row["lab_hold_weeks"]
    # P62 (ADR 0071): the template's room weeks only when set.
    for lt in data.get("lead_times", ()):
        if "lab_hold_weeks" in lt and lt["lab_hold_weeks"] is None:
            del lt["lab_hold_weeks"]
    if is_default_categories(schedule_input.categories):
        del data["categories"]
    return data


#: ADR 0054 (R40-12): output fields omitted from the canonical form at False.
_OUTCOME_PIN_FLAGS: tuple[str, ...] = ("manual_overlap", "pin_lapsed")
_STEP_PIN_FLAGS: tuple[str, ...] = ("pinned", "manual_overlap")
#: ADR 0056 (R42-4): outcome fields omitted from the canonical form at their
#: default, so a run with no P4/Q and no queued P3 is byte-identical to P41.
_OUTCOME_BAND_DEFAULTS: tuple[tuple[str, bool], ...] = (
    ("not_scheduled_priority", False),
    ("counts_toward_year", True),
)


def canonical_schedule_output_asdict(schedule_output: ScheduleOutput) -> dict[str, Any]:
    """`dataclasses.asdict(schedule_output)` with the P40 output flags removed
    at their default (R40-12, I48(a)): `pinned` / `manual_overlap` on every
    step row and `manual_overlap` / `pin_lapsed` on every outcome, when
    False. A run with no pin therefore serialises exactly as before P40; use
    this (not `asdict`) wherever an output is hashed or stored as JSON."""

    data = dataclasses.asdict(schedule_output)
    for outcome in data["project_outcomes"]:
        for key in _OUTCOME_PIN_FLAGS:
            if outcome.get(key) is False:
                del outcome[key]
        # ADR 0056 (R42-4): the P42 outcome flags at their default.
        for key, default in _OUTCOME_BAND_DEFAULTS:
            if outcome.get(key) is default:
                del outcome[key]
        for step in outcome["steps"]:
            for key in _STEP_PIN_FLAGS:
                if step.get(key) is False:
                    del step[key]
            # P62 (ADR 0071): a row without a hold serialises as before P62.
            if "lab_hold_weeks" in step and step["lab_hold_weeks"] is None:
                del step["lab_hold_weeks"]
    return data


def derive_remaining(
    duration: int, percent_complete: int, remaining_weeks_override: int | None
) -> int:
    """DOMAIN_RULES.md "Derived remaining duration"."""

    if remaining_weeks_override is not None:
        remaining = remaining_weeks_override
    else:
        remaining = math.ceil(duration * (1 - percent_complete / 100))
    return max(0, remaining)


def analyse_project(
    project: ProjectInput,
    workflow: Workflow,
    lead_time_table: Mapping[tuple[str, str, str], int],
    *,
    leader_fte: float | None = None,
) -> ProjectPlan:
    """Build the `ProjectPlan`: durations, skips, normalised progress, `remaining`,
    the FTE-stretched `span` / `remaining_span` (ADR 0032), the Blocked hold
    set, and any `data_error`.

    `frozen` wins over progress (ADR 0006 precedence): a frozen project's
    progress rows are ignored entirely (every step reads as Not Started) and it
    can never be progress-tracked, blocked or rejected for a data error. A
    frozen project is also never stretched (ADR 0032: its dates stay locked).

    `leader_fte` is the leader's FTE (`None`: no leader resolves, or the caller
    only wants effort figures; nothing is stretched). A non-frozen project whose
    leader FTE is not `is_valid_fte` (0, negative, NaN) is a `data_error` when
    any design step still has work to place; otherwise the FTE is irrelevant.
    """

    progress_by_step: dict[str, StepProgressInput] = {}
    errors: list[str] = []
    for pr in sorted(project.step_progress, key=lambda r: r.step_id):
        if pr.step_id not in workflow.steps_by_id:
            errors.append(f"progress row for unknown step {pr.step_id!r}")
            continue
        if pr.step_id in progress_by_step:
            errors.append(f"duplicate progress row for step {pr.step_id!r}")
            continue
        progress_by_step[pr.step_id] = pr

    # ADR 0019 step timing, sorted by step_id (I8). `validate_step_timing`
    # rejects bad rows before a run; this stays tolerant (first row per step
    # wins, unknown steps ignored) so the invariant validator can analyse any
    # input without raising.
    timing_by_step: dict[str, StepTimingInput] = {}
    for row in sorted(project.step_timing, key=_step_timing_sort_key):
        if row.step_id in workflow.steps_by_id:
            timing_by_step.setdefault(row.step_id, row)

    def effective_duration(step: WorkflowStepTemplate, table_weeks: int) -> int:
        """`eff(p, s)` (ADR 0041 R5, R33-1): `lead = lead_weeks ?? table`, then
        the merged override `?? lead`; 0 for a lead-0 step or a lab step with
        certification testing off. A frozen project honours `lead_weeks` too
        (it is a duration, not timing)."""

        row = timing_by_step.get(step.step_id)
        return step_effective_weeks(
            lead_weeks=effective_lead_weeks(row, table_weeks),
            kind=step.kind,
            certification_testing_required=project.certification_testing_required,
            override_weeks=None if row is None else row.duration_override_weeks,
            lab_hold_weeks=hold_of(step),
        )

    def hold_of(step: WorkflowStepTemplate) -> int | None:
        """ADR 0071: the step's room weeks, on a `lab` step only (a hold on
        another kind is stored but not read). Tolerant of a malformed value
        (the run rejects it earlier in `validate_step_timing`)."""

        row = timing_by_step.get(step.step_id)
        if step.kind != "lab" or row is None or row.lab_hold_weeks is None:
            return None
        return max(0, row.lab_hold_weeks)

    def start_floor(step_id: str) -> int | None:
        """The Not Started search floor; frozen projects ignore it (frozen wins)."""

        row = timing_by_step.get(step_id)
        if project.frozen or row is None:
            return None
        return row.start_not_before_week

    def overlap_of(step: WorkflowStepTemplate) -> int:
        """ADR 0043: the step's overlap; 0 in a frozen project and on a first
        step (the validator rejects that input; this stays tolerant)."""

        row = timing_by_step.get(step.step_id)
        if project.frozen or row is None or not step.predecessor_ids:
            return 0
        return max(0, row.overlap_weeks)

    def wait_of(step: WorkflowStepTemplate) -> int:
        """P33 (R33-4): the step's wait; 0 in a frozen project, on a first
        step and wherever the step also carries an overlap (the validator
        rejects both inputs; this stays tolerant). Only a Not Started step
        is given it (see the callers): a started step's wait is over."""

        row = timing_by_step.get(step.step_id)
        if project.frozen or row is None or not step.predecessor_ids or row.overlap_weeks > 0:
            return 0
        return max(0, row.wait_weeks)

    # ADR 0032: a non-frozen project with a valid leader FTE is stretched.
    stretch_fte = (
        leader_fte
        if not project.frozen and leader_fte is not None and is_valid_fte(leader_fte)
        else None
    )

    def spans(kind: str, effort: int, remaining: int) -> tuple[int, int]:
        """(span, remaining_span): `ceil(weeks / fte)` for a stretched design
        step, the effort figures unchanged for everything else."""

        if kind != "design" or stretch_fte is None:
            return effort, remaining
        return fte_span(effort, stretch_fte), fte_span(remaining, stretch_fte)

    plans: dict[str, StepPlan] = {}
    for step in workflow.steps:
        lead = lead_time_table[(project.workflow_id, project.category, step.step_id)]  # type: ignore[index]
        # ADR 0041 R5: the one skip predicate — skipped ⟺ eff == 0.
        duration = effective_duration(step, lead)
        skipped = duration == 0
        progress = None if project.frozen else progress_by_step.get(step.step_id)

        if skipped:
            # A skipped step has no progress state of its own — always complete.
            plans[step.step_id] = StepPlan(
                step=step,
                duration=0,
                skipped=True,
                status=STATUS_DONE,
                percent_complete=100,
                actual_start_week=None,
                actual_end_week=None,
                remaining=0,
                span=0,
                remaining_span=0,
            )
            continue

        if progress is None:
            span, remaining_span = spans(step.kind, duration, duration)
            plans[step.step_id] = StepPlan(
                step=step,
                duration=duration,
                skipped=False,
                status=STATUS_NOT_STARTED,
                percent_complete=0,
                actual_start_week=None,
                actual_end_week=None,
                remaining=duration,
                span=span,
                remaining_span=remaining_span,
                start_not_before_week=start_floor(step.step_id),
                overlap_weeks=overlap_of(step),
                wait_weeks=wait_of(step),
                lab_hold_weeks=hold_of(step),
            )
            continue

        status = progress.status
        if status not in PROGRESS_STATUSES:
            errors.append(f"step {step.step_id!r}: unknown status {status!r}")
            continue
        if not 0 <= progress.percent_complete <= 100:
            errors.append(
                f"step {step.step_id!r}: percent_complete "
                f"{progress.percent_complete} outside 0..100"
            )
            continue
        if status in ANCHORED_STATUSES and progress.actual_start_week is None:
            errors.append(f"step {step.step_id!r}: status {status!r} but actual_start_week is null")
            continue
        if status == STATUS_DONE and progress.actual_end_week is None:
            errors.append(f"step {step.step_id!r}: status Done but actual_end_week is null")
            continue
        if (
            progress.actual_start_week is not None
            and progress.actual_end_week is not None
            and progress.actual_end_week < progress.actual_start_week
        ):
            errors.append(
                f"step {step.step_id!r}: actual_end_week {progress.actual_end_week} < "
                f"actual_start_week {progress.actual_start_week}"
            )
            continue
        if progress.remaining_weeks_override is not None and progress.remaining_weeks_override < 0:
            errors.append(
                f"step {step.step_id!r}: remaining_weeks_override "
                f"{progress.remaining_weeks_override} is negative"
            )
            continue

        # Consistency coercions (DOMAIN_RULES.md field table): Not Started ⇒ 0,
        # Done ⇒ 100. Enforced at write time upstream; re-applied here so the
        # I12 roll-up never depends on a stale percentage.
        pct = progress.percent_complete
        if status == STATUS_NOT_STARTED:
            pct = 0
        elif status == STATUS_DONE:
            pct = 100

        if status in (STATUS_IN_PROGRESS, STATUS_BLOCKED):
            remaining = derive_remaining(duration, pct, progress.remaining_weeks_override)
        elif status == STATUS_DONE:
            remaining = 0
        else:
            remaining = duration

        span, remaining_span = spans(step.kind, duration, remaining)
        plans[step.step_id] = StepPlan(
            step=step,
            duration=duration,
            skipped=False,
            status=status,
            percent_complete=pct,
            actual_start_week=progress.actual_start_week if status != STATUS_NOT_STARTED else None,
            actual_end_week=progress.actual_end_week if status == STATUS_DONE else None,
            remaining=remaining,
            span=span,
            remaining_span=remaining_span,
            start_not_before_week=(
                start_floor(step.step_id) if status == STATUS_NOT_STARTED else None
            ),
            overlap_weeks=overlap_of(step),
            wait_weeks=wait_of(step) if status == STATUS_NOT_STARTED else 0,
            lab_hold_weeks=hold_of(step),
        )

    if not project.frozen and leader_fte is not None and not is_valid_fte(leader_fte):
        # ADR 0032: a leader at FTE 0 (or a negative / non-finite FTE) cannot
        # do design work, so any design step with work left is unplaceable.
        # Reported through the existing data-error rejection; never a divide.
        unplaceable = [
            sid
            for sid in workflow.walk_order
            if sid in plans
            and plans[sid].step.kind == "design"
            and not plans[sid].skipped
            and plans[sid].status != STATUS_DONE
            and (plans[sid].status == STATUS_NOT_STARTED or plans[sid].remaining > 0)
        ]
        if unplaceable:
            errors.append(
                f"leader {project.leader_engineer_id!r} has FTE {leader_fte!r} (must be > 0): "
                f"design step(s) {', '.join(unplaceable)} cannot be scheduled"
            )

    data_error = "; ".join(errors) if errors else None
    if data_error is not None:
        # The project is rejected; fill any missing plans so the mapping is
        # complete for callers that still want durations (progress_pct etc.).
        for step in workflow.steps:
            if step.step_id not in plans:
                lead = lead_time_table[(project.workflow_id, project.category, step.step_id)]  # type: ignore[index]
                duration = effective_duration(step, lead)
                span, remaining_span = spans(step.kind, duration, duration)
                plans[step.step_id] = StepPlan(
                    step=step,
                    duration=duration,
                    skipped=False,
                    status=STATUS_NOT_STARTED,
                    percent_complete=0,
                    actual_start_week=None,
                    actual_end_week=None,
                    remaining=duration,
                    span=span,
                    remaining_span=remaining_span,
                    start_not_before_week=start_floor(step.step_id),
                    overlap_weeks=overlap_of(step),
                    wait_weeks=wait_of(step),
                    lab_hold_weeks=hold_of(step),
                )

    tracked = any(not sp.skipped and sp.status != STATUS_NOT_STARTED for sp in plans.values())
    blocked = any(not sp.skipped and sp.status == STATUS_BLOCKED for sp in plans.values())

    held: set[str] = set()
    for sid in workflow.walk_order:
        sp = plans[sid]
        if not sp.skipped and sp.status == STATUS_BLOCKED and sp.remaining > 0:
            held.add(sid)
            held.update(transitive_successors(workflow, sid))
    # Skipped steps are rendered as skipped regardless of the hold.
    held = {sid for sid in held if not plans[sid].skipped}

    return ProjectPlan(
        project=project,
        workflow=workflow,
        steps=plans,
        data_error=data_error,
        progress_tracked=tracked,
        blocked=blocked,
        held_step_ids=frozenset(held),
        pins=_applicable_pins(project, workflow, plans) if project.step_pins else {},
    )


# --- Pure by-products --------------------------------------------------------------


def first_step_frontier(project: ProjectInput, current_week: int) -> int:
    """Earliest week the project's first step may start (its "frontier").
    Frozen: locked at `actual_start_week`. Otherwise `max(CURRENT_WEEK,
    actual_start_week)` (P2-T01 earliest-start floor, unchanged)."""

    if project.frozen:
        assert project.actual_start_week is not None
        return project.actual_start_week
    frontier = current_week
    if project.actual_start_week is not None:
        frontier = max(frontier, project.actual_start_week)
    return frontier


def unconstrained_end_week(plan: ProjectPlan, current_week: int) -> int | None:
    """DOMAIN_RULES.md "Expected vs projected completion": the earliest finish
    assuming unlimited engineers and chambers — walk the DAG with the
    effective durations only (ADR 0019: `duration_override_weeks ?? lead
    time`), stretched by the leader's FTE (ADR 0032: `span` /
    `remaining_span`; unlimited engineers remove contention, not the leader's
    own speed, so unconstrained <= constrained still holds), honouring a Not
    Started step's `start_not_before_week` (a plan input, not a resource).
    Done / In Progress stages keep their actual start and their derived
    `remaining` (progress rules); a Blocked stage is
    treated as In Progress (unlimited resources cannot unblock it, but the
    *unconstrained* figure deliberately assumes the block clears now — the
    constrained run reports the hold via `blocked=True`). `None` when every
    step is skipped.

    ADR 0043: precedence is the release / gate rule (`release_week`,
    `step_gate`, `passed_release`), identical to the schedulers'; with every
    overlap 0 it is `max(pred.end) + 1`, unchanged.

    P33 (R33-4/R33-5): the gate includes a Not Started step's wait
    (`release + 1 + w`), a plan input like the floor.

    P40 (ADR 0054, R40-8): a pinned step sits on its effective window
    (`pin_windows`) and passes on `G = max(end, release)`; the one-leader rule
    below also avoids the project's pinned design windows.

    P33 (R33-6) one-leader rule: a non-frozen, Not Started design step is
    placed at the first week `>= floor` whose window `[w, w + span)` does not
    intersect the window of any design step of the same project already
    placed in walk order (its leader is one person, the same reason the FTE
    stretch is kept). Anchored windows count from `CURRENT_WEEK` (the part a
    scheduler books). This is greedy's leader search restricted to the
    project itself, so I16 (unconstrained <= constrained) still holds. With
    design steps totally ordered by precedence and no overlap (the seeded
    strict chain) it never moves anything.
    """

    frontier = first_step_frontier(plan.project, current_week)
    ends: dict[str, int] = {}
    starts: dict[str, int] = {}
    g: dict[str, int] = {}
    # R33-6: design windows of this project already placed, in walk order.
    design_windows: list[tuple[int, int]] = []
    one_leader = not plan.project.frozen
    # ADR 0054 (R40-8): pins are plan inputs, placed on their effective
    # windows (a Blocked hold is assumed to clear, as above, so every
    # applicable pin counts). They are fixed before any search in the
    # schedulers, so the one leader is busy in a pinned design window
    # whatever the walk order. No pin: nothing below changes.
    pins = pin_windows(plan, current_week, include_held=True) if plan.pins else {}
    if one_leader:
        for win in pins.values():
            if plan.steps[win.step_id].step.kind == "design":
                design_windows.append((win.start_week, win.end_week))
    for sid in plan.workflow.walk_order:
        sp = plan.steps[sid]
        release = release_week(sp.step, g, frontier)
        if sp.skipped:
            starts[sid] = ends[sid] = release
            g[sid] = release
            continue
        if sid in pins:
            starts[sid] = pins[sid].start_week
            ends[sid] = pins[sid].end_week
            g[sid] = pinned_release(ends[sid], release)
            continue
        gate = step_gate(sp, release, (starts[r] for r in plan.start_anchor_ids(sid)), frontier)
        if sp.status == STATUS_DONE:
            assert sp.actual_start_week is not None and sp.actual_end_week is not None
            starts[sid] = sp.actual_start_week
            ends[sid] = sp.actual_end_week
        elif sp.status in (STATUS_IN_PROGRESS, STATUS_BLOCKED):
            assert sp.actual_start_week is not None
            starts[sid] = sp.actual_start_week
            if sp.remaining_span == 0:
                ends[sid] = max(sp.actual_start_week, gate - 1)
            else:
                tail_start = max(current_week, gate, sp.actual_start_week)
                ends[sid] = tail_start + sp.remaining_span - 1
                if one_leader and sp.step.kind == "design":
                    design_windows.append((tail_start, ends[sid]))
        else:
            start = gate if plan.project.frozen else max(current_week, gate)
            if sp.start_not_before_week is not None:
                # ADR 0019: a planner-set earliest start is a plan input, not a
                # resource limit, so unlimited resources do not lift it (keeps
                # unconstrained <= constrained, I16).
                start = max(start, sp.start_not_before_week)
            if one_leader and sp.step.kind == "design":
                start = first_free_week(start, sp.span, design_windows)
                design_windows.append((start, start + sp.span - 1))
            starts[sid] = start
            ends[sid] = start + sp.span - 1
        if (
            one_leader
            and sp.step.kind == "design"
            and sp.status == STATUS_DONE
            and ends[sid] >= current_week
        ):
            design_windows.append((max(starts[sid], current_week), ends[sid]))
        g[sid] = passed_release(sp, ends[sid], release)
    non_skipped = [ends[sid] for sid, sp in plan.steps.items() if not sp.skipped]
    return max(non_skipped) if non_skipped else None


def first_free_week(floor: int, span: int, windows: Iterable[tuple[int, int]]) -> int:
    """R33-6: the first week `w >= floor` such that `[w, w + span - 1]`
    intersects none of the inclusive `windows`. Pure and deterministic (the
    windows are sorted before the scan). A `span` of 0 is placed at `floor`."""

    w = floor
    if span <= 0:
        return w
    for lo, hi in sorted(windows):
        if hi < w:
            continue
        if lo > w + span - 1:
            break
        w = hi + 1
    return w


def project_progress_pct(steps: Iterable[tuple[int, int]]) -> int | None:
    """The one project roll-up formula (DOMAIN_RULES "Project roll-up
    progress", I12; "Gate remediation rulings" #3). Public and pure so the
    API layer (Project Workspace) and both solvers share a single body.

    `steps` is one `(percent_complete, effective_duration_weeks)` pair per
    workflow step, where `percent_complete` is the **stored** value (0 for a
    step with no progress row) and `effective_duration_weeks` is the step's
    effective duration (ADR 0019: `duration_override_weeks ?? lead time`), or
    0 when the step is skipped (lead time 0, or a lab step with certification
    testing off; an override never un-skips a step). Returns
    `round(Σ(percent × duration) / Σ duration)` (Python `round`, i.e.
    half-to-even), or `None` when Σ duration == 0. Duration-weighted, never a
    14-way mean. Applies to every project, frozen ones included.
    """

    pairs = list(steps)
    total = sum(d for _, d in pairs)
    if total == 0:
        return None
    return round(sum(p * d for p, d in pairs) / total)


def compute_progress_pct(plan: ProjectPlan) -> int | None:
    """`project_progress_pct` over this project's stored progress rows
    (ruling 3). Uses the stored `percent_complete` exactly as the Workspace
    does -- including for a frozen project, whose rows the *scheduling* rules
    otherwise ignore (ADR 0006 "frozen wins") -- with skipped steps weighted 0.
    A duplicated row (a data error) counts once, first in input order."""

    stored: dict[str, int] = {}
    for pr in plan.project.step_progress:
        stored.setdefault(pr.step_id, pr.percent_complete)
    return project_progress_pct(
        (stored.get(sid, 0), sp.duration) for sid, sp in sorted(plan.steps.items())
    )
