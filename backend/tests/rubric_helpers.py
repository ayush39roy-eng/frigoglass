"""Test helpers for the scoring rubric (ADR 0037, P26-T01): the initial 13
dimensions as seeded by migration `p26a_scoring_rubric_tables`, and the one
scoring implementation (`services.priority_scoring.compute_score`)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from seed.initial_scoring_rubric import INITIAL_KEYS, INITIAL_SCORING_DIMENSIONS, initial_rubric
from services.priority_scoring import compute_score

INITIAL_WEIGHTS: list[int] = [d[3] for d in INITIAL_SCORING_DIMENSIONS]
INITIAL_TOTAL_WEIGHT: int = sum(INITIAL_WEIGHTS)  # 295

__all__ = [
    "INITIAL_KEYS",
    "INITIAL_TOTAL_WEIGHT",
    "INITIAL_WEIGHTS",
    "score_body",
    "score_of",
]


def score_of(dims: Sequence[int]) -> tuple[float, int, str]:
    """`(weighted_score, normalized_pct, band)` of positional `dims` under the
    initial rubric."""

    result = compute_score(initial_rubric(), dict(zip(INITIAL_KEYS, dims, strict=True)))
    assert result.weighted_score is not None and result.normalized_pct is not None
    assert result.band is not None
    return float(result.weighted_score), result.normalized_pct, result.band


def score_body(dims: Sequence[int], hard_gates: Sequence[str] = ()) -> dict[str, Any]:
    """A `PUT /priorities/{id}` body for positional `dims` (ADR 0037 shape)."""

    return {"scores": dict(zip(INITIAL_KEYS, dims, strict=True)), "hard_gates": list(hard_gates)}
