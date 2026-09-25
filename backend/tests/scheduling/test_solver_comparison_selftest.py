"""P2-T09 port of `backend/scheduling/_selftest_solver_comparison.py`
(P2-T07, greedy-vs-CP-SAT comparison harness).

Drives: the solvers-agree case, the divergence classifier bucket assignments
(including the negative test that a leader-mismatch / frozen divergence is
flagged UNEXPLAINED), the full real 46-project dataset comparison (CLEAN,
zero invariant violations either side, zero unexplained divergences), and the
determinism check.

`backend/scheduling/solver_comparison.py` had zero pytest-measured coverage
before this (flagged in the P2-T07 review entry).
"""

from __future__ import annotations

import pytest

from scheduling import _selftest_solver_comparison as st

SCENARIOS = [
    st.scenario_solvers_agree,
    st.scenario_classifier_buckets,
    st.real_seed_dataset,
    st.determinism,
]


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda f: f.__name__)
def test_solver_comparison_selftest_scenario(scenario, drive_selftest):
    drive_selftest(st, scenario)
