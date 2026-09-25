"""Scenario #7 — the `PriorityScore`/`PriorityApplicationResult`
weighted-score / normalized-pct / band formula matches
`docs/DOMAIN_RULES.md`'s documented thresholds (>=70 P1, >=55 P2, >=40 P3,
else P4), including a boundary case at each threshold.

There is no standalone, reusable "compute a priority score" service function
yet (P3 hasn't been built) — the only place this formula is actually
implemented in shipped code is `seed.seed_demo_data._priority_score_fields`,
used at seed time (P1-T03). This test suite exercises *that* real function
directly (not a reimplementation of the formula that would only test itself)
against dimension-score combinations chosen to land exactly on, and just
below, each documented threshold, then persists the result through the real
`PriorityScore` model/CHECK-constraints to confirm the whole path (formula
-> DB round-trip) is consistent with DOMAIN_RULES.md.
"""

from __future__ import annotations

import pytest

import domain_constants as dc
from models.enums import ProjectPriority
from seed.seed_demo_data import _priority_score_fields
from tests.factories import make_hub, make_priority_score, make_project

# Dimension order per domain_constants.PRIORITIZATION_DIMENSIONS /
# models.priority.DIMENSION_FIELD_NAMES:
#   strategic_project(25), new_customer(25), new_options(25),
#   regulatory_compliance(25), quality_improvements(25), rm_savings(25),
#   total_rm_savings(25), gross_margins(25), profitability(25),
#   annual_volume(15), three_year_volume(15), new_models(15),
#   capex_investment(10)
# TOTAL_WEIGHT = 280, max per-dimension score = 5, so max weighted_score = 1400.

# Uniform-score cases: weighted_score = 280 * score, pct = score * 20.
DIMS_ALL_1 = [1] * 13  # weighted=280, pct=20  -> P4
DIMS_ALL_2 = [2] * 13  # weighted=560, pct=40  -> P3 (exact threshold)
DIMS_ALL_3 = [3] * 13  # weighted=840, pct=60  -> P2 (>= 55, < 70)

# Hand-tuned combinations landing exactly on the 70 and 55 thresholds.
# 25*5+25*5+25*4+25*4+25*3*5 + 15*3*3 + 10*2
#   = 125+125+100+100+375 + 135 + 20 = 980 -> pct = round(980/1400*100) = 70
DIMS_EXACTLY_70 = [5, 5, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 2]
# 25*1 + 25*3*8 + 15*3*3 + 10*1 = 25 + 600 + 135 + 10 = 770 -> pct = 55
DIMS_EXACTLY_55 = [1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1]
# One dimension below DIMS_EXACTLY_70's total (weighted=965) -> pct = 69,
# demonstrating the band flips to P2 just *below* the P1 threshold.
DIMS_JUST_BELOW_70 = [5, 5, 4, 4, 3, 3, 3, 3, 3, 2, 3, 3, 2]


def _expected(dims: list[int]) -> tuple[float, int, str]:
    """Independent oracle for weighted_score/normalized_pct/band, computed
    directly from `domain_constants` rather than by calling the function
    under test — this is what the parametrized assertions below are checked
    against, so this test would have caught a formula bug in either the
    weights table or the banding thresholds.
    """
    weighted = sum(
        score * weight
        for score, (*_rest, weight) in zip(dims, dc.PRIORITIZATION_DIMENSIONS, strict=True)
    )
    pct = round(weighted / (dc.TOTAL_WEIGHT * dc.DIMENSION_SCORE_MAX) * 100)
    band = next(label for threshold, label in dc.PRIORITY_BAND_THRESHOLDS if pct >= threshold)
    return weighted, pct, band


@pytest.mark.parametrize(
    ("dims", "expected_pct", "expected_band"),
    [
        (DIMS_ALL_1, 20, "P4"),
        (DIMS_ALL_2, 40, "P3"),  # exact P3 threshold: >= 40
        (DIMS_ALL_3, 60, "P2"),
        (DIMS_EXACTLY_55, 55, "P2"),  # exact P2 threshold: >= 55
        (DIMS_JUST_BELOW_70, 69, "P2"),  # just below P1 threshold: still P2
        (DIMS_EXACTLY_70, 70, "P1"),  # exact P1 threshold: >= 70
    ],
)
def test_priority_score_fields_matches_domain_rules_thresholds(dims, expected_pct, expected_band):
    weighted, pct, band = _priority_score_fields(dims)
    exp_weighted, exp_pct, exp_band = _expected(dims)

    assert pct == expected_pct == exp_pct
    assert band == expected_band == exp_band
    assert weighted == exp_weighted


def test_priority_score_thresholds_are_ordered_and_cover_full_range():
    """Sanity-checks domain_constants.PRIORITY_BAND_THRESHOLDS itself: strictly
    descending thresholds ending in a catch-all 0 (else -> P4), and matches
    the exact DOMAIN_RULES.md band labels/order (P1, P2, P3, P4).
    """
    thresholds = dc.PRIORITY_BAND_THRESHOLDS
    assert [t for t, _label in thresholds] == sorted((t for t, _l in thresholds), reverse=True)
    assert thresholds[-1][0] == 0
    assert [label for _t, label in thresholds] == ["P1", "P2", "P3", "P4"]


@pytest.mark.parametrize(
    ("dims", "expected_pct", "expected_band"),
    [
        (DIMS_ALL_1, 20, ProjectPriority.P4),
        (DIMS_EXACTLY_55, 55, ProjectPriority.P2),
        (DIMS_EXACTLY_70, 70, ProjectPriority.P1),
    ],
)
async def test_priority_score_persists_and_reads_back_through_db(
    db_session, dims, expected_pct, expected_band
):
    """End-to-end: compute via the real seed-time function, persist through
    the actual `PriorityScore` model (exercising its 13 CHECK(1..5)
    constraints), and read the band back via the ORM — confirming the
    formula's output is exactly what ends up queryable, not just what a pure
    Python function returns in isolation.
    """
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    weighted, pct, band = _priority_score_fields(dims)
    assert pct == expected_pct

    score = await make_priority_score(
        db_session,
        project,
        dims=dims,
        weighted_score=weighted,
        normalized_pct=pct,
        suggested_band=ProjectPriority(band),
    )
    assert score.normalized_pct == expected_pct
    assert score.suggested_band == expected_band
