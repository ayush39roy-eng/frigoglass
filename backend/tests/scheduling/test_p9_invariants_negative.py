"""P9-T02 negative-path coverage for the revised / added invariants.

Each test takes a *correct* greedy output, hand-breaks exactly one thing with
`dataclasses.replace`, and asserts `validate_invariants` reports the matching
invariant id. I15 and I11 are the two the brief requires explicitly.
"""

from __future__ import annotations

from dataclasses import replace

from scheduling import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ScheduleInput,
    ScheduleOutput,
    default_workflow_templates,
    run_greedy_sgs,
    validate_invariants,
)
from tests.scheduling._fixtures import progress

ENG_A = EngineerInput("eng-a", "A", "R&D-Greece", ("A+", "A", "B", "C"))
CH_GR = ChamberInput("ch-gr", "GR", "Greece", max_concurrent=1, allowed_stages=("PDD-F", "PDD-H"))


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
    return ScheduleInput(projects=projects, engineers=(ENG_A,), chambers=(CH_GR,), **kw)  # type: ignore[arg-type]


def _break_step(out: ScheduleOutput, pid: str, target: str, /, **changes: object) -> ScheduleOutput:
    outcomes = []
    for o in out.project_outcomes:
        if o.project_id == pid:
            steps = tuple(
                replace(s, **changes) if s.step_id == target else s  # type: ignore[arg-type]
                for s in o.steps
            )
            o = replace(o, steps=steps)
        outcomes.append(o)
    return replace(out, project_outcomes=tuple(outcomes))


def _break_outcome(out: ScheduleOutput, pid: str, **changes: object) -> ScheduleOutput:
    return replace(
        out,
        project_outcomes=tuple(
            replace(o, **changes) if o.project_id == pid else o  # type: ignore[arg-type]
            for o in out.project_outcomes
        ),
    )


def _ids(violations) -> set[str]:
    return {v.invariant for v in violations}


def _edited_dag():
    return tuple(
        replace(t, predecessor_ids=("PDD-G",))
        if t.step_id == "PDD-I"
        else replace(t, predecessor_ids=("PDD-H", "PDD-I"))
        if t.step_id == "PDD-J"
        else t
        for t in default_workflow_templates()
    )


def test_i15_step_starting_before_dag_predecessor_is_caught():
    """Edited DAG: PDD-J depends on both PDD-H and PDD-I. Moving J so it
    starts while H (its non-consecutive DAG predecessor) is still running
    must be caught as I15 and I3 — even though J still starts after I."""

    si = _si(_project(category="A+"), workflow_steps=_edited_dag())
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out, check_determinism=False) == ()
    broken = _break_step(out, "p", "PDD-J", start_week=63, end_week=63)  # H ends 64
    ids = _ids(validate_invariants(si, broken, check_determinism=False))
    assert {"I15", "I3"} <= ids


def test_i15_cyclic_graph_in_input_is_caught():
    si = _si(_project())
    out = run_greedy_sgs(si)
    cyclic = tuple(
        replace(t, predecessor_ids=("PDD-N",)) if t.step_id == "PDD-A" else t
        for t in default_workflow_templates()
    )
    ids = _ids(
        validate_invariants(replace(si, workflow_steps=cyclic), out, check_determinism=False)
    )
    assert "I15" in ids


def test_i15_foreign_step_row_is_caught():
    si = _si(_project())
    out = run_greedy_sgs(si)
    broken = _break_step(out, "p", "PDD-N", step_id="OEM-N")
    assert "I15" in _ids(validate_invariants(si, broken, check_determinism=False))


def test_i11_done_stage_replaced_is_caught():
    p = _project(
        step_progress=(
            progress(
                "PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20
            ),
        )
    )
    si = _si(p)
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out, check_determinism=False) == ()
    broken = _break_step(out, "p", "PDD-A", start_week=31, end_week=31)
    assert "I11" in _ids(validate_invariants(si, broken, check_determinism=False))


def test_i5_skipped_row_with_duration_is_caught():
    si = _si(_project())
    out = run_greedy_sgs(si)
    broken = _break_step(out, "p", "PDD-B", duration_weeks=2, end_week=33)
    assert "I5" in _ids(validate_invariants(si, broken, check_determinism=False))
    unskipped = _break_step(out, "p", "PDD-B", skipped=False)
    assert "I5" in _ids(validate_invariants(si, unskipped, check_determinism=False))


def test_i5_data_error_with_rows_is_caught():
    si = _si(_project(step_progress=(progress("PDD-E", "In Progress"),)))
    out = run_greedy_sgs(si)
    good = run_greedy_sgs(_si(_project()))
    broken = _break_outcome(out, "p", steps=good.project_outcomes[0].steps)
    assert "I5" in _ids(validate_invariants(si, broken, check_determinism=False))


def test_i6_duration_not_matching_lead_time_table_is_caught():
    si = _si(_project())
    out = run_greedy_sgs(si)
    broken = _break_step(out, "p", "PDD-E", duration_weeks=3)
    assert "I6" in _ids(validate_invariants(si, broken, check_determinism=False))
    broken_lab = _break_step(out, "p", "PDD-H", duration_weeks=3)
    assert "I7" in _ids(validate_invariants(si, broken_lab, check_determinism=False))


def test_i12_unweighted_progress_pct_is_caught():
    p = _project(
        step_progress=(
            progress(
                "PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20
            ),
        )
    )
    si = _si(p)
    out = run_greedy_sgs(si)
    # A 14-way unweighted mean would give round(100 / 14) = 7, not 6 (=1/18).
    broken = _break_outcome(out, "p", progress_pct=7)
    assert "I12" in _ids(validate_invariants(si, broken, check_determinism=False))


def test_i16_completion_lines_inconsistent_are_caught():
    si = _si(_project(target_end_week=50, delay_weeks=2))
    out = run_greedy_sgs(si)
    for changes in (
        {"projected_end_week": 48},  # forgot the delay
        {"expected_end_week": 48},  # ignored target_end_week
        {"unconstrained_end_week": 40},  # not the DAG walk
    ):
        broken = _break_outcome(out, "p", **changes)
        assert "I16" in _ids(validate_invariants(si, broken, check_determinism=False)), changes


def test_i1_anchored_conflict_without_flag_is_caught():
    """Two In Progress tails on the same leader overlap (a legitimate
    conflict of recorded reality) — the run must raise ENG_CONFLICT; removing
    the flag must be caught."""

    rows = (progress("PDD-A", "In Progress", percent_complete=0, actual_start_week=30),)
    si = _si(_project("p1", step_progress=rows), _project("p2", priority="P2", step_progress=rows))
    out = run_greedy_sgs(si)
    assert any(o.eng_conflict for o in out.project_outcomes)
    assert validate_invariants(si, out, check_determinism=False) == ()
    broken = replace(
        out,
        project_outcomes=tuple(replace(o, eng_conflict=False) for o in out.project_outcomes),
    )
    assert "I1" in _ids(validate_invariants(si, broken, check_determinism=False))


def test_i9_blocked_project_counted_within_year_is_caught():
    rows = (progress("PDD-A", "Blocked", percent_complete=0, actual_start_week=30),)
    si = _si(_project(step_progress=rows))
    out = run_greedy_sgs(si)
    assert out.project_outcomes[0].blocked
    broken = _break_outcome(out, "p", within_year=True)
    assert "I9" in _ids(validate_invariants(si, broken, check_determinism=False))
