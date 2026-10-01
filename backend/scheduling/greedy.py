"""Greedy serial schedule-generation scheme (SGS), per `docs/DOMAIN_RULES.md`.

Implemented directly from DOMAIN_RULES.md's "Scheduling order", "Precedence",
"Booking rules", "Per-stage progress capture" and Invariants I1-I17. The
prototype oracle was retired at P2 close and was not consulted for the
2026-09-27 revision (P9-T02); every judgement call the revised contract forced
is recorded in that task's `docs/MEMORY.md` entry.

Shape of a run (all pure, all deterministic — Invariant I8):

  1. Validate input (`ValueError` on malformed configuration) and build the
     per-project `ProjectPlan` (durations, skips, progress, holds).
  2. Walk **frozen** projects first, in scheduling order — every step locked
     at `actual_start_week` + precedence, capacity consumed regardless of
     conflict (`ENG_CONFLICT` / `OVERLAP`).
  3. **Pre-book the anchored steps** of every non-frozen, progress-tracked
     project (in scheduling order): `Done` steps at their recorded actuals
     (capacity consumed only for weeks >= CURRENT_WEEK) and `In Progress`
     tails from `max(CURRENT_WEEK, pred_end + 1)` for `remaining` weeks. These
     are facts about work already under way, so they must be on the books
     before any *search* for a free window (otherwise a higher-priority
     not-started project could grab the very weeks an in-progress project is
     already occupying). Conflicts here are flagged, never resolved by moving
     the anchored step (I11).
  4. Walk the non-frozen projects in scheduling order: each step in the DAG's
     deterministic walk order gets `earliest_start = max(pred.end) + 1`
     (floored at CURRENT_WEEK); `design` searches the leader's calendar,
     `lab` searches eligible chambers, `elapsed` books nothing, `skipped`
     steps are transparent, held (Blocked) steps are not placed.

No DB access, no network access, no filesystem access, no randomness, no
wall-clock dependence. Every collection this module iterates is explicitly
sorted before iteration.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

import domain_constants as dc
from scheduling.types import (
    CATEGORY_RANK,
    OEM_CATEGORIES,
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
)
from scheduling.workflow import (
    STATUS_BLOCKED,
    STATUS_DONE,
    STATUS_IN_PROGRESS,
    ProjectPlan,
    StepPlan,
    Workflow,
    analyse_project,
    build_lead_time_table,
    build_workflows,
    compute_progress_pct,
    first_step_frontier,
    unconstrained_end_week,
    validate_schedulable_project,
)

# --- Small pure helpers ------------------------------------------------------


def _is_oem_hub(hub: str) -> bool:
    return hub in dc.OEM_HUBS


def _lab_region_for_hub(hub: str) -> str:
    if hub not in dc.HUB_LAB_REGION:
        raise ValueError(f"unknown hub {hub!r}; expected one of {sorted(dc.HUB_LAB_REGION)}")
    return dc.HUB_LAB_REGION[hub]


def _cat_not_allowed(project: ProjectInput, leader: EngineerInput) -> bool:
    """CAT_NOT_ALLOWED: the leader's `allowed_categories` excludes the project's
    category, "or OEM for OEM-hub projects". An OEM-hub leader is eligible if
    `allowed_categories` carries either the generic `"OEM"` marker or the
    project's own `X-OEM` category (ADR 0007: engineer eligibility now accepts
    the three OEM categories explicitly)."""

    allowed = leader.allowed_categories
    if _is_oem_hub(project.hub):
        oem_cat_ok = project.category in OEM_CATEGORIES and project.category in allowed
        return not ("OEM" in allowed or oem_cat_ok)
    return project.category not in allowed


def _sort_key(project: ProjectInput) -> tuple[int, int, int, int, str]:
    """DOMAIN_RULES.md "Scheduling order": frozen desc, priority, status,
    category (`A+ → A → B → C → A-OEM → B-OEM → C-OEM`), then an explicit
    `project_id` tiebreak (P2-T01 decision: a pure function must not derive
    determinism from caller ordering)."""

    return (
        0 if project.frozen else 1,
        dc.PRIORITY_ORDER.index(project.priority),
        dc.SCHEDULABLE_STATUS_ORDER[project.status],
        CATEGORY_RANK.index(project.category),
        project.project_id,
    )


def _eligible_chambers(
    chambers_by_id: dict[str, ChamberInput], region: str, step_id: str
) -> list[ChamberInput]:
    """Deterministic candidate order: sorted by chamber_id (P2-T01)."""

    return sorted(
        (
            c
            for c in chambers_by_id.values()
            if c.lab_region == region and step_id in c.allowed_stages
        ),
        key=lambda c: c.chamber_id,
    )


# --- Run context and mutable resource state ----------------------------------


@dataclass(frozen=True)
class _Placement:
    """A step placement fixed before the search phase (frozen or anchored)."""

    start_week: int
    end_week: int
    engineer_id: str | None
    chamber_id: str | None


class _ResourceState:
    """Per-run mutable booking state. Fresh on every call — no shared state
    between calls (Invariant I8)."""

    def __init__(self, schedule_input: ScheduleInput) -> None:
        self.eng_busy: dict[str, set[int]] = {
            e.engineer_id: set() for e in schedule_input.engineers
        }
        self.chamber_busy: dict[str, dict[int, int]] = {
            c.chamber_id: {} for c in schedule_input.chambers
        }
        # Which projects hold each engineer-week, so a double booking can flag
        # ENG_CONFLICT on *every* project involved (P9-R01), not only on the
        # second booker.
        self.eng_owners: dict[str, dict[int, set[str]]] = {}
        self.eng_conflict_projects: set[str] = set()

    def book_engineer(self, engineer_id: str, weeks: range, project_id: str) -> bool:
        """Consume `weeks` regardless of conflict; return True if any was busy.
        On a conflict, `project_id` and every earlier holder of the clashing
        weeks are added to `eng_conflict_projects`."""

        busy = self.eng_busy.setdefault(engineer_id, set())
        owners = self.eng_owners.setdefault(engineer_id, {})
        conflict = False
        for wk in weeks:
            holders = owners.setdefault(wk, set())
            if wk in busy and holders - {project_id}:
                conflict = True
                self.eng_conflict_projects.update(holders)
                self.eng_conflict_projects.add(project_id)
            busy.add(wk)
            holders.add(project_id)
        return conflict

    def engineer_free(self, engineer_id: str, weeks: range) -> bool:
        busy = self.eng_busy.get(engineer_id, set())
        return all(wk not in busy for wk in weeks)

    def book_chamber(self, chamber: ChamberInput, weeks: range) -> bool:
        """Consume 1.0 platform-week per project-week regardless of capacity;
        return True if `max_concurrent` was exceeded in any week."""

        per_week = self.chamber_busy.setdefault(chamber.chamber_id, {})
        overlap = False
        for wk in weeks:
            per_week[wk] = per_week.get(wk, 0) + 1
            if per_week[wk] > chamber.max_concurrent:
                overlap = True
        return overlap

    def chamber_free(self, chamber: ChamberInput, weeks: range) -> bool:
        per_week = self.chamber_busy.get(chamber.chamber_id, {})
        return all(per_week.get(wk, 0) < chamber.max_concurrent for wk in weeks)


def apply_eng_conflict_flags(
    outcomes_by_id: dict[str, ProjectScheduleOutcome], state: _ResourceState
) -> None:
    """Set `eng_conflict=True` on every project involved in a fixed-placement
    engineer double booking (both sides — P9-R01, auditor D4)."""

    for pid in sorted(state.eng_conflict_projects):
        outcome = outcomes_by_id.get(pid)
        if outcome is not None and not outcome.eng_conflict:
            outcomes_by_id[pid] = replace(outcome, eng_conflict=True)


@dataclass(frozen=True)
class RunContext:
    """Validated, pre-analysed input shared by the greedy and CP-SAT solvers."""

    schedule_input: ScheduleInput
    workflows: dict[str, Workflow]
    lead_time_table: dict[tuple[str, str, str], int]
    engineers_by_id: dict[str, EngineerInput]
    chambers_by_id: dict[str, ChamberInput]
    plans: dict[str, ProjectPlan]
    ordered: tuple[ProjectInput, ...]  # schedulable projects in scheduling order
    excluded: tuple[ProjectInput, ...]


def prepare_run(schedule_input: ScheduleInput) -> RunContext:
    if schedule_input.horizon_weeks < 1:
        raise ValueError("horizon_weeks must be >= 1")

    workflows = build_workflows(schedule_input.workflow_steps)
    lead_time_table = build_lead_time_table(schedule_input.lead_times)
    engineers_by_id = {e.engineer_id: e for e in schedule_input.engineers}
    chambers_by_id = {c.chamber_id: c for c in schedule_input.chambers}

    schedulable: list[ProjectInput] = []
    excluded: list[ProjectInput] = []
    for project in schedule_input.projects:
        if project.status in dc.SCHEDULABLE_STATUS_ORDER:
            schedulable.append(project)
        else:
            # Commercialized / On Hold / Cancelled / Draft / anything else.
            excluded.append(project)

    plans: dict[str, ProjectPlan] = {}
    for project in schedulable:
        validate_schedulable_project(
            project,
            workflows,
            lead_time_table,
            hub_lab_region=dc.HUB_LAB_REGION,
            priority_order=dc.PRIORITY_ORDER,
        )
        plans[project.project_id] = analyse_project(
            project, workflows[project.workflow_id], lead_time_table
        )

    return RunContext(
        schedule_input=schedule_input,
        workflows=workflows,
        lead_time_table=lead_time_table,
        engineers_by_id=engineers_by_id,
        chambers_by_id=chambers_by_id,
        plans=plans,
        ordered=tuple(sorted(schedulable, key=_sort_key)),
        excluded=tuple(excluded),
    )


# --- Core algorithm ------------------------------------------------------


def run_greedy_sgs(schedule_input: ScheduleInput) -> ScheduleOutput:
    """Pure function: `ScheduleInput -> ScheduleOutput`. See module docstring."""

    ctx = prepare_run(schedule_input)
    state = _ResourceState(schedule_input)
    current_week = schedule_input.current_week

    outcomes_by_id: dict[str, ProjectScheduleOutcome] = {}
    scheduling_order: list[str] = []

    frozen_projects = [p for p in ctx.ordered if p.frozen]
    non_frozen_projects = [p for p in ctx.ordered if not p.frozen]

    for project in frozen_projects:
        scheduling_order.append(project.project_id)
        outcomes_by_id[project.project_id] = _schedule_one_project(
            ctx, state, ctx.plans[project.project_id], prebooked={}, pre_flags=(False, False)
        )

    prebooked, pre_flags = prebook_anchored_steps(ctx, state, non_frozen_projects)

    for project in non_frozen_projects:
        scheduling_order.append(project.project_id)
        outcomes_by_id[project.project_id] = _schedule_one_project(
            ctx,
            state,
            ctx.plans[project.project_id],
            prebooked=prebooked.get(project.project_id, {}),
            pre_flags=pre_flags.get(project.project_id, (False, False)),
        )

    for project in ctx.excluded:
        outcomes_by_id[project.project_id] = _excluded_outcome(project)

    apply_eng_conflict_flags(outcomes_by_id, state)
    by_project_id = sorted(schedule_input.projects, key=lambda p: p.project_id)
    project_outcomes = tuple(outcomes_by_id[p.project_id] for p in by_project_id)
    _ = current_week
    return ScheduleOutput(
        project_outcomes=project_outcomes, scheduling_order=tuple(scheduling_order)
    )


def _excluded_outcome(project: ProjectInput) -> ProjectScheduleOutcome:
    """DOMAIN_RULES.md: excluded statuses are never scheduled. `within_year`
    for an excluded project (P2-T01 resolution, unchanged): Commercialized is
    trivially "done, within year"; anything else is not."""

    return ProjectScheduleOutcome(
        project_id=project.project_id,
        excluded=True,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=(project.status == "Commercialized"),
        no_leader=False,
        no_chamber_step_id=None,
        steps=(),
        start_week=None,
        end_week=None,
    )


def _no_leader_outcome(
    project: ProjectInput, plan: ProjectPlan, current_week: int
) -> ProjectScheduleOutcome:
    """P2-T01 resolution (unchanged): no resolvable leader -> immediate
    LEFT_OUT, no step attempted, CAT_NOT_ALLOWED never evaluated."""

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
        unconstrained_end_week=unconstrained_end_week(plan, current_week),
        expected_end_week=_expected_end_week(project, unconstrained_end_week(plan, current_week)),
        projected_end_week=None,
        blocked=plan.blocked,
        progress_pct=compute_progress_pct(plan),
    )


def _data_error_outcome(project: ProjectInput, plan: ProjectPlan) -> ProjectScheduleOutcome:
    """DOMAIN_RULES.md: an In Progress / Blocked / Done step missing a required
    actual week rejects the project as a data error — it is not silently
    scheduled from scratch, and it consumes no capacity."""

    assert plan.data_error is not None
    return ProjectScheduleOutcome(
        project_id=project.project_id,
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=False,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(),
        start_week=None,
        end_week=None,
        unconstrained_end_week=None,
        expected_end_week=project.target_end_week,
        projected_end_week=None,
        blocked=False,
        progress_pct=None,
        data_error=plan.data_error,
    )


def _expected_end_week(project: ProjectInput, unconstrained: int | None) -> int | None:
    return project.target_end_week if project.target_end_week is not None else unconstrained


# --- Phase 3: anchored pre-booking (Done / In Progress) --------------------------


def prebook_anchored_steps(
    ctx: RunContext, state: _ResourceState, projects: list[ProjectInput]
) -> tuple[dict[str, dict[str, _Placement]], dict[str, tuple[bool, bool]]]:
    """Book every *known* anchored step of the given non-frozen projects, in
    scheduling order, before any search takes place (see module docstring,
    step 3). A step is known when its placement can be computed from recorded
    actuals alone: every `Done` step, and every `In Progress` / `Blocked`
    (remaining == 0) step whose predecessors are all themselves known. An
    anchored step behind a Not-Started predecessor (inconsistent data) is
    placed during the walk instead.

    Returns `(placements[project_id][step_id], (eng_conflict, overlap)[project_id])`.
    """

    current_week = ctx.schedule_input.current_week
    placements: dict[str, dict[str, _Placement]] = {}
    flags: dict[str, tuple[bool, bool]] = {}

    for project in projects:
        plan = ctx.plans[project.project_id]
        if plan.data_error is not None or not plan.progress_tracked:
            continue
        leader = ctx.engineers_by_id.get(project.leader_engineer_id or "")
        if leader is None:
            continue  # no_leader -> LEFT_OUT with nothing booked (unchanged)
        region = _lab_region_for_hub(project.hub)
        frontier = first_step_frontier(project, current_week)

        known_ends: dict[str, int] = {}
        placed: dict[str, _Placement] = {}
        eng_conflict = False
        overlap = False
        for sid in plan.workflow.walk_order:
            sp = plan.steps[sid]
            preds = sp.step.predecessor_ids
            preds_known = all(p in known_ends for p in preds)
            pred_end = (
                (max(known_ends[p] for p in preds) if preds else frontier - 1)
                if preds_known
                else None
            )

            if sp.skipped:
                if pred_end is not None:
                    known_ends[sid] = pred_end
                continue
            if sid in plan.held_step_ids:
                # Held: not placed here (see _schedule_one_project); its end is
                # known if its predecessors are, so successors stay consistent.
                if pred_end is not None and sp.status == STATUS_BLOCKED:
                    assert sp.actual_start_week is not None
                    hold_week = max(current_week, pred_end + 1, sp.actual_start_week)
                    known_ends[sid] = max(sp.actual_start_week, hold_week - 1)
                elif pred_end is not None:
                    known_ends[sid] = pred_end
                continue

            if sp.status == STATUS_DONE:
                assert sp.actual_start_week is not None and sp.actual_end_week is not None
                placement, conflict, over = _book_anchored(
                    ctx,
                    state,
                    sp,
                    leader,
                    region,
                    sp.actual_start_week,
                    sp.actual_end_week,
                    project_id=project.project_id,
                    consume_from=current_week,
                )
                if placement is None:
                    continue  # no eligible chamber: the walk reports no_chamber / LEFT_OUT
                eng_conflict |= conflict
                overlap |= over
                placed[sid] = placement
                known_ends[sid] = placement.end_week
                continue

            if sp.status in (STATUS_IN_PROGRESS, STATUS_BLOCKED):
                assert sp.actual_start_week is not None
                if pred_end is None:
                    continue  # placed during the walk
                if sp.remaining == 0:
                    end = max(sp.actual_start_week, pred_end)
                    placed[sid] = _Placement(sp.actual_start_week, end, None, None)
                    known_ends[sid] = end
                    continue
                tail_start = max(current_week, pred_end + 1, sp.actual_start_week)
                tail_end = tail_start + sp.remaining - 1
                placement, conflict, over = _book_anchored(
                    ctx,
                    state,
                    sp,
                    leader,
                    region,
                    tail_start,
                    tail_end,
                    project_id=project.project_id,
                    consume_from=current_week,
                    reported_start=sp.actual_start_week,
                )
                if placement is None:
                    continue
                eng_conflict |= conflict
                overlap |= over
                placed[sid] = placement
                known_ends[sid] = placement.end_week
                continue
            # Not Started: unknown until the walk.

        if placed:
            placements[project.project_id] = placed
            flags[project.project_id] = (eng_conflict, overlap)
    return placements, flags


def _book_anchored(
    ctx: RunContext,
    state: _ResourceState,
    sp: StepPlan,
    leader: EngineerInput,
    region: str,
    start: int,
    end: int,
    *,
    project_id: str,
    consume_from: int,
    reported_start: int | None = None,
) -> tuple[_Placement | None, bool, bool]:
    """Consume capacity for `[max(start, consume_from) .. end]` regardless of
    conflict (DOMAIN_RULES.md: capacity is only tracked for weeks >=
    CURRENT_WEEK; anchored placements never move). Returns
    `(placement, eng_conflict, overlap)`; `placement is None` only for a lab
    step with zero eligible chambers.

    Lab steps (DOMAIN_RULES "Gate remediation rulings" #1): the first eligible
    chamber, in chamber_id order, with room for every consumed week; only
    when none has room is the step booked over capacity (into the first
    eligible chamber) and OVERLAP raised."""

    weeks = range(max(start, consume_from), end + 1)
    shown_start = reported_start if reported_start is not None else start
    kind = sp.step.kind
    if kind == "design":
        conflict = state.book_engineer(leader.engineer_id, weeks, project_id)
        return _Placement(shown_start, end, leader.engineer_id, None), conflict, False
    if kind == "lab":
        eligible = _eligible_chambers(ctx.chambers_by_id, region, sp.step.step_id)
        if not eligible:
            return None, False, False
        chosen = next((c for c in eligible if state.chamber_free(c, weeks)), eligible[0])
        over = state.book_chamber(chosen, weeks)
        return _Placement(shown_start, end, None, chosen.chamber_id), False, over
    return _Placement(shown_start, end, None, None), False, False


# --- Phase 2 / 4: per-project walk -------------------------------------------------


def _schedule_one_project(
    ctx: RunContext,
    state: _ResourceState,
    plan: ProjectPlan,
    *,
    prebooked: dict[str, _Placement],
    pre_flags: tuple[bool, bool],
) -> ProjectScheduleOutcome:
    project = plan.project
    si = ctx.schedule_input
    current_week = si.current_week
    horizon = si.horizon_weeks

    if plan.data_error is not None:
        return _data_error_outcome(project, plan)

    leader = (
        ctx.engineers_by_id.get(project.leader_engineer_id) if project.leader_engineer_id else None
    )
    if leader is None:
        return _no_leader_outcome(project, plan, current_week)

    cat_not_allowed = _cat_not_allowed(project, leader)
    region = _lab_region_for_hub(project.hub)
    frontier = first_step_frontier(project, current_week)
    frozen = project.frozen

    eng_conflict, overlap = pre_flags
    left_out = False
    no_chamber_step_id: str | None = None
    ends: dict[str, int] = {}
    steps_out: dict[str, StepSchedule] = {}

    def emit(
        sp: StepPlan,
        start: int,
        end: int,
        eng: str | None,
        ch: str | None,
        *,
        skipped: bool = False,
    ) -> None:
        ends[sp.step.step_id] = end
        steps_out[sp.step.step_id] = StepSchedule(
            step_id=sp.step.step_id,
            sequence_order=sp.step.sequence_order,
            kind=sp.step.kind,
            start_week=start,
            end_week=end,
            duration_weeks=0 if skipped else sp.duration,
            assigned_engineer_id=eng,
            assigned_chamber_id=ch,
            skipped=skipped,
        )

    for sid in plan.workflow.walk_order:
        sp = plan.steps[sid]
        preds = sp.step.predecessor_ids
        pred_end = max(ends[p] for p in preds) if preds else frontier - 1

        if sp.skipped:
            emit(sp, pred_end, pred_end, None, None, skipped=True)
            continue

        if sid in plan.held_step_ids:
            # Blocked hold (ADR 0006 / 0009): the Blocked step keeps its fixed
            # start and is shown up to the hold frontier; every successor is
            # held there, transparently, and nothing is booked.
            if sp.status == STATUS_BLOCKED:
                assert sp.actual_start_week is not None
                hold_week = max(current_week, pred_end + 1, sp.actual_start_week)
                emit(sp, sp.actual_start_week, max(sp.actual_start_week, hold_week - 1), None, None)
            else:
                emit(sp, pred_end, pred_end, None, None)
            continue

        if sid in prebooked:
            pl = prebooked[sid]
            emit(sp, pl.start_week, pl.end_week, pl.engineer_id, pl.chamber_id)
            continue

        if not frozen and sp.status == STATUS_DONE:
            # Only reachable when the Done lab step had no eligible chamber at
            # pre-booking time — same dead end as below.
            assert sp.actual_start_week is not None and sp.actual_end_week is not None
            placement, conflict, over = _book_anchored(
                ctx,
                state,
                sp,
                leader,
                region,
                sp.actual_start_week,
                sp.actual_end_week,
                project_id=project.project_id,
                consume_from=current_week,
            )
            if placement is None:
                left_out, no_chamber_step_id = True, sid
                break
            eng_conflict |= conflict
            overlap |= over
            emit(
                sp,
                placement.start_week,
                placement.end_week,
                placement.engineer_id,
                placement.chamber_id,
            )
            continue

        if not frozen and sp.status in (STATUS_IN_PROGRESS, STATUS_BLOCKED):
            # Anchored step whose predecessor was not yet known at pre-booking
            # (inconsistent data: in progress behind a not-started step) — the
            # tail is placed now, still without a search.
            assert sp.actual_start_week is not None
            if sp.remaining == 0:
                emit(sp, sp.actual_start_week, max(sp.actual_start_week, pred_end), None, None)
                continue
            tail_start = max(current_week, pred_end + 1, sp.actual_start_week)
            placement, conflict, over = _book_anchored(
                ctx,
                state,
                sp,
                leader,
                region,
                tail_start,
                tail_start + sp.remaining - 1,
                project_id=project.project_id,
                consume_from=current_week,
                reported_start=sp.actual_start_week,
            )
            if placement is None:
                left_out, no_chamber_step_id = True, sid
                break
            eng_conflict |= conflict
            overlap |= over
            emit(
                sp,
                placement.start_week,
                placement.end_week,
                placement.engineer_id,
                placement.chamber_id,
            )
            continue

        # --- Not Started (or frozen): place per the Booking rules -----------------
        duration = sp.duration
        w = pred_end + 1 if frozen else max(current_week, pred_end + 1)
        kind = sp.step.kind

        if kind == "design":
            if frozen:
                eng_conflict |= state.book_engineer(
                    leader.engineer_id, range(w, w + duration), project.project_id
                )
            else:
                while w + duration <= horizon and not state.engineer_free(
                    leader.engineer_id, range(w, w + duration)
                ):
                    w += 1
                if w + duration > horizon:
                    left_out = True
                    break
                state.book_engineer(leader.engineer_id, range(w, w + duration), project.project_id)
            emit(sp, w, w + duration - 1, leader.engineer_id, None)

        elif kind == "lab":
            eligible = _eligible_chambers(ctx.chambers_by_id, region, sid)
            if not eligible:
                left_out, no_chamber_step_id = True, sid
                break
            if frozen:
                chosen = eligible[0]
                overlap |= state.book_chamber(chosen, range(w, w + duration))
            else:
                chosen_opt: ChamberInput | None = None
                while w + duration <= horizon and chosen_opt is None:
                    for candidate in eligible:
                        if state.chamber_free(candidate, range(w, w + duration)):
                            chosen_opt = candidate
                            break
                    if chosen_opt is None:
                        w += 1
                if chosen_opt is None:
                    left_out = True
                    break
                chosen = chosen_opt
                state.book_chamber(chosen, range(w, w + duration))
            emit(sp, w, w + duration - 1, None, chosen.chamber_id)

        else:  # elapsed: books nothing, starts at its earliest feasible start
            if not frozen and w + duration > horizon:
                left_out = True
                break
            emit(sp, w, w + duration - 1, None, None)

    if left_out:
        # DOMAIN_RULES "Gate remediation rulings" #2: in-flight work is never
        # erased. Pre-booked anchored rows the walk did not reach are still
        # emitted (their capacity is already consumed).
        for sid in plan.workflow.walk_order:
            if sid in prebooked and sid not in steps_out:
                pl = prebooked[sid]
                emit(plan.steps[sid], pl.start_week, pl.end_week, pl.engineer_id, pl.chamber_id)

    steps_tuple = tuple(sorted(steps_out.values(), key=lambda s: (s.sequence_order, s.step_id)))
    non_skipped = [s for s in steps_tuple if not s.skipped]
    start_week = min((s.start_week for s in non_skipped), default=None)
    end_week = max((s.end_week for s in non_skipped), default=None)
    held = bool(plan.held_step_ids)

    scheduled = not left_out and not held and end_week is not None
    completion_week = end_week + project.delay_weeks if scheduled and end_week is not None else None
    within_year = completion_week is not None and completion_week <= si.within_year_week
    spillover = scheduled and not within_year

    unconstrained = unconstrained_end_week(plan, current_week)
    return ProjectScheduleOutcome(
        project_id=project.project_id,
        excluded=False,
        left_out=left_out,
        eng_conflict=eng_conflict,
        overlap=overlap,
        cat_not_allowed=cat_not_allowed,
        spillover=spillover,
        within_year=within_year,
        no_leader=False,
        no_chamber_step_id=no_chamber_step_id,
        steps=steps_tuple,
        start_week=start_week,
        end_week=end_week,
        unconstrained_end_week=unconstrained,
        expected_end_week=_expected_end_week(project, unconstrained),
        projected_end_week=completion_week,
        blocked=plan.blocked,
        progress_pct=compute_progress_pct(plan),
        data_error=None,
    )
