"""P2-T09 port of `backend/scheduling/_selftest_invariants.py` (P2-T04, I1-I10).

Direction 1 (zero violations on accepted-correct scheduler output, including
the full 14-step multi-hub scenario and the real 46-project seed dataset) and
Direction 2 (each invariant's hand-crafted broken `ScheduleOutput` is caught)
are each driven here as parametrized pytest cases.

`test_invariants_negative.py` already covers the I1-I10 broken-output cases
with hand-written `assert` statements; this driver additionally exercises the
Direction-1 positive paths (which drive most of the reconciliation / load-
aggregation branches of `backend/scheduling/invariants.py`) toward the P2-T09
>=85% coverage gate.
"""

from __future__ import annotations

import pytest

from scheduling import _selftest_invariants as st

DIRECTION1 = [
    st.direction1_normal_case,
    st.direction1_single_engineer_contention,
    st.direction1_chamber_saturation,
    st.direction1_frozen_conflict,
    st.direction1_frozen_chamber_overlap,
    st.direction1_left_out_at_horizon,
    st.direction1_category_mismatch_and_oem,
    st.direction1_spillover_boundary_and_delay,
    st.direction1_excluded_statuses,
    st.direction1_full_14_step_multi_hub,
    st.direction1_real_seed_dataset,
]

DIRECTION2 = [
    st.direction2_i1_engineer_double_booked_non_frozen,
    st.direction2_i2_chamber_over_capacity_no_frozen,
    st.direction2_i3_steps_overlap_within_project,
    st.direction2_i4_wrong_lab_region_and_stage,
    st.direction2_i5_incomplete_not_flagged_left_out,
    st.direction2_i6_negative_design_duration,
    st.direction2_i7_negative_lab_duration,
    st.direction2_i8_nondeterministic_input_rejected,
    st.direction2_i9_within_year_flag_wrong,
    st.direction2_i10_frozen_dates_mutated,
]


@pytest.mark.parametrize("scenario", DIRECTION1, ids=lambda f: f.__name__)
def test_invariants_direction1_zero_violations(scenario, drive_selftest):
    drive_selftest(st, scenario)


@pytest.mark.parametrize("scenario", DIRECTION2, ids=lambda f: f.__name__)
def test_invariants_direction2_broken_output_caught(scenario, drive_selftest):
    drive_selftest(st, scenario)
