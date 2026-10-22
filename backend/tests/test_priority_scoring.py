"""Scenario #7 — the `PriorityScore` weighted-score / normalized-pct / band
formula matches `docs/DOMAIN_RULES.md`'s documented thresholds (>=70 P1,
>=55 P2, >=40 P3, else P4), including a boundary case at each threshold.

ADR 0037 (P26-T01): the one implementation is
`services.priority_scoring.compute_score(rubric, scores)`, used by the API,
scenario apply and the seed (`seed.initial_scoring_rubric`). These goldens run
it on the initial rubric (the 13 dimensions of ADR 0029, total 295) against an
independent oracle with literal weights.
"""

from __future__ import annotations

import pytest

import domain_constants as dc
from models.enums import ProjectPriority
from seed.initial_scoring_rubric import INITIAL_SCORING_DIMENSIONS, initial_rubric
from services.priority_scoring import compute_score, dimension_points, dimension_table
from tests.factories import make_hub, make_priority_score, make_project
from tests.rubric_helpers import INITIAL_KEYS, score_of

# Positional order of the initial rubric (ADR 0029 weights):
#   strategic_project(25), new_customer(25), new_options(25),
#   regulatory_compliance(25), quality_improvements(25), rm_savings(25),
#   total_rm_savings(25), gross_margins(25, "Gross Profitability"),
#   profitability(25, "ROI"), annual_volume(15), three_year_volume(25),
#   new_models(15), capex_investment(15)
# TOTAL_WEIGHT = 295. points = score / 5 * weight; max raw = TOTAL_WEIGHT.
_ORACLE_WEIGHTS = (25, 25, 25, 25, 25, 25, 25, 25, 25, 15, 25, 15, 15)

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
    from literal weights rather than by calling the function under test, so
    this would catch a formula bug in either the seeded weights or the
    banding thresholds.
    """
    weighted = sum(score / 5 * weight for score, weight in zip(dims, _ORACLE_WEIGHTS, strict=True))
    pct = round(weighted / sum(_ORACLE_WEIGHTS) * 100)
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
    weighted, pct, band = score_of(dims)
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
    """End-to-end: compute via the real scoring function, persist through
    the actual `PriorityScore` model and its `priority_dimension_scores`
    rows (CHECK 0..5), and read the band back via the ORM.
    """
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    weighted, pct, band = score_of(dims)
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


# --- ADR 0029 goldens: the initial rubric, weights, scaled figures -------


def test_initial_rubric_matches_adr_0029():
    rubric = initial_rubric()
    by_key = {d.key: (d.label, d.pillar, d.weight) for d in rubric.dimensions}
    assert list(INITIAL_KEYS) == [
        "strategic_project", "new_customer", "new_options", "regulatory_compliance",
        "quality_improvements", "rm_savings", "total_rm_savings", "gross_margins",
        "profitability", "annual_volume", "three_year_volume", "new_models",
        "capex_investment",
    ]  # fmt: skip
    assert by_key["gross_margins"] == ("Gross Profitability", "Financial Return", 25)
    assert by_key["profitability"] == ("ROI", "Investment & Feasibility", 25)
    assert by_key["three_year_volume"][2] == 25
    assert by_key["capex_investment"][2] == 15
    assert [d.inverted for d in rubric.dimensions] == [False] * 12 + [True]
    assert rubric.total_weight == 295 == sum(_ORACLE_WEIGHTS)
    assert [d[3] for d in INITIAL_SCORING_DIMENSIONS] == list(_ORACLE_WEIGHTS)


def test_score_one_gives_a_fifth_of_the_weight_and_five_the_whole_weight():
    rubric = initial_rubric()
    pts1 = dimension_points(rubric, dict.fromkeys(INITIAL_KEYS, 1))
    pts5 = dimension_points(rubric, dict.fromkeys(INITIAL_KEYS, 5))
    assert pts1["three_year_volume"]["points"] == 5.0
    assert pts5["three_year_volume"]["points"] == 25.0
    assert pts1["capex_investment"]["points"] == 3.0
    assert pts5["capex_investment"]["points"] == 15.0
    assert score_of([5] * 13) == (295.0, 100, "P1")
    assert score_of([1] * 13) == (59.0, 20, "P4")
    # scaled points of an all-5 row sum to ~100
    total = sum(v["scaled_points"] for v in pts5.values())
    assert abs(total - 100) < 0.1


def test_scaled_weights_are_served_two_decimals():
    table = {d["key"]: d for d in dimension_table(initial_rubric())}
    assert table["strategic_project"]["scaled_weight"] == 8.47  # 25 * 100 / 295
    assert table["three_year_volume"]["scaled_weight"] == 8.47
    assert table["capex_investment"]["scaled_weight"] == 5.08  # 15 * 100 / 295


def test_half_up_rounding_is_exact():
    """ADR 0037: exact rational arithmetic, half up (no float noise, no
    banker's rounding). Weight 1 of 8 at score 5 is exactly 12.5 -> 13;
    weight 3 of 8 at 5 is 37.5 -> 38 (Python round() would give 12 and 38)."""

    import uuid

    from services.priority_scoring import Rubric, RubricDimension

    def rubric(weights):
        return Rubric(
            version=1,
            dimensions=tuple(
                RubricDimension(uuid.uuid4(), f"k{i}", f"L{i}", "P", w, False, True, i + 1)
                for i, w in enumerate(weights)
            ),
        )

    r = rubric([1, 7])
    assert compute_score(r, {"k0": 5, "k1": 0}).normalized_pct == 13  # 12.5 -> 13
    r = rubric([3, 5])
    assert compute_score(r, {"k0": 5, "k1": 0}).normalized_pct == 38  # 37.5 -> 38
    r = rubric([7])
    res = compute_score(r, {"k0": 3})  # 4.2 of 7 = 60
    assert (float(res.weighted_score), res.normalized_pct, res.band) == (4.2, 60, "P2")


# --- migration formula agrees with the service ------------------------------


def test_rescore_migrations_formula_matches_service():
    """The frozen weights of the p16a and p26a data migrations equal the
    initial rubric, and their band/pct arithmetic agrees with `compute_score`."""
    import importlib.util
    from pathlib import Path

    def load(name):
        path = Path(__file__).resolve().parent.parent / f"alembic/versions/{name}.py"
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    p16a = load("p16a_rescore_adr0029")
    p26a = load("p26a_scoring_rubric_tables")
    expected = [(d[0], d[3]) for d in INITIAL_SCORING_DIMENSIONS]
    assert list(p16a._WEIGHTS) == expected
    assert [(d[0], d[3]) for d in p26a._DIMENSIONS] == expected
    assert list(p26a._DIMENSIONS) == list(INITIAL_SCORING_DIMENSIONS)
    for dims in (DIMS_ALL_1, DIMS_ALL_3, DIMS_EXACTLY_70, DIMS_JUST_BELOW_55):
        raw = sum(s * w / 5 for s, (_c, w) in zip(dims, p16a._WEIGHTS, strict=True))
        pct = round(raw / p16a._TOTAL * 100)
        assert (float(raw), pct, p16a._band(pct)) == score_of(dims)
        raw26, pct26, band26 = p26a._score(dims)
        assert (float(raw26), pct26, band26) == score_of(dims)
