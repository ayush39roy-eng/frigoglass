"""CP-SAT model for the same RCPSP-shaped scheduling problem `greedy.py` solves
by construction (greedy SGS). This module solves it as a constraint-optimization
problem instead: interval variables + `AddNoOverlap` per engineer, `AddCumulative`
per chamber, objective = maximise weighted value of projects completing within
year (`WITHIN_YEAR_WEEK`), subject to Invariant I3 precedence.

Speaks the exact same `ScheduleInput`/`ScheduleOutput` dataclass contract as
`scheduling.greedy.run_greedy_sgs` (P2-T01) — same input, same output shape —
so P2-T07's solver-comparison harness can diff the two field-by-field on
identical input. See `docs/MEMORY.md`'s P2-T06 entry for the full design
rationale; this docstring covers the parts a future reader needs without
re-reading that entry.

--------------------------------------------------------------------------
THE HIGHEST-RISK MODELLING DECISION IN THIS MODULE, read before editing:
--------------------------------------------------------------------------
A naive model that feeds ALL projects (frozen and non-frozen) as peers into one
hard `AddNoOverlap`/`AddCumulative` constraint set goes INFEASIBLE the instant
two *frozen* projects genuinely conflict (same engineer/overlapping weeks, or
same chamber/over capacity) -- frozen dates are fixed constants with zero
slack, and DOMAIN_RULES.md says a frozen-vs-frozen conflict is a WARNING
(`ENG_CONFLICT`/`OVERLAP`), never a scheduling blocker. A hard CP-SAT
constraint has no way to "flag and continue" the way greedy.py's procedural
walk does.

**Resolution: frozen projects are never CP-SAT decision variables at all.**
Frozen projects' schedules are already fully deterministic (no search needed —
design steps sit at `actual_start_week` sequentially; lab steps go to "the
first eligible chamber in chamber_id-sorted order", exactly greedy.py's already
-reviewed-and-accepted logic). This module pre-resolves every frozen project's
full schedule OUTSIDE the solver by calling `scheduling.greedy.run_greedy_sgs`
on a `ScheduleInput` containing *only* the frozen projects (see the
"Pre-resolve frozen projects" block inside `run_cp_sat` below for why this is
provably identical to running the full greedy walk and taking just the
frozen-project outcomes: greedy's sort key
puts every frozen project before every non-frozen one, and a frozen project's
booking never depends on anything about a *later*-processed project — only on
previously-processed frozen projects, which are present, in the same relative
order, in the frozen-only sub-input too).

The frozen projects' resulting resource consumption (which engineer-weeks and
which chamber-project-weeks they occupy) is then fed into the CP-SAT model as
**fixed background occupancy** that the non-frozen, CP-SAT-optimised projects
must route around — mirroring exactly how greedy.py handles it (frozen
projects go first, consuming capacity; non-frozen projects search around it).
`ENG_CONFLICT`/`OVERLAP` for frozen projects are copied verbatim from that
pre-resolution; no CP-SAT variable is ever created for a frozen project.

Two further infeasibility traps this design specifically avoids, both regarding
how the background occupancy is fed into the hard constraints:

1. **Engineer background (`AddNoOverlap`)**: if a frozen ENG_CONFLICT exists
   (two frozen projects double-book the same engineer/week), naively adding
   *both* frozen projects' design-step intervals as separate fixed
   (non-optional) intervals into that engineer's `AddNoOverlap` list would
   itself be infeasible (two mandatory, overlapping intervals can never
   satisfy "no overlap"). Fix: the frozen-occupied weeks per engineer are
   first collapsed into a *set* (dedup — "is this week busy at all", exactly
   what greedy's own `eng_busy: dict[str, set[int]]` tracks), then merged into
   disjoint contiguous ranges. Two frozen projects piling onto the same week
   collapse into ONE occupied week in the set, so the derived background
   intervals never overlap each other by construction, regardless of how many
   frozen projects contributed to a given week.
2. **Chamber background (`AddCumulative`)**: chambers have `max_concurrent`
   potentially > 1, so naive per-week frozen demand (which CAN legitimately
   exceed `max_concurrent` — that is exactly what an OVERLAP conflict *is*)
   cannot be fed into `AddCumulative` unmodified: a mandatory (always-present)
   background interval whose demand alone exceeds the chamber's capacity makes
   that `AddCumulative` call infeasible before any non-frozen interval is even
   considered. Fix: the background chamber demand fed into the solver is
   capped at `chamber.max_concurrent` per week
   (`min(actual_frozen_demand, max_concurrent)`). This guarantees the
   mandatory portion of every `AddCumulative` call never alone exceeds its own
   capacity ceiling, so frozen-vs-frozen chamber conflicts can never make the
   model infeasible either — the real over-booking is still correctly reported
   via the pre-resolved `OVERLAP` flag (computed by greedy.py's logic, outside
   the solver), exactly matching DOMAIN_RULES.md's "warning, not a blocker"
   semantics.

Both mechanisms are pure Python-level aggregation performed before the model
is built — no CP-SAT constraint here can ever be asked to prove a frozen-vs-
frozen conflict "doesn't happen", because DOMAIN_RULES.md says it may.
See `_selftest_cp_sat.py::scenario_two_frozen_projects_engineer_conflict` and
`::scenario_two_frozen_projects_chamber_overlap` for the tests that exercise
exactly this path end-to-end (two genuinely conflicting frozen projects,
confirmed FEASIBLE with `eng_conflict=True`/`overlap=True` raised, not
INFEASIBLE).

--------------------------------------------------------------------------
Objective weighting -- a genuine DOMAIN_RULES.md gap, resolved here, flagged
for the orchestrator/client to revisit if a real numeric scheme is specified:
--------------------------------------------------------------------------
DOMAIN_RULES.md defines the 13-dimension *scoring formula* that produces a
priority *band* (P1-P4/Q) and the greedy scheduler's *sort order*
(P1->P2->P3->P4->Q) -- neither is a numeric objective weight a CP-SAT
`Maximize()` call can use directly, and `ProjectInput` (P2-T01) only carries
the priority band string, not the full 13-dimension weighted score. Chosen
here: a simple ordinal weight derived from the band,
`{"P1": 4, "P2": 3, "P3": 2, "P4": 1, "Q": 0}`, maximising
`sum(weight[project.priority] * within_year[project] for project in solvable)`
-- i.e. maximise the priority-weighted count of projects that both get
scheduled at all (not LEFT_OUT) AND complete within year (`WITHIN_YEAR_WEEK`).
This is a reasonable, defensible default (higher band -> higher weight,
matching the sort order's own relative importance) but is NOT sourced from any
DOMAIN_RULES.md text -- it is an explicit gap-fill, not a silent invention.
See `docs/MEMORY.md`'s P2-T06 entry for the full reasoning.

A small, coarse secondary (tie-break) term is added on top of this primary
term -- see `run_cp_sat`'s "Objective" section for the exact formula and why
it exists (preventing CP-SAT from leaving a perfectly schedulable project
LEFT_OUT purely because doing so scores identically under the primary term
alone). This secondary term is this module's own addition, also not
DOMAIN_RULES.md-sourced, and is scaled to never override the primary term's
ranking.

--------------------------------------------------------------------------
Purity / determinism
--------------------------------------------------------------------------
Same purity contract as the rest of `backend/scheduling/`: no DB/network/
filesystem access, no wall-clock dependence. This module does import
`ortools.sat.python.cp_model`, a pure numerical solver library with no I/O
of its own (same category of dependency as `domain_constants`).

Determinism (Invariant I8, as literally worded in DOMAIN_RULES.md) is scoped
to "the greedy scheduler" specifically -- it does not, on its own text,
require CP-SAT's output to be byte-identical across runs. This module still
makes a genuine best effort at CP-SAT determinism (`num_search_workers=1`,
fixed `random_seed`) since the algorithm-engineer role's own "Determinism is
mandatory" instruction reads more broadly than I8's literal text -- but a
solver operating under a wall-clock `max_time_in_seconds` budget cannot
formally guarantee byte-identical results across machines the way a pure,
unbounded greedy walk can (a well-known, inherent property of time-limited
search, not a bug in this implementation). See the P2-T06 MEMORY.md entry for
the empirical determinism check performed on the real 46-project dataset and
exactly what was found.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ortools.sat.python import cp_model

import domain_constants as dc
from scheduling.greedy import (
    _duration_weeks,
    _excluded_outcome,
    _is_oem_hub,
    _lab_region_for_hub,
    _sort_key,
    _validate_schedulable_project,
    run_greedy_sgs,
)
from scheduling.types import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
    WorkflowStepTemplate,
)

# Ordinal objective weight derived from the priority band -- see the module
# docstring's "Objective weighting" section for why this is a documented
# gap-fill, not a DOMAIN_RULES.md-sourced constant.
PRIORITY_OBJECTIVE_WEIGHT: dict[str, int] = {"P1": 4, "P2": 3, "P3": 2, "P4": 1, "Q": 0}

DEFAULT_MAX_TIME_IN_SECONDS: float = 60.0
DEFAULT_RANDOM_SEED: int = 2026


@dataclass(frozen=True)
class CpSatSolveInfo:
    """Solver diagnostics, returned alongside the `ScheduleOutput` by
    `run_cp_sat` -- NOT part of the shared `ScheduleOutput` contract itself
    (P2-T07's diff harness only needs `ScheduleOutput` to be identical-shaped
    between solvers; these fields are CP-SAT-specific extras).
    """

    status_name: str  # "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNKNOWN" | ...
    # `objective_value`/`best_objective_bound` report the PRIMARY objective
    # term only (sum of priority weight * within_year, re-derived from the
    # solved variable values) -- NOT the raw scaled `_TIEBREAK_SCALE *
    # primary - secondary` value CP-SAT's own `ObjectiveValue()`/
    # `BestObjectiveBound()` return internally, which would be a
    # meaningless-looking large number to any caller unaware of the
    # tie-break scaling. See `run_cp_sat`'s "Objective" section.
    objective_value: float
    best_objective_bound: float
    wall_time_seconds: float
    num_solvable_projects: int
    num_frozen_projects: int
    num_pre_resolved_left_out: int  # no_leader + no_eligible_chamber, resolved outside the solver


def _upper_bound_slack(steps: tuple[WorkflowStepTemplate, ...], project: ProjectInput) -> int:
    """A generous upper-bound slack added on top of `horizon_weeks` for a
    project's start/end IntVar domains, so the "not present" case always has
    a valid, non-empty domain regardless of how the project's earliest-start
    floor (`current_week`/`actual_start_week`) relates to `horizon_weeks` --
    see the `upper_bound` comment inside `run_cp_sat` for why this matters
    (capping the raw domain at exactly `horizon` made the whole model
    INFEASIBLE, not just `present=False`, for a project with no room left
    before the horizon -- a real bug caught during this task's own
    verification). Sized to the project's own total workflow duration (sum of
    every step's `duration_weeks`), which is always enough slack for the full
    sequential step chain to fit even if it hypothetically started at
    `horizon` itself.
    """

    return sum(
        _duration_weeks(s.base_weeks, project.category)  # type: ignore[arg-type]
        for s in steps
    )


# --- Public entry point -------------------------------------------------------


def run_cp_sat(
    schedule_input: ScheduleInput,
    *,
    max_time_in_seconds: float = DEFAULT_MAX_TIME_IN_SECONDS,
    num_search_workers: int = 1,
    random_seed: int = DEFAULT_RANDOM_SEED,
    warm_start_hint: bool = True,
) -> tuple[ScheduleOutput, CpSatSolveInfo]:
    """CP-SAT solve for `schedule_input`. Returns `(ScheduleOutput,
    CpSatSolveInfo)` -- the first element is the shared contract P2-T07's diff
    harness compares against `run_greedy_sgs`'s output; the second is
    solver-specific diagnostics.

    `num_search_workers=1` (single-threaded) is the default specifically for
    determinism (see module docstring) -- callers who want faster wall-clock
    solves at the cost of a weaker (empirically-observed-only, not formally
    guaranteed) determinism claim may pass a higher value.

    `warm_start_hint=True` (default) runs `run_greedy_sgs(schedule_input)`
    once and feeds its result in via `AddHint` on the decision variables
    (`scheduling-algorithms` skill's guidance) -- CP-SAT converges faster from
    a known-feasible starting point.

    Never invoked from a request-handling process (Standing Decision) -- this
    module contains no web-framework code at all, so that constraint is
    satisfied structurally; dispatching this function from a Celery worker is
    P3's job, out of this task's scope.
    """

    if schedule_input.horizon_weeks < 1:
        raise ValueError("horizon_weeks must be >= 1")

    engineers_by_id: dict[str, EngineerInput] = {e.engineer_id: e for e in schedule_input.engineers}
    chambers_by_id: dict[str, ChamberInput] = {c.chamber_id: c for c in schedule_input.chambers}
    steps_sorted: tuple[WorkflowStepTemplate, ...] = tuple(
        sorted(schedule_input.workflow_steps, key=lambda s: s.sequence_order)
    )

    excluded: list[ProjectInput] = []
    schedulable: list[ProjectInput] = []
    for project in schedule_input.projects:
        if project.status in dc.SCHEDULABLE_STATUS_ORDER:
            schedulable.append(project)
        else:
            excluded.append(project)
    for project in schedulable:
        _validate_schedulable_project(project)

    frozen = [p for p in schedulable if p.frozen]
    non_frozen = [p for p in schedulable if not p.frozen]

    # --- Pre-resolve frozen projects entirely outside the solver ------------
    # See module docstring: this is provably identical to the frozen-project
    # subset of a full greedy run, since greedy processes all frozen projects
    # strictly before all non-frozen ones and a frozen project's booking never
    # depends on anything about a later-processed (non-frozen) project.
    frozen_input = ScheduleInput(
        projects=tuple(frozen),
        engineers=schedule_input.engineers,
        chambers=schedule_input.chambers,
        workflow_steps=schedule_input.workflow_steps,
        current_week=schedule_input.current_week,
        horizon_weeks=schedule_input.horizon_weeks,
        within_year_week=schedule_input.within_year_week,
    )
    frozen_output = run_greedy_sgs(frozen_input)
    frozen_outcomes_by_id = {o.project_id: o for o in frozen_output.project_outcomes}

    # --- Pre-resolve non-frozen projects that need no search at all ---------
    # "No leader" and "some lab step has zero eligible chambers" are both
    # unconditional, timing-independent dead ends (greedy.py hits them via an
    # early continue/break, never attempting a booking) -- no CP-SAT variable
    # is worth creating for these; compute their outcomes directly, mirroring
    # greedy.py's own branches exactly (same field values it would produce).
    pre_resolved_left_out: dict[str, ProjectScheduleOutcome] = {}
    solvable: list[ProjectInput] = []
    for project in non_frozen:
        leader = (
            engineers_by_id.get(project.leader_engineer_id) if project.leader_engineer_id else None
        )
        if leader is None:
            pre_resolved_left_out[project.project_id] = _no_leader_outcome(project)
            continue

        region = _lab_region_for_hub(project.hub)
        missing_chamber_step: str | None = None
        for step in steps_sorted:
            if step.kind != "lab":
                continue
            eligible = [
                c
                for c in chambers_by_id.values()
                if c.lab_region == region and step.step_id in c.allowed_stages
            ]
            if not eligible:
                missing_chamber_step = step.step_id
                break
        if missing_chamber_step is not None:
            pre_resolved_left_out[project.project_id] = _no_chamber_outcome(
                project, missing_chamber_step, leader
            )
            continue

        solvable.append(project)

    # --- Background occupancy from frozen projects ---------------------------
    eng_busy_weeks: dict[str, set[int]] = {e.engineer_id: set() for e in schedule_input.engineers}
    chamber_demand: dict[str, dict[int, int]] = {c.chamber_id: {} for c in schedule_input.chambers}
    for outcome in frozen_output.project_outcomes:
        for step in outcome.steps:
            if step.kind == "design" and step.assigned_engineer_id is not None:
                eng_busy_weeks.setdefault(step.assigned_engineer_id, set()).update(
                    range(step.start_week, step.end_week + 1)
                )
            elif step.kind == "lab" and step.assigned_chamber_id is not None:
                per_week = chamber_demand.setdefault(step.assigned_chamber_id, {})
                for wk in range(step.start_week, step.end_week + 1):
                    per_week[wk] = per_week.get(wk, 0) + 1

    # --- Build the CP-SAT model ----------------------------------------------
    model = cp_model.CpModel()
    horizon = schedule_input.horizon_weeks
    current_week = schedule_input.current_week

    present: dict[str, cp_model.IntVar] = {}
    starts: dict[tuple[str, str], cp_model.IntVar] = {}
    ends: dict[tuple[str, str], cp_model.IntVar] = {}
    within_year_var: dict[str, cp_model.IntVar] = {}
    assign: dict[tuple[str, str, str], cp_model.IntVar] = {}

    engineer_intervals: dict[str, list[cp_model.IntervalVar]] = {
        e.engineer_id: [] for e in schedule_input.engineers
    }
    chamber_intervals: dict[str, list[cp_model.IntervalVar]] = {
        c.chamber_id: [] for c in schedule_input.chambers
    }
    chamber_demands: dict[str, list[int]] = {c.chamber_id: [] for c in schedule_input.chambers}

    for project in solvable:
        pid = project.project_id
        present[pid] = model.NewBoolVar(f"present[{pid}]")

        # Earliest-start floor: identical rule to greedy.py's non-frozen path
        # (P2-T01 MEMORY.md's "earliest-start floor" resolution) -- search
        # starts at current_week, honouring actual_start_week as a further
        # lower bound only if it happens to be populated and later.
        lower_bound = current_week
        if project.actual_start_week is not None:
            lower_bound = max(lower_bound, project.actual_start_week)

        leader = engineers_by_id[project.leader_engineer_id]  # guaranteed resolvable (pre-filtered)
        region = _lab_region_for_hub(project.hub)

        # Domain upper bound deliberately widened well beyond `horizon` (not
        # capped at it) -- see the comment on `_upper_bound_slack` below for
        # why capping the raw IntVar domain at `horizon` would silently make
        # the "not present" case infeasible too (a real bug caught and fixed
        # during this task's own verification: a project whose earliest
        # possible start already leaves no room before `horizon` was making
        # the *entire* model INFEASIBLE, not correctly resolving to
        # `present=False`/LEFT_OUT, because the domain ceiling is an
        # unconditional IntVar constraint that CP-SAT cannot relax based on a
        # presence literal, unlike a `model.Add(...)` constraint). The actual
        # "must complete within horizon" rule is instead enforced by an
        # explicit constraint below, reified on `present[pid]` specifically.
        upper_bound = horizon + _upper_bound_slack(steps_sorted, project)

        prev_end: cp_model.IntVar | None = None
        for step in steps_sorted:
            duration = _duration_weeks(step.base_weeks, project.category)  # type: ignore[arg-type]
            key = (pid, step.step_id)
            start_var = model.NewIntVar(lower_bound, upper_bound, f"start[{pid},{step.step_id}]")
            end_var = model.NewIntVar(lower_bound, upper_bound, f"end[{pid},{step.step_id}]")
            # `end == start + duration` is deliberately NOT added here as an
            # unconditional `model.Add(...)` -- each step's
            # `NewOptionalIntervalVar(start_var, duration, end_var, ...)`
            # (design steps below, or per-candidate-chamber for lab steps)
            # already enforces exactly this relationship, but ONLY while its
            # own presence literal is true, which is precisely the
            # "not present -> no constraint at all, free to satisfy trivially"
            # behaviour the LEFT_OUT / optional-interval design needs.
            starts[key] = start_var
            ends[key] = end_var

            if prev_end is not None:
                model.Add(start_var >= prev_end)  # Invariant I3
            prev_end = end_var

            if step.kind == "design":
                interval = model.NewOptionalIntervalVar(
                    start_var, duration, end_var, present[pid], f"iv[{pid},{step.step_id}]"
                )
                engineer_intervals[leader.engineer_id].append(interval)
            else:
                eligible = sorted(
                    (
                        c
                        for c in chambers_by_id.values()
                        if c.lab_region == region and step.step_id in c.allowed_stages
                    ),
                    key=lambda c: c.chamber_id,
                )
                assign_vars = []
                for chamber in eligible:
                    akey = (pid, step.step_id, chamber.chamber_id)
                    a = model.NewBoolVar(f"assign[{pid},{step.step_id},{chamber.chamber_id}]")
                    assign[akey] = a
                    interval = model.NewOptionalIntervalVar(
                        start_var,
                        duration,
                        end_var,
                        a,
                        f"iv[{pid},{step.step_id},{chamber.chamber_id}]",
                    )
                    chamber_intervals[chamber.chamber_id].append(interval)
                    chamber_demands[chamber.chamber_id].append(1)
                    assign_vars.append(a)
                # Exactly one eligible chamber chosen if (and only if) the
                # project is present at all -- matches Invariant I5's "fully
                # scheduled or fully LEFT_OUT" via a single shared per-project
                # presence literal, per the scheduling-algorithms skill.
                model.Add(sum(assign_vars) == present[pid])

        # `within_year[p]`: reified from the last step's completion week +
        # delay_weeks (ADR 0004 -- delay is a terminal adjustment, applied
        # only to this check, never propagated into step dates), forced to
        # False whenever the project is not present (see module docstring:
        # without this, the objective could spuriously reward
        # within_year=True for a project that was never actually scheduled).
        last_step_id = steps_sorted[-1].step_id
        last_end = ends[(pid, last_step_id)]
        # The actual "must finish within horizon_weeks" rule (greedy.py's
        # `w + duration <= horizon_weeks` check, i.e. `end <= horizon` in this
        # module's exclusive-end convention) -- reified on `present[pid]`
        # specifically so an infeasible-within-horizon project resolves to
        # `present=False` (LEFT_OUT) rather than making the whole model
        # INFEASIBLE (see the domain-widening comment above `upper_bound`).
        model.Add(last_end <= horizon).OnlyEnforceIf(present[pid])
        completion = model.NewIntVar(
            lower_bound - 1, upper_bound + project.delay_weeks, f"completion[{pid}]"
        )
        model.Add(completion == last_end - 1 + project.delay_weeks)
        wy = model.NewBoolVar(f"within_year[{pid}]")
        model.Add(completion <= schedule_input.within_year_week).OnlyEnforceIf(wy)
        model.Add(completion > schedule_input.within_year_week).OnlyEnforceIf(wy.Not())
        model.Add(wy <= present[pid])
        within_year_var[pid] = wy

    # --- Background occupancy: engineers (AddNoOverlap) -----------------------
    for engineer_id, busy_weeks in eng_busy_weeks.items():
        for range_start, range_len in _contiguous_ranges(busy_weeks):
            engineer_intervals.setdefault(engineer_id, []).append(
                model.NewIntervalVar(
                    range_start,
                    range_len,
                    range_start + range_len,
                    f"frozen_busy[{engineer_id},{range_start}]",
                )
            )
    for engineer_id in sorted(engineer_intervals):
        if engineer_intervals[engineer_id]:
            model.AddNoOverlap(engineer_intervals[engineer_id])

    # --- Background occupancy: chambers (AddCumulative) ------------------------
    for chamber_id, per_week in chamber_demand.items():
        chamber = chambers_by_id.get(chamber_id)
        max_concurrent = chamber.max_concurrent if chamber is not None else 0
        for range_start, range_len, demand in _contiguous_demand_ranges(per_week):
            capped = min(demand, max_concurrent) if chamber_id in chambers_by_id else 0
            if capped <= 0:
                continue
            chamber_intervals.setdefault(chamber_id, []).append(
                model.NewIntervalVar(
                    range_start,
                    range_len,
                    range_start + range_len,
                    f"frozen_demand[{chamber_id},{range_start}]",
                )
            )
            chamber_demands.setdefault(chamber_id, []).append(capped)
    for chamber_id in sorted(chamber_intervals):
        if chamber_intervals[chamber_id]:
            model.AddCumulative(
                chamber_intervals[chamber_id],
                chamber_demands[chamber_id],
                chambers_by_id[chamber_id].max_concurrent,
            )

    # --- Objective --------------------------------------------------------------
    # Primary term: DOMAIN_RULES.md's stated objective, "maximise weighted
    # value of projects completing by week 52" -- see the module docstring's
    # "Objective weighting" section for `PRIORITY_OBJECTIVE_WEIGHT`'s
    # provenance (a documented gap-fill, not sourced from DOMAIN_RULES.md
    # text).
    #
    # Secondary term (lexicographic tie-break, this module's own addition,
    # NOT DOMAIN_RULES.md-sourced, kept deliberately coarse): among solutions
    # tied on the primary term, prefer actually scheduling a project
    # (`present=True`) over leaving it LEFT_OUT for no reason. Scaled by
    # `_TIEBREAK_SCALE` (larger than the maximum possible secondary swing,
    # `len(solvable)`) so it can never trade off against the primary
    # objective -- it only resolves otherwise-arbitrary ties.
    #
    # Without ANY secondary term, CP-SAT is free to leave a perfectly
    # schedulable project LEFT_OUT purely because doing so scores identically
    # to scheduling it under the primary term alone (e.g. a Q-priority project
    # whose `within_year` contributes weight 0 either way) -- caught
    # empirically during this task's own verification (the spillover-boundary
    # golden-file scenario, adapted from `_selftest.py`, was spuriously
    # resolving to LEFT_OUT instead of "scheduled but late" before this term
    # was added). See the P2-T06 MEMORY.md entry.
    #
    # A finer-grained secondary term that also minimised exact completion
    # weeks (preferring the earliest possible placement among ties) was tried
    # first and rejected: it made the real 46-project dataset's solve
    # timeout at 60s without proving optimality (and non-deterministic
    # results across runs, since the time-limited search grabbed whatever
    # feasible point it reached first) -- minimising exact timing across
    # every tied, priority-irrelevant project is a much harder combinatorial
    # search than simply maximising how many are present at all. This coarser
    # `present`-count term is `O(len(solvable))`-cheap for CP-SAT to satisfy
    # and was empirically confirmed (P2-T06 MEMORY.md entry) to keep the real
    # dataset's solve at well under a second, reaching OPTIMAL.
    _TIEBREAK_SCALE = len(solvable) + 1
    primary = sum(
        PRIORITY_OBJECTIVE_WEIGHT.get(p.priority, 0) * within_year_var[p.project_id]
        for p in solvable
    )
    presence_tiebreak = sum(present[p.project_id] for p in solvable)
    model.Maximize(_TIEBREAK_SCALE * primary + presence_tiebreak)

    # --- Warm start -----------------------------------------------------------
    if warm_start_hint and solvable:
        _apply_greedy_hint(
            model=model,
            schedule_input=schedule_input,
            solvable_ids={p.project_id for p in solvable},
            present=present,
            starts=starts,
            ends=ends,
            assign=assign,
        )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_time_in_seconds
    solver.parameters.num_search_workers = num_search_workers
    solver.parameters.random_seed = random_seed
    status = solver.Solve(model)
    status_name = solver.StatusName(status)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # Per the scheduling-algorithms skill: INFEASIBLE should never happen
        # for this model (every decision project has an always-valid "absent"
        # fallback) -- if it does, that is a modelling bug, not a domain
        # outcome, and callers should see it loudly rather than receive a
        # silently-empty ScheduleOutput.
        raise RuntimeError(
            f"CP-SAT solve did not reach OPTIMAL/FEASIBLE (status={status_name}); "
            "this indicates a modelling bug -- frozen-conflict handling should make "
            "INFEASIBLE structurally unreachable for this model, see module docstring"
        )

    outcomes_by_id: dict[str, ProjectScheduleOutcome] = {}
    for project in solvable:
        outcomes_by_id[project.project_id] = _extract_outcome(
            project=project,
            steps=steps_sorted,
            solver=solver,
            present=present[project.project_id],
            starts=starts,
            ends=ends,
            within_year_var=within_year_var[project.project_id],
            assign=assign,
            leader=engineers_by_id[project.leader_engineer_id],
        )

    for pid, outcome in pre_resolved_left_out.items():
        outcomes_by_id[pid] = outcome
    for pid, outcome in frozen_outcomes_by_id.items():
        outcomes_by_id[pid] = outcome
    for project in excluded:
        outcomes_by_id[project.project_id] = _excluded_outcome(project)

    by_project_id = sorted(schedule_input.projects, key=lambda p: p.project_id)
    project_outcomes = tuple(outcomes_by_id[p.project_id] for p in by_project_id)

    # scheduling_order has no CP-SAT-native meaning (the solver has no
    # sequential walk order the way greedy.py does) -- reported here as the
    # same DOMAIN_RULES.md sort order greedy.py would use over every
    # schedulable (non-excluded) project, purely so a caller comparing this
    # field against greedy's output sees a like-for-like DOMAIN_RULES.md
    # ordering rather than an empty/undefined value. This does NOT reflect
    # anything about CP-SAT's actual internal solve process. See the P2-T06
    # MEMORY.md entry.
    scheduling_order = tuple(p.project_id for p in sorted(schedulable, key=_sort_key))

    primary_value = (
        float(
            sum(
                PRIORITY_OBJECTIVE_WEIGHT.get(p.priority, 0)
                * solver.Value(within_year_var[p.project_id])
                for p in solvable
            )
        )
        if solvable
        else 0.0
    )
    if not solvable:
        primary_bound = 0.0
    elif status == cp_model.OPTIMAL:
        # Proven optimal on the *scaled* objective necessarily means the
        # primary term is optimal too: `_TIEBREAK_SCALE` is large enough that
        # no possible change in the secondary term could make a worse-primary
        # solution score higher overall (see the objective's own comment).
        primary_bound = primary_value
    else:
        # FEASIBLE, not proven OPTIMAL (time limit reached): the raw solver
        # bound is on the *scaled* objective
        # (`_TIEBREAK_SCALE * primary + presence_tiebreak`), not the primary
        # term alone. Since `presence_tiebreak >= 0` always,
        # `primary <= scaled_bound / _TIEBREAK_SCALE`; flooring gives the
        # tightest valid integer upper bound on the primary term.
        primary_bound = math.floor(solver.BestObjectiveBound() / _TIEBREAK_SCALE)

    output = ScheduleOutput(project_outcomes=project_outcomes, scheduling_order=scheduling_order)
    info = CpSatSolveInfo(
        status_name=status_name,
        objective_value=primary_value,
        best_objective_bound=primary_bound,
        wall_time_seconds=solver.WallTime(),
        num_solvable_projects=len(solvable),
        num_frozen_projects=len(frozen),
        num_pre_resolved_left_out=len(pre_resolved_left_out),
    )
    return output, info


# --- Pre-resolution helpers (mirroring greedy.py's own branches exactly) -----


def _no_leader_outcome(project: ProjectInput) -> ProjectScheduleOutcome:
    """Mirrors `greedy._schedule_one_project`'s "no leader" branch exactly --
    see that function's docstring / the P2-T01 MEMORY.md entry for why this is
    an immediate LEFT_OUT with no steps attempted and CAT_NOT_ALLOWED never
    evaluated.
    """

    return ProjectScheduleOutcome(
        project_id=project.project_id,
        excluded=False,
        left_out=True,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=False,
        no_leader=True,
        no_chamber_step_id=None,
        steps=(),
        start_week=None,
        end_week=None,
    )


def _no_chamber_outcome(
    project: ProjectInput, missing_chamber_step: str, leader: EngineerInput
) -> ProjectScheduleOutcome:
    """A non-frozen project with a resolvable leader, but at least one lab
    step has zero eligible chambers (region + allowed_stages match) -- an
    unconditional, timing-independent LEFT_OUT (greedy.py hits the same dead
    end via `break` the first time it reaches this step; the earlier lab/
    design steps it might have booked before then are NOT retained here --
    per this task's explicit instruction, CP-SAT targets I5's cleaner
    "fully scheduled or fully LEFT_OUT" reading rather than replicating
    greedy's partial-retention-on-LEFT_OUT quirk, which was itself an
    artifact of the step-by-step greedy walk, not a DOMAIN_RULES.md
    requirement). `cat_not_allowed` is still evaluated, matching greedy's
    control flow (the leader-exists check happens before any step is walked).
    """

    required_category = "OEM" if _is_oem_hub(project.hub) else project.category
    cat_not_allowed = required_category not in leader.allowed_categories
    return ProjectScheduleOutcome(
        project_id=project.project_id,
        excluded=False,
        left_out=True,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=cat_not_allowed,
        spillover=False,
        within_year=False,
        no_leader=False,
        no_chamber_step_id=missing_chamber_step,
        steps=(),
        start_week=None,
        end_week=None,
    )


def _contiguous_ranges(weeks: set[int]) -> list[tuple[int, int]]:
    """`{10,11,12,20}` -> `[(10,3),(20,1)]` (start, length) -- merges a set of
    individually-occupied weeks into disjoint contiguous ranges, sorted.
    """

    if not weeks:
        return []
    ordered = sorted(weeks)
    ranges: list[tuple[int, int]] = []
    range_start = ordered[0]
    prev = ordered[0]
    for wk in ordered[1:]:
        if wk == prev + 1:
            prev = wk
            continue
        ranges.append((range_start, prev - range_start + 1))
        range_start = wk
        prev = wk
    ranges.append((range_start, prev - range_start + 1))
    return ranges


def _contiguous_demand_ranges(per_week: dict[int, int]) -> list[tuple[int, int, int]]:
    """`{10:2, 11:2, 12:1}` -> `[(10,2,2),(12,1,1)]` (start, length, demand) --
    merges consecutive weeks sharing the *same* demand value into one range,
    so `AddCumulative` gets a compact background-interval list rather than one
    interval per single week. Weeks with demand 0 are simply absent from
    `per_week` and produce no interval.
    """

    if not per_week:
        return []
    ordered_weeks = sorted(per_week)
    ranges: list[tuple[int, int, int]] = []
    range_start = ordered_weeks[0]
    prev = ordered_weeks[0]
    demand = per_week[ordered_weeks[0]]
    for wk in ordered_weeks[1:]:
        if wk == prev + 1 and per_week[wk] == demand:
            prev = wk
            continue
        ranges.append((range_start, prev - range_start + 1, demand))
        range_start = wk
        prev = wk
        demand = per_week[wk]
    ranges.append((range_start, prev - range_start + 1, demand))
    return ranges


# --- Warm start ---------------------------------------------------------------


def _apply_greedy_hint(
    *,
    model: cp_model.CpModel,
    schedule_input: ScheduleInput,
    solvable_ids: set[str],
    present: dict[str, cp_model.IntVar],
    starts: dict[tuple[str, str], cp_model.IntVar],
    ends: dict[tuple[str, str], cp_model.IntVar],
    assign: dict[tuple[str, str, str], cp_model.IntVar],
) -> None:
    """Warm-start CP-SAT with greedy's own output on the SAME `schedule_input`
    (per the `scheduling-algorithms` skill's "feed the greedy SGS result in as
    a hint" guidance) -- runs the full greedy walk once (not just the
    `solvable` subset -- greedy needs the full picture of contention to
    produce a meaningful hint) and hints `present`/`start`/`end`/`assign` for
    every project this CP-SAT model actually has decision variables for.
    """

    # `CpModel.AddHint(var, value)` hints exactly one variable per call (it is
    # NOT a batch/list API despite superficially resembling one) -- each hint
    # below is a separate call, accumulated in a single solution_hint proto
    # under the hood.
    greedy_output = run_greedy_sgs(schedule_input)

    for outcome in greedy_output.project_outcomes:
        if outcome.project_id not in solvable_ids:
            continue
        is_present = not outcome.left_out and not outcome.excluded
        model.AddHint(present[outcome.project_id], 1 if is_present else 0)
        if not is_present:
            continue
        for step in outcome.steps:
            key = (outcome.project_id, step.step_id)
            if key in starts:
                model.AddHint(starts[key], step.start_week)
            if key in ends:
                model.AddHint(ends[key], step.end_week + 1)  # exclusive end
            if step.kind == "lab" and step.assigned_chamber_id is not None:
                akey = (outcome.project_id, step.step_id, step.assigned_chamber_id)
                if akey in assign:
                    model.AddHint(assign[akey], 1)


# --- Extraction ---------------------------------------------------------------


def _extract_outcome(
    *,
    project: ProjectInput,
    steps: tuple[WorkflowStepTemplate, ...],
    solver: cp_model.CpSolver,
    present: cp_model.IntVar,
    starts: dict[tuple[str, str], cp_model.IntVar],
    ends: dict[tuple[str, str], cp_model.IntVar],
    within_year_var: cp_model.IntVar,
    assign: dict[tuple[str, str, str], cp_model.IntVar],
    leader: EngineerInput,
) -> ProjectScheduleOutcome:
    pid = project.project_id
    is_present = bool(solver.Value(present))

    required_category = "OEM" if _is_oem_hub(project.hub) else project.category
    cat_not_allowed = required_category not in leader.allowed_categories

    if not is_present:
        return ProjectScheduleOutcome(
            project_id=pid,
            excluded=False,
            left_out=True,
            eng_conflict=False,
            overlap=False,
            cat_not_allowed=cat_not_allowed,
            spillover=False,
            within_year=False,
            no_leader=False,
            no_chamber_step_id=None,
            steps=(),
            start_week=None,
            end_week=None,
        )

    steps_out: list[StepSchedule] = []
    for step in steps:
        key = (pid, step.step_id)
        start_val = solver.Value(starts[key])
        end_val_exclusive = solver.Value(ends[key])
        chamber_id: str | None = None
        if step.kind == "lab":
            for (p2, s2, c2), var in assign.items():
                if p2 == pid and s2 == step.step_id and solver.Value(var):
                    chamber_id = c2
                    break
        steps_out.append(
            StepSchedule(
                step_id=step.step_id,
                sequence_order=step.sequence_order,
                kind=step.kind,
                start_week=start_val,
                end_week=end_val_exclusive - 1,
                duration_weeks=end_val_exclusive - start_val,
                assigned_engineer_id=leader.engineer_id if step.kind == "design" else None,
                assigned_chamber_id=chamber_id,
            )
        )

    steps_tuple = tuple(steps_out)
    start_week = steps_tuple[0].start_week
    end_week = steps_tuple[-1].end_week
    within_year = bool(solver.Value(within_year_var))
    spillover = not within_year

    return ProjectScheduleOutcome(
        project_id=pid,
        excluded=False,
        left_out=False,
        eng_conflict=False,  # never possible between two non-frozen projects (hard constraints)
        overlap=False,
        cat_not_allowed=cat_not_allowed,
        spillover=spillover,
        within_year=within_year,
        no_leader=False,
        no_chamber_step_id=None,
        steps=steps_tuple,
        start_week=start_week,
        end_week=end_week,
    )
