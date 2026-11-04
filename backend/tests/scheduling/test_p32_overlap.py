"""P32-T01 golden files — parallel steps by per-project overlap (ADR 0043,
DOMAIN_RULES "Parallel steps — per-project overlap", API contract P32 A1/A2,
I3 restated through G, new I27).

Every expected week below is hand-derived from the contract formulas with
CURRENT_WEEK = 31, HORIZON_WEEKS = 78, the default strict chain and the
default lead-time table. The base project is PDD / B (as in the P12 suite):

    step:  A B C D E F G H I J K L M N
    lead:  1 0 0 1 4 0 0 6 0 1 2 1 1 1
    kind:  d d e d d l e l d d d e d e   (d design, l lab, e elapsed)

With no timing it books A 31, D 32, E 33-36, H 37-42, J 43, K 44-45, L 46,
M 47, N 48 (B/C/F/G/I skipped and transparent).

    G(q)       = release(q) if skipped; end(q) if o(q) = 0;
                 max(end(q), release(q)) if o(q) > 0
    release(s) = max(G(q) for q in P(s))      (frontier - 1 with none)
    gate(s)    = release(s) + 1                                  if o(s) = 0
               = max(release(s) + 1 - o(s), start of SG(s), frontier)  if o(s) > 0
"""

from __future__ import annotations

import dataclasses
from dataclasses import replace

import pytest

from scheduling import (
    OVERLAP_MAX_WEEKS,
    ChamberInput,
    EngineerInput,
    InvariantViolation,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepTimingInput,
    analyse_project,
    build_lead_time_table,
    build_workflows,
    canonical_step_timing,
    canonical_step_timing_dict,
    run_cp_sat,
    run_greedy_sgs,
    unconstrained_end_week,
    validate_invariants,
)
from scheduling.types import default_lead_times, default_workflow_templates
from tests.scheduling._fixtures import progress

CW = 31
ENG_A = EngineerInput("eng-a", "A", "R&D-Greece", ("A+", "A", "B", "C"))
CH_GR = ChamberInput("ch-gr", "GR", "Greece", max_concurrent=1, allowed_stages=("PDD-F", "PDD-H"))

BASELINE = {
    "PDD-A": (31, 31),
    "PDD-D": (32, 32),
    "PDD-E": (33, 36),
    "PDD-H": (37, 42),
    "PDD-J": (43, 43),
    "PDD-K": (44, 45),
    "PDD-L": (46, 46),
    "PDD-M": (47, 47),
    "PDD-N": (48, 48),
}


def _t(
    step_id: str,
    *,
    overlap: int = 0,
    duration: int | None = None,
    not_before: int | None = None,
) -> StepTimingInput:
    return StepTimingInput(
        step_id=step_id,
        duration_override_weeks=duration,
        start_not_before_week=not_before,
        overlap_weeks=overlap,
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
    base: dict[str, object] = dict(
        projects=projects, engineers=(ENG_A,), chambers=(CH_GR,), current_week=CW
    )
    base.update(kw)
    return ScheduleInput(**base)  # type: ignore[arg-type]


def _run(si: ScheduleInput) -> tuple[ScheduleOutput, dict[str, ProjectScheduleOutcome]]:
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    return out, {o.project_id: o for o in out.project_outcomes}


def _weeks(outcome: ProjectScheduleOutcome) -> dict[str, tuple[int, int]]:
    return {s.step_id: (s.start_week, s.end_week) for s in outcome.steps if not s.skipped}


def _skipped(outcome: ProjectScheduleOutcome) -> dict[str, int]:
    return {s.step_id: s.start_week for s in outcome.steps if s.skipped}


def _ids(violations: tuple[InvariantViolation, ...]) -> set[str]:
    return {v.invariant for v in violations}


def _broken(out: ScheduleOutput, pid: str, step_id: str, **kw: int) -> ScheduleOutput:
    outcomes = []
    for o in out.project_outcomes:
        if o.project_id == pid:
            o = replace(
                o,
                steps=tuple(
                    replace(s, **kw) if s.step_id == step_id else s  # type: ignore[arg-type]
                    for s in o.steps
                ),
            )
        outcomes.append(o)
    return replace(out, project_outcomes=tuple(outcomes))


def _cp_sat_weeks(si: ScheduleInput) -> tuple[ScheduleOutput, dict[str, ProjectScheduleOutcome]]:
    out, _info = run_cp_sat(si, deterministic_time=5.0, earliness_deterministic_time=2.0)
    assert validate_invariants(si, out, check_determinism=False) == ()
    return out, {o.project_id: o for o in out.project_outcomes}


def _plan(project: ProjectInput):  # type: ignore[no-untyped-def]
    wfs = build_workflows(default_workflow_templates())
    return analyse_project(
        project, wfs[project.workflow_id], build_lead_time_table(default_lead_times())
    )


# --- Fixtures (hand-derived) ---------------------------------------------------

#: H (lab, 6 wk) overlaps 4 weeks across the skipped F / G onto E (design).
#: release(H) = G(G) = G(F) = end(E) = 36; gate = max(37 - 4, start(E) = 33, 31) = 33.
#: H 33-38 runs alongside E 33-36. G(H) = max(38, 36) = 38 -> I (skipped) at 38,
#: J 39, K 40-41, L 42, M 43, N 44.
LAB_PARALLEL = _project(step_timing=(_t("PDD-H", overlap=4),))
LAB_PARALLEL_WEEKS = {
    "PDD-A": (31, 31),
    "PDD-D": (32, 32),
    "PDD-E": (33, 36),
    "PDD-H": (33, 38),
    "PDD-J": (39, 39),
    "PDD-K": (40, 41),
    "PDD-L": (42, 42),
    "PDD-M": (43, 43),
    "PDD-N": (44, 44),
}

#: L (elapsed, 1 wk) overlaps 2 weeks onto K (design 44-45).
#: release(L) = 45; gate = max(46 - 2, start(K) = 44, 31) = 44 -> L 44-44, which
#: ends BEFORE K. G(L) = max(44, 45) = 45, so M waits for both: M 46, N 47.
ELAPSED_CHAIN = _project(step_timing=(_t("PDD-L", overlap=2),))
ELAPSED_CHAIN_WEEKS = {**BASELINE, "PDD-L": (44, 44), "PDD-M": (46, 46), "PDD-N": (47, 47)}

#: E (design) overlaps 1 week onto D (design, 32): gate = max(33 - 1, 32, 31) = 32,
#: but the one leader is busy at 32, so E starts 33 — serialised, the baseline.
DESIGN_ON_DESIGN = _project(step_timing=(_t("PDD-E", overlap=1),))


# --- Greedy golden files ---------------------------------------------------------


def test_zero_overlap_is_the_unchanged_baseline() -> None:
    p = _project(step_timing=(_t("PDD-H", overlap=0), _t("PDD-K", overlap=0)))
    _, by_id = _run(_si(p))
    assert _weeks(by_id["p"]) == BASELINE
    assert repr(run_greedy_sgs(_si(p))) == repr(run_greedy_sgs(_si(_project())))


def test_lab_step_overlapping_design_runs_truly_parallel() -> None:
    _, by_id = _run(_si(LAB_PARALLEL))
    o = by_id["p"]
    assert _weeks(o) == LAB_PARALLEL_WEEKS
    # The lab step and the design step share weeks 33-36.
    e, h = LAB_PARALLEL_WEEKS["PDD-E"], LAB_PARALLEL_WEEKS["PDD-H"]
    assert h[0] <= e[1] and e[0] <= h[1]
    # Skipped steps are emitted at their release: F, G at end(E) = 36; I at G(H) = 38.
    assert _skipped(o)["PDD-F"] == 36
    assert _skipped(o)["PDD-G"] == 36
    assert _skipped(o)["PDD-I"] == 38
    assert o.end_week == 44
    assert o.unconstrained_end_week == 44


def test_overlap_across_skipped_predecessor_anchors_on_nearest_non_skipped() -> None:
    """o = 10 would give 37 - 10 = 27; the start anchor SG(H) = {E} (walking
    through skipped G, F) holds H at start(E) = 33."""

    p = _project(step_timing=(_t("PDD-H", overlap=10),))
    plan = _plan(p)
    assert plan.start_anchor_ids("PDD-H") == ("PDD-E",)
    _, by_id = _run(_si(p))
    assert _weeks(by_id["p"]) == LAB_PARALLEL_WEEKS


def test_elapsed_overlap_ending_before_its_predecessor_successor_waits_for_both() -> None:
    _, by_id = _run(_si(ELAPSED_CHAIN))
    o = by_id["p"]
    assert _weeks(o) == ELAPSED_CHAIN_WEEKS
    # L ends (44) before K (45): the last step in sequence order is not
    # necessarily the last to end; completion is the max end.
    assert o.end_week == 47


def test_design_on_design_overlap_is_serialised_by_the_leader() -> None:
    _, by_id = _run(_si(DESIGN_ON_DESIGN))
    assert _weeks(by_id["p"]) == BASELINE
    # Unlimited resources still serialise nothing but the leader is the same
    # engineer, so the unconstrained walk *does* overlap (gate 32 -> E 32-35,
    # H 36-41, ... N 47): unconstrained <= constrained.
    assert by_id["p"].unconstrained_end_week == 47
    assert by_id["p"].end_week == 48


def test_overlap_with_floor_floor_still_wins() -> None:
    """gate(H) = 33 but the ADR 0019 floor 35 is later: H 35-40."""

    p = _project(step_timing=(_t("PDD-H", overlap=4, not_before=35),))
    _, by_id = _run(_si(p))
    w = _weeks(by_id["p"])
    assert w["PDD-H"] == (35, 40)
    assert w["PDD-J"] == (41, 41)


def test_overlap_waits_for_capacity() -> None:
    """A higher-priority project holds the only chamber; the overlapping lab
    step searches forward from its gate like any other step."""

    blocker = _project(
        "a-blocker",
        leader_engineer_id="eng-b",
        step_timing=(_t("PDD-H", not_before=31),),
    )
    # blocker: A 31 D 32 E 33-36 on eng-b, H 37-42 (floor 31 is below precedence).
    eng_b = EngineerInput("eng-b", "B", "R&D-Greece", ("A+", "A", "B", "C"))
    p = replace(LAB_PARALLEL, project_id="z-p", priority="P2")
    si = _si(blocker, p, engineers=(ENG_A, eng_b))
    _, by_id = _run(si)
    assert _weeks(by_id["a-blocker"])["PDD-H"] == (37, 42)
    # z-p's H gate is 33, the chamber is busy 37-42, so a 6-week window
    # starting at 33 collides; the first free window is 43-48.
    assert _weeks(by_id["z-p"])["PDD-H"] == (43, 48)
    assert _weeks(by_id["z-p"])["PDD-J"] == (49, 49)


def test_first_step_overlap_rejected() -> None:
    p = _project(step_timing=(_t("PDD-A", overlap=1),))
    with pytest.raises(ValueError, match="first step"):
        run_greedy_sgs(_si(p))


@pytest.mark.parametrize("value", [-1, OVERLAP_MAX_WEEKS + 1])
def test_overlap_out_of_range_rejected(value: int) -> None:
    p = _project(step_timing=(_t("PDD-H", overlap=value),))
    with pytest.raises(ValueError, match="overlap_weeks"):
        run_greedy_sgs(_si(p))


def test_overlap_bounds_inclusive() -> None:
    p = _project(step_timing=(_t("PDD-H", overlap=OVERLAP_MAX_WEEKS),))
    _, by_id = _run(_si(p))
    # Clamped by the start anchor: same as o = 4.
    assert _weeks(by_id["p"]) == LAB_PARALLEL_WEEKS
    zero_first = _project(step_timing=(_t("PDD-A", overlap=0),))
    _run(_si(zero_first))


def test_overlap_on_skipped_step_is_ignored() -> None:
    p = _project(step_timing=(_t("PDD-F", overlap=3),))
    assert _plan(p).steps["PDD-F"].overlap_weeks == 0
    _, by_id = _run(_si(p))
    assert _weeks(by_id["p"]) == BASELINE


def test_frozen_project_ignores_overlap() -> None:
    frozen = _project(frozen=True, actual_start_week=31, step_timing=(_t("PDD-H", overlap=4),))
    plan = _plan(frozen)
    assert all(sp.overlap_weeks == 0 for sp in plan.steps.values())
    _, by_id = _run(_si(frozen))
    assert _weeks(by_id["p"]) == BASELINE


def test_in_progress_tail_with_overlap_keeps_running_in_parallel() -> None:
    """A Done 20, D Done 21, E In Progress from 29 (4 of 4 weeks left -> tail
    31-34), H In Progress from 30 with 3 weeks left and o = 4.

    Without the overlap: tail = max(31, end(E) + 1 = 35, 30) = 35 -> H 30..37.
    With it: gate = max(35 - 4, start(E) = 29, 31) = 31 -> tail 31-33, H 30..33.
    G(H) = max(33, 34) = 34 -> I at 34, J 35, K 36-37, L 38, M 39, N 40."""

    prog = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
        progress("PDD-D", "Done", percent_complete=100, actual_start_week=21, actual_end_week=21),
        progress("PDD-E", "In Progress", percent_complete=0, actual_start_week=29),
        progress("PDD-H", "In Progress", percent_complete=50, actual_start_week=30),
    )
    p = _project(step_progress=prog, step_timing=(_t("PDD-H", overlap=4),))
    assert _plan(p).steps["PDD-H"].overlap_weeks == 4  # kept on a started step
    _, by_id = _run(_si(p))
    w = _weeks(by_id["p"])
    assert w["PDD-E"] == (29, 34)
    assert w["PDD-H"] == (30, 33)
    assert _skipped(by_id["p"])["PDD-I"] == 34
    assert w["PDD-J"] == (35, 35)
    assert w["PDD-N"] == (40, 40)
    assert by_id["p"].unconstrained_end_week == 40

    no_overlap = _project(step_progress=prog)
    _, base = _run(_si(no_overlap))
    assert _weeks(base["p"])["PDD-H"] == (30, 37)


def test_blocked_hold_uses_gate() -> None:
    """E In Progress 29 (tail 31-34); H Blocked from 30 with o = 4: the hold
    frontier is max(31, gate = 31, 30) = 31 -> H shown 30..30 and held."""

    prog = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
        progress("PDD-D", "Done", percent_complete=100, actual_start_week=21, actual_end_week=21),
        progress("PDD-E", "In Progress", percent_complete=0, actual_start_week=29),
        progress("PDD-H", "Blocked", percent_complete=50, actual_start_week=30),
    )
    p = _project(step_progress=prog, step_timing=(_t("PDD-H", overlap=4),))
    _, by_id = _run(_si(p))
    assert _weeks(by_id["p"])["PDD-H"] == (30, 30)
    assert by_id["p"].blocked is True
    _, base = _run(_si(_project(step_progress=prog)))
    assert _weeks(base["p"])["PDD-H"] == (30, 34)


def test_unconstrained_finish_uses_release_and_gate() -> None:
    assert unconstrained_end_week(_plan(LAB_PARALLEL), CW) == 44
    assert unconstrained_end_week(_plan(ELAPSED_CHAIN), CW) == 47
    assert unconstrained_end_week(_plan(_project()), CW) == 48


def test_supplied_order_and_determinism() -> None:
    p1 = _project(step_timing=(_t("PDD-L", overlap=2), _t("PDD-H", overlap=4)))
    p2 = _project(step_timing=(_t("PDD-H", overlap=4), _t("PDD-L", overlap=2)))
    a, b = run_greedy_sgs(_si(p1)), run_greedy_sgs(_si(p2))
    assert repr(a) == repr(b)
    assert repr(a) == repr(run_greedy_sgs(_si(p1)))


# --- Canonical form / hash ------------------------------------------------------


def test_canonical_form_omits_zero_overlap() -> None:
    row = _t("PDD-H", duration=3)
    assert canonical_step_timing_dict(row) == {
        "step_id": "PDD-H",
        "duration_override_weeks": 3,
        "start_not_before_week": None,
    }
    # Same keys as the pre-P32 asdict of a row (without the new field).
    pre = {k: v for k, v in dataclasses.asdict(row).items() if k != "overlap_weeks"}
    assert canonical_step_timing_dict(row) == pre
    assert canonical_step_timing_dict(_t("PDD-H", overlap=2))["overlap_weeks"] == 2
    # An overlap-only row is kept; an all-empty row is dropped.
    assert canonical_step_timing((_t("PDD-K"), _t("PDD-H", overlap=2))) == (_t("PDD-H", overlap=2),)


def test_default_overlap_is_zero() -> None:
    row = StepTimingInput("PDD-H", None, None)
    assert row.overlap_weeks == 0
    assert [f.name for f in dataclasses.fields(StepTimingInput)][-1] == "overlap_weeks"


# --- CP-SAT agreement ------------------------------------------------------------


@pytest.mark.parametrize(
    ("project", "expected", "slack"),
    [
        (LAB_PARALLEL, LAB_PARALLEL_WEEKS, ()),
        # L is off the critical path (G(L) = 45 whether L sits at 44 or 45),
        # and the CP-SAT earliness pass minimises finish weeks only.
        (ELAPSED_CHAIN, ELAPSED_CHAIN_WEEKS, ("PDD-L",)),
        (DESIGN_ON_DESIGN, BASELINE, ()),
    ],
    ids=["lab-parallel", "elapsed-chain", "design-on-design"],
)
def test_cp_sat_agrees_with_greedy_on_overlap(
    project: ProjectInput, expected: dict[str, tuple[int, int]], slack: tuple[str, ...]
) -> None:
    si = _si(project)
    _, greedy = _run(si)
    _, cp = _cp_sat_weeks(si)
    assert _weeks(greedy["p"]) == expected
    cp_weeks = _weeks(cp["p"])
    assert {k: v for k, v in cp_weeks.items() if k not in slack} == {
        k: v for k, v in expected.items() if k not in slack
    }
    if slack:
        assert cp_weeks["PDD-L"] in ((44, 44), (45, 45))
    assert cp["p"].end_week == greedy["p"].end_week
    assert cp["p"].unconstrained_end_week == greedy["p"].unconstrained_end_week


def test_cp_sat_in_progress_overlap_agrees() -> None:
    prog = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
        progress("PDD-D", "Done", percent_complete=100, actual_start_week=21, actual_end_week=21),
        progress("PDD-E", "In Progress", percent_complete=0, actual_start_week=29),
        progress("PDD-H", "In Progress", percent_complete=50, actual_start_week=30),
    )
    p = _project(step_progress=prog, step_timing=(_t("PDD-H", overlap=4), _t("PDD-L", overlap=2)))
    si = _si(p)
    _, greedy = _run(si)
    _, cp = _cp_sat_weeks(si)
    # Pre-booked tails are shared code: identical. The rest agrees on finish.
    assert _weeks(cp["p"])["PDD-E"] == _weeks(greedy["p"])["PDD-E"] == (29, 34)
    assert _weeks(cp["p"])["PDD-H"] == _weeks(greedy["p"])["PDD-H"] == (30, 33)
    assert cp["p"].end_week == greedy["p"].end_week


def test_cp_sat_overlap_with_contention_respects_invariants() -> None:
    eng_b = EngineerInput("eng-b", "B", "R&D-Greece", ("A+", "A", "B", "C"))
    projects = (
        _project("p1", step_timing=(_t("PDD-H", overlap=4),)),
        _project("p2", priority="P2", step_timing=(_t("PDD-H", overlap=3), _t("PDD-L", overlap=2))),
        _project("p3", priority="P3", leader_engineer_id="eng-b"),
    )
    si = _si(*projects, engineers=(ENG_A, eng_b))
    _run(si)
    _cp_sat_weeks(si)


def test_cp_sat_zero_overlap_is_byte_identical() -> None:
    """A zero overlap row leaves the CP-SAT result byte-identical."""

    base = _si(_project("p1"), _project("p2", priority="P2"))
    zero = _si(
        _project("p1", step_timing=(_t("PDD-H", overlap=0),)),
        _project("p2", priority="P2", step_timing=(_t("PDD-K", overlap=0),)),
    )
    a, _ = run_cp_sat(base, deterministic_time=2.0, earliness_deterministic_time=1.0)
    b, _ = run_cp_sat(zero, deterministic_time=2.0, earliness_deterministic_time=1.0)
    assert repr(a) == repr(b)


# --- Invariants (negative) ------------------------------------------------------


def test_i27_detects_start_before_gate() -> None:
    si = _si(LAB_PARALLEL)
    out = run_greedy_sgs(si)
    # H moved to 32-37: before start(E) = 33 (the step it runs in parallel with).
    bad = _broken(out, "p", "PDD-H", start_week=32, end_week=37)
    assert "I27" in _ids(validate_invariants(si, bad, check_determinism=False))


def test_i27_detects_overlap_larger_than_set() -> None:
    p = _project(step_timing=(_t("PDD-L", overlap=1),))
    si = _si(p)
    out = run_greedy_sgs(si)
    # gate(L) = 46 - 1 = 45; L at 44 overlaps 2 weeks.
    assert {s.step_id: s.start_week for s in out.project_outcomes[0].steps}["PDD-L"] == 45
    bad = _broken(out, "p", "PDD-L", start_week=44, end_week=44)
    assert "I27" in _ids(validate_invariants(si, bad, check_determinism=False))


def test_i3_via_g_detects_successor_not_waiting_for_passed_on_work() -> None:
    """L (o = 2) ends 44 but passes K's end 45 on; M at 45 starts after L ends
    yet before G(L) + 1 = 46 — a violation the pre-P32 edge check would miss."""

    si = _si(ELAPSED_CHAIN)
    out = run_greedy_sgs(si)
    bad = _broken(out, "p", "PDD-M", start_week=45, end_week=45)
    ids = _ids(validate_invariants(si, bad, check_determinism=False))
    assert "I3" in ids and "I15" in ids


def test_i21_in_progress_tail_with_overlap_checked_against_gate() -> None:
    prog = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
        progress("PDD-D", "Done", percent_complete=100, actual_start_week=21, actual_end_week=21),
        progress("PDD-E", "In Progress", percent_complete=0, actual_start_week=29),
        progress("PDD-H", "In Progress", percent_complete=50, actual_start_week=30),
    )
    p = _project(step_progress=prog, step_timing=(_t("PDD-H", overlap=4),))
    si = _si(p)
    out = run_greedy_sgs(si)
    # The pre-P32 tail (30..37) is now wrong: the tail must start at gate 31.
    bad = _broken(out, "p", "PDD-H", end_week=37)
    assert "I21" in _ids(validate_invariants(si, bad, check_determinism=False))


# --- Seeded fuzz: random overlaps, both solvers, the full validator -------------


def _fuzz_inputs(seed: int) -> ScheduleInput:
    import random

    rng = random.Random(seed)
    steps = [s for s in default_workflow_templates() if s.workflow_id == "PDD"]
    non_first = [s.step_id for s in steps if s.predecessor_ids]
    eng_b = EngineerInput("eng-b", "B", "R&D-Greece", ("A+", "A", "B", "C"))
    projects = []
    for i in range(4):
        chosen = sorted(rng.sample(non_first, 3))
        timing = tuple(_t(sid, overlap=rng.randint(0, 6)) for sid in chosen)
        projects.append(
            _project(
                f"p{i}",
                category=rng.choice(["A", "B", "C"]),
                priority=rng.choice(["P1", "P2", "P3"]),
                leader_engineer_id=rng.choice(["eng-a", "eng-b"]),
                step_timing=timing,
            )
        )
    return _si(*projects, engineers=(ENG_A, eng_b))


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
def test_fuzz_overlaps_hold_every_invariant(seed: int) -> None:
    si = _fuzz_inputs(seed)
    out, by_id = _run(si)
    cp, cp_by_id = _cp_sat_weeks(si)
    for pid, o in by_id.items():
        if o.end_week is not None and o.unconstrained_end_week is not None:
            assert o.unconstrained_end_week <= o.end_week
        assert cp_by_id[pid].unconstrained_end_week == o.unconstrained_end_week
    assert repr(out) == repr(run_greedy_sgs(si))
