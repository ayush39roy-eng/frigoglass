"""Demand load (I25) and effort split (I26) checks over *live* project rows
(ADR 0041, "Invariant wording"). Pure: the backend (or the workflow-auditor)
reads `projects` / `project_workflow_steps` / the lead-time table and hands
the rows over as `LiveProjectRow`s; nothing here touches a database or a
schedule run.

Both invariants read `eff(p, s)` exactly as the scheduler does
(`workflow.step_effective_weeks` over `workflow.merged_step_override`):

    eff = 0                                  lead = 0, or lab ∧ ¬cert
    eff = user_override ?? effort_weeks ?? lead   otherwise

- **I25 — demand load**, never from a run.
  - Full-year design demand(h) = Σ eff over design-kind steps of every
    project whose capacity hub is h (own + members, ADR 0042) with status ∉
    {Cancelled, Draft}.
  - Remaining design demand(h) = Σ rem over the same steps, for projects in a
    schedulable status (In Buyoff, Under Industrialization, In Development,
    In Queue) with priority ∉ {P4, Q} or frozen (ADR 0056 R42-6: a
    non-frozen P4/Q project is never scheduled; a queued P3 is). `rem` is
    0 when eff = 0 or the stage is Done;
    `derive_remaining(eff, percent_complete, remaining_weeks_override)` for
    In Progress / Blocked; eff for Not Started. Effort, never a span; not
    windowed to W52; stored progress counts for every project, frozen
    included.
  - Lab: the same per lab region (of the project's hub), lab-kind steps,
    × 1.0 platform-week per project-week.
  - The served `design_load_weeks` / `design_load_remaining_weeks` equal the
    design figures to the week; `lab_load_weeks` / `lab_load_remaining_weeks`
    the lab figures to 2 dp.
- **I26 — effort split** (rev. 2, P35-T03 / R35-3). For every non-frozen
  project, the stored `effort_weeks` of its steps equal
  `effort_split.derive_project_effort` of its figures over the current lead
  times and the step exclusions (S′ = weighted, non-excluded steps), with
  R3's `max(1, ·)` on started steps of S′; excluded steps carry none; and a
  figure in force (`inForce(p, k)`) has a non-empty S′. Lab steps are not
  checked when certification testing is off (they are skipped whatever they
  carry, R7). A figure whose split would exceed 104
  weeks on a step must never have been stored (R7). Frozen projects are
  exempt (R6: re-derivation is a no-op on them, I10).
- **Step exclusion** (ADR 0049 as ruled, R35-1): `eff(p, s) = 0` for an
  excluded live step, before every other branch; the one predicate then
  calls it skipped. The live-row halves of I33 (`check_i33_step_exclusion`:
  an excluded step reaches the run input as `lead_weeks = 0` (None when the
  table is already 0) with no override, and every run row for it is skipped
  with duration 0) and I34 (i) (`check_i34_excluded_not_done`: no step is
  both excluded and Done) are here. The rest of I34 (progress byte-equal
  across exclude / re-include) and of I36 (audit rows, frozen guard over
  time) need DB history and are the backend's.

Violations reuse `invariants.InvariantViolation` (`invariant="I25"` /
`"I26"` / `"I33"` / `"I34"`); every result is in a deterministic order.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction

import domain_constants as dc
from scheduling import hubs
from scheduling.effort_split import (
    NOT_APPLIED_ALL_EXCLUDED,
    EffortFigure,
    EffortSplitRejected,
    EffortStepInput,
    derive_project_effort,
)
from scheduling.invariants import InvariantViolation
from scheduling.types import (
    LAB_CONSUMPTION_PER_PROJECT_WEEK,
    PROGRESS_STATUSES,
    ScheduleInput,
    ScheduleOutput,
)
from scheduling.workflow import (
    STATUS_BLOCKED,
    STATUS_DONE,
    STATUS_IN_PROGRESS,
    STATUS_NOT_STARTED,
    booked_hold_weeks,
    derive_remaining,
    is_partial_room,
    merged_step_override,
    step_effective_weeks,
)

#: I25 full-year scope: every status except these (ADR 0041 R8).
FULL_YEAR_EXCLUDED_STATUSES: frozenset[str] = frozenset({"Cancelled", "Draft"})


# --- Inputs -----------------------------------------------------------------------


@dataclass(frozen=True)
class LiveStepRow:
    """One `project_workflow_steps` row joined with its template and the
    lead-time table in force.

    - `kind`: the template's kind (`design` / `lab` / `elapsed`).
    - `lead_weeks`: `lead_time[workflow][category][step]` (the table, never
      the override).
    - `user_override_weeks`: `duration_override_weeks` (the user's figure,
      1..104 or None, R4).
    - `effort_weeks`: the derived effort column (0..104 or None, R4).
    - `status` / `percent_complete` / `remaining_weeks_override`: the stored
      stage progress (`status` one of Not Started / In Progress / Blocked /
      Done).
    - `excluded`: the per-project step exclusion (`project_workflow_steps.
      excluded`, ADR 0049 / R35-1): `eff = 0` before every other branch.
    """

    step_id: str
    sequence_order: int
    kind: str
    lead_weeks: int
    user_override_weeks: int | None
    effort_weeks: int | None
    status: str = STATUS_NOT_STARTED
    percent_complete: int = 0
    remaining_weeks_override: int | None = None
    excluded: bool = False
    # ADR 0071: `project_workflow_steps.plan_lab_hold_weeks` (None = full).
    # On a lab step a value makes it `partialRoom`: `eff = user_override ??
    # lead` (no effort share, R62-1), not skipped by certification off
    # (R62-2), and its lab demand is `min(hold, eff)` / `min(hold, rem)`
    # (I25 lab half, I66). The default keeps every pre-P62 caller unchanged.
    lab_hold_weeks: int | None = None


@dataclass(frozen=True)
class LiveProjectRow:
    """One `projects` row with its 14 step rows.

    - `capacity_hub`: `hubs.capacity_hub_id` resolved to a name (the hub
      itself when null, ADR 0042).
    - `status`: the project status (stored value).
    - `design_effort_weeks` / `lab_effort_weeks`: the stored `Numeric(6, 2)`
      figures (None when blank).
    """

    project_id: str
    hub: str
    capacity_hub: str
    status: str
    frozen: bool
    certification_testing_required: bool
    design_effort_weeks: EffortFigure | None
    lab_effort_weeks: EffortFigure | None
    steps: tuple[LiveStepRow, ...]
    # ADR 0056 R42-6 (I25 remaining): the project's priority band. A
    # non-frozen P4/Q project is never scheduled, so it leaves remaining
    # demand. The default `None` keeps every pre-P42 caller unchanged; the
    # backend builder must pass the stored `projects.priority`.
    priority: str | None = None


@dataclass(frozen=True)
class ServedDesignLoad:
    """The served design demand fields of one capacity-hub row."""

    capacity_hub: str
    design_load_weeks: Decimal | float | int
    design_load_remaining_weeks: Decimal | float | int


@dataclass(frozen=True)
class ServedLabLoad:
    """The served lab demand fields of one lab region (each region once)."""

    lab_region: str
    lab_load_weeks: Decimal | float | int
    lab_load_remaining_weeks: Decimal | float | int


@dataclass(frozen=True)
class DemandLoad:
    """I25 figures. Keys are sorted; a capacity hub / region appears when at
    least one in-scope project maps to it (its figure may be 0)."""

    design_full_year: Mapping[str, int]  # capacity hub -> weeks
    design_remaining: Mapping[str, int]
    lab_full_year: Mapping[str, float]  # lab region -> platform-weeks
    lab_remaining: Mapping[str, float]


# --- eff / rem -------------------------------------------------------------------


def live_step_effective_weeks(project: LiveProjectRow, step: LiveStepRow) -> int:
    """`eff(p, s)` of a live row — the scheduler's own predicate, with R35-1's
    first branch: an excluded step is 0 (so skipped) whatever else it
    carries."""

    if step.excluded:
        return 0
    return step_effective_weeks(
        lead_weeks=step.lead_weeks,
        kind=step.kind,
        certification_testing_required=project.certification_testing_required,
        override_weeks=merged_step_override(
            step.user_override_weeks,
            step.effort_weeks,
            kind=step.kind,
            lab_hold_weeks=step.lab_hold_weeks,
        ),
        lab_hold_weeks=step.lab_hold_weeks,
    )


def live_step_lab_load_weeks(weeks: int, step: LiveStepRow) -> int:
    """ADR 0071 (I25 lab half, I66): the room weeks of a lab step's `weeks`
    (its `eff` or `rem`), `min(hold, weeks)`; `weeks` itself when the hold
    is full (None) or the step is not `partialRoom`."""

    if not is_partial_room(kind=step.kind, lab_hold_weeks=step.lab_hold_weeks):
        return weeks
    return booked_hold_weeks(step.lab_hold_weeks, weeks)


def live_step_remaining_weeks(project: LiveProjectRow, step: LiveStepRow) -> int:
    """`rem(p, s)` (I25): 0 when eff = 0 or Done; derived for In Progress /
    Blocked; eff for Not Started. Raises `ValueError` on an unknown status."""

    if step.status not in PROGRESS_STATUSES:
        raise ValueError(
            f"project {project.project_id!r} step {step.step_id!r}: unknown status {step.status!r}"
        )
    eff = live_step_effective_weeks(project, step)
    if eff == 0 or step.status == STATUS_DONE:
        return 0
    if step.status in (STATUS_IN_PROGRESS, STATUS_BLOCKED):
        return derive_remaining(eff, step.percent_complete, step.remaining_weeks_override)
    return eff


def _lab_region(project: LiveProjectRow) -> str:
    if project.hub not in hubs.HUB_LAB_REGION:
        raise ValueError(f"project {project.project_id!r}: unknown hub {project.hub!r}")
    return hubs.HUB_LAB_REGION[project.hub]


# --- I25 ---------------------------------------------------------------------------


def compute_demand_load(projects: Iterable[LiveProjectRow]) -> DemandLoad:
    """I25's four figures over `projects` (every stored project; scope is
    applied here). Pure and order-independent."""

    design_year: dict[str, int] = defaultdict(int)
    design_rem: dict[str, int] = defaultdict(int)
    lab_year: dict[str, float] = defaultdict(float)
    lab_rem: dict[str, float] = defaultdict(float)
    for p in sorted(projects, key=lambda r: r.project_id):
        if p.status in FULL_YEAR_EXCLUDED_STATUSES:
            continue
        schedulable = p.status in dc.SCHEDULABLE_STATUS_ORDER
        # R42-6: remaining demand covers schedulable ∧ (priority ∉ {P4, Q} ∨
        # frozen). The hub / region key still appears for any schedulable
        # project (its figure may be 0), as before P42.
        open_ = schedulable and (p.frozen or p.priority not in dc.NOT_SCHEDULED_PRIORITIES)
        region = _lab_region(p)
        design_year[p.capacity_hub] += 0
        lab_year[region] += 0.0
        if schedulable:
            design_rem[p.capacity_hub] += 0
            lab_rem[region] += 0.0
        for s in sorted(p.steps, key=lambda r: (r.sequence_order, r.step_id)):
            if s.kind not in ("design", "lab"):
                continue
            eff = live_step_effective_weeks(p, s)
            rem = live_step_remaining_weeks(p, s) if open_ else 0
            if s.kind == "design":
                design_year[p.capacity_hub] += eff
                if open_:
                    design_rem[p.capacity_hub] += rem
            else:
                # ADR 0071: room weeks, `min(hold, eff)` / `min(hold, rem)`.
                lab_year[region] += (
                    live_step_lab_load_weeks(eff, s) * LAB_CONSUMPTION_PER_PROJECT_WEEK
                )
                if open_:
                    lab_rem[region] += (
                        live_step_lab_load_weeks(rem, s) * LAB_CONSUMPTION_PER_PROJECT_WEEK
                    )
    return DemandLoad(
        design_full_year=dict(sorted(design_year.items())),
        design_remaining=dict(sorted(design_rem.items())),
        lab_full_year=dict(sorted(lab_year.items())),
        lab_remaining=dict(sorted(lab_rem.items())),
    )


def _exact(value: Decimal | float | int) -> Fraction:
    return Fraction(Decimal(str(value)) if isinstance(value, float) else value)


def _two_dp(value: Decimal | float | int) -> Decimal:
    dec = Decimal(str(value)) if isinstance(value, float) else Decimal(value)
    return dec.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def check_i25_demand(
    projects: Iterable[LiveProjectRow],
    served_design: Iterable[ServedDesignLoad],
    served_lab: Iterable[ServedLabLoad],
) -> tuple[InvariantViolation, ...]:
    """I25: the served demand fields equal `compute_demand_load(projects)` —
    design to the week (exact), lab to 2 dp. A capacity hub / region with
    non-zero demand must be served; a served row with no in-scope project
    must read 0. `served_*` are the unfiltered rows (one per capacity hub /
    lab region)."""

    demand = compute_demand_load(projects)
    violations: list[InvariantViolation] = []
    design_rows = {r.capacity_hub: r for r in served_design}
    lab_rows = {r.lab_region: r for r in served_lab}

    for hub in sorted(set(demand.design_full_year) | set(design_rows)):
        row = design_rows.get(hub)
        expected = (
            ("design_load_weeks", demand.design_full_year.get(hub, 0)),
            ("design_load_remaining_weeks", demand.design_remaining.get(hub, 0)),
        )
        for field_name, want in expected:
            got = None if row is None else getattr(row, field_name)
            if got is None:
                if want != 0:
                    violations.append(
                        InvariantViolation(
                            invariant="I25",
                            description=(
                                f"capacity hub {hub!r}: no served {field_name}, but the "
                                f"live rows give {want} weeks"
                            ),
                            hub=hub,
                        )
                    )
                continue
            if _exact(got) != want:
                violations.append(
                    InvariantViolation(
                        invariant="I25",
                        description=(
                            f"capacity hub {hub!r}: served {field_name}={got} but Σ eff / rem "
                            f"over the live rows is {want} weeks"
                        ),
                        hub=hub,
                    )
                )

    for region in sorted(set(demand.lab_full_year) | set(lab_rows)):
        lrow = lab_rows.get(region)
        lab_expected = (
            ("lab_load_weeks", demand.lab_full_year.get(region, 0.0)),
            ("lab_load_remaining_weeks", demand.lab_remaining.get(region, 0.0)),
        )
        for field_name, lab_want in lab_expected:
            got = None if lrow is None else getattr(lrow, field_name)
            if got is None:
                if lab_want != 0:
                    violations.append(
                        InvariantViolation(
                            invariant="I25",
                            description=(
                                f"lab region {region!r}: no served {field_name}, but the "
                                f"live rows give {lab_want}"
                            ),
                        )
                    )
                continue
            if _two_dp(got) != _two_dp(lab_want):
                violations.append(
                    InvariantViolation(
                        invariant="I25",
                        description=(
                            f"lab region {region!r}: served {field_name}={got} but Σ eff / rem "
                            f"over the live rows is {lab_want} (2 dp)"
                        ),
                    )
                )
    return tuple(violations)


# --- I26 ---------------------------------------------------------------------------


def check_i26_effort_split(projects: Iterable[LiveProjectRow]) -> tuple[InvariantViolation, ...]:
    """I26 (rev. 2): for every non-frozen project, each step's stored
    `effort_weeks` equals `derive_project_effort` (R2 split of `E = max(1,
    round_half_up(x))` over the current lead times on S′ = the weighted,
    non-excluded steps of the kind, R3 `max(1, ·)` on started steps of S′;
    `None` on every step outside an applied split, excluded steps included).
    Lab steps are not checked when certification testing is off (R7). A
    stored figure whose split exceeds 104 weeks on a step is itself a
    violation (R7: it must have been rejected at write), and so is a figure
    in force whose S′ is empty (R35-5: every weighted step excluded)."""

    violations: list[InvariantViolation] = []
    for p in sorted(projects, key=lambda r: r.project_id):
        if p.frozen:
            continue
        inputs = tuple(
            EffortStepInput(
                step_id=s.step_id,
                sequence_order=s.sequence_order,
                kind=s.kind,
                lead_weeks=s.lead_weeks,
                started=s.status != STATUS_NOT_STARTED,
                excluded=s.excluded,
                lab_hold_weeks=s.lab_hold_weeks,
            )
            for s in p.steps
        )
        try:
            derivation = derive_project_effort(
                design_effort_weeks=p.design_effort_weeks,
                lab_effort_weeks=p.lab_effort_weeks,
                certification_testing_required=p.certification_testing_required,
                steps=inputs,
            )
        except EffortSplitRejected as exc:
            violations.append(
                InvariantViolation(
                    invariant="I26",
                    description=f"project {p.project_id!r}: {exc} — must be rejected at write",
                    project_id=p.project_id,
                    step_id=exc.step_id,
                )
            )
            continue
        for split in (derivation.design, derivation.lab):
            if split.not_applied_reason == NOT_APPLIED_ALL_EXCLUDED:
                violations.append(
                    InvariantViolation(
                        invariant="I26",
                        description=(
                            f"project {p.project_id!r}: its {split.kind} figure is in force but "
                            f"every {split.kind} step with a weight is excluded (S′ is empty; "
                            "R35-5 must refuse this with EFFORT_NEEDS_A_STEP)"
                        ),
                        project_id=p.project_id,
                    )
                )
        expected = derivation.effort_weeks_by_step()
        for s in sorted(p.steps, key=lambda r: (r.sequence_order, r.step_id)):
            # R7 as amended by R62-2: only full-room lab steps are skipped by
            # certification off; a `partialRoom` step must carry no effort
            # share either way (R62-1 / I67).
            if (
                s.kind == "lab"
                and not p.certification_testing_required
                and not is_partial_room(kind=s.kind, lab_hold_weeks=s.lab_hold_weeks)
            ):
                continue
            want = expected.get(s.step_id)
            if s.effort_weeks != want:
                violations.append(
                    InvariantViolation(
                        invariant="I26",
                        description=(
                            f"project {p.project_id!r} step {s.step_id!r} ({s.kind}): "
                            f"effort_weeks={s.effort_weeks} but the effort split gives {want}"
                        ),
                        project_id=p.project_id,
                        step_id=s.step_id,
                    )
                )
    return tuple(violations)


# --- I33 / I34 (live-row halves) ----------------------------------------------------


def _excluded_steps(
    projects: Iterable[LiveProjectRow],
) -> list[tuple[LiveProjectRow, LiveStepRow]]:
    out: list[tuple[LiveProjectRow, LiveStepRow]] = []
    for p in sorted(projects, key=lambda r: r.project_id):
        for s in sorted(p.steps, key=lambda r: (r.sequence_order, r.step_id)):
            if s.excluded:
                out.append((p, s))
    return out


def check_i34_excluded_not_done(
    projects: Iterable[LiveProjectRow],
) -> tuple[InvariantViolation, ...]:
    """I34 (i): no live step is both excluded and stored `Done` (OQ #82,
    R35-2: a Done step may not be excluded, 409 `STEP_DONE`). The other
    halves of I34 compare progress fields across time and are the backend's
    (P35-T05)."""

    return tuple(
        InvariantViolation(
            invariant="I34",
            description=(
                f"project {p.project_id!r} step {s.step_id!r} is excluded but its stored stage "
                "is Done (a Done step may never be excluded, R35-2)"
            ),
            project_id=p.project_id,
            step_id=s.step_id,
        )
        for p, s in _excluded_steps(projects)
        if s.status == STATUS_DONE
    )


def check_i33_step_exclusion(
    projects: Iterable[LiveProjectRow],
    schedule_input: ScheduleInput,
    schedule_output: ScheduleOutput | None = None,
) -> tuple[InvariantViolation, ...]:
    """I33, the part checkable from live rows, the built run input and the
    run (R35-1 / R35-9):

    - every excluded live step has `eff = 0` (`live_step_effective_weeks`);
    - in `schedule_input`, the project's `StepTimingInput` row for it carries
      `lead_weeks = 0` (or no `lead_weeks` when the input table value is
      already 0) and `duration_override_weeks = None`;
    - in `schedule_output` (when given), every row for it is `skipped` with
      `duration_weeks = 0`.

    A project absent from the input (not in the run) is not checked against
    it. "No surface derives a number from the flag alone" is a code-review
    property, not checkable here."""

    violations: list[InvariantViolation] = []
    inputs = {p.project_id: p for p in schedule_input.projects}
    table = {
        (lt.workflow_id, lt.category, lt.step_id): lt.weeks for lt in schedule_input.lead_times
    }
    outcomes = (
        {}
        if schedule_output is None
        else {o.project_id: o for o in schedule_output.project_outcomes}
    )

    def bad(p: LiveProjectRow, s: LiveStepRow, why: str) -> None:
        violations.append(
            InvariantViolation(
                invariant="I33",
                description=f"project {p.project_id!r} excluded step {s.step_id!r}: {why}",
                project_id=p.project_id,
                step_id=s.step_id,
            )
        )

    for p, s in _excluded_steps(projects):
        if live_step_effective_weeks(p, s) != 0:
            bad(p, s, "eff is not 0")
        pin = inputs.get(p.project_id)
        if pin is None:
            continue
        rows = [r for r in pin.step_timing if r.step_id == s.step_id]
        table_weeks = (
            None if pin.category is None else table.get((pin.workflow_id, pin.category, s.step_id))
        )
        leads = sorted(r.lead_weeks for r in rows if r.lead_weeks is not None)
        if leads:
            if any(lead != 0 for lead in leads):
                bad(p, s, f"the run input carries lead_weeks={leads}, not 0 (R35-9)")
        elif table_weeks != 0:
            bad(
                p,
                s,
                f"the run input carries no lead_weeks and the table gives {table_weeks}, so "
                "the step is not skipped (R35-9: lead_weeks = 0)",
            )
        overrides = sorted(
            r.duration_override_weeks for r in rows if r.duration_override_weeks is not None
        )
        if overrides:
            bad(
                p, s, f"the run input carries duration_override_weeks={overrides}, not None (R35-9)"
            )
        outcome = outcomes.get(p.project_id)
        if outcome is None:
            continue
        for row in outcome.steps:
            if row.step_id == s.step_id and (not row.skipped or row.duration_weeks != 0):
                bad(
                    p,
                    s,
                    f"the run row has skipped={row.skipped}, duration_weeks="
                    f"{row.duration_weeks} (must be skipped, 0)",
                )
    return tuple(violations)
