"""P12-T01 golden files — Gantt drag step timing (ADR 0019, DOMAIN_RULES "Step
timing from the Gantt", I21 / I22).

Every expected week below is hand-derived from `docs/DOMAIN_RULES.md`
(CURRENT_WEEK = 31, HORIZON_WEEKS = 78) with the default seeded strict chain
and the default lead-time table. The base project is PDD / B:

    step:  A B C D E F G H I J K L M N
    lead:  1 0 0 1 4 0 0 6 0 1 2 1 1 1   (Σ 18)
    kind:  d d e d d l e l d d d e d e   (d design, l lab, e elapsed)

so with no timing it books A 31, D 32, E 33-36, H 37-42, J 43, K 44-45,
L 46, M 47, N 48 (skipped B/C/F/G/I transparent).

Every greedy test asserts the documented outcome AND
`validate_invariants == ()` (I1-I22, including the new I21 / I22).
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from scheduling import (
    ChamberInput,
    EngineerInput,
    InvariantViolation,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
    StepTimingInput,
    canonical_step_timing,
    compute_design_load_by_hub,
    compute_lab_load_by_hub,
    forecast_delivery,
    run_cp_sat,
    run_greedy_sgs,
    validate_invariants,
)
from scheduling.monte_carlo import _perturbed_step_timing
from tests.scheduling._fixtures import progress

ENG_A = EngineerInput("eng-a", "A", "R&D-Greece", ("A+", "A", "B", "C"))
CH_GR = ChamberInput("ch-gr", "GR", "Greece", max_concurrent=1, allowed_stages=("PDD-F", "PDD-H"))

BASELINE = {
    "PDD-A": (31, 31, False),
    "PDD-B": (31, 31, True),
    "PDD-C": (31, 31, True),
    "PDD-D": (32, 32, False),
    "PDD-E": (33, 36, False),
    "PDD-F": (36, 36, True),
    "PDD-G": (36, 36, True),
    "PDD-H": (37, 42, False),
    "PDD-I": (42, 42, True),
    "PDD-J": (43, 43, False),
    "PDD-K": (44, 45, False),
    "PDD-L": (46, 46, False),
    "PDD-M": (47, 47, False),
    "PDD-N": (48, 48, False),
}

DONE_A_D = (
    progress("PDD-A", "Done", percent_complete=100, actual_start_week=25, actual_end_week=25),
    progress("PDD-D", "Done", percent_complete=100, actual_start_week=26, actual_end_week=26),
)


def _t(step_id: str, duration: int | None = None, not_before: int | None = None) -> StepTimingInput:
    return StepTimingInput(
        step_id=step_id, duration_override_weeks=duration, start_not_before_week=not_before
    )


def _project(pid: str = "p", **kw: object) -> ProjectInput:
    base: dict[str, object] = dict(
        project_id=pid,
        name=pid,
        hub="R&D-Greece",
        status="In Development",
        category="B",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    base.update(kw)
    return ProjectInput(**base)  # type: ignore[arg-type]


def _si(*projects: ProjectInput, **kw: object) -> ScheduleInput:
    base: dict[str, object] = dict(projects=projects, engineers=(ENG_A,), chambers=(CH_GR,))
    base.update(kw)
    return ScheduleInput(**base)  # type: ignore[arg-type]


def _run(si: ScheduleInput) -> tuple[ScheduleOutput, dict[str, ProjectScheduleOutcome]]:
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    return out, {o.project_id: o for o in out.project_outcomes}


def _weeks(outcome: ProjectScheduleOutcome) -> dict[str, tuple[int, int, bool]]:
    return {s.step_id: (s.start_week, s.end_week, s.skipped) for s in outcome.steps}


def _step(outcome: ProjectScheduleOutcome, step_id: str) -> StepSchedule:
    return next(s for s in outcome.steps if s.step_id == step_id)


def _with(outcome: ProjectScheduleOutcome, step_id: str, **kw: int) -> ProjectScheduleOutcome:
    return replace(
        outcome,
        steps=tuple(
            replace(s, **kw) if s.step_id == step_id else s  # type: ignore[arg-type]
            for s in outcome.steps
        ),
    )


def _broken(out: ScheduleOutput, pid: str, step_id: str, **kw: int) -> ScheduleOutput:
    return replace(
        out,
        project_outcomes=tuple(
            _with(o, step_id, **kw) if o.project_id == pid else o for o in out.project_outcomes
        ),
    )


def _ids(violations: tuple[InvariantViolation, ...]) -> set[str]:
    return {v.invariant for v in violations}


# --- Baseline: the default `()` is the pre-P12 input ---------------------------


def test_no_timing_is_the_unchanged_baseline() -> None:
    _, by = _run(_si(_project()))
    assert _weeks(by["p"]) == BASELINE
    assert by["p"].end_week == 48 and by["p"].unconstrained_end_week == 48


def test_rows_with_no_field_set_change_nothing() -> None:
    plain, _ = _run(_si(_project()))
    empty_rows, _ = _run(_si(_project(step_timing=(_t("PDD-E"), _t("PDD-H")))))
    assert repr(empty_rows) == repr(plain)


# --- Effective duration ---------------------------------------------------------


def test_override_longer_than_lead_time() -> None:
    _, by = _run(_si(_project(step_timing=(_t("PDD-E", 7),))))
    o = by["p"]
    w = _weeks(o)
    assert w["PDD-E"] == (33, 39, False)
    assert _step(o, "PDD-E").duration_weeks == 7  # effective, not the table's 4
    assert w["PDD-H"] == (40, 45, False)  # successors move with it
    assert o.end_week == 51
    assert o.unconstrained_end_week == 51 and o.expected_end_week == 51
    assert o.projected_end_week == 51 and o.within_year


def test_override_shorter_than_lead_time() -> None:
    _, by = _run(_si(_project(step_timing=(_t("PDD-E", 1), _t("PDD-H", 2)))))
    o = by["p"]
    w = _weeks(o)
    assert w["PDD-E"] == (33, 33, False)
    assert w["PDD-H"] == (34, 35, False)
    assert _step(o, "PDD-H").duration_weeks == 2
    assert w["PDD-N"] == (41, 41, False)
    assert o.end_week == 41 and o.unconstrained_end_week == 41


def test_override_on_elapsed_step() -> None:
    _, by = _run(_si(_project(step_timing=(_t("PDD-L", 5),))))
    o = by["p"]
    assert _weeks(o)["PDD-L"] == (46, 50, False)
    assert _step(o, "PDD-L").duration_weeks == 5
    assert o.end_week == 52


def test_skipped_step_with_override_stays_skipped() -> None:
    """Lead time 0 (PDD-B/C/F/G/I for category B) never revives under an override."""

    plain, _ = _run(_si(_project()))
    out, by = _run(_si(_project(step_timing=(_t("PDD-B", 5), _t("PDD-F", 3, 40)))))
    w = _weeks(by["p"])
    assert w["PDD-B"] == (31, 31, True) and w["PDD-F"] == (36, 36, True)
    assert _step(by["p"], "PDD-B").duration_weeks == 0
    assert w == BASELINE
    assert [o.steps for o in out.project_outcomes] == [o.steps for o in plain.project_outcomes]


def test_lab_step_skipped_by_certification_flag_stays_skipped_with_override() -> None:
    _, by = _run(_si(_project(certification_testing_required=False, step_timing=(_t("PDD-H", 3),))))
    o = by["p"]
    assert _weeks(o)["PDD-H"] == (36, 36, True)
    assert _step(o, "PDD-H").duration_weeks == 0
    assert o.end_week == 42  # 48 minus the 6-week lab step


# --- Earliest start -------------------------------------------------------------


def test_floor_later_than_precedence_moves_the_step() -> None:
    _, by = _run(_si(_project(step_timing=(_t("PDD-H", not_before=45),))))
    o = by["p"]
    w = _weeks(o)
    assert w["PDD-E"] == (33, 36, False)  # predecessors untouched
    assert w["PDD-H"] == (45, 50, False)  # I22: starts at the floor, not at 37
    assert w["PDD-J"] == (51, 51, False)
    assert o.end_week == 56 and not o.within_year and o.spillover
    # The floor is a plan input, so the unconstrained finish honours it too.
    assert o.unconstrained_end_week == 56


def test_floor_earlier_than_precedence_has_no_effect() -> None:
    plain, _ = _run(_si(_project()))
    out, by = _run(_si(_project(step_timing=(_t("PDD-H", not_before=32), _t("PDD-A", None, 1)))))
    assert _weeks(by["p"]) == BASELINE
    assert [o.steps for o in out.project_outcomes] == [o.steps for o in plain.project_outcomes]
    assert by["p"].unconstrained_end_week == 48


def test_floor_on_first_step() -> None:
    _, by = _run(_si(_project(step_timing=(_t("PDD-A", not_before=40),))))
    o = by["p"]
    assert _weeks(o)["PDD-A"] == (40, 40, False)
    assert o.start_week == 40 and o.end_week == 57


def test_floor_and_override_on_the_same_step() -> None:
    _, by = _run(_si(_project(step_timing=(_t("PDD-E", 2, 40),))))
    w = _weeks(by["p"])
    assert w["PDD-E"] == (40, 41, False)
    assert w["PDD-H"] == (42, 47, False)


def test_floor_waits_for_capacity_never_lands_earlier() -> None:
    """A floor is a lower bound only: capacity can still push the bar later."""

    blocker = _project("p-1", step_timing=(_t("PDD-E", 10),))  # leader busy 33-42 on E
    moved = _project("p-2", priority="P2", step_timing=(_t("PDD-A", not_before=35),))
    _, by = _run(_si(blocker, moved))
    # p-1 holds eng-a on A 31, D 32, E 33-42, J 49, K 50-51, M 53.
    a = _step(by["p-2"], "PDD-A")
    assert a.start_week >= 35
    assert a.start_week == 43  # leader free from week 43
    assert _weeks(by["p-1"])["PDD-E"] == (33, 42, False)


def test_floor_beyond_reach_leaves_project_out() -> None:
    _, by = _run(_si(_project(step_timing=(_t("PDD-H", not_before=75),))))
    o = by["p"]
    assert o.left_out and not o.within_year
    assert o.projected_end_week is None


# --- In Progress / Blocked / Done ----------------------------------------------


def test_in_progress_resize_tail_uses_effective_duration() -> None:
    p = _project(
        step_progress=DONE_A_D
        + (progress("PDD-E", "In Progress", percent_complete=50, actual_start_week=28),),
        step_timing=(_t("PDD-E", 8, not_before=40),),  # floor ignored for In Progress
    )
    _, by = _run(_si(p))
    o = by["p"]
    w = _weeks(o)
    # remaining = ceil(8 * (1 - 0.5)) = 4 -> tail 31..34 (was 2 weeks with the table's 4)
    assert w["PDD-E"] == (28, 34, False)
    assert _step(o, "PDD-E").duration_weeks == 8
    assert w["PDD-H"] == (35, 40, False)
    assert o.end_week == 46 and o.unconstrained_end_week == 46
    # I12: weights use the effective duration: (100*1 + 100*1 + 50*8) / (1+1+8+6+1+2+1+1+1)
    assert o.progress_pct == round(600 / 22) == 27


def test_in_progress_remaining_override_still_wins() -> None:
    p = _project(
        step_progress=DONE_A_D
        + (
            progress(
                "PDD-E",
                "In Progress",
                percent_complete=50,
                actual_start_week=28,
                remaining_weeks_override=3,
            ),
        ),
        step_timing=(_t("PDD-E", 8),),
    )
    _, by = _run(_si(p))
    assert _weeks(by["p"])["PDD-E"] == (28, 33, False)


def test_done_step_ignores_timing() -> None:
    p = _project(step_progress=DONE_A_D, step_timing=(_t("PDD-A", 5, 60),))
    _, by = _run(_si(p))
    assert _weeks(by["p"])["PDD-A"] == (25, 25, False)  # I11: history never moves


def test_blocked_hold_with_floor_on_held_successor() -> None:
    p = _project(
        step_progress=DONE_A_D
        + (progress("PDD-E", "Blocked", percent_complete=50, actual_start_week=28),),
        step_timing=(_t("PDD-H", not_before=60), _t("PDD-E", 6)),
    )
    _, by = _run(_si(p))
    o = by["p"]
    assert o.blocked and o.projected_end_week is None
    assert _weeks(o)["PDD-H"] == (30, 30, False)  # held: not placed, I22 exempt
    # Unconstrained walk: E tail ceil(6*0.5)=3 -> 31..33, H floored at 60 -> 60..65, N 71.
    assert o.unconstrained_end_week == 71


def test_floor_on_not_started_step_of_progress_tracked_project() -> None:
    p = _project(step_progress=DONE_A_D, step_timing=(_t("PDD-E", not_before=38),))
    _, by = _run(_si(p))
    assert _weeks(by["p"])["PDD-E"] == (38, 41, False)


# --- Frozen ---------------------------------------------------------------------


def test_frozen_project_uses_override_but_ignores_floor() -> None:
    p = _project(
        frozen=True, actual_start_week=31, step_timing=(_t("PDD-E", 7), _t("PDD-H", None, 60))
    )
    _, by = _run(_si(p))
    w = _weeks(by["p"])
    assert w["PDD-E"] == (33, 39, False)  # effective duration, so the locked layout keeps it
    assert w["PDD-H"] == (40, 45, False)  # floor 60 ignored: frozen wins (I10)


# --- Capacity -------------------------------------------------------------------


def test_capacity_consumption_reflects_effective_duration() -> None:
    first = _project("p-1", step_timing=(_t("PDD-E", 10), _t("PDD-H", 2)))
    second = _project("p-2", priority="P2")
    si = _si(first, second)
    out, by = _run(si)
    w1 = _weeks(by["p-1"])
    assert w1["PDD-E"] == (33, 42, False)
    assert w1["PDD-H"] == (43, 44, False)
    # p-2 needs eng-a; it is busy on A 31, D 32, E 33-42 (10 weeks, not 4).
    w2 = _weeks(by["p-2"])
    assert w2["PDD-A"] == (43, 43, False)
    # I6 / I7 load is the effective duration: design 1+1+10+1+2+1 + 10, lab 2 + 6.
    assert compute_design_load_by_hub(si, out) == {"R&D-Greece": 16 + 10}
    assert compute_lab_load_by_hub(si, out) == {"R&D-Greece": 2.0 + 6.0}


def test_chamber_freed_by_shorter_lab_override() -> None:
    first = _project("p-1", step_timing=(_t("PDD-H", 1),))
    second = _project("p-2", priority="P2", leader_engineer_id="eng-b")
    eng_b = EngineerInput("eng-b", "B", "R&D-Greece", ("A+", "A", "B", "C"))
    _, by = _run(_si(first, second, engineers=(ENG_A, eng_b)))
    assert _weeks(by["p-1"])["PDD-H"] == (37, 37, False)
    assert _weeks(by["p-2"])["PDD-H"] == (38, 43, False)  # single platform free from 38


# --- Validation (ValueError) ----------------------------------------------------


@pytest.mark.parametrize(
    ("rows", "fragment"),
    [
        ((_t("OEM-A", 2),), "not a step of workflow 'PDD'"),
        ((_t("PDD-Z", 2),), "not a step of workflow"),
        # ADR 0041 R4: the solver input's merged duration is 0..104 (0 = skipped,
        # R5), so 0 is valid now (tests/scheduling/test_p30_effort.py) and -1 is not.
        ((_t("PDD-E", -1),), "outside 0..104"),
        ((_t("PDD-E", 105),), "outside 0..104"),
        ((_t("PDD-E", None, 0),), "outside 1..78"),
        ((_t("PDD-E", None, 79),), "outside 1..78"),
        ((_t("PDD-E", 2), _t("PDD-E", None, 40)), "more than once"),
    ],
)
def test_invalid_step_timing_rejected(rows: tuple[StepTimingInput, ...], fragment: str) -> None:
    si = _si(_project(step_timing=rows))
    with pytest.raises(ValueError, match=fragment):
        run_greedy_sgs(si)
    with pytest.raises(ValueError, match=fragment):
        run_cp_sat(si)


def test_validation_bounds_are_inclusive() -> None:
    _run(_si(_project(step_timing=(_t("PDD-E", 104),))))
    _run(_si(_project(step_timing=(_t("PDD-E", 1, 78),))))
    # The floor domain follows the run's horizon.
    with pytest.raises(ValueError, match="outside 1..60"):
        run_greedy_sgs(_si(_project(step_timing=(_t("PDD-E", None, 61),)), horizon_weeks=60))


def test_excluded_project_timing_not_validated() -> None:
    _run(_si(_project("p-hold", status="On Hold", step_timing=(_t("PDD-Z", 999),))))


# --- Determinism (I8) -----------------------------------------------------------


def test_timing_order_does_not_affect_output() -> None:
    rows = (_t("PDD-H", 3, 44), _t("PDD-E", 2), _t("PDD-K", None, 50))
    a = run_greedy_sgs(_si(_project(step_timing=rows)))
    b = run_greedy_sgs(_si(_project(step_timing=tuple(reversed(rows)))))
    assert repr(a) == repr(b)
    assert run_greedy_sgs(_si(_project())) != a


def test_canonical_step_timing() -> None:
    rows = [_t("PDD-K", None, 50), _t("PDD-E"), _t("PDD-E2", 2), _t("PDD-A", 3)]
    assert canonical_step_timing(rows) == (_t("PDD-A", 3), _t("PDD-E2", 2), _t("PDD-K", None, 50))
    assert canonical_step_timing([_t("PDD-E"), _t("PDD-H")]) == ()
    assert canonical_step_timing(()) == ()


# --- CP-SAT agrees with greedy --------------------------------------------------


def test_cp_sat_agrees_with_greedy_on_a_small_case() -> None:
    p = _project(step_timing=(_t("PDD-E", 7), _t("PDD-H", 3, 44), _t("PDD-B", 5)))
    si = _si(p)
    greedy, _ = _run(si)
    cp, info = run_cp_sat(si)
    assert info.status_name == "OPTIMAL"
    assert validate_invariants(si, cp, check_determinism=False) == ()
    g = greedy.project_outcomes[0]
    c = cp.project_outcomes[0]
    assert c.steps == g.steps
    assert _weeks(c)["PDD-E"] == (33, 39, False)
    assert _weeks(c)["PDD-H"] == (44, 46, False)
    assert (c.end_week, c.unconstrained_end_week, c.within_year) == (
        g.end_week,
        g.unconstrained_end_week,
        g.within_year,
    )


def test_cp_sat_honours_floor_and_override_with_contention() -> None:
    first = _project("p-1", step_timing=(_t("PDD-E", 6),))
    second = _project("p-2", priority="P2", step_timing=(_t("PDD-A", not_before=50),))
    si = _si(first, second)
    cp, _ = run_cp_sat(si)
    assert validate_invariants(si, cp, check_determinism=False) == ()
    by = {o.project_id: o for o in cp.project_outcomes}
    assert _step(by["p-1"], "PDD-E").duration_weeks == 6
    assert _step(by["p-2"], "PDD-A").start_week >= 50


# --- I21 / I22 negative paths ----------------------------------------------------


def test_i21_detects_span_not_equal_to_effective_duration() -> None:
    si = _si(_project(step_timing=(_t("PDD-E", 7),)))
    out = run_greedy_sgs(si)
    # Booked as the table's 4 weeks while the effective duration is 7.
    bad = _broken(out, "p", "PDD-E", end_week=36)
    violations = validate_invariants(si, bad, check_determinism=False)
    assert "I21" in _ids(violations)
    assert any(v.step_id == "PDD-E" and v.invariant == "I21" for v in violations)


def test_i21_detects_duration_weeks_not_effective() -> None:
    si = _si(_project(step_timing=(_t("PDD-L", 5),)))
    out = run_greedy_sgs(si)
    bad = _broken(out, "p", "PDD-L", duration_weeks=1)  # elapsed: I6/I7 do not cover it
    assert _ids(validate_invariants(si, bad, check_determinism=False)) == {"I21"}


def test_i21_detects_in_progress_tail_from_table_duration() -> None:
    p = _project(
        step_progress=DONE_A_D
        + (progress("PDD-E", "In Progress", percent_complete=50, actual_start_week=28),),
        step_timing=(_t("PDD-E", 8),),
    )
    si = _si(p)
    out = run_greedy_sgs(si)
    # Tail from the table's 4 weeks (2 weeks: 31..32) instead of the effective 8 (4: 31..34).
    bad = _broken(out, "p", "PDD-E", end_week=32)
    violations = validate_invariants(si, bad, check_determinism=False)
    assert any(v.invariant == "I21" and "tail" in v.description for v in violations)


def test_i21_detects_remaining_zero_row_end() -> None:
    p = _project(
        step_progress=DONE_A_D
        + (progress("PDD-E", "In Progress", percent_complete=100, actual_start_week=28),),
        step_timing=(_t("PDD-E", 8),),
    )
    si = _si(p)
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    assert _weeks(out.project_outcomes[0])["PDD-E"] == (28, 28, False)
    bad = _broken(out, "p", "PDD-E", end_week=30)
    assert "I21" in _ids(validate_invariants(si, bad, check_determinism=False))


def test_i22_detects_start_before_floor() -> None:
    si = _si(_project(step_timing=(_t("PDD-H", not_before=45),)))
    out = run_greedy_sgs(si)
    bad = _broken(out, "p", "PDD-H", start_week=43, end_week=48)
    violations = validate_invariants(si, bad, check_determinism=False)
    assert "I22" in _ids(violations)
    v = next(v for v in violations if v.invariant == "I22")
    assert (v.project_id, v.step_id, v.week) == ("p", "PDD-H", 43)


def test_i21_i22_exempt_frozen_projects() -> None:
    p = _project(frozen=True, actual_start_week=31, step_timing=(_t("PDD-H", None, 60),))
    si = _si(p)
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    assert _weeks(out.project_outcomes[0])["PDD-H"][0] < 60


# --- Monte Carlo ------------------------------------------------------------------


def test_monte_carlo_scales_overrides_and_clamps() -> None:
    rows = (_t("PDD-E", 10), _t("PDD-H", None, 40), _t("PDD-K", 100))
    assert _perturbed_step_timing(rows, 1.3) == (
        _t("PDD-E", 13),
        _t("PDD-H", None, 40),
        _t("PDD-K", 104),
    )
    assert _perturbed_step_timing((_t("PDD-E", 1),), 0.1) == (_t("PDD-E", 1),)
    assert _perturbed_step_timing((), 1.3) == ()


def test_monte_carlo_unperturbed_matches_greedy_with_timing() -> None:
    si = _si(_project(step_timing=(_t("PDD-E", 7), _t("PDD-H", None, 44))))
    fc = forecast_delivery(si, iterations=1, delay_perturbation=False, duration_perturbation=False)
    greedy_end = run_greedy_sgs(si).project_outcomes[0].end_week
    assert fc.project_forecasts[0].completion_weeks == (greedy_end,)
    perturbed = forecast_delivery(si, iterations=5, seed=7)
    again = forecast_delivery(si, iterations=5, seed=7)
    assert perturbed == again
