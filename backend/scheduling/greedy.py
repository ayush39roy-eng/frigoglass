"""Greedy serial schedule-generation scheme (SGS), per `docs/DOMAIN_RULES.md`.

Implemented directly from DOMAIN_RULES.md's "Scheduling order", "Booking
rules", and Invariants I1-I10 — see the P2-T01 `docs/MEMORY.md` entry for
every place `reference/rpd-platform-prototype.html`'s scheduler (function
`qm`, read but never transliterated) was consulted to resolve a genuine
ambiguity DOMAIN_RULES.md leaves open, and exactly what was decided and why.

No DB access, no network access, no filesystem access, no randomness, no
wall-clock dependence. Every collection this module iterates is explicitly
sorted before iteration — never relies on dict/set insertion order (Invariant
I8's "no set-iteration-order dependence" requirement).
"""

from __future__ import annotations

import domain_constants as dc
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

# --- Small pure helpers ------------------------------------------------------


def _duration_weeks(base_weeks: int, category: str) -> int:
    """``max(1, round(base_weeks * multiplier))`` — DOMAIN_RULES.md "Category
    multipliers". Delegates to `domain_constants.duration_weeks` (the same
    formula P1's seed script and priority scoring already use) rather than
    re-implementing it, to avoid a second, driftable copy of a one-line
    formula. See the P2-T01 MEMORY.md entry for why importing
    `domain_constants` from `scheduling/` does not violate the purity
    constraint (it is pure data + this one pure helper, no DB/model/network
    dependency of its own).
    """

    if category not in dc.CATEGORY_MULTIPLIERS:
        raise ValueError(
            f"unknown project category {category!r}; expected one of {dc.CATEGORY_ORDER}"
        )
    return dc.duration_weeks(base_weeks, category)


def _is_oem_hub(hub: str) -> bool:
    return hub in dc.OEM_HUBS


def _lab_region_for_hub(hub: str) -> str:
    if hub not in dc.HUB_LAB_REGION:
        raise ValueError(f"unknown hub {hub!r}; expected one of {sorted(dc.HUB_LAB_REGION)}")
    return dc.HUB_LAB_REGION[hub]


def _validate_schedulable_project(project: ProjectInput) -> None:
    """Fail loudly on malformed input for a project whose status participates
    in scheduling, rather than crashing deep inside the sort key (a `TypeError`/
    `KeyError` from `PRIORITY_ORDER.index(None)` is much harder to diagnose
    than a clear `ValueError` naming the offending project).
    """

    if project.priority not in dc.PRIORITY_ORDER:
        raise ValueError(
            f"project {project.project_id!r}: priority {project.priority!r} is not one of "
            f"{dc.PRIORITY_ORDER} (required for any project whose status participates in "
            "scheduling)"
        )
    if project.category not in dc.CATEGORY_MULTIPLIERS:
        raise ValueError(
            f"project {project.project_id!r}: category {project.category!r} is not one of "
            f"{dc.CATEGORY_ORDER} (required for any project whose status participates in "
            "scheduling)"
        )
    if project.hub not in dc.HUB_LAB_REGION:
        raise ValueError(
            f"project {project.project_id!r}: hub {project.hub!r} is not one of "
            f"{sorted(dc.HUB_LAB_REGION)}"
        )
    if project.frozen and project.actual_start_week is None:
        raise ValueError(
            f"project {project.project_id!r}: frozen=True but actual_start_week is None "
            "(DOMAIN_RULES.md: frozen projects' dates are locked at actual_start)"
        )


def _sort_key(project: ProjectInput) -> tuple[int, int, int, int, str]:
    """DOMAIN_RULES.md "Scheduling order": frozen desc, priority, status,
    category, then an explicit `project_id` tiebreak.

    The `project_id` tiebreak is a deliberate strengthening beyond DOMAIN_RULES.md's
    literal four-key text: the prototype relies on JavaScript's guaranteed-stable
    `Array.sort` to preserve the *caller-supplied array order* for ties on all
    four keys, but nothing in DOMAIN_RULES.md or this function's contract
    promises `ScheduleInput.projects` arrives in any particular order — a pure
    function must not derive determinism (Invariant I8) from an unstated
    assumption about caller ordering. Adding `project_id` as a fifth,
    always-decisive key makes the total order well-defined (no remaining ties)
    regardless of input order, which is strictly stronger than, and never
    contradicts, the documented four-key order. Recorded in the P2-T01
    MEMORY.md entry.
    """

    return (
        0 if project.frozen else 1,
        dc.PRIORITY_ORDER.index(project.priority),
        dc.SCHEDULABLE_STATUS_ORDER[project.status],
        dc.CATEGORY_ORDER.index(project.category),
        project.project_id,
    )


# --- Core algorithm ------------------------------------------------------


def run_greedy_sgs(schedule_input: ScheduleInput) -> ScheduleOutput:
    """Pure function: `ScheduleInput -> ScheduleOutput`. See module docstring."""

    if schedule_input.horizon_weeks < 1:
        raise ValueError("horizon_weeks must be >= 1")

    engineers_by_id: dict[str, EngineerInput] = {e.engineer_id: e for e in schedule_input.engineers}
    chambers_by_id: dict[str, ChamberInput] = {c.chamber_id: c for c in schedule_input.chambers}
    steps_sorted: tuple[WorkflowStepTemplate, ...] = tuple(
        sorted(schedule_input.workflow_steps, key=lambda s: s.sequence_order)
    )

    # Mutable per-run resource state. Fresh on every call — no shared state
    # between calls, which is part of what makes repeated calls on identical
    # input deterministic (Invariant I8).
    eng_busy: dict[str, set[int]] = {e.engineer_id: set() for e in schedule_input.engineers}
    chamber_busy: dict[str, dict[int, int]] = {c.chamber_id: {} for c in schedule_input.chambers}

    schedulable: list[ProjectInput] = []
    excluded: list[ProjectInput] = []
    for project in schedule_input.projects:
        if project.status in dc.SCHEDULABLE_STATUS_ORDER:
            schedulable.append(project)
        else:
            # Any status outside the four ordered statuses is excluded from
            # scheduling entirely (DOMAIN_RULES.md booking rules) — this
            # naturally covers "Commercialized", "On Hold", and the P1-added
            # "Draft" status (not itself named in DOMAIN_RULES.md, per the
            # P1-T01 MEMORY.md entry) without `scheduling/` needing to
            # hardcode a vocabulary that belongs to `backend/models/enums.py`.
            excluded.append(project)

    for project in schedulable:
        _validate_schedulable_project(project)

    ordered = sorted(schedulable, key=_sort_key)

    outcomes_by_id: dict[str, ProjectScheduleOutcome] = {}
    scheduling_order: list[str] = []

    for project in ordered:
        scheduling_order.append(project.project_id)
        outcomes_by_id[project.project_id] = _schedule_one_project(
            project=project,
            steps=steps_sorted,
            engineers_by_id=engineers_by_id,
            chambers_by_id=chambers_by_id,
            eng_busy=eng_busy,
            chamber_busy=chamber_busy,
            current_week=schedule_input.current_week,
            horizon_weeks=schedule_input.horizon_weeks,
            within_year_week=schedule_input.within_year_week,
        )

    for project in excluded:
        outcomes_by_id[project.project_id] = _excluded_outcome(project)

    # Sorted by project_id, independent of ScheduleInput.projects' supplied
    # order — see ScheduleOutput.project_outcomes docstring.
    by_project_id = sorted(schedule_input.projects, key=lambda p: p.project_id)
    project_outcomes = tuple(outcomes_by_id[p.project_id] for p in by_project_id)

    return ScheduleOutput(
        project_outcomes=project_outcomes, scheduling_order=tuple(scheduling_order)
    )


def _excluded_outcome(project: ProjectInput) -> ProjectScheduleOutcome:
    """DOMAIN_RULES.md: "Status Commercialized and On Hold are excluded from
    scheduling entirely." `within_year` for an excluded project: resolved via
    the prototype (function `qm`) since DOMAIN_RULES.md is silent — a
    Commercialized project is trivially "done, within year"
    (`withinYear:true` in the prototype); an On Hold project (or any other
    excluded status) is not counted as delivering this year
    (`withinYear:false`). See the P2-T01 MEMORY.md entry.
    """

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


def _schedule_one_project(
    *,
    project: ProjectInput,
    steps: tuple[WorkflowStepTemplate, ...],
    engineers_by_id: dict[str, EngineerInput],
    chambers_by_id: dict[str, ChamberInput],
    eng_busy: dict[str, set[int]],
    chamber_busy: dict[str, dict[int, int]],
    current_week: int,
    horizon_weeks: int,
    within_year_week: int,
) -> ProjectScheduleOutcome:
    leader = engineers_by_id.get(project.leader_engineer_id) if project.leader_engineer_id else None

    if leader is None:
        # DOMAIN_RULES.md's booking rules do not explicitly cover "no leader
        # assigned" — resolved via the prototype (`m=t.find(...); if(!m){...
        # leftOut=true, noEngineer=true ...}`, which never attempts to book a
        # single step and never evaluates CAT_NOT_ALLOWED). See the P2-T01
        # MEMORY.md entry.
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

    required_category = "OEM" if _is_oem_hub(project.hub) else project.category
    cat_not_allowed = required_category not in leader.allowed_categories

    if project.frozen:
        assert project.actual_start_week is not None  # validated by _validate_schedulable_project
        w = project.actual_start_week
    else:
        # Earliest-start floor for a non-frozen project's first step.
        #
        # DOMAIN_RULES.md never specifies what week the forward search starts
        # from — it only says "Non-frozen projects advance w until a free
        # window is found." The prototype fills this gap with
        # `h = Math.max(actualStart, CURRENT_WEEK - 6)`, treating every
        # project's `actualStart` (even non-frozen ones) as a soft lower-bound
        # scheduling hint.
        #
        # Deliberately NOT replicated here. Two independent reasons: (1) the
        # already-reviewed-and-accepted P1 data model (`docs/MEMORY.md`
        # P1-T03 entry, Decision #2) populates `Project.actual_start_week`
        # ONLY for frozen projects specifically *because* a non-frozen
        # project's `actualStart` is not a real fact worth carrying — building
        # this scheduler around a field the accepted upstream data model
        # deliberately leaves null would silently resurrect exactly the
        # ambiguity P1 already closed; and (2) the "-6" offset has no textual
        # basis anywhere in DOMAIN_RULES.md and is exactly the kind of
        # unexplained magic constant this task's brief warns against silently
        # transliterating. Instead: a non-frozen project's search starts at
        # `current_week` (you cannot schedule new, non-frozen work in the
        # past), and if `actual_start_week` happens to be populated and is
        # later than `current_week`, it is honoured as a further lower bound.
        # Recorded in the P2-T01 MEMORY.md entry and flagged there for
        # P2-T02/T03's differential oracle to specifically scrutinize, since
        # it will produce a systematic (intentional, not a port bug) start-week
        # divergence against the prototype oracle for most non-frozen projects.
        w = current_week
        if project.actual_start_week is not None:
            w = max(w, project.actual_start_week)

    steps_out: list[StepSchedule] = []
    eng_conflict = False
    overlap = False
    left_out = False
    no_chamber_step_id: str | None = None

    for step in steps:
        duration = _duration_weeks(step.base_weeks, project.category)  # type: ignore[arg-type]

        if step.kind == "design":
            if project.frozen:
                # Capacity is consumed regardless of conflict; dates never move.
                for wk in range(w, w + duration):
                    if wk in eng_busy[leader.engineer_id]:
                        eng_conflict = True
                    eng_busy[leader.engineer_id].add(wk)
            else:
                while w + duration <= horizon_weeks:
                    if all(wk not in eng_busy[leader.engineer_id] for wk in range(w, w + duration)):
                        break
                    w += 1
                if w + duration > horizon_weeks:
                    left_out = True
                    break
                for wk in range(w, w + duration):
                    eng_busy[leader.engineer_id].add(wk)

            steps_out.append(
                StepSchedule(
                    step_id=step.step_id,
                    sequence_order=step.sequence_order,
                    kind=step.kind,
                    start_week=w,
                    end_week=w + duration - 1,
                    duration_weeks=duration,
                    assigned_engineer_id=leader.engineer_id,
                    assigned_chamber_id=None,
                )
            )
            w += duration

        else:  # lab step
            region = _lab_region_for_hub(project.hub)
            # Deterministic candidate order: sorted by chamber_id, independent
            # of `ScheduleInput.chambers`' supplied order. The prototype picks
            # among eligible chambers using raw input-array order (`n.filter(...)`,
            # `.find(...)`) — same caller-order-dependence issue as the project
            # sort (see `_sort_key`'s docstring); resolved the same way, for
            # the same determinism reason (Invariant I8), and documented once
            # in the P2-T01 MEMORY.md entry rather than repeated per call site.
            eligible = sorted(
                (
                    c
                    for c in chambers_by_id.values()
                    if c.lab_region == region and step.step_id in c.allowed_stages
                ),
                key=lambda c: c.chamber_id,
            )

            if not eligible:
                left_out = True
                no_chamber_step_id = step.step_id
                break

            if project.frozen:
                # DOMAIN_RULES.md does not specify which chamber a frozen
                # project's lab step is assigned to when multiple are
                # eligible. Resolved via the prototype (`Q=I[0]`, "the first
                # eligible chamber") — here, "first" in the deterministic
                # `chamber_id`-sorted candidate list rather than raw input
                # order, per the same determinism reasoning as above.
                chosen = eligible[0]
                for wk in range(w, w + duration):
                    busy_this_week = chamber_busy[chosen.chamber_id].get(wk, 0) + 1
                    chamber_busy[chosen.chamber_id][wk] = busy_this_week
                    if busy_this_week > chosen.max_concurrent:
                        overlap = True
            else:
                chosen = None
                while w + duration <= horizon_weeks and chosen is None:
                    for candidate in eligible:
                        if all(
                            chamber_busy[candidate.chamber_id].get(wk, 0) < candidate.max_concurrent
                            for wk in range(w, w + duration)
                        ):
                            chosen = candidate
                            break
                    if chosen is None:
                        w += 1
                if chosen is None:
                    left_out = True
                    break
                for wk in range(w, w + duration):
                    chamber_busy[chosen.chamber_id][wk] = (
                        chamber_busy[chosen.chamber_id].get(wk, 0) + 1
                    )

            steps_out.append(
                StepSchedule(
                    step_id=step.step_id,
                    sequence_order=step.sequence_order,
                    kind=step.kind,
                    start_week=w,
                    end_week=w + duration - 1,
                    duration_weeks=duration,
                    assigned_engineer_id=None,
                    assigned_chamber_id=chosen.chamber_id,
                )
            )
            w += duration

    steps_tuple = tuple(steps_out)
    start_week = steps_tuple[0].start_week if steps_tuple else None
    end_week = steps_tuple[-1].end_week if steps_tuple else None
    completion_week = end_week + project.delay_weeks if end_week is not None else None
    within_year = (
        not left_out and completion_week is not None and completion_week <= within_year_week
    )
    spillover = not left_out and not within_year

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
    )
