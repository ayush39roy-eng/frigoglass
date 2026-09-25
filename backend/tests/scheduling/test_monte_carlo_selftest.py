"""P2-T09 port of `backend/scheduling/_selftest_monte_carlo.py`
(P2-T08, Monte Carlo P50/P80 delivery forecast).

Drives: `_nearest_rank` hand examples, forecaster determinism (I8 extended:
same seed -> equal `DeliveryForecast`; independent of project input order),
that both perturbation dimensions are actually wired, the `iterations=1` +
no-perturbation cross-check against a direct `run_greedy_sgs` call, the
forecast's structural invariants, and the real 46-project headline run.

`backend/scheduling/monte_carlo.py` had zero pytest-measured coverage before
this (flagged in the P2-T08 review entry). Uses the greedy inner solver
(default) so the run stays fast and exactly deterministic.
"""

from __future__ import annotations

import pytest

from scheduling import _selftest_monte_carlo as st

SCENARIOS = [
    st.percentile_method,
    st.determinism,
    st.perturbation_wired,
    st.matches_unperturbed_greedy,
    st.forecast_structure,
    st.real_seed_headline,
]


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda f: f.__name__)
def test_monte_carlo_selftest_scenario(scenario, drive_selftest):
    drive_selftest(st, scenario)
