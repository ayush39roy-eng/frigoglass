"""Reusable invariant validator — Invariants I1-I10, per `docs/DOMAIN_RULES.md`'s
"Invariants" section.

This is **the permanent correctness contract** for `backend/scheduling/`, not the
`tests/oracle/` differential-oracle comparison (P2-T02/T03), which is temporary
scaffolding deleted at P2-T05. `workflow-auditor` is expected to call
`validate_invariants()` on every subsequent solver-touching change for the rest
of the project's life — see the P2-T04 `docs/MEMORY.md` entry for the full
design rationale and both directions of verification performed when this module
was built.

Design:
    - `validate_invariants(schedule_input, schedule_output) -> tuple[InvariantViolation, ...]`
      runs every check and returns *all* violations found in one pass (never
      raises, never stops at the first failure) — empty tuple means all ten
      invariants hold. A validator that stops at the first violation would be
      far less useful to a caller trying to produce a full findings report.
    - Each `InvariantViolation` names which invariant (`"I1"`..`"I10"`), a
      human-readable description, and whichever of
      project_id/step_id/engineer_id/chamber_id/hub/week is relevant to locate
      the problem (irrelevant fields are left `None`, never fabricated).
    - `check_scheduler_determinism(schedule_input)` is I8's check, exposed as
      its own reusable, general-purpose public function (not folded silently
      into `validate_invariants`'s internals only) — it operates on any
      `ScheduleInput`, independent of any specific `ScheduleOutput`, per this
      task's explicit instruction that it be "a reusable, general-purpose
      version any caller can invoke on any ScheduleInput, not just P2-T01's own
      hardcoded scenarios." `validate_invariants` calls it internally by
      default (`check_determinism=True`) so a single call covers all ten
      invariants, but callers who already know determinism holds (e.g. a tight
      loop validating many hand-crafted `ScheduleOutput`s against a single
      `ScheduleInput`, as this module's own self-test does for I1-I7/I9/I10)
      can pass `check_determinism=False` to skip the extra `run_greedy_sgs`
      calls.
    - `compute_design_load_by_hub` / `compute_lab_load_by_hub` are exposed as
      their own reusable public functions (not just inlined into the I6/I7
      checks) since a future Capacity-surface reporting layer (P3/P4, not yet
      built) is very likely to want exactly these aggregates rather than
      reimplementing them a second time with the drift risk that implies.

I6/I7 scope note (see also the module-level docstrings on `_check_i6`/`_check_i7`
below and the P2-T04 MEMORY.md entry): DOMAIN_RULES.md's I6/I7 text says these
totals "must reconcile with the Capacity surface." No Capacity API/surface
exists yet (P3/P4 haven't started). This module validates everything that CAN be
validated at the pure-function level today — that each hub's total design/lab
load is computable from `ScheduleOutput` alone, without error, and that two
independently-sourced recomputations of it agree (an internal-consistency
check) — and explicitly does NOT claim to validate reconciliation against a
live Capacity surface, since none exists. That half of I6/I7 is N/A-for-now, not
silently skipped: it is impossible to check today and will need revisiting once
P3/P4 build that surface.

No DB access, no network access, no filesystem access, no randomness, no
wall-clock dependence — same purity contract as the rest of `backend/scheduling/`
(P2-T01). Every collection this module iterates is explicitly sorted before
iteration, never relying on dict/set iteration order, so this module's own
output (the *order* of violations in the returned tuple) is itself deterministic.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

import domain_constants as dc
from scheduling.greedy import run_greedy_sgs
from scheduling.types import ScheduleInput, ScheduleOutput

# --- Violation record --------------------------------------------------------


@dataclass(frozen=True)
class InvariantViolation:
    """One concrete failure of one of Invariants I1-I10.

    `invariant` is always one of the literal strings `"I1"`..`"I10"`.
    `description` is a human-readable, one-line explanation of exactly what was
    found wrong, self-contained enough to act on without re-reading this
    module's source. The remaining fields are optional context to help locate
    the problem in the data (only the fields relevant to the specific
    invariant/violation are populated; the rest are left `None`, never
    fabricated placeholder values).
    """

    invariant: str
    description: str
    project_id: str | None = None
    step_id: str | None = None
    engineer_id: str | None = None
    chamber_id: str | None = None
    hub: str | None = None
    week: int | None = None


# --- Public entry point -------------------------------------------------------


def validate_invariants(
    schedule_input: ScheduleInput,
    schedule_output: ScheduleOutput,
    *,
    check_determinism: bool = True,
) -> tuple[InvariantViolation, ...]:
    """Run all ten invariant checks (I1-I10) and return every violation found.

    Never raises on a violation and never stops at the first one — returns a
    tuple of every `InvariantViolation` found across all ten checks, in a
    fixed, deterministic order (I1 through I10, and within each check, sorted
    by whatever id most naturally orders that check's findings). An empty
    tuple means all ten invariants hold for this `(schedule_input,
    schedule_output)` pair.

    `check_determinism=False` skips I8 (which re-runs `run_greedy_sgs` on
    `schedule_input` twice internally) — useful when a caller already knows
    determinism holds for this input (e.g. because it was checked once
    already) and wants to validate many different hand-crafted
    `schedule_output`s against the same `schedule_input` without repeating an
    expensive re-run each time. Defaults to `True` so a single call validates
    the full permanent correctness contract.
    """

    violations: list[InvariantViolation] = []
    violations.extend(_check_i1_engineer_conflicts(schedule_input, schedule_output))
    violations.extend(_check_i2_chamber_overlap(schedule_input, schedule_output))
    violations.extend(_check_i3_sequential_steps(schedule_output))
    violations.extend(_check_i4_lab_chamber_eligibility(schedule_input, schedule_output))
    violations.extend(_check_i5_complete_or_left_out(schedule_input, schedule_output))
    violations.extend(_check_i6_design_load_computable(schedule_input, schedule_output))
    violations.extend(_check_i7_lab_load_computable(schedule_input, schedule_output))
    if check_determinism:
        violations.extend(check_scheduler_determinism(schedule_input))
    violations.extend(_check_i9_within_year_derivation(schedule_input, schedule_output))
    violations.extend(_check_i10_frozen_dates_immutable(schedule_input, schedule_output))
    return tuple(violations)


# --- Small shared helpers -----------------------------------------------------


def _outcomes_by_id(schedule_output: ScheduleOutput):
    return {o.project_id: o for o in schedule_output.project_outcomes}


def _projects_by_id(schedule_input: ScheduleInput):
    return {p.project_id: p for p in schedule_input.projects}


# --- I1: engineer double-booking -------------------------------------------


def _check_i1_engineer_conflicts(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> list[InvariantViolation]:
    """I1: No engineer is assigned two design steps in the same week — unless
    at least one of the two projects is `frozen`, in which case `ENG_CONFLICT`
    must be raised (on at least one of the two projects involved).

    Gathers every booked design-step (engineer_id, project_id, week-range)
    triple from `schedule_output`, and for every pair of *different* projects
    sharing the same engineer with an overlapping week range:
      - if neither project is frozen: this should never happen (a non-frozen
        project always searches forward for a free window) -> violation.
      - if at least one is frozen: the invariant requires `ENG_CONFLICT` to
        have been raised on at least one of the two projects -> violation if
        neither project's outcome has `eng_conflict=True`.
    """

    violations: list[InvariantViolation] = []
    projects = _projects_by_id(schedule_input)
    outcomes = _outcomes_by_id(schedule_output)

    bookings: dict[str, list[tuple[str, int, int]]] = defaultdict(list)
    for outcome in sorted(schedule_output.project_outcomes, key=lambda o: o.project_id):
        for step in outcome.steps:
            if step.kind == "design" and step.assigned_engineer_id is not None:
                bookings[step.assigned_engineer_id].append(
                    (outcome.project_id, step.start_week, step.end_week)
                )

    for engineer_id in sorted(bookings):
        entries = sorted(bookings[engineer_id])
        for i in range(len(entries)):
            pid_a, start_a, end_a = entries[i]
            for j in range(i + 1, len(entries)):
                pid_b, start_b, end_b = entries[j]
                if pid_a == pid_b:
                    continue
                overlaps = start_a <= end_b and start_b <= end_a
                if not overlaps:
                    continue

                project_a = projects.get(pid_a)
                project_b = projects.get(pid_b)
                a_frozen = bool(project_a and project_a.frozen)
                b_frozen = bool(project_b and project_b.frozen)

                if not a_frozen and not b_frozen:
                    violations.append(
                        InvariantViolation(
                            invariant="I1",
                            description=(
                                f"engineer {engineer_id!r} double-booked between non-frozen "
                                f"projects {pid_a!r} and {pid_b!r} (overlapping weeks "
                                f"[{start_a},{end_a}] and [{start_b},{end_b}]) — neither project "
                                "is frozen, so this should never happen"
                            ),
                            project_id=pid_a,
                            engineer_id=engineer_id,
                        )
                    )
                    continue

                a_flag = bool(outcomes.get(pid_a) and outcomes[pid_a].eng_conflict)
                b_flag = bool(outcomes.get(pid_b) and outcomes[pid_b].eng_conflict)
                if not (a_flag or b_flag):
                    violations.append(
                        InvariantViolation(
                            invariant="I1",
                            description=(
                                f"engineer {engineer_id!r} double-booked between projects "
                                f"{pid_a!r} and {pid_b!r} (overlapping weeks [{start_a},{end_a}] "
                                f"and [{start_b},{end_b}]), at least one frozen, but neither "
                                "project's outcome has eng_conflict=True"
                            ),
                            project_id=pid_a,
                            engineer_id=engineer_id,
                        )
                    )
    return violations


# --- I2: chamber over-capacity ------------------------------------------------


def _check_i2_chamber_overlap(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> list[InvariantViolation]:
    """I2: No chamber exceeds `max` concurrent projects in any week — unless
    frozen, then `OVERLAP` must be raised.

    Same shape as I1's check, but per (chamber, week) rather than per
    (engineer, pairwise-overlap): counts distinct projects booked into each
    chamber in each week; if that count exceeds `chamber.max_concurrent`,
    requires that at least one contributing project is frozen, and that at
    least one contributing frozen project's outcome has `overlap=True`.
    """

    violations: list[InvariantViolation] = []
    projects = _projects_by_id(schedule_input)
    outcomes = _outcomes_by_id(schedule_output)
    max_concurrent_by_chamber = {c.chamber_id: c.max_concurrent for c in schedule_input.chambers}

    usage: dict[str, dict[int, list[str]]] = defaultdict(lambda: defaultdict(list))
    for outcome in sorted(schedule_output.project_outcomes, key=lambda o: o.project_id):
        for step in outcome.steps:
            if step.kind == "lab" and step.assigned_chamber_id is not None:
                for wk in range(step.start_week, step.end_week + 1):
                    usage[step.assigned_chamber_id][wk].append(outcome.project_id)

    for chamber_id in sorted(usage):
        max_concurrent = max_concurrent_by_chamber.get(chamber_id)
        if max_concurrent is None:
            # Booked to a chamber that isn't even in ScheduleInput.chambers —
            # a distinct problem, already caught (and reported) by I4.
            continue
        for wk in sorted(usage[chamber_id]):
            project_ids = usage[chamber_id][wk]
            if len(project_ids) <= max_concurrent:
                continue

            frozen_ids = sorted(
                pid for pid in project_ids if projects.get(pid) and projects[pid].frozen
            )
            if not frozen_ids:
                violations.append(
                    InvariantViolation(
                        invariant="I2",
                        description=(
                            f"chamber {chamber_id!r} exceeds max_concurrent={max_concurrent} in "
                            f"week {wk} ({len(project_ids)} projects: {sorted(project_ids)}) but "
                            "none of the contributing projects is frozen — this should never "
                            "happen for non-frozen bookings"
                        ),
                        chamber_id=chamber_id,
                        week=wk,
                    )
                )
                continue

            if not any(outcomes.get(pid) and outcomes[pid].overlap for pid in frozen_ids):
                violations.append(
                    InvariantViolation(
                        invariant="I2",
                        description=(
                            f"chamber {chamber_id!r} exceeds max_concurrent={max_concurrent} in "
                            f"week {wk} ({len(project_ids)} projects: {sorted(project_ids)}), "
                            f"frozen projects involved ({frozen_ids}), but none of their "
                            "outcomes has overlap=True"
                        ),
                        chamber_id=chamber_id,
                        week=wk,
                    )
                )
    return violations


# --- I3: sequential, non-overlapping steps within a project -------------------


def _check_i3_sequential_steps(schedule_output: ScheduleOutput) -> list[InvariantViolation]:
    """I3: Steps within a project are strictly sequential and non-overlapping:
    `step[n].start >= step[n-1].end + 1`.
    """

    violations: list[InvariantViolation] = []
    for outcome in sorted(schedule_output.project_outcomes, key=lambda o: o.project_id):
        steps_sorted = sorted(outcome.steps, key=lambda s: s.sequence_order)
        for step in steps_sorted:
            if step.start_week > step.end_week:
                violations.append(
                    InvariantViolation(
                        invariant="I3",
                        description=(
                            f"project {outcome.project_id!r} step {step.step_id!r} has "
                            f"start_week={step.start_week} > end_week={step.end_week} "
                            "(degenerate/invalid step)"
                        ),
                        project_id=outcome.project_id,
                        step_id=step.step_id,
                    )
                )
        # Deliberately NOT strict=True: steps_sorted[1:] is one element shorter
        # than steps_sorted by construction (this pairs consecutive steps), not
        # an accidental length mismatch.
        for prev, cur in zip(steps_sorted, steps_sorted[1:]):  # noqa: B905
            if cur.start_week < prev.end_week + 1:
                violations.append(
                    InvariantViolation(
                        invariant="I3",
                        description=(
                            f"project {outcome.project_id!r}: step {cur.step_id!r} "
                            f"(start_week={cur.start_week}) starts before step {prev.step_id!r} "
                            f"(end_week={prev.end_week}) has ended — requires "
                            f"start >= {prev.end_week + 1}"
                        ),
                        project_id=outcome.project_id,
                        step_id=cur.step_id,
                    )
                )
    return violations


# --- I4: lab step / chamber eligibility ----------------------------------------


def _check_i4_lab_chamber_eligibility(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> list[InvariantViolation]:
    """I4: A lab step is only ever booked to a chamber in the project's lab
    region whose `allowed_stages` contains that step.
    """

    violations: list[InvariantViolation] = []
    projects = _projects_by_id(schedule_input)
    chambers = {c.chamber_id: c for c in schedule_input.chambers}

    for outcome in sorted(schedule_output.project_outcomes, key=lambda o: o.project_id):
        project = projects.get(outcome.project_id)
        expected_region = dc.HUB_LAB_REGION.get(project.hub) if project else None

        for step in outcome.steps:
            if step.kind != "lab":
                continue
            if step.assigned_chamber_id is None:
                violations.append(
                    InvariantViolation(
                        invariant="I4",
                        description=(
                            f"project {outcome.project_id!r} lab step {step.step_id!r} is "
                            "booked (has start/end weeks) but has no assigned_chamber_id"
                        ),
                        project_id=outcome.project_id,
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
                            f"project {outcome.project_id!r} lab step {step.step_id!r} is "
                            f"booked to chamber_id {step.assigned_chamber_id!r}, which is not "
                            "present in ScheduleInput.chambers at all"
                        ),
                        project_id=outcome.project_id,
                        step_id=step.step_id,
                        chamber_id=step.assigned_chamber_id,
                    )
                )
                continue

            if project is None:
                continue  # can't check region/hub for a project not in the input at all

            if expected_region is not None and chamber.lab_region != expected_region:
                violations.append(
                    InvariantViolation(
                        invariant="I4",
                        description=(
                            f"project {outcome.project_id!r} (hub {project.hub!r}, lab region "
                            f"{expected_region!r}) lab step {step.step_id!r} is booked to "
                            f"chamber {chamber.chamber_id!r} in lab region "
                            f"{chamber.lab_region!r} — region mismatch"
                        ),
                        project_id=outcome.project_id,
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
                            f"project {outcome.project_id!r} lab step {step.step_id!r} is "
                            f"booked to chamber {chamber.chamber_id!r}, whose allowed_stages "
                            f"{chamber.allowed_stages} does not include {step.step_id!r}"
                        ),
                        project_id=outcome.project_id,
                        step_id=step.step_id,
                        chamber_id=chamber.chamber_id,
                    )
                )
    return violations


# --- I5: complete schedule or LEFT_OUT --------------------------------------


def _check_i5_complete_or_left_out(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> list[InvariantViolation]:
    """I5: Every scheduled project has either a complete N-step schedule
    (N = `len(schedule_input.workflow_steps)`, 14 for the canonical template)
    or `LEFT_OUT = true`.

    "Every scheduled project" is read as "every project that was fed into the
    greedy walk at all" — i.e. every non-`excluded` outcome (an `excluded`
    project, per DOMAIN_RULES.md, was never scheduled in the first place, so
    I5 does not apply to it). Also asserts the converse direction implied by
    the "OR": a `left_out=True` outcome must NOT also report a complete
    schedule (that combination would make the "OR" meaningless) — `left_out`
    is only ever set by the greedy walk when a step failed to book, so a
    complete step count under `left_out=True` would itself be inconsistent
    output.
    """

    violations: list[InvariantViolation] = []
    total_steps = len(schedule_input.workflow_steps)

    for outcome in sorted(schedule_output.project_outcomes, key=lambda o: o.project_id):
        if outcome.excluded:
            continue
        if outcome.left_out:
            if len(outcome.steps) >= total_steps:
                violations.append(
                    InvariantViolation(
                        invariant="I5",
                        description=(
                            f"project {outcome.project_id!r} has left_out=True but also a "
                            f"complete step count ({len(outcome.steps)}/{total_steps}) — "
                            "left_out should mean an incomplete schedule"
                        ),
                        project_id=outcome.project_id,
                    )
                )
            continue
        if len(outcome.steps) != total_steps:
            violations.append(
                InvariantViolation(
                    invariant="I5",
                    description=(
                        f"project {outcome.project_id!r} is not left_out and not excluded, but "
                        f"has {len(outcome.steps)}/{total_steps} steps scheduled (expected a "
                        "complete schedule)"
                    ),
                    project_id=outcome.project_id,
                )
            )
    return violations


# --- I6 / I7: hub load aggregates ---------------------------------------------


def compute_design_load_by_hub(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> dict[str, int]:
    """I6: total design-step load (Σ duration_weeks) per hub, recomputed
    directly from `ScheduleOutput.steps` (raw per-step data), independent of
    any aggregate `ScheduleOutput` itself might carry (it doesn't carry one —
    see the P2-T01 MEMORY.md entry's "recompute independently" design intent).

    Attributes each design step's duration to the *project's* hub (not the
    assigned engineer's hub — DOMAIN_RULES.md's I6 says "that hub's projects",
    not "that hub's engineers"; an engineer may in principle lead a project
    based at a different hub, and this function is deliberately consistent
    with the invariant's literal wording either way).
    """

    projects = _projects_by_id(schedule_input)
    load: dict[str, int] = defaultdict(int)
    for outcome in schedule_output.project_outcomes:
        project = projects.get(outcome.project_id)
        if project is None or project.hub not in dc.HUB_LAB_REGION:
            continue
        for step in outcome.steps:
            if step.kind == "design":
                load[project.hub] += step.duration_weeks
    return dict(load)


def compute_lab_load_by_hub(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> dict[str, float]:
    """I7: total lab-step load per hub = Σ (lab step duration_weeks × 0.5),
    attributed to the project's hub, same reasoning as
    `compute_design_load_by_hub`.
    """

    projects = _projects_by_id(schedule_input)
    load: dict[str, float] = defaultdict(float)
    for outcome in schedule_output.project_outcomes:
        project = projects.get(outcome.project_id)
        if project is None or project.hub not in dc.HUB_LAB_REGION:
            continue
        for step in outcome.steps:
            if step.kind == "lab":
                load[project.hub] += step.duration_weeks * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK
    return dict(load)


def _check_i6_design_load_computable(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> list[InvariantViolation]:
    """I6, the part checkable today (see this module's docstring's "I6/I7
    scope note" and the P2-T04 MEMORY.md entry): confirm the per-hub design
    load total is computable (no negative/malformed durations) and internally
    consistent (summing the per-hub breakdown equals an independently-summed
    grand total, computed via a second, differently-sourced loop). Does NOT
    (cannot yet) check reconciliation against a live Capacity surface — no
    such surface exists yet (P3/P4 not started).
    """

    violations: list[InvariantViolation] = []

    for outcome in sorted(schedule_output.project_outcomes, key=lambda o: o.project_id):
        for step in outcome.steps:
            if step.kind == "design" and step.duration_weeks < 0:
                violations.append(
                    InvariantViolation(
                        invariant="I6",
                        description=(
                            f"project {outcome.project_id!r} design step {step.step_id!r} has "
                            f"negative duration_weeks={step.duration_weeks}, making the design "
                            "load aggregate uncomputable/meaningless"
                        ),
                        project_id=outcome.project_id,
                        step_id=step.step_id,
                    )
                )

    per_hub = compute_design_load_by_hub(schedule_input, schedule_output)

    grand_total_independent = 0
    for project in sorted(schedule_input.projects, key=lambda p: p.project_id):
        outcome = _outcomes_by_id(schedule_output).get(project.project_id)
        if outcome is None or project.hub not in dc.HUB_LAB_REGION:
            continue
        grand_total_independent += sum(
            step.duration_weeks for step in outcome.steps if step.kind == "design"
        )

    if sum(per_hub.values()) != grand_total_independent:
        violations.append(
            InvariantViolation(
                invariant="I6",
                description=(
                    f"design load per-hub breakdown sums to {sum(per_hub.values())}, but an "
                    f"independently-computed grand total is {grand_total_independent} — "
                    "per-hub aggregation is internally inconsistent"
                ),
            )
        )
    return violations


def _check_i7_lab_load_computable(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> list[InvariantViolation]:
    """I7, same shape and same scope caveat as `_check_i6_design_load_computable`."""

    violations: list[InvariantViolation] = []

    for outcome in sorted(schedule_output.project_outcomes, key=lambda o: o.project_id):
        for step in outcome.steps:
            if step.kind == "lab" and step.duration_weeks < 0:
                violations.append(
                    InvariantViolation(
                        invariant="I7",
                        description=(
                            f"project {outcome.project_id!r} lab step {step.step_id!r} has "
                            f"negative duration_weeks={step.duration_weeks}, making the lab "
                            "load aggregate uncomputable/meaningless"
                        ),
                        project_id=outcome.project_id,
                        step_id=step.step_id,
                    )
                )

    per_hub = compute_lab_load_by_hub(schedule_input, schedule_output)

    grand_total_independent = 0.0
    for project in sorted(schedule_input.projects, key=lambda p: p.project_id):
        outcome = _outcomes_by_id(schedule_output).get(project.project_id)
        if outcome is None or project.hub not in dc.HUB_LAB_REGION:
            continue
        grand_total_independent += sum(
            step.duration_weeks * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK
            for step in outcome.steps
            if step.kind == "lab"
        )

    if sum(per_hub.values()) != grand_total_independent:
        violations.append(
            InvariantViolation(
                invariant="I7",
                description=(
                    f"lab load per-hub breakdown sums to {sum(per_hub.values())}, but an "
                    f"independently-computed grand total is {grand_total_independent} — "
                    "per-hub aggregation is internally inconsistent"
                ),
            )
        )
    return violations


# --- I8: determinism ----------------------------------------------------------


def check_scheduler_determinism(
    schedule_input: ScheduleInput, *, runs: int = 2
) -> tuple[InvariantViolation, ...]:
    """I8: Re-running the greedy scheduler on identical input produces
    byte-identical output.

    Reusable, general-purpose — takes only a `ScheduleInput` (no
    `ScheduleOutput` needed) so it can be called independently on any input, in
    isolation, unlike the other nine checks. Runs `run_greedy_sgs(schedule_input)`
    `runs` times (default 2) and asserts every run is both structurally equal
    (`==`) and byte-identical via `repr()` to the first run.

    P2-T01's own `_selftest.py::scenario_determinism` already checks this in
    isolation for its own hardcoded scenarios; this function is the same check
    made available to any caller (`validate_invariants`, `workflow-auditor`,
    P2-T05's golden-file harness, etc.) for any `ScheduleInput`.
    """

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
                        "different ScheduleOutput than run 1 (== comparison failed) — "
                        "determinism violated"
                    ),
                )
            )
        elif repr(out) != repr(first):
            # Structurally equal but not byte-identical would still be a real
            # I8 concern (e.g. float formatting or ordering differences that
            # dataclass `==` doesn't surface) — checked separately, per
            # P2-T01's own precedent in `_selftest.py`.
            violations.append(
                InvariantViolation(
                    invariant="I8",
                    description=(
                        f"run {i} of {runs} on identical ScheduleInput is structurally equal "
                        "(==) to run 1 but not byte-identical via repr() — determinism violated"
                    ),
                )
            )
    return tuple(violations)


# --- I9: within_year re-derivation --------------------------------------------


def _check_i9_within_year_derivation(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> list[InvariantViolation]:
    """I9: `within_year` on any outcome must actually be derived from that
    same project's other output fields (`left_out`/`end_week`) and input
    field (`delay_weeks`) via DOMAIN_RULES.md's completing-within-year
    formula — never an arbitrary/inconsistent value.

    At the pure-function level (no DB, no Dashboard yet) this is the
    strongest available check of "no independent calculation anywhere": for
    every outcome, independently re-derive what `within_year` should be from
    first principles, and assert it matches what the outcome actually
    reports. Also checks `spillover`'s consistency with the same re-derivation
    (`spillover == not left_out and not excluded and not within_year`) since
    it's a direct, closely-related corollary of the same formula and DOMAIN_
    RULES.md defines SPILLOVER as the `within_year` formula's negation.

    Formula (DOMAIN_RULES.md "Booking rules"):
      `!left_out AND (last_step_end + delay <= WITHIN_YEAR_WEEK)`
    Excluded-project resolution (DOMAIN_RULES.md is silent; resolved via the
    prototype per the P2-T01 MEMORY.md entry, and re-applied here verbatim
    since this validator must check what was actually decided, not invent a
    stricter reading of its own): `within_year = (status == "Commercialized")`.
    """

    violations: list[InvariantViolation] = []
    projects = _projects_by_id(schedule_input)

    for outcome in sorted(schedule_output.project_outcomes, key=lambda o: o.project_id):
        project = projects.get(outcome.project_id)
        if project is None:
            continue

        if outcome.excluded:
            expected_within_year = project.status == "Commercialized"
        elif outcome.left_out:
            expected_within_year = False
        else:
            if outcome.end_week is None:
                violations.append(
                    InvariantViolation(
                        invariant="I9",
                        description=(
                            f"project {outcome.project_id!r} is neither excluded nor left_out, "
                            "but end_week is None — within_year cannot be re-derived"
                        ),
                        project_id=outcome.project_id,
                    )
                )
                continue
            completion_week = outcome.end_week + project.delay_weeks
            expected_within_year = completion_week <= schedule_input.within_year_week

        if outcome.within_year != expected_within_year:
            violations.append(
                InvariantViolation(
                    invariant="I9",
                    description=(
                        f"project {outcome.project_id!r}: within_year={outcome.within_year!r} "
                        f"but re-derived from left_out/end_week/delay_weeks/status the expected "
                        f"value is {expected_within_year!r}"
                    ),
                    project_id=outcome.project_id,
                )
            )
            continue  # spillover check below assumes within_year is trustworthy

        if not outcome.excluded:
            expected_spillover = not outcome.left_out and not outcome.within_year
            if outcome.spillover != expected_spillover:
                violations.append(
                    InvariantViolation(
                        invariant="I9",
                        description=(
                            f"project {outcome.project_id!r}: spillover={outcome.spillover!r} "
                            f"but re-derived (not left_out and not within_year) expected "
                            f"{expected_spillover!r}"
                        ),
                        project_id=outcome.project_id,
                    )
                )
    return violations


# --- I10: frozen dates are never mutated --------------------------------------


def _check_i10_frozen_dates_immutable(
    schedule_input: ScheduleInput, schedule_output: ScheduleOutput
) -> list[InvariantViolation]:
    """I10: Applying priorities never mutates a frozen project's dates.

    No "apply priorities" action exists yet at the pure-function level (P5) —
    per this task's scoping, the checkable equivalent today is: for any input
    project with `frozen=True`, its first step's `start_week` in the output
    must always equal `ProjectInput.actual_start_week`, regardless of any
    conflicts or anything else happening in the schedule around it. This is
    what "dates never move" reduces to at this layer — if this holds
    unconditionally (independent of contention, sort order, or any other
    project's presence), then no later mutation-inducing operation (like a
    future "apply priorities" step built on top of this scheduler) can have
    silently shifted a frozen project's dates within *this* function either.
    """

    violations: list[InvariantViolation] = []
    outcomes = _outcomes_by_id(schedule_output)

    for project in sorted(schedule_input.projects, key=lambda p: p.project_id):
        if not project.frozen:
            continue
        outcome = outcomes.get(project.project_id)
        if outcome is None or not outcome.steps:
            # No steps booked at all (e.g. no_leader) — nothing to check a
            # date against; not itself an I10 violation.
            continue
        first_step = min(outcome.steps, key=lambda s: s.sequence_order)
        if first_step.start_week != project.actual_start_week:
            violations.append(
                InvariantViolation(
                    invariant="I10",
                    description=(
                        f"frozen project {project.project_id!r}: first step "
                        f"({first_step.step_id!r}) start_week={first_step.start_week} does not "
                        f"equal actual_start_week={project.actual_start_week} — a frozen "
                        "project's dates must never move"
                    ),
                    project_id=project.project_id,
                    step_id=first_step.step_id,
                )
            )
    return violations
