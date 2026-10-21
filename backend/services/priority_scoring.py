"""The 13-dimension prioritization scoring formula, per `docs/DOMAIN_RULES.md`
"Prioritization scoring — 13 dimensions".

This is the same formula `seed.seed_demo_data._priority_score_fields` already
implements for seed-time computation (see that module's docstring and
`docs/MEMORY.md` P1-T03/P1-T05 entries) — duplicated here rather than
imported from `seed/`, because `seed_demo_data` is a standalone CLI script
(argparse, its own `asyncio.run`), not a module the API process should import
at request time. **This is a deliberate, flagged duplication** of one pure
function, not two independently-maintained implementations of the rule set:
both read their weights/thresholds from `domain_constants`, so they cannot
drift on the *data* (only a literal code bug in one but not the other could
cause disagreement) — `tests/test_priority_scoring.py`'s existing golden
threshold cases (P1-T05) apply equally to this copy. Flagged for a future
task to fold `seed_demo_data._priority_score_fields` into an import of this
module instead, once someone owns editing that already-reviewed seed script.
"""

from __future__ import annotations

import domain_constants as dc


def compute_priority_score(dimension_scores: list[int]) -> tuple[float, int, str]:
    """`(weighted_score, normalized_pct, suggested_band)` per DOMAIN_RULES.md.

    `dimension_scores` must be exactly 13 ints (0-5 each, ADR 0033), in
    `domain_constants.PRIORITIZATION_DIMENSIONS` / `models.priority.
    DIMENSION_FIELD_NAMES` order (Strategic Project, New Customer, ...,
    CAPEX Investment). Caller (the Pydantic request schema) is responsible for
    the 0-5 range check; this function only asserts the count.
    """

    if len(dimension_scores) != len(dc.PRIORITIZATION_DIMENSIONS):
        raise ValueError(
            f"expected {len(dc.PRIORITIZATION_DIMENSIONS)} dimension scores, "
            f"got {len(dimension_scores)}"
        )
    weighted_score = sum(_points(score, weight) for score, weight in _pairs(dimension_scores))
    normalized_pct = round(weighted_score / dc.TOTAL_WEIGHT * 100)
    suggested_band = next(
        label for threshold, label in dc.PRIORITY_BAND_THRESHOLDS if normalized_pct >= threshold
    )
    return float(weighted_score), normalized_pct, suggested_band


def _points(score: int, weight: int) -> float:
    """ADR 0029: a dimension contributes `score / 5 * weight` (weight at score 5)."""

    return score * weight / dc.DIMENSION_SCORE_MAX


def _pairs(dimension_scores: list[int]) -> list[tuple[int, int]]:
    return [
        (score, weight)
        for score, (*_rest, weight) in zip(
            dimension_scores, dc.PRIORITIZATION_DIMENSIONS, strict=True
        )
    ]


def scaled_weight(weight: int) -> float:
    """A weight shown out of 100: `weight * 100 / TOTAL_WEIGHT`, 2 dp (I9: server-side)."""

    return round(weight * 100 / dc.TOTAL_WEIGHT, 2)


def dimension_table() -> list[dict[str, object]]:
    """The served dimension table, in positional (DB column) order."""

    return [
        {
            "key": key,
            "label": label,
            "pillar": pillar,
            "weight": weight,
            "scaled_weight": scaled_weight(weight),
        }
        for pillar, label, key, weight in dc.PRIORITIZATION_DIMENSIONS
    ]


def dimension_points(dimension_scores: list[int]) -> dict[str, dict[str, float]]:
    """Per-dimension `{points, scaled_points}` (2 dp), keyed by dimension key.
    `scaled_points = points * 100 / TOTAL_WEIGHT`."""

    out: dict[str, dict[str, float]] = {}
    for (*_r, key, weight), score in zip(
        dc.PRIORITIZATION_DIMENSIONS, dimension_scores, strict=True
    ):
        pts = _points(score, weight)
        out[key] = {
            "points": round(pts, 2),
            "scaled_points": round(pts * 100 / dc.TOTAL_WEIGHT, 2),
        }
    return out


def dimension_score_rows(dimension_scores: list[int] | None) -> list[dict[str, object]]:
    """P21-T01 (docs/API_CONTRACT_P21.md §3): the 13 dimensions in positional
    order, each `{key, label, pillar, score, weight, points, max_points}`.

    `points = score / 5 * weight` (ADR 0029; a score of 0 earns 0, ADR 0033),
    `max_points = weight` (the points at score 5). Both are on the raw scale,
    so `Σ points == weighted_score` exactly (every weight is a multiple of 5,
    so each point value is an integer). `None` (an unscored project) gives the
    full list with `score` and `points` null.
    """

    rows: list[dict[str, object]] = []
    scores: list[int | None] = (
        list(dimension_scores)
        if dimension_scores is not None
        else [None] * len(dc.PRIORITIZATION_DIMENSIONS)
    )
    for (pillar, label, key, weight), score in zip(
        dc.PRIORITIZATION_DIMENSIONS, scores, strict=True
    ):
        rows.append(
            {
                "key": key,
                "label": label,
                "pillar": pillar,
                "score": score,
                "weight": weight,
                "points": round(_points(score, weight), 2) if score is not None else None,
                "max_points": float(weight),
            }
        )
    return rows
