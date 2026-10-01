"""Reusable invariant validator — Invariants I1-I17, per `docs/DOMAIN_RULES.md`.

This is **the permanent correctness contract** for `backend/scheduling/`.
`workflow-auditor` calls `validate_invariants()` on every solver-touching
change — see the P2-T04 and P9-T02 `docs/MEMORY.md` entries.

Design:
    - `validate_invariants(schedule_input, schedule_output)` runs every check
      and returns *all* violations found in one pass (never raises on a
      violation, never stops at the first) — an empty tuple means every
      assertable invariant holds.
    - Each `InvariantViolation` names which invariant (`"I1"`..`"I17"`), a
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
        carries its anchored rows, ruling 2); data-error projects carry no rows
    I6  design load = Σ design-kind lead-time durations (each row's duration
        equals the lead-time table; elapsed/skipped contribute 0)
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
    I13 (health badge), I14 (run immutability) and I17 (capacity supply) are
    API/DB-side invariants with nothing to assert on a `ScheduleOutput`; they
    are the workflow-auditor's to check against the live API (P9-T06).

No DB access, no network access, no filesystem access, no randomness, no
wall-clock dependence. Every iteration is over an explicitly sorted sequence,
so the *order* of violations returned is itself deterministic.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

import domain_constants as dc
from scheduling.greedy import run_greedy_sgs
from scheduling.types import (
    LAB_CONSUMPTION_PER_PROJECT_WEEK,
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
    analyse_project,
    build_lead_time_table,
    build_workflows,
    compute_progress_pct,
    unconstrained_end_week,
)

# --- Violation record --------------------------------------------------------


@dataclass(frozen=True)
class InvariantViolation:
    """One concrete failure of one of Invariants I1-I17."""

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

    def plan(self, project_id: str) -> ProjectPlan | None:
        return self.plans.get(project_id)

    def is_fixed(self, project_id: str, step_id: str) -> bool:
        """A placement the scheduler may never move: any step of a frozen
        project, or an anchored (Done / In Progress / Blocked) step."""

        project = self.projects.get(project_id)
        if project is None:
            return False
        if project.frozen:
            return True
        plan = self.plans.get(project_id)
        if plan is None:
            return False
        sp = plan.steps.get(step_id)
        return bool(sp is not None and sp.anchored)

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
            sp is not None and sp.anchored and sp.status != STATUS_DONE and sp.remaining == 0
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
        if sp is not None and sp.status in (STATUS_IN_PROGRESS, STATUS_BLOCKED) and sp.remaining:
            # The row is shown from actual_start_week, but only the tail
            # `[end - remaining + 1 .. end]` is booked (DOMAIN_RULES progress).
            start = max(start, step.end_week - sp.remaining + 1)
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

    for project in sorted(schedule_input.projects, key=lambda p: p.project_id):
        if project.status not in dc.SCHEDULABLE_STATUS_ORDER:
            continue
        wf = workflows.get(project.workflow_id)
        if wf is None or project.category is None:
            continue
        if any((project.workflow_id, project.category, s.step_id) not in table for s in wf.steps):
            continue
        if project.frozen and project.actual_start_week is None:
            continue
        plans[project.project_id] = analyse_project(project, wf, table)

    return _Ctx(schedule_input, schedule_output, projects, outcomes, plans), violations


# --- Public entry point -------------------------------------------------------


def validate_invariants(
    schedule_input: ScheduleInput,
    schedule_output: ScheduleOutput,
    *,
    check_determinism: bool = True,
) -> tuple[InvariantViolation, ...]:
    """Run every assertable invariant check and return every violation found,
    in a fixed, deterministic order. `check_determinism=False` skips I8 (which
    re-runs `run_greedy_sgs` on `schedule_input` twice internally)."""

    ctx, violations = _build_ctx(schedule_input, schedule_output)
    violations.extend(_check_i1_engineer_conflicts(ctx))
    violations.extend(_check_i2_chamber_overlap(ctx))
    violations.extend(_check_i3_precedence(ctx, tag="I3"))
    violations.extend(_check_i4_lab_chamber_eligibility(ctx))
    violations.extend(_check_i5_complete_or_left_out(ctx))
    violations.extend(_check_i6_design_load(ctx))
    violations.extend(_check_i7_lab_load(ctx))
    if check_determinism:
        violations.extend(check_scheduler_determinism(schedule_input))
    violations.extend(_check_i9_within_year_derivation(ctx))
    violations.extend(_check_i10_frozen_dates_immutable(ctx))
    violations.extend(_check_i11_done_stages_immutable(ctx))
    violations.extend(_check_i12_progress_pct(ctx))
    violations.extend(_check_i15_dag(ctx))
    violations.extend(_check_i16_completion_lines(ctx))
    return tuple(violations)


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
                if pid_a == pid_b:
                    continue
                if not (start_a <= end_b and start_b <= end_a):
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
    frozen Done / In Progress) lab step that sits in an over-capacity chamber
    week is a violation if another eligible chamber (lab region + allowed
    stage) had room for every week it consumes. Usage only grows during a run,
    so room in the final output proves room at booking time; the check never
    raises a false positive."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        project = ctx.projects.get(outcome.project_id)
        if project is None or project.frozen or project.hub not in dc.HUB_LAB_REGION:
            continue
        region = dc.HUB_LAB_REGION[project.hub]
        for step in outcome.steps:
            chamber_id = step.assigned_chamber_id
            if step.kind != "lab" or chamber_id is None:
                continue
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
            for pred_id in sorted(template.predecessor_ids):
                pred = by_id.get(pred_id)
                if pred is None:
                    continue  # reported by I5
                if step.start_week < pred.end_week + 1:
                    violations.append(_precedence_violation(tag, pid, step, pred))
    return violations


def _precedence_violation(
    tag: str, pid: str, cur: StepSchedule, prev: StepSchedule
) -> InvariantViolation:
    return InvariantViolation(
        invariant=tag,
        description=(
            f"project {pid!r}: step {cur.step_id!r} (start_week={cur.start_week}) starts "
            f"before predecessor {prev.step_id!r} (end_week={prev.end_week}) has ended — "
            f"requires start >= {prev.end_week + 1}"
        ),
        project_id=pid,
        step_id=cur.step_id,
    )


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
        expected_region = dc.HUB_LAB_REGION.get(project.hub) if project else None
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


def _check_i5_complete_or_left_out(ctx: _Ctx) -> list[InvariantViolation]:
    """I5 (revised): every scheduled project has either a complete 14-step
    schedule — skipped steps present with `skipped=true`, zero duration,
    `start == end` and no resource — or `LEFT_OUT=true` (with an incomplete
    row set). A data-error project carries no rows."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        pid = outcome.project_id
        if outcome.excluded:
            continue
        plan = ctx.plan(pid)
        total = len(plan.workflow.steps) if plan else len(ctx.schedule_input.workflow_steps)
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
        if plan is None:
            continue
        ids = sorted(s.step_id for s in outcome.steps)
        if ids != sorted(plan.workflow.steps_by_id):
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
            sp = plan.steps[step.step_id]
            if step.skipped != sp.skipped:
                violations.append(
                    InvariantViolation(
                        invariant="I5",
                        description=(
                            f"project {pid!r} step {step.step_id!r}: skipped={step.skipped} but "
                            f"the lead-time table / certification flag says skipped={sp.skipped}"
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
    return violations


# --- I6 / I7: hub load aggregates ---------------------------------------------


def compute_design_load_by_hub(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> dict[str, int]:
    """I6: Σ `design`-kind step `duration_weeks` per project hub (elapsed and
    skipped steps contribute 0)."""

    projects = {p.project_id: p for p in schedule_input.projects}
    load: dict[str, int] = defaultdict(int)
    for outcome in schedule_output.project_outcomes:
        project = projects.get(outcome.project_id)
        if project is None or project.hub not in dc.HUB_LAB_REGION:
            continue
        for step in outcome.steps:
            if step.kind == "design" and not step.skipped:
                load[project.hub] += step.duration_weeks
    return dict(load)


def compute_lab_load_by_hub(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> dict[str, float]:
    """I7: Σ `lab`-kind step `duration_weeks` × 1.0 per project hub (ADR 0007).
    Aggregate per lab region with `domain_constants.HUB_LAB_REGION`."""

    projects = {p.project_id: p for p in schedule_input.projects}
    load: dict[str, float] = defaultdict(float)
    for outcome in schedule_output.project_outcomes:
        project = projects.get(outcome.project_id)
        if project is None or project.hub not in dc.HUB_LAB_REGION:
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
                            f"{step.duration_weeks} but the lead-time table gives {expected} — "
                            "the load aggregate would not reconcile with the Capacity surface"
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
        if outcome is None or project.hub not in dc.HUB_LAB_REGION:
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
        if outcome is None or project.hub not in dc.HUB_LAB_REGION:
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
    """I9: `within_year` / `spillover` re-derived from the outcome's own fields:
    excluded -> `status == Commercialized`; left_out / data_error / Blocked
    hold -> False; else `end_week + delay_weeks <= WITHIN_YEAR_WEEK`."""

    violations: list[InvariantViolation] = []
    for outcome in sorted(ctx.schedule_output.project_outcomes, key=lambda o: o.project_id):
        project = ctx.projects.get(outcome.project_id)
        if project is None:
            continue
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
            expected = outcome.end_week + project.delay_weeks <= ctx.schedule_input.within_year_week

        if outcome.within_year != expected:
            violations.append(
                InvariantViolation(
                    invariant="I9",
                    description=(
                        f"project {outcome.project_id!r}: within_year={outcome.within_year!r} but "
                        f"re-derived from left_out/end_week/delay_weeks/status the expected value "
                        f"is {expected!r}"
                    ),
                    project_id=outcome.project_id,
                )
            )
            continue
        if not outcome.excluded:
            expected_spill = ctx.is_scheduled(outcome) and not outcome.within_year
            if outcome.spillover != expected_spill:
                violations.append(
                    InvariantViolation(
                        invariant="I9",
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
