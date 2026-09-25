"""P2-T09 port of `backend/scheduling/_selftest.py` (P2-T01, greedy SGS).

Each `scenario_*` function in that script is driven here as an individual,
parametrized pytest case via the `drive_selftest` fixture. The scenario bodies
themselves live in the `_selftest` module (still runnable as
`python -m scheduling._selftest`); this file is the CI-enforced pytest view of
them, contributing `backend/scheduling/greedy.py` coverage toward the P2-T09
>=85% gate.

The golden-file suite in `test_golden_files.py` covers the same named
DOMAIN_RULES.md rules with hand-written `assert` statements; this driver keeps
the P2-T01 scenarios (including the determinism / OEM / excluded-status
variants) wired in as well so no assertion coverage is lost when comparing the
two.
"""

from __future__ import annotations

import pytest

from scheduling import _selftest as st

SCENARIOS = [
    st.scenario_normal_case,
    st.scenario_single_engineer_contention,
    st.scenario_chamber_saturation,
    st.scenario_frozen_conflict,
    st.scenario_left_out_at_horizon,
    st.scenario_category_mismatch,
    st.scenario_oem_hub_requires_oem_allowed_category,
    st.scenario_spillover_boundary,
    st.scenario_delay_is_terminal_not_propagated,
    st.scenario_excluded_statuses,
    st.scenario_determinism,
]


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda f: f.__name__)
def test_greedy_selftest_scenario(scenario, drive_selftest):
    drive_selftest(st, scenario)
