"""Per-project effort split (ADR 0041 §3 as amended by the workflow-auditor's
R2, R3 and R7). Pure, exact, deterministic.

A project's typed effort figure (`projects.design_effort_weeks`, col 16, or
`projects.lab_effort_weeks`, col 21; `Numeric(6, 2)`) is apportioned over the
steps of one kind (`design` or `lab`) of its workflow, in proportion to their
lead times. The result is written by the backend (P30-T02) to
`project_workflow_steps.effort_weeks` (R4), never to the user's
`duration_override_weeks`. The solver never calls this module: it receives the
merged `user ?? effort` value through `StepTimingInput.duration_override_weeks`
(`workflow.merged_step_override`).

The rule, for a figure x and the steps S of the kind whose lead time
t_i > 0 (T = Σ t_i):

1. **Target.** `E = max(1, round_half_up(x))` on the stored decimal, for
   x > 0 (R2). A figure that is blank or 0 is **no figure**: the steps keep
   their table durations (§3 fallback; "a typed 0 is treated like a blank").
2. **Quotas** are exact rationals `q_i = E × t_i / T` (`fractions.Fraction`;
   never binary floats, which pick a different step in 52 of the cases the
   auditor enumerated). Each step gets `⌊q_i⌋`.
3. **Remainder** `E − Σ⌊q_i⌋` goes one week at a time down the total order
   (R2): larger fractional part `q_i − ⌊q_i⌋`, then larger `t_i`, then
   smaller `sequence_order`, then smaller `step_id`. So `Σ = E` exactly.
4. **Recorded work is never erased** (R3): a step whose stored stage status
   is not `Not Started` gets `max(1, A_i)`. The total may then exceed E by
   the number of raised steps (reported as `raised_step_ids`).
5. **Edge cases** (R7):
   - T = 0 (the category has no non-zero step of that kind): no split, the
     figure is flagged *not applied* (`NOT_APPLIED_NO_NONZERO_STEP`);
   - a split that puts a step above 104 weeks is **rejected**
     (`EffortSplitRejected`, a `ValueError`) — at write and at import;
   - a `lab` split with certification testing off is not applied
     (`NOT_APPLIED_CERTIFICATION_OFF`): the lab steps stay skipped whatever
     `lab_effort_weeks` says.

A step of S that receives 0 is skipped by the scheduler (ADR 0041 R5:
skipped ⟺ effective = 0). Steps outside S (lead 0) carry no derived effort.

Worked examples (DOMAIN_RULES lead-time table): PDD/B design, x = 4 →
A 1, E 2, K 1 (D, J and M skipped); PDD/C design, x = 3 → A 1, D 1, E 1
(J and K skipped); PDD/B lab, x = 10 → H 10; PDD/A+ lab, x = 4 → F 2, H 2;
PDD/B lab, x = 70 → H 70; x = 1.5 → E = 2.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from fractions import Fraction

#: The maximum effective duration of one step (the 0..104 domain, ADR 0041 R4).
EFFORT_STEP_MAX_WEEKS = 104

#: `EffortSplit.not_applied_reason` values.
NOT_APPLIED_NO_FIGURE = "no_figure"  # blank, or 0 (a typed 0 is a blank)
NOT_APPLIED_NO_NONZERO_STEP = "no_nonzero_step"  # R7: T = 0
NOT_APPLIED_CERTIFICATION_OFF = "certification_off"  # R7: lab, cert testing off

EFFORT_KINDS: tuple[str, ...] = ("design", "lab")

#: A stored effort figure: the `Numeric(6, 2)` value (a `Decimal` from the
#: driver), an `int`, or its decimal string. A `float` is accepted and read
#: through `str()` (its shortest repr, e.g. `2.675` -> `Decimal("2.675")`),
#: never through its binary value.
EffortFigure = Decimal | int | float | str


class EffortSplitRejected(ValueError):
    """R7: the split would put a step above `EFFORT_STEP_MAX_WEEKS`. The
    figure must be rejected at write (422) and at import."""

    def __init__(self, step_id: str, weeks: int, figure: Decimal) -> None:
        super().__init__(
            f"effort figure {figure} puts step {step_id!r} at {weeks} weeks, above the "
            f"{EFFORT_STEP_MAX_WEEKS}-week maximum of one step (ADR 0041 R7)"
        )
        self.step_id = step_id
        self.weeks = weeks
        self.figure = figure


@dataclass(frozen=True)
class EffortStepInput:
    """One workflow step of one project, as the split needs it.

    - `kind`: the step's kind on Workflow Settings (`design` / `lab` /
      `elapsed`); only steps of the split's kind take part.
    - `lead_weeks`: the lead-time table value `lead_time[workflow][category]
      [step]` in force (never the override, never the effort column).
    - `started`: the stored stage status is not `Not Started` (In Progress,
      Blocked or Done) — R3.
    """

    step_id: str
    sequence_order: int
    kind: str
    lead_weeks: int
    started: bool = False


@dataclass(frozen=True)
class EffortSplit:
    """The split of one figure over one kind's steps.

    `step_weeks` lists `(step_id, weeks)` for every step of S (lead > 0) in
    `(sequence_order, step_id)` order — 0 is a value (the step is skipped);
    it is empty when the split is not applied. Steps not listed carry no
    derived effort (`effort_weeks` NULL)."""

    kind: str
    applied: bool
    not_applied_reason: str | None
    figure: Decimal | None
    target_weeks: int | None  # E; None when there is no figure
    step_weeks: tuple[tuple[str, int], ...]
    raised_step_ids: tuple[str, ...]  # R3: started steps raised from 0 to 1

    @property
    def total_weeks(self) -> int:
        """Σ derived weeks = `target_weeks + len(raised_step_ids)` when applied."""

        return sum(w for _, w in self.step_weeks)

    def weeks_by_step(self) -> dict[str, int]:
        return dict(self.step_weeks)


@dataclass(frozen=True)
class ProjectEffortDerivation:
    """Both splits of one project and the resulting `effort_weeks` column:
    one `(step_id, weeks | None)` per input step, in `(sequence_order,
    step_id)` order. `None` = no derived effort (the step falls back to the
    user override or the lead time)."""

    design: EffortSplit
    lab: EffortSplit
    effort_weeks: tuple[tuple[str, int | None], ...]

    def effort_weeks_by_step(self) -> dict[str, int | None]:
        return dict(self.effort_weeks)


# --- Arithmetic -------------------------------------------------------------------


def to_decimal(figure: EffortFigure) -> Decimal:
    """The figure as an exact `Decimal` (see `EffortFigure`). Raises
    `ValueError` for a non-finite or non-numeric value."""

    if isinstance(figure, bool):
        raise ValueError(f"effort figure {figure!r} is not a number")
    try:
        value = Decimal(str(figure)) if isinstance(figure, float) else Decimal(figure)
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"effort figure {figure!r} is not a number") from exc
    if not value.is_finite():
        raise ValueError(f"effort figure {figure!r} is not finite")
    return value


def round_half_up(figure: EffortFigure) -> int:
    """Round to the nearest integer, halves away from zero (`0.5 -> 1`,
    `1.5 -> 2`, `2.5 -> 3`), on the exact decimal value. Never Python's
    half-to-even `round`."""

    return int(to_decimal(figure).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def effort_target_weeks(figure: EffortFigure | None) -> int | None:
    """R2: `E = max(1, round_half_up(x))` for x > 0; `None` for a blank or 0
    figure (no figure: table fallback). Raises `ValueError` for x < 0 (the
    column is `>= 0`)."""

    if figure is None:
        return None
    value = to_decimal(figure)
    if value < 0:
        raise ValueError(f"effort figure {figure!r} is negative")
    if value == 0:
        return None
    return max(1, round_half_up(value))


def _validate_steps(steps: Iterable[EffortStepInput]) -> tuple[EffortStepInput, ...]:
    ordered = tuple(sorted(steps, key=lambda s: (s.sequence_order, s.step_id)))
    seen: set[str] = set()
    for s in ordered:
        if s.step_id in seen:
            raise ValueError(f"step {s.step_id!r} appears more than once")
        seen.add(s.step_id)
        if s.lead_weeks < 0:
            raise ValueError(f"step {s.step_id!r} has a negative lead time {s.lead_weeks}")
    return ordered


def apportion_effort(
    figure: EffortFigure | None,
    steps: Iterable[EffortStepInput],
    *,
    kind: str = "design",
    certification_testing_required: bool = True,
) -> EffortSplit:
    """ADR 0041 §3 + R2/R3/R7: split `figure` over the `kind` steps of
    `steps` (other kinds in `steps` are ignored). See the module docstring for
    the rule. Raises `EffortSplitRejected` when a step would exceed 104 weeks
    and `ValueError` on malformed input (negative figure or lead time,
    duplicate step, unknown kind). Pure and deterministic: the input order of
    `steps` never matters."""

    if kind not in EFFORT_KINDS:
        raise ValueError(f"kind {kind!r} is not one of {EFFORT_KINDS}")
    ordered = _validate_steps(steps)
    target = effort_target_weeks(figure)
    decimal_figure = None if figure is None else to_decimal(figure)

    def not_applied(reason: str) -> EffortSplit:
        return EffortSplit(
            kind=kind,
            applied=False,
            not_applied_reason=reason,
            figure=decimal_figure,
            target_weeks=target,
            step_weeks=(),
            raised_step_ids=(),
        )

    if target is None:
        return not_applied(NOT_APPLIED_NO_FIGURE)
    if kind == "lab" and not certification_testing_required:
        return not_applied(NOT_APPLIED_CERTIFICATION_OFF)
    members = [s for s in ordered if s.kind == kind and s.lead_weeks > 0]
    total_lead = sum(s.lead_weeks for s in members)
    if total_lead == 0:
        return not_applied(NOT_APPLIED_NO_NONZERO_STEP)

    quota = {s.step_id: Fraction(target * s.lead_weeks, total_lead) for s in members}
    weeks = {sid: math.floor(q) for sid, q in quota.items()}
    remainder = target - sum(weeks.values())
    # R2 total order: larger fractional part, larger t_i, sequence_order, step_id.
    by_claim = sorted(
        members,
        key=lambda s: (
            -(quota[s.step_id] - weeks[s.step_id]),
            -s.lead_weeks,
            s.sequence_order,
            s.step_id,
        ),
    )
    for s in by_claim[:remainder]:
        weeks[s.step_id] += 1
    assert sum(weeks.values()) == target  # exact arithmetic: Σ⌊q⌋ ≤ E < Σ⌊q⌋ + |S|

    raised: list[str] = []
    for s in members:
        if s.started and weeks[s.step_id] == 0:
            weeks[s.step_id] = 1  # R3: recorded work is never erased
            raised.append(s.step_id)

    for s in members:
        if weeks[s.step_id] > EFFORT_STEP_MAX_WEEKS:
            assert decimal_figure is not None
            raise EffortSplitRejected(s.step_id, weeks[s.step_id], decimal_figure)

    return EffortSplit(
        kind=kind,
        applied=True,
        not_applied_reason=None,
        figure=decimal_figure,
        target_weeks=target,
        step_weeks=tuple((s.step_id, weeks[s.step_id]) for s in members),
        raised_step_ids=tuple(raised),
    )


def derive_project_effort(
    *,
    design_effort_weeks: EffortFigure | None,
    lab_effort_weeks: EffortFigure | None,
    certification_testing_required: bool,
    steps: Iterable[EffortStepInput],
) -> ProjectEffortDerivation:
    """The whole `project_workflow_steps.effort_weeks` column of one project
    (R4): the design split over its design steps, the lab split over its lab
    steps (not applied when certification testing is off), `None` on every
    other step (elapsed steps, lead-0 steps, and every step of a kind whose
    figure is blank / 0 / not applicable). Raises `EffortSplitRejected` (R7)
    if either split would exceed 104 weeks on a step — the caller rejects the
    whole write."""

    ordered = _validate_steps(steps)
    design = apportion_effort(design_effort_weeks, ordered, kind="design")
    lab = apportion_effort(
        lab_effort_weeks,
        ordered,
        kind="lab",
        certification_testing_required=certification_testing_required,
    )
    derived: Mapping[str, int] = {**design.weeks_by_step(), **lab.weeks_by_step()}
    return ProjectEffortDerivation(
        design=design,
        lab=lab,
        effort_weeks=tuple((s.step_id, derived.get(s.step_id)) for s in ordered),
    )
