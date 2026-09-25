"""P2-T09 port of `backend/scheduling/_selftest_cp_sat.py` (P2-T06, CP-SAT model).

Drives every hand-traced scenario, the two highest-risk frozen-vs-frozen
conflict scenarios, and the full real 46-project seed-dataset solve (bounded
`max_time_in_seconds`, zero `validate_invariants` violations, byte-identical
single-threaded re-run) as parametrized pytest cases.

`backend/scheduling/cp_sat.py` had zero pytest-measured coverage before this
(flagged in the P2-T06 review entry); this module is what brings it over the
P2-T09 >=85% gate. CP-SAT runs single-threaded with a fixed seed inside
`run_cp_sat`, so these are deterministic.
"""

from __future__ import annotations

import pytest

from scheduling import _selftest_cp_sat as st

HAND_TRACED = [
    st.scenario_normal_case,
    st.scenario_single_engineer_contention,
    st.scenario_chamber_saturation,
    st.scenario_left_out_at_horizon,
    st.scenario_category_mismatch,
    st.scenario_oem_hub_requires_oem_allowed_category,
    st.scenario_spillover_boundary,
    st.scenario_delay_is_terminal_not_propagated,
    st.scenario_excluded_statuses,
    st.scenario_no_leader,
    st.scenario_no_eligible_chamber,
]

FROZEN_CONFLICT = [
    st.scenario_two_frozen_projects_engineer_conflict,
    st.scenario_two_frozen_projects_chamber_overlap,
]


@pytest.mark.parametrize("scenario", HAND_TRACED, ids=lambda f: f.__name__)
def test_cp_sat_hand_traced_scenario(scenario, drive_selftest):
    drive_selftest(st, scenario)


@pytest.mark.parametrize("scenario", FROZEN_CONFLICT, ids=lambda f: f.__name__)
def test_cp_sat_frozen_conflict_stays_feasible(scenario, drive_selftest):
    drive_selftest(st, scenario)


def test_cp_sat_real_seed_dataset(drive_selftest):
    drive_selftest(st, st.real_seed_dataset)
