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

    `dimension_scores` must be exactly 13 ints (1-5 each), in
    `domain_constants.PRIORITIZATION_DIMENSIONS` / `models.priority.
    DIMENSION_FIELD_NAMES` order (Strategic Project, New Customer, ...,
    CAPEX Investment). Caller (the Pydantic request schema) is responsible for
    the 1-5 range check; this function only asserts the count.
    """

    if len(dimension_scores) != len(dc.PRIORITIZATION_DIMENSIONS):
        raise ValueError(
            f"expected {len(dc.PRIORITIZATION_DIMENSIONS)} dimension scores, "
            f"got {len(dimension_scores)}"
        )
    weighted_score = sum(
        score * weight
        for score, (*_rest, weight) in zip(
            dimension_scores, dc.PRIORITIZATION_DIMENSIONS, strict=True
        )
    )
    normalized_pct = round(weighted_score / (dc.TOTAL_WEIGHT * dc.DIMENSION_SCORE_MAX) * 100)
    suggested_band = next(
        label for threshold, label in dc.PRIORITY_BAND_THRESHOLDS if normalized_pct >= threshold
    )
    return float(weighted_score), normalized_pct, suggested_band
