"""Informal self-test for P2-T06's CP-SAT model (`scheduling.cp_sat`).

Run directly: `python -m scheduling._selftest_cp_sat` from `backend/`.

Same status as `scheduling._selftest.py` (P2-T01) and
`scheduling._selftest_invariants.py` (P2-T04): deliberately not a pytest
module under `backend/tests/` (qa-inspector's directory) — formal pytest
coverage of `backend/scheduling/` is P2-T09's job, not this one's.

Three things this script verifies, per this task's explicit brief:

  1. **Small, hand-traced scenarios**, adapted from `_selftest.py`'s own
     library (not re-derived from scratch), confirming `run_cp_sat`'s
     solution satisfies the same documented DOMAIN_RULES.md rules
     `run_greedy_sgs` does, for every named outcome flag
     (ENG_CONFLICT/OVERLAP/LEFT_OUT/CAT_NOT_ALLOWED/SPILLOVER) plus the
     ambiguity resolutions P2-T01 recorded (no_leader, no eligible chamber).
     CP-SAT is a genuine optimizer, not required to match greedy's exact
     tie-breaking/ordering (per this task's own framing) — these scenarios
     therefore assert the DOMAIN-correctness of the outcome (flags, within-
     year/spillover boundaries, I3 sequencing), not byte-for-byte agreement
     with greedy's specific chosen week/chamber where the domain rules leave
     that choice open.

  2. **The full real 46-project seed dataset**
     (`backend/seed/prototype_seed_data.json`) — confirms the solve completes
     within a bounded `max_time_in_seconds` and, most importantly,
     `validate_invariants` (P2-T04) reports **zero violations** on the CP-SAT
     output. This is independent proof the CP-SAT model respects the same
     domain rules the greedy scheduler and its validator already enforce.

  3. **The frozen-conflict scenario** — the single highest-risk decision in
     this task (see `scheduling/cp_sat.py`'s module docstring): two frozen
     projects that genuinely conflict (same engineer, overlapping weeks; and
     separately, same chamber, over capacity) must leave the model FEASIBLE
     with the correct `eng_conflict`/`overlap` flag raised, never
     INFEASIBLE.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from scheduling import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ScheduleInput,
    WorkflowStepTemplate,
    validate_invariants,
)
from scheduling.cp_sat import run_cp_sat

FAILURES: list[str] = []


def check(label: str, condition: bool) -> None:
    status = "OK" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        FAILURES.append(label)


def check_no_violations(label: str, schedule_input: ScheduleInput, out) -> None:  # noqa: ANN001
    v = validate_invariants(schedule_input, out)
    check(f"{label}: validate_invariants == () (got {len(v)})", v == ())
    if v:
        for viol in v:
            print(f"    {viol}")


# --- Shared fixtures (mirrors scheduling._selftest.py's building blocks) ------

TEMPLATE = (
    WorkflowStepTemplate("PDD-A", "Marketing Brief", "design", base_weeks=2, sequence_order=1),
    WorkflowStepTemplate("PDD-F", "Proof of Concept", "lab", base_weeks=3, sequence_order=2),
)

ENGINEER_A = EngineerInput("eng-a", "Engineer A", "R&D-Greece", ("A+", "A", "B", "C"))
ENGINEER_B = EngineerInput("eng-b", "Engineer B", "R&D-Greece", ("A+", "A", "B", "C"))
ENGINEER_C_NARROW = EngineerInput("eng-c", "Engineer C", "R&D-Greece", ("C",))

CHAMBER_GR1 = ChamberInput(
    "ch-gr1", "GR-CH1", "Greece", max_concurrent=1, allowed_stages=("PDD-F",)
)
CHAMBER_GR2 = ChamberInput(
    "ch-gr2", "GR-CH2", "Greece", max_concurrent=1, allowed_stages=("PDD-F",)
)


# --- 1. Small, hand-traced scenarios -------------------------------------------


def scenario_normal_case() -> None:
    """A single, unremarkable project schedules cleanly, sequentially, no flags."""

    proj = ProjectInput(
        project_id="p-normal",
        name="Normal",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P2",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    si = ScheduleInput(
        projects=(proj,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    out, info = run_cp_sat(si)
    check("normal: OPTIMAL", info.status_name == "OPTIMAL")
    outcome = out.project_outcomes[0]
    check("normal: not left_out", not outcome.left_out)
    check("normal: not excluded", not outcome.excluded)
    check("normal: no eng_conflict", not outcome.eng_conflict)
    check("normal: no overlap", not outcome.overlap)
    check("normal: 2 steps scheduled", len(outcome.steps) == 2)
    design_step, lab_step = outcome.steps
    check("normal: design step starts at current_week", design_step.start_week == 31)
    check("normal: design duration 2", design_step.duration_weeks == 2)
    check(
        "normal: I3 sequential (lab.start >= design.end + 1)",
        lab_step.start_week >= design_step.end_week + 1,
    )
    check("normal: lab step assigned a chamber", lab_step.assigned_chamber_id == "ch-gr1")
    check("normal: within_year true", outcome.within_year)
    check("normal: no cat_not_allowed", not outcome.cat_not_allowed)
    check_no_violations("normal", si, out)


def scenario_single_engineer_contention() -> None:
    """Two non-frozen projects share the same leader -- neither may double-book
    the engineer (I1), and the optimizer must still schedule BOTH (there is no
    objective reason to leave either LEFT_OUT: plenty of horizon remains).
    """

    common = dict(
        hub="R&D-Greece", status="In Queue", category="A", frozen=False, leader_engineer_id="eng-a"
    )
    p1 = ProjectInput(project_id="p-eng-1", name="First", priority="P1", **common)
    p2 = ProjectInput(project_id="p-eng-2", name="Second", priority="P2", **common)
    si = ScheduleInput(
        projects=(p2, p1),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1, CHAMBER_GR2),
        workflow_steps=TEMPLATE,
    )
    out, info = run_cp_sat(si)
    check("contention: OPTIMAL", info.status_name == "OPTIMAL")
    by_id = {o.project_id: o for o in out.project_outcomes}
    check("contention: both scheduled (not left_out)", not by_id["p-eng-1"].left_out)
    check("contention: both scheduled (not left_out) 2", not by_id["p-eng-2"].left_out)
    d1 = by_id["p-eng-1"].steps[0]
    d2 = by_id["p-eng-2"].steps[0]
    weeks1 = set(range(d1.start_week, d1.end_week + 1))
    weeks2 = set(range(d2.start_week, d2.end_week + 1))
    check("contention: engineer never double-booked (I1)", not (weeks1 & weeks2))
    check("contention: p1 has no eng_conflict (non-frozen)", not by_id["p-eng-1"].eng_conflict)
    check("contention: p2 has no eng_conflict (non-frozen)", not by_id["p-eng-2"].eng_conflict)
    check_no_violations("contention", si, out)


def scenario_chamber_saturation() -> None:
    """max_concurrent=1 chamber; two non-frozen projects' lab steps can't overlap,
    but the optimizer must still schedule both (I2)."""

    common = dict(hub="R&D-Greece", status="In Queue", category="A", priority="P1", frozen=False)
    p1 = ProjectInput(project_id="p-lab-1", name="First", leader_engineer_id="eng-a", **common)
    p2 = ProjectInput(project_id="p-lab-2", name="Second", leader_engineer_id="eng-b", **common)
    si = ScheduleInput(
        projects=(p1, p2),
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
    )
    out, info = run_cp_sat(si)
    check("saturation: OPTIMAL", info.status_name == "OPTIMAL")
    by_id = {o.project_id: o for o in out.project_outcomes}
    both_scheduled = not by_id["p-lab-1"].left_out and not by_id["p-lab-2"].left_out
    check("saturation: both scheduled", both_scheduled)
    lab1, lab2 = by_id["p-lab-1"].steps[1], by_id["p-lab-2"].steps[1]
    weeks1 = set(range(lab1.start_week, lab1.end_week + 1))
    weeks2 = set(range(lab2.start_week, lab2.end_week + 1))
    check(
        "saturation: lab steps never share a week in the same chamber (I2)",
        not (weeks1 & weeks2),
    )
    check("saturation: p1 has no overlap flag (non-frozen)", not by_id["p-lab-1"].overlap)
    check("saturation: p2 has no overlap flag (non-frozen)", not by_id["p-lab-2"].overlap)
    check_no_violations("saturation", si, out)


def scenario_left_out_at_horizon() -> None:
    """A tiny horizon leaves no room for even the first step -- present=False,
    LEFT_OUT, structurally FEASIBLE (not INFEASIBLE)."""

    proj = ProjectInput(
        project_id="p-horizon",
        name="Too late",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    si = ScheduleInput(
        projects=(proj,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=77,  # design step duration 2 -> 77+2=79 > horizon 78
        horizon_weeks=78,
    )
    out, info = run_cp_sat(si)
    check("left_out: OPTIMAL (not INFEASIBLE)", info.status_name == "OPTIMAL")
    outcome = out.project_outcomes[0]
    check("left_out: flagged left_out", outcome.left_out)
    check("left_out: no steps scheduled", len(outcome.steps) == 0)
    check("left_out: within_year is False", not outcome.within_year)
    check("left_out: not spillover (mutually exclusive with left_out)", not outcome.spillover)
    check_no_violations("left_out", si, out)


def scenario_category_mismatch() -> None:
    """Leader's allowed_categories excludes the project's category -> warning,
    not a block -- the project must still be scheduled."""

    proj = ProjectInput(
        project_id="p-cat",
        name="Cat mismatch",
        hub="R&D-Greece",
        status="In Queue",
        category="A",  # engineer C only allows "C"
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-c",
    )
    si = ScheduleInput(
        projects=(proj,),
        engineers=(ENGINEER_C_NARROW,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
    )
    out, info = run_cp_sat(si)
    check("cat mismatch: OPTIMAL", info.status_name == "OPTIMAL")
    outcome = out.project_outcomes[0]
    check("cat mismatch: cat_not_allowed=True", outcome.cat_not_allowed)
    check("cat mismatch: still scheduled (warning only, not a block)", not outcome.left_out)
    check("cat mismatch: 2 steps scheduled despite mismatch", len(outcome.steps) == 2)
    check_no_violations("cat mismatch", si, out)


def scenario_oem_hub_requires_oem_allowed_category() -> None:
    """OEM-hub project checks the leader's "OEM" eligibility, not the project's
    own category."""

    eng_without_oem = EngineerInput("eng-oem-no", "No OEM", "OEM-HCK", ("A+", "A", "B", "C"))
    eng_with_oem = EngineerInput("eng-oem-yes", "Has OEM", "OEM-HCK", ("OEM",))
    common = dict(hub="OEM-HCK", status="In Queue", category="A", priority="P1", frozen=False)
    p_no = ProjectInput(
        project_id="p-oem-no", name="No OEM eligibility", leader_engineer_id="eng-oem-no", **common
    )
    p_yes = ProjectInput(
        project_id="p-oem-yes",
        name="Has OEM eligibility",
        leader_engineer_id="eng-oem-yes",
        **common,
    )
    india_chamber = ChamberInput(
        "ch-in1", "IN-CH1", "India", max_concurrent=2, allowed_stages=("PDD-F",)
    )
    si = ScheduleInput(
        projects=(p_no, p_yes),
        engineers=(eng_without_oem, eng_with_oem),
        chambers=(india_chamber,),
        workflow_steps=TEMPLATE,
    )
    out, info = run_cp_sat(si)
    check("OEM hub: OPTIMAL", info.status_name == "OPTIMAL")
    by_id = {o.project_id: o for o in out.project_outcomes}
    check(
        "OEM hub: leader without OEM eligibility -> cat_not_allowed",
        by_id["p-oem-no"].cat_not_allowed,
    )
    check(
        "OEM hub: leader with OEM eligibility -> no cat_not_allowed",
        not by_id["p-oem-yes"].cat_not_allowed,
    )
    check_no_violations("OEM hub", si, out)


def scenario_spillover_boundary() -> None:
    """end_week + delay <= 52 -> within_year; one week over -> spillover, not
    left_out (the presence tie-break must not spuriously leave a schedulable
    project out just because it can never achieve within_year -- see
    `cp_sat.py`'s "Objective" section, and the P2-T06 MEMORY.md entry for the
    bug this scenario originally caught)."""

    common = dict(
        hub="R&D-Greece",
        status="In Queue",
        category="A+",  # multiplier 1.0 -> no rounding, exact boundary arithmetic
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    proj_ok = ProjectInput(project_id="p-spill-ok", name="Just in time", **common)
    si_ok = ScheduleInput(
        projects=(proj_ok,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=48,
    )
    out_ok, info_ok = run_cp_sat(si_ok)
    check("spillover boundary (ok): OPTIMAL", info_ok.status_name == "OPTIMAL")
    outcome_ok = out_ok.project_outcomes[0]
    check("spillover boundary: not left_out", not outcome_ok.left_out)
    check("spillover boundary: end_week == 52", outcome_ok.end_week == 52)
    check("spillover boundary: within_year True at exactly 52", outcome_ok.within_year)
    check("spillover boundary: not spillover at exactly 52", not outcome_ok.spillover)
    check_no_violations("spillover boundary (ok)", si_ok, out_ok)

    proj_late = ProjectInput(project_id="p-spill-late", name="One week over", **common)
    si_late = ScheduleInput(
        projects=(proj_late,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=49,
    )
    out_late, info_late = run_cp_sat(si_late)
    check("spillover boundary (late): OPTIMAL", info_late.status_name == "OPTIMAL")
    outcome_late = out_late.project_outcomes[0]
    check(
        "spillover boundary: NOT left_out despite being unable to hit within_year "
        "(this is exactly the bug the presence tie-break fixes -- see cp_sat.py)",
        not outcome_late.left_out,
    )
    check("spillover boundary: end_week == 53", outcome_late.end_week == 53)
    check("spillover boundary: within_year False at 53", not outcome_late.within_year)
    check("spillover boundary: spillover True at 53", outcome_late.spillover)
    check_no_violations("spillover boundary (late)", si_late, out_late)


def scenario_delay_is_terminal_not_propagated() -> None:
    """ADR 0004: delay_weeks only affects the within_year check, never step
    dates."""

    proj = ProjectInput(
        project_id="p-delay",
        name="Delayed",
        hub="R&D-Greece",
        status="In Queue",
        category="A+",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
        delay_weeks=10,
    )
    si = ScheduleInput(
        projects=(proj,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=45,
    )
    out, info = run_cp_sat(si)
    check("delay: OPTIMAL", info.status_name == "OPTIMAL")
    outcome = out.project_outcomes[0]
    # start=45, duration 5 -> end=49 (undelayed). within_year check: 49+10=59>52 -> spillover.
    check("delay: end_week reflects undelayed schedule (49, not 59)", outcome.end_week == 49)
    check("delay: within_year accounts for delay in the check only", not outcome.within_year)
    check("delay: spillover True", outcome.spillover)
    check_no_violations("delay", si, out)


def scenario_excluded_statuses() -> None:
    """Commercialized / On Hold projects are excluded entirely, distinct from
    LEFT_OUT -- no CP-SAT variables are created for them at all."""

    common = dict(
        hub="R&D-Greece", category="A", priority="P1", frozen=False, leader_engineer_id="eng-a"
    )
    commercialized = ProjectInput(
        project_id="p-comm", name="Done", status="Commercialized", **common
    )
    on_hold = ProjectInput(project_id="p-hold", name="Paused", status="On Hold", **common)
    active = ProjectInput(project_id="p-active", name="Active", status="In Queue", **common)
    si = ScheduleInput(
        projects=(commercialized, on_hold, active),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
    )
    out, info = run_cp_sat(si)
    check("excluded: OPTIMAL", info.status_name == "OPTIMAL")
    check("excluded: only 1 solvable project counted", info.num_solvable_projects == 1)
    by_id = {o.project_id: o for o in out.project_outcomes}
    check("excluded: commercialized.excluded=True", by_id["p-comm"].excluded)
    check(
        "excluded: commercialized.left_out=False (distinct outcomes)", not by_id["p-comm"].left_out
    )
    check("excluded: commercialized.within_year=True", by_id["p-comm"].within_year)
    check("excluded: on_hold.excluded=True", by_id["p-hold"].excluded)
    check("excluded: on_hold.within_year=False", not by_id["p-hold"].within_year)
    check("excluded: active project not excluded", not by_id["p-active"].excluded)
    check(
        "excluded: excluded projects never consumed engineer capacity",
        by_id["p-active"].steps[0].start_week == 31,
    )
    check_no_violations("excluded", si, out)


def scenario_no_leader() -> None:
    """P2-T01 ambiguity resolution: `leader_engineer_id` doesn't resolve to any
    engineer -> immediate LEFT_OUT/no_leader=True, pre-resolved outside CP-SAT
    entirely (no solver variables created for this project)."""

    proj = ProjectInput(
        project_id="p-noleader",
        name="No leader",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P1",
        frozen=False,
        leader_engineer_id=None,
    )
    si = ScheduleInput(
        projects=(proj,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    out, info = run_cp_sat(si)
    check("no_leader: OPTIMAL", info.status_name == "OPTIMAL")
    check("no_leader: zero solvable projects (pre-resolved)", info.num_solvable_projects == 0)
    check("no_leader: pre-resolved as left-out", info.num_pre_resolved_left_out == 1)
    outcome = out.project_outcomes[0]
    check("no_leader: no_leader=True", outcome.no_leader)
    check("no_leader: left_out=True", outcome.left_out)
    check("no_leader: no steps", outcome.steps == ())
    check_no_violations("no_leader", si, out)


def scenario_no_eligible_chamber() -> None:
    """A non-frozen project with a resolvable leader, but zero chambers in its
    lab region can host its lab step -> unconditional LEFT_OUT/
    no_chamber_step_id, pre-resolved outside CP-SAT entirely."""

    proj = ProjectInput(
        project_id="p-nochamber",
        name="No eligible chamber",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    # Only an India chamber exists; the project's hub (R&D-Greece) requires a
    # Greece-region chamber for its lab step (PDD-F) -- zero eligible.
    india_chamber = ChamberInput(
        "ch-in1", "IN-CH1", "India", max_concurrent=2, allowed_stages=("PDD-F",)
    )
    si = ScheduleInput(
        projects=(proj,),
        engineers=(ENGINEER_A,),
        chambers=(india_chamber,),
        workflow_steps=TEMPLATE,
    )
    out, info = run_cp_sat(si)
    check("no_chamber: OPTIMAL", info.status_name == "OPTIMAL")
    check("no_chamber: zero solvable projects (pre-resolved)", info.num_solvable_projects == 0)
    check("no_chamber: pre-resolved as left-out", info.num_pre_resolved_left_out == 1)
    outcome = out.project_outcomes[0]
    check("no_chamber: no_chamber_step_id == PDD-F", outcome.no_chamber_step_id == "PDD-F")
    check("no_chamber: left_out=True", outcome.left_out)
    check("no_chamber: no steps", outcome.steps == ())
    check_no_violations("no_chamber", si, out)


# --- 3. The highest-risk decision: frozen-vs-frozen conflicts stay FEASIBLE ---


def scenario_two_frozen_projects_engineer_conflict() -> None:
    """THE test for this task's highest-risk modelling decision (see
    `cp_sat.py`'s module docstring): two frozen projects double-book the same
    engineer at the same weeks. A naive model feeding both as fixed intervals
    into one hard `AddNoOverlap` would be INFEASIBLE. This module pre-resolves
    frozen projects outside the solver entirely, so the model must stay
    FEASIBLE, with `ENG_CONFLICT` correctly raised on (at least) one side, and
    neither frozen project's dates moved (I10)."""

    p1 = ProjectInput(
        project_id="p-frozen-1",
        name="Frozen A",
        hub="R&D-Greece",
        status="In Development",
        category="A",
        priority="P1",
        frozen=True,
        leader_engineer_id="eng-a",
        actual_start_week=10,
    )
    p2 = ProjectInput(
        project_id="p-frozen-2",
        name="Frozen B",
        hub="R&D-Greece",
        status="In Development",
        category="A",
        priority="P1",
        frozen=True,
        leader_engineer_id="eng-a",
        actual_start_week=10,  # exact same weeks -> guaranteed conflict
    )
    si = ScheduleInput(
        projects=(p1, p2), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    out, info = run_cp_sat(si)
    check(
        "frozen eng conflict: model stays FEASIBLE/OPTIMAL, NOT INFEASIBLE "
        f"(status={info.status_name})",
        info.status_name in ("OPTIMAL", "FEASIBLE"),
    )
    by_id = {o.project_id: o for o in out.project_outcomes}
    check(
        "frozen eng conflict: p1 dates locked at actual_start_week",
        by_id["p-frozen-1"].steps[0].start_week == 10,
    )
    check(
        "frozen eng conflict: p2 dates ALSO locked at actual_start_week (I10: never mutated)",
        by_id["p-frozen-2"].steps[0].start_week == 10,
    )
    check(
        "frozen eng conflict: at least one side has eng_conflict=True",
        by_id["p-frozen-1"].eng_conflict or by_id["p-frozen-2"].eng_conflict,
    )
    check_no_violations("frozen eng conflict", si, out)

    # And: a THIRD, non-frozen project sharing the same engineer must correctly
    # route around the frozen background occupancy (weeks 10-11), proving the
    # background-occupancy mechanism (not just "the model didn't crash").
    p3 = ProjectInput(
        project_id="p-nonfrozen",
        name="Routes around frozen",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    si2 = ScheduleInput(
        projects=(p1, p2, p3),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=10,
    )
    out2, info2 = run_cp_sat(si2)
    check("frozen background: OPTIMAL", info2.status_name == "OPTIMAL")
    by_id2 = {o.project_id: o for o in out2.project_outcomes}
    nf_design = by_id2["p-nonfrozen"].steps[0]
    frozen_busy_weeks = {10, 11}  # actual_start_week=10, design duration 2 -> weeks 10,11
    nf_weeks = set(range(nf_design.start_week, nf_design.end_week + 1))
    check(
        "frozen background: non-frozen project avoids frozen-occupied weeks entirely",
        not (nf_weeks & frozen_busy_weeks),
    )
    check_no_violations("frozen background", si2, out2)


def scenario_two_frozen_projects_chamber_overlap() -> None:
    """Same highest-risk decision, chamber side (I2's "unless frozen, then
    OVERLAP" branch): two frozen projects both need the same
    max_concurrent=1 chamber at the same weeks -> OVERLAP, model stays
    FEASIBLE (not INFEASIBLE from the mandatory background demand alone --
    see `cp_sat.py`'s capped-demand design)."""

    p1 = ProjectInput(
        project_id="p-fc1",
        name="F1",
        hub="R&D-Greece",
        status="In Development",
        category="A",
        priority="P1",
        frozen=True,
        leader_engineer_id="eng-a",
        actual_start_week=10,
    )
    p2 = ProjectInput(
        project_id="p-fc2",
        name="F2",
        hub="R&D-Greece",
        status="In Development",
        category="A",
        priority="P1",
        frozen=True,
        leader_engineer_id="eng-b",
        actual_start_week=10,
    )
    si = ScheduleInput(
        projects=(p1, p2),
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1,),  # max_concurrent=1
        workflow_steps=TEMPLATE,
    )
    out, info = run_cp_sat(si)
    check(
        "frozen chamber overlap: model stays FEASIBLE/OPTIMAL, NOT INFEASIBLE "
        f"(status={info.status_name})",
        info.status_name in ("OPTIMAL", "FEASIBLE"),
    )
    by_id = {o.project_id: o for o in out.project_outcomes}
    check(
        "frozen chamber overlap: at least one side has overlap=True",
        by_id["p-fc1"].overlap or by_id["p-fc2"].overlap,
    )
    check_no_violations("frozen chamber overlap", si, out)


# --- 2. Full real 46-project seed dataset --------------------------------------


def real_seed_dataset() -> None:
    """The full real 46-project P1-T03 seed dataset, canonical 14-step
    template -- confirms the model solves within a bounded
    `max_time_in_seconds` and `validate_invariants` reports zero violations at
    realistic scale, not just on small hand-traced fixtures. Self-contained
    (does not import from the now-deleted `tests/oracle/`)."""

    seed_path = Path(__file__).resolve().parent.parent / "seed" / "prototype_seed_data.json"
    if not seed_path.exists():
        check("real_seed_dataset: seed file present (skipped, not found)", False)
        return

    seed = json.loads(seed_path.read_text())

    engineers = tuple(
        EngineerInput(
            engineer_id=e["name"],
            name=e["name"],
            hub=e["hub"],
            allowed_categories=tuple(e["cats"]),
            fte=e["fte"],
        )
        for e in seed["engineers"]
    )
    chambers = tuple(
        ChamberInput(
            chamber_id=c["id"],
            code=c["id"],
            lab_region=c["labHub"],
            max_concurrent=c["max"],
            allowed_stages=tuple(f"PDD-{letter}" for letter in c["stages"]),
            efficiency=c["eff"],
            weeks_per_chamber=c["wksCh"],
        )
        for c in seed["chambers"]
    )
    projects = tuple(
        ProjectInput(
            project_id=p["id"],
            name=p["name"],
            hub=p["hub"],
            status=p["status"],
            category=p["cat"],
            priority=p["prio"],
            frozen=p["frozen"],
            leader_engineer_id=p["leader"],
            actual_start_week=p["actualStart"] if p["frozen"] else None,
            delay_weeks=p["delay"],
        )
        for p in seed["projects"]
    )
    si = ScheduleInput(projects=projects, engineers=engineers, chambers=chambers)

    max_time = 60.0
    t0 = time.time()
    out, info = run_cp_sat(si, max_time_in_seconds=max_time)
    wall_clock = time.time() - t0

    check(
        f"real_seed_dataset (46 projects): completes within bounded "
        f"max_time_in_seconds={max_time}s (wall clock {wall_clock:.2f}s, "
        f"solver-reported {info.wall_time_seconds:.2f}s)",
        wall_clock <= max_time + 5.0,  # small grace for process/model-build overhead
    )
    check(
        f"real_seed_dataset: solver status is OPTIMAL (got {info.status_name})",
        info.status_name == "OPTIMAL",
    )
    schedulable_statuses = {"In Buyoff", "Under Industrialization", "In Development", "In Queue"}
    num_excluded = sum(1 for p in projects if p.status not in schedulable_statuses)
    accounted_for = (
        info.num_solvable_projects
        + info.num_frozen_projects
        + info.num_pre_resolved_left_out
        + num_excluded
    )
    check(
        f"real_seed_dataset: solvable({info.num_solvable_projects}) + "
        f"frozen({info.num_frozen_projects}) + "
        f"pre_resolved_left_out({info.num_pre_resolved_left_out}) + "
        f"excluded({num_excluded}) == 46 project total (got {accounted_for})",
        accounted_for == 46,
    )

    v = validate_invariants(si, out)
    check(f"real_seed_dataset (46 projects): zero violations (got {len(v)})", v == ())
    if v:
        for viol in v[:20]:
            print(f"    {viol}")

    # Determinism (best-effort, single-threaded default -- see cp_sat.py's
    # module docstring for why this is not formally guaranteed the way I8 is
    # for the greedy scheduler, only empirically verified here).
    out2, _info2 = run_cp_sat(si, max_time_in_seconds=max_time)
    check("real_seed_dataset: single-threaded re-run is structurally equal (==)", out == out2)
    check(
        "real_seed_dataset: single-threaded re-run is byte-identical (repr())",
        repr(out) == repr(out2),
    )


def main() -> int:
    print("=== 1. Small, hand-traced scenarios (adapted from _selftest.py) ===")
    scenario_normal_case()
    scenario_single_engineer_contention()
    scenario_chamber_saturation()
    scenario_left_out_at_horizon()
    scenario_category_mismatch()
    scenario_oem_hub_requires_oem_allowed_category()
    scenario_spillover_boundary()
    scenario_delay_is_terminal_not_propagated()
    scenario_excluded_statuses()
    scenario_no_leader()
    scenario_no_eligible_chamber()

    print()
    print("=== 2. Highest-risk decision: frozen-vs-frozen conflicts stay FEASIBLE ===")
    scenario_two_frozen_projects_engineer_conflict()
    scenario_two_frozen_projects_chamber_overlap()

    print()
    print("=== 3. Full real 46-project seed dataset ===")
    real_seed_dataset()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) FAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
