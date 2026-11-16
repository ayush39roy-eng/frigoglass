"""P40-T03a — manual step pins in the scheduler (ADR 0054 as ruled at P40-T02,
R40-3..R40-8, R40-12; DOMAIN_RULES "Manual step weeks", I45-I48 and the
amended I1/I2/I3/I15/I21/I22/I27).

Every week below is hand-derived with CURRENT_WEEK = 31 and the default
table. The base project is PDD / B (as in the P12, P32, P33 and P35 suites):

    step:  A B C D E F G H I J K L M N
    lead:  1 0 0 1 4 0 0 6 0 1 2 1 1 1
    kind:  d d e d d l e l d d d e d e

Baseline: A 31, D 32, E 33-36, H 37-42, J 43, K 44-45, L 46, M 47, N 48.

A pin `(ms, me)` is end-inclusive (R40-1). It places the step on its
effective window `(a, b)` (R40-5: `(ms, me)` when frozen or `ms >= cw`, else
`(cw, cw + L - 1)`), books it like a fixed placement (R40-6), reports effort
as `duration_weeks` (R40-3) and passes on `G = max(end, release)` (R40-7).
"""

from __future__ import annotations

import dataclasses
import hashlib
import json

import pytest

from scheduling import (
    ChamberInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepPinInput,
    StepSchedule,
    StepTimingInput,
    canonical_schedule_input_asdict,
    canonical_schedule_output_asdict,
    check_pin_load_neutrality,
    forecast_delivery,
    run_cp_sat,
    run_greedy_sgs,
    validate_invariants,
)
from scheduling.monte_carlo import _perturbed_project
from scheduling.workflow import (
    analyse_project,
    build_lead_time_table,
    build_workflows,
    pin_windows,
    unconstrained_end_week,
)
from tests.scheduling._fixtures import progress
from tests.scheduling.test_p33_gaps import (
    BASELINE,
    CH_GR,
    CW,
    ENG_A,
    ENG_B,
    _broken,
    _ids,
    _project,
    _si,
    _t,
    _weeks,
)


def _pin(step_id: str, start: int, end: int) -> StepPinInput:
    return StepPinInput(step_id=step_id, start_week=start, end_week=end)


def _run(si: ScheduleInput) -> tuple[ScheduleOutput, dict[str, ProjectScheduleOutcome]]:
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    return out, {o.project_id: o for o in out.project_outcomes}


def _cp(si: ScheduleInput) -> tuple[ScheduleOutput, dict[str, ProjectScheduleOutcome]]:
    out, _info = run_cp_sat(si, deterministic_time=5.0, earliness_deterministic_time=2.0)
    assert validate_invariants(si, out, check_determinism=False) == ()
    return out, {o.project_id: o for o in out.project_outcomes}


def _rows(outcome: ProjectScheduleOutcome) -> dict[str, StepSchedule]:
    return {s.step_id: s for s in outcome.steps}


def _pinned(outcome: ProjectScheduleOutcome) -> dict[str, tuple[int, int]]:
    return {s.step_id: (s.start_week, s.end_week) for s in outcome.steps if s.pinned}


def _digest(obj: object) -> str:
    blob = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _plan(p: ProjectInput, fte: float | None = 1.0):  # type: ignore[no-untyped-def]
    si = _si(p)
    wf = build_workflows(si.workflow_steps)[p.workflow_id]
    return analyse_project(p, wf, build_lead_time_table(si.lead_times), leader_fte=fte)


ENG_A_HALF = dataclasses.replace(ENG_A, fte=0.5)
CH_GR2 = ChamberInput(
    "ch-gr2", "GR2", "Greece", max_concurrent=1, allowed_stages=("PDD-F", "PDD-H")
)


# =====================================================================================
# Types, defaults and the canonical forms (R40-12, I48(a))
# =====================================================================================


def test_new_fields_default_to_empty_and_false() -> None:
    p = _project()
    assert p.step_pins == ()
    row = StepSchedule("PDD-A", 1, "design", 31, 31, 1, "eng-a", None)
    assert (row.pinned, row.manual_overlap) == (False, False)
    out, by = _run(_si(p))
    assert not by["p"].manual_overlap and not by["p"].pin_lapsed
    assert all(not s.pinned and not s.manual_overlap for s in by["p"].steps)
    # Field order: the new fields come last, so every positional caller and the
    # asdict order of every pre-P40 field are unchanged.
    names = [f.name for f in dataclasses.fields(ProjectInput)]
    assert names[-1] == "step_pins"
    assert [f.name for f in dataclasses.fields(StepSchedule)][-2:] == ["pinned", "manual_overlap"]
    assert [f.name for f in dataclasses.fields(ProjectScheduleOutcome)][-2:] == [
        "manual_overlap",
        "pin_lapsed",
    ]


def test_canonical_input_omits_empty_step_pins_and_keeps_a_set_one() -> None:
    si = _si(_project("a"), _project("b", step_pins=(_pin("PDD-E", 40, 42),)))
    data = canonical_schedule_input_asdict(si)
    assert "step_pins" not in data["projects"][0]
    assert data["projects"][1]["step_pins"] == (
        {"step_id": "PDD-E", "start_week": 40, "end_week": 42},
    )
    raw = dataclasses.asdict(si)
    del raw["categories"]
    for proj in raw["projects"]:
        proj.pop("band_rank")
    del raw["projects"][0]["step_pins"]
    assert data == raw


def test_canonical_output_omits_the_p40_flags_at_their_defaults() -> None:
    out, _by = _run(_si(_project()))
    data = canonical_schedule_output_asdict(out)
    for o in data["project_outcomes"]:
        assert "manual_overlap" not in o and "pin_lapsed" not in o
        for s in o["steps"]:
            assert "pinned" not in s and "manual_overlap" not in s
    raw = dataclasses.asdict(out)
    for o in raw["project_outcomes"]:
        del o["manual_overlap"], o["pin_lapsed"]
        for s in o["steps"]:
            del s["pinned"], s["manual_overlap"]
    assert data == raw
    pinned_out, _ = _run(_si(_project(step_pins=(_pin("PDD-E", 20, 23),))))
    pdata = canonical_schedule_output_asdict(pinned_out)["project_outcomes"][0]
    assert pdata["pin_lapsed"] is True and pdata["manual_overlap"] is True
    e = next(s for s in pdata["steps"] if s["step_id"] == "PDD-E")
    assert (e["pinned"], e["manual_overlap"]) == (True, True)


def test_explicit_empty_pins_are_byte_identical_to_the_default() -> None:
    p = _project()
    explicit = dataclasses.replace(p, step_pins=())
    a, b = _si(p), _si(explicit)
    assert canonical_schedule_input_asdict(a) == canonical_schedule_input_asdict(b)
    assert repr(run_greedy_sgs(a)) == repr(run_greedy_sgs(b))


# --- validation (R40-12: ValueError) --------------------------------------------------


@pytest.mark.parametrize(
    ("pins", "match"),
    [
        ((_pin("PDD-Z", 40, 41),), "not a step of workflow"),
        ((_pin("OEM-E", 40, 41),), "not a step of workflow"),
        ((_pin("PDD-E", 40, 41), _pin("PDD-E", 42, 43)), "more than once"),
        ((_pin("PDD-E", 41, 40),), "outside"),
        ((_pin("PDD-E", 0, 3),), "outside"),
        ((_pin("PDD-E", 70, 79),), "outside"),
        ((StepPinInput("PDD-E", True, 3),), "outside"),  # type: ignore[arg-type]
        ((StepPinInput("PDD-E", 3, 4.0),), "outside"),  # type: ignore[arg-type]
    ],
)
def test_invalid_pins_are_rejected(pins: tuple[StepPinInput, ...], match: str) -> None:
    with pytest.raises(ValueError, match=match):
        run_greedy_sgs(_si(_project(step_pins=pins)))


def test_a_one_week_pin_and_a_pin_at_the_horizon_are_valid() -> None:
    _out, by = _run(_si(_project(step_pins=(_pin("PDD-N", 78, 78),))))
    assert _pinned(by["p"]) == {"PDD-N": (78, 78)}
    assert by["p"].end_week == 78


# =====================================================================================
# Placement fixtures (I45, I47(a))
# =====================================================================================


#: On time: E pinned 35-38 (ms >= cw). release(E) = end(D) = 32, 35 >= 33: no
#: MANUAL_OVERLAP. G(E) = max(38, 32) = 38, so H 39-44 and the tail follows.
ON_TIME_WEEKS = {
    **{k: BASELINE[k] for k in ("PDD-A", "PDD-D")},
    "PDD-E": (35, 38),
    "PDD-H": (39, 44),
    "PDD-J": (45, 45),
    "PDD-K": (46, 47),
    "PDD-L": (48, 48),
    "PDD-M": (49, 49),
    "PDD-N": (50, 50),
}


def test_on_time_pin_sits_exactly_on_its_weeks() -> None:
    si = _si(_project(step_pins=(_pin("PDD-E", 35, 38),)))
    _out, by = _run(si)
    o = by["p"]
    assert _weeks(o) == ON_TIME_WEEKS
    e = _rows(o)["PDD-E"]
    assert (e.pinned, e.manual_overlap, e.duration_weeks, e.assigned_engineer_id) == (
        True,
        False,
        4,
        "eng-a",
    )
    assert _pinned(o) == {"PDD-E": (35, 38)}
    assert not o.pin_lapsed and not o.manual_overlap and not o.eng_conflict
    assert o.end_week == 50 and o.projected_end_week == 50 and o.within_year


def test_pin_squeezed_below_the_fte_span_books_the_window_but_reports_effort() -> None:
    """Leader at FTE 0.5: E (eff 4) would span 8 weeks. Pinned to 2 weeks it
    books exactly 35-36 and still reports `duration_weeks = 4` (R40-3, I29)."""

    si = _si(_project(step_pins=(_pin("PDD-E", 35, 36),)), engineers=(ENG_A_HALF,))
    _out, by = _run(si)
    o = by["p"]
    assert _weeks(o) == {
        "PDD-A": (31, 32),
        "PDD-D": (33, 34),
        "PDD-E": (35, 36),
        "PDD-H": (37, 42),
        "PDD-J": (43, 44),
        "PDD-K": (45, 48),
        "PDD-L": (49, 49),
        "PDD-M": (50, 51),
        "PDD-N": (52, 52),
    }
    e = _rows(o)["PDD-E"]
    assert e.pinned and e.duration_weeks == 4
    # Unpinned, E spans 8 weeks at FTE 0.5.
    _o2, by2 = _run(_si(_project(), engineers=(ENG_A_HALF,)))
    assert _weeks(by2["p"])["PDD-E"] == (35, 42)
    assert _rows(by2["p"])["PDD-E"].duration_weeks == 4


def test_lapsed_pin_moves_to_the_current_week_and_keeps_its_length() -> None:
    """E pinned 20-23 at W31 lapses to 31-34 (`pin_lapsed`). The pin is booked
    before any search, so A and D wait for the leader: A 35, D 36. release(E)
    = 36 > 31 - 1: MANUAL_OVERLAP. G(E) = max(34, 36) = 36 (F5): H 37-42."""

    si = _si(_project(step_pins=(_pin("PDD-E", 20, 23),)))
    _out, by = _run(si)
    o = by["p"]
    assert _weeks(o) == {
        "PDD-A": (35, 35),
        "PDD-D": (36, 36),
        "PDD-E": (31, 34),
        "PDD-H": (37, 42),
        "PDD-J": (43, 43),
        "PDD-K": (44, 45),
        "PDD-L": (46, 46),
        "PDD-M": (47, 47),
        "PDD-N": (48, 48),
    }
    assert o.pin_lapsed and o.manual_overlap
    assert _rows(o)["PDD-E"].manual_overlap and _rows(o)["PDD-E"].pinned
    # Pins are booked before the search, so the unconstrained finish (one
    # leader, R33-6) sees them too: 48.
    assert o.unconstrained_end_week == 48


def test_pin_that_starts_at_the_current_week_is_not_lapsed() -> None:
    _out, by = _run(_si(_project(step_pins=(_pin("PDD-A", 31, 31),))))
    assert not by["p"].pin_lapsed
    assert _weeks(by["p"]) == BASELINE


def test_frozen_pin_in_the_past_is_exact() -> None:
    """Frozen, actual start W10: A 10 (frozen gate), D pinned 5-6 (exact, in
    the past, never floored at CW): release(D) = 10 > 5 - 1 -> MANUAL_OVERLAP;
    G(D) = max(6, 10) = 10, so E 11-14 (frozen: no FTE stretch, no search)."""

    p = _project(frozen=True, actual_start_week=10, step_pins=(_pin("PDD-D", 5, 6),))
    _out, by = _run(_si(p))
    o = by["p"]
    assert _weeks(o) == {
        "PDD-A": (10, 10),
        "PDD-D": (5, 6),
        "PDD-E": (11, 14),
        "PDD-H": (15, 20),
        "PDD-J": (21, 21),
        "PDD-K": (22, 23),
        "PDD-L": (24, 24),
        "PDD-M": (25, 25),
        "PDD-N": (26, 26),
    }
    d = _rows(o)["PDD-D"]
    assert d.pinned and d.manual_overlap and d.duration_weeks == 1
    assert not o.pin_lapsed and o.manual_overlap


def test_frozen_pin_later_than_the_plan_moves_only_its_successors() -> None:
    p = _project(frozen=True, actual_start_week=10, step_pins=(_pin("PDD-E", 30, 33),))
    _out, by = _run(_si(p))
    w = _weeks(by["p"])
    assert (w["PDD-A"], w["PDD-D"], w["PDD-E"], w["PDD-H"]) == (
        (10, 10),
        (11, 11),
        (30, 33),
        (34, 39),
    )
    assert not by["p"].manual_overlap


def test_lapsed_pin_past_the_horizon_leaves_the_project_out_and_keeps_other_pins() -> None:
    """E pinned 1-50 lapses to 31-80 > 78: LEFT_OUT, E has no row and nothing
    is booked for it. H pinned 60-65 is within the horizon: pre-booked, and
    its row is kept (Gate ruling 2)."""

    p = _project(step_pins=(_pin("PDD-E", 1, 50), _pin("PDD-H", 60, 65)))
    si = _si(p)
    _out, by = _run(si)
    o = by["p"]
    assert o.left_out and o.pin_lapsed and o.projected_end_week is None
    rows = _rows(o)
    assert "PDD-E" not in rows
    assert _pinned(o) == {"PDD-H": (60, 65)}
    assert rows["PDD-H"].assigned_chamber_id == "ch-gr"
    assert _weeks(o) == {"PDD-A": (31, 31), "PDD-D": (32, 32), "PDD-H": (60, 65)}
    _cp_out, cp_by = _cp(si)
    assert cp_by["p"] == o


# --- precedence and MANUAL_OVERLAP (R40-7, I47(a)) ------------------------------------


def test_pin_before_its_predecessor_ends_is_flagged_and_the_predecessor_waits() -> None:
    """E pinned 32-35: D (gate 32) cannot use the leader in 32-35 and moves to
    36. release(E) = 36: 32 < 37 -> MANUAL_OVERLAP. H waits for D's end (36),
    E's own end is 35: G(E) = 36, H 37-42 (successors wait for all upstream
    work, F5)."""

    _out, by = _run(_si(_project(step_pins=(_pin("PDD-E", 32, 35),))))
    o = by["p"]
    w = _weeks(o)
    assert (w["PDD-A"], w["PDD-D"], w["PDD-E"], w["PDD-H"]) == (
        (31, 31),
        (36, 36),
        (32, 35),
        (37, 42),
    )
    assert o.manual_overlap and _rows(o)["PDD-E"].manual_overlap


@pytest.mark.parametrize(("overlap", "flagged"), [(0, True), (2, False), (1, True)])
def test_template_overlap_is_allowed_before_the_flag(overlap: int, flagged: bool) -> None:
    """H (lab) pinned 35-40, release(H) = end(E) = 36: flagged iff 35 < 37 - o.
    The pin overrides the overlap's gate either way."""

    timing = (_t("PDD-H", overlap=overlap),) if overlap else ()
    p = _project(step_timing=timing, step_pins=(_pin("PDD-H", 35, 40),))
    _out, by = _run(_si(p))
    o = by["p"]
    assert _weeks(o)["PDD-H"] == (35, 40)
    assert _rows(o)["PDD-H"].manual_overlap is flagged
    assert o.manual_overlap is flagged
    assert _weeks(o)["PDD-J"] == (41, 41)


def test_pin_inside_a_wait_is_not_flagged() -> None:
    """E waits 3 (gate 36) but is pinned 33-36: the pin overrides the gap and
    33 >= release + 1 = 33, so no MANUAL_OVERLAP (R40-7)."""

    p = _project(step_timing=(_t("PDD-E", wait=3),), step_pins=(_pin("PDD-E", 33, 36),))
    _out, by = _run(_si(p))
    assert _weeks(by["p"]) == BASELINE
    assert not by["p"].manual_overlap and _rows(by["p"])["PDD-E"].pinned


def test_a_wait_after_a_pin_counts_from_the_release() -> None:
    """H waits 2 after a pinned E 35-38: gate(H) = G(E) + 1 + 2 = 41."""

    p = _project(step_timing=(_t("PDD-H", wait=2),), step_pins=(_pin("PDD-E", 35, 38),))
    _out, by = _run(_si(p))
    assert _weeks(by["p"])["PDD-H"] == (41, 46)


def test_unpinned_neighbours_are_never_moved_before_a_pin_nor_move_it() -> None:
    """E pinned early (33-34, squeezed): H still waits for E's end, nothing
    moves the pin, and A/D are untouched (only the pinned step changes, M3)."""

    _out, by = _run(_si(_project(step_pins=(_pin("PDD-E", 33, 34),))))
    w = _weeks(by["p"])
    assert (w["PDD-A"], w["PDD-D"], w["PDD-E"], w["PDD-H"]) == (
        (31, 31),
        (32, 32),
        (33, 34),
        (35, 40),
    )


def test_a_pin_overrides_start_not_before_and_the_floor_still_governs_the_rest() -> None:
    p = _project(
        step_timing=(StepTimingInput("PDD-E", None, 50), StepTimingInput("PDD-J", None, 50)),
        step_pins=(_pin("PDD-E", 33, 36),),
    )
    _out, by = _run(_si(p))
    w = _weeks(by["p"])
    assert w["PDD-E"] == (33, 36) and w["PDD-H"] == (37, 42) and w["PDD-J"] == (50, 50)


# --- progress, holds, skips (R40-4, R40-9) ---------------------------------------------


def test_blocked_hold_wins_over_a_pin() -> None:
    """D Blocked (remaining 1): D and every successor are held, so the pin on
    E is not placed, nothing is booked and no row is pinned."""

    held = _project(step_progress=(progress("PDD-D", "Blocked", actual_start_week=30),))
    pinned = dataclasses.replace(held, step_pins=(_pin("PDD-E", 40, 43),))
    _o1, by1 = _run(_si(held))
    _o2, by2 = _run(_si(pinned))
    assert by2["p"].blocked and not _pinned(by2["p"]) and not by2["p"].pin_lapsed
    assert by2["p"].steps == by1["p"].steps


@pytest.mark.parametrize(
    "variant",
    ["lead0", "excluded", "cert_off", "in_progress", "done"],
)
def test_pins_on_skipped_or_started_steps_are_inert(variant: str) -> None:
    """A pin on a skipped step (lead 0: PDD-B; an excluded step, sent as
    `lead_weeks = 0`; a lab step with certification off) or on a started step
    of a non-frozen project changes nothing at all."""

    base_kw: dict[str, object] = {}
    pin = _pin("PDD-E", 40, 43)
    if variant == "lead0":
        pin = _pin("PDD-B", 40, 43)
    elif variant == "excluded":
        base_kw["step_timing"] = (_t("PDD-E", lead=0),)
    elif variant == "cert_off":
        base_kw["certification_testing_required"] = False
        pin = _pin("PDD-H", 40, 43)
    elif variant == "in_progress":
        base_kw["step_progress"] = (
            progress("PDD-A", "Done", actual_start_week=29, actual_end_week=29),
            progress("PDD-D", "Done", actual_start_week=30, actual_end_week=30),
            progress("PDD-E", "In Progress", percent_complete=50, actual_start_week=30),
        )
    else:
        base_kw["step_progress"] = (
            progress("PDD-A", "Done", actual_start_week=20, actual_end_week=20),
            progress("PDD-D", "Done", actual_start_week=21, actual_end_week=21),
            progress("PDD-E", "Done", actual_start_week=22, actual_end_week=25),
        )
    plain = _project(**base_kw)  # type: ignore[arg-type]
    pinned = dataclasses.replace(plain, step_pins=(pin,))
    o1, _ = _run(_si(plain))
    o2, by2 = _run(_si(pinned))
    assert repr(o1) == repr(o2)
    assert not _pinned(by2["p"]) and not by2["p"].pin_lapsed


def test_frozen_project_pins_apply_whatever_the_stored_stage_says() -> None:
    p = _project(
        frozen=True,
        actual_start_week=31,
        step_progress=(progress("PDD-E", "In Progress", actual_start_week=31),),
        step_pins=(_pin("PDD-E", 40, 43),),
    )
    _out, by = _run(_si(p))
    assert _pinned(by["p"]) == {"PDD-E": (40, 43)}


# --- capacity: engineers (R40-6, I1 / I47(d)) -----------------------------------------


def test_two_pins_of_one_project_sharing_a_week_raise_eng_conflict() -> None:
    """D pinned 40-41 and E pinned 41-44 share week 41 for the same leader
    (F4). G(D) = 41, so E (41 < 42) is MANUAL_OVERLAP too."""

    p = _project(step_pins=(_pin("PDD-D", 40, 41), _pin("PDD-E", 41, 44)))
    _out, by = _run(_si(p))
    o = by["p"]
    assert o.eng_conflict and o.manual_overlap
    assert _pinned(o) == {"PDD-D": (40, 41), "PDD-E": (41, 44)}
    assert _weeks(o)["PDD-H"] == (45, 50)


def test_pin_against_the_projects_own_anchored_tail_raises_eng_conflict() -> None:
    p = _project(
        step_progress=(progress("PDD-A", "In Progress", actual_start_week=31),),
        step_pins=(_pin("PDD-D", 31, 31),),
    )
    _out, by = _run(_si(p))
    o = by["p"]
    assert o.eng_conflict and _rows(o)["PDD-D"].manual_overlap
    assert _weeks(o)["PDD-A"] == (31, 31) and _weeks(o)["PDD-D"] == (31, 31)


def test_frozen_pin_against_the_projects_own_frozen_step_raises_eng_conflict() -> None:
    p = _project(frozen=True, actual_start_week=31, step_pins=(_pin("PDD-E", 31, 34),))
    _out, by = _run(_si(p))
    assert by["p"].eng_conflict


def test_two_unpinned_fixed_steps_of_one_project_stay_unflagged() -> None:
    """Byte-identity guard: the same-project rule needs a pin on one side."""

    p = _project(
        step_progress=(
            progress("PDD-A", "In Progress", actual_start_week=31),
            progress("PDD-D", "In Progress", actual_start_week=31),
        ),
    )
    _out, by = _run(_si(p))
    assert not by["p"].eng_conflict


def test_pin_against_another_project_flags_both() -> None:
    frozen = _project("f", frozen=True, actual_start_week=31)
    pinned = _project("q", priority="P2", step_pins=(_pin("PDD-A", 31, 31),))
    _out, by = _run(_si(frozen, pinned))
    assert by["f"].eng_conflict and by["q"].eng_conflict


def test_a_later_priority_pin_keeps_its_weeks_against_a_higher_priority_project() -> None:
    """Pins are pre-booked before any search (R40-6): the P1 project's A waits."""

    first = _project("p1", priority="P1")
    second = _project("p2", priority="P2", step_pins=(_pin("PDD-A", 31, 31),))
    _out, by = _run(_si(first, second))
    assert _weeks(by["p2"])["PDD-A"] == (31, 31)
    assert _weeks(by["p1"])["PDD-A"] == (32, 32)
    assert not by["p1"].eng_conflict and not by["p2"].eng_conflict


def test_unpinned_steps_search_around_the_leaders_own_pins() -> None:
    """J (1 week) is pinned on the leader's week 31: A searches past it."""

    _out, by = _run(_si(_project(step_pins=(_pin("PDD-J", 31, 31),))))
    w = _weeks(by["p"])
    assert w["PDD-A"] == (32, 32) and w["PDD-J"] == (31, 31)
    assert not by["p"].eng_conflict


# --- capacity: chambers (R40-6, I2 / I47(d)) -------------------------------------------


def test_two_lab_pins_overbook_a_single_chamber_with_overlap() -> None:
    a = _project("a", step_pins=(_pin("PDD-H", 40, 45),))
    b = _project("b", priority="P2", leader_engineer_id="eng-b", step_pins=(_pin("PDD-H", 40, 45),))
    si = _si(a, b, engineers=(ENG_A, ENG_B))
    _out, by = _run(si)
    assert _rows(by["a"])["PDD-H"].assigned_chamber_id == "ch-gr"
    assert _rows(by["b"])["PDD-H"].assigned_chamber_id == "ch-gr"
    assert not by["a"].overlap and by["b"].overlap
    assert _pinned(by["b"]) == {"PDD-H": (40, 45)}


def test_a_lab_pin_takes_the_first_chamber_with_room() -> None:
    a = _project("a", step_pins=(_pin("PDD-H", 40, 45),))
    b = _project("b", priority="P2", leader_engineer_id="eng-b", step_pins=(_pin("PDD-H", 40, 45),))
    si = _si(a, b, engineers=(ENG_A, ENG_B), chambers=(CH_GR, CH_GR2))
    _out, by = _run(si)
    assert _rows(by["b"])["PDD-H"].assigned_chamber_id == "ch-gr2"
    assert not by["a"].overlap and not by["b"].overlap


def test_a_lab_pin_with_no_eligible_chamber_leaves_the_project_out() -> None:
    p = _project(step_pins=(_pin("PDD-H", 40, 45),))
    _out, by = _run(_si(p, chambers=(dataclasses.replace(CH_GR, allowed_stages=("PDD-F",)),)))
    o = by["p"]
    assert o.left_out and o.no_chamber_step_id == "PDD-H" and not _pinned(o)


# =====================================================================================
# Unconstrained finish (R40-8), Monte Carlo, determinism
# =====================================================================================


def test_unconstrained_finish_uses_the_pins() -> None:
    p = _project(step_pins=(_pin("PDD-E", 35, 38),))
    assert unconstrained_end_week(_plan(p), CW) == 50
    _out, by = _run(_si(p))
    assert by["p"].unconstrained_end_week == 50 and by["p"].expected_end_week == 50
    target = dataclasses.replace(p, target_end_week=45)
    _o2, by2 = _run(_si(target))
    assert by2["p"].expected_end_week == 45


def test_pin_windows_helper() -> None:
    p = _project(step_pins=(_pin("PDD-E", 20, 23), _pin("PDD-H", 40, 45), _pin("PDD-B", 1, 2)))
    wins = pin_windows(_plan(p), CW)
    assert sorted(wins) == ["PDD-E", "PDD-H"]  # B is skipped: inert
    assert (wins["PDD-E"].start_week, wins["PDD-E"].end_week, wins["PDD-E"].lapsed) == (
        31,
        34,
        True,
    )
    assert (wins["PDD-H"].start_week, wins["PDD-H"].end_week, wins["PDD-H"].lapsed) == (
        40,
        45,
        False,
    )


def test_monte_carlo_never_perturbs_pins(monkeypatch: pytest.MonkeyPatch) -> None:
    """R40-12: every sampled input carries the pins unchanged (they are not in
    `StepTimingInput`, the field Monte Carlo perturbs), and every sample
    places the pinned step exactly."""

    import scheduling.monte_carlo as mc

    p = _project(step_timing=(_t("PDD-E", duration=3),), step_pins=(_pin("PDD-E", 35, 38),))
    perturbed = _perturbed_project(p, delay_weeks=2, duration_factor=1.5)
    assert perturbed.step_pins == p.step_pins
    assert perturbed.step_timing != p.step_timing

    seen: list[ScheduleInput] = []
    real = mc.run_greedy_sgs

    def spy(si: ScheduleInput) -> ScheduleOutput:
        seen.append(si)
        out = real(si)
        assert _pinned(out.project_outcomes[0]) == {"PDD-E": (35, 38)}
        return out

    monkeypatch.setattr(mc, "run_greedy_sgs", spy)
    forecast_delivery(_si(p), iterations=12, seed=7)
    assert len(seen) >= 12
    assert all(s.projects[0].step_pins == p.step_pins for s in seen)


def test_determinism_with_pins() -> None:
    si = _si(
        _project("a", step_pins=(_pin("PDD-E", 20, 23),)),
        _project("b", priority="P2", step_pins=(_pin("PDD-H", 40, 45), _pin("PDD-D", 33, 33))),
    )
    assert repr(run_greedy_sgs(si)) == repr(run_greedy_sgs(si))


# =====================================================================================
# Greedy vs CP-SAT (I47(c))
# =====================================================================================


def test_greedy_and_cp_sat_emit_identical_pinned_rows_and_pin_lapsed() -> None:
    projects = (
        _project("a", step_pins=(_pin("PDD-E", 20, 23),)),
        _project("b", priority="P2", step_pins=(_pin("PDD-H", 40, 45), _pin("PDD-D", 36, 36))),
        _project("c", priority="P3", leader_engineer_id="eng-b"),
        _project("d", frozen=True, actual_start_week=25, step_pins=(_pin("PDD-E", 26, 27),)),
        _project("e", priority="P4", leader_engineer_id="eng-b", step_pins=(_pin("PDD-E", 1, 50),)),
        _project(
            "f",
            priority="P2",
            step_timing=(_t("PDD-H", overlap=2),),
            step_pins=(_pin("PDD-H", 35, 40),),
        ),
    )
    si = _si(*projects, engineers=(ENG_A, ENG_B), chambers=(CH_GR, CH_GR2))
    g_out, g = _run(si)
    _c_out, c = _cp(si)
    for pid in sorted(g):
        # `manual_overlap` depends on where each solver placed the predecessors,
        # so each evaluates it on its own rows (I47(c), checked by the validator
        # in `_run` / `_cp`); everything else on a pinned row is identical.
        assert _pinned_rows(g[pid]) == _pinned_rows(c[pid]), pid
        assert g[pid].pin_lapsed == c[pid].pin_lapsed, pid
    assert g["a"].pin_lapsed and g["e"].pin_lapsed and g["e"].left_out
    # e's pin lapses past the horizon (no row): 5 pinned rows of 6 pins.
    assert sum(len(_pinned(o)) for o in g.values()) == 5


def _pinned_rows(o: ProjectScheduleOutcome) -> dict[str, StepSchedule]:
    return {s.step_id: dataclasses.replace(s, manual_overlap=False) for s in o.steps if s.pinned}


# =====================================================================================
# Invariants: negative tests (I45, I47, I48(b), amended I1 / I3 / I10 / I21)
# =====================================================================================


def _with_outcome(out: ScheduleOutput, pid: str, **kw: object) -> ScheduleOutput:
    return dataclasses.replace(
        out,
        project_outcomes=tuple(
            dataclasses.replace(o, **kw) if o.project_id == pid else o  # type: ignore[arg-type]
            for o in out.project_outcomes
        ),
    )


ON_TIME = _si(_project(step_pins=(_pin("PDD-E", 35, 38),)))
LAPSED = _si(_project(step_pins=(_pin("PDD-E", 20, 23),)))


def test_i45_pinned_row_moved_off_its_pin() -> None:
    out = run_greedy_sgs(ON_TIME)
    bad = _broken(out, "p", "PDD-E", start_week=36, end_week=39)
    assert "I45" in _ids(validate_invariants(ON_TIME, bad, check_determinism=False))


def test_i45_pinned_flag_missing_and_spurious() -> None:
    out = run_greedy_sgs(ON_TIME)
    missing = _broken(out, "p", "PDD-E", pinned=False)
    assert "I45" in _ids(validate_invariants(ON_TIME, missing, check_determinism=False))
    spurious = _broken(out, "p", "PDD-H", pinned=True)
    assert "I45" in _ids(validate_invariants(ON_TIME, spurious, check_determinism=False))


def test_i45_pinned_row_reports_the_window_as_duration() -> None:
    out = run_greedy_sgs(_si(_project(step_pins=(_pin("PDD-E", 35, 36),))))
    bad = _broken(out, "p", "PDD-E", duration_weeks=2)
    si = _si(_project(step_pins=(_pin("PDD-E", 35, 36),)))
    assert "I45" in _ids(validate_invariants(si, bad, check_determinism=False))


def test_i45_pin_lapsed_flag() -> None:
    out = run_greedy_sgs(LAPSED)
    assert "I45" in _ids(
        validate_invariants(
            LAPSED, _with_outcome(out, "p", pin_lapsed=False), check_determinism=False
        )
    )
    out2 = run_greedy_sgs(ON_TIME)
    assert "I45" in _ids(
        validate_invariants(
            ON_TIME, _with_outcome(out2, "p", pin_lapsed=True), check_determinism=False
        )
    )


def test_i45_lapsed_pin_placed_in_the_past() -> None:
    out = run_greedy_sgs(LAPSED)
    bad = _broken(out, "p", "PDD-E", start_week=20, end_week=23)
    assert "I45" in _ids(validate_invariants(LAPSED, bad, check_determinism=False))


def test_i45_past_horizon_pin_must_leave_the_project_out() -> None:
    si = _si(_project(step_pins=(_pin("PDD-E", 1, 50),)))
    out = run_greedy_sgs(si)
    bad = _with_outcome(out, "p", left_out=False)
    assert "I45" in _ids(validate_invariants(si, bad, check_determinism=False))


def test_i45_design_pin_must_book_the_leader() -> None:
    out = run_greedy_sgs(ON_TIME)
    bad = _broken(out, "p", "PDD-E", assigned_engineer_id=None)
    assert "I45" in _ids(validate_invariants(ON_TIME, bad, check_determinism=False))


def test_i47a_manual_overlap_flags() -> None:
    out = run_greedy_sgs(LAPSED)
    no_flag = _broken(out, "p", "PDD-E", manual_overlap=False)
    assert "I47" in _ids(validate_invariants(LAPSED, no_flag, check_determinism=False))
    out2 = run_greedy_sgs(ON_TIME)
    spurious = _broken(out2, "p", "PDD-E", manual_overlap=True)
    assert "I47" in _ids(validate_invariants(ON_TIME, spurious, check_determinism=False))
    outcome_or = _with_outcome(out, "p", manual_overlap=False)
    assert "I47" in _ids(validate_invariants(LAPSED, outcome_or, check_determinism=False))


def test_i47b_successor_of_a_pin_must_wait_for_the_release() -> None:
    """Lapsed E ends 34 but passes on G = 36: H at 35 breaks I3 (G of a
    pinned predecessor), even though it starts after E's own end."""

    out = run_greedy_sgs(LAPSED)
    bad = _broken(out, "p", "PDD-H", start_week=35, end_week=40)
    ids = _ids(validate_invariants(LAPSED, bad, check_determinism=False))
    assert "I3" in ids and "I15" in ids


def test_i47d_same_project_pins_need_eng_conflict() -> None:
    si = _si(_project(step_pins=(_pin("PDD-D", 40, 41), _pin("PDD-E", 41, 44))))
    out = run_greedy_sgs(si)
    bad = _with_outcome(out, "p", eng_conflict=False)
    assert "I1" in _ids(validate_invariants(si, bad, check_determinism=False))


def test_i47d_cross_project_pin_needs_eng_conflict() -> None:
    si = _si(
        _project("f", frozen=True, actual_start_week=31),
        _project("q", priority="P2", step_pins=(_pin("PDD-A", 31, 31),)),
    )
    out = run_greedy_sgs(si)
    bad = _with_outcome(_with_outcome(out, "f", eng_conflict=False), "q", eng_conflict=False)
    assert "I1" in _ids(validate_invariants(si, bad, check_determinism=False))


def test_i47d_lab_pin_overbooking_with_a_roomy_chamber() -> None:
    a = _project("a", step_pins=(_pin("PDD-H", 40, 45),))
    b = _project("b", priority="P2", leader_engineer_id="eng-b", step_pins=(_pin("PDD-H", 40, 45),))
    si = _si(a, b, engineers=(ENG_A, ENG_B), chambers=(CH_GR, CH_GR2))
    out = run_greedy_sgs(si)
    bad = _with_outcome(_broken(out, "b", "PDD-H", assigned_chamber_id="ch-gr"), "b", overlap=True)
    assert "I2" in _ids(validate_invariants(si, bad, check_determinism=False))


def test_i10_frozen_with_pins_is_recomputed_from_the_frozen_rule() -> None:
    si = _si(_project(frozen=True, actual_start_week=10, step_pins=(_pin("PDD-D", 5, 6),)))
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    bad = _broken(out, "p", "PDD-E", start_week=12, end_week=15)
    assert "I10" in _ids(validate_invariants(si, bad, check_determinism=False))


def test_i48b_load_neutrality_holds_and_detects_a_difference() -> None:
    assert check_pin_load_neutrality(LAPSED) == ()
    assert check_pin_load_neutrality(_si(_project())) == ()


def test_i48b_compare_helper_reports_a_changed_duration() -> None:
    from scheduling.invariants import _compare_pin_neutral

    with_p = run_greedy_sgs(LAPSED)
    without = run_greedy_sgs(_si(_project()))
    bad = _broken(with_p, "p", "PDD-E", duration_weeks=2)
    assert {v.invariant for v in _compare_pin_neutral(bad, without)} == {"I48"}
    assert _compare_pin_neutral(with_p, without) == []


def test_validator_is_clean_on_every_fixture_with_cp_sat_too() -> None:
    for si in (
        ON_TIME,
        LAPSED,
        _si(_project(frozen=True, actual_start_week=10, step_pins=(_pin("PDD-D", 5, 6),))),
        _si(_project(step_pins=(_pin("PDD-D", 40, 41), _pin("PDD-E", 41, 44)))),
        _si(_project(step_pins=(_pin("PDD-E", 35, 36),)), engineers=(ENG_A_HALF,)),
    ):
        g_out = run_greedy_sgs(si)
        assert validate_invariants(si, g_out) == (), si
        _c_out, _c = _cp(si)
        g_pinned = {o.project_id: _pinned(o) for o in g_out.project_outcomes}
        c_pinned = {o.project_id: _pinned(o) for o in _c_out.project_outcomes}
        assert g_pinned == c_pinned


# =====================================================================================
# Plan import (R40-12: PIN_DROPPED) and the What-if baseline
# =====================================================================================


def test_plan_import_drops_the_pins_of_a_replaced_project_and_keeps_the_rest() -> None:
    """R40-12, the engine half: a matched plan project the file replaces is
    rebuilt from the file, so its pins never reach the import run; plan
    projects the file does not replace keep theirs. The `PIN_DROPPED` listing
    is service-side (`services.whatif_import.pin_dropped_issues`, hub-scoped,
    P40-T03b), so the engine adds no issue of its own."""

    from scheduling.plan_import import PlanImportRequest, build_plan_import_input, run_plan_import
    from tests.scheduling._whatif_fixtures import tiny_baseline
    from tests.scheduling.test_p32_plan_import import by_ref, plan_project, row, step

    p1 = dataclasses.replace(plan_project("p1"), step_pins=(_pin("PDD-E", 40, 43),))
    p2 = dataclasses.replace(plan_project("p2"), step_pins=(_pin("PDD-E", 44, 47),))
    base = tiny_baseline(projects=(p1, p2, plan_project("p3")), engineers=2)
    req = PlanImportRequest(
        projects=(row(5, replaces="p1"), row(6, leader="e1"), row(7, replaces="p3")),
        mode="merge",
    )
    run_si = build_plan_import_input(base, req)
    pins = {p.project_id: p.step_pins for p in run_si.projects if p.step_pins}
    assert pins == {"p2": (_pin("PDD-E", 44, 47),)}
    res = run_plan_import(base, req)
    e = step(by_ref(res, "p2"), "PDD-E")
    assert (e.start_week, e.end_week) == (44, 47)
    assert not any(i.code == "PIN_DROPPED" for i in res.issues)


def test_canonical_hash_of_a_pinless_input_is_the_pre_p40_one() -> None:
    """I48(a), pinned in-suite: the P37 fixture input's canonical hash and its
    greedy output's canonical hash are the pre-P40 values (see
    `test_p37_current_week`); here on a P33-gaps input built two ways."""

    si = _si(_project("a"), _project("b", priority="P2"))
    explicit = _si(_project("a", step_pins=()), _project("b", priority="P2", step_pins=()))
    assert _digest(canonical_schedule_input_asdict(si)) == _digest(
        canonical_schedule_input_asdict(explicit)
    )
    assert _digest(canonical_schedule_output_asdict(run_greedy_sgs(si))) == _digest(
        canonical_schedule_output_asdict(run_greedy_sgs(explicit))
    )


def test_solver_comparison_harness_reports_no_unexplained_divergence_on_pins() -> None:
    from scheduling.solver_comparison import compare_solvers

    si = _si(
        _project("a", step_pins=(_pin("PDD-E", 20, 23),)),
        _project("b", priority="P2", step_pins=(_pin("PDD-H", 40, 45), _pin("PDD-D", 36, 36))),
        _project("c", priority="P3", leader_engineer_id="eng-b"),
        engineers=(ENG_A, ENG_B),
        chambers=(CH_GR, CH_GR2),
    )
    report = compare_solvers(si, cp_sat_deterministic_time=5.0)
    assert not report.has_invariant_violations
    assert not report.has_unexplained_divergence
