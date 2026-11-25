"""P62-T03 — lab hold weeks in the engine (ADR 0071 R62-0..R62-13; DOMAIN_RULES
"Lab hold weeks", I64-I67; API_CONTRACT_P62 §2).

Two fixtures:

* `TEMPLATE2` — a two-step chain, `PDD-A` design then `PDD-L` lab, hand-traced
  at CURRENT_WEEK 31. Lead weeks (A, L): A+ / A (1, 3), B (1, 1), C (1, 0).
  One chamber `ch-l` (max 1, PDD-L). A project's A is week 31, so its L is
  earliest 32. A 3-week L with hold 1 spans 32-34 and holds week 34 only.
* `TEMPLATE14` / `LEAD14` — the real 14-step PDD workflow with PDD-J / PDD-L
  `lab` (the hosted settings of 2026-11-22), the seeded lead times with
  C/PDD-J = 0 (R62-11, migration p71a) and the p71a template holds
  (J / L hold 1 for A+, A, B; 0 for C).

Every week below is hand-derived; each run is also checked with
`validate_invariants` (I64-I67 included).
"""

from __future__ import annotations

import dataclasses
from decimal import Decimal
from typing import Any

import pytest

from scheduling import (
    ChamberInput,
    EffortStepInput,
    EngineerInput,
    LeadTime,
    LiveProjectRow,
    LiveStepRow,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepPinInput,
    StepSchedule,
    StepTimingInput,
    WorkflowStepTemplate,
    apportion_effort,
    canonical_schedule_input_asdict,
    canonical_schedule_output_asdict,
    certification_off_skips,
    check_i26_effort_split,
    compute_demand_load,
    compute_lab_load_by_hub,
    default_lead_times,
    default_workflow_templates,
    derive_project_effort,
    hold_window,
    is_step_skipped,
    merged_step_override,
    partial_room_zero_length_skips,
    row_lab_load_weeks,
    run_cp_sat,
    run_greedy_sgs,
    template_lab_hold_rows,
    validate_invariants,
)
from scheduling.monte_carlo import _perturbed_project, forecast_delivery
from scheduling.plan_import import ImportProject, PlanImportRequest, build_plan_import_input
from scheduling.template_timeline import template_timeline
from scheduling.whatif import (
    AddProject,
    ChamberSupplyInput,
    HubCalendarInput,
    Scenario,
    WhatIfBaseline,
    apply_scenario,
)
from scheduling.workflow import build_lab_hold_table, build_workflows
from tests.scheduling._fixtures import progress

CW = 31

# =====================================================================================
# Fixtures
# =====================================================================================

TEMPLATE2: tuple[WorkflowStepTemplate, ...] = (
    WorkflowStepTemplate("PDD", "PDD-A", "MKTG_BRF", "Marketing Brief", "design", 1, ()),
    WorkflowStepTemplate("PDD", "PDD-L", "PILOT", "Pilot", "lab", 2, ("PDD-A",)),
)
_LEADS2 = {"A+": (1, 3), "A": (1, 3), "B": (1, 1), "C": (1, 0)}
LEAD2: tuple[LeadTime, ...] = tuple(
    LeadTime("PDD", cat, sid, w)
    for cat, (a, lab) in _LEADS2.items()
    for sid, w in (("PDD-A", a), ("PDD-L", lab))
)
ENG_A = EngineerInput("eng-a", "A", "R&D-Greece", ("A+", "A", "B", "C"))
ENG_B = EngineerInput("eng-b", "B", "R&D-Greece", ("A+", "A", "B", "C"))
ENG_C = EngineerInput("eng-c", "C", "R&D-Greece", ("A+", "A", "B", "C"))
CH_L = ChamberInput("ch-l", "GR-L", "Greece", max_concurrent=1, allowed_stages=("PDD-L",))


def _hold(step_id: str, weeks: int | None) -> StepTimingInput:
    return StepTimingInput(step_id, None, None, lab_hold_weeks=weeks)


def _p(
    pid: str, *, cat: str = "A", eng: str = "eng-a", hold: int | None = 1, **kw: Any
) -> ProjectInput:
    timing = kw.pop("step_timing", None)
    if timing is None:
        timing = () if hold is None else (_hold("PDD-L", hold),)
    defaults: dict[str, Any] = dict(
        project_id=pid,
        name=pid,
        hub="R&D-Greece",
        status="In Development",
        category=cat,
        priority="P1",
        frozen=False,
        leader_engineer_id=eng,
        step_timing=timing,
    )
    defaults.update(kw)
    return ProjectInput(**defaults)


def _si2(*projects: ProjectInput, chambers: tuple[ChamberInput, ...] = (CH_L,)) -> ScheduleInput:
    return ScheduleInput(
        current_week=CW,
        projects=projects,
        engineers=(ENG_A, ENG_B, ENG_C),
        chambers=chambers,
        workflow_steps=TEMPLATE2,
        lead_times=LEAD2,
    )


def _run(si: ScheduleInput) -> dict[str, ProjectScheduleOutcome]:
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    return {o.project_id: o for o in out.project_outcomes}


def _cp(si: ScheduleInput):  # type: ignore[no-untyped-def]
    out, info = run_cp_sat(si, deterministic_time=5.0, earliness_deterministic_time=2.0)
    assert validate_invariants(si, out, check_determinism=False) == ()
    return {o.project_id: o for o in out.project_outcomes}, info


def _row(o: ProjectScheduleOutcome, sid: str) -> StepSchedule:
    return next(s for s in o.steps if s.step_id == sid)


def _span(o: ProjectScheduleOutcome, sid: str) -> tuple[int, int, str | None, int | None]:
    r = _row(o, sid)
    return (r.start_week, r.end_week, r.assigned_chamber_id, r.lab_hold_weeks)


# The real 14-step PDD workflow with J / L lab (hosted settings, ADR 0071).
TEMPLATE14: tuple[WorkflowStepTemplate, ...] = tuple(
    dataclasses.replace(t, kind="lab") if t.step_id in ("PDD-J", "PDD-L") else t
    for t in default_workflow_templates()
)
_P71A_HOLD = {"A+": 1, "A": 1, "B": 1, "C": 0}
LEAD14: tuple[LeadTime, ...] = tuple(
    dataclasses.replace(
        lt,
        weeks=0 if (lt.category, lt.step_id) == ("C", "PDD-J") else lt.weeks,  # R62-11
        lab_hold_weeks=_P71A_HOLD[lt.category] if lt.step_id in ("PDD-J", "PDD-L") else None,
    )
    if lt.workflow_id == "PDD"
    else lt
    for lt in default_lead_times()
)
CH_FH = ChamberInput("gr-fh", "GR-FH", "Greece", 2, ("PDD-F", "PDD-H"))
CH_JL = ChamberInput("gr-jl", "GR-JL", "Greece", 1, ("PDD-J", "PDD-L"))
JL_HOLDS = (_hold("PDD-J", 1), _hold("PDD-L", 1))


def _si14(*projects: ProjectInput) -> ScheduleInput:
    return ScheduleInput(
        current_week=CW,
        projects=projects,
        engineers=(ENG_A, ENG_B, ENG_C),
        chambers=(CH_FH, CH_JL),
        workflow_steps=TEMPLATE14,
        lead_times=LEAD14,
    )


# =====================================================================================
# Pure helpers
# =====================================================================================


def test_hold_window_is_the_last_h_weeks() -> None:
    assert hold_window(32, 34, None) == range(32, 35)  # full: the pre-P62 rule
    assert hold_window(32, 34, 1) == range(34, 35)
    assert hold_window(32, 34, 2) == range(33, 35)
    assert hold_window(32, 34, 9) == range(32, 35)  # h = min(hold, n)
    assert hold_window(32, 34, 0) == range(35, 35)  # empty


def test_row_lab_load_reads_null_as_duration() -> None:
    full = StepSchedule("PDD-L", 2, "lab", 32, 34, 3, None, "ch-l")
    held = dataclasses.replace(full, lab_hold_weeks=1)
    assert row_lab_load_weeks(full) == 3
    assert row_lab_load_weeks(held) == 1
    assert row_lab_load_weeks(dataclasses.replace(held, skipped=True)) == 0


# =====================================================================================
# R62-0 / R62-5: greedy books the last h weeks on one chamber
# =====================================================================================


def test_hold_on_the_last_week() -> None:
    by = _run(_si2(_p("p")))
    assert _span(by["p"], "PDD-L") == (32, 34, "ch-l", 1)
    assert _row(by["p"], "PDD-L").duration_weeks == 3  # the step keeps its length
    assert by["p"].end_week == 34


def test_full_hold_row_reports_none_and_books_every_week() -> None:
    by = _run(_si2(_p("p", hold=None)))
    assert _span(by["p"], "PDD-L") == (32, 34, "ch-l", None)


def test_search_needs_the_chamber_free_only_in_the_held_weeks() -> None:
    # A frozen blocker holds ch-l in 32-34 (full). p's L (hold 1) may start at
    # 33: its lead-in weeks 33-34 book nothing, its held week 35 is free.
    blocker = _p("fz", eng="eng-b", hold=None, frozen=True, actual_start_week=31)
    by = _run(_si2(blocker, _p("p")))
    assert _span(by["fz"], "PDD-L") == (32, 34, "ch-l", None)
    assert _span(by["p"], "PDD-L") == (33, 35, "ch-l", 1)
    # With a full hold, p waits for every week: 35-37.
    by_full = _run(_si2(blocker, _p("p", hold=None)))
    assert _span(by_full["p"], "PDD-L") == (35, 37, "ch-l", None)


def test_contention_two_projects_one_chamber() -> None:
    by = _run(_si2(_p("p1"), _p("p2", eng="eng-b", priority="P2")))
    assert _span(by["p1"], "PDD-L") == (32, 34, "ch-l", 1)  # holds 34
    assert _span(by["p2"], "PDD-L") == (33, 35, "ch-l", 1)  # 34 is taken; holds 35
    full = _run(_si2(_p("p1", hold=None), _p("p2", eng="eng-b", priority="P2", hold=None)))
    assert _span(full["p2"], "PDD-L") == (35, 37, "ch-l", None)


def test_frozen_project_books_eligible_first_over_the_held_weeks() -> None:
    # Frozen fz (hold 1) books week 34 only; q (B, L 1 week) takes 32.
    fz = _p("fz", eng="eng-b", frozen=True, actual_start_week=31)
    by = _run(_si2(fz, _p("q", cat="B", hold=None)))
    assert _span(by["fz"], "PDD-L") == (32, 34, "ch-l", 1)
    assert _span(by["q"], "PDD-L") == (32, 32, "ch-l", None)
    full = _run(_si2(dataclasses.replace(fz, step_timing=()), _p("q", cat="B", hold=None)))
    assert _span(full["q"], "PDD-L") == (35, 35, "ch-l", None)


# =====================================================================================
# R62-4: h = 0
# =====================================================================================


def test_h0_books_no_chamber_and_is_never_no_chamber() -> None:
    by = _run(_si2(_p("p", hold=0), chambers=()))
    o = by["p"]
    assert not o.left_out and o.no_chamber_step_id is None
    assert _span(o, "PDD-L") == (32, 34, None, 0)  # still spans its 3 weeks
    assert o.end_week == 34
    # Without the hold the same project dead-ends on the missing chamber.
    full = _run(_si2(_p("p", hold=None), chambers=()))
    assert full["p"].left_out and full["p"].no_chamber_step_id == "PDD-L"


def test_h0_leaves_the_chamber_to_others() -> None:
    by = _run(_si2(_p("p", hold=0), _p("q", eng="eng-b", priority="P2", hold=None)))
    assert _span(by["p"], "PDD-L") == (32, 34, None, 0)
    assert _span(by["q"], "PDD-L") == (32, 34, "ch-l", None)


# =====================================================================================
# Anchored paths: In Progress tail, Done, pin
# =====================================================================================


def _tail_project(hold: int | None) -> ProjectInput:
    # A Done 29; L In Progress since 30, 0 % -> remaining 3 -> tail 31-33.
    return _p(
        "p",
        hold=hold,
        step_progress=(
            progress("PDD-A", "Done", actual_start_week=29, actual_end_week=29),
            progress("PDD-L", "In Progress", actual_start_week=30),
        ),
    )


def test_in_progress_tail_holds_its_last_weeks() -> None:
    q = _p("q", cat="B", eng="eng-b", priority="P2", hold=None)  # L 1 week, earliest 32
    by = _run(_si2(_tail_project(1), q))
    assert _span(by["p"], "PDD-L") == (30, 33, "ch-l", 1)  # tail 31-33, holds 33
    assert _span(by["q"], "PDD-L") == (32, 32, "ch-l", None)
    full = _run(_si2(_tail_project(None), q))
    assert _span(full["p"], "PDD-L") == (30, 33, "ch-l", None)
    assert _span(full["q"], "PDD-L") == (34, 34, "ch-l", None)


def test_in_progress_tail_with_hold_0() -> None:
    by = _run(_si2(_tail_project(0), chambers=()))
    assert _span(by["p"], "PDD-L") == (30, 33, None, 0)
    assert not by["p"].left_out


def test_done_step_holds_its_last_actual_weeks() -> None:
    def done(hold: int | None) -> ProjectInput:
        return _p(
            "p",
            hold=hold,
            step_progress=(
                progress("PDD-A", "Done", actual_start_week=28, actual_end_week=28),
                progress("PDD-L", "Done", actual_start_week=29, actual_end_week=33),
            ),
        )

    q = _p("q", cat="B", eng="eng-b", priority="P2", hold=None)
    by = _run(_si2(done(1), q))
    assert _span(by["p"], "PDD-L") == (29, 33, "ch-l", 1)  # holds 33 (>= cw)
    assert _span(by["q"], "PDD-L") == (32, 32, "ch-l", None)
    full = _run(_si2(done(None), q))
    assert _span(full["q"], "PDD-L") == (34, 34, "ch-l", None)  # 31-33 consumed


def test_pinned_lab_step_holds_the_last_weeks_of_its_window() -> None:
    pin = (StepPinInput("PDD-L", 40, 42),)
    q = _p(
        "q",
        cat="B",
        eng="eng-b",
        priority="P2",
        hold=None,
        step_timing=(StepTimingInput("PDD-L", None, 40),),
    )
    by = _run(_si2(_p("p", step_pins=pin), q))
    assert _span(by["p"], "PDD-L") == (40, 42, "ch-l", 1)
    assert _row(by["p"], "PDD-L").pinned
    assert _span(by["q"], "PDD-L") == (40, 40, "ch-l", None)
    full = _run(_si2(_p("p", hold=None, step_pins=pin), q))
    assert _span(full["q"], "PDD-L") == (43, 43, "ch-l", None)


def test_pinned_lab_step_with_hold_0_needs_no_chamber() -> None:
    by = _run(_si2(_p("p", hold=0, step_pins=(StepPinInput("PDD-L", 40, 42),)), chambers=()))
    assert _span(by["p"], "PDD-L") == (40, 42, None, 0)
    assert not by["p"].left_out


# =====================================================================================
# CP-SAT parity (R62-5)
# =====================================================================================


def test_cp_sat_matches_greedy_on_the_hold_fixture() -> None:
    si = _si2(
        _p("p1"),
        _p("p2", eng="eng-b", priority="P2"),
        _p("p3", eng="eng-c", priority="P2", hold=0),
    )
    greedy = _run(si)
    cp, info = _cp(si)
    assert set(info.model_project_ids) == {"p1", "p2", "p3"}  # all in the model
    for pid in ("p1", "p2", "p3"):
        assert cp[pid].steps == greedy[pid].steps, pid
    # The unique optimum needs the occupancy-only cumulative: p2 holds 35.
    assert _span(cp["p2"], "PDD-L") == (33, 35, "ch-l", 1)
    assert _span(cp["p3"], "PDD-L") == (32, 34, None, 0)


def test_cp_sat_tail_walk_sees_only_held_weeks() -> None:
    # `_book_solved_placements`: q is a queued P3 (walked after the solve). The
    # solved p1 holds only week 34, so q's 1-week L fits at 32.
    q = _p("q", cat="B", eng="eng-b", priority="P3", status="In Queue", hold=None)
    cp, info = _cp(_si2(_p("p1"), q))
    assert "q" in info.tail_project_ids
    assert _span(cp["p1"], "PDD-L") == (32, 34, "ch-l", 1)
    assert _span(cp["q"], "PDD-L") == (32, 32, "ch-l", None)


def test_cp_sat_h0_with_no_chamber_stays_in_the_model() -> None:
    cp, info = _cp(_si2(_p("p", hold=0), chambers=()))
    assert info.model_project_ids == ("p",)
    assert _span(cp["p"], "PDD-L") == (32, 34, None, 0)


# =====================================================================================
# Real 14-step workflow (J / L lab, p71a holds) — golden
# =====================================================================================


def test_golden_b_project_j_and_l_hold_one_week() -> None:
    # PDD/B: A1 D1 E4 H6 J1 K2 L1 M1 N1 -> A31 D32 E33-36 H37-42 J43 K44-45
    # L46 M47 N48 (J / L book GR-JL for their one week).
    by = _run(_si14(_p("b", cat="B", step_timing=JL_HOLDS)))
    o = by["b"]
    assert _span(o, "PDD-H") == (37, 42, "gr-fh", None)
    assert _span(o, "PDD-J") == (43, 43, "gr-jl", 1)
    assert _span(o, "PDD-L") == (46, 46, "gr-jl", 1)
    assert o.end_week == 48


def test_golden_a_plus_pilot_holds_its_last_week() -> None:
    # PDD/A+: A1 B8 C4 D1 E6 F6 G2 H6 I2 J1 K2 L3 M1 N1 from 31:
    # ... I 65-66, J 67, K 68-69, L 70-72 (holds 72), M 73, N 74.
    by = _run(_si14(_p("ap", cat="A+", step_timing=JL_HOLDS)))
    o = by["ap"]
    assert _span(o, "PDD-J") == (67, 67, "gr-jl", 1)
    assert _span(o, "PDD-L") == (70, 72, "gr-jl", 1)
    assert o.end_week == 74
    load = compute_lab_load_by_hub(_si14(_p("ap", cat="A+", step_timing=JL_HOLDS)), _out(o))
    assert load == {"R&D-Greece": 6 + 6 + 1 + 1}  # F 6 + H 6 + J 1 + L 1 (I66)


def _out(*outcomes: ProjectScheduleOutcome) -> ScheduleOutput:
    return ScheduleOutput(project_outcomes=outcomes, scheduling_order=())


def test_golden_c_has_no_pr_pr_or_pilot() -> None:
    # R62-11: C/PDD-J length 0 (C/PDD-L already 0), hold 0 -> both skipped,
    # and a user override never revives them.
    c_holds = (
        StepTimingInput("PDD-J", 2, None, lab_hold_weeks=0),
        _hold("PDD-L", 0),
    )
    by = _run(_si14(_p("c", cat="C", step_timing=c_holds)))
    assert _row(by["c"], "PDD-J").skipped and _row(by["c"], "PDD-L").skipped


def test_r62_2_certification_off_skips_full_room_lab_steps_only() -> None:
    p = _p("b", cat="B", step_timing=JL_HOLDS, certification_testing_required=False)
    by = _run(_si14(p))
    assert _row(by["b"], "PDD-H").skipped  # full-room: skipped
    assert not _row(by["b"], "PDD-J").skipped  # partialRoom: runs
    assert not _row(by["b"], "PDD-L").skipped
    # Separability / pre-P62 behaviour: with no hold J / L are skipped too.
    by_full = _run(_si14(dataclasses.replace(p, step_timing=())))
    assert all(_row(by_full["b"], s).skipped for s in ("PDD-H", "PDD-J", "PDD-L"))


def test_skip_predicate_functions_are_separate() -> None:
    kw = dict(kind="lab", certification_testing_required=False)
    assert certification_off_skips(**kw, lab_hold_weeks=None)  # type: ignore[arg-type]
    assert not certification_off_skips(**kw, lab_hold_weeks=1)  # type: ignore[arg-type]
    assert partial_room_zero_length_skips(kind="lab", lead_weeks=0, lab_hold_weeks=0)
    assert not partial_room_zero_length_skips(kind="lab", lead_weeks=1, lab_hold_weeks=0)
    assert not partial_room_zero_length_skips(kind="design", lead_weeks=0, lab_hold_weeks=0)
    # The one predicate composes them.
    assert not is_step_skipped(
        lead_weeks=1,
        override_weeks=None,
        lab_hold_weeks=1,
        **kw,  # type: ignore[arg-type]
    )
    assert is_step_skipped(
        lead_weeks=0,
        override_weeks=3,
        lab_hold_weeks=0,
        **kw,  # type: ignore[arg-type]
    )
    # A hold on a non-lab step is not read.
    assert not certification_off_skips(
        kind="design", certification_testing_required=False, lab_hold_weeks=None
    )


def test_merged_override_ignores_effort_on_partial_room_steps() -> None:
    assert merged_step_override(None, 4) == 4  # pre-P62
    assert merged_step_override(None, 4, kind="lab", lab_hold_weeks=1) is None
    assert merged_step_override(2, 4, kind="lab", lab_hold_weeks=1) == 2
    assert merged_step_override(None, 4, kind="lab", lab_hold_weeks=None) == 4


# =====================================================================================
# Invariants I64-I67 (negative)
# =====================================================================================


def _with_row(si: ScheduleInput, pid: str, sid: str, **changes: object) -> ScheduleOutput:
    out = run_greedy_sgs(si)
    outcomes = []
    for o in out.project_outcomes:
        if o.project_id == pid:
            steps = tuple(
                dataclasses.replace(s, **changes) if s.step_id == sid else s  # type: ignore[arg-type]
                for s in o.steps
            )
            o = dataclasses.replace(o, steps=steps)
        outcomes.append(o)
    return dataclasses.replace(out, project_outcomes=tuple(outcomes))


def _tags(si: ScheduleInput, out: ScheduleOutput) -> set[str]:
    return {v.invariant for v in validate_invariants(si, out, check_determinism=False)}


def test_i64_flags_a_wrong_or_missing_hold_on_the_row() -> None:
    si = _si2(_p("p"))
    assert "I64" in _tags(si, _with_row(si, "p", "PDD-L", lab_hold_weeks=None))
    assert "I64" in _tags(si, _with_row(si, "p", "PDD-L", lab_hold_weeks=2))
    assert "I65" in _tags(si, _with_row(si, "p", "PDD-L", lab_hold_weeks=7))
    # h > 0 without a chamber, h = 0 with one.
    assert "I64" in _tags(si, _with_row(si, "p", "PDD-L", assigned_chamber_id=None))
    si0 = _si2(_p("p", hold=0))
    assert "I64" in _tags(si0, _with_row(si0, "p", "PDD-L", assigned_chamber_id="ch-l"))
    # A full-hold row must not report a hold; a design row never.
    sif = _si2(_p("p", hold=None))
    assert "I64" in _tags(sif, _with_row(sif, "p", "PDD-L", lab_hold_weeks=3))
    assert "I64" in _tags(si, _with_row(si, "p", "PDD-A", lab_hold_weeks=1))


def test_i64_h0_step_is_never_the_no_chamber_cause() -> None:
    si = _si2(_p("p", hold=0), chambers=())
    out = run_greedy_sgs(si)
    o = dataclasses.replace(out.project_outcomes[0], no_chamber_step_id="PDD-L", left_out=True)
    assert "I64" in _tags(si, dataclasses.replace(out, project_outcomes=(o,)))


def test_i2_counts_only_held_weeks() -> None:
    # Two projects whose rows overlap in 33-34 but whose held weeks (34 / 35)
    # do not: no I2 violation (the validator counts occupancy weeks only).
    si = _si2(_p("p1"), _p("p2", eng="eng-b", priority="P2"))
    assert validate_invariants(si, run_greedy_sgs(si)) == ()
    # Moving p2's held week onto 34 is an I2 violation.
    bad = _with_row(si, "p2", "PDD-L", start_week=32, end_week=34)
    assert "I2" in _tags(si, bad)


def test_i67_partial_room_step_not_skipped_by_certification_off() -> None:
    si = _si14(_p("b", cat="B", step_timing=JL_HOLDS, certification_testing_required=False))
    out = _with_row(si, "b", "PDD-J", skipped=True, duration_weeks=0, assigned_chamber_id=None)
    assert "I67" in _tags(si, out)


# =====================================================================================
# Effort split (R62-1) and demand (I25 lab half, I26)
# =====================================================================================


def _lab_steps(holds: bool) -> tuple[EffortStepInput, ...]:
    h = 1 if holds else None
    return (
        EffortStepInput("PDD-F", 6, "lab", 4),
        EffortStepInput("PDD-H", 8, "lab", 6),
        EffortStepInput("PDD-J", 10, "lab", 1, lab_hold_weeks=h),
        EffortStepInput("PDD-L", 12, "lab", 3, lab_hold_weeks=h),
    )


def test_r62_1_partial_room_steps_take_no_lab_share() -> None:
    # PDD/A lab figure 4 over F, H only (DOMAIN_RULES R2 example): F 2, H 2.
    split = apportion_effort(4, _lab_steps(True), kind="lab")
    assert split.step_weeks == (("PDD-F", 2), ("PDD-H", 2))
    d = derive_project_effort(
        design_effort_weeks=None,
        lab_effort_weeks=4,
        certification_testing_required=True,
        steps=_lab_steps(True),
    )
    assert d.effort_weeks_by_step()["PDD-J"] is None
    assert d.effort_weeks_by_step()["PDD-L"] is None
    # All holds NULL: the pre-P62 split over F, H, J, L (weights 4:6:1:3).
    assert apportion_effort(4, _lab_steps(False), kind="lab").step_weeks == (
        ("PDD-F", 1),
        ("PDD-H", 2),
        ("PDD-J", 0),
        ("PDD-L", 1),
    )


def test_r62_1_b_lab_figure_goes_to_certification_only() -> None:
    steps = (
        EffortStepInput("PDD-H", 8, "lab", 6),
        EffortStepInput("PDD-J", 10, "lab", 1, lab_hold_weeks=1),
        EffortStepInput("PDD-L", 12, "lab", 1, lab_hold_weeks=1),
    )
    assert apportion_effort(10, steps, kind="lab").step_weeks == (("PDD-H", 10),)


def _live(cert: bool, **l_kw: object) -> LiveProjectRow:
    steps = (
        LiveStepRow("PDD-H", 8, "lab", 6, None, None),
        LiveStepRow(
            **{  # type: ignore[arg-type]
                "step_id": "PDD-L",
                "sequence_order": 12,
                "kind": "lab",
                "lead_weeks": 3,
                "user_override_weeks": None,
                "effort_weeks": None,
                "lab_hold_weeks": 1,
                **l_kw,
            }
        ),
    )
    return LiveProjectRow(
        project_id="p",
        hub="R&D-Greece",
        capacity_hub="R&D-Greece",
        status="In Development",
        frozen=False,
        certification_testing_required=cert,
        design_effort_weeks=None,
        lab_effort_weeks=Decimal("6"),
        steps=steps,
        priority="P1",
    )


def test_i25_lab_demand_counts_room_weeks() -> None:
    d = compute_demand_load([_live(True, effort_weeks=None)])
    # H eff 6 (its figure is not in the row: effort None -> lead 6) + L min(1, 3).
    assert d.lab_full_year == {"Greece": 7.0}
    # Certification off: H skipped, L (partialRoom) still 1.
    assert compute_demand_load([_live(False)]).lab_full_year == {"Greece": 1.0}
    # In Progress L with 2 weeks left still holds 1.
    ip = _live(True, status="In Progress", remaining_weeks_override=2)
    assert compute_demand_load([ip]).lab_remaining == {"Greece": 7.0}


def test_i26_partial_room_step_must_carry_no_effort() -> None:
    ok = dataclasses.replace(
        _live(True),
        steps=(dataclasses.replace(_live(True).steps[0], effort_weeks=6), _live(True).steps[1]),
    )
    assert check_i26_effort_split([ok]) == ()
    stale = _live(True, effort_weeks=2)  # L keeps a share: violation
    stale = dataclasses.replace(stale, steps=(ok.steps[0], stale.steps[1]))
    assert {v.step_id for v in check_i26_effort_split([stale])} == {"PDD-L"}
    # Certification off: a full-room step is not checked, a partialRoom one is.
    off = dataclasses.replace(stale, certification_testing_required=False)
    assert {v.step_id for v in check_i26_effort_split([off])} == {"PDD-L"}


# =====================================================================================
# What-if / plan import (R62-9), Monte Carlo, template timeline, canonical form
# =====================================================================================


def _baseline(*projects: ProjectInput) -> WhatIfBaseline:
    return WhatIfBaseline(
        schedule=_si14(*projects),
        calendars=(HubCalendarInput("R&D-Greece", 5, 10, 0, 0, 0),),
        chamber_supply=(
            ChamberSupplyInput("gr-fh", "Greece", 2, 1.0, 0, 0, 0),
            ChamberSupplyInput("gr-jl", "Greece", 1, 1.0, 0, 0, 0),
        ),
    )


def test_whatif_added_project_takes_the_template_hold() -> None:
    applied = apply_scenario(_baseline(), Scenario(add_projects=(AddProject("R&D-Greece", "B"),)))
    (p,) = applied.schedule_input.projects
    assert p.step_timing == JL_HOLDS
    by = _run(applied.schedule_input)
    assert _span(by[p.project_id], "PDD-J")[3] == 1
    assert _span(by[p.project_id], "PDD-L")[3] == 1


def test_whatif_without_template_holds_is_unchanged() -> None:
    lead = tuple(dataclasses.replace(lt, lab_hold_weeks=None) for lt in LEAD14)
    base = _baseline()
    base = dataclasses.replace(base, schedule=dataclasses.replace(base.schedule, lead_times=lead))
    applied = apply_scenario(base, Scenario(add_projects=(AddProject("R&D-Greece", "B"),)))
    assert applied.schedule_input.projects[0].step_timing == ()


def test_plan_import_file_project_takes_the_template_hold() -> None:
    fp = ImportProject(
        key="row-2",
        name="F",
        hub="R&D-Greece",
        category="B",
        status="In Queue",
        priority="P1",
        rank=1,
        file_row=2,
        leader="eng-a",
        current_step_id=None,
        step_weeks=(),
        certification_testing_required=False,
    )
    si = build_plan_import_input(_baseline(), PlanImportRequest(projects=(fp,), mode="file_only"))
    (p,) = si.projects
    assert {(r.step_id, r.lab_hold_weeks) for r in p.step_timing} == {("PDD-J", 1), ("PDD-L", 1)}
    by = _run(si)
    rows = by[p.project_id]
    assert _row(rows, "PDD-H").skipped  # R62-2 on a file project too
    assert not _row(rows, "PDD-J").skipped and not _row(rows, "PDD-L").skipped


def test_template_lab_hold_rows_and_table() -> None:
    wf = build_workflows(TEMPLATE14)["PDD"]
    table = build_lab_hold_table(LEAD14)
    assert template_lab_hold_rows(wf, "C", table) == (_hold("PDD-J", 0), _hold("PDD-L", 0))
    assert template_lab_hold_rows(build_workflows(TEMPLATE14)["OEM"], "A-OEM", table) == ()


def test_monte_carlo_never_samples_the_hold() -> None:
    p = _p("p")
    perturbed = _perturbed_project(p, 0, 1.3)
    assert perturbed.step_timing[0].lab_hold_weeks == 1
    si = _si2(
        p,
        _p(
            "q",
            eng="eng-b",
            priority="P2",
            step_timing=(StepTimingInput("PDD-L", 3, None, lab_hold_weeks=1),),
        ),
    )
    fc = forecast_delivery(si, iterations=5, seed=7)
    assert {r.project_id for r in fc.project_forecasts} == {"p", "q"}


def test_template_timeline_room_weeks() -> None:
    wf = build_workflows(TEMPLATE14)["PDD"]
    lengths = {lt.step_id: lt.weeks for lt in LEAD14 if lt.category == "A+"}
    base = template_timeline(workflow=wf, lengths=lengths, gaps={})
    held = template_timeline(
        workflow=wf, lengths=lengths, gaps={}, lab_holds={"PDD-J": 1, "PDD-L": 1}
    )
    assert base.lab_weeks == base.lab_length_weeks == 6 + 6 + 1 + 3
    assert held.lab_weeks == 6 + 6 + 1 + 1 and held.lab_length_weeks == 16
    assert held.total_weeks == base.total_weeks  # lengths unchanged
    l_step = next(s for s in held.steps if s.step_id == "PDD-L")
    assert (l_step.room_weeks, l_step.room_start_week) == (1, l_step.end_week - 1)


def test_canonical_forms_carry_the_hold_only_when_set() -> None:
    si = _si2(_p("p"), _p("q", eng="eng-b", hold=None))
    data = canonical_schedule_input_asdict(si)
    rows = {p["project_id"]: p["step_timing"] for p in data["projects"]}
    assert rows["p"][0]["lab_hold_weeks"] == 1 and rows["q"] == ()
    assert all("lab_hold_weeks" not in lt for lt in data["lead_times"])
    out = canonical_schedule_output_asdict(run_greedy_sgs(si))
    by = {o["project_id"]: {s["step_id"]: s for s in o["steps"]} for o in out["project_outcomes"]}
    assert by["p"]["PDD-L"]["lab_hold_weeks"] == 1
    assert "lab_hold_weeks" not in by["q"]["PDD-L"]
    assert "lab_hold_weeks" not in by["p"]["PDD-A"]


def test_rejects_a_hold_outside_the_domain() -> None:
    with pytest.raises(ValueError, match="lab_hold_weeks"):
        run_greedy_sgs(_si2(_p("p", hold=105)))
    with pytest.raises(ValueError, match="lab_hold_weeks"):
        run_greedy_sgs(_si2(_p("p", hold=-1)))


def test_determinism_with_holds() -> None:
    si = _si14(
        _p("b", cat="B", step_timing=JL_HOLDS),
        _p("a", cat="A", eng="eng-b", priority="P2", step_timing=JL_HOLDS),
    )
    assert repr(run_greedy_sgs(si)) == repr(run_greedy_sgs(si))
    assert validate_invariants(si, run_greedy_sgs(si)) == ()
