"""Scenario #6 — `domain_constants.duration_weeks()` matches
`docs/DOMAIN_RULES.md`'s formula (`max(1, round(base_weeks * multiplier))`)
across all four categories (A+/A/B/C), including cases where Python's
round-half-to-even ("banker's rounding") behaviour matters.

Pure-function tests, no DB required — fast, deterministic.
"""

from __future__ import annotations

import pytest

import domain_constants as dc


@pytest.mark.parametrize(
    ("base_weeks", "category", "expected"),
    [
        # A+ (multiplier 1.0): always base_weeks unchanged (min 1).
        (1, "A+", 1),
        (2, "A+", 2),
        (4, "A+", 4),
        # A (multiplier 0.8): ordinary rounding, no ties.
        (1, "A", 1),  # round(0.8) = 1
        (2, "A", 2),  # round(1.6) = 2
        (3, "A", 2),  # round(2.4) = 2
        (4, "A", 3),  # round(3.2) = 3
        # B (multiplier 0.5): exact .5 ties — this is where Python's
        # round-half-to-even matters and a naive round-half-up implementation
        # would disagree.
        (1, "B", 1),  # round(0.5) == 0 (rounds to even) -> max(1, 0) = 1
        (2, "B", 1),  # round(1.0) = 1
        (3, "B", 2),  # round(1.5) == 2 (rounds to even, 2 is even)
        (4, "B", 2),  # round(2.0) = 2
        # C (multiplier 0.25): further ties/near-ties.
        (1, "C", 1),  # round(0.25) = 0 -> max(1, 0) = 1
        (2, "C", 1),  # round(0.5) == 0 (rounds to even) -> max(1, 0) = 1
        (3, "C", 1),  # round(0.75) = 1
        (4, "C", 1),  # round(1.0) = 1
    ],
)
def test_duration_weeks_matches_domain_rules_formula(base_weeks, category, expected):
    assert dc.duration_weeks(base_weeks, category) == expected


def test_duration_weeks_never_returns_less_than_one():
    for base_weeks in range(1, 5):
        for category in ("A+", "A", "B", "C"):
            assert dc.duration_weeks(base_weeks, category) >= 1


def test_duration_weeks_explicit_round_half_to_even_boundary():
    """The two clearest round()-matters cases, spelled out explicitly (not
    just parametrized) so a reviewer sees the exact tie behaviour being
    asserted: 0.5 rounds down to 0 (then floored to 1 by max()), 1.5 rounds
    up to 2 — both because Python's built-in `round()` rounds half-to-even,
    not half-away-from-zero.
    """
    assert round(0.5) == 0
    assert round(1.5) == 2
    assert dc.duration_weeks(1, "B") == max(1, round(1 * 0.5)) == 1
    assert dc.duration_weeks(3, "B") == max(1, round(3 * 0.5)) == 2


def test_duration_weeks_matches_formula_for_every_real_workflow_step_and_category():
    """Cross-checks every one of the 14 real `WORKFLOW_STEP_TEMPLATE_SEED`
    base_weeks values (not just synthetic 1-4 examples above) against every
    category, independently recomputing the expected value from
    `CATEGORY_MULTIPLIERS` rather than calling `duration_weeks()` to generate
    its own expectation (that would just be testing tautologically).
    """
    for _step_id, _name, _kind, base_weeks, _seq in dc.WORKFLOW_STEP_TEMPLATE_SEED:
        for category, multiplier in dc.CATEGORY_MULTIPLIERS.items():
            expected = max(1, round(base_weeks * multiplier))
            assert dc.duration_weeks(base_weeks, category) == expected
