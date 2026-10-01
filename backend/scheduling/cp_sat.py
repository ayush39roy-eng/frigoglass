"""CP-SAT model for the same RCPSP-shaped scheduling problem `greedy.py` solves
by construction (greedy SGS). This module solves it as a constraint-optimization
problem instead: interval variables + `AddNoOverlap` per engineer, `AddCumulative`
per chamber, precedence per DAG edge (ADR 0009), objective = maximise weighted
value of projects completing within year (`WITHIN_YEAR_WEEK`, ADR 0005).

Speaks the exact same `ScheduleInput`/`ScheduleOutput` dataclass contract as
`scheduling.greedy.run_greedy_sgs` — same input, same output shape — so the
solver-comparison harness can diff the two field-by-field on identical input.

--------------------------------------------------------------------------
THE HIGHEST-RISK MODELLING DECISION IN THIS MODULE, read before editing:
--------------------------------------------------------------------------
A naive model that feeds ALL projects (frozen and non-frozen) as peers into one
hard `AddNoOverlap`/`AddCumulative` constraint set goes INFEASIBLE the instant
two *fixed* placements genuinely conflict (same engineer/overlapping weeks, or
same chamber/over capacity) -- fixed dates have zero slack, and DOMAIN_RULES.md
says such a conflict is a WARNING (`ENG_CONFLICT`/`OVERLAP`), never a
scheduling blocker. A hard CP-SAT constraint has no way to "flag and continue"
the way greedy.py's procedural walk does.

**Resolution: fixed placements are never CP-SAT decision variables.** Three
kinds of placement are fixed before the model is built, using exactly the
greedy module's own (shared) code so the two solvers agree byte-for-byte on
them:

  1. **Frozen projects** — walked first with `greedy._schedule_one_project`
     (dates locked at `actual_start_week`, capacity consumed regardless).
  2. **Anchored steps** (ADR 0006) — `Done` steps at their recorded actuals
     and `In Progress` tails, pre-booked in scheduling order with
     `greedy.prebook_anchored_steps` (capacity consumed only for weeks >=
     CURRENT_WEEK; conflicts flagged, never resolved by moving them — I11).
  3. **Projects that cannot be optimised** — data-error rejections, no
     leader, a lab step with zero eligible chambers, a `Blocked` hold, an
     anchored step behind a not-started predecessor, or a project with no
     searchable step at all. These are resolved with the greedy walk on the
     same shared resource state, before the model is built.

Everything consumed by 1-3 is then fed into the model as **fixed background
occupancy** that the CP-SAT-optimised (Not Started) steps must route around:
engineer-busy weeks are collapsed into a set and merged into disjoint ranges
(so two conflicting fixed bookings never become two overlapping mandatory
intervals), and per-week chamber demand is capped at `max_concurrent` (so a
fixed OVERLAP never makes an `AddCumulative` infeasible on its own). The real
over-booking is still reported via the flags computed outside the solver.

Step kinds (ADR 0007): `design` -> optional interval on the leader's
`AddNoOverlap`; `lab` -> one optional interval per eligible chamber (exactly
one chosen iff present) at demand 1.0 per project-week on that chamber's
`AddCumulative`; `elapsed` -> `end == start + duration` only, no resource;
`skipped` -> no variables, `end = max(pred.end)` (transparent). Precedence:
`start >= pred.end` (exclusive-end convention) per DAG edge.

Objective weighting: ADR 0005 (documented gap-fill, not DOMAIN_RULES.md text)
-- `PRIORITY_OBJECTIVE_WEIGHT = {P1:4, P2:3, P3:2, P4:1, Q:0}` times
`within_year`, plus a coarse presence tie-break scaled so it can never
override the primary term.

Purity / determinism: same contract as the rest of the package (no I/O;
`ortools.sat.python.cp_model` is a pure solver library). `num_search_workers=1`
and a fixed `random_seed` by default. Both passes are bounded by CP-SAT
*deterministic* time only, never wall-clock (DOMAIN_RULES "Gate remediation
rulings" #6, ADR 0011 Amendment), so a re-run on identical input gives
identical output on any machine. The pass-1 status ("OPTIMAL" / "FEASIBLE")
is returned as `ScheduleOutput.solver_status`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ortools.sat.python import cp_model

from scheduling.greedy import (
    RunContext,
    _cat_not_allowed,
    _data_error_outcome,
    _eligible_chambers,
    _excluded_outcome,
    _expected_end_week,
    _lab_region_for_hub,
    _no_leader_outcome,
    _Placement,
    _ResourceState,
    _schedule_one_project,
    apply_eng_conflict_flags,
    prebook_anchored_steps,
    prepare_run,
    run_greedy_sgs,
)
from scheduling.types import (
    EngineerInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
)
from scheduling.workflow import (
    ProjectPlan,
    compute_progress_pct,
    first_step_frontier,
    unconstrained_end_week,
)

# Ordinal objective weight derived from the priority band -- ADR 0005.
PRIORITY_OBJECTIVE_WEIGHT: dict[str, int] = {"P1": 4, "P2": 3, "P3": 2, "P4": 1, "Q": 0}

#: Pass-1 (ADR 0005 portfolio objective) budget, in CP-SAT *deterministic*
#: time units. Ruling 6: never a wall-clock limit. Sized in P9-R01 on the real
#: DB seed (46 projects, 10 workbook chambers): 15 + 4 units took ~51 s wall
#: (FEASIBLE, objective 31, bound 34). 10, 15 and 20 units all reach the same
#: pass-1 solution there; 20 + 5 costs ~67 s for byte-identical output.
DEFAULT_DETERMINISTIC_TIME: float = 15.0
DEFAULT_RANDOM_SEED: int = 2026
#: Budget for the phase-2 earliness pass, in CP-SAT *deterministic* time units
#: (reproducible across runs and machines, unlike wall-clock seconds).
DEFAULT_EARLINESS_DETERMINISTIC_TIME: float = 4.0


@dataclass(frozen=True)
class CpSatSolveInfo:
    """Solver diagnostics, returned alongside the `ScheduleOutput` by
    `run_cp_sat` -- NOT part of the shared `ScheduleOutput` contract itself.
    """

    status_name: str  # "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNKNOWN" | ...
    # PRIMARY objective term only (Σ priority weight × within_year over the
    # solvable projects) -- not the raw scaled value CP-SAT reports internally.
    objective_value: float
    best_objective_bound: float
    wall_time_seconds: float
    num_solvable_projects: int
    num_frozen_projects: int
    # Non-frozen projects resolved outside the solver: no_leader, no eligible
    # chamber, data_error, Blocked hold, anchored-behind-not-started, or
    # nothing left to search.
    num_pre_resolved_left_out: int


@dataclass
class _ProjectVars:
    present: cp_model.IntVar
    within_year: cp_model.IntVar
    starts: dict[str, cp_model.IntVar]  # searched steps only
    ends: dict[str, cp_model.IntVar]  # exclusive end, searched steps only
    ends_excl: dict[str, cp_model.IntVar | int]  # every step
    assign: dict[tuple[str, str], cp_model.IntVar]  # (step_id, chamber_id)
    prebooked: dict[str, _Placement]
    last_end: cp_model.IntVar


# --- Public entry point -------------------------------------------------------


def run_cp_sat(
    schedule_input: ScheduleInput,
    *,
    deterministic_time: float = DEFAULT_DETERMINISTIC_TIME,
    max_time_in_seconds: float | None = None,
    num_search_workers: int = 1,
    random_seed: int = DEFAULT_RANDOM_SEED,
    warm_start_hint: bool = True,
    earliness_deterministic_time: float = DEFAULT_EARLINESS_DETERMINISTIC_TIME,
) -> tuple[ScheduleOutput, CpSatSolveInfo]:
    """CP-SAT solve for `schedule_input`. Returns `(ScheduleOutput, CpSatSolveInfo)`.

    `num_search_workers=1` (single-threaded) is the default specifically for
    determinism. `warm_start_hint=True` feeds `run_greedy_sgs`'s result in via
    `AddHint`. Never invoked from a request-handling process (Standing
    Decision) -- dispatch is the Celery worker's job.

    `deterministic_time` bounds pass 1 and `earliness_deterministic_time`
    bounds pass 2, both in CP-SAT deterministic-time units (ruling 6).
    `max_time_in_seconds` is **accepted and ignored**: it is kept only so the
    existing Celery call site keeps working; a wall-clock limit would make the
    result depend on machine speed.
    """

    _ = max_time_in_seconds  # deliberately unused (ruling 6)

    ctx = prepare_run(schedule_input)
    state = _ResourceState(schedule_input)
    horizon = schedule_input.horizon_weeks
    current_week = schedule_input.current_week

    frozen = [p for p in ctx.ordered if p.frozen]
    non_frozen = [p for p in ctx.ordered if not p.frozen]

    outcomes_by_id: dict[str, ProjectScheduleOutcome] = {}

    # --- 1. Frozen projects: fixed, walked with the shared greedy code -------
    for project in frozen:
        outcomes_by_id[project.project_id] = _schedule_one_project(
            ctx, state, ctx.plans[project.project_id], prebooked={}, pre_flags=(False, False)
        )

    # --- 2. Anchored steps (Done / In Progress) pre-booked in scheduling order
    prebooked_all, pre_flags_all = prebook_anchored_steps(ctx, state, non_frozen)

    # --- 3. Projects that cannot be optimised: resolved outside the solver ---
    solvable: list[ProjectInput] = []
    num_pre_resolved = 0
    for project in non_frozen:
        pid = project.project_id
        plan = ctx.plans[pid]
        prebooked = prebooked_all.get(pid, {})
        pre_flags = pre_flags_all.get(pid, (False, False))

        if plan.data_error is not None:
            outcomes_by_id[pid] = _data_error_outcome(project, plan)
            num_pre_resolved += 1
            continue
        leader = ctx.engineers_by_id.get(project.leader_engineer_id or "")
        if leader is None:
            outcomes_by_id[pid] = _no_leader_outcome(project, plan, current_week)
            num_pre_resolved += 1
            continue
        if _needs_greedy(ctx, plan, prebooked):
            outcomes_by_id[pid] = _schedule_one_project(
                ctx, state, plan, prebooked=prebooked, pre_flags=pre_flags
            )
            num_pre_resolved += 1
            continue
        solvable.append(project)

    # --- 4. Build the CP-SAT model over the searchable steps -----------------
    model = cp_model.CpModel()
    engineer_intervals: dict[str, list[cp_model.IntervalVar]] = {
        e.engineer_id: [] for e in schedule_input.engineers
    }
    chamber_intervals: dict[str, list[cp_model.IntervalVar]] = {
        c.chamber_id: [] for c in schedule_input.chambers
    }
    chamber_demands: dict[str, list[int]] = {c.chamber_id: [] for c in schedule_input.chambers}
    project_vars: dict[str, _ProjectVars] = {}

    for project in solvable:
        pid = project.project_id
        plan = ctx.plans[pid]
        prebooked = prebooked_all.get(pid, {})
        leader = ctx.engineers_by_id[project.leader_engineer_id]  # type: ignore[index]
        region = _lab_region_for_hub(project.hub)
        frontier = first_step_frontier(project, current_week)

        # Domain upper bound deliberately widened beyond `horizon` (P2-T06:
        # capping the raw IntVar domain at `horizon` made the whole model
        # INFEASIBLE instead of resolving to present=False). The "must finish
        # within horizon" rule is a reified constraint below.
        fixed_ends = [pl.end_week + 1 for pl in prebooked.values()]
        upper_bound = max([horizon, frontier, *fixed_ends]) + sum(
            sp.duration for sp in plan.steps.values()
        )
        lower_bound = frontier
        # Tightest valid floor for the derived max/skip vars: a fixed (Done)
        # end may lie before the frontier. Wide domains cripple propagation
        # (measured: a -1e6 floor took the real dataset from ~1 s to ~46 s).
        domain_lo = min([frontier, *fixed_ends])

        present = model.NewBoolVar(f"present[{pid}]")
        starts: dict[str, cp_model.IntVar] = {}
        ends: dict[str, cp_model.IntVar] = {}
        ends_excl: dict[str, cp_model.IntVar | int] = {}
        assign: dict[tuple[str, str], cp_model.IntVar] = {}

        for sid in plan.workflow.walk_order:
            sp = plan.steps[sid]
            preds = sp.step.predecessor_ids
            pred_ends: list[cp_model.IntVar | int] = [ends_excl[p] for p in preds]

            if sp.skipped:
                if not preds:
                    ends_excl[sid] = frontier
                elif all(isinstance(e, int) for e in pred_ends):
                    ends_excl[sid] = max(e for e in pred_ends if isinstance(e, int))
                else:
                    v = model.NewIntVar(domain_lo, upper_bound, f"skip_end[{pid},{sid}]")
                    model.AddMaxEquality(v, pred_ends)
                    ends_excl[sid] = v
                continue

            if sid in prebooked:
                ends_excl[sid] = prebooked[sid].end_week + 1
                continue

            duration = sp.duration
            start_var = model.NewIntVar(lower_bound, upper_bound, f"start[{pid},{sid}]")
            end_var = model.NewIntVar(lower_bound, upper_bound, f"end[{pid},{sid}]")
            for pe in pred_ends:
                model.Add(start_var >= pe)  # Invariant I3 / I15, per DAG edge
            # `end == start + duration` is enforced by the optional interval(s)
            # (design/lab) or an explicit reified constraint (elapsed) ONLY
            # while present -- "not present -> no constraint at all".
            if sp.step.kind == "design":
                interval = model.NewOptionalIntervalVar(
                    start_var, duration, end_var, present, f"iv[{pid},{sid}]"
                )
                engineer_intervals.setdefault(leader.engineer_id, []).append(interval)
            elif sp.step.kind == "lab":
                assign_vars = []
                for chamber in _eligible_chambers(ctx.chambers_by_id, region, sid):
                    a = model.NewBoolVar(f"assign[{pid},{sid},{chamber.chamber_id}]")
                    assign[(sid, chamber.chamber_id)] = a
                    interval = model.NewOptionalIntervalVar(
                        start_var, duration, end_var, a, f"iv[{pid},{sid},{chamber.chamber_id}]"
                    )
                    chamber_intervals.setdefault(chamber.chamber_id, []).append(interval)
                    chamber_demands.setdefault(chamber.chamber_id, []).append(1)
                    assign_vars.append(a)
                # Exactly one eligible chamber iff the project is present (I5).
                model.Add(sum(assign_vars) == present)
            else:  # elapsed
                model.Add(end_var == start_var + duration).OnlyEnforceIf(present)
            # Redundant when present (the intervals imply it) but it removes a
            # free variable from the absent case and tightens propagation;
            # always satisfiable because `upper_bound` leaves room for the
            # whole chain even when it starts at the frontier.
            model.Add(end_var == start_var + duration)
            model.Add(end_var <= horizon).OnlyEnforceIf(present)
            starts[sid] = start_var
            ends[sid] = end_var
            ends_excl[sid] = end_var

        non_skipped_ends = [ends_excl[sid] for sid, sp in plan.steps.items() if not sp.skipped]
        last_end = model.NewIntVar(domain_lo, upper_bound, f"last_end[{pid}]")
        model.AddMaxEquality(last_end, non_skipped_ends)
        # within_year: reified from max end + delay_weeks (ADR 0004: delay is
        # terminal), forced False when not present.
        completion = model.NewIntVar(
            domain_lo - 1 + min(0, project.delay_weeks),
            upper_bound + max(0, project.delay_weeks),
            f"completion[{pid}]",
        )
        model.Add(completion == last_end - 1 + project.delay_weeks)
        wy = model.NewBoolVar(f"within_year[{pid}]")
        model.Add(completion <= schedule_input.within_year_week).OnlyEnforceIf(wy)
        model.Add(completion > schedule_input.within_year_week).OnlyEnforceIf(wy.Not())
        model.Add(wy <= present)

        project_vars[pid] = _ProjectVars(
            present=present,
            within_year=wy,
            starts=starts,
            ends=ends,
            ends_excl=ends_excl,
            assign=assign,
            prebooked=prebooked,
            last_end=last_end,
        )

    # --- Background occupancy: engineers (AddNoOverlap) -----------------------
    for engineer_id in sorted(state.eng_busy):
        for range_start, range_len in _contiguous_ranges(state.eng_busy[engineer_id]):
            engineer_intervals.setdefault(engineer_id, []).append(
                model.NewIntervalVar(
                    range_start,
                    range_len,
                    range_start + range_len,
                    f"fixed_busy[{engineer_id},{range_start}]",
                )
            )
    for engineer_id in sorted(engineer_intervals):
        if engineer_intervals[engineer_id]:
            model.AddNoOverlap(engineer_intervals[engineer_id])

    # --- Background occupancy: chambers (AddCumulative, demand capped) --------
    for chamber_id in sorted(state.chamber_busy):
        busy_chamber = ctx.chambers_by_id.get(chamber_id)
        if busy_chamber is None:
            continue
        for range_start, range_len, demand in _contiguous_demand_ranges(
            state.chamber_busy[chamber_id]
        ):
            capped = min(demand, busy_chamber.max_concurrent)
            if capped <= 0:
                continue
            chamber_intervals.setdefault(chamber_id, []).append(
                model.NewIntervalVar(
                    range_start,
                    range_len,
                    range_start + range_len,
                    f"fixed_demand[{chamber_id},{range_start}]",
                )
            )
            chamber_demands.setdefault(chamber_id, []).append(capped)
    for chamber_id in sorted(chamber_intervals):
        if chamber_intervals[chamber_id]:
            model.AddCumulative(
                chamber_intervals[chamber_id],
                chamber_demands[chamber_id],
                ctx.chambers_by_id[chamber_id].max_concurrent,
            )

    # --- Objective (ADR 0005 + presence tie-break) ------------------------------
    _TIEBREAK_SCALE = len(solvable) + 1
    primary = sum(
        PRIORITY_OBJECTIVE_WEIGHT.get(p.priority or "Q", 0) * project_vars[p.project_id].within_year
        for p in solvable
    )
    presence_tiebreak = sum(project_vars[p.project_id].present for p in solvable)
    model.Maximize(_TIEBREAK_SCALE * primary + presence_tiebreak)

    # --- Warm start -----------------------------------------------------------
    if warm_start_hint and solvable:
        _apply_greedy_hint(model, schedule_input, project_vars)

    solver = cp_model.CpSolver()
    solver.parameters.max_deterministic_time = deterministic_time
    solver.parameters.num_search_workers = num_search_workers
    solver.parameters.random_seed = random_seed
    status = solver.Solve(model)
    status_name = solver.StatusName(status)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError(
            f"CP-SAT solve did not reach OPTIMAL/FEASIBLE (status={status_name}); "
            "this indicates a modelling bug -- fixed-placement handling should make "
            "INFEASIBLE structurally unreachable for this model, see module docstring"
        )

    # --- Phase 2: lexicographic earliness pass --------------------------------
    # ADR 0005's objective is indifferent to *when* a project finishes as long
    # as its within_year / present values are unchanged, so phase 1 may return
    # any of many equally-optimal placements (e.g. a spillover project pushed
    # needlessly late). Fix every project's present / within_year literal to
    # its phase-1 value (so the ADR 0005 objective cannot get worse), hint the
    # phase-1 solution, and minimise Σ finish weeks under a *deterministic*
    # time budget. If phase 2 finds nothing (it always has the hint), the
    # phase-1 solution stands.
    phase1_solver = solver
    wall_time = solver.WallTime()
    if solvable and earliness_deterministic_time > 0:
        solver = _earliness_pass(
            model,
            solvable,
            project_vars,
            phase1_solver,
            deterministic_time=earliness_deterministic_time,
            num_search_workers=num_search_workers,
            random_seed=random_seed,
        )
        if solver is not phase1_solver:
            wall_time += solver.WallTime()

    for project in solvable:
        pid = project.project_id
        outcomes_by_id[pid] = _extract_outcome(
            project=project,
            plan=ctx.plans[pid],
            pv=project_vars[pid],
            solver=solver,
            leader=ctx.engineers_by_id[project.leader_engineer_id],  # type: ignore[index]
            pre_flags=pre_flags_all.get(pid, (False, False)),
            current_week=current_week,
            within_year_week=schedule_input.within_year_week,
        )

    apply_eng_conflict_flags(outcomes_by_id, state)

    for project in ctx.excluded:
        outcomes_by_id[project.project_id] = _excluded_outcome(project)

    by_project_id = sorted(schedule_input.projects, key=lambda p: p.project_id)
    project_outcomes = tuple(outcomes_by_id[p.project_id] for p in by_project_id)
    # scheduling_order: the DOMAIN_RULES.md sort order over every schedulable
    # project, for like-for-like comparison with greedy (P2-T06).
    scheduling_order = tuple(p.project_id for p in ctx.ordered)

    primary_value = (
        float(
            sum(
                PRIORITY_OBJECTIVE_WEIGHT.get(p.priority or "Q", 0)
                * solver.Value(project_vars[p.project_id].within_year)
                for p in solvable
            )
        )
        if solvable
        else 0.0
    )
    if not solvable:
        primary_bound = 0.0
    elif status == cp_model.OPTIMAL:
        primary_bound = primary_value
    else:
        primary_bound = math.floor(phase1_solver.BestObjectiveBound() / _TIEBREAK_SCALE)

    output = ScheduleOutput(
        project_outcomes=project_outcomes,
        scheduling_order=scheduling_order,
        solver_status=status_name,
    )
    info = CpSatSolveInfo(
        status_name=status_name,
        objective_value=primary_value,
        best_objective_bound=primary_bound,
        wall_time_seconds=wall_time,
        num_solvable_projects=len(solvable),
        num_frozen_projects=len(frozen),
        num_pre_resolved_left_out=num_pre_resolved,
    )
    return output, info


# --- Phase 2 ---------------------------------------------------------------------


def _earliness_pass(
    model: cp_model.CpModel,
    solvable: list[ProjectInput],
    project_vars: dict[str, _ProjectVars],
    phase1: cp_model.CpSolver,
    *,
    deterministic_time: float,
    num_search_workers: int,
    random_seed: int,
) -> cp_model.CpSolver:
    model.ClearHints()
    finish_terms = []
    for project in solvable:
        pv = project_vars[project.project_id]
        present_val = phase1.Value(pv.present)
        model.Add(pv.present == present_val)
        model.Add(pv.within_year == phase1.Value(pv.within_year))
        model.AddHint(pv.present, present_val)
        for sid in sorted(pv.starts):
            model.AddHint(pv.starts[sid], phase1.Value(pv.starts[sid]))
            model.AddHint(pv.ends[sid], phase1.Value(pv.ends[sid]))
        for akey in sorted(pv.assign):
            model.AddHint(pv.assign[akey], phase1.Value(pv.assign[akey]))
        if present_val:
            finish_terms.append(pv.last_end)
    if not finish_terms:
        return phase1
    model.Minimize(sum(finish_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_deterministic_time = deterministic_time
    solver.parameters.num_search_workers = num_search_workers
    solver.parameters.random_seed = random_seed
    status = solver.Solve(model)
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return solver
    return phase1


# --- Classification -------------------------------------------------------------


def _needs_greedy(ctx: RunContext, plan: ProjectPlan, prebooked: dict[str, _Placement]) -> bool:
    """True when the project has nothing CP-SAT can usefully decide, or has a
    fixed placement the model cannot represent as a constraint (see module
    docstring, item 3). Such projects are walked with the greedy code on the
    shared resource state instead."""

    if plan.held_step_ids:
        return True
    region = _lab_region_for_hub(plan.project.hub)
    searchable = 0
    for sid in plan.workflow.walk_order:
        sp = plan.steps[sid]
        if sp.skipped or sid in prebooked:
            continue
        if sp.anchored:
            return True  # anchored behind a not-started predecessor
        if sp.step.kind == "lab" and not _eligible_chambers(ctx.chambers_by_id, region, sid):
            return True
        searchable += 1
    return searchable == 0


# --- Background helpers ---------------------------------------------------------


def _contiguous_ranges(weeks: set[int]) -> list[tuple[int, int]]:
    """`{10,11,12,20}` -> `[(10,3),(20,1)]` (start, length)."""

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
    """`{10:2, 11:2, 12:1}` -> `[(10,2,2),(12,1,1)]` (start, length, demand)."""

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
    model: cp_model.CpModel, schedule_input: ScheduleInput, project_vars: dict[str, _ProjectVars]
) -> None:
    """Hint every decision variable from a full greedy run on the same input
    (the `scheduling-algorithms` skill's "feed the greedy SGS result in as a
    hint" guidance). `AddHint` hints one variable per call."""

    greedy_output = run_greedy_sgs(schedule_input)
    for outcome in greedy_output.project_outcomes:
        pv = project_vars.get(outcome.project_id)
        if pv is None:
            continue
        is_present = not outcome.left_out and not outcome.excluded
        model.AddHint(pv.present, 1 if is_present else 0)
        if not is_present:
            continue
        for step in outcome.steps:
            if step.step_id in pv.starts:
                model.AddHint(pv.starts[step.step_id], step.start_week)
                model.AddHint(pv.ends[step.step_id], step.end_week + 1)
            if step.kind == "lab" and step.assigned_chamber_id is not None:
                akey = (step.step_id, step.assigned_chamber_id)
                if akey in pv.assign:
                    model.AddHint(pv.assign[akey], 1)


# --- Extraction ---------------------------------------------------------------


def _extract_outcome(
    *,
    project: ProjectInput,
    plan: ProjectPlan,
    pv: _ProjectVars,
    solver: cp_model.CpSolver,
    leader: EngineerInput,
    pre_flags: tuple[bool, bool],
    current_week: int,
    within_year_week: int,
) -> ProjectScheduleOutcome:
    pid = project.project_id
    cat_not_allowed = _cat_not_allowed(project, leader)
    unconstrained = unconstrained_end_week(plan, current_week)
    progress_pct = compute_progress_pct(plan)
    eng_conflict, overlap = pre_flags

    if not solver.Value(pv.present):
        # DOMAIN_RULES "Gate remediation rulings" #2: in-flight work is never
        # erased. The project is LEFT_OUT, but its pre-booked Done rows and
        # In-Progress / Blocked tails (whose capacity is already consumed) are
        # still emitted -- the same shape greedy produces on a dead end.
        kept = tuple(
            StepSchedule(
                step.step_id,
                step.sequence_order,
                step.kind,
                pv.prebooked[step.step_id].start_week,
                pv.prebooked[step.step_id].end_week,
                plan.steps[step.step_id].duration,
                pv.prebooked[step.step_id].engineer_id,
                pv.prebooked[step.step_id].chamber_id,
            )
            for step in plan.workflow.steps
            if step.step_id in pv.prebooked
        )
        return ProjectScheduleOutcome(
            project_id=pid,
            excluded=False,
            left_out=True,
            eng_conflict=eng_conflict,
            overlap=overlap,
            cat_not_allowed=cat_not_allowed,
            spillover=False,
            within_year=False,
            no_leader=False,
            no_chamber_step_id=None,
            steps=kept,
            start_week=min((r.start_week for r in kept), default=None),
            end_week=max((r.end_week for r in kept), default=None),
            unconstrained_end_week=unconstrained,
            expected_end_week=_expected_end_week(project, unconstrained),
            projected_end_week=None,
            blocked=plan.blocked,
            progress_pct=progress_pct,
        )

    def value(e: cp_model.IntVar | int) -> int:
        return e if isinstance(e, int) else solver.Value(e)

    steps_out: list[StepSchedule] = []
    for step in plan.workflow.steps:
        sid = step.step_id
        sp = plan.steps[sid]
        if sp.skipped:
            e = value(pv.ends_excl[sid]) - 1
            steps_out.append(
                StepSchedule(sid, step.sequence_order, step.kind, e, e, 0, None, None, True)
            )
            continue
        if sid in pv.prebooked:
            pl = pv.prebooked[sid]
            steps_out.append(
                StepSchedule(
                    sid,
                    step.sequence_order,
                    step.kind,
                    pl.start_week,
                    pl.end_week,
                    sp.duration,
                    pl.engineer_id,
                    pl.chamber_id,
                )
            )
            continue
        start_val = solver.Value(pv.starts[sid])
        end_incl = solver.Value(pv.ends[sid]) - 1
        chamber_id: str | None = None
        if step.kind == "lab":
            for (s2, c2), var in sorted(pv.assign.items()):
                if s2 == sid and solver.Value(var):
                    chamber_id = c2
                    break
        steps_out.append(
            StepSchedule(
                sid,
                step.sequence_order,
                step.kind,
                start_val,
                end_incl,
                sp.duration,
                leader.engineer_id if step.kind == "design" else None,
                chamber_id,
            )
        )

    steps_tuple = tuple(steps_out)
    non_skipped = [s for s in steps_tuple if not s.skipped]
    start_week = min(s.start_week for s in non_skipped)
    end_week = max(s.end_week for s in non_skipped)
    within_year = bool(solver.Value(pv.within_year))
    projected = end_week + project.delay_weeks
    _ = within_year_week

    return ProjectScheduleOutcome(
        project_id=pid,
        excluded=False,
        left_out=False,
        eng_conflict=eng_conflict,
        overlap=overlap,
        cat_not_allowed=cat_not_allowed,
        spillover=not within_year,
        within_year=within_year,
        no_leader=False,
        no_chamber_step_id=None,
        steps=steps_tuple,
        start_week=start_week,
        end_week=end_week,
        unconstrained_end_week=unconstrained,
        expected_end_week=_expected_end_week(project, unconstrained),
        projected_end_week=projected,
        blocked=plan.blocked,
        progress_pct=progress_pct,
    )
