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
    In Queue). `rem` is 0 when eff = 0 or the stage is Done;
    `derive_remaining(eff, percent_complete, remaining_weeks_override)` for
    In Progress / Blocked; eff for Not Started. Effort, never a span; not
    windowed to W52; stored progress counts for every project, frozen
    included.
  - Lab: the same per lab region (of the project's hub), lab-kind steps,
    × 1.0 platform-week per project-week.
  - The served `design_load_weeks` / `design_load_remaining_weeks` equal the
    design figures to the week; `lab_load_weeks` / `lab_load_remaining_weeks`
    the lab figures to 2 dp.
- **I26 — effort split.** For every non-frozen project, the stored
  `effort_weeks` of its steps equal `effort_split.derive_project_effort` of
  its figures over the current lead times, with R3's `max(1, ·)` on started
  steps. Lab steps are not checked when certification testing is off (they
  are skipped whatever they carry, R7). A figure whose split would exceed 104
  weeks on a step must never have been stored (R7). Frozen projects are
  exempt (R6: re-derivation is a no-op on them, I10).

Violations reuse `invariants.InvariantViolation` (`invariant="I25"` /
`"I26"`); every result is in a deterministic order.
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
    EffortFigure,
    EffortSplitRejected,
    EffortStepInput,
    derive_project_effort,
)
from scheduling.invariants import InvariantViolation
from scheduling.types import LAB_CONSUMPTION_PER_PROJECT_WEEK, PROGRESS_STATUSES
from scheduling.workflow import (
    STATUS_BLOCKED,
    STATUS_DONE,
    STATUS_IN_PROGRESS,
    STATUS_NOT_STARTED,
    derive_remaining,
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
    """`eff(p, s)` of a live row — the scheduler's own predicate."""

    return step_effective_weeks(
        lead_weeks=step.lead_weeks,
        kind=step.kind,
        certification_testing_required=project.certification_testing_required,
        override_weeks=merged_step_override(step.user_override_weeks, step.effort_weeks),
    )


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
        open_ = p.status in dc.SCHEDULABLE_STATUS_ORDER
        region = _lab_region(p)
        design_year[p.capacity_hub] += 0
        lab_year[region] += 0.0
        if open_:
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
                lab_year[region] += eff * LAB_CONSUMPTION_PER_PROJECT_WEEK
                if open_:
                    lab_rem[region] += rem * LAB_CONSUMPTION_PER_PROJECT_WEEK
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
    """I26: for every non-frozen project, each step's stored `effort_weeks`
    equals `derive_project_effort` (R2 split of `E = max(1,
    round_half_up(x))` over the current lead times, R3 `max(1, ·)` on
    started steps; `None` on every step outside an applied split). Lab steps
    are not checked when certification testing is off (R7). A stored figure
    whose split exceeds 104 weeks on a step is itself a violation (R7: it
    must have been rejected at write)."""

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
        expected = derivation.effort_weeks_by_step()
        for s in sorted(p.steps, key=lambda r: (r.sequence_order, r.step_id)):
            if s.kind == "lab" and not p.certification_testing_required:
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
