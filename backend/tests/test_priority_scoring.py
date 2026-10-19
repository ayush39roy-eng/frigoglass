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
# models.priority.DIMENSION_FIELD_NAMES (ADR 0029 weights):
#   strategic_project(25), new_customer(25), new_options(25),
#   regulatory_compliance(25), quality_improvements(25), rm_savings(25),
#   total_rm_savings(25), gross_margins(25, "Gross Profitability"),
#   profitability(25, "ROI"), annual_volume(15), three_year_volume(25),
#   new_models(15), capex_investment(15)
# TOTAL_WEIGHT is derived (295). points = score / 5 * weight; max raw = TOTAL_WEIGHT.

# Uniform-score cases: raw = TOTAL_WEIGHT * score / 5, pct = score * 20.
DIMS_ALL_1 = [1] * 13  # raw=59,  pct=20  -> P4
DIMS_ALL_2 = [2] * 13  # raw=118, pct=40  -> P3 (exact threshold)
DIMS_ALL_3 = [3] * 13  # raw=177, pct=60  -> P2 (>= 55, < 70)

# Hand-tuned combinations around the thresholds (raw / 295 * 100, rounded).
DIMS_EXACTLY_70 = [5, 3, 5, 2, 4, 2, 5, 2, 4, 2, 5, 2, 3]  # raw 206 -> 69.83 -> 70
DIMS_JUST_BELOW_70 = [5, 3, 5, 2, 4, 2, 5, 2, 4, 1, 5, 2, 3]  # raw 203 -> 68.81 -> 69
DIMS_EXACTLY_55 = [2, 2, 4, 3, 3, 2, 3, 2, 2, 4, 3, 2, 5]  # raw 163 -> 55.25 -> 55
DIMS_JUST_BELOW_55 = [2, 2, 4, 3, 3, 2, 3, 2, 2, 3, 3, 2, 5]  # raw 160 -> 54.24 -> 54


def _expected(dims: list[int]) -> tuple[float, int, str]:
    """Independent oracle for weighted_score/normalized_pct/band, computed
    directly from `domain_constants` rather than by calling the function
    under test — this is what the parametrized assertions below are checked
    against, so this test would have caught a formula bug in either the
    weights table or the banding thresholds.
    """
    weighted = sum(
        score / 5 * weight
        for score, (*_rest, weight) in zip(dims, dc.PRIORITIZATION_DIMENSIONS, strict=True)
    )
    pct = round(weighted / dc.TOTAL_WEIGHT * 100)
    band = next(label for threshold, label in dc.PRIORITY_BAND_THRESHOLDS if pct >= threshold)
    return weighted, pct, band


@pytest.mark.parametrize(
    ("dims", "expected_pct", "expected_band"),
    [
        (DIMS_ALL_1, 20, "P4"),
        (DIMS_ALL_2, 40, "P3"),  # exact P3 threshold: >= 40
        (DIMS_ALL_3, 60, "P2"),
        (DIMS_EXACTLY_55, 55, "P2"),  # exact P2 threshold: >= 55
        (DIMS_JUST_BELOW_55, 54, "P3"),  # just below P2 threshold
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


# --- ADR 0029 goldens: dimension table, weights, scaled figures -----------


def test_dimension_table_matches_adr_0029():
    by_key = {key: (label, pillar, w) for pillar, label, key, w in dc.PRIORITIZATION_DIMENSIONS}
    assert [k for _p, _l, k, _w in dc.PRIORITIZATION_DIMENSIONS] == [
        "strategic_project", "new_customer", "new_options", "regulatory_compliance",
        "quality_improvements", "rm_savings", "total_rm_savings", "gross_margins",
        "profitability", "annual_volume", "three_year_volume", "new_models",
        "capex_investment",
    ]  # fmt: skip
    assert by_key["gross_margins"] == ("Gross Profitability", "Financial Return", 25)
    assert by_key["profitability"] == ("ROI", "Investment & Feasibility", 25)
    assert by_key["three_year_volume"][2] == 25
    assert by_key["capex_investment"][2] == 15
    assert dc.TOTAL_WEIGHT == 295 == sum(w for *_r, w in dc.PRIORITIZATION_DIMENSIONS)


def test_score_one_gives_a_fifth_of_the_weight_and_five_the_whole_weight():
    from services.priority_scoring import compute_priority_score, dimension_points

    pts1 = dimension_points([1] * 13)
    pts5 = dimension_points([5] * 13)
    assert pts1["three_year_volume"]["points"] == 5.0
    assert pts5["three_year_volume"]["points"] == 25.0
    assert pts1["capex_investment"]["points"] == 3.0
    assert pts5["capex_investment"]["points"] == 15.0
    assert compute_priority_score([5] * 13) == (295.0, 100, "P1")
    assert compute_priority_score([1] * 13) == (59.0, 20, "P4")
    # scaled points of an all-5 row sum to ~100
    total = sum(v["scaled_points"] for v in pts5.values())
    assert abs(total - 100) < 0.1


def test_scaled_weights_are_served_two_decimals():
    from services.priority_scoring import dimension_table

    table = {d["key"]: d for d in dimension_table()}
    assert table["strategic_project"]["scaled_weight"] == 8.47  # 25 * 100 / 295
    assert table["three_year_volume"]["scaled_weight"] == 8.47
    assert table["capex_investment"]["scaled_weight"] == 5.08  # 15 * 100 / 295


# --- recompute migration + endpoint shapes (ADR 0029) ----------------------


def test_rescore_migration_formula_matches_service():
    """The frozen weights in the p16a data migration equal the live table, and
    its band/pct arithmetic agrees with `compute_priority_score`."""
    import importlib.util
    from pathlib import Path

    from services.priority_scoring import compute_priority_score

    path = Path(__file__).resolve().parent.parent / "alembic/versions/p16a_rescore_adr0029.py"
    spec = importlib.util.spec_from_file_location("p16a", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert [(c, w) for c, w in mod._WEIGHTS] == [
        (k, w) for _p, _l, k, w in dc.PRIORITIZATION_DIMENSIONS
    ]
    for dims in (DIMS_ALL_1, DIMS_ALL_3, DIMS_EXACTLY_70, DIMS_JUST_BELOW_55):
        raw = sum(s * w / 5 for s, (_c, w) in zip(dims, mod._WEIGHTS, strict=True))
        pct = round(raw / mod._TOTAL * 100)
        assert (float(raw), pct, mod._band(pct)) == compute_priority_score(dims)

