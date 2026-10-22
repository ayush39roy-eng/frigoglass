"""Informal self-test for P2-T01 — NOT the P2-T05 golden-file suite.

Run directly: `python -m scheduling._selftest` from `backend/`.

This is deliberately not a pytest module under `backend/tests/` (qa-inspector's
directory) or under a not-yet-existing `backend/scheduling/tests/` (that
formal harness, with hand-constructed fixtures per named rule, is P2-T05's
job). This script exists only so P2-T01 can informally, repeatably demonstrate:
  (a) the scheduler produces the expected outcome for one hand-traced scenario
      per named rule in DOMAIN_RULES.md's booking rules / invariants, and
  (b) re-running on identical input is deterministic (Invariant I8) —
      structurally equal (in fact byte-identical via `repr()`) output.

Kept intentionally small and single-file, mirroring the "one rule per fixture"
principle the `scheduling-algorithms` skill recommends for the eventual
golden-file suite.
"""

from __future__ import annotations

from scheduling import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ScheduleInput,
    run_greedy_sgs,
)
from scheduling._selftest_common import LEAD_TIMES, TEMPLATE

FAILURES: list[str] = []


def check(label: str, condition: bool) -> None:
    status = "OK" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        FAILURES.append(label)


# A minimal 2-step template (one design step of 2 weeks, one lab step of 3
# weeks; `scheduling._selftest_common`) so scenarios are easy to hand-trace,
# per the skill's "small fixtures, one rule per fixture" guidance.

ENGINEER_A = EngineerInput("eng-a", "Engineer A", "R&D-Greece", ("A+", "A", "B", "C"))
ENGINEER_B = EngineerInput("eng-b", "Engineer B", "R&D-Greece", ("A+", "A", "B", "C"))
ENGINEER_C_NARROW = EngineerInput("eng-c", "Engineer C", "R&D-Greece", ("C",))  # only allows "C"

CHAMBER_GR1 = ChamberInput(
    "ch-gr1", "GR-CH1", "Greece", max_concurrent=1, allowed_stages=("PDD-F",)
)
CHAMBER_GR2 = ChamberInput(
    "ch-gr2", "GR-CH2", "Greece", max_concurrent=1, allowed_stages=("PDD-F",)
)


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
    out = run_greedy_sgs(
        ScheduleInput(
            projects=(proj,),
            engineers=(ENGINEER_A,),
            chambers=(CHAMBER_GR1,),
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
        )
    )
    outcome = out.project_outcomes[0]
    check("normal: not left_out", not outcome.left_out)
    check("normal: not excluded", not outcome.excluded)
    check("normal: no eng_conflict", not outcome.eng_conflict)
    check("normal: no overlap", not outcome.overlap)
    check("normal: 2 steps scheduled", len(outcome.steps) == 2)
    design_step, lab_step = outcome.steps
    # A category: duration_weeks(2, "A") = max(1, round(2*0.8)) = max(1,2) = 2
    check("normal: design step starts at current_week", design_step.start_week == 31)
    check("normal: design duration 2", design_step.duration_weeks == 2)
    # lab step must start strictly after design step ends (Invariant I3)
    i3_holds = lab_step.start_week >= design_step.end_week + 1
    check("normal: I3 sequential (lab.start >= design.end + 1)", i3_holds)
    check("normal: I3 no gap (tight packing)", lab_step.start_week == design_step.end_week + 1)
    check("normal: lab step assigned a chamber", lab_step.assigned_chamber_id == "ch-gr1")
    check("normal: within_year true", outcome.within_year)
    check("normal: no cat_not_allowed", not outcome.cat_not_allowed)


def scenario_single_engineer_contention() -> None:
    """Two non-frozen projects share the same leader; the second must wait."""

    common = dict(
        hub="R&D-Greece", status="In Queue", category="A", frozen=False, leader_engineer_id="eng-a"
    )
    p1 = ProjectInput(project_id="p-eng-1", name="First", priority="P1", **common)
    p2 = ProjectInput(project_id="p-eng-2", name="Second", priority="P2", **common)
    out = run_greedy_sgs(
        ScheduleInput(
            projects=(p2, p1),  # deliberately out of priority order in the input
            engineers=(ENGINEER_A,),
            chambers=(CHAMBER_GR1, CHAMBER_GR2),
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
        )
    )
    by_id = {o.project_id: o for o in out.project_outcomes}
    order_ok = out.scheduling_order == ("p-eng-1", "p-eng-2")
    check("contention: p1 scheduled first (P1 before P2)", order_ok)
    check(
        "contention: p2's design step starts after p1's design step ends",
        by_id["p-eng-2"].steps[0].start_week > by_id["p-eng-1"].steps[0].end_week,
    )
    check(
        "contention: p1 has no eng_conflict (non-frozen just waits)",
        not by_id["p-eng-1"].eng_conflict,
    )
    check(
        "contention: p2 has no eng_conflict (non-frozen just waits)",
        not by_id["p-eng-2"].eng_conflict,
    )


def scenario_chamber_saturation() -> None:
    """max_concurrent=1 chamber; two non-frozen projects' lab steps can't overlap."""

    common = dict(hub="R&D-Greece", status="In Queue", category="A", priority="P1", frozen=False)
    p1 = ProjectInput(project_id="p-lab-1", name="First", leader_engineer_id="eng-a", **common)
    p2 = ProjectInput(project_id="p-lab-2", name="Second", leader_engineer_id="eng-b", **common)
    out = run_greedy_sgs(
        ScheduleInput(
            projects=(p1, p2),
            engineers=(ENGINEER_A, ENGINEER_B),
            chambers=(CHAMBER_GR1,),  # only one chamber, max_concurrent=1
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
        )
    )
    by_id = {o.project_id: o for o in out.project_outcomes}
    lab1, lab2 = by_id["p-lab-1"].steps[1], by_id["p-lab-2"].steps[1]
    weeks1 = set(range(lab1.start_week, lab1.end_week + 1))
    weeks2 = set(range(lab2.start_week, lab2.end_week + 1))
    check("saturation: lab steps never share a week in the same chamber", not (weeks1 & weeks2))
    check(
        "saturation: p1 has no overlap flag (non-frozen just waits)", not by_id["p-lab-1"].overlap
    )
    check(
        "saturation: p2 has no overlap flag (non-frozen just waits)", not by_id["p-lab-2"].overlap
    )


def scenario_frozen_conflict() -> None:
    """Two frozen projects sharing a leader and the same weeks -> ENG_CONFLICT, dates unmoved."""

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
    out = run_greedy_sgs(
        ScheduleInput(
            projects=(p1, p2),
            engineers=(ENGINEER_A,),
            chambers=(CHAMBER_GR1,),
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
        )
    )
    by_id = {o.project_id: o for o in out.project_outcomes}
    check(
        "frozen conflict: p1 dates locked at actual_start_week",
        by_id["p-frozen-1"].steps[0].start_week == 10,
    )
    check(
        "frozen conflict: p2 dates ALSO locked at actual_start_week (I10: never mutated)",
        by_id["p-frozen-2"].steps[0].start_week == 10,
    )
    check("frozen conflict: p2 has eng_conflict=True", by_id["p-frozen-2"].eng_conflict)
    check(
        "frozen conflict: p1 also has eng_conflict=True (both sides flagged, P9-R01)",
        by_id["p-frozen-1"].eng_conflict,
    )


def scenario_left_out_at_horizon() -> None:
    """A tiny horizon leaves no room for even the first step."""

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
    out = run_greedy_sgs(
        ScheduleInput(
            projects=(proj,),
            engineers=(ENGINEER_A,),
            chambers=(CHAMBER_GR1,),
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
            current_week=77,  # design step duration 2 -> 77+2=79 > horizon 78
            horizon_weeks=78,
        )
    )
    outcome = out.project_outcomes[0]
    check("left_out: flagged left_out", outcome.left_out)
    check("left_out: no steps scheduled", len(outcome.steps) == 0)
    check("left_out: within_year is False", not outcome.within_year)
    check("left_out: not spillover (mutually exclusive with left_out)", not outcome.spillover)


def scenario_category_mismatch() -> None:
    """Leader's allowed_categories excludes the project's category -> warning, not a block."""

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
    out = run_greedy_sgs(
        ScheduleInput(
            projects=(proj,),
            engineers=(ENGINEER_C_NARROW,),
            chambers=(CHAMBER_GR1,),
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
        )
    )
    outcome = out.project_outcomes[0]
    check("cat mismatch: cat_not_allowed=True", outcome.cat_not_allowed)
    check("cat mismatch: still scheduled (warning only, not a block)", not outcome.left_out)
    check("cat mismatch: 2 steps scheduled despite mismatch", len(outcome.steps) == 2)


def scenario_oem_hub_requires_oem_allowed_category() -> None:
    """OEM-hub project checks the leader's "OEM" eligibility, not the project's own category."""

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
    out = run_greedy_sgs(
        ScheduleInput(
            projects=(p_no, p_yes),
            engineers=(eng_without_oem, eng_with_oem),
            chambers=(india_chamber,),
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
        )
    )
    by_id = {o.project_id: o for o in out.project_outcomes}
    check(
        "OEM hub: leader without OEM eligibility -> cat_not_allowed",
        by_id["p-oem-no"].cat_not_allowed,
    )
    check(
        "OEM hub: leader with OEM eligibility -> no cat_not_allowed",
        not by_id["p-oem-yes"].cat_not_allowed,
    )


def scenario_oem_project_on_greece_capacity_hub() -> None:
    """ADR 0042 (P29): an OEM-HCK project whose capacity hub is R&D-Greece, led
    by a Greek engineer carrying `B-OEM` (no generic "OEM" marker), runs the OEM
    workflow, books the Greek engineer and a chamber in the Greece lab region.

    B-OEM lead times (A..N) 1 1 1 0 0 2 2 6 0 1 0 0 0 0, CURRENT_WEEK 31:
    A 31, B 32, C 33, (D, E skipped), F 34-35, G 36-37, H 38-43, (I), J 44.
    """

    greek = EngineerInput("eng-gr-oem", "Greek OEM", "R&D-Greece", ("A+", "A", "B", "C", "B-OEM"))
    # Sorts first and hosts the OEM lab stages, but is in the wrong lab region.
    india = ChamberInput(
        "ch-a-india", "IN-OEM", "India", max_concurrent=1, allowed_stages=("OEM-E", "OEM-H")
    )
    greece = ChamberInput(
        "ch-gr-oem", "GR-OEM", "Greece", max_concurrent=1, allowed_stages=("OEM-E", "OEM-H")
    )
    proj = ProjectInput(
        project_id="p-oem-gr",
        name="OEM on Greece capacity",
        hub="OEM-HCK",
        status="In Queue",
        category="B-OEM",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-gr-oem",
        workflow_id="OEM",
        capacity_hub="R&D-Greece",
    )
    si = ScheduleInput(
        projects=(proj,), engineers=(greek,), chambers=(india, greece), current_week=31
    )
    out = run_greedy_sgs(si)
    o = out.project_outcomes[0]
    design = [s for s in o.steps if s.kind == "design" and not s.skipped]
    lab = [s for s in o.steps if s.kind == "lab" and not s.skipped]
    check("capacity hub: scheduled, has a leader", not o.left_out and not o.no_leader)
    check("capacity hub: B-OEM leader is category-eligible", not o.cat_not_allowed)
    check("capacity hub: OEM workflow, 14 rows", [s.step_id[:4] for s in o.steps] == ["OEM-"] * 14)
    check(
        "capacity hub: every design step on the Greek engineer",
        bool(design) and all(s.assigned_engineer_id == "eng-gr-oem" for s in design),
    )
    check(
        "capacity hub: lab step in the Greece region",
        [s.assigned_chamber_id for s in lab] == ["ch-gr-oem"],
    )
    check(
        "capacity hub: hand-derived weeks",
        [(s.step_id, s.start_week, s.end_week) for s in design + lab]
        == [
            ("OEM-A", 31, 31),
            ("OEM-B", 32, 32),
            ("OEM-G", 36, 37),
            ("OEM-J", 44, 44),
            ("OEM-H", 38, 43),
        ],
    )
    check("capacity hub: within year (end W44)", o.end_week == 44 and o.within_year)
    check("capacity hub: re-run byte-identical (I8)", repr(run_greedy_sgs(si)) == repr(out))
    # Regression: without capacity_hub the field defaults to the hub, and the
    # walk (which books the assigned leader) is byte-identical.
    plain = ProjectInput(
        project_id="p-oem-gr",
        name="OEM on Greece capacity",
        hub="OEM-HCK",
        status="In Queue",
        category="B-OEM",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-gr-oem",
        workflow_id="OEM",
    )
    check("capacity hub: defaults to the project's hub", plain.capacity_hub == "OEM-HCK")
    out_plain = run_greedy_sgs(
        ScheduleInput(
            projects=(plain,), engineers=(greek,), chambers=(india, greece), current_week=31
        )
    )
    check("capacity hub: unset -> byte-identical output", repr(out_plain) == repr(out))


def scenario_spillover_boundary() -> None:
    """end_week + delay <= 52 -> within_year; one week over -> spillover, not left_out."""

    # category "A+" (multiplier 1.0) so step durations equal base_weeks exactly
    # (2 and 3) with no rounding, keeping the boundary arithmetic exact/obvious.
    common = dict(
        hub="R&D-Greece",
        status="In Queue",
        category="A+",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    # TEMPLATE total duration = 2 (design) + 3 (lab) = 5 weeks. Start exactly at
    # current_week=48 -> end_week = 48+5-1 = 52 -> within_year (52<=52).
    proj_ok = ProjectInput(project_id="p-spill-ok", name="Just in time", **common)
    out_ok = run_greedy_sgs(
        ScheduleInput(
            projects=(proj_ok,),
            engineers=(ENGINEER_A,),
            chambers=(CHAMBER_GR1,),
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
            current_week=48,
        )
    )
    outcome_ok = out_ok.project_outcomes[0]
    check("spillover boundary: end_week == 52", outcome_ok.end_week == 52)
    check("spillover boundary: within_year True at exactly 52", outcome_ok.within_year)
    check("spillover boundary: not spillover at exactly 52", not outcome_ok.spillover)

    proj_late = ProjectInput(project_id="p-spill-late", name="One week over", **common)
    # A fresh run (independent from out_ok's call above) — engineer/chamber
    # busy-state is rebuilt from scratch inside run_greedy_sgs on every call,
    # so reusing the same ENGINEER_A/CHAMBER_GR1 module-level (immutable)
    # instances across the two calls in this scenario cannot leak state.
    out_late = run_greedy_sgs(
        ScheduleInput(
            projects=(proj_late,),
            engineers=(ENGINEER_A,),
            chambers=(CHAMBER_GR1,),
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
            current_week=49,
        )
    )
    outcome_late = out_late.project_outcomes[0]
    # start=49 -> end = 49+5-1 = 53 > 52
    check("spillover boundary: end_week == 53", outcome_late.end_week == 53)
    check("spillover boundary: within_year False at 53", not outcome_late.within_year)
    check("spillover boundary: spillover True at 53", outcome_late.spillover)
    check(
        "spillover boundary: not left_out (it WAS scheduled, just late)", not outcome_late.left_out
    )


def scenario_delay_is_terminal_not_propagated() -> None:
    """ADR 0004: delay_weeks only affects the within_year check, never step dates."""

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
    out = run_greedy_sgs(
        ScheduleInput(
            projects=(proj,),
            engineers=(ENGINEER_A,),
            chambers=(CHAMBER_GR1,),
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
            current_week=45,
        )
    )
    outcome = out.project_outcomes[0]
    # start=45, duration 5 -> end=49 (undelayed). within_year check: 49+10=59>52 -> spillover.
    check("delay: end_week reflects undelayed schedule (49, not 59)", outcome.end_week == 49)
    check("delay: within_year accounts for delay in the check only", not outcome.within_year)
    check("delay: spillover True", outcome.spillover)


def scenario_excluded_statuses() -> None:
    """Commercialized / On Hold projects are excluded entirely, distinct from LEFT_OUT."""

    common = dict(
        hub="R&D-Greece", category="A", priority="P1", frozen=False, leader_engineer_id="eng-a"
    )
    commercialized = ProjectInput(
        project_id="p-comm", name="Done", status="Commercialized", **common
    )
    on_hold = ProjectInput(project_id="p-hold", name="Paused", status="On Hold", **common)
    active = ProjectInput(project_id="p-active", name="Active", status="In Queue", **common)
    out = run_greedy_sgs(
        ScheduleInput(
            projects=(commercialized, on_hold, active),
            engineers=(ENGINEER_A,),
            chambers=(CHAMBER_GR1,),
            workflow_steps=TEMPLATE,
            lead_times=LEAD_TIMES,
        )
    )
    by_id = {o.project_id: o for o in out.project_outcomes}
    check("excluded: commercialized.excluded=True", by_id["p-comm"].excluded)
    check(
        "excluded: commercialized.left_out=False (distinct outcomes)",
        not by_id["p-comm"].left_out,
    )
    check("excluded: commercialized.within_year=True", by_id["p-comm"].within_year)
    check("excluded: on_hold.excluded=True", by_id["p-hold"].excluded)
    check("excluded: on_hold.within_year=False", not by_id["p-hold"].within_year)
    check("excluded: active project not excluded", not by_id["p-active"].excluded)
    check(
        "excluded: excluded projects never consumed engineer capacity",
        # eng-a free at current_week despite "sharing" it with the excluded projects above
        by_id["p-active"].steps[0].start_week == 31,
    )
    check(
        "excluded: scheduling_order omits excluded projects entirely",
        out.scheduling_order == ("p-active",),
    )


def scenario_determinism() -> None:
    """Invariant I8: identical input -> byte-identical output, run twice."""

    projects = tuple(
        ProjectInput(
            project_id=f"p-{i}",
            name=f"Project {i}",
            hub="R&D-Greece" if i % 2 == 0 else "PD-Romania",
            status="In Queue",
            category=["A+", "A", "B", "C"][i % 4],
            priority=["P1", "P2", "P3", "P4", "Q"][i % 5],
            frozen=(i % 5 == 0),
            leader_engineer_id="eng-a" if i % 2 == 0 else "eng-b",
            actual_start_week=(20 + i) if (i % 5 == 0) else None,
        )
        for i in range(12)
    )
    romania_chamber = ChamberInput(
        "ch-ro1", "RO-CH1", "Romania", max_concurrent=2, allowed_stages=("PDD-F",)
    )
    schedule_input = ScheduleInput(
        projects=projects,
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1, CHAMBER_GR2, romania_chamber),
        workflow_steps=TEMPLATE,
        lead_times=LEAD_TIMES,
    )
    out1 = run_greedy_sgs(schedule_input)
    out2 = run_greedy_sgs(schedule_input)
    check("determinism: structurally equal across two runs", out1 == out2)
    check("determinism: repr() byte-identical across two runs", repr(out1) == repr(out2))

    # Re-run with the SAME projects supplied in a shuffled tuple order — the
    # project_id tiebreak (see _sort_key docstring) must make this irrelevant.
    shuffled_input = ScheduleInput(
        projects=tuple(reversed(projects)),
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1, CHAMBER_GR2, romania_chamber),
        workflow_steps=TEMPLATE,
        lead_times=LEAD_TIMES,
    )
    out3 = run_greedy_sgs(shuffled_input)
    check("determinism: independent of ScheduleInput.projects' supplied order", out1 == out3)


def main() -> int:
    scenario_normal_case()
    scenario_single_engineer_contention()
    scenario_chamber_saturation()
    scenario_frozen_conflict()
    scenario_left_out_at_horizon()
    scenario_category_mismatch()
    scenario_oem_hub_requires_oem_allowed_category()
    scenario_oem_project_on_greece_capacity_hub()
    scenario_spillover_boundary()
    scenario_delay_is_terminal_not_propagated()
    scenario_excluded_statuses()
    scenario_determinism()

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
