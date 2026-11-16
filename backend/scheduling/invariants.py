"""Reusable invariant validator — Invariants I1-I17, I21-I22, I27-I30, I35, I37 and the
solver-input part of I26, per `docs/DOMAIN_RULES.md`. I25 / I26 over live rows are in
`scheduling.demand`.

This is **the permanent correctness contract** for `backend/scheduling/`.
`workflow-auditor` calls `validate_invariants()` on every solver-touching
change — see the P2-T04 and P9-T02 `docs/MEMORY.md` entries.

Design:
    - `validate_invariants(schedule_input, schedule_output)` runs every check
      and returns *all* violations found in one pass (never raises on a
      violation, never stops at the first) — an empty tuple means every
      assertable invariant holds.
    - Each `InvariantViolation` names which invariant (`"I1"`..`"I22"`), a
      human-readable description, and whichever of project_id / step_id /
      engineer_id / chamber_id / hub / week locates the problem.
    - `check_scheduler_determinism(schedule_input)` is I8's check, exposed as
      its own reusable public function.
    - `compute_design_load_by_hub` / `compute_lab_load_by_hub` are the I6 / I7
      aggregates, exposed for the Capacity surface to reuse.

What is assertable at the pure-function level (2026-09-27 revision):
    I1  engineer double-booking (fixed placements -> ENG_CONFLICT required;
        weeks < CURRENT_WEEK of a non-frozen project do not consume capacity)
    I2  chamber over-capacity (same shape, OVERLAP required); an anchored
        lab step may overbook only when every eligible chamber was full
        (DOMAIN_RULES "Gate remediation rulings" #1)
    I3  every non-skipped step starts after all its DAG predecessors end
        (anchored / held steps exempt: their start is recorded history)
    I4  lab steps booked only to eligible chambers in the project's lab region
    I5  14-row shape: skipped rows present with skipped=true and zero
        duration, or LEFT_OUT (a LEFT_OUT progress-tracked project still
        carries its anchored rows, ruling 2); data-error projects carry no rows.
        ADR 0041 R5: "skipped" is derived from the inputs (lead = 0, lab with
        certification off, or a merged override of 0), never from
        `analyse_project`; a non-skipped row has a positive duration
    I6  design load = Σ design-kind effective durations (each row's duration
        equals `duration_override_weeks ?? lead time`, ADR 0019;
        elapsed/skipped contribute 0)
    I7  lab load = Σ lab-kind durations × 1.0
    I8  determinism (re-run byte-identical)
    I9  within_year / spillover re-derived from end_week + delay_weeks
    I10 frozen dates never move
    I11 Done stages' [start, end] equal the recorded actuals, and a Done row
        is never missing from a non-data-error outcome (ruling 2)
    I12 progress_pct is the duration-weighted roll-up
    I15 input DAG acyclic/valid; every run respects it; step rows belong to
        the project's workflow
    I16 expected / projected / unconstrained end weeks are the stored
        by-products of the run (consistent with target_end_week, end_week +
        delay, and a recomputed unconstrained walk)
    I21 (ADR 0019, ADR 0032) every non-skipped, non-Done step of a
        non-frozen project carries its effective duration (effort) as
        `duration_weeks` and books a span equal to that duration stretched by
        the leader's FTE (`ceil(duration / fte)` for design, the duration
        itself for lab / elapsed); an In Progress / Blocked tail equals
        `ceil(remaining / fte)` (design) or `remaining`
    I22 (ADR 0019) every Not Started step with `start_not_before_week` set
        starts at or after it (frozen projects and held steps exempt)
    I27 (ADR 0043) every non-skipped, non-held Not Started step of a
        non-frozen project starts at or after `gate(s)`. I3 is restated
        through the release `G` (`start >= G(q) + 1` per predecessor `q`) for
        every step with `overlap_weeks == 0` — identical to the pre-P32 I3
        when no step has an overlap. For a step with `o(s) = 0`, I27 is I3
        (`gate = release + 1`), so I27 is *reported* only for steps with
        `o(s) > 0` (no duplicate violations for an I3 failure)
    I26 (ADR 0041 R3, input part) a started stage of a non-frozen project is
        never zeroed by its merged override (the live-row I26 split check is
        `scheduling.demand.check_i26_effort_split`)
    I27 rev. (P33, R33-4) every non-skipped, non-held Not Started step of a
        non-frozen project starts at or after `max(CURRENT_WEEK, gate(s),
        start_not_before_week)`, `gate` piecewise (`release + 1 + w` with no
        overlap). To avoid reporting one failure twice: the `gate` term is
        reported here for `o(s) > 0` (I3 covers `release + 1`, I28 the wait,
        I22 the floor) and the `CURRENT_WEEK` term for every such step
    I28 (P33) every such step with `w(s) > 0` starts at or after `release(s) +
        1 + w(s)`; and (`check_wait_invariance`, run with I8) two inputs that
        differ only in waits give identical `duration_weeks` on every common
        row and identical `progress_pct`
    I29 (P33, R33-1) every row's `duration_weeks` equals `eff` evaluated on
        the input alone (`lead = lead_weeks ?? table`; 0 if `lead = 0` or lab
        with certification off; else `override ?? lead`), and the row is
        `skipped` exactly when that is 0
    I30 (P33, ADR 0047 §3, R33-8) the category list is valid, and for
        consecutive ids in `scheduling_order` equal on sort keys 1-4 the
        category rank never decreases, ties broken by ascending `project_id`.
        The snapshot half (`workflow_snapshot["categories"]`) is service-side
    I35 (P35, ADR 0049 as ruled) every project of the run input in a
        schedulable status has at least one step with `eff > 0` derived from
        the inputs (`lead_weeks ?? table`, certification, override). A project
        whose 14 steps are all skipped (e.g. every step excluded, which the
        builder sends as `lead_weeks = 0`, R35-9) gets an outcome in no
        Dashboard bucket; R35-5 (`NO_STEPS_LEFT`) must refuse it before the
        run. I33 / I34 live-row halves are in `scheduling.demand`
    I30 rev. (P36, R36-9) the "equal on sort keys" head is keys 1-3a and 4
        (frozen, VIP, priority, band_rank, status)
    I37a (P36, ADR 0050, R36-9) every `band_rank` is None or an int >= 1, and
        keys 1-3a (frozen, VIP, priority, band_rank with None last) are
        lexicographically non-decreasing over every consecutive pair of
        `scheduling_order` (so ranks never decrease inside a band group, and
        no group is split). Run on every input.
    I37b (P36) live state only (`validate_invariants(live_state=True)` /
        `check_i37b_band_ranks_dense`): per band, the schedulable projects'
        ranks are exactly 1..n, and `band_rank` is set iff the status is
        schedulable and the priority is set
    I37c (P36) a re-rank write: `check_i37c_placement` over the band's id
        order before / after the write. I37d (preview input == input rebuilt
        after confirm) is service-side
    I38 (P37, ADR 0052) one week per solve: `check_i38_run_week` /
        `validate_invariants(run_week=...)` — the stored run row's
        `current_week` equals the input's `current_week`, and that week is in
        the I41 domain. The solvers read the week only from the input (no
        import-bound default exists since P37-T03), so the outcomes are at it.
    I41 (P37) week domain: `check_i41_week_domain` — `1 <= week <= 52`. Run
        on `run_week` when given and on the input week under `live_state`
        (an engine-only input may solve from a week past 52, e.g. the horizon-
        overflow golden scenarios, so it is not run on every input).
    I45 (P40, ADR 0054) every pin the input applies (not skipped, not held,
        Not Started unless frozen) sits on its effective window with
        `pinned = true`, `duration_weeks = eff` and its resource; a window past
        the horizon makes the project left_out with no row; `pin_lapsed` iff
        some window differs from its pin; no other row is pinned
    I47 (P40) (a) `manual_overlap` iff `a < release + 1 - o`, release from the
        rows with `G = max(end, release)` for a pinned step, OR on the outcome;
        (b) I3 / I15 / I21 / I22 / I27 / I28 hold for unpinned steps with that
        `G`; (d) I1 / I2 accept a pinned placement only with ENG_CONFLICT /
        OVERLAP, including two placements of one project (a lab pin also only
        when no eligible chamber had room). (c) greedy = CP-SAT on pinned rows
        is the solver-comparison's / test suite's
    I48 (P40) (b) `check_pin_load_neutrality` (run with I8): pins change no
        `duration_weeks` / `skipped` on a common row and no `progress_pct`;
        (d) I10 for a frozen project with pins recomputes its frozen walk
    I49 (P42, ADR 0056 R42-3) band exclusion: a non-frozen P4 / Q project in a
        schedulable status has the not-scheduled outcome (excluded,
        `not_scheduled_priority`, no rows, null weeks, never counted) and is
        absent from `scheduling_order`; no other outcome carries the flag; a
        status-excluded project keeps `counts_toward_year = true`
    I50 (P42, R42-4) year basis: `counts_toward_year` equals
        `domain_constants.counts_toward_year` on the input; I9 is re-derived
        with it (`_check_i9_within_year_derivation`, tagged I50 on a
        non-counting project)
    I51 (P42, R42-5) the (frozen, counts_toward_year) tier never decreases
        over `scheduling_order`; I30 / I37a heads gain key 1a
    I52 (P42, R42-5) `check_band_neutrality(schedule_input, solver)`: the
        outcomes of counting work are identical with and without the
        non-frozen non-counting projects (run with I8 for greedy)
    I13 (health badge), I14 (run immutability) and I17 (capacity supply) are
    API/DB-side invariants with nothing to assert on a `ScheduleOutput`; they
    are the workflow-auditor's to check against the live API (P9-T06).

Capacity hubs (2026-10-22, ADR 0042, P29-T02):
    `ProjectInput.capacity_hub` (R&D-Greece for `OEM-HCK` / `OEM-Seitek`, the
    hub itself otherwise) is the project's engineer pool and the hub its design
    load counts against. Inside this validator that means:
    - I6's per-hub aggregate stays keyed by `project.hub` (the `members`
      breakdown of the Capacity surface's Greece row); the surface's row
      figure is `compute_design_load_by_capacity_hub`, which is Σ over the
      capacity hub's own and member projects (ADR 0042 §3). Both sum to the
      same grand total, which is what I6 asserts.
    - I4 (lab region) and the workflow (I15) still follow `project.hub`: the
      OEM hubs' lab region is already Greece.
    - There is deliberately **no** invariant "the booked engineer belongs to
      the project's capacity hub". The scheduler books the *assigned* leader
      (DOMAIN_RULES "Booking rules") and never picks one; the pool rule
      governs engineer selection (the what-if picker, the service-side
      provisional-leader picker). The client's own data has leaders outside
      the project's hub (an R&D-India engineer leads two dozen PD-India
      projects), which a hard rule would reject. `cross_capacity_hub_leaders`
      lists those cases as a *diagnostic* for the auditor and the Capacity
      surface (such a project's load counts against its capacity hub while
      the leader's FTE sits in another hub's supply).
    - An unknown `capacity_hub` is a configuration error: `run_greedy_sgs`
      raises `ValueError` (`workflow.validate_schedulable_project`).

No DB access, no network access, no filesystem access, no randomness, no
wall-clock dependence. Every iteration is over an explicitly sorted sequence,
so the *order* of violations returned is itself deterministic.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace

import domain_constants as dc
from scheduling import hubs
from scheduling.greedy import (
    _band_rank_key,
    category_maps_for,
    is_not_scheduled_priority,
    project_counts_toward_year,
    run_greedy_sgs,
)
from scheduling.types import (
    LAB_CONSUMPTION_PER_PROJECT_WEEK,
    PLAN_WEEK_MAX,
    PLAN_WEEK_MIN,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
    StepTimingInput,
)
from scheduling.workflow import (
    STATUS_BLOCKED,
    STATUS_DONE,
    STATUS_IN_PROGRESS,
    STATUS_NOT_STARTED,
    CategoryMaps,
    ProjectPlan,
    Workflow,
    analyse_project,
    build_lead_time_table,
    build_workflows,
    compute_progress_pct,
    first_step_frontier,
    leader_fte_of,
    step_gate,
    unconstrained_end_week,
)

# --- Violation record --------------------------------------------------------


@dataclass(frozen=True)
class InvariantViolation:
    """One concrete failure of one of Invariants I1-I17, I21-I22, I25-I30, I35, I37."""

    invariant: str
    description: str
    project_id: str | None = None
    step_id: str | None = None
    engineer_id: str | None = None
    chamber_id: str | None = None
    hub: str | None = None
    week: int | None = None


# --- Shared context -----------------------------------------------------------


@dataclass(frozen=True)
class _Ctx:
    schedule_input: ScheduleInput
    schedule_output: ScheduleOutput
    projects: dict[str, ProjectInput]
    outcomes: dict[str, ProjectScheduleOutcome]
    plans: dict[str, ProjectPlan]  # only for schedulable projects that analyse cleanly
    # The validated inputs, for checks that must not lean on `analyse_project`
    # (ADR 0041 R5: I5 derives "skipped" from the inputs itself).
    workflows: Mapping[str, Workflow]
    lead_time_table: Mapping[tuple[str, str, str], int]
    # R33-8: the validated category list (None when invalid: I30 reports it).
    categories: CategoryMaps | None = None
    # ADR 0054 (I45): per project, `step_id -> (ms, me)` of the pins the run
    # must place (`_input_pinned_steps`). Empty without pins.
    pins: Mapping[str, Mapping[str, tuple[int, int]]] = field(default_factory=dict)

    def plan(self, project_id: str) -> ProjectPlan | None:
        return self.plans.get(project_id)

    def is_fixed(self, project_id: str, step_id: str) -> bool:
        """A placement the scheduler may never move: any step of a frozen
        project, an anchored (Done / In Progress / Blocked) step, or (ADR
        0054) a step placed on a manual pin."""

        project = self.projects.get(project_id)
        if project is None:
            return False
        if project.frozen:
            return True
        plan = self.plans.get(project_id)
        if plan is None:
            return False
        sp = plan.steps.get(step_id)
        return bool(sp is not None and sp.anchored) or self.is_pinned(project_id, step_id)

    def pinned_ids(self, project_id: str) -> frozenset[str]:
        """ADR 0054 (I45): the steps of `project_id` the run must place on a
        pin, derived from the **input** (`_input_pinned_steps`), never from
        the rows' `pinned` flag."""

        return frozenset(self.pins.get(project_id, ()))

    def is_pinned(self, project_id: str, step_id: str) -> bool:
        found = self.pins.get(project_id)
        return found is not None and step_id in found

    def books_nothing(self, project_id: str, step: StepSchedule) -> bool:
        """Rows that legitimately carry no resource: skipped, held (Blocked
        hold), or an anchored step with `remaining == 0`."""

        if step.skipped:
            return True
        plan = self.plans.get(project_id)
        if plan is None:
            return False
        if step.step_id in plan.held_step_ids:
            return True
        sp = plan.steps.get(step.step_id)
        return bool(
            sp is not None and sp.anchored and sp.status != STATUS_DONE and sp.remaining_span == 0
        )

    def effective_weeks(self, project_id: str, step: StepSchedule) -> range:
        """Weeks a row actually consumes: the full span for a frozen project;
        for anything else only weeks >= CURRENT_WEEK (DOMAIN_RULES.md:
        capacity is only tracked for weeks >= CURRENT_WEEK)."""

        if self.books_nothing(project_id, step):
            return range(0)
        project = self.projects.get(project_id)
        if project is not None and project.frozen:
            return range(step.start_week, step.end_week + 1)
        start = step.start_week
        plan = self.plans.get(project_id)
        sp = plan.steps.get(step.step_id) if plan is not None else None
        if (
            sp is not None
            and sp.status in (STATUS_IN_PROGRESS, STATUS_BLOCKED)
            and sp.remaining_span
        ):
            # The row is shown from actual_start_week, but only the tail
            # `[end - remaining_span + 1 .. end]` is booked (DOMAIN_RULES
            # progress; ADR 0032 stretches a design tail by the leader's FTE).
            start = max(start, step.end_week - sp.remaining_span + 1)
        return range(max(start, self.schedule_input.current_week), step.end_week + 1)

    def is_scheduled(self, outcome: ProjectScheduleOutcome) -> bool:
        """Neither excluded, left_out, data-error nor held by a Blocked stage."""

        if outcome.excluded or outcome.left_out or outcome.data_error is not None:
            return False
        plan = self.plans.get(outcome.project_id)
        if plan is not None:
            return not plan.held_step_ids
        return not outcome.blocked


def _build_ctx(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> tuple[_Ctx, list[InvariantViolation]]:
    violations: list[InvariantViolation] = []
    projects = {p.project_id: p for p in schedule_input.projects}
    outcomes = {o.project_id: o for o in schedule_output.project_outcomes}
    plans: dict[str, ProjectPlan] = {}

    try:
        workflows = build_workflows(schedule_input.workflow_steps)
    except ValueError as exc:
        violations.append(
            InvariantViolation(
                invariant="I15", description=f"workflow precedence graph is invalid: {exc}"
            )
        )
        workflows = {}
    try:
        table = build_lead_time_table(schedule_input.lead_times)
    except ValueError as exc:
        violations.append(
            InvariantViolation(invariant="I6", description=f"lead-time table invalid: {exc}")
        )
        table = {}

    categories: CategoryMaps | None
    try:
        categories = category_maps_for(schedule_input, workflows)
    except ValueError as exc:
        violations.append(
            InvariantViolation(invariant="I30", description=f"category list invalid: {exc}")
        )
        categories = None

    fte_by_engineer = {e.engineer_id: e.fte for e in schedule_input.engineers}
    for project in sorted(schedule_input.projects, key=lambda p: p.project_id):
        if project.status not in dc.SCHEDULABLE_STATUS_ORDER:
            continue
        if is_not_scheduled_priority(project):
            continue  # ADR 0056 R42-3: never scheduled, so nothing to analyse (I49)
        wf = workflows.get(project.workflow_id)
        if wf is None or project.category is None:
            continue
        if any((project.workflow_id, project.category, s.step_id) not in table for s in wf.steps):
            continue
        if project.frozen and project.actual_start_week is None:
            continue
        plans[project.project_id] = analyse_project(
            project, wf, table, leader_fte=leader_fte_of(project, fte_by_engineer)
        )

    ctx = _Ctx(
        schedule_input, schedule_output, projects, outcomes, plans, workflows, table, categories
    )
    pins = {
        pid: found
        for pid in sorted(plans)
        if (found := _input_pinned_steps(ctx, projects[pid], plans[pid]))
    }
    if pins:
        ctx = replace(ctx, pins=pins)
    return ctx, violations


def _input_pinned_steps(
    ctx: _Ctx, project: ProjectInput, plan: ProjectPlan
) -> dict[str, tuple[int, int]]:
    """ADR 0054 / I45, from the input rows (independently of
    `analyse_project`'s pin filter): the first pin per step (sorted), on a
    step that is not skipped by the inputs (`_input_says_skipped`), not in a
    Blocked hold, and (for a non-frozen project) whose input stage is Not
    Started (no progress row = Not Started). `(ms, me)` as given."""

    if not project.step_pins:
        return {}
    stage: dict[str, str] = {}
    for pr in project.step_progress:
        stage.setdefault(pr.step_id, pr.status)
    out: dict[str, tuple[int, int]] = {}
    for pin in sorted(project.step_pins, key=lambda r: (r.step_id, repr(r.start_week))):
        sid = pin.step_id
        if sid in out or _input_says_skipped(ctx, project, sid) is not False:
            continue
        if sid in plan.held_step_ids:
            continue
        if not project.frozen and stage.get(sid, STATUS_NOT_STARTED) != STATUS_NOT_STARTED:
            continue
        out[sid] = (pin.start_week, pin.end_week)
    return out


# --- Public entry point -------------------------------------------------------


def validate_invariants(
    schedule_input: ScheduleInput,
    schedule_output: ScheduleOutput,
    *,
    check_determinism: bool = True,
    live_state: bool = False,
    run_week: int | None = None,
) -> tuple[InvariantViolation, ...]:
    """Run every assertable invariant check and return every violation found,
    in a fixed, deterministic order. `check_determinism=False` skips I8 (which
    re-runs `run_greedy_sgs` on `schedule_input` twice internally).
    `live_state=True` (ADR 0050, R36-9) also runs I37b, which holds only on an
    input built from the live DB (never on What-if / import inputs, whose
    added or re-banded projects are legitimately unranked), and I41 on the
    input week (P37). `run_week` (P37, I38) is the stored
    `ScheduleRun.current_week` of the run this output was persisted as; when
    given, I38 (it equals the input week) and I41 (it is in 1..52) run."""

    violations_pre: list[InvariantViolation] = []
    if run_week is not None:
        violations_pre.extend(check_i38_run_week(schedule_input, run_week))
    elif live_state:
        violations_pre.extend(check_i41_week_domain(schedule_input.current_week))
    ctx, violations = _build_ctx(schedule_input, schedule_output)
    violations[:0] = violations_pre
    violations.extend(_check_i1_engineer_conflicts(ctx))
    violations.extend(_check_i2_chamber_overlap(ctx))
    violations.extend(_check_i3_precedence(ctx, tag="I3"))
    violations.extend(_check_i4_lab_chamber_eligibility(ctx))
    violations.extend(_check_i5_complete_or_left_out(ctx))
    violations.extend(_check_i6_design_load(ctx))
    violations.extend(_check_i7_lab_load(ctx))
    if check_determinism:
        violations.extend(check_scheduler_determinism(schedule_input))
        violations.extend(check_wait_invariance(schedule_input))
        violations.extend(check_pin_load_neutrality(schedule_input))
        violations.extend(check_band_neutrality(schedule_input))
    violations.extend(_check_i9_within_year_derivation(ctx))
    violations.extend(_check_i10_frozen_dates_immutable(ctx))
    violations.extend(_check_i11_done_stages_immutable(ctx))
    violations.extend(_check_i12_progress_pct(ctx))
    violations.extend(_check_i15_dag(ctx))
    violations.extend(_check_i16_completion_lines(ctx))
    violations.extend(_check_i21_effective_duration_span(ctx))
    violations.extend(_check_i22_start_not_before(ctx))
    violations.extend(_check_i26_recorded_work_not_zeroed(ctx))
    violations.extend(_check_i27_overlap_gate(ctx))
    violations.extend(_check_i28_wait_gate(ctx))
    violations.extend(_check_i29_duration_from_input(ctx))
    violations.extend(_check_i30_category_order(ctx))
    violations.extend(_check_i37a_band_rank_order(ctx))
    if live_state:
        violations.extend(check_i37b_band_ranks_dense(schedule_input.projects))
    violations.extend(_check_i35_no_empty_project(ctx))
    violations.extend(_check_i45_pins_placed(ctx))
    violations.extend(_check_i47a_manual_overlap(ctx))
    violations.extend(_check_i49_band_exclusion(ctx))
    violations.extend(_check_i51_tier_order(ctx))
    return tuple(violations)


# --- I38 / I41: the week a run is solved at (P37, ADR 0052) -------------------


def check_i41_week_domain(week: object) -> list[InvariantViolation]:
    """I41: `1 <= week <= 52` (`PLAN_WEEK_MIN..PLAN_WEEK_MAX`), an int and
    not a bool. Returns the violation instead of raising (validator style);
    `scheduling.types.require_plan_week` is the raising form."""

    if isinstance(week, bool) or not isinstance(week, int):
        return [InvariantViolation("I41", f"week {week!r} is not an int")]
    if not PLAN_WEEK_MIN <= week <= PLAN_WEEK_MAX:
        return [
            InvariantViolation(
                "I41", f"week {week} is outside {PLAN_WEEK_MIN}..{PLAN_WEEK_MAX}", week=week
            )
        ]
    return []


def check_i38_run_week(schedule_input: ScheduleInput, run_week: object) -> list[InvariantViolation]:
    """I38: a `ScheduleRun` stores `current_week` equal to its input's
    `current_week`, and that week is a plan week (I41). `run_week` is the
    stored row's value; `schedule_input` the input the run was solved with
    (as rebuilt from the row by the caller). Every outcome of the pure
    solvers is computed at `schedule_input.current_week` (the only week they
    read), so equality here is the whole of I38 the engine can assert; the
    "read once at row creation" half is service-side (P37-T04)."""

    violations = check_i41_week_domain(run_week)
    if run_week != schedule_input.current_week:
        violations.append(
            InvariantViolation(
                "I38",
                f"run stores week {run_week!r} but its input was solved at week "
                f"{schedule_input.current_week}",
                week=run_week if isinstance(run_week, int) else None,
            )
        )
    return violations


# --- I1: engineer double-booking -------------------------------------------


def _check_i1_engineer_conflicts(ctx: _Ctx) -> list[InvariantViolation]:
    """I1: No engineer is assigned two design steps in the same week — unless
    one of the two placements is fixed (frozen project, or an anchored Done /
    In Progress step), in which case `ENG_CONFLICT` must be raised on at
    least one of the two projects."""

    violations: list[InvariantViolation] = []
    bookings: dict[str, list[tuple[str, str, int, int]]] = defaultdict(list)
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        for step in outcome.steps:
            if step.kind != "design" or step.assigned_engineer_id is None:
                continue
            weeks = ctx.effective_weeks(outcome.project_id, step)
            if len(weeks) == 0:
                continue
            bookings[step.assigned_engineer_id].append(
                (outcome.project_id, step.step_id, weeks.start, weeks.stop - 1)
            )

    for engineer_id in sorted(bookings):
        entries = sorted(bookings[engineer_id])
        for i in range(len(entries)):
            pid_a, sid_a, start_a, end_a = entries[i]
            for j in range(i + 1, len(entries)):
                pid_b, sid_b, start_b, end_b = entries[j]
                if not (start_a <= end_b and start_b <= end_a):
                    continue
                if pid_a == pid_b:
                    # ADR 0054 (I1 amended, I47(d)): two fixed design placements
                    # of one project sharing a week need ENG_CONFLICT when one
                    # of them is a pin; otherwise one project's own steps are
                    # not I1's concern (unchanged).
                    if not (ctx.is_pinned(pid_a, sid_a) or ctx.is_pinned(pid_b, sid_b)):
                        continue
                    if not (ctx.outcomes.get(pid_a) and ctx.outcomes[pid_a].eng_conflict):
                        violations.append(
                            InvariantViolation(
                                invariant="I1",
                                description=(
                                    f"engineer {engineer_id!r} is booked twice by project "
                                    f"{pid_a!r} ({sid_a} [{start_a},{end_a}] and {sid_b} "
                                    f"[{start_b},{end_b}]), a manual pin is involved, but the "
                                    "outcome has eng_conflict=False (ADR 0054, F4)"
                                ),
                                project_id=pid_a,
                                engineer_id=engineer_id,
                            )
                        )
                    continue
                fixed = ctx.is_fixed(pid_a, sid_a) or ctx.is_fixed(pid_b, sid_b)
                if not fixed:
                    violations.append(
                        InvariantViolation(
                            invariant="I1",
                            description=(
                                f"engineer {engineer_id!r} double-booked between projects "
                                f"{pid_a!r}/{sid_a} and {pid_b!r}/{sid_b} (weeks "
                                f"[{start_a},{end_a}] and [{start_b},{end_b}]) — neither "
                                "placement is fixed, so this "
                                "should never happen"
                            ),
                            project_id=pid_a,
                            engineer_id=engineer_id,
                        )
                    )
                    continue
                a_flag = bool(ctx.outcomes.get(pid_a) and ctx.outcomes[pid_a].eng_conflict)
                b_flag = bool(ctx.outcomes.get(pid_b) and ctx.outcomes[pid_b].eng_conflict)
                if not (a_flag or b_flag):
                    violations.append(
                        InvariantViolation(
                            invariant="I1",
                            description=(
                                f"engineer {engineer_id!r} double-booked between projects "
                                f"{pid_a!r} and {pid_b!r} (weeks [{start_a},{end_a}] and "
                                f"[{start_b},{end_b}]), a fixed placement is involved, but neither "
                                "project's outcome has eng_conflict=True"
                            ),
                            project_id=pid_a,
                            engineer_id=engineer_id,
                        )
                    )
    return violations


# --- I2: chamber over-capacity ------------------------------------------------


def _check_i2_chamber_overlap(ctx: _Ctx) -> list[InvariantViolation]:
    """I2: No chamber exceeds `max_concurrent` projects in any week — unless a
    fixed placement contributes, then `OVERLAP` must be raised on one of the
    fixed contributors."""

    violations: list[InvariantViolation] = []
    max_by_chamber = {c.chamber_id: c.max_concurrent for c in ctx.schedule_input.chambers}
    usage: dict[str, dict[int, list[tuple[str, str]]]] = defaultdict(lambda: defaultdict(list))
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        for step in outcome.steps:
            if step.kind != "lab" or step.assigned_chamber_id is None:
                continue
            for wk in ctx.effective_weeks(outcome.project_id, step):
                usage[step.assigned_chamber_id][wk].append((outcome.project_id, step.step_id))

    for chamber_id in sorted(usage):
        max_concurrent = max_by_chamber.get(chamber_id)
        if max_concurrent is None:
            continue  # unknown chamber: reported by I4
        for wk in sorted(usage[chamber_id]):
            entries = usage[chamber_id][wk]
            if len(entries) <= max_concurrent:
                continue
            fixed_ids = sorted({pid for pid, sid in entries if ctx.is_fixed(pid, sid)})
            if not fixed_ids:
                violations.append(
                    InvariantViolation(
                        invariant="I2",
                        description=(
                            f"chamber {chamber_id!r} exceeds max_concurrent={max_concurrent} in "
                            f"week {wk} ({len(entries)} projects: {sorted(p for p, _ in entries)}) "
                            "but no contributing placement is fixed — this should never happen"
                        ),
                        chamber_id=chamber_id,
                        week=wk,
                    )
                )
                continue
            if not any(ctx.outcomes.get(pid) and ctx.outcomes[pid].overlap for pid in fixed_ids):
                violations.append(
                    InvariantViolation(
                        invariant="I2",
                        description=(
                            f"chamber {chamber_id!r} exceeds max_concurrent={max_concurrent} in "
                            f"week {wk}, fixed placements involved ({fixed_ids}), but none of "
                            "their outcomes has overlap=True"
                        ),
                        chamber_id=chamber_id,
                        week=wk,
                    )
                )
    violations.extend(_check_i2_anchored_room(ctx, usage, max_by_chamber))
    return violations


def _check_i2_anchored_room(
    ctx: _Ctx,
    usage: dict[str, dict[int, list[tuple[str, str]]]],
    max_by_chamber: dict[str, int],
) -> list[InvariantViolation]:
    """I2 per DOMAIN_RULES "Gate remediation rulings" #1: an anchored (non-
    frozen Done / In Progress) or (ADR 0054, I47(d)) pinned (any project)
    lab step that sits in an over-capacity chamber
    week is a violation if another eligible chamber (lab region + allowed
    stage) had room for every week it consumes. Usage only grows during a run,
    so room in the final output proves room at booking time; the check never
    raises a false positive."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        project = ctx.projects.get(outcome.project_id)
        if project is None or project.hub not in hubs.HUB_LAB_REGION:
            continue
        if project.frozen and not ctx.pinned_ids(outcome.project_id):
            continue
        region = hubs.HUB_LAB_REGION[project.hub]
        for step in outcome.steps:
            chamber_id = step.assigned_chamber_id
            if step.kind != "lab" or chamber_id is None:
                continue
            if project.frozen and not ctx.is_pinned(outcome.project_id, step.step_id):
                continue  # ADR 0054 (I47(d)): of a frozen project, only pins
            if not ctx.is_fixed(outcome.project_id, step.step_id):
                continue
            weeks = ctx.effective_weeks(outcome.project_id, step)
            cap = max_by_chamber.get(chamber_id)
            if cap is None or not any(len(usage[chamber_id][wk]) > cap for wk in weeks):
                continue
            roomy = [
                c.chamber_id
                for c in sorted(ctx.schedule_input.chambers, key=lambda c: c.chamber_id)
                if c.chamber_id != chamber_id
                and c.lab_region == region
                and step.step_id in c.allowed_stages
                and all(len(usage[c.chamber_id][wk]) < c.max_concurrent for wk in weeks)
            ]
            if roomy:
                violations.append(
                    InvariantViolation(
                        invariant="I2",
                        description=(
                            f"anchored lab step {outcome.project_id!r}/{step.step_id} overbooks "
                            f"chamber {chamber_id!r} (weeks {weeks.start}..{weeks.stop - 1}) "
                            f"although eligible chamber {roomy[0]!r} had room (ruling 1)"
                        ),
                        project_id=outcome.project_id,
                        chamber_id=chamber_id,
                        week=weeks.start,
                    )
                )
    return violations


# --- I3 / I15: precedence over the DAG ----------------------------------------


def _check_i3_precedence(ctx: _Ctx, *, tag: str) -> list[InvariantViolation]:
    """I3 (revised, ADR 0009): every non-skipped step starts after all of its
    predecessors end (`start >= max(pred.end) + 1`). A skipped step is
    transparent (`start == end == max(pred.end)`). Anchored steps (their
    start is recorded history) and held steps (a Blocked hold) are exempt as
    successors. With no plan available (unknown project / workflow) the check
    falls back to consecutive `sequence_order` pairs — the seeded strict
    chain."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        by_id = {s.step_id: s for s in outcome.steps}
        for step in sorted(outcome.steps, key=lambda s: (s.sequence_order, s.step_id)):
            if step.start_week > step.end_week:
                violations.append(
                    InvariantViolation(
                        invariant=tag,
                        description=(
                            f"project {pid!r} step {step.step_id!r} has start_week="
                            f"{step.start_week} > end_week={step.end_week} (degenerate step)"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
        plan = ctx.plan(pid)
        if plan is None:
            ordered = sorted(outcome.steps, key=lambda s: (s.sequence_order, s.step_id))
            for prev, cur in zip(ordered, ordered[1:]):  # noqa: B905
                if cur.skipped:
                    continue
                if cur.start_week < prev.end_week + 1:
                    violations.append(_precedence_violation(tag, pid, cur, prev))
            continue
        for step in sorted(outcome.steps, key=lambda s: (s.sequence_order, s.step_id)):
            if (
                step.skipped
                or step.step_id in plan.held_step_ids
                or ctx.is_fixed(pid, step.step_id)
            ):
                continue
            template = plan.workflow.steps_by_id.get(step.step_id)
            if template is None:
                continue  # reported by I15
            sp = plan.steps.get(step.step_id)
            if sp is not None and sp.overlap_weeks > 0:
                continue  # ADR 0043: an overlapping step is I27's to check
            g = None
            for pred_id in sorted(template.predecessor_ids):
                pred = by_id.get(pred_id)
                if pred is None:
                    continue  # reported by I5
                pred_sp = plan.steps.get(pred_id)
                release_g = pred.end_week
                if (
                    pred_sp is not None
                    and not pred_sp.skipped
                    and (pred_sp.overlap_weeks > 0 or ctx.is_pinned(pid, pred_id))
                ):
                    # ADR 0054 (I47(b)): a pinned predecessor passes on
                    # G = max(end, release) too.
                    # ADR 0043: an overlapping predecessor passes its own
                    # predecessors' end on (G); its own end alone is not enough.
                    if g is None:
                        g = _row_releases(ctx, plan, outcome)[0]
                    release_g = g.get(pred_id, pred.end_week)
                if step.start_week < release_g + 1:
                    violations.append(_precedence_violation(tag, pid, step, pred, release_g))
    return violations


def _precedence_violation(
    tag: str, pid: str, cur: StepSchedule, prev: StepSchedule, release_g: int | None = None
) -> InvariantViolation:
    # A pinned predecessor's G (ADR 0054) is reported with the overlap wording.
    if release_g is None or release_g == prev.end_week:
        description = (
            f"project {pid!r}: step {cur.step_id!r} (start_week={cur.start_week}) starts "
            f"before predecessor {prev.step_id!r} (end_week={prev.end_week}) has ended — "
            f"requires start >= {prev.end_week + 1}"
        )
    else:
        description = (
            f"project {pid!r}: step {cur.step_id!r} (start_week={cur.start_week}) starts "
            f"before the work predecessor {prev.step_id!r} passes on (it overlapped its own "
            f"predecessors; release G={release_g}) has ended — requires start >= "
            f"{release_g + 1}"
        )
    return InvariantViolation(
        invariant=tag,
        description=description,
        project_id=pid,
        step_id=cur.step_id,
    )


def _row_releases(
    ctx: _Ctx, plan: ProjectPlan, outcome: ProjectScheduleOutcome
) -> tuple[dict[str, int], dict[str, int], dict[str, StepSchedule]]:
    """ADR 0043 `G(q)` and `release(s)` recomputed from the *output rows*
    (contract P32 A2), in walk order: `G(q)` is a skipped row's emitted week,
    a row's end with no overlap, and `max(end, release(q))` with one.
    `release(s)` is `max(G(q) for q in P(s))` (`frontier - 1` with none).
    A step whose predecessors' `G` is unknown (a row missing — I5's to report)
    gets no entry. Returns `(g, release, rows_by_step_id)`. ADR 0054 (I47):
    a step the input pins passes on `max(end, release)` as well."""

    pinned = ctx.pinned_ids(outcome.project_id)
    by_id = {s.step_id: s for s in outcome.steps}
    frontier = first_step_frontier(plan.project, ctx.schedule_input.current_week)
    g: dict[str, int] = {}
    release: dict[str, int] = {}
    for sid in plan.workflow.walk_order:
        sp = plan.steps[sid]
        preds = sp.step.predecessor_ids
        if all(p in g for p in preds):
            release[sid] = max((g[p] for p in preds), default=frontier - 1)
        row = by_id.get(sid)
        if row is None:
            continue
        if row.skipped or sp.skipped or (sp.overlap_weeks == 0 and sid not in pinned):
            g[sid] = row.end_week
        elif sid in release:
            g[sid] = max(row.end_week, release[sid])
    return g, release, by_id


def _row_gate(
    ctx: _Ctx,
    plan: ProjectPlan,
    step_id: str,
    release: dict[str, int],
    by_id: dict[str, StepSchedule],
) -> int | None:
    """`gate(s)` from the output rows (`workflow.step_gate`); `None` when the
    release or a start-anchor row is unknown."""

    sp = plan.steps[step_id]
    if step_id not in release:
        return None
    anchors = plan.start_anchor_ids(step_id) if sp.overlap_weeks else ()
    if any(r not in by_id for r in anchors):
        return None
    frontier = first_step_frontier(plan.project, ctx.schedule_input.current_week)
    return step_gate(sp, release[step_id], (by_id[r].start_week for r in anchors), frontier)


def _check_i15_dag(ctx: _Ctx) -> list[InvariantViolation]:
    """I15: the precedence graph is acyclic (checked in `_build_ctx`), every
    step row belongs to the project's workflow, and every run respects the
    DAG (I3 stated over the DAG — deliberately reported under both tags)."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        plan = ctx.plan(outcome.project_id)
        if plan is None:
            continue
        for step in sorted(outcome.steps, key=lambda s: (s.sequence_order, s.step_id)):
            if step.step_id not in plan.workflow.steps_by_id:
                violations.append(
                    InvariantViolation(
                        invariant="I15",
                        description=(
                            f"project {outcome.project_id!r} (workflow "
                            f"{plan.workflow.workflow_id!r}) has a step row {step.step_id!r} "
                            "that is not a step of its workflow"
                        ),
                        project_id=outcome.project_id,
                        step_id=step.step_id,
                    )
                )
    violations.extend(_check_i3_precedence(ctx, tag="I15"))
    return violations


# --- I4: lab step / chamber eligibility ----------------------------------------


def _check_i4_lab_chamber_eligibility(ctx: _Ctx) -> list[InvariantViolation]:
    """I4: A lab step is only ever booked to a chamber in the project's lab
    region whose `allowed_stages` contains that step."""

    violations: list[InvariantViolation] = []
    chambers = {c.chamber_id: c for c in ctx.schedule_input.chambers}
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        project = ctx.projects.get(pid)
        expected_region = hubs.HUB_LAB_REGION.get(project.hub) if project else None
        for step in outcome.steps:
            if step.kind != "lab" or ctx.books_nothing(pid, step):
                continue
            if step.assigned_chamber_id is None:
                violations.append(
                    InvariantViolation(
                        invariant="I4",
                        description=(
                            f"project {pid!r} lab step {step.step_id!r} is booked but has no "
                            "assigned_chamber_id"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
                continue
            chamber = chambers.get(step.assigned_chamber_id)
            if chamber is None:
                violations.append(
                    InvariantViolation(
                        invariant="I4",
                        description=(
                            f"project {pid!r} lab step {step.step_id!r} is booked to chamber_id "
                            f"{step.assigned_chamber_id!r}, not present in ScheduleInput.chambers"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                        chamber_id=step.assigned_chamber_id,
                    )
                )
                continue
            if project is None:
                continue
            if expected_region is not None and chamber.lab_region != expected_region:
                violations.append(
                    InvariantViolation(
                        invariant="I4",
                        description=(
                            f"project {pid!r} (hub {project.hub!r}, lab region "
                            f"{expected_region!r}) lab step {step.step_id!r} is booked to chamber "
                            f"{chamber.chamber_id!r} in lab region {chamber.lab_region!r}"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                        chamber_id=chamber.chamber_id,
                        hub=project.hub,
                    )
                )
            if step.step_id not in chamber.allowed_stages:
                violations.append(
                    InvariantViolation(
                        invariant="I4",
                        description=(
                            f"project {pid!r} lab step {step.step_id!r} is booked to chamber "
                            f"{chamber.chamber_id!r}, whose allowed_stages "
                            f"{chamber.allowed_stages} does not include {step.step_id!r}"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                        chamber_id=chamber.chamber_id,
                    )
                )
    return violations


# --- I5: complete schedule or LEFT_OUT --------------------------------------


def _input_override(project: ProjectInput, step_id: str) -> int | None:
    """The merged per-project duration the input carries for `step_id`
    (`StepTimingInput.duration_override_weeks`), read straight from the input
    rows: with duplicate rows (rejected before any run) the smallest value
    wins, a deterministic choice made without the scheduler's helpers."""

    rows: list[StepTimingInput] = [r for r in project.step_timing if r.step_id == step_id]
    values = sorted(
        (-1 if r.duration_override_weeks is None else r.duration_override_weeks) for r in rows
    )
    return None if not values or values[0] < 0 else values[0]


def _input_lead(ctx: _Ctx, project: ProjectInput, step_id: str) -> int | None:
    """R33-1, from the input rows only: the project's own `lead_weeks` for
    `step_id` (the smallest, with duplicate rows) `??` the input table.
    `None` when there is no table row (other checks report that)."""

    if project.category is None:
        return None
    table = ctx.lead_time_table.get((project.workflow_id, project.category, step_id))
    if table is None:
        return None
    own = sorted(
        r.lead_weeks
        for r in project.step_timing
        if r.step_id == step_id and r.lead_weeks is not None
    )
    return own[0] if own else table


def _input_eff(ctx: _Ctx, project: ProjectInput, step_id: str) -> int | None:
    """R33-1 `eff(p, s)` derived from the inputs only (never from
    `analyse_project`): 0 if `lead = 0` or a lab step with certification
    testing off, else `override ?? lead`, with `lead = lead_weeks ?? table`.
    `None` when the inputs cannot say (unknown workflow, step or lead-time
    row: other checks report those)."""

    wf = ctx.workflows.get(project.workflow_id)
    if wf is None or step_id not in wf.steps_by_id:
        return None
    lead = _input_lead(ctx, project, step_id)
    if lead is None:
        return None
    if lead == 0:
        return 0
    if wf.steps_by_id[step_id].kind == "lab" and not project.certification_testing_required:
        return 0
    override = _input_override(project, step_id)
    return lead if override is None else override


def _input_says_skipped(ctx: _Ctx, project: ProjectInput, step_id: str) -> bool | None:
    """ADR 0041 R5 / R33-1, derived from the inputs only: skipped ⟺ `eff = 0`
    (`lead_weeks ?? table` = 0, lab ∧ ¬certification, or a merged override
    of 0). `None` when the inputs cannot say."""

    eff = _input_eff(ctx, project, step_id)
    return None if eff is None else eff == 0


def _check_i5_complete_or_left_out(ctx: _Ctx) -> list[InvariantViolation]:
    """I5 (revised; ADR 0041 R5): every scheduled project has either a
    complete 14-step schedule — skipped steps present with `skipped=true`,
    zero duration, `start == end` and no resource; every other step with a
    positive duration — or `LEFT_OUT=true` (with an incomplete row set). A
    data-error project carries no rows. Whether a row should be skipped is
    derived from the **inputs** (lead time, kind, certification flag, merged
    override), independently of `analyse_project`."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        if outcome.excluded:
            continue
        project = ctx.projects.get(pid)
        workflow = ctx.workflows.get(project.workflow_id) if project is not None else None
        total = len(workflow.steps) if workflow else len(ctx.schedule_input.workflow_steps)
        if outcome.data_error is not None:
            if outcome.steps or outcome.left_out:
                violations.append(
                    InvariantViolation(
                        invariant="I5",
                        description=(
                            f"project {pid!r} was rejected as a data error but carries "
                            f"{len(outcome.steps)} step rows / left_out={outcome.left_out}"
                        ),
                        project_id=pid,
                    )
                )
            continue
        if outcome.left_out:
            if len(outcome.steps) >= total:
                violations.append(
                    InvariantViolation(
                        invariant="I5",
                        description=(
                            f"project {pid!r} has left_out=True but also a complete step count "
                            f"({len(outcome.steps)}/{total})"
                        ),
                        project_id=pid,
                    )
                )
            continue
        if len(outcome.steps) != total:
            violations.append(
                InvariantViolation(
                    invariant="I5",
                    description=(
                        f"project {pid!r} is not left_out and not excluded, but has "
                        f"{len(outcome.steps)}/{total} steps (expected a complete schedule)"
                    ),
                    project_id=pid,
                )
            )
            continue
        if project is None or workflow is None:
            continue
        ids = sorted(s.step_id for s in outcome.steps)
        if ids != sorted(workflow.steps_by_id):
            violations.append(
                InvariantViolation(
                    invariant="I5",
                    description=(
                        f"project {pid!r} step rows {ids} do not match its workflow's steps"
                    ),
                    project_id=pid,
                )
            )
            continue
        for step in sorted(outcome.steps, key=lambda s: s.sequence_order):
            expected = _input_says_skipped(ctx, project, step.step_id)
            if expected is not None and step.skipped != expected:
                violations.append(
                    InvariantViolation(
                        invariant="I5",
                        description=(
                            f"project {pid!r} step {step.step_id!r}: skipped={step.skipped} but "
                            "the inputs (lead time / certification flag / merged override) say "
                            f"skipped={expected}"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
            if step.skipped and (
                step.duration_weeks != 0
                or step.start_week != step.end_week
                or step.assigned_engineer_id is not None
                or step.assigned_chamber_id is not None
            ):
                violations.append(
                    InvariantViolation(
                        invariant="I5",
                        description=(
                            f"project {pid!r} skipped step {step.step_id!r} must have zero "
                            "duration, start == end and no resource"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
            if not step.skipped and (step.duration_weeks < 1 or step.end_week < step.start_week):
                violations.append(
                    InvariantViolation(
                        invariant="I5",
                        description=(
                            f"project {pid!r} step {step.step_id!r} is not skipped but has "
                            f"duration_weeks={step.duration_weeks}, weeks "
                            f"{step.start_week}..{step.end_week} (a 0-week step must be "
                            "skipped, ADR 0041 R5)"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
    return violations


# --- I6 / I7: hub load aggregates ---------------------------------------------


def compute_design_load_by_hub(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> dict[str, int]:
    """I6: Σ `design`-kind step `duration_weeks` per project hub (elapsed and
    skipped steps contribute 0). These are effort weeks, never the
    FTE-stretched elapsed span (ADR 0032), so they compare with the supply
    `working_weeks × Σ fte` (ADR 0008)."""

    projects = {p.project_id: p for p in schedule_input.projects}
    load: dict[str, int] = defaultdict(int)
    for outcome in schedule_output.project_outcomes:
        project = projects.get(outcome.project_id)
        if project is None or project.hub not in hubs.HUB_LAB_REGION:
            continue
        for step in outcome.steps:
            if step.kind == "design" and not step.skipped:
                load[project.hub] += step.duration_weeks
    return dict(load)


def compute_design_load_by_capacity_hub(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> dict[str, int]:
    """ADR 0042 §3: Σ `design`-kind step `duration_weeks` per **capacity hub**
    — every project whose `capacity_hub` resolves to it (its own projects plus
    its member hubs' projects; the OEM hubs' load lands on R&D-Greece). Same
    rows and same grand total as `compute_design_load_by_hub` (I6), regrouped;
    this is the figure the Capacity surface's capacity-hub row shows, the
    per-hub one is its `members` breakdown."""

    projects = {p.project_id: p for p in schedule_input.projects}
    load: dict[str, int] = defaultdict(int)
    for outcome in schedule_output.project_outcomes:
        project = projects.get(outcome.project_id)
        if project is None or project.hub not in hubs.HUB_LAB_REGION:
            continue
        for step in outcome.steps:
            if step.kind == "design" and not step.skipped:
                load[project.capacity_hub] += step.duration_weeks
    return dict(load)


@dataclass(frozen=True)
class CrossCapacityHubLeader:
    """One project whose assigned leader sits outside its capacity hub
    (diagnostic, not a violation — see the module docstring)."""

    project_id: str
    hub: str
    capacity_hub: str
    engineer_id: str
    engineer_hub: str


def cross_capacity_hub_leaders(schedule_input: ScheduleInput) -> tuple[CrossCapacityHubLeader, ...]:
    """ADR 0042 diagnostic: schedulable projects whose `leader_engineer_id`
    resolves to an engineer with `hub != project.capacity_hub`. Sorted by
    `project_id`. Unset / unknown leaders are not listed (they are `no_leader`
    outcomes, not pool questions)."""

    engineers = {e.engineer_id: e for e in schedule_input.engineers}
    out: list[CrossCapacityHubLeader] = []
    for project in sorted(schedule_input.projects, key=lambda p: p.project_id):
        if project.status not in dc.SCHEDULABLE_STATUS_ORDER or project.leader_engineer_id is None:
            continue
        engineer = engineers.get(project.leader_engineer_id)
        if engineer is None or engineer.hub == project.capacity_hub:
            continue
        out.append(
            CrossCapacityHubLeader(
                project_id=project.project_id,
                hub=project.hub,
                capacity_hub=project.capacity_hub,
                engineer_id=engineer.engineer_id,
                engineer_hub=engineer.hub,
            )
        )
    return tuple(out)


def compute_lab_load_by_hub(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> dict[str, float]:
    """I7: Σ `lab`-kind step `duration_weeks` × 1.0 per project hub (ADR 0007).
    Aggregate per lab region with `domain_constants.HUB_LAB_REGION`."""

    projects = {p.project_id: p for p in schedule_input.projects}
    load: dict[str, float] = defaultdict(float)
    for outcome in schedule_output.project_outcomes:
        project = projects.get(outcome.project_id)
        if project is None or project.hub not in hubs.HUB_LAB_REGION:
            continue
        for step in outcome.steps:
            if step.kind == "lab" and not step.skipped:
                load[project.hub] += step.duration_weeks * LAB_CONSUMPTION_PER_PROJECT_WEEK
    return dict(load)


def _check_durations_match_table(ctx: _Ctx, kind: str, tag: str) -> list[InvariantViolation]:
    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        plan = ctx.plan(pid)
        for step in outcome.steps:
            if step.kind != kind:
                continue
            if step.duration_weeks < 0:
                violations.append(
                    InvariantViolation(
                        invariant=tag,
                        description=(
                            f"project {pid!r} {kind} step {step.step_id!r} has negative "
                            f"duration_weeks={step.duration_weeks}"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
                continue
            if plan is None or step.step_id not in plan.steps:
                continue
            expected = plan.steps[step.step_id].duration
            if step.duration_weeks != expected:
                violations.append(
                    InvariantViolation(
                        invariant=tag,
                        description=(
                            f"project {pid!r} {kind} step {step.step_id!r} has duration_weeks="
                            f"{step.duration_weeks} but its effective duration (override or "
                            f"lead time) is {expected} — the load aggregate would not reconcile "
                            "with the Capacity surface"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
    return violations


def _check_i6_design_load(ctx: _Ctx) -> list[InvariantViolation]:
    """I6: per-hub design load is computable, each design row's duration is the
    lead-time-table value, and the per-hub breakdown sums to an independently
    computed grand total."""

    violations = _check_durations_match_table(ctx, "design", "I6")
    per_hub = compute_design_load_by_hub(ctx.schedule_input, ctx.schedule_output)
    grand = 0
    for project in sorted(ctx.schedule_input.projects, key=lambda p: p.project_id):
        outcome = ctx.outcomes.get(project.project_id)
        if outcome is None or project.hub not in hubs.HUB_LAB_REGION:
            continue
        grand += sum(
            s.duration_weeks for s in outcome.steps if s.kind == "design" and not s.skipped
        )
    if sum(per_hub.values()) != grand:
        violations.append(
            InvariantViolation(
                invariant="I6",
                description=(
                    f"design load per-hub breakdown sums to {sum(per_hub.values())}, but an "
                    f"independently-computed grand total is {grand}"
                ),
            )
        )
    return violations


def _check_i7_lab_load(ctx: _Ctx) -> list[InvariantViolation]:
    """I7: same shape as I6 for `lab`-kind rows at 1.0 platform-week per project-week."""

    violations = _check_durations_match_table(ctx, "lab", "I7")
    per_hub = compute_lab_load_by_hub(ctx.schedule_input, ctx.schedule_output)
    grand = 0.0
    for project in sorted(ctx.schedule_input.projects, key=lambda p: p.project_id):
        outcome = ctx.outcomes.get(project.project_id)
        if outcome is None or project.hub not in hubs.HUB_LAB_REGION:
            continue
        grand += sum(
            s.duration_weeks * LAB_CONSUMPTION_PER_PROJECT_WEEK
            for s in outcome.steps
            if s.kind == "lab" and not s.skipped
        )
    if sum(per_hub.values()) != grand:
        violations.append(
            InvariantViolation(
                invariant="I7",
                description=(
                    f"lab load per-hub breakdown sums to {sum(per_hub.values())}, but an "
                    f"independently-computed grand total is {grand}"
                ),
            )
        )
    return violations


# --- I8: determinism ----------------------------------------------------------


def check_scheduler_determinism(
    schedule_input: ScheduleInput, *, runs: int = 2
) -> tuple[InvariantViolation, ...]:
    """I8: Re-running the greedy scheduler on identical input produces
    byte-identical output. Precedence, lead times, workflow ids, progress
    rows and the new project fields are all part of the dataclass input, so a
    re-run exercises exactly the same data."""

    if runs < 2:
        raise ValueError("check_scheduler_determinism requires runs >= 2 to compare anything")

    outputs = [run_greedy_sgs(schedule_input) for _ in range(runs)]
    first = outputs[0]
    violations: list[InvariantViolation] = []
    for i, out in enumerate(outputs[1:], start=2):
        if out != first:
            violations.append(
                InvariantViolation(
                    invariant="I8",
                    description=(
                        f"run {i} of {runs} on identical ScheduleInput produced a structurally "
                        "different ScheduleOutput than run 1 — determinism violated"
                    ),
                )
            )
        elif repr(out) != repr(first):
            violations.append(
                InvariantViolation(
                    invariant="I8",
                    description=(
                        f"run {i} of {runs} is structurally equal (==) to run 1 but not "
                        "byte-identical via repr() — determinism violated"
                    ),
                )
            )
    return tuple(violations)


# --- I9: within_year re-derivation --------------------------------------------


def _check_i9_within_year_derivation(ctx: _Ctx) -> list[InvariantViolation]:
    """I9 as amended by I50 (ADR 0056, R42-4 / R42-9): `counts_toward_year`
    equals `domain_constants.counts_toward_year(priority, status)` on the run
    input (I50), and `within_year` / `spillover` are re-derived from the
    outcome's own fields:
    - status-excluded -> `within_year = status == Commercialized` (unchanged);
    - `not_scheduled_priority` -> False / False (I49 owns the rest);
    - otherwise `within_year = counts ∧ scheduled ∧ end_week + delay_weeks <=
      within_year_week` and `spillover = counts ∧ scheduled ∧ ¬within_year`,
      "scheduled" as before (not left_out / data_error / Blocked hold).
    A within/spill mismatch is tagged I9 on a counting project (the pre-P42
    rule) and I50 on a non-counting one."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        project = ctx.projects.get(outcome.project_id)
        if project is None:
            continue
        counts = project_counts_toward_year(project)
        tag = "I9" if counts else "I50"
        if outcome.counts_toward_year != counts:
            violations.append(
                InvariantViolation(
                    invariant="I50",
                    description=(
                        f"project {outcome.project_id!r}: counts_toward_year="
                        f"{outcome.counts_toward_year!r} but R42-4 on the input "
                        f"(priority {project.priority!r}, status {project.status!r}) gives "
                        f"{counts!r}"
                    ),
                    project_id=outcome.project_id,
                )
            )
        if outcome.not_scheduled_priority:
            continue  # I49 asserts its flags
        if outcome.excluded:
            expected = project.status == "Commercialized"
        elif not ctx.is_scheduled(outcome):
            expected = False
        else:
            if outcome.end_week is None:
                violations.append(
                    InvariantViolation(
                        invariant="I9",
                        description=(
                            f"project {outcome.project_id!r} is scheduled but end_week is None — "
                            "within_year cannot be re-derived"
                        ),
                        project_id=outcome.project_id,
                    )
                )
                continue
            expected = counts and (
                outcome.end_week + project.delay_weeks <= ctx.schedule_input.within_year_week
            )

        if outcome.within_year != expected:
            violations.append(
                InvariantViolation(
                    invariant=tag,
                    description=(
                        f"project {outcome.project_id!r}: within_year={outcome.within_year!r} but "
                        f"re-derived from counts_toward_year/left_out/end_week/delay_weeks/status "
                        f"the expected value is {expected!r}"
                    ),
                    project_id=outcome.project_id,
                )
            )
            continue
        if not outcome.excluded:
            expected_spill = counts and ctx.is_scheduled(outcome) and not outcome.within_year
            if outcome.spillover != expected_spill:
                violations.append(
                    InvariantViolation(
                        invariant=tag,
                        description=(
                            f"project {outcome.project_id!r}: spillover={outcome.spillover!r} but "
                            f"re-derived expected {expected_spill!r}"
                        ),
                        project_id=outcome.project_id,
                    )
                )
    return violations


# --- I10: frozen dates are never mutated --------------------------------------


def _check_i10_frozen_dates_immutable(ctx: _Ctx) -> list[InvariantViolation]:
    """I10: a frozen project's first non-skipped step starts at `actual_start_week`."""

    violations: list[InvariantViolation] = []
    for project in sorted(ctx.schedule_input.projects, key=lambda p: p.project_id):
        if not project.frozen:
            continue
        outcome = ctx.outcomes.get(project.project_id)
        if outcome is None:
            continue
        real = [s for s in outcome.steps if not s.skipped]
        if not real:
            continue
        if ctx.pinned_ids(project.project_id):
            violations.extend(_check_i10_frozen_with_pins(ctx, project, outcome))
            continue
        first_step = min(real, key=lambda s: (s.start_week, s.sequence_order))
        if first_step.start_week != project.actual_start_week:
            violations.append(
                InvariantViolation(
                    invariant="I10",
                    description=(
                        f"frozen project {project.project_id!r}: first step "
                        f"({first_step.step_id!r}) start_week={first_step.start_week} does not "
                        f"equal actual_start_week={project.actual_start_week}"
                    ),
                    project_id=project.project_id,
                    step_id=first_step.step_id,
                )
            )
    return violations


def _check_i10_frozen_with_pins(
    ctx: _Ctx, project: ProjectInput, outcome: ProjectScheduleOutcome
) -> list[InvariantViolation]:
    """I10 for a frozen project with manual pins (ADR 0054, R40-10, I48(d)):
    its dates are a function of its frozen inputs only. Every row equals the
    frozen rule recomputed here from `actual_start_week`, the effective
    durations and the pins (exact, never lapsed): a pinned step sits on its
    pin and passes on `max(end, release)`; any other step starts at
    `release + 1` (no wait, no overlap, no stretch in a frozen project); a
    skipped step sits at its release. With a pin the first step need not
    start at `actual_start_week`, so this replaces the plain check."""

    plan = ctx.plan(project.project_id)
    if plan is None or project.actual_start_week is None:
        return []
    pins = ctx.pins.get(project.project_id, {})
    frontier = project.actual_start_week
    g: dict[str, int] = {}
    expected: dict[str, tuple[int, int]] = {}
    for sid in plan.workflow.walk_order:
        sp = plan.steps[sid]
        preds = sp.step.predecessor_ids
        release = max((g[p] for p in preds), default=frontier - 1)
        if sp.skipped:
            expected[sid] = (release, release)
            g[sid] = release
        elif sid in pins:
            expected[sid] = pins[sid]
            g[sid] = max(pins[sid][1], release)
        else:
            expected[sid] = (release + 1, release + sp.duration)
            g[sid] = release + sp.duration
    out: list[InvariantViolation] = []
    for step in sorted(outcome.steps, key=lambda s: (s.sequence_order, s.step_id)):
        want = expected.get(step.step_id)
        if want is not None and (step.start_week, step.end_week) != want:
            out.append(
                InvariantViolation(
                    invariant="I10",
                    description=(
                        f"frozen project {project.project_id!r} step {step.step_id!r} is at "
                        f"[{step.start_week},{step.end_week}] but its frozen inputs (actual "
                        f"start {frontier}, durations, manual pins) give [{want[0]},{want[1]}]"
                    ),
                    project_id=project.project_id,
                    step_id=step.step_id,
                )
            )
    return out


# --- I11: Done stages are immutable history ----------------------------------


def _check_i11_done_stages_immutable(ctx: _Ctx) -> list[InvariantViolation]:
    """I11: a `Done` stage's scheduled `[start, end]` equals its recorded
    `[actual_start_week, actual_end_week]` (non-frozen projects; `frozen` wins
    over progress per ADR 0006)."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        plan = ctx.plan(pid)
        if plan is None or plan.project.frozen or outcome.data_error is not None:
            continue
        for step in sorted(outcome.steps, key=lambda s: s.sequence_order):
            sp = plan.steps.get(step.step_id)
            if sp is None or sp.skipped or sp.status != STATUS_DONE:
                continue
            if (step.start_week, step.end_week) != (sp.actual_start_week, sp.actual_end_week):
                violations.append(
                    InvariantViolation(
                        invariant="I11",
                        description=(
                            f"project {pid!r} Done step {step.step_id!r} is placed at "
                            f"[{step.start_week},{step.end_week}] but its recorded actuals are "
                            f"[{sp.actual_start_week},{sp.actual_end_week}] — Done stages are "
                            "never re-placed"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
        present = {s.step_id for s in outcome.steps}
        for sid in _required_anchored_rows(plan, outcome):
            if sid not in present:
                violations.append(
                    InvariantViolation(
                        invariant="I11",
                        description=(
                            f"project {pid!r} anchored step {sid!r} "
                            f"({plan.steps[sid].status}) is missing from the run -- in-flight "
                            "work is never erased (ruling 2)"
                        ),
                        project_id=pid,
                        step_id=sid,
                    )
                )
    return violations


def _required_anchored_rows(plan: ProjectPlan, outcome: ProjectScheduleOutcome) -> list[str]:
    """Anchored steps that must appear in every non-frozen outcome (ruling 2):
    every `Done` step, and every non-held In Progress / Blocked step whose
    predecessors are all themselves anchored or skipped (the steps the solvers
    pre-book). Not required when there is nothing to book against: no leader,
    or a dead end on a lab step with no eligible chamber."""

    if not plan.progress_tracked or outcome.no_leader or outcome.no_chamber_step_id:
        return []
    known: set[str] = set()
    required: list[str] = []
    for sid in plan.workflow.walk_order:
        sp = plan.steps[sid]
        preds_known = all(p in known for p in sp.step.predecessor_ids)
        if sp.skipped:
            if preds_known:
                known.add(sid)
        elif sp.status == STATUS_DONE:
            known.add(sid)
            required.append(sid)
        elif sp.status in (STATUS_IN_PROGRESS, STATUS_BLOCKED) and preds_known:
            known.add(sid)
            if sid not in plan.held_step_ids:
                required.append(sid)
    return required


# --- I12: duration-weighted roll-up -------------------------------------------


def _check_i12_progress_pct(ctx: _Ctx) -> list[InvariantViolation]:
    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        plan = ctx.plan(outcome.project_id)
        if plan is None or outcome.excluded:
            continue
        expected = None if outcome.data_error is not None else compute_progress_pct(plan)
        if outcome.progress_pct != expected:
            violations.append(
                InvariantViolation(
                    invariant="I12",
                    description=(
                        f"project {outcome.project_id!r}: progress_pct={outcome.progress_pct!r} "
                        f"but the duration-weighted roll-up gives {expected!r}"
                    ),
                    project_id=outcome.project_id,
                )
            )
    return violations


# --- I16: completion lines are stored by-products -----------------------------


def _check_i16_completion_lines(ctx: _Ctx) -> list[InvariantViolation]:
    """I16 (the assertable half): `unconstrained_end_week` equals a recomputed
    unconstrained DAG walk, `expected_end_week` is `target_end_week` when set
    else the unconstrained finish, `projected_end_week` is `end_week +
    delay_weeks` for a scheduled project and None otherwise, and a scheduled
    non-frozen project never finishes *before* its unconstrained finish."""

    violations: list[InvariantViolation] = []
    cw = ctx.schedule_input.current_week
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        project = ctx.projects.get(pid)
        if project is None:
            continue

        def bad(msg: str, pid: str = pid) -> None:
            violations.append(
                InvariantViolation(
                    invariant="I16", description=f"project {pid!r}: {msg}", project_id=pid
                )
            )

        if outcome.excluded:
            if (
                outcome.unconstrained_end_week,
                outcome.expected_end_week,
                outcome.projected_end_week,
            ) != (None, None, None):
                bad("excluded project must carry no completion weeks")
            continue
        plan = ctx.plan(pid)
        if outcome.data_error is not None:
            if outcome.unconstrained_end_week is not None or outcome.projected_end_week is not None:
                bad("data-error project must have unconstrained/projected end weeks of None")
            if outcome.expected_end_week != project.target_end_week:
                bad("data-error project's expected_end_week must equal target_end_week")
            continue
        if plan is not None:
            recomputed = unconstrained_end_week(plan, cw)
            if outcome.unconstrained_end_week != recomputed:
                bad(
                    f"unconstrained_end_week={outcome.unconstrained_end_week!r} but a recomputed "
                    f"unconstrained walk gives {recomputed!r}"
                )
        expected = (
            project.target_end_week
            if project.target_end_week is not None
            else outcome.unconstrained_end_week
        )
        if outcome.expected_end_week != expected:
            bad(
                f"expected_end_week={outcome.expected_end_week!r} but target/unconstrained "
                f"gives {expected!r}"
            )
        if ctx.is_scheduled(outcome):
            if outcome.end_week is None:
                continue  # I9 reports this
            projected = outcome.end_week + project.delay_weeks
            if outcome.projected_end_week != projected:
                bad(
                    f"projected_end_week={outcome.projected_end_week!r} but end_week + delay "
                    f"gives {projected}"
                )
            if (
                not project.frozen
                and outcome.unconstrained_end_week is not None
                and outcome.end_week < outcome.unconstrained_end_week
            ):
                bad(
                    f"end_week={outcome.end_week} is earlier than the unconstrained finish "
                    f"{outcome.unconstrained_end_week} — capacity can only delay a project"
                )
        elif outcome.projected_end_week is not None:
            bad("projected_end_week must be None when left_out / blocked / data_error")
    return violations


# --- I21 / I22: Gantt step timing (ADR 0019) ------------------------------------


def _check_i21_effective_duration_span(ctx: _Ctx) -> list[InvariantViolation]:
    """I21 (ADR 0019, amended by ADR 0032): every scheduled step that is not
    skipped, not `Done` and not in a frozen project carries its effective
    duration (`duration_override_weeks ?? lead time`, effort weeks) as
    `duration_weeks`, and books a span equal to that duration stretched by
    its leader's FTE (`ceil(duration / fte)` for a design step; lab and
    elapsed steps are not stretched). For an `In Progress` / `Blocked` step
    the booked tail `[max(CURRENT_WEEK, pred_end + 1, actual_start) .. end]`
    equals the remaining duration derived from the effective duration (ADR
    0006), stretched the same way; with `remaining == 0` the row ends at
    `max(actual_start, pred_end)` and books nothing. Held steps (a Blocked
    hold) book nothing and are exempt; a missing predecessor row is I5's to
    report."""

    violations: list[InvariantViolation] = []
    cw = ctx.schedule_input.current_week
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        project = ctx.projects.get(pid)
        plan = ctx.plan(pid)
        if (
            outcome.excluded
            or outcome.data_error is not None
            or project is None
            or plan is None
            or project.frozen
        ):
            continue
        by_id = {s.step_id: s for s in outcome.steps}
        frontier = first_step_frontier(project, cw)
        for step in sorted(outcome.steps, key=lambda s: (s.sequence_order, s.step_id)):
            sp = plan.steps.get(step.step_id)
            if (
                sp is None
                or sp.skipped
                or step.skipped
                or sp.status == STATUS_DONE
                or step.step_id in plan.held_step_ids
                or ctx.is_pinned(pid, step.step_id)  # ADR 0054: I45 governs a pinned row
            ):
                continue

            def bad(msg: str, pid: str = pid, sid: str = step.step_id) -> None:
                violations.append(
                    InvariantViolation(
                        invariant="I21",
                        description=f"project {pid!r} step {sid!r}: {msg}",
                        project_id=pid,
                        step_id=sid,
                    )
                )

            if step.duration_weeks != sp.duration:
                bad(
                    f"duration_weeks={step.duration_weeks} but its effective duration "
                    f"(override or lead time) is {sp.duration}"
                )
            if sp.status == STATUS_NOT_STARTED:
                span = step.end_week - step.start_week + 1
                if span != sp.span:
                    bad(
                        f"books weeks {step.start_week}..{step.end_week} ({span} weeks) but "
                        f"its effective duration {sp.duration} at the leader's FTE spans "
                        f"{sp.span}"
                    )
                continue

            # In Progress / Blocked (not held): the anchored tail.
            assert sp.actual_start_week is not None
            preds = [by_id.get(p) for p in sorted(sp.step.predecessor_ids)]
            if any(r is None for r in preds):
                continue  # I5 reports the missing row
            pred_end = max(r.end_week for r in preds if r is not None) if preds else frontier - 1
            if plan.has_overlap or ctx.pinned_ids(pid):
                # ADR 0043: the tail starts at `gate(s)` where it used
                # `pred_end + 1` (identical with no overlap anywhere).
                _g, release, rows = _row_releases(ctx, plan, outcome)
                gate = _row_gate(ctx, plan, step.step_id, release, rows)
                if gate is None:
                    continue  # I5 reports the missing row
                pred_end = gate - 1
            if sp.remaining_span == 0:
                expected_end = max(sp.actual_start_week, pred_end)
                if step.end_week != expected_end:
                    bad(
                        f"remaining is 0 so the row must end at {expected_end}, "
                        f"got end_week={step.end_week}"
                    )
                continue
            tail_start = max(cw, pred_end + 1, sp.actual_start_week)
            tail = step.end_week - tail_start + 1
            if tail != sp.remaining_span:
                bad(
                    f"{sp.status} tail {tail_start}..{step.end_week} is {tail} weeks but the "
                    f"remaining derived from the effective duration {sp.duration} is "
                    f"{sp.remaining}, spanning {sp.remaining_span} at the leader's FTE"
                )
    return violations


def _check_i22_start_not_before(ctx: _Ctx) -> list[InvariantViolation]:
    """I22 (ADR 0019): every `Not Started` step with `start_not_before_week`
    set starts at or after that week. Exempt, by the same rules the
    schedulers follow: frozen projects ("frozen wins", ADR 0006 — their dates
    are locked at `actual_start_week`, I10), held steps (a Blocked hold places
    nothing), skipped steps, and In Progress / Blocked / Done steps (the
    floor does not apply to them)."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        project = ctx.projects.get(pid)
        plan = ctx.plan(pid)
        if (
            outcome.excluded
            or outcome.data_error is not None
            or project is None
            or plan is None
            or project.frozen
        ):
            continue
        for step in sorted(outcome.steps, key=lambda s: (s.sequence_order, s.step_id)):
            sp = plan.steps.get(step.step_id)
            if (
                sp is None
                or sp.skipped
                or step.skipped
                or sp.status != STATUS_NOT_STARTED
                or sp.start_not_before_week is None
                or step.step_id in plan.held_step_ids
                or ctx.is_pinned(pid, step.step_id)  # ADR 0054: unpinned steps only
            ):
                continue
            if step.start_week < sp.start_not_before_week:
                violations.append(
                    InvariantViolation(
                        invariant="I22",
                        description=(
                            f"project {pid!r} step {step.step_id!r} starts at week "
                            f"{step.start_week}, before its start_not_before_week "
                            f"{sp.start_not_before_week}"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                        week=step.start_week,
                    )
                )
    return violations


# --- R3 at the input (ADR 0041) -----------------------------------------------------


def _check_i26_recorded_work_not_zeroed(ctx: _Ctx) -> list[InvariantViolation]:
    """ADR 0041 R3 / I26, the part visible in a solver input: a step of a
    non-frozen project whose stored stage status is not `Not Started` must
    not be zeroed by its merged override (`user ?? effort` = 0). The effort
    split raises such a step to `max(1, ·)` and a user override is never 0,
    so a 0 here means recorded work would vanish from the run (the step is
    skipped, its actuals dropped, and I11 — which exempts skipped steps —
    would not notice). Lead-0 steps and lab steps with certification testing
    off are skipped by the table, not by the override, and are not
    reported (their progress has always been ignored)."""

    violations: list[InvariantViolation] = []
    for project in sorted(ctx.schedule_input.projects, key=lambda p: p.project_id):
        if project.frozen or project.status not in dc.SCHEDULABLE_STATUS_ORDER:
            continue
        wf = ctx.workflows.get(project.workflow_id)
        if wf is None or project.category is None:
            continue
        started = sorted(
            {pr.step_id for pr in project.step_progress if pr.status != STATUS_NOT_STARTED}
        )
        for step_id in started:
            if step_id not in wf.steps_by_id:
                continue
            lead = _input_lead(ctx, project, step_id)
            if not lead:
                continue
            if wf.steps_by_id[step_id].kind == "lab" and not project.certification_testing_required:
                continue
            if _input_override(project, step_id) == 0:
                violations.append(
                    InvariantViolation(
                        invariant="I26",
                        description=(
                            f"project {project.project_id!r} step {step_id!r} has recorded "
                            "progress but its merged duration is 0, so the run skips it and "
                            "drops the recorded work (ADR 0041 R3: a started step keeps "
                            "max(1, effort))"
                        ),
                        project_id=project.project_id,
                        step_id=step_id,
                    )
                )
    return violations


# --- I27: gate (ADR 0043, rev. P33 R33-4) ----------------------------------------------


def _not_started_steps(ctx: _Ctx) -> list[tuple[ProjectScheduleOutcome, ProjectPlan, StepSchedule]]:
    """The rows I27 / I28 govern: non-skipped, non-held `Not Started` steps of
    non-frozen, non-excluded, non-data-error projects that analyse cleanly,
    in (project_id, sequence_order, step_id) order."""

    out: list[tuple[ProjectScheduleOutcome, ProjectPlan, StepSchedule]] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        project = ctx.projects.get(outcome.project_id)
        plan = ctx.plan(outcome.project_id)
        if (
            outcome.excluded
            or outcome.data_error is not None
            or project is None
            or plan is None
            or project.frozen
        ):
            continue
        for step in sorted(outcome.steps, key=lambda s: (s.sequence_order, s.step_id)):
            sp = plan.steps.get(step.step_id)
            if (
                sp is None
                or sp.skipped
                or step.skipped
                or sp.status != STATUS_NOT_STARTED
                or step.step_id in plan.held_step_ids
                or ctx.is_pinned(outcome.project_id, step.step_id)  # ADR 0054 / I47(b)
            ):
                continue
            out.append((outcome, plan, step))
    return out


def _check_i27_overlap_gate(ctx: _Ctx) -> list[InvariantViolation]:
    """I27 (ADR 0043, rev. P33 R33-4): every non-skipped, non-held `Not
    Started` step of a non-frozen project starts at or after `max(CURRENT_WEEK,
    gate(s), start_not_before_week)`, with `release` and the anchor starts
    recomputed from the output rows. Each term is reported once: the gate
    term here only for `o(s) > 0` (with no overlap `gate = release + 1 + w`,
    which I3 and I28 report), the floor by I22, and the `CURRENT_WEEK` term
    here for every such step."""

    violations: list[InvariantViolation] = []
    cw = ctx.schedule_input.current_week
    releases: dict[str, tuple[dict[str, int], dict[str, StepSchedule]]] = {}
    for outcome, plan, step in _not_started_steps(ctx):
        pid = outcome.project_id
        sp = plan.steps[step.step_id]
        if step.start_week < cw:
            violations.append(
                InvariantViolation(
                    invariant="I27",
                    description=(
                        f"project {pid!r} step {step.step_id!r} is Not Started but starts at "
                        f"week {step.start_week}, before CURRENT_WEEK {cw}"
                    ),
                    project_id=pid,
                    step_id=step.step_id,
                    week=step.start_week,
                )
            )
            continue
        if sp.overlap_weeks == 0:
            continue
        if pid not in releases:
            _g, release, by_id = _row_releases(ctx, plan, outcome)
            releases[pid] = (release, by_id)
        release, by_id = releases[pid]
        gate = _row_gate(ctx, plan, step.step_id, release, by_id)
        if gate is None:
            continue  # a predecessor / anchor row is missing: I5's to report
        if step.start_week < gate:
            violations.append(
                InvariantViolation(
                    invariant="I27",
                    description=(
                        f"project {pid!r} step {step.step_id!r} (overlap_weeks="
                        f"{sp.overlap_weeks}) starts at week {step.start_week}, before "
                        f"its gate {gate} (release {release[step.step_id]} + 1 - overlap, "
                        "the start of the step it runs in parallel with, the frontier)"
                    ),
                    project_id=pid,
                    step_id=step.step_id,
                    week=step.start_week,
                )
            )
    return violations


# --- I28: wait (P33, R33-4) -----------------------------------------------------------


def _check_i28_wait_gate(ctx: _Ctx) -> list[InvariantViolation]:
    """I28 (P33): every non-skipped, non-held `Not Started` step of a
    non-frozen project with `w(s) > 0` starts at or after `release(s) + 1 +
    w(s)`, `release` recomputed from the output rows (DOMAIN_RULES
    "Category templates" §D). The difference half is `check_wait_invariance`."""

    violations: list[InvariantViolation] = []
    releases: dict[str, dict[str, int]] = {}
    for outcome, plan, step in _not_started_steps(ctx):
        pid = outcome.project_id
        sp = plan.steps[step.step_id]
        if sp.wait_weeks == 0:
            continue
        if pid not in releases:
            releases[pid] = _row_releases(ctx, plan, outcome)[1]
        release = releases[pid].get(step.step_id)
        if release is None:
            continue  # a predecessor row is missing: I5's to report
        floor = release + 1 + sp.wait_weeks
        if step.start_week < floor:
            violations.append(
                InvariantViolation(
                    invariant="I28",
                    description=(
                        f"project {pid!r} step {step.step_id!r} (wait_weeks={sp.wait_weeks}) "
                        f"starts at week {step.start_week}, before release {release} + 1 + "
                        f"wait = {floor}"
                    ),
                    project_id=pid,
                    step_id=step.step_id,
                    week=step.start_week,
                )
            )
    return violations


def without_waits(schedule_input: ScheduleInput) -> ScheduleInput:
    """`schedule_input` with every `wait_weeks` set to 0 (I28's comparison
    input). Rows are otherwise unchanged; an input without waits is returned
    as is."""

    if not any(r.wait_weeks for p in schedule_input.projects for r in p.step_timing):
        return schedule_input
    return replace(
        schedule_input,
        projects=tuple(
            replace(p, step_timing=tuple(replace(r, wait_weeks=0) for r in p.step_timing))
            if any(r.wait_weeks for r in p.step_timing)
            else p
            for p in schedule_input.projects
        ),
    )


def check_wait_invariance(schedule_input: ScheduleInput) -> tuple[InvariantViolation, ...]:
    """I28, the difference half: a wait books nothing. Runs greedy on
    `schedule_input` and on `without_waits(schedule_input)` and requires, for
    every project, the same `progress_pct` (I12 weights) and the same
    `duration_weeks` / `skipped` on every step row both runs emit (a wait may
    push a project to LEFT_OUT, which drops rows; it never changes one). A
    no-op (no re-run) when the input has no wait. A `ValueError` from the
    scheduler (malformed input) is not reported here."""

    stripped = without_waits(schedule_input)
    if stripped is schedule_input:
        return ()
    try:
        with_w = run_greedy_sgs(schedule_input)
        no_w = run_greedy_sgs(stripped)
    except ValueError:
        return ()
    base = {o.project_id: o for o in no_w.project_outcomes}
    violations: list[InvariantViolation] = []
    for outcome in with_w.project_outcomes:
        other = base.get(outcome.project_id)
        if other is None:
            continue
        pid = outcome.project_id
        if outcome.progress_pct != other.progress_pct:
            violations.append(
                InvariantViolation(
                    invariant="I28",
                    description=(
                        f"project {pid!r}: progress_pct {outcome.progress_pct!r} with waits but "
                        f"{other.progress_pct!r} without (a wait must not weigh progress)"
                    ),
                    project_id=pid,
                )
            )
        rows = {s.step_id: s for s in other.steps}
        for step in outcome.steps:
            row = rows.get(step.step_id)
            if row is None:
                continue
            if (step.duration_weeks, step.skipped) != (row.duration_weeks, row.skipped):
                violations.append(
                    InvariantViolation(
                        invariant="I28",
                        description=(
                            f"project {pid!r} step {step.step_id!r}: duration_weeks="
                            f"{step.duration_weeks} (skipped={step.skipped}) with waits but "
                            f"{row.duration_weeks} (skipped={row.skipped}) without (a wait "
                            "must book nothing)"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
    return tuple(violations)


# --- I29: duration from the input (P33, R33-1) ------------------------------------------


def _check_i29_duration_from_input(ctx: _Ctx) -> list[InvariantViolation]:
    """I29 (P33): every run row's `duration_weeks` equals `eff(p, s)` evaluated
    on the run's input (`_input_eff`: `lead_weeks ?? table`, then `override ??
    lead`, 0 for lead 0 or a lab step with certification testing off), with
    "skipped" exactly when it is 0. Reported once, disjoint from the checks
    that already compare rows with the scheduler's own `eff`:

    - (a) the scheduler's `eff` (`analyse_project`, which every solver uses)
      equals the input-derived `eff` on every step of every analysed project.
      Combined with I5 (skipped rows: duration 0, flag from the input), I6 /
      I7 (design / lab rows) and I21 (non-frozen, non-Done, non-held rows),
      this is I29 on those rows;
    - (b) the rows none of those see: elapsed, non-skipped rows of a frozen
      project, a Done step or a held step must carry the input `eff`."""

    violations: list[InvariantViolation] = []
    for pid in sorted(ctx.plans):
        plan = ctx.plans[pid]
        project = ctx.projects[pid]
        for sid in plan.workflow.walk_order:
            eff = _input_eff(ctx, project, sid)
            sp = plan.steps[sid]
            if eff is None or (sp.duration == eff and sp.skipped == (eff == 0)):
                continue
            violations.append(
                InvariantViolation(
                    invariant="I29",
                    description=(
                        f"project {pid!r} step {sid!r}: the scheduler's effective duration is "
                        f"{sp.duration} (skipped={sp.skipped}) but eff on the input "
                        f"(lead_weeks ?? table, then override ?? lead) is {eff}"
                    ),
                    project_id=pid,
                    step_id=sid,
                )
            )
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        row_project = ctx.projects.get(pid)
        row_plan = ctx.plan(pid)
        if row_project is None or row_plan is None:
            continue
        for step in sorted(outcome.steps, key=lambda s: (s.sequence_order, s.step_id)):
            row_sp = row_plan.steps.get(step.step_id)
            if row_sp is None or step.skipped or step.kind != "elapsed":
                continue
            if not (
                row_project.frozen
                or row_sp.status == STATUS_DONE
                or step.step_id in row_plan.held_step_ids
            ):
                continue  # I21's
            eff = _input_eff(ctx, row_project, step.step_id)
            if eff is not None and step.duration_weeks != eff:
                violations.append(
                    InvariantViolation(
                        invariant="I29",
                        description=(
                            f"project {pid!r} step {step.step_id!r}: duration_weeks="
                            f"{step.duration_weeks} but eff on the input is {eff}"
                        ),
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
    return violations


# --- I30: category order (P33, ADR 0047 §3, R33-8) ---------------------------------------


def _check_i30_category_order(ctx: _Ctx) -> list[InvariantViolation]:
    """I30 (P33; R36-9; R42-9): for consecutive ids `a, b` in
    `scheduling_order` that are equal on sort keys 1, 1a, 2, 3, 3a and 4
    (frozen, counts_toward_year, VIP, priority, band_rank, status), `rank(a) <=
    rank(b)`, and equal rank implies `project_id(a) < project_id(b)`. Ranks
    come from `ScheduleInput.categories`. An invalid list is reported in
    `_build_ctx`; ids that are unknown or lack a valid priority / status /
    category are skipped (other checks and input validation own them)."""

    if ctx.categories is None:
        return []
    rank = ctx.categories.rank

    def keys(pid: str) -> tuple[tuple[int, int, int, int, tuple[int, int], int], int] | None:
        p = ctx.projects.get(pid)
        if (
            p is None
            or p.priority not in dc.PRIORITY_ORDER
            or p.status not in dc.SCHEDULABLE_STATUS_ORDER
            or p.category not in rank
        ):
            return None
        # R36-9 / R42-9: the head is keys 1, 1a, 2, 3, 3a and 4 (frozen,
        # counts_toward_year, VIP, priority, band_rank, status); with every
        # band_rank None and every project counting it is the P33 head.
        head = (
            0 if p.frozen else 1,
            0 if project_counts_toward_year(p) else 1,
            0 if p.is_vip else 1,
            dc.PRIORITY_ORDER.index(p.priority),
            _band_rank_key(p.band_rank),
            dc.SCHEDULABLE_STATUS_ORDER[p.status],
        )
        return head, rank[p.category]  # type: ignore[index]

    violations: list[InvariantViolation] = []
    order = ctx.schedule_output.scheduling_order
    for a, b in zip(order, order[1:]):  # noqa: B905
        ka, kb = keys(a), keys(b)
        if ka is None or kb is None or ka[0] != kb[0]:
            continue
        if ka[1] > kb[1] or (ka[1] == kb[1] and not a < b):
            violations.append(
                InvariantViolation(
                    invariant="I30",
                    description=(
                        f"scheduling_order has {a!r} (category rank {ka[1]}) before {b!r} "
                        f"(category rank {kb[1]}) although they are equal on sort keys "
                        "1, 1a, 2, 3, 3a and 4: "
                        "rank must not decrease, ties by ascending project_id"
                    ),
                    project_id=b,
                )
            )
    return violations


# --- I35: no empty project (P35, ADR 0049 as ruled) ---------------------------------


def _check_i35_no_empty_project(ctx: _Ctx) -> list[InvariantViolation]:
    """I35: every project of the run input in a schedulable status keeps at
    least one step with `eff > 0`, derived from the inputs alone
    (`_input_eff`). Projects the inputs cannot evaluate (unknown workflow,
    no category, a missing lead-time row) are left to I15 / I6 / the data
    error path."""

    violations: list[InvariantViolation] = []
    for project in sorted(ctx.schedule_input.projects, key=lambda p: p.project_id):
        if project.status not in dc.SCHEDULABLE_STATUS_ORDER:
            continue
        if is_not_scheduled_priority(project):
            continue  # R42-3: never scheduled; its bucket is NOT_SCHEDULED_PRIORITY
        wf = ctx.workflows.get(project.workflow_id)
        if wf is None or project.category is None:
            continue
        effs = [_input_eff(ctx, project, step_id) for step_id in sorted(wf.steps_by_id)]
        if any(e is None for e in effs):
            continue
        if all(e == 0 for e in effs):
            violations.append(
                InvariantViolation(
                    invariant="I35",
                    description=(
                        f"project {project.project_id!r} has all {len(effs)} steps skipped "
                        "(eff = 0 on every step): the run gives it no completion week and it "
                        "falls in no Dashboard bucket (R35-5 NO_STEPS_LEFT must refuse this)"
                    ),
                    project_id=project.project_id,
                )
            )
    return violations


# --- I37: rank within a priority band (P36, ADR 0050, R36-9) ---------------------------


def _check_i37a_band_rank_order(ctx: _Ctx) -> list[InvariantViolation]:
    """I37a: every `band_rank` in the input is None or an int >= 1; and over
    every consecutive pair `a, b` of `scheduling_order`, keys 1, 1a, 2, 3, 3a
    (frozen, counts_toward_year (R42-9), VIP, priority, band_rank with None
    last) never decrease. That is the
    pairwise rule "equal on keys 1-3 => band_rank non-decreasing, NULL last"
    plus the lexicographic check across groups (a non-contiguous group is a
    decrease somewhere). Ids unknown or lacking a valid priority are skipped
    (I15 / input validation own them)."""

    violations: list[InvariantViolation] = []
    for p in sorted(ctx.schedule_input.projects, key=lambda q: q.project_id):
        r = p.band_rank
        if r is not None and (isinstance(r, bool) or not isinstance(r, int) or r < 1):
            violations.append(
                InvariantViolation(
                    invariant="I37a",
                    description=f"band_rank {r!r} is not None or an integer >= 1",
                    project_id=p.project_id,
                )
            )

    def head(pid: str) -> tuple[int, int, int, int, tuple[int, int]] | None:
        p = ctx.projects.get(pid)
        if p is None or p.priority not in dc.PRIORITY_ORDER:
            return None
        r = p.band_rank
        if r is not None and (isinstance(r, bool) or not isinstance(r, int)):
            return None
        # R42-9: keys 1, 1a, 2, 3, 3a.
        return (
            0 if p.frozen else 1,
            0 if project_counts_toward_year(p) else 1,
            0 if p.is_vip else 1,
            dc.PRIORITY_ORDER.index(p.priority),
            _band_rank_key(r),
        )

    order = ctx.schedule_output.scheduling_order
    for a, b in zip(order, order[1:]):  # noqa: B905
        ha, hb = head(a), head(b)
        if ha is None or hb is None or ha <= hb:
            continue
        same_band = ha[:4] == hb[:4]
        ra, rb = ctx.projects[a].band_rank, ctx.projects[b].band_rank
        violations.append(
            InvariantViolation(
                invariant="I37a",
                description=(
                    f"scheduling_order has {a!r} (band_rank {ra}) before {b!r} "
                    f"(band_rank {rb})"
                    + (
                        ": equal on sort keys 1, 1a, 2, 3, band_rank must not decrease (None last)"
                        if same_band
                        else ": sort keys 1, 1a, 2, 3, 3a (frozen, counts_toward_year, VIP, "
                        "priority, band_rank) decrease"
                    )
                ),
                project_id=b,
            )
        )
    return violations


def check_i37b_band_ranks_dense(
    projects: Iterable[ProjectInput],
) -> tuple[InvariantViolation, ...]:
    """I37b (live state, R36-9): `band_rank` is set iff the project is a band
    member (status schedulable and priority set), and per band the members'
    ranks are exactly {1..n}. Only meaningful on a DB-built input or a list of
    live projects; never call it on a What-if / import input. Pure; usable by
    backend tests after every write path."""

    violations: list[InvariantViolation] = []
    by_band: dict[str, list[ProjectInput]] = defaultdict(list)
    for p in sorted(projects, key=lambda q: q.project_id):
        member = p.status in dc.SCHEDULABLE_STATUS_ORDER and p.priority is not None
        if member != (p.band_rank is not None):
            violations.append(
                InvariantViolation(
                    invariant="I37b",
                    description=(
                        f"band_rank {p.band_rank!r} with status {p.status!r} and priority "
                        f"{p.priority!r}: band_rank must be set iff the status is schedulable "
                        "and the priority is set"
                    ),
                    project_id=p.project_id,
                )
            )
        if member:
            by_band[p.priority].append(p)  # type: ignore[index]
    for band in sorted(by_band):
        ranks = sorted(p.band_rank for p in by_band[band] if p.band_rank is not None)
        expected = list(range(1, len(by_band[band]) + 1))
        if ranks != expected:
            violations.append(
                InvariantViolation(
                    invariant="I37b",
                    description=(
                        f"band {band!r}: ranks {ranks} are not exactly 1..{len(expected)}"
                    ),
                )
            )
    return tuple(violations)


def check_i37c_placement(
    before_order: Sequence[str],
    after_order: Sequence[str],
    project_id: str,
    *,
    before_project_id: str | None = None,
    after_project_id: str | None = None,
) -> tuple[InvariantViolation, ...]:
    """I37c (re-rank write, R36-9): `before_order` / `after_order` are the
    band's ids in rank order before and after placing `project_id` before
    `before_project_id` / after `after_project_id` (both None: last).
    After the write `project_id` is immediately before / after its anchor
    (last when neither is given), the band holds the same ids, and every
    other member keeps its relative order. Pure; for backend tests."""

    violations: list[InvariantViolation] = []

    def fail(msg: str) -> None:
        violations.append(
            InvariantViolation(invariant="I37c", description=msg, project_id=project_id)
        )

    expected_ids = set(before_order) | {project_id}
    if set(after_order) != expected_ids or len(after_order) != len(expected_ids):
        fail(f"band membership changed by the re-rank: {list(before_order)} -> {list(after_order)}")
        return tuple(violations)
    others_before = [i for i in before_order if i != project_id]
    others_after = [i for i in after_order if i != project_id]
    if others_before != others_after:
        fail("the relative order of the other band members changed")
    pos = list(after_order).index(project_id)
    if before_project_id is not None and after_project_id is not None:
        fail("both before_project_id and after_project_id given")
    elif before_project_id is not None:
        if pos + 1 >= len(after_order) or after_order[pos + 1] != before_project_id:
            fail(f"{project_id!r} is not immediately before {before_project_id!r}")
    elif after_project_id is not None:
        if pos == 0 or after_order[pos - 1] != after_project_id:
            fail(f"{project_id!r} is not immediately after {after_project_id!r}")
    elif pos != len(after_order) - 1:
        fail(f"{project_id!r} is not last in its band")
    return tuple(violations)


# --- I45 / I47 / I48: manual step pins (ADR 0054 as ruled at P40-T02) --------------------


def _check_i45_pins_placed(ctx: _Ctx) -> list[InvariantViolation]:
    """I45: for every project with rows in the run, every pin the input says
    applies (`_Ctx.pins`: not skipped, not held, Not Started unless frozen)
    sits on its effective window `(a, b)` — `(ms, me)` when frozen or `ms >=
    current_week`, else `(cw, cw + L - 1)` — with `pinned = true`,
    `duration_weeks = eff(p, s)` (from the input), the leader on a design row
    and a chamber on a lab row; a window ending past `horizon_weeks` makes the
    project `left_out` with no row for the step; `pin_lapsed` is true iff some
    such window differs from its pin; and no other row has `pinned = true`.

    A project that dead-ended on a lab step with no eligible chamber
    (`no_chamber_step_id`, R40-6) is not required to carry its pinned rows,
    exactly as `_required_anchored_rows` exempts its anchored ones; a row it
    does carry must still be right."""

    violations: list[InvariantViolation] = []
    cw = ctx.schedule_input.current_week
    horizon = ctx.schedule_input.horizon_weeks
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        project = ctx.projects.get(pid)
        if project is None or outcome.excluded or outcome.data_error is not None:
            continue
        if not outcome.steps:
            continue  # "every project with rows in it" (no_leader, empty LEFT_OUT)
        pins = ctx.pins.get(pid, {})
        rows = {s.step_id: s for s in outcome.steps}

        def bad(msg: str, sid: str | None = None, pid: str = pid) -> None:
            violations.append(
                InvariantViolation(
                    invariant="I45",
                    description=f"project {pid!r}" + (f" step {sid!r}" if sid else "") + f": {msg}",
                    project_id=pid,
                    step_id=sid,
                )
            )

        lapsed = False
        placed: set[str] = set()
        for sid in sorted(pins):
            ms, me = pins[sid]
            if project.frozen or ms >= cw:
                a, b = ms, me
            else:
                a, b = cw, cw + (me - ms)
            lapsed = lapsed or (a, b) != (ms, me)
            row = rows.get(sid)
            if b > horizon:
                if not outcome.left_out:
                    bad(
                        f"its pin window {a}..{b} ends past horizon week {horizon} but the "
                        "project is not left_out",
                        sid,
                    )
                if row is not None:
                    bad(f"its pin window {a}..{b} ends past the horizon but it has a row", sid)
                continue
            placed.add(sid)
            if row is None:
                if outcome.no_chamber_step_id is None:
                    bad(f"pinned to {a}..{b} but has no row in the run", sid)
                continue
            if (row.start_week, row.end_week) != (a, b):
                bad(
                    f"is at [{row.start_week},{row.end_week}] but its pin ({ms}, {me}) at "
                    f"week {cw} places it on [{a},{b}]",
                    sid,
                )
            if not row.pinned:
                bad("sits on a pin but its row has pinned=False", sid)
            eff = _input_eff(ctx, project, sid)
            if eff is not None and row.duration_weeks != eff:
                bad(
                    f"duration_weeks={row.duration_weeks} but a pin is a placement, not "
                    f"effort: it must stay eff={eff} (R40-3)",
                    sid,
                )
            if row.kind == "design" and row.assigned_engineer_id != project.leader_engineer_id:
                bad(
                    f"design pin books {row.assigned_engineer_id!r}, not the leader "
                    f"{project.leader_engineer_id!r}",
                    sid,
                )
            if row.kind == "lab" and row.assigned_chamber_id is None:
                bad("lab pin books no chamber", sid)
        if outcome.pin_lapsed != lapsed:
            bad(f"pin_lapsed={outcome.pin_lapsed} but the input's pins give {lapsed}")
        for row in sorted(outcome.steps, key=lambda r: (r.sequence_order, r.step_id)):
            if row.pinned and row.step_id not in placed:
                bad("has pinned=True but the input places no pin on it", row.step_id)
    return violations


def _check_i47a_manual_overlap(ctx: _Ctx) -> list[InvariantViolation]:
    """I47(a): a pinned row `s` with start `a` has `manual_overlap = true` iff
    `a < release(s) + 1 - o(s)`, `release` from the run's own rows with `G` of
    a pinned predecessor = `max(end, release)` (`_row_releases`), `o(s)` the
    template overlap (0 in a frozen project); a row whose release is unknown
    (a predecessor row missing) is not flagged. Every other row has
    `manual_overlap = false`, and the outcome's flag is the OR over its rows."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        plan = ctx.plan(pid)
        any_flag = any(r.manual_overlap for r in outcome.steps)
        if outcome.manual_overlap != any_flag:
            violations.append(
                InvariantViolation(
                    "I47",
                    f"project {pid!r}: manual_overlap={outcome.manual_overlap} but the OR over "
                    f"its rows is {any_flag}",
                    project_id=pid,
                )
            )
        if not any_flag and not ctx.pinned_ids(pid):
            continue
        release: dict[str, int] = {}
        if plan is not None:
            release = _row_releases(ctx, plan, outcome)[1]
        for row in sorted(outcome.steps, key=lambda r: (r.sequence_order, r.step_id)):
            expected = False
            if plan is not None and row.pinned and ctx.is_pinned(pid, row.step_id):
                sp = plan.steps.get(row.step_id)
                rel = release.get(row.step_id)
                if sp is not None and rel is not None:
                    o = 0 if plan.project.frozen else sp.overlap_weeks
                    expected = row.start_week < rel + 1 - o
            if row.manual_overlap != expected:
                violations.append(
                    InvariantViolation(
                        "I47",
                        f"project {pid!r} step {row.step_id!r}: manual_overlap="
                        f"{row.manual_overlap} but start {row.start_week} against release "
                        f"{release.get(row.step_id)!r} gives {expected}",
                        project_id=pid,
                        step_id=row.step_id,
                    )
                )
    return violations


def without_pins(schedule_input: ScheduleInput) -> ScheduleInput:
    """`schedule_input` with every `step_pins` emptied (I48(b)'s comparison
    input). Returned as is when it has no pin."""

    if not any(p.step_pins for p in schedule_input.projects):
        return schedule_input
    return replace(
        schedule_input,
        projects=tuple(
            replace(p, step_pins=()) if p.step_pins else p for p in schedule_input.projects
        ),
    )


def check_pin_load_neutrality(schedule_input: ScheduleInput) -> tuple[InvariantViolation, ...]:
    """I48(b): two inputs that differ only in pins give identical
    `duration_weeks` / `skipped` on every row present in both runs and
    identical `progress_pct` (the I12 weights). Runs greedy on the input and
    on `without_pins(input)`. A no-op (no re-run) without pins; a
    `ValueError` (malformed input) is not reported here. I25 demand and
    `effort_weeks` are computed from live rows that carry no pin
    (`scheduling.demand`, `scheduling.effort_split`), so they cannot differ."""

    stripped = without_pins(schedule_input)
    if stripped is schedule_input:
        return ()
    try:
        with_p = run_greedy_sgs(schedule_input)
        no_p = run_greedy_sgs(stripped)
    except ValueError:
        return ()
    return tuple(_compare_pin_neutral(with_p, no_p))


def _compare_pin_neutral(
    with_pins: ScheduleOutput, without: ScheduleOutput
) -> list[InvariantViolation]:
    base = {o.project_id: o for o in without.project_outcomes}
    violations: list[InvariantViolation] = []
    for outcome in sorted(with_pins.project_outcomes, key=lambda o: o.project_id):
        other = base.get(outcome.project_id)
        if other is None:
            continue
        pid = outcome.project_id
        if outcome.progress_pct != other.progress_pct:
            violations.append(
                InvariantViolation(
                    "I48",
                    f"project {pid!r}: progress_pct {outcome.progress_pct!r} with pins but "
                    f"{other.progress_pct!r} without (a pin must not weigh progress)",
                    project_id=pid,
                )
            )
        rows = {s.step_id: s for s in other.steps}
        for step in sorted(outcome.steps, key=lambda r: (r.sequence_order, r.step_id)):
            row = rows.get(step.step_id)
            if row is None:
                continue
            if (step.duration_weeks, step.skipped) != (row.duration_weeks, row.skipped):
                violations.append(
                    InvariantViolation(
                        "I48",
                        f"project {pid!r} step {step.step_id!r}: duration_weeks="
                        f"{step.duration_weeks} (skipped={step.skipped}) with pins but "
                        f"{row.duration_weeks} (skipped={row.skipped}) without (a pin is a "
                        "placement, not effort)",
                        project_id=pid,
                        step_id=step.step_id,
                    )
                )
    return violations


# --- I49 / I51 / I52: priority band meaning (P42, ADR 0056, R42-9) ---------------------


def _check_i49_band_exclusion(ctx: _Ctx) -> list[InvariantViolation]:
    """I49: every input project with a schedulable status, priority in
    {P4, Q} and `frozen = false` has an outcome with `excluded`,
    `not_scheduled_priority` True, `counts_toward_year` False,
    `within_year = spillover = left_out = blocked = False`, no step rows and
    null start / end / projected / expected / unconstrained weeks, and is
    absent from `scheduling_order` (so it books nothing: I6 / I7 load 0). No
    other outcome has `not_scheduled_priority`. A status-excluded project
    keeps today's excluded outcome with `not_scheduled_priority = False` and
    `counts_toward_year = True`. `is_vip` changes none of this."""

    violations: list[InvariantViolation] = []
    order = set(ctx.schedule_output.scheduling_order)

    def bad(pid: str, msg: str) -> None:
        violations.append(
            InvariantViolation(
                invariant="I49", description=f"project {pid!r}: {msg}", project_id=pid
            )
        )

    for project in sorted(ctx.schedule_input.projects, key=lambda p: p.project_id):
        pid = project.project_id
        outcome = ctx.outcomes.get(pid)
        if outcome is None:
            continue  # the outcome set is I5's
        if is_not_scheduled_priority(project):
            flags = {
                "excluded": (outcome.excluded, True),
                "not_scheduled_priority": (outcome.not_scheduled_priority, True),
                "counts_toward_year": (outcome.counts_toward_year, False),
                "within_year": (outcome.within_year, False),
                "spillover": (outcome.spillover, False),
                "left_out": (outcome.left_out, False),
                "blocked": (outcome.blocked, False),
            }
            for name, (got, want) in flags.items():
                if got != want:
                    bad(
                        pid,
                        f"non-frozen {project.priority} project has {name}={got!r}, not {want!r}",
                    )
            if outcome.steps:
                bad(pid, f"non-frozen {project.priority} project carries {len(outcome.steps)} rows")
            weeks = {
                "start_week": outcome.start_week,
                "end_week": outcome.end_week,
                "projected_end_week": outcome.projected_end_week,
                "expected_end_week": outcome.expected_end_week,
                "unconstrained_end_week": outcome.unconstrained_end_week,
            }
            for name, value in weeks.items():
                if value is not None:
                    bad(
                        pid, f"non-frozen {project.priority} project has {name}={value!r}, not None"
                    )
            if pid in order:
                bad(pid, f"non-frozen {project.priority} project is in scheduling_order")
            continue
        if outcome.not_scheduled_priority:
            bad(
                pid,
                "not_scheduled_priority=True but the project is not a non-frozen P4/Q project "
                f"in a schedulable status (priority {project.priority!r}, status "
                f"{project.status!r}, frozen {project.frozen!r})",
            )
        if project.status not in dc.SCHEDULABLE_STATUS_ORDER and not outcome.counts_toward_year:
            bad(pid, "a status-excluded project must have counts_toward_year=True")
    return violations


def _check_i51_tier_order(ctx: _Ctx) -> list[InvariantViolation]:
    """I51: over consecutive ids `a, b` of `scheduling_order`, the pair
    (frozen key, `counts_toward_year` key) never decreases: frozen projects
    first, then every counting project, then the queued ones. Unknown ids
    are skipped (I15 / input validation own them)."""

    def tier(pid: str) -> tuple[int, int] | None:
        p = ctx.projects.get(pid)
        if p is None:
            return None
        return (0 if p.frozen else 1, 0 if project_counts_toward_year(p) else 1)

    violations: list[InvariantViolation] = []
    order = ctx.schedule_output.scheduling_order
    for a, b in zip(order, order[1:]):  # noqa: B905
        ta, tb = tier(a), tier(b)
        if ta is None or tb is None or ta <= tb:
            continue
        violations.append(
            InvariantViolation(
                invariant="I51",
                description=(
                    f"scheduling_order has {a!r} (frozen/counts tier {ta}) before {b!r} "
                    f"(tier {tb}): the (frozen, counts_toward_year) tier must not decrease"
                ),
                project_id=b,
            )
        )
    return violations


def _has_anchored_or_pinned_step(project: ProjectInput) -> bool:
    """I52's premise, on the input: a Done / In Progress / Blocked progress
    row, or any manual pin."""

    if project.step_pins:
        return True
    return any(
        pr.status in (STATUS_DONE, STATUS_IN_PROGRESS, STATUS_BLOCKED)
        for pr in project.step_progress
    )


def without_spare_capacity_projects(schedule_input: ScheduleInput) -> ScheduleInput:
    """I52's X⁻: `schedule_input` without its non-frozen projects whose
    `counts_toward_year` is False (queued P3 and non-frozen P4/Q)."""

    return replace(
        schedule_input,
        projects=tuple(
            p for p in schedule_input.projects if p.frozen or project_counts_toward_year(p)
        ),
    )


def check_band_neutrality(
    schedule_input: ScheduleInput,
    solver: str = "greedy",
    **solver_params: object,
) -> tuple[InvariantViolation, ...]:
    """I52 (spare-capacity neutrality, ADR 0056 R42-5 / R42-9). Pure.

    Let X be `schedule_input` and X⁻ = `without_spare_capacity_projects(X)`.
    When no non-frozen non-counting project of X has an anchored (Done, In
    Progress, Blocked) or pinned step, every outcome of a project of X⁻ must
    be identical (every field and row) in run(X) and run(X⁻), for `solver`
    `"greedy"` or `"cp_sat"` (`solver_params` passed to `run_cp_sat`
    unchanged on both runs, i.e. identical parameters).

    The premise is evaluated over the queued (scheduled, non-counting)
    projects only: a non-frozen P4/Q project books nothing whatever its
    progress (R42-3, asserted by I49), so it cannot break neutrality. This
    makes the check apply to strictly more inputs than the literal text.
    Returns `()` when the premise does not hold or X has no such project."""

    if solver not in ("greedy", "cp_sat"):
        raise ValueError(f"unknown solver {solver!r}; expected 'greedy' or 'cp_sat'")
    removed = [
        p
        for p in sorted(schedule_input.projects, key=lambda p: p.project_id)
        if not p.frozen and not project_counts_toward_year(p)
    ]
    if not removed:
        return ()
    if any(_has_anchored_or_pinned_step(p) for p in removed if not is_not_scheduled_priority(p)):
        return ()
    reduced = without_spare_capacity_projects(schedule_input)
    if solver == "greedy":
        full_out = run_greedy_sgs(schedule_input)
        reduced_out = run_greedy_sgs(reduced)
    else:
        from scheduling.cp_sat import run_cp_sat  # local: cp_sat imports this module's peers

        full_out, _ = run_cp_sat(schedule_input, **solver_params)  # type: ignore[arg-type]
        reduced_out, _ = run_cp_sat(reduced, **solver_params)  # type: ignore[arg-type]
    full_by_id = {o.project_id: o for o in full_out.project_outcomes}
    violations: list[InvariantViolation] = []
    for o in reduced_out.project_outcomes:
        other = full_by_id.get(o.project_id)
        if other != o:
            violations.append(
                InvariantViolation(
                    invariant="I52",
                    description=(
                        f"project {o.project_id!r}: its {solver} outcome differs between the "
                        f"input and the input without its {len(removed)} non-frozen "
                        "non-counting project(s): queued / P4 work took capacity from counting "
                        "work"
                    ),
                    project_id=o.project_id,
                )
            )
    return tuple(violations)
