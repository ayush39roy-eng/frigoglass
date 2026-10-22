"""The prioritization scoring formula, per `docs/DOMAIN_RULES.md`
"Prioritization scoring" — against the editable rubric (ADR 0037, P26-T01).

Pure functions only (no DB). The rubric itself (dimensions, weights, the
current version) is loaded from the `scoring_dimensions` / `rubric_versions`
tables by `services.scoring_rubric.load_rubric` and passed in as a `Rubric`.
There is no dimension or weight constant left in code: every reader goes
through a `Rubric`.

```
TOTAL_WEIGHT   = Σ weight(d) over ACTIVE dimensions
points(d)      = score(d) / 5 × weight(d)      (score 0..5; null counts 0)
raw            = Σ points(d)                    (= weighted_score)
normalized_pct = round(raw / TOTAL_WEIGHT × 100), half up, exact
band           = >= 70 P1, >= 55 P2, >= 40 P3, else P4
```

A project with at least one active dimension scored is "scored"; the active
dimensions it has no score on count 0 points and are served as
`missing_dimension_keys` ("incomplete"). A project with no score on any active
dimension is unscored (all three cached fields null), exactly like a project
without a `PriorityScore` row.

Rounding: exact rational arithmetic with half-up rounding. Under the
pre-ADR-0037 rubric (every weight a multiple of 5, total 295) no input can
produce a `.5`, so this is identical to the old float `round()` on every
stored score (pinned by the migration losslessness test).

The seed (`seed/initial_scoring_rubric.py`) computes through these same
functions, so seed-time and request-time scores cannot drift.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from typing import Literal

import domain_constants as dc


@dataclass(frozen=True)
class RubricDimension:
    id: uuid.UUID
    key: str
    label: str
    pillar: str
    weight: int
    inverted: bool
    active: bool
    display_order: int


@dataclass(frozen=True)
class Rubric:
    """One rubric version: every dimension (active and inactive), in
    `display_order`."""

    version: int
    dimensions: tuple[RubricDimension, ...]

    @property
    def active(self) -> tuple[RubricDimension, ...]:
        return tuple(d for d in self.dimensions if d.active)

    @property
    def total_weight(self) -> int:
        return sum(d.weight for d in self.active)

    @property
    def active_keys(self) -> tuple[str, ...]:
        return tuple(d.key for d in self.active)


@dataclass(frozen=True)
class ScoreResult:
    """`weighted_score` is exact to 1 dp (each point is `score × weight / 5`).
    All three are None when no active dimension is scored."""

    weighted_score: Decimal | None
    normalized_pct: int | None
    band: str | None
    missing_keys: tuple[str, ...]

    @property
    def scored(self) -> bool:
        return self.normalized_pct is not None


def points(score: int, weight: int) -> Fraction:
    """ADR 0029: a dimension contributes `score / 5 * weight` (weight at score 5)."""

    return Fraction(score * weight, dc.DIMENSION_SCORE_MAX)


def band_for(pct: int) -> str:
    return next(label for threshold, label in dc.PRIORITY_BAND_THRESHOLDS if pct >= threshold)


def _half_up(value: Fraction) -> int:
    """`round()` half up for a non-negative exact value."""

    return int(value + Fraction(1, 2))


def to_2dp(value: Fraction) -> Decimal:
    return (Decimal(value.numerator) / Decimal(value.denominator)).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


def compute_score(rubric: Rubric, scores: Mapping[str, int | None]) -> ScoreResult:
    """The cached fields of one project under `rubric`. `scores` maps
    dimension key → 0..5 or None; keys of inactive (or unknown) dimensions are
    ignored, active keys absent from `scores` count as missing."""

    active = rubric.active
    present = [(d, scores.get(d.key)) for d in active]
    if not any(s is not None for _d, s in present):
        return ScoreResult(None, None, None, ())
    total = rubric.total_weight
    raw = sum((points(s, d.weight) for d, s in present if s is not None), Fraction(0))
    pct = _half_up(raw * 100 / total)
    missing = tuple(d.key for d, s in present if s is None)
    return ScoreResult(to_2dp(raw), pct, band_for(pct), missing)


def scaled_weight(rubric: Rubric, weight: int) -> float:
    """A weight shown out of 100: `weight * 100 / TOTAL_WEIGHT`, 2 dp (I9: server-side)."""

    return float(to_2dp(Fraction(weight * 100, rubric.total_weight)))


def dimension_table(rubric: Rubric) -> list[dict[str, object]]:
    """The served dimension table: ACTIVE dimensions in `display_order`."""

    return [
        {
            "key": d.key,
            "label": d.label,
            "pillar": d.pillar,
            "weight": d.weight,
            "scaled_weight": scaled_weight(rubric, d.weight),
        }
        for d in rubric.active
    ]


def dimension_points(
    rubric: Rubric, scores: Mapping[str, int | None]
) -> dict[str, dict[str, float]]:
    """Per ACTIVE dimension `{points, scaled_points}` (2 dp), keyed by key.
    `scaled_points = points * 100 / TOTAL_WEIGHT`; a missing score is 0."""

    out: dict[str, dict[str, float]] = {}
    for d in rubric.active:
        score = scores.get(d.key)
        pts = points(score, d.weight) if score is not None else Fraction(0)
        out[d.key] = {
            "points": float(to_2dp(pts)),
            "scaled_points": float(to_2dp(pts * 100 / rubric.total_weight)),
        }
    return out


def dimension_score_rows(
    rubric: Rubric, scores: Mapping[str, int | None] | None
) -> list[dict[str, object]]:
    """docs/API_CONTRACT_P21.md §3 / P26 §4: the ACTIVE dimensions in
    `display_order`, each `{key, label, pillar, score, weight, points,
    max_points}`. `points = score / 5 * weight`, `max_points = weight`, raw
    scale, so `Σ points == weighted_score` (null points count 0). `score` and
    `points` are null for a dimension the project has no score on, and for
    every dimension of an unscored project (`scores is None`)."""

    rows: list[dict[str, object]] = []
    for d in rubric.active:
        score = scores.get(d.key) if scores is not None else None
        rows.append(
            {
                "key": d.key,
                "label": d.label,
                "pillar": d.pillar,
                "score": score,
                "weight": d.weight,
                "points": float(to_2dp(points(score, d.weight))) if score is not None else None,
                "max_points": float(d.weight),
            }
        )
    return rows


# --- P1 capacity fill (ADR 0036, P25-T01) ------------------------------------------

#: The P1 score threshold of the existing band rule (`>= 70 -> P1`), read from
#: `PRIORITY_BAND_THRESHOLDS`, never hard-coded.
P1_SCORE_THRESHOLD: int = next(t for t, label in dc.PRIORITY_BAND_THRESHOLDS if label == "P1")

#: Everything below works on exact 2 dp decimals, so `L + load <= C` is never
#: decided by a binary float rounding error.
_CENT = Decimal("0.01")

FillOutcome = Literal["promoted", "skipped_no_load", "stopped"]


def to_weeks(value: float | Decimal | None) -> Decimal:
    """A week figure as an exact 2 dp `Decimal` (`None` → 0)."""

    if value is None:
        return Decimal("0.00")
    return Decimal(str(value)).quantize(_CENT)


@dataclass(frozen=True)
class FillProject:
    """One project of a hub, as the P1 capacity fill sees it.

    `normalized_pct` is `None` for an unscored project (never in the base set,
    never a candidate). `schedulable` is the live status test (not
    Commercialized / Cancelled / On Hold / Draft). `remaining_design_weeks` is
    the project's remaining design effort in the active run, 0 when it is not
    in the run (`services.capacity_priority.remaining_run_load_by_project`).
    """

    project_id: uuid.UUID
    normalized_pct: int | None
    schedulable: bool
    remaining_design_weeks: Decimal


@dataclass(frozen=True)
class FillDecision:
    """What the walk decided for one candidate. `load_after_weeks` is the
    hub's P1 design load with this candidate's load added (for `promoted` the
    new running total; for `stopped` the total that would have exceeded the
    capacity; for `skipped_no_load` the unchanged total)."""

    outcome: FillOutcome
    load_after_weeks: Decimal


@dataclass(frozen=True)
class HubFill:
    capacity_weeks: Decimal
    base_load_weeks: Decimal
    filled_load_weeks: Decimal
    decisions: Mapping[uuid.UUID, FillDecision] = field(default_factory=dict)

    @property
    def promoted_ids(self) -> frozenset[uuid.UUID]:
        return frozenset(pid for pid, d in self.decisions.items() if d.outcome == "promoted")


def fill_order_key(project: FillProject) -> tuple[int, str]:
    """ADR 0036 walk order: normalized score descending, then `project_id`
    ascending as its canonical lowercase UUID string (deterministic)."""

    return (-(project.normalized_pct or 0), str(project.project_id))


def fill_p1_capacity(capacity_weeks: Decimal, projects: Iterable[FillProject]) -> HubFill:
    """ADR 0036 "P1 capacity fill" for ONE hub. Pure; reads nothing else.

    - Base P1 set: scored projects with `normalized_pct >= 70` (the band rule;
      any status). Base load `L` = Σ their remaining design weeks.
    - If `C <= 0` or `L >= C`: nothing is promoted.
    - Otherwise walk the candidates (scored, `normalized_pct < 70`,
      schedulable) in `fill_order_key` order. A candidate with 0 remaining
      design weeks is skipped (it uses no capacity, so promoting it would not
      "fill" anything) and the walk continues. Otherwise, if `L + load <= C`
      it is promoted and `L += load`; if not, the walk STOPS there.
    """

    items = list(projects)
    capacity = capacity_weeks.quantize(_CENT)
    base_load = sum(
        (
            p.remaining_design_weeks
            for p in items
            if p.normalized_pct is not None and p.normalized_pct >= P1_SCORE_THRESHOLD
        ),
        Decimal("0.00"),
    ).quantize(_CENT)
    if capacity <= 0 or base_load >= capacity:
        return HubFill(capacity, base_load, base_load, {})

    candidates = sorted(
        (
            p
            for p in items
            if p.normalized_pct is not None
            and p.normalized_pct < P1_SCORE_THRESHOLD
            and p.schedulable
        ),
        key=fill_order_key,
    )
    load = base_load
    decisions: dict[uuid.UUID, FillDecision] = {}
    for p in candidates:
        weeks = p.remaining_design_weeks.quantize(_CENT)
        if weeks <= 0:
            decisions[p.project_id] = FillDecision("skipped_no_load", load)
            continue
        after = load + weeks
        if after > capacity:
            decisions[p.project_id] = FillDecision("stopped", after)
            break
        load = after
        decisions[p.project_id] = FillDecision("promoted", load)
    return HubFill(capacity, base_load, load, decisions)


def capacity_fill_reason(decision: FillDecision | None, capacity_weeks: Decimal) -> str | None:
    """The short served `capacity_fill_reason` (ADR 0036 §5); `None` for a
    project the walk never decided on."""

    if decision is None:
        return None
    after, cap = f"{decision.load_after_weeks:.2f}", f"{capacity_weeks:.2f}"
    if decision.outcome == "promoted":
        return f"P1 (capacity fill): hub P1 design load {after} of {cap} weeks with this project"
    if decision.outcome == "stopped":
        return f"Not promoted: hub P1 design load would be {after} of {cap} weeks"
    return "Not promoted: no remaining design work in the active run"
