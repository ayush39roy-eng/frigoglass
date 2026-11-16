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
     tails from `max(CURRENT_WEEK, gate)` for `remaining` weeks. These
     are facts about work already under way, so they must be on the books
     before any *search* for a free window (otherwise a higher-priority
     not-started project could grab the very weeks an in-progress project is
     already occupying). Conflicts here are flagged, never resolved by moving
     the anchored step (I11).
  4. Walk the non-frozen projects in scheduling order: each step in the DAG's
     deterministic walk order gets `earliest_start = gate(s)` (floored at
     CURRENT_WEEK and, for a Not Started step, at its ADR 0019
     `start_not_before_week`); `design` searches the leader's calendar,
     `lab` searches eligible chambers, `elapsed` books nothing, `skipped`
     steps are transparent, held (Blocked) steps are not placed.

Precedence (ADR 0009 as amended by ADR 0043): `gate(s)` and the release
`G(q)` a step passes on are `workflow.step_gate` / `workflow.passed_release`.
With every `overlap_weeks` 0, `gate(s) = max(pred.end) + 1` and `G(q) =
end(q)`, i.e. exactly the pre-P32 rule, so every golden file is unchanged. A
step with an overlap may start up to `o(s)` weeks before its release, but never
before the step it runs in parallel with has started; it then passes its
predecessors' end on, so successors still wait for all upstream work.

P33 (ADR 0046 as ruled, R33-1/R33-4): a Not Started step's gate also carries
its wait (`release + 1 + w`; `workflow.step_gate`), a wait books nothing, and a
step's duration is `override ?? (lead_weeks ?? table)` (`analyse_project`).
Sort key 5 is the category's rank from `ScheduleInput.categories` (ADR 0047
§3, R33-8), validated in `prepare_run`. With every wait 0, no `lead_weeks` and
the default category list, every run is byte-identical to before P33.

FTE (ADR 0032, supersedes ADR 0002): a design step of a non-frozen project
books `span = ceil(duration / leader.fte)` consecutive weeks of its leader (an
In Progress tail `ceil(remaining / fte)`); `duration_weeks` on the output row
stays the effort figure, so load (I6) is unchanged. Frozen projects are not
stretched (their dates stay locked, I10). A leader at FTE <= 0 makes the
project a `data_error` (see `workflow.analyse_project`).

Leader and capacity hub (ADR 0042, P29): this walk never *chooses* an
engineer — it books the project's assigned `leader_engineer_id` (DOMAIN_RULES
"Booking rules": "the project's assigned leader must be free"), wherever that
engineer's hub is; the only eligibility test on the leader is the category
rule (`_cat_not_allowed`, a warning). A project whose leader is unset or does
not resolve is `LEFT_OUT` with `no_leader` and books nothing (`_no_leader_outcome`;
`prebook_anchored_steps` skips it) — unchanged by ADR 0042, whose seed assigns
provisional leaders upstream. `ProjectInput.capacity_hub` (R&D-Greece for the
OEM hubs) is the pool that engineer *selection* draws from — the what-if
leader picker (`whatif._pick_leader`) and the service-side pickers — and the
key of the capacity-hub load aggregate; workflow and lab region still follow
`project.hub` (`_is_oem_hub`, `_lab_region_for_hub`).

Manual step pins (ADR 0054 as ruled at P40-T02, R40-3..R40-7; DOMAIN_RULES
"Manual step weeks"): `ProjectInput.step_pins` fixes a step on its effective
window (`workflow.pin_windows`: the pin, or `cw .. cw + L - 1` when a
non-frozen pin has lapsed). A frozen project's pins are booked in its walk
(phase 2); a non-frozen project's pins are pre-booked with the anchored steps
(phase 3, `prebook_anchored_steps`), before any search. Pins are booked like
anchored steps, regardless of conflict (`_book_anchored`), and two fixed
design placements of the same project sharing a week raise ENG_CONFLICT when
one is a pin (`_ResourceState.book_engineer`). A pinned step ignores its own
gate and passes on `max(end, release)`; `manual_overlap` is evaluated on the
emitted rows (`workflow.manual_overlap_by_row`). The row reports `eff` as
`duration_weeks` (R40-3). With no pin anywhere every run is byte-identical to
before P40 (I48(a)).

Priority band meaning (ADR 0056 as ruled at P42-T01, R42-2..R42-5; DOMAIN_RULES
"Priority band meaning"): `prepare_run` checks status exclusion first, then
sets aside every non-frozen P4/Q project in a schedulable status
(`ctx.not_scheduled`, before validation; `not_scheduled_priority_outcome`).
Sort key 1a (`counts_toward_year` desc) walks every queued P3 (In Queue) after
all counting work, so it only takes spare capacity; its anchored and pinned
steps are still pre-booked in phase 3. Every outcome carries
`counts_toward_year` and its year flags come from `year_flags` (I50). With no
P4/Q and no queued P3 in the input every run is byte-identical to before P42.

No DB access, no network access, no filesystem access, no randomness, no
wall-clock dependence. Every collection this module iterates is explicitly
sorted before iteration.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace

import domain_constants as dc
from scheduling import hubs
from scheduling.types import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
    default_categories,
)
from scheduling.workflow import (
    STATUS_BLOCKED,
    STATUS_DONE,
    STATUS_IN_PROGRESS,
    CategoryMaps,
    ProjectPlan,
    StepPlan,
    Workflow,
    analyse_project,
    build_category_maps,
    build_lead_time_table,
    build_workflows,
    compute_progress_pct,
    first_step_frontier,
    is_default_categories,
    leader_fte_of,
    manual_overlap_by_row,
    passed_release,
    pin_windows,
    pinned_release,
    pins_lapsed,
    release_week,
    step_gate,
    unconstrained_end_week,
    validate_schedulable_project,
)

#: The seeded categories (ranks 1..7, `CATEGORY_RANK` order): the fallback of
#: `_sort_key` / `_cat_not_allowed` for callers that pass no category list.
_DEFAULT_CATEGORIES: CategoryMaps = build_category_maps(default_categories())

# --- Small pure helpers ------------------------------------------------------


def _is_oem_hub(hub: str) -> bool:
    return hubs.is_oem_hub(hub)


def _lab_region_for_hub(hub: str) -> str:
    # ADR 0041 §4 / R14: both spellings of a renamed hub are accepted
    # (`scheduling.hubs`), so an old run's input snapshot still replays.
    if hub not in hubs.HUB_LAB_REGION:
        raise ValueError(f"unknown hub {hub!r}; expected one of {sorted(hubs.HUB_LAB_REGION)}")
    return hubs.HUB_LAB_REGION[hub]


def _cat_not_allowed(
    project: ProjectInput,
    leader: EngineerInput,
    category_workflow: Mapping[str, str] | None = None,
) -> bool:
    """CAT_NOT_ALLOWED: the leader's `allowed_categories` excludes the project's
    category, "or OEM for OEM-hub projects". An OEM-hub leader is eligible if
    `allowed_categories` carries either the generic `"OEM"` marker or the
    project's own OEM-workflow category (ADR 0007: engineer eligibility now
    accepts the OEM categories explicitly). P33 (R33-8): "an OEM-workflow
    category" is read from the input's category list (`category_workflow`,
    default: the seeded seven), not from a constant."""

    workflow_of = _DEFAULT_CATEGORIES.workflow if category_workflow is None else category_workflow
    allowed = leader.allowed_categories
    if _is_oem_hub(project.hub):
        oem_cat_ok = (
            project.category is not None
            and workflow_of.get(project.category) == "OEM"
            and project.category in allowed
        )
        return not ("OEM" in allowed or oem_cat_ok)
    return project.category not in allowed


def _band_rank_key(band_rank: int | None) -> tuple[int, int]:
    """Scheduling order key 3a (ADR 0050, R36-9 / I37a): `band_rank`
    ascending, `None` after every integer. `(0, rank)` / `(1, 0)` keeps the
    tuple totally ordered (never compares `None` with an int)."""

    return (1, 0) if band_rank is None else (0, band_rank)


def project_counts_toward_year(project: ProjectInput) -> bool:
    """R42-4 on one input project (`domain_constants.counts_toward_year`)."""

    return dc.counts_toward_year(project.priority, project.status)


def is_not_scheduled_priority(project: ProjectInput) -> bool:
    """R42-3: a non-frozen project in a schedulable status with priority P4
    or Q is never scheduled, in every solver and path. Status exclusion is
    checked first (a status-excluded project is never this), and VIP does
    not override it."""

    return (
        project.status in dc.SCHEDULABLE_STATUS_ORDER
        and not project.frozen
        and project.priority in dc.NOT_SCHEDULED_PRIORITIES
    )


def year_flags(
    *, counts_toward_year: bool, scheduled: bool, completion_week: int | None, within_year_week: int
) -> tuple[bool, bool]:
    """The one shared year-basis rule (R42-4, I50; I9 follows it), used by
    the greedy walk (frozen and non-frozen) and by CP-SAT extraction::

        within_year = counts ∧ scheduled ∧ completion_week ≤ within_year_week
        spillover   = counts ∧ scheduled ∧ ¬within_year

    Returns `(within_year, spillover)`. With `counts_toward_year` True this
    is exactly the pre-P42 rule."""

    if not (counts_toward_year and scheduled) or completion_week is None:
        return False, False
    within = completion_week <= within_year_week
    return within, not within


def _sort_key(
    project: ProjectInput, category_rank: Mapping[str, int] | None = None
) -> tuple[int, int, int, int, tuple[int, int], int, int, str]:
    """DOMAIN_RULES.md "Scheduling order": frozen desc, `counts_toward_year`
    desc (key 1a, ADR 0056 R42-5), is_vip desc (ADR 0040),
    priority, band_rank asc with None last (key 3a, ADR 0050), status,
    category rank, then an explicit `project_id` tiebreak (P2-T01 decision: a
    pure function must not derive determinism from caller ordering). With no
    VIP project the order is exactly the pre-ADR-0040 one; with every
    `band_rank` None it is exactly the pre-P36 one (key 3a is constant).
    With no queued P3 (and no frozen P4/Q; a non-frozen P4/Q never reaches
    the sort) key 1a is constant, so the order is exactly the pre-P42 one.
    Key 1a puts every queued P3 after all counting work, VIP included
    (R42-5): spare capacity only.

    Key 5 is the category's `rank` value from the input's category list
    (ADR 0047 §3, R33-8; default: the seeded seven at ranks 1..7, i.e.
    `A+ → A → B → C → A-OEM → B-OEM → C-OEM`, the pre-P33 order).

    This is the only scheduling sort (R36-4): CP-SAT, Monte Carlo, What-if
    and plan import all take their order from `prepare_run` / this key."""

    rank = _DEFAULT_CATEGORIES.rank if category_rank is None else category_rank
    return (
        0 if project.frozen else 1,
        0 if project_counts_toward_year(project) else 1,
        0 if project.is_vip else 1,
        dc.PRIORITY_ORDER.index(project.priority),
        _band_rank_key(project.band_rank),
        dc.SCHEDULABLE_STATUS_ORDER[project.status],
        rank[project.category],  # type: ignore[index]
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
        # ADR 0054 (R40-6, F4): which projects hold an engineer-week through a
        # *pinned* placement, so two fixed design placements of the same
        # project sharing a week raise ENG_CONFLICT when one of them is a pin.
        # Empty in every run without pins, so nothing else changes.
        self.eng_pin_owners: dict[str, dict[int, set[str]]] = {}

    def book_engineer(
        self, engineer_id: str, weeks: range, project_id: str, *, pinned: bool = False
    ) -> bool:
        """Consume `weeks` regardless of conflict; return True if any was busy.
        On a conflict, `project_id` and every earlier holder of the clashing
        weeks are added to `eng_conflict_projects`.

        ADR 0054 (R40-6, F4): a week the same project already holds is also a
        conflict when either booking is a pin (`pinned`, or an earlier pinned
        booking of this project in that week): pin and pin, pin and anchored
        tail, pin and frozen step. Two non-pinned bookings of one project stay
        unflagged, exactly as before P40."""

        busy = self.eng_busy.setdefault(engineer_id, set())
        owners = self.eng_owners.setdefault(engineer_id, {})
        pin_owners = self.eng_pin_owners.get(engineer_id)
        conflict = False
        for wk in weeks:
            holders = owners.setdefault(wk, set())
            if wk in busy and holders - {project_id}:
                conflict = True
                self.eng_conflict_projects.update(holders)
                self.eng_conflict_projects.add(project_id)
            elif (
                wk in busy
                and project_id in holders
                and (pinned or (pin_owners is not None and project_id in pin_owners.get(wk, ())))
            ):
                conflict = True
                self.eng_conflict_projects.add(project_id)
            busy.add(wk)
            holders.add(project_id)
            if pinned:
                self.eng_pin_owners.setdefault(engineer_id, {}).setdefault(wk, set()).add(
                    project_id
                )
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
    # ADR 0047 §3 / R33-8: the validated category list (rank, workflow).
    categories: CategoryMaps = _DEFAULT_CATEGORIES
    # ADR 0056 R42-3: non-frozen P4/Q projects in a schedulable status,
    # excluded before validation (input order; outcomes are emitted by id).
    # Never in `ordered`, `plans` or `scheduling_order`.
    not_scheduled: tuple[ProjectInput, ...] = ()


def prepare_run(schedule_input: ScheduleInput) -> RunContext:
    if schedule_input.horizon_weeks < 1:
        raise ValueError("horizon_weeks must be >= 1")

    workflows = build_workflows(schedule_input.workflow_steps)
    lead_time_table = build_lead_time_table(schedule_input.lead_times)
    categories = category_maps_for(schedule_input, workflows)
    engineers_by_id = {e.engineer_id: e for e in schedule_input.engineers}
    chambers_by_id = {c.chamber_id: c for c in schedule_input.chambers}

    schedulable: list[ProjectInput] = []
    excluded: list[ProjectInput] = []
    not_scheduled: list[ProjectInput] = []
    for project in schedule_input.projects:
        if project.status not in dc.SCHEDULABLE_STATUS_ORDER:
            # Commercialized / On Hold / Cancelled / Draft / anything else.
            # R42-3: status exclusion is checked first, whatever the band.
            excluded.append(project)
        elif is_not_scheduled_priority(project):
            # R42-3: non-frozen P4/Q, excluded before validation (VIP or not,
            # started or not: its anchored stages are not pre-booked).
            not_scheduled.append(project)
        else:
            schedulable.append(project)

    fte_by_engineer = {e.engineer_id: e.fte for e in schedule_input.engineers}
    plans: dict[str, ProjectPlan] = {}
    for project in schedulable:
        validate_schedulable_project(
            project,
            workflows,
            lead_time_table,
            hub_lab_region=hubs.HUB_LAB_REGION,
            priority_order=dc.PRIORITY_ORDER,
            horizon_weeks=schedule_input.horizon_weeks,
            category_workflow=categories.workflow,
        )
        plans[project.project_id] = analyse_project(
            project,
            workflows[project.workflow_id],
            lead_time_table,
            leader_fte=leader_fte_of(project, fte_by_engineer),
        )

    return RunContext(
        schedule_input=schedule_input,
        workflows=workflows,
        lead_time_table=lead_time_table,
        engineers_by_id=engineers_by_id,
        chambers_by_id=chambers_by_id,
        plans=plans,
        ordered=tuple(sorted(schedulable, key=lambda p: _sort_key(p, categories.rank))),
        excluded=tuple(excluded),
        categories=categories,
        not_scheduled=tuple(not_scheduled),
    )


def category_maps_for(
    schedule_input: ScheduleInput, workflows: Mapping[str, Workflow]
) -> CategoryMaps:
    """R33-8: the validated category list of `schedule_input`. A list equal to
    the seeded default is not checked against the input's workflows (see
    `build_category_maps`); any other list is."""

    if is_default_categories(schedule_input.categories):
        return build_category_maps(schedule_input.categories)
    return build_category_maps(schedule_input.categories, workflow_ids=sorted(workflows))


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
    for project in ctx.not_scheduled:
        outcomes_by_id[project.project_id] = not_scheduled_priority_outcome(project)

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
        # R42-3: a status-excluded project counts toward the year (True).
        counts_toward_year=project_counts_toward_year(project),
    )


def not_scheduled_priority_outcome(project: ProjectInput) -> ProjectScheduleOutcome:
    """R42-3 / I49: the outcome of a non-frozen P4/Q project in a schedulable
    status. Excluded, never scheduled, never counted: no rows, every week
    null, `progress_pct` null, every year / structural flag False."""

    return ProjectScheduleOutcome(
        project_id=project.project_id,
        excluded=True,
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
        expected_end_week=None,
        projected_end_week=None,
        blocked=False,
        progress_pct=None,
        data_error=None,
        not_scheduled_priority=True,
        counts_toward_year=False,
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
        pin_lapsed=pins_lapsed(plan, current_week) if plan.pinned_step_ids else False,
        counts_toward_year=project_counts_toward_year(project),
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
        counts_toward_year=project_counts_toward_year(project),
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

    ADR 0054 (R40-6): the manual pins of these projects are pre-booked in the
    same pass, in the same order (per project in scheduling order, steps in
    walk order), on their effective windows (R40-5), so a later-priority
    project's pin keeps its weeks against a higher-priority project that has
    not started (as Gate ruling 4 does for anchored steps). A pin whose window
    ends past the horizon is not booked (the walk makes the project LEFT_OUT);
    a lab pin with no eligible chamber is not booked either (`no_chamber`).

    Returns `(placements[project_id][step_id], (eng_conflict, overlap)[project_id])`.
    """

    current_week = ctx.schedule_input.current_week
    horizon = ctx.schedule_input.horizon_weeks
    placements: dict[str, dict[str, _Placement]] = {}
    flags: dict[str, tuple[bool, bool]] = {}

    for project in projects:
        plan = ctx.plans[project.project_id]
        if plan.data_error is not None or not (plan.progress_tracked or plan.pinned_step_ids):
            continue
        leader = ctx.engineers_by_id.get(project.leader_engineer_id or "")
        if leader is None:
            continue  # no_leader -> LEFT_OUT with nothing booked (unchanged)
        region = _lab_region_for_hub(project.hub)
        frontier = first_step_frontier(project, current_week)
        pins = pin_windows(plan, current_week) if plan.pinned_step_ids else {}

        # ADR 0043: `known_g[q]` is the release G(q) a known step passes on
        # (== its end when it has no overlap) and `known_starts[q]` its start
        # (for the start anchor of an overlapping successor).
        known_g: dict[str, int] = {}
        known_starts: dict[str, int] = {}
        placed: dict[str, _Placement] = {}
        eng_conflict = False
        overlap = False

        for sid in plan.workflow.walk_order:
            sp = plan.steps[sid]
            preds = sp.step.predecessor_ids
            preds_known = all(p in known_g for p in preds)
            release = release_week(sp.step, known_g, frontier) if preds_known else None
            gate = (
                _known_gate(plan, sp, release, known_starts, frontier)
                if release is not None
                else None
            )

            if sp.skipped:
                if release is not None:
                    _know(known_g, known_starts, sp, release, release, release)
                continue
            if sid in plan.held_step_ids:
                # Held: not placed here (see _schedule_one_project); its end is
                # known if its predecessors are, so successors stay consistent.
                if gate is not None and release is not None and sp.status == STATUS_BLOCKED:
                    assert sp.actual_start_week is not None
                    hold_week = max(current_week, gate, sp.actual_start_week)
                    _know(
                        known_g,
                        known_starts,
                        sp,
                        sp.actual_start_week,
                        max(sp.actual_start_week, hold_week - 1),
                        release,
                    )
                elif release is not None and sp.status != STATUS_BLOCKED:
                    _know(known_g, known_starts, sp, release, release, release)
                continue

            if sid in pins:
                # ADR 0054: a fixed placement on the effective window, booked
                # regardless of conflict; it ignores its own gate (R40-7).
                win = pins[sid]
                if win.end_week > horizon:
                    continue  # R40-5: LEFT_OUT in the walk, nothing booked
                placement, conflict, over = _book_anchored(
                    ctx,
                    state,
                    sp,
                    leader,
                    region,
                    win.start_week,
                    win.end_week,
                    project_id=project.project_id,
                    consume_from=current_week,
                    pinned=True,
                )
                if placement is None:
                    continue  # no eligible chamber: the walk reports no_chamber / LEFT_OUT
                eng_conflict |= conflict
                overlap |= over
                placed[sid] = placement
                known_starts[sid] = placement.start_week
                if release is not None:
                    known_g[sid] = pinned_release(placement.end_week, release)
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
                _know(known_g, known_starts, sp, placement.start_week, placement.end_week, release)
                continue

            if sp.status in (STATUS_IN_PROGRESS, STATUS_BLOCKED):
                assert sp.actual_start_week is not None
                if gate is None:
                    continue  # placed during the walk
                if sp.remaining_span == 0:
                    end = max(sp.actual_start_week, gate - 1)
                    placed[sid] = _Placement(sp.actual_start_week, end, None, None)
                    _know(known_g, known_starts, sp, sp.actual_start_week, end, release)
                    continue
                # ADR 0032: the remaining effort is stretched by the leader's FTE.
                # ADR 0043: `gate` replaces `pred_end + 1`.
                tail_start = max(current_week, gate, sp.actual_start_week)
                tail_end = tail_start + sp.remaining_span - 1
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
                _know(known_g, known_starts, sp, placement.start_week, placement.end_week, release)
                continue
            # Not Started: unknown until the walk.

        if placed:
            placements[project.project_id] = placed
            flags[project.project_id] = (eng_conflict, overlap)
    return placements, flags


def _known_gate(
    plan: ProjectPlan,
    sp: StepPlan,
    release: int,
    known_starts: dict[str, int],
    frontier: int,
) -> int | None:
    """ADR 0043 `gate(s)` at pre-booking time; `None` while a start anchor is
    not yet known."""

    anchors = plan.start_anchor_ids(sp.step.step_id) if sp.overlap_weeks else ()
    if any(r not in known_starts for r in anchors):
        return None
    return step_gate(sp, release, (known_starts[r] for r in anchors), frontier)


def _know(
    known_g: dict[str, int],
    known_starts: dict[str, int],
    sp: StepPlan,
    start: int,
    end: int,
    release: int | None,
) -> None:
    """Record a step known at pre-booking time: its start, and its release
    `G` when computable (a step with an overlap needs its own release to pass
    it on; with no overlap `G` is its end, as before P32)."""

    sid = sp.step.step_id
    known_starts[sid] = start
    if sp.overlap_weeks == 0 and not sp.skipped:
        known_g[sid] = end
    elif release is not None:
        known_g[sid] = passed_release(sp, end, release)


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
    pinned: bool = False,
) -> tuple[_Placement | None, bool, bool]:
    """Consume capacity for `[max(start, consume_from) .. end]` regardless of
    conflict (DOMAIN_RULES.md: capacity is only tracked for weeks >=
    CURRENT_WEEK; anchored placements never move). Returns
    `(placement, eng_conflict, overlap)`; `placement is None` only for a lab
    step with zero eligible chambers.

    Lab steps (DOMAIN_RULES "Gate remediation rulings" #1): the first eligible
    chamber, in chamber_id order, with room for every consumed week; only
    when none has room is the step booked over capacity (into the first
    eligible chamber) and OVERLAP raised.

    ADR 0054 (R40-6): a manual pin is booked through here too (`pinned`), on
    its effective window: a design pin books the leader in every week, a lab
    pin one platform of one chamber per week, an elapsed pin nothing."""

    weeks = range(max(start, consume_from), end + 1)
    shown_start = reported_start if reported_start is not None else start
    kind = sp.step.kind
    if kind == "design":
        conflict = state.book_engineer(leader.engineer_id, weeks, project_id, pinned=pinned)
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

    cat_not_allowed = _cat_not_allowed(project, leader, ctx.categories.workflow)
    region = _lab_region_for_hub(project.hub)
    frontier = first_step_frontier(project, current_week)
    frozen = project.frozen
    # ADR 0054: the pins this walk places (effective windows, R40-5).
    pins = pin_windows(plan, current_week) if plan.pinned_step_ids else {}

    eng_conflict, overlap = pre_flags
    left_out = False
    no_chamber_step_id: str | None = None
    ends: dict[str, int] = {}
    starts: dict[str, int] = {}
    g: dict[str, int] = {}  # ADR 0043 release G(q) each emitted step passes on
    steps_out: dict[str, StepSchedule] = {}

    def emit(
        sp: StepPlan,
        start: int,
        end: int,
        eng: str | None,
        ch: str | None,
        *,
        skipped: bool = False,
        pinned: bool = False,
    ) -> None:
        ends[sp.step.step_id] = end
        starts[sp.step.step_id] = start
        # R40-7: a pinned step passes on max(end, release).
        g[sp.step.step_id] = (
            pinned_release(end, release) if pinned else passed_release(sp, end, release)
        )
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
            pinned=pinned,
        )

    release = frontier - 1
    for sid in plan.workflow.walk_order:
        sp = plan.steps[sid]
        # ADR 0043: release(s) and gate(s); with no overlap anywhere these are
        # max(pred.end) and max(pred.end) + 1, exactly the pre-P32 rule.
        release = release_week(sp.step, g, frontier)

        if sp.skipped:
            emit(sp, release, release, None, None, skipped=True)
            continue
        gate = step_gate(sp, release, (starts[r] for r in plan.start_anchor_ids(sid)), frontier)

        if sid in plan.held_step_ids:
            # Blocked hold (ADR 0006 / 0009): the Blocked step keeps its fixed
            # start and is shown up to the hold frontier; every successor is
            # held there, transparently, and nothing is booked.
            if sp.status == STATUS_BLOCKED:
                assert sp.actual_start_week is not None
                hold_week = max(current_week, gate, sp.actual_start_week)
                emit(sp, sp.actual_start_week, max(sp.actual_start_week, hold_week - 1), None, None)
            else:
                emit(sp, release, release, None, None)
            continue

        if sid in pins:
            # ADR 0054 (R40-5 / R40-6 / R40-7): the step sits exactly on its
            # effective window, ignoring its own gate, wait, overlap, floor and
            # the frontier. Non-frozen pins were pre-booked; a frozen
            # project's pins are booked here, in walk order (phase 2).
            win = pins[sid]
            if win.end_week > horizon:
                left_out = True
                break
            if sid in prebooked:
                pl = prebooked[sid]
                emit(sp, pl.start_week, pl.end_week, pl.engineer_id, pl.chamber_id, pinned=True)
                continue
            placement, conflict, over = _book_anchored(
                ctx,
                state,
                sp,
                leader,
                region,
                win.start_week,
                win.end_week,
                project_id=project.project_id,
                consume_from=win.start_week if frozen else current_week,
                pinned=True,
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
                pinned=True,
            )
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
            if sp.remaining_span == 0:
                emit(sp, sp.actual_start_week, max(sp.actual_start_week, gate - 1), None, None)
                continue
            tail_start = max(current_week, gate, sp.actual_start_week)
            placement, conflict, over = _book_anchored(
                ctx,
                state,
                sp,
                leader,
                region,
                tail_start,
                tail_start + sp.remaining_span - 1,
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
        # Elapsed weeks booked: the effective duration (ADR 0019), stretched by
        # the leader's FTE for a design step (ADR 0032). `emit` still reports
        # the effort (`sp.duration`) as `duration_weeks`.
        duration = sp.span
        w = gate if frozen else max(current_week, gate)
        if sp.start_not_before_week is not None:
            # ADR 0019 earliest start (never set for a frozen project): the
            # search floor is max(CURRENT_WEEK, gate(s), floor).
            w = max(w, sp.start_not_before_week)
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
                emit(
                    plan.steps[sid],
                    pl.start_week,
                    pl.end_week,
                    pl.engineer_id,
                    pl.chamber_id,
                    pinned=sid in pins,
                )

    manual_overlap = False
    if pins:
        # R40-7 / I47(a): evaluated on this walk's own rows.
        for sid, flagged in manual_overlap_by_row(plan, steps_out, frontier).items():
            if flagged:
                steps_out[sid] = replace(steps_out[sid], manual_overlap=True)
                manual_overlap = True

    steps_tuple = tuple(sorted(steps_out.values(), key=lambda s: (s.sequence_order, s.step_id)))
    non_skipped = [s for s in steps_tuple if not s.skipped]
    start_week = min((s.start_week for s in non_skipped), default=None)
    end_week = max((s.end_week for s in non_skipped), default=None)
    held = bool(plan.held_step_ids)

    scheduled = not left_out and not held and end_week is not None
    completion_week = end_week + project.delay_weeks if scheduled and end_week is not None else None
    # R42-4 / I50: the shared year basis (a frozen walk too: a frozen P4/Q or
    # queued P3 books its capacity but never counts).
    counts = project_counts_toward_year(project)
    within_year, spillover = year_flags(
        counts_toward_year=counts,
        scheduled=scheduled,
        completion_week=completion_week,
        within_year_week=si.within_year_week,
    )

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
        manual_overlap=manual_overlap,
        pin_lapsed=pins_lapsed(plan, current_week) if pins else False,
        counts_toward_year=counts,
    )
