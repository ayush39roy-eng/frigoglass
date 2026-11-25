"""P33-T02 — per-project `lead_weeks` and `wait_weeks` (ADR 0046 as ruled:
R33-1 eff, R33-4 signed gap, R33-5 CP-SAT / Monte Carlo, R33-6 one-leader
unconstrained finish, R33-7 canonical form; DOMAIN_RULES "Category templates"
§B/§D, I27 rev., I28, I29).

Every expected week is hand-derived with CURRENT_WEEK = 31, HORIZON_WEEKS = 78,
the default strict chain and the default lead-time table. The base project is
PDD / B (as in the P12 and P32 suites):

    step:  A B C D E F G H I J K L M N
    lead:  1 0 0 1 4 0 0 6 0 1 2 1 1 1
    kind:  d d e d d l e l d d d e d e   (d design, l lab, e elapsed)

With no timing it books A 31, D 32, E 33-36, H 37-42, J 43, K 44-45, L 46,
M 47, N 48 (B/C/F/G/I skipped and transparent).

    gate(s) = release(s) + 1 + w(s)                                  if o(s) = 0
            = max(release(s) + 1 - o(s), max start of SG(s), frontier)  if o(s) > 0
"""

from __future__ import annotations

import dataclasses
from dataclasses import replace

import pytest

from scheduling import (
    LEAD_MAX_WEEKS,
    WAIT_MAX_WEEKS,
    ChamberInput,
    EngineerInput,
    InvariantViolation,
    LeadTime,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepTimingInput,
    WorkflowStepTemplate,
    analyse_project,
    build_lead_time_table,
    build_workflows,
    canonical_schedule_input_asdict,
    canonical_step_timing,
    canonical_step_timing_dict,
    check_wait_invariance,
    compute_design_load_by_hub,
    compute_lab_load_by_hub,
    effective_lead_weeks,
    run_cp_sat,
    run_greedy_sgs,
    unconstrained_end_week,
    validate_invariants,
    without_waits,
)
from scheduling.monte_carlo import _perturbed_step_timing
from scheduling.plan_import import StepEdit, _edit_plan_project
from scheduling.types import default_lead_times, default_workflow_templates
from scheduling.workflow import first_free_week
from tests.scheduling._fixtures import progress

CW = 31
ENG_A = EngineerInput("eng-a", "A", "R&D-Greece", ("A+", "A", "B", "C"))
ENG_B = EngineerInput("eng-b", "B", "R&D-Greece", ("A+", "A", "B", "C"))
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
    wait: int = 0,
    lead: int | None = None,
    overlap: int = 0,
    duration: int | None = None,
    not_before: int | None = None,
) -> StepTimingInput:
    return StepTimingInput(
        step_id=step_id,
        duration_override_weeks=duration,
        start_not_before_week=not_before,
        overlap_weeks=overlap,
        wait_weeks=wait,
        lead_weeks=lead,
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


def _cp(si: ScheduleInput) -> dict[str, ProjectScheduleOutcome]:
    out, _info = run_cp_sat(si, deterministic_time=5.0, earliness_deterministic_time=2.0)
    assert validate_invariants(si, out, check_determinism=False) == ()
    return {o.project_id: o for o in out.project_outcomes}


def _weeks(outcome: ProjectScheduleOutcome) -> dict[str, tuple[int, int]]:
    return {s.step_id: (s.start_week, s.end_week) for s in outcome.steps if not s.skipped}


def _skipped(outcome: ProjectScheduleOutcome) -> dict[str, int]:
    return {s.step_id: s.start_week for s in outcome.steps if s.skipped}


def _ids(violations: tuple[InvariantViolation, ...]) -> set[str]:
    return {v.invariant for v in violations}


def _broken(out: ScheduleOutput, pid: str, step_id: str, **kw: object) -> ScheduleOutput:
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


def _shift(weeks: dict[str, tuple[int, int]], by: int, *ids: str) -> dict[str, tuple[int, int]]:
    return {k: ((s + by, e + by) if k in ids else (s, e)) for k, (s, e) in weeks.items()}


_AFTER_E = ("PDD-E", "PDD-H", "PDD-J", "PDD-K", "PDD-L", "PDD-M", "PDD-N")

# --- Fixtures (hand-derived) -----------------------------------------------------

#: E (design) waits 2: release(E) = end(D) = 32, gate = 32 + 1 + 2 = 35 -> E 35-38,
#: and everything after it moves 2 weeks.
WAIT_DESIGN = _project(step_timing=(_t("PDD-E", wait=2),))
WAIT_DESIGN_WEEKS = _shift(BASELINE, 2, *_AFTER_E)

#: H (lab) waits 3: release(H) = G(G) = G(F) = end(E) = 36 (F, G skipped),
#: gate = 40 -> H 40-45, J 46, K 47-48, L 49, M 50, N 51.
WAIT_LAB = _project(step_timing=(_t("PDD-H", wait=3),))
WAIT_LAB_WEEKS = _shift(BASELINE, 3, *_AFTER_E[1:])

#: L (elapsed) waits 2: release(L) = end(K) = 45, gate 48 -> L 48, M 49, N 50.
WAIT_ELAPSED = _project(step_timing=(_t("PDD-L", wait=2),))
WAIT_ELAPSED_WEEKS = _shift(BASELINE, 2, "PDD-L", "PDD-M", "PDD-N")


# --- Greedy golden files ---------------------------------------------------------


def test_zero_wait_and_no_lead_is_the_unchanged_baseline() -> None:
    p = _project(step_timing=(_t("PDD-H", wait=0), _t("PDD-K", lead=None)))
    _, by_id = _run(_si(p))
    assert _weeks(by_id["p"]) == BASELINE
    _, base = _run(_si(_project()))
    assert repr(by_id["p"]) == repr(base["p"])


@pytest.mark.parametrize(
    ("project", "expected"),
    [
        (WAIT_DESIGN, WAIT_DESIGN_WEEKS),
        (WAIT_LAB, WAIT_LAB_WEEKS),
        (WAIT_ELAPSED, WAIT_ELAPSED_WEEKS),
    ],
    ids=["design", "lab", "elapsed"],
)
def test_wait_delays_the_step_by_exactly_w(
    project: ProjectInput, expected: dict[str, tuple[int, int]]
) -> None:
    _, by_id = _run(_si(project))
    assert _weeks(by_id["p"]) == expected
    # A wait books nothing: effort durations are those of the baseline.
    durations = {s.step_id: s.duration_weeks for s in by_id["p"].steps}
    _, base = _run(_si(_project()))
    assert durations == {s.step_id: s.duration_weeks for s in base["p"].steps}
    # Unlimited resources do not lift a wait (a plan input): unconstrained = end.
    assert by_id["p"].unconstrained_end_week == by_id["p"].end_week


def test_wait_and_capacity() -> None:
    """A higher-priority project holds the only chamber 37-42. z-p's H waits 3
    (gate 40): the chamber is busy, so H searches forward to 43-48 — the same
    window as with no wait (the wait costs nothing here). With a wait of 8
    (gate 45) the chamber is free from 43, so H starts at its gate: 45-50."""

    blocker = _project("a-blocker", leader_engineer_id="eng-b")
    engineers = (ENG_A, ENG_B)
    w3 = _project("z-p", priority="P2", step_timing=(_t("PDD-H", wait=3),))
    _, by_id = _run(_si(blocker, w3, engineers=engineers))
    assert _weeks(by_id["a-blocker"])["PDD-H"] == (37, 42)
    assert _weeks(by_id["z-p"])["PDD-H"] == (43, 48)
    _, no_wait = _run(_si(blocker, replace(w3, step_timing=()), engineers=engineers))
    assert _weeks(no_wait["z-p"])["PDD-H"] == (43, 48)

    w8 = replace(w3, step_timing=(_t("PDD-H", wait=8),))
    _, by_id8 = _run(_si(blocker, w8, engineers=engineers))
    assert _weeks(by_id8["z-p"])["PDD-H"] == (45, 50)
    assert _weeks(by_id8["z-p"])["PDD-J"] == (51, 51)


_DONE_TO_E = (
    progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
    progress("PDD-D", "Done", percent_complete=100, actual_start_week=21, actual_end_week=21),
    progress("PDD-E", "Done", percent_complete=100, actual_start_week=22, actual_end_week=25),
)


def test_wait_already_elapsed_costs_nothing() -> None:
    """E ended at 25, so release(H) = 25. A wait of 3 gives gate 29 < CURRENT_WEEK
    31: H still starts at 31. A wait of 8 gives gate 34: H 34-39."""

    _, plain = _run(_si(_project(step_progress=_DONE_TO_E)))
    assert _weeks(plain["p"])["PDD-H"] == (31, 36)
    p3 = _project(step_progress=_DONE_TO_E, step_timing=(_t("PDD-H", wait=3),))
    _, by_id = _run(_si(p3))
    assert _weeks(by_id["p"]) == _weeks(plain["p"])
    p8 = _project(step_progress=_DONE_TO_E, step_timing=(_t("PDD-H", wait=8),))
    _, by_id8 = _run(_si(p8))
    assert _weeks(by_id8["p"])["PDD-H"] == (34, 39)


def test_wait_counts_against_the_horizon() -> None:
    """N (elapsed) waits 40: release 47, gate 88 > HORIZON 78 -> LEFT_OUT."""

    p = _project(step_timing=(_t("PDD-N", wait=40),))
    _, by_id = _run(
        _si(p, horizon_weeks=78)
    )  # P53: overflow golden, pinned at the pre-P53 78-week search
    assert by_id["p"].left_out is True
    assert by_id["p"].projected_end_week is None
    assert "PDD-N" not in _weeks(by_id["p"])
    assert _weeks(by_id["p"])["PDD-M"] == (47, 47)


def test_in_progress_tail_ignores_the_wait() -> None:
    prog = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
        progress("PDD-D", "Done", percent_complete=100, actual_start_week=21, actual_end_week=21),
        progress("PDD-E", "In Progress", percent_complete=50, actual_start_week=29),
    )
    _, plain = _run(_si(_project(step_progress=prog)))
    waited = _project(step_progress=prog, step_timing=(_t("PDD-E", wait=5),))
    _, by_id = _run(_si(waited))
    assert _weeks(by_id["p"]) == _weeks(plain["p"])
    assert _weeks(by_id["p"])["PDD-E"] == (29, 32)  # tail 31-32 (remaining 2)
    plan = analyse_project(
        waited,
        build_workflows(default_workflow_templates())["PDD"],
        build_lead_time_table(default_lead_times()),
    )
    assert plan.steps["PDD-E"].wait_weeks == 0


def test_blocked_hold_ignores_the_wait() -> None:
    prog = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
        progress("PDD-D", "Blocked", percent_complete=0, actual_start_week=30),
    )
    _, plain = _run(_si(_project(step_progress=prog)))
    waited = _project(step_progress=prog, step_timing=(_t("PDD-E", wait=4), _t("PDD-H", wait=2)))
    _, by_id = _run(_si(waited))
    assert by_id["p"].blocked is True
    # The held rows are emitted at their release: the waits change nothing...
    assert by_id["p"].steps == plain["p"].steps
    # ...while the unconstrained finish, which assumes the block clears now,
    # places E and H as Not Started steps and honours their waits (4 + 2).
    assert plain["p"].unconstrained_end_week == 47
    assert by_id["p"].unconstrained_end_week == 53


def test_skipped_steps_gap_is_ignored() -> None:
    """F (lab) and G (elapsed) have lead 0 for B: their waits do nothing."""

    p = _project(step_timing=(_t("PDD-F", wait=5), _t("PDD-G", wait=3)))
    _, by_id = _run(_si(p))
    assert _weeks(by_id["p"]) == BASELINE
    assert _skipped(by_id["p"])["PDD-F"] == 36


def test_frozen_project_ignores_wait_and_honours_lead() -> None:
    """Frozen at 31: E's wait is ignored (I10) and its lead_weeks 2 is used
    (a duration, not timing): E 33-34, H 35-40, ..."""

    p = _project(
        frozen=True,
        actual_start_week=31,
        step_timing=(_t("PDD-E", wait=3, lead=2), _t("PDD-H", wait=4)),
    )
    _, by_id = _run(_si(p))
    weeks = _weeks(by_id["p"])
    assert weeks["PDD-E"] == (33, 34)
    assert weeks["PDD-H"] == (35, 40)
    assert weeks["PDD-N"] == (46, 46)


# --- Per-project lead (R33-1) ------------------------------------------------------


def test_lead_zero_to_n_revives_a_step() -> None:
    """F (lab) has lead 0 for B; lead_weeks 2 revives it: release(F) = 36,
    F 37-38, G (skipped) at 38, H 39-44, J 45, K 46-47, L 48, M 49, N 50."""

    p = _project(step_timing=(_t("PDD-F", lead=2),))
    out, by_id = _run(_si(p))
    weeks = _weeks(by_id["p"])
    assert weeks["PDD-F"] == (37, 38)
    assert by_id["p"].steps[5].assigned_chamber_id == "ch-gr"
    assert _skipped(by_id["p"])["PDD-G"] == 38
    assert weeks == {**_shift(BASELINE, 2, *_AFTER_E[1:]), "PDD-F": (37, 38)}
    assert compute_lab_load_by_hub(_si(p), out) == {"R&D-Greece": 8.0}


def test_lead_n_to_zero_skips_a_step() -> None:
    """E lead_weeks 0: E is skipped at 32, H 33-38, J 39, K 40-41, L 42, M 43, N 44."""

    p = _project(step_timing=(_t("PDD-E", lead=0),))
    _, by_id = _run(_si(p))
    assert _skipped(by_id["p"])["PDD-E"] == 32
    expected = {k: v for k, v in _shift(BASELINE, -4, *_AFTER_E[1:]).items() if k != "PDD-E"}
    assert _weeks(by_id["p"]) == expected
    assert expected["PDD-H"] == (33, 38)
    assert expected["PDD-N"] == (44, 44)


def test_override_beats_lead_and_lead_zero_beats_override() -> None:
    # lead 6, override 2: eff = 2 -> E 33-34.
    p = _project(step_timing=(_t("PDD-E", lead=6, duration=2),))
    _, by_id = _run(_si(p))
    assert _weeks(by_id["p"])["PDD-E"] == (33, 34)
    e_row = next(s for s in by_id["p"].steps if s.step_id == "PDD-E")
    assert e_row.duration_weeks == 2
    # lead 0, override 3: eff = 0 (an override never revives a lead-0 step).
    q = _project(step_timing=(_t("PDD-E", lead=0, duration=3),))
    _, by_q = _run(_si(q))
    assert "PDD-E" not in _weeks(by_q["p"])
    # lead 5 alone: E 33-37.
    r = _project(step_timing=(_t("PDD-E", lead=5),))
    _, by_r = _run(_si(r))
    assert _weeks(by_r["p"])["PDD-E"] == (33, 37)


def test_lab_lead_with_certification_off_stays_skipped() -> None:
    p = _project(certification_testing_required=False, step_timing=(_t("PDD-H", lead=9),))
    _, by_id = _run(_si(p))
    assert "PDD-H" not in _weeks(by_id["p"])


def test_effective_lead_weeks_helper() -> None:
    assert effective_lead_weeks(None, 4) == 4
    assert effective_lead_weeks(_t("PDD-E"), 4) == 4
    assert effective_lead_weeks(_t("PDD-E", lead=0), 4) == 0
    assert effective_lead_weeks(_t("PDD-E", lead=7), 4) == 7


# --- Validation (R33-4) --------------------------------------------------------------


@pytest.mark.parametrize(
    ("row", "match"),
    [
        (_t("PDD-E", wait=2, overlap=1), "both non-zero"),
        (_t("PDD-A", wait=1), "first step"),
        (_t("PDD-E", wait=WAIT_MAX_WEEKS + 1), "wait_weeks"),
        (_t("PDD-E", wait=-1), "wait_weeks"),
        (_t("PDD-E", wait=True), "wait_weeks"),  # type: ignore[arg-type]
        (_t("PDD-E", lead=LEAD_MAX_WEEKS + 1), "lead_weeks"),
        (_t("PDD-E", lead=-1), "lead_weeks"),
        (_t("PDD-E", lead=False), "lead_weeks"),  # type: ignore[arg-type]
    ],
    ids=[
        "overlap-and-wait",
        "first-step",
        "wait-high",
        "wait-negative",
        "wait-bool",
        "lead-high",
        "lead-negative",
        "lead-bool",
    ],
)
def test_invalid_rows_rejected(row: StepTimingInput, match: str) -> None:
    with pytest.raises(ValueError, match=match):
        run_greedy_sgs(_si(_project(step_timing=(row,))))


def test_first_step_lead_is_allowed() -> None:
    """A first step may carry its own lead (only its gap must be 0)."""

    _, by_id = _run(_si(_project(step_timing=(_t("PDD-A", lead=3),))))
    assert _weeks(by_id["p"])["PDD-A"] == (31, 33)


# --- I28 as a difference test --------------------------------------------------------


def _rows(out: ScheduleOutput) -> dict[tuple[str, str], tuple[int, bool]]:
    return {
        (o.project_id, s.step_id): (s.duration_weeks, s.skipped)
        for o in out.project_outcomes
        for s in o.steps
    }


def test_wait_changes_no_duration_load_or_weight() -> None:
    prog = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
    )
    p1_timing = (_t("PDD-E", wait=3), _t("PDD-L", wait=2))
    waited = (
        _project("p1", step_progress=prog, step_timing=p1_timing),
        _project(
            "p2", priority="P2", leader_engineer_id="eng-b", step_timing=(_t("PDD-H", wait=6),)
        ),
    )
    si = _si(*waited, engineers=(ENG_A, ENG_B))
    stripped = without_waits(si)
    assert stripped is not si
    assert without_waits(stripped) is stripped
    a, b = run_greedy_sgs(si), run_greedy_sgs(stripped)
    assert validate_invariants(si, a) == ()
    assert _rows(a) == _rows(b)
    assert [o.progress_pct for o in a.project_outcomes] == [
        o.progress_pct for o in b.project_outcomes
    ]
    assert compute_design_load_by_hub(si, a) == compute_design_load_by_hub(stripped, b)
    assert compute_lab_load_by_hub(si, a) == compute_lab_load_by_hub(stripped, b)
    assert check_wait_invariance(si) == ()
    # But the waits did move work later.
    assert a.project_outcomes[0].end_week > b.project_outcomes[0].end_week  # type: ignore[operator]


def test_check_wait_invariance_is_a_no_op_without_waits() -> None:
    si = _si(_project())
    assert without_waits(si) is si
    assert check_wait_invariance(si) == ()


def test_check_wait_invariance_ignores_malformed_input() -> None:
    bad = _si(_project(step_timing=(_t("PDD-E", wait=2, overlap=1),)))
    assert check_wait_invariance(bad) == ()


# --- CP-SAT agrees with greedy (R33-5) ------------------------------------------------


@pytest.mark.parametrize(
    ("project", "expected"),
    [
        (WAIT_DESIGN, WAIT_DESIGN_WEEKS),
        (WAIT_LAB, WAIT_LAB_WEEKS),
        (WAIT_ELAPSED, WAIT_ELAPSED_WEEKS),
        (
            _project(step_timing=(_t("PDD-F", lead=2),)),
            {**_shift(BASELINE, 2, *_AFTER_E[1:]), "PDD-F": (37, 38)},
        ),
    ],
    ids=["design", "lab", "elapsed", "lead-revives"],
)
def test_cp_sat_agrees_with_greedy_on_waits(
    project: ProjectInput, expected: dict[str, tuple[int, int]]
) -> None:
    si = _si(project)
    _, greedy = _run(si)
    cp = _cp(si)
    assert _weeks(greedy["p"]) == expected
    assert _weeks(cp["p"]) == expected
    assert cp["p"].unconstrained_end_week == greedy["p"].unconstrained_end_week


def test_cp_sat_wait_with_capacity_agrees() -> None:
    blocker = _project("a-blocker", leader_engineer_id="eng-b")
    w8 = _project("z-p", priority="P2", step_timing=(_t("PDD-H", wait=8),))
    si = _si(blocker, w8, engineers=(ENG_A, ENG_B))
    _, greedy = _run(si)
    cp = _cp(si)
    assert _weeks(cp["z-p"])["PDD-H"] == _weeks(greedy["z-p"])["PDD-H"] == (45, 50)
    assert cp["z-p"].end_week == greedy["z-p"].end_week


def test_cp_sat_wait_to_left_out_agrees() -> None:
    si = _si(
        _project(step_timing=(_t("PDD-N", wait=40),)), horizon_weeks=78
    )  # P53: overflow golden, pinned at the pre-P53 78-week search
    _, greedy = _run(si)
    cp = _cp(si)
    assert greedy["p"].left_out and cp["p"].left_out
    # P53 (R53-2 / R53-5): with the default H = cw + 260 both place it.
    si = _si(_project(step_timing=(_t("PDD-N", wait=40),)))
    _, greedy = _run(si)
    cp = _cp(si)
    assert not greedy["p"].left_out and not cp["p"].left_out
    assert greedy["p"].end_week == cp["p"].end_week == 88


def test_cp_sat_zero_wait_is_byte_identical() -> None:
    base = _si(_project("p1"), _project("p2", priority="P2"))
    zero = _si(
        _project("p1", step_timing=(_t("PDD-H", wait=0),)),
        _project("p2", priority="P2", step_timing=(_t("PDD-K", lead=None),)),
    )
    a, _ = run_cp_sat(base, deterministic_time=2.0, earliness_deterministic_time=1.0)
    b, _ = run_cp_sat(zero, deterministic_time=2.0, earliness_deterministic_time=1.0)
    assert repr(a) == repr(b)


# --- Unconstrained finish: the one-leader rule (R33-6) ----------------------------------


def _parallel_design_workflow() -> tuple[tuple[WorkflowStepTemplate, ...], tuple[LeadTime, ...]]:
    """PDD-A (design 1) -> {PDD-B (design 2), PDD-C (design 3)} -> PDD-D (elapsed 1):
    two design branches in parallel, which one leader cannot run at once."""

    def st(sid: str, kind: str, seq: int, preds: tuple[str, ...]) -> WorkflowStepTemplate:
        return WorkflowStepTemplate("PDD", sid, sid, sid, kind, seq, preds)

    steps = (
        st("PDD-A", "design", 1, ()),
        st("PDD-B", "design", 2, ("PDD-A",)),
        st("PDD-C", "design", 3, ("PDD-A",)),
        st("PDD-D", "elapsed", 4, ("PDD-B", "PDD-C")),
    )
    weeks = {"PDD-A": 1, "PDD-B": 2, "PDD-C": 3, "PDD-D": 1}
    leads = tuple(
        LeadTime("PDD", cat, sid, w) for cat in ("A+", "A", "B", "C") for sid, w in weeks.items()
    )
    return steps, leads


def test_unconstrained_one_leader_on_parallel_design_branches() -> None:
    """A 31; B and C both gate at 32. One leader: B 32-33, C 34-36, D 37. The
    unconstrained finish is 37 (it was 35 before R33-6), equal to greedy."""

    steps, leads = _parallel_design_workflow()
    si = _si(_project(), workflow_steps=steps, lead_times=leads)
    _, by_id = _run(si)
    assert _weeks(by_id["p"]) == {
        "PDD-A": (31, 31),
        "PDD-B": (32, 33),
        "PDD-C": (34, 36),
        "PDD-D": (37, 37),
    }
    assert by_id["p"].unconstrained_end_week == 37
    cp = _cp(si)
    assert cp["p"].unconstrained_end_week == 37
    assert cp["p"].end_week == 37


def test_unconstrained_one_leader_on_design_overlap() -> None:
    """E (design) overlaps 2 onto D (design 32): gate = max(33 - 2, 32, 31) = 32,
    but the leader does D at 32, so the unconstrained walk puts E at 33-36, like
    greedy: unconstrained finish 48 = the constrained finish."""

    p = _project(step_timing=(_t("PDD-E", overlap=2),))
    _, by_id = _run(_si(p))
    assert _weeks(by_id["p"]) == BASELINE
    assert by_id["p"].unconstrained_end_week == 48


def test_unconstrained_one_leader_counts_in_progress_tails() -> None:
    """D In Progress (tail 31-32 of remaining 2) and E overlapping D by 3: gate
    = max(33 - 3, start(D) = 30, 31) = 31, but the leader's tail is 31-32, so E
    is placed 33-36 in the unconstrained walk too."""

    prog = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
        progress(
            "PDD-D",
            "In Progress",
            percent_complete=0,
            actual_start_week=30,
            remaining_weeks_override=2,
        ),
    )
    p = _project(step_progress=prog, step_timing=(_t("PDD-E", overlap=3),))
    _, by_id = _run(_si(p))
    assert _weeks(by_id["p"])["PDD-D"] == (30, 32)
    assert _weeks(by_id["p"])["PDD-E"] == (33, 36)
    plan = analyse_project(
        p,
        build_workflows(default_workflow_templates())["PDD"],
        build_lead_time_table(default_lead_times()),
        leader_fte=1.0,
    )
    assert unconstrained_end_week(plan, CW) == by_id["p"].end_week


def test_unconstrained_frozen_project_has_no_leader_rule() -> None:
    """A frozen project keeps its locked dates and has no gaps: no change."""

    p = _project(frozen=True, actual_start_week=31)
    _, by_id = _run(_si(p))
    assert by_id["p"].unconstrained_end_week == 48


def test_first_free_week() -> None:
    assert first_free_week(5, 2, []) == 5
    assert first_free_week(5, 2, [(1, 3)]) == 5
    assert first_free_week(5, 2, [(6, 7)]) == 8
    assert first_free_week(5, 2, [(8, 9), (4, 5)]) == 6  # 6-7 fits before 8
    assert first_free_week(5, 3, [(8, 9), (4, 5)]) == 10
    assert first_free_week(5, 0, [(4, 9)]) == 5


# --- Canonical / hashed form (R33-7) -----------------------------------------------------


def test_canonical_dict_adds_new_keys_only_when_non_default() -> None:
    row = _t("PDD-H", duration=3)
    assert canonical_step_timing_dict(row) == {
        "step_id": "PDD-H",
        "duration_override_weeks": 3,
        "start_not_before_week": None,
    }
    assert canonical_step_timing_dict(_t("PDD-H", wait=2))["wait_weeks"] == 2
    assert canonical_step_timing_dict(_t("PDD-H", lead=0))["lead_weeks"] == 0
    assert "lead_weeks" not in canonical_step_timing_dict(_t("PDD-H", wait=2))
    # A wait-only or lead-only row is kept; an all-default row is dropped.
    rows = (_t("PDD-K"), _t("PDD-H", wait=2), _t("PDD-E", lead=5))
    assert canonical_step_timing(rows) == (_t("PDD-E", lead=5), _t("PDD-H", wait=2))


def test_canonical_schedule_input_asdict_omits_p33_defaults() -> None:
    si = _si(_project(step_timing=(_t("PDD-H", overlap=2), _t("PDD-K", duration=1))))
    data = canonical_schedule_input_asdict(si)
    assert "categories" not in data
    for row in data["projects"][0]["step_timing"]:
        assert set(row) == {
            "step_id",
            "duration_override_weeks",
            "start_not_before_week",
            "overlap_weeks",
        }
    raw = dataclasses.asdict(si)
    del raw["categories"]
    del raw["projects"][0]["band_rank"]  # P36 (R36-1(g)): omitted when None
    del raw["projects"][0]["step_pins"]  # P40 (R40-12): omitted when empty
    del raw["projects"][0]["actual_end_week"]  # P53 (R53-2b): omitted when None
    for row in raw["projects"][0]["step_timing"]:
        del row["wait_weeks"], row["lead_weeks"]
        del row["lab_hold_weeks"]  # P62 (ADR 0071): omitted when None
    for lt in raw["lead_times"]:
        del lt["lab_hold_weeks"]  # P62 (ADR 0071): omitted when None
    assert data == raw
    waited = _si(_project(step_timing=(_t("PDD-H", wait=2, lead=4),)))
    row = canonical_schedule_input_asdict(waited)["projects"][0]["step_timing"][0]
    assert (row["wait_weeks"], row["lead_weeks"]) == (2, 4)


def test_new_fields_default_to_the_pre_p33_values() -> None:
    row = StepTimingInput("PDD-H", None, None)
    assert (row.overlap_weeks, row.wait_weeks, row.lead_weeks) == (0, 0, None)


# --- Monte Carlo never samples gaps (R33-5) ---------------------------------------------


def test_monte_carlo_perturbs_lead_not_gaps() -> None:
    rows = (
        _t("PDD-E", lead=4, wait=3),
        _t("PDD-H", lead=0, overlap=2),
        _t("PDD-K", wait=5),
        _t("PDD-J", duration=2),
    )
    out = {r.step_id: r for r in _perturbed_step_timing(rows, 1.5)}
    assert (out["PDD-E"].lead_weeks, out["PDD-E"].wait_weeks) == (6, 3)
    assert (out["PDD-H"].lead_weeks, out["PDD-H"].overlap_weeks) == (0, 2)  # 0 stays 0
    assert out["PDD-K"] is rows[2]  # nothing to perturb: same row
    assert out["PDD-J"].duration_override_weeks == 3
    low = {r.step_id: r for r in _perturbed_step_timing(rows, 0.01)}
    assert low["PDD-E"].lead_weeks == 1  # R10 floor
    high = {r.step_id: r for r in _perturbed_step_timing((_t("PDD-E", lead=100),), 9.0)}
    assert high["PDD-E"].lead_weeks == 104


# --- Invariants (negative) ----------------------------------------------------------------


def test_i28_detects_a_step_starting_inside_its_wait() -> None:
    si = _si(WAIT_DESIGN)
    out = run_greedy_sgs(si)
    # E moved from 35-38 to 33-36: after D (so I3 holds) but inside the wait.
    bad = _broken(out, "p", "PDD-E", start_week=33, end_week=36)
    assert _ids(validate_invariants(si, bad, check_determinism=False)) == {"I28"}


def test_i27_detects_a_not_started_step_before_current_week() -> None:
    prog = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
    )
    si = _si(_project(step_progress=prog))
    out = run_greedy_sgs(si)
    bad = _broken(out, "p", "PDD-D", start_week=25, end_week=25)
    assert _ids(validate_invariants(si, bad, check_determinism=False)) == {"I27"}


def test_i29_detects_a_frozen_elapsed_row_off_its_input_eff() -> None:
    si = _si(_project(frozen=True, actual_start_week=31, step_timing=(_t("PDD-L", lead=2),)))
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    bad = _broken(out, "p", "PDD-L", duration_weeks=1)
    assert _ids(validate_invariants(si, bad, check_determinism=False)) == {"I29"}


def test_i5_and_i29_read_the_per_project_lead() -> None:
    """A revived step (lead_weeks 2 over a table 0) is valid; marking it skipped
    is an I5 failure (skipped is derived from lead_weeks ?? table)."""

    si = _si(_project(step_timing=(_t("PDD-F", lead=2),)))
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    bad = _broken(out, "p", "PDD-F", skipped=True, duration_weeks=0)
    assert "I5" in _ids(validate_invariants(si, bad, check_determinism=False))


def test_i26_input_reads_the_per_project_lead() -> None:
    """A started step whose per-project lead is 0 is skipped by its lead, not
    by an override: not an I26 input failure (as for a table-0 step)."""

    prog = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20),
        progress("PDD-D", "In Progress", percent_complete=0, actual_start_week=30),
    )
    si = _si(_project(step_progress=prog, step_timing=(_t("PDD-D", lead=0, duration=0),)))
    out = run_greedy_sgs(si)
    assert "I26" not in _ids(validate_invariants(si, out, check_determinism=False))


# --- Plan import keeps a matched project's lead and wait (R33-9) --------------------------


def test_plan_import_edit_keeps_lead_and_wait_and_overlap_clears_wait() -> None:
    wfs = build_workflows(default_workflow_templates())
    table = build_lead_time_table(default_lead_times())
    p = _project(step_timing=(_t("PDD-E", wait=2, lead=5), _t("PDD-K", lead=3)))
    edited = _edit_plan_project(p, (StepEdit("p", "PDD-K", 4, None, None),), wfs, table)
    rows = {r.step_id: r for r in edited.step_timing}
    assert (rows["PDD-E"].wait_weeks, rows["PDD-E"].lead_weeks) == (2, 5)
    assert (rows["PDD-K"].duration_override_weeks, rows["PDD-K"].lead_weeks) == (4, 3)
    # An overlap drag on E sets o and clears w (one signed gap remains).
    dragged = _edit_plan_project(p, (StepEdit("p", "PDD-E", None, None, 1),), wfs, table)
    e = {r.step_id: r for r in dragged.step_timing}["PDD-E"]
    assert (e.overlap_weeks, e.wait_weeks, e.lead_weeks) == (1, 0, 5)
    run_greedy_sgs(_si(dragged))  # valid input


def test_plan_import_edit_on_a_revived_step_is_allowed() -> None:
    """F has lead 0 in the table but lead_weeks 2: it is not skipped, so a
    duration edit is accepted (it would be rejected on a skipped step)."""

    wfs = build_workflows(default_workflow_templates())
    table = build_lead_time_table(default_lead_times())
    p = _project(step_timing=(_t("PDD-F", lead=2),))
    edited = _edit_plan_project(p, (StepEdit("p", "PDD-F", 3, None, None),), wfs, table)
    f = {r.step_id: r for r in edited.step_timing}["PDD-F"]
    assert (f.duration_override_weeks, f.lead_weeks) == (3, 2)
    q = _project()
    with pytest.raises(ValueError, match="skipped"):
        _edit_plan_project(q, (StepEdit("p", "PDD-F", 3, None, None),), wfs, table)
