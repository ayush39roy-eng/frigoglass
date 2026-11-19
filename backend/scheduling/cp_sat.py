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
`skipped` -> no variables, `end = max(pred.end)` (transparent). A design
interval's length is the step's FTE-stretched `span` (ADR 0032). Precedence:
`start >= pred.end` (exclusive-end convention) per DAG edge.

Overlap (ADR 0043, contract P32 A2): a project whose steps all have
`overlap_weeks == 0` gets exactly the pre-P32 model (same variables, same
constraints, same order), so every golden file and CP-SAT result is unchanged.
A project with any overlap uses the static release sets `R(q)`
(`ProjectPlan.release_sources`): `start(s) >= end(r) + 1 - o(s)` for every `r`
in `⋃R(q), q in P(s)` (exclusive ends: `start >= end_excl(r) - o(s)`), plus
`start(s) >= start(r)` for `r` in the start anchors `SG(s)` when `o(s) > 0`.
The `frontier` floor of `gate(s)` is the start variables' lower bound. A
skipped step is emitted at `release` = max over its `R` set.

Manual step pins (ADR 0054, R40-12): a pin is a fixed placement, pre-booked
by the shared `greedy.prebook_anchored_steps` (non-frozen) or the shared
frozen walk, so greedy and CP-SAT emit identical pinned rows and identical
`pin_lapsed` (I47(c)). The model adds no precedence constraint into a pinned
step; a project with a pin uses the release sets, where a pinned step's set
is `{q} ∪ ⋃R(p)`, so its successors start after `max(end, release)` (+ wait).
A pin that could not be pre-booked (window past the horizon, lab pin with no
eligible chamber) sends the project to the greedy walk (LEFT_OUT).
`manual_overlap` is evaluated after the solve on this solve's own rows.

Priority band meaning (ADR 0056 R42-5, R53-2): a non-frozen queue-tier
project (a queued P3) is never a decision variable, nor walked before the
model. Window and tail (ADR 0063 R53-5, I60): the model's window is `W_cp =
min(within_year_week + 26, H)` (78 for a 2026 live run, so the model over the
same projects is the pre-P53 one, hint included). After both passes every
CP-SAT placement is booked into the shared `_ResourceState`, then one
post-solve walk, in `ctx.ordered` order, runs the shared
`greedy._schedule_one_project` up to H over every project the model did not
place: the counting projects it left absent, then the queue-tier ones. The
tail never moves a model placement; a CP-SAT LEFT_OUT <=> the tail found no
slot <= H. So the model of an input X equals the model of X without its
queue-tier projects (I52). Non-frozen P4/Q projects never reach the model
(`ctx.not_scheduled`, R42-3); the P4/Q entries of `PRIORITY_OBJECTIVE_WEIGHT`
are therefore unreachable (frozen projects are never in the model either) and
are kept only for the record.

Objective weighting: ADR 0005 (documented gap-fill, not DOMAIN_RULES.md text)
-- `PRIORITY_OBJECTIVE_WEIGHT = {P1:4, P2:3, P3:2, P4:1, Q:0}` times
`within_year`, plus a coarse presence tie-break scaled so it can never
override the primary term. ADR 0040 adds a VIP tier on top of the band
(`objective_weights`): a VIP project's weight exceeds the sum of every non-VIP
weight, mirroring `is_vip` as the second scheduling-order key. With no VIP
project the weights are the plain bands.

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
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace

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
    not_scheduled_priority_outcome,
    prebook_anchored_steps,
    prepare_run,
    project_counts_toward_year,
    project_queue_tier,
    run_greedy_sgs,
    year_flags,
)
from scheduling.types import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
)
from scheduling.weeks import cp_sat_window
from scheduling.workflow import (
    FRONTIER_SOURCE,
    ProjectPlan,
    compute_progress_pct,
    first_step_frontier,
    manual_overlap_by_row,
    pins_lapsed,
    unconstrained_end_week,
)

# Ordinal objective weight derived from the priority band -- ADR 0005.
PRIORITY_OBJECTIVE_WEIGHT: dict[str, int] = {"P1": 4, "P2": 3, "P3": 2, "P4": 1, "Q": 0}


def objective_weights(projects: Iterable[ProjectInput]) -> dict[str, int]:
    """Per-project weight of `within_year` in the ADR 0005 primary objective,
    with the ADR 0040 VIP tier on top.

    A non-VIP project weighs its band (`PRIORITY_OBJECTIVE_WEIGHT`). A VIP
    project weighs its band plus `vip_bonus = Σ(non-VIP band weights) + 1`, so
    one more VIP project within the year outranks every combination of non-VIP
    ones (VIP is the second scheduling-order key, above priority; DOMAIN_RULES
    "Scheduling order"). Among VIP projects the band still orders them. With
    no VIP project every weight is the plain band weight, so the objective --
    and therefore the solve -- is exactly the pre-ADR-0040 one.

    ADR 0050 / R36-4: `band_rank` (scheduling order key 3a) is deliberately
    NOT part of the objective, exactly as status and category are not. CP-SAT
    honours the rank only through `greedy.prepare_run` (`ctx.ordered`: the
    served `scheduling_order`, the anchored-step prebook order and the greedy
    warm-start hint), so it may put a lower-ranked project of a band in-year
    ahead of a higher-ranked one. Documented, intentional greedy/CP-SAT
    divergence; do not add the rank here.
    """

    ordered = sorted(projects, key=lambda p: p.project_id)
    band = {p.project_id: PRIORITY_OBJECTIVE_WEIGHT.get(p.priority or "Q", 0) for p in ordered}
    vip_bonus = sum(band[p.project_id] for p in ordered if not p.is_vip) + 1
    return {p.project_id: band[p.project_id] + (vip_bonus if p.is_vip else 0) for p in ordered}


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
    # ADR 0056 R42-5: non-frozen non-counting (queued P3) projects kept out of
    # the model and walked after the solve on the residual capacity.
    num_queued_walked: int = 0
    # R53-5 / I60: counting projects the model left absent inside `W_cp` and
    # re-walked by the greedy tail up to H.
    num_tail_walked: int = 0
    # I60 evidence: the searched (model) projects in `ctx.ordered` order, and
    # the projects the post-solve tail walked, in walk order.
    model_project_ids: tuple[str, ...] = ()
    tail_project_ids: tuple[str, ...] = ()
    # P53-R01 / I60: the projects resolved before the model (frozen, then the
    # non-frozen counting no_leader / data_error / needs-greedy ones), in walk
    # order. Queued P3 (step 6) and the tail are not in it.
    pre_model_project_ids: tuple[str, ...] = ()


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
    # R53-5 / I60: the model window `W_cp = min(within_year_week + 26, H)`;
    # every greedy walk (frozen, needs-greedy, the post-solve tail) searches
    # to the run's H (`schedule_input.horizon_weeks`).
    horizon = cp_sat_window(schedule_input.within_year_week, schedule_input.horizon_weeks)
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
    # ADR 0056 R42-5: a non-frozen project with `counts_toward_year = false`
    # (a queued P3) is never a decision variable. It is walked after the
    # solve (step 6), whatever its kind (needs-greedy, no_leader,
    # data_error), so the model of X equals the model of X⁻ (I52).
    solvable: list[ProjectInput] = []
    queued: list[ProjectInput] = []
    num_pre_resolved = 0
    pre_model_ids: list[str] = [p.project_id for p in frozen]
    for project in non_frozen:
        pid = project.project_id
        if project_queue_tier(project):
            queued.append(project)
            continue
        plan = ctx.plans[pid]
        prebooked = prebooked_all.get(pid, {})
        pre_flags = pre_flags_all.get(pid, (False, False))

        if plan.data_error is not None:
            outcomes_by_id[pid] = _data_error_outcome(project, plan)
            num_pre_resolved += 1
            pre_model_ids.append(pid)
            continue
        leader = ctx.engineers_by_id.get(project.leader_engineer_id or "")
        if leader is None:
            outcomes_by_id[pid] = _no_leader_outcome(project, plan, current_week)
            num_pre_resolved += 1
            pre_model_ids.append(pid)
            continue
        if _needs_greedy(ctx, plan, prebooked):
            outcomes_by_id[pid] = _schedule_one_project(
                ctx, state, plan, prebooked=prebooked, pre_flags=pre_flags
            )
            num_pre_resolved += 1
            pre_model_ids.append(pid)
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
        # P33 (R33-5): waits widen the room the absent case needs; + 0 when
        # no step waits, so the model is unchanged.
        # R53-5: a start floor may now lie past `W_cp` (floors are <= H); it
        # joins the max so the absent case stays SAT. With every floor <=
        # `W_cp` the bound is exactly the pre-P53 one.
        floors = [
            sp.start_not_before_week
            for sp in plan.steps.values()
            if sp.start_not_before_week is not None
        ]
        # The within-year cut-off joins too, so `completion > within_year_week`
        # stays satisfiable when absent even on an input whose cut-off lies
        # past `W_cp` (only an engine-level input violating I57 does that).
        upper_bound = max(
            [horizon, frontier, *fixed_ends, *floors, schedule_input.within_year_week]
        ) + sum(sp.span + sp.wait_weeks for sp in plan.steps.values())
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

        # ADR 0043: only a project with an overlap uses the release sets; every
        # other project is modelled exactly as before P32. ADR 0054 (R40-7 /
        # R40-12): so does a project with a pin. A pin is pre-booked (fixed,
        # `prebooked`), so no precedence constraint goes *into* it, and its
        # release set `{q} ∪ ⋃R(p)` constrains its successors from
        # `max(end, release) + 1 (+ w)`.
        sources = plan.release_sources() if plan.has_overlap or plan.pinned_step_ids else None

        def release_terms(
            ids: Iterable[str],
            ends_excl: dict[str, cp_model.IntVar | int] = ends_excl,
            frontier: int = frontier,
        ) -> list[cp_model.IntVar | int]:
            """Exclusive-end terms `G + 1` of a release set (`frontier` for the
            `frontier - 1` marker), sorted for determinism."""

            return [frontier if r == FRONTIER_SOURCE else ends_excl[r] for r in sorted(ids)]

        def start_of(
            r: str,
            starts: dict[str, cp_model.IntVar] = starts,
            prebooked: dict[str, _Placement] = prebooked,
        ) -> cp_model.IntVar | int:
            return prebooked[r].start_week if r in prebooked else starts[r]

        for sid in plan.workflow.walk_order:
            sp = plan.steps[sid]
            preds = sp.step.predecessor_ids
            pred_ends: list[cp_model.IntVar | int] = [ends_excl[p] for p in preds]
            if sources is not None:
                upstream = sorted({r for p in preds for r in sources[p]})
                pred_ends = release_terms(upstream) if preds else []

            if sp.skipped:
                # With an overlap, `pred_ends` is the release set: the skipped
                # step is emitted at release(s) (ADR 0043).
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

            # Elapsed weeks: the effective duration (ADR 0019), stretched by the
            # leader's FTE for a design step (ADR 0032, shared with greedy via
            # `prepare_run`). The output row still reports `sp.duration` (effort).
            duration = sp.span
            # ADR 0019 earliest start: a Not Started step may not start before
            # its `start_not_before_week` (inside `upper_bound`, so it still
            # leaves room for the whole chain and the absent case stays SAT).
            step_lo = lower_bound
            if sp.start_not_before_week is not None:
                step_lo = max(step_lo, sp.start_not_before_week)
            start_var = model.NewIntVar(step_lo, upper_bound, f"start[{pid},{sid}]")
            end_var = model.NewIntVar(lower_bound, upper_bound, f"end[{pid},{sid}]")
            o = sp.overlap_weeks
            w = sp.wait_weeks
            for pe in pred_ends:
                # Invariant I3 / I15, per DAG edge; ADR 0043 release set when
                # the project has an overlap (`- o`, I27); P33 wait (`+ w`,
                # R33-5, I28; `o` and `w` are exclusive). With neither, the
                # constraint is exactly the pre-P32 one.
                if o:
                    model.add(start_var >= pe - o)
                elif w:
                    model.add(start_var >= pe + w)
                else:
                    model.Add(start_var >= pe)
            if o:
                # ADR 0043 start anchor: never before the step it runs in
                # parallel with has started.
                for r in plan.start_anchor_ids(sid):
                    model.add(start_var >= start_of(r))
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
    weights = objective_weights(solvable)  # ADR 0005 bands + ADR 0040 VIP tier
    primary = sum(weights[p.project_id] * project_vars[p.project_id].within_year for p in solvable)
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
            category_workflow=ctx.categories.workflow,
        )

    # --- 6. R53-5 / I60 greedy tail (and R42-5 residual placement) ---------
    # Book every CP-SAT placement into the shared state, then walk, in
    # `ctx.ordered` order, every project the model did not place: the
    # counting projects it left absent (no slot inside `W_cp`), then the
    # queue-tier projects, with the shared greedy routine up to H (their
    # anchored / pinned steps were pre-booked in step 2, as in greedy). The
    # model's placements are never moved; a CP-SAT LEFT_OUT <=> the tail
    # found no slot <= H.
    absent = [p for p in solvable if outcomes_by_id[p.project_id].left_out]
    tail_ids = {p.project_id for p in absent} | {p.project_id for p in queued}
    tail = [p for p in ctx.ordered if p.project_id in tail_ids]
    if tail:
        placed = [p for p in solvable if p.project_id not in tail_ids]
        _book_solved_placements(state, ctx.chambers_by_id, placed, outcomes_by_id, prebooked_all)
        for project in tail:
            pid = project.project_id
            outcomes_by_id[pid] = _schedule_one_project(
                ctx,
                state,
                ctx.plans[pid],
                prebooked=prebooked_all.get(pid, {}),
                pre_flags=pre_flags_all.get(pid, (False, False)),
            )

    apply_eng_conflict_flags(outcomes_by_id, state)

    for project in ctx.excluded:
        outcomes_by_id[project.project_id] = _excluded_outcome(project, current_week)
    for project in ctx.not_scheduled:
        outcomes_by_id[project.project_id] = not_scheduled_priority_outcome(project)

    by_project_id = sorted(schedule_input.projects, key=lambda p: p.project_id)
    project_outcomes = tuple(outcomes_by_id[p.project_id] for p in by_project_id)
    # scheduling_order: the DOMAIN_RULES.md sort order over every schedulable
    # project, for like-for-like comparison with greedy (P2-T06).
    scheduling_order = tuple(p.project_id for p in ctx.ordered)

    primary_value = (
        float(
            sum(
                weights[p.project_id] * solver.Value(project_vars[p.project_id].within_year)
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
        num_queued_walked=len(queued),
        num_tail_walked=len(absent),
        model_project_ids=tuple(p.project_id for p in solvable),
        tail_project_ids=tuple(p.project_id for p in tail),
        pre_model_project_ids=tuple(pre_model_ids),
    )
    return output, info


def _book_solved_placements(
    state: _ResourceState,
    chambers_by_id: Mapping[str, ChamberInput],
    solvable: list[ProjectInput],
    outcomes_by_id: Mapping[str, ProjectScheduleOutcome],
    prebooked_all: Mapping[str, Mapping[str, _Placement]],
) -> None:
    """R42-5: book the searched (non-pre-booked) design and lab rows of every
    solved project into `state`, in `solvable` order (= `ctx.ordered`): the
    leader per span week, one platform of the chosen chamber per lab week.
    Pre-booked rows (anchored, pinned) are already in `state`; skipped and
    elapsed rows book nothing. CP-SAT placements never overlap the
    background or each other, so this raises no conflict."""

    for project in solvable:
        outcome = outcomes_by_id[project.project_id]
        if outcome.left_out:
            continue  # absent: only its pre-booked rows were emitted
        prebooked = prebooked_all.get(project.project_id, {})
        for row in outcome.steps:
            if row.skipped or row.step_id in prebooked:
                continue
            weeks = range(row.start_week, row.end_week + 1)
            if row.kind == "design" and row.assigned_engineer_id is not None:
                state.book_engineer(row.assigned_engineer_id, weeks, project.project_id)
            elif row.kind == "lab" and row.assigned_chamber_id is not None:
                state.book_chamber(chambers_by_id[row.assigned_chamber_id], weeks)


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
    pinned = plan.pinned_step_ids
    for sid in plan.workflow.walk_order:
        sp = plan.steps[sid]
        if sp.skipped or sid in prebooked:
            continue
        if sid in pinned:
            # ADR 0054: a pin that could not be pre-booked (its window ends
            # past the horizon, or a lab pin with no eligible chamber) makes
            # the project LEFT_OUT; the greedy walk reports it.
            return True
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

    # R53-5 / I60: hint from a greedy run over the model window `W_cp`, so a
    # model over the same projects gets exactly the pre-P53 hint. An input
    # whose pins / floors lie past `W_cp` cannot be validated at `W_cp`; it
    # is hinted from the full-H run, a placement ending past `W_cp` as absent.
    w_cp = cp_sat_window(schedule_input.within_year_week, schedule_input.horizon_weeks)
    try:
        greedy_output = run_greedy_sgs(replace(schedule_input, horizon_weeks=w_cp))
    except ValueError:
        greedy_output = run_greedy_sgs(schedule_input)
    for outcome in greedy_output.project_outcomes:
        pv = project_vars.get(outcome.project_id)
        if pv is None:
            continue
        is_present = (
            not outcome.left_out
            and not outcome.excluded
            and all(s.end_week <= w_cp for s in outcome.steps)
        )
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
    category_workflow: Mapping[str, str],
) -> ProjectScheduleOutcome:
    pid = project.project_id
    cat_not_allowed = _cat_not_allowed(project, leader, category_workflow)
    unconstrained = unconstrained_end_week(plan, current_week)
    progress_pct = compute_progress_pct(plan)
    eng_conflict, overlap = pre_flags
    # ADR 0054: pins are pre-booked fixed placements shared with greedy
    # (identical rows, identical `pin_lapsed`, I47(c)); `manual_overlap` is
    # evaluated on this solve's own rows (R40-12).
    pinned = plan.pinned_step_ids
    lapsed = pins_lapsed(plan, current_week) if pinned else False

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
                pinned=step.step_id in pinned,
            )
            for step in plan.workflow.steps
            if step.step_id in pv.prebooked
        )
        kept, manual_overlap = _with_manual_overlap(plan, kept, current_week)
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
            manual_overlap=manual_overlap,
            pin_lapsed=lapsed,
            counts_toward_year=project_counts_toward_year(project),
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
                    pinned=sid in pinned,
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

    steps_tuple, manual_overlap = _with_manual_overlap(plan, tuple(steps_out), current_week)
    non_skipped = [s for s in steps_tuple if not s.skipped]
    start_week = min(s.start_week for s in non_skipped)
    end_week = max(s.end_week for s in non_skipped)
    # R42-4 / I50: the shared year basis. A solvable project always counts
    # (non-counting ones are not in the model), so this equals the model's
    # `within_year` literal; it is recomputed here so both solvers emit the
    # flags through one helper.
    projected = end_week + project.delay_weeks
    counts = project_counts_toward_year(project)
    within_year, spillover = year_flags(
        counts_toward_year=counts,
        scheduled=True,
        completion_week=projected,
        within_year_week=within_year_week,
    )

    return ProjectScheduleOutcome(
        project_id=pid,
        excluded=False,
        left_out=False,
        eng_conflict=eng_conflict,
        overlap=overlap,
        cat_not_allowed=cat_not_allowed,
        spillover=spillover,
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
        manual_overlap=manual_overlap,
        pin_lapsed=lapsed,
        counts_toward_year=counts,
    )


def _with_manual_overlap(
    plan: ProjectPlan, rows: tuple[StepSchedule, ...], current_week: int
) -> tuple[tuple[StepSchedule, ...], bool]:
    """R40-7 / I47(a) on this solve's rows: set `manual_overlap` on every
    flagged pinned row; return the rows (same order) and the OR. A no-op,
    returning the rows unchanged, for a project without a pinned row."""

    if not any(r.pinned for r in rows):
        return rows, False
    frontier = first_step_frontier(plan.project, current_week)
    flags = manual_overlap_by_row(plan, {r.step_id: r for r in rows}, frontier)
    out = tuple(replace(r, manual_overlap=True) if flags.get(r.step_id) else r for r in rows)
    return out, any(flags.values())
