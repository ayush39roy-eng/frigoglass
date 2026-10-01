"""P9-T02 golden files — the 2026-09-27 contract (ADRs 0006/0007/0009).

Every expected week below is hand-derived from `docs/DOMAIN_RULES.md`'s
lead-time table and rules (the prototype oracle is retired and was not
consulted). Default `ScheduleInput.workflow_steps` / `lead_times` (the
seeded strict chain and the 98-row table) are used unless a test edits them.

Lead times used (DOMAIN_RULES.md "Lead times"), steps A..N:
    PDD / A+ : 1 8 4 1 6 6 2 6 2 1 2 3 1 1   (Σ 44)
    PDD / B  : 1 0 0 1 4 0 0 6 0 1 2 1 1 1   (Σ 18)
    OEM / B-OEM: 1 1 1 0 0 2 2 6 0 1 0 0 0 0 (Σ 14)

Every test asserts the documented outcome AND `validate_invariants == ()`.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from scheduling import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ScheduleInput,
    default_lead_times,
    default_workflow_templates,
    run_cp_sat,
    run_greedy_sgs,
    validate_invariants,
)
from tests.scheduling._fixtures import progress

ENG_A = EngineerInput("eng-a", "A", "R&D-Greece", ("A+", "A", "B", "C"))
ENG_B = EngineerInput("eng-b", "B", "R&D-Greece", ("A+", "A", "B", "C"))
ENG_OEM = EngineerInput("eng-oem", "OEM lead", "OEM-HCK", ("B-OEM",))
CH_GR = ChamberInput("ch-gr", "GR", "Greece", max_concurrent=1, allowed_stages=("PDD-F", "PDD-H"))
CH_IN = ChamberInput(
    "ch-in", "IN", "India", max_concurrent=1, allowed_stages=("OEM-E", "OEM-H", "PDD-F", "PDD-H")
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
        projects=projects, engineers=(ENG_A, ENG_B, ENG_OEM), chambers=(CH_GR, CH_IN)
    )
    base.update(kw)
    return ScheduleInput(**base)  # type: ignore[arg-type]


def _run(si: ScheduleInput):
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    return out, {o.project_id: o for o in out.project_outcomes}


def _weeks(outcome) -> dict[str, tuple[int, int, bool]]:
    return {s.step_id: (s.start_week, s.end_week, s.skipped) for s in outcome.steps}


# --- Defaults ------------------------------------------------------------------


def test_default_tables_transcribed_from_domain_rules():
    templates = default_workflow_templates()
    assert len(templates) == 28
    lts = default_lead_times()
    assert len(lts) == 98
    sums: dict[tuple[str, str], int] = {}
    for lt in lts:
        sums[(lt.workflow_id, lt.category)] = sums.get((lt.workflow_id, lt.category), 0) + lt.weeks
    assert sums == {
        ("PDD", "A+"): 44,
        ("PDD", "A"): 38,
        ("PDD", "B"): 18,
        ("PDD", "C"): 8,
        ("OEM", "A-OEM"): 21,
        ("OEM", "B-OEM"): 14,
        ("OEM", "C-OEM"): 4,
    }
    kinds = {t.step_id: t.kind for t in templates}
    assert [s for s, k in kinds.items() if k == "lab"] == ["PDD-F", "PDD-H", "OEM-E", "OEM-H"]
    assert {s for s, k in kinds.items() if k == "elapsed"} == {
        "PDD-C", "PDD-G", "PDD-L", "PDD-N", "OEM-C", "OEM-F", "OEM-L", "OEM-N",
    }  # fmt: skip
    pdd = [t for t in templates if t.workflow_id == "PDD"]
    assert pdd[0].predecessor_ids == ()
    assert all(t.predecessor_ids == (pdd[i].step_id,) for i, t in enumerate(pdd[1:]))


# --- Strict chain, skipped steps, OEM, edited DAG, certification flag -----------


def test_strict_chain_pdd_a_plus():
    _, by = _run(_si(_project(category="A+")))
    o = by["p"]
    w = _weeks(o)
    assert w["PDD-A"] == (31, 31, False)
    assert w["PDD-B"] == (32, 39, False)
    assert w["PDD-C"] == (40, 43, False)  # elapsed, books nothing
    assert w["PDD-F"] == (51, 56, False)
    assert w["PDD-H"] == (59, 64, False)
    assert w["PDD-N"] == (74, 74, False)
    assert (o.start_week, o.end_week) == (31, 74)  # 31 + 44 - 1
    elapsed_rows = [s for s in o.steps if s.kind == "elapsed"]
    assert all(
        s.assigned_engineer_id is None and s.assigned_chamber_id is None for s in elapsed_rows
    )
    assert o.spillover and not o.within_year


def test_pdd_b_skipped_steps_are_transparent():
    _, by = _run(_si(_project(category="B")))
    o = by["p"]
    w = _weeks(o)
    assert len(o.steps) == 14  # I5: skipped rows present
    assert w["PDD-A"] == (31, 31, False)
    assert w["PDD-B"] == (31, 31, True)  # start = end = pred end
    assert w["PDD-C"] == (31, 31, True)
    assert w["PDD-D"] == (32, 32, False)
    assert w["PDD-E"] == (33, 36, False)
    assert w["PDD-F"] == (36, 36, True)
    assert w["PDD-G"] == (36, 36, True)
    assert w["PDD-H"] == (37, 42, False)
    assert w["PDD-I"] == (42, 42, True)
    assert w["PDD-N"] == (48, 48, False)
    assert o.end_week == 48  # 31 + 18 - 1
    assert all(s.duration_weeks == 0 for s in o.steps if s.skipped)
    assert o.within_year


def test_oem_b_oem_workflow():
    p = _project(hub="OEM-HCK", category="B-OEM", workflow_id="OEM", leader_engineer_id="eng-oem")
    _, by = _run(_si(p))
    o = by["p"]
    w = _weeks(o)
    assert [s.step_id for s in o.steps][0] == "OEM-A"
    assert w["OEM-A"] == (31, 31, False)
    assert w["OEM-B"] == (32, 32, False)
    assert w["OEM-C"] == (33, 33, False)  # elapsed
    assert w["OEM-D"] == (33, 33, True)
    assert w["OEM-E"] == (33, 33, True)  # lab, 0 weeks for B-OEM
    assert w["OEM-F"] == (34, 35, False)  # elapsed
    assert w["OEM-G"] == (36, 37, False)
    assert w["OEM-H"] == (38, 43, False)
    assert w["OEM-J"] == (44, 44, False)
    assert w["OEM-N"] == (44, 44, True)
    assert o.end_week == 44  # 31 + 14 - 1
    assert {s.assigned_chamber_id for s in o.steps if s.step_id == "OEM-H"} == {"ch-in"}
    # Leader lists the project's own OEM category -> eligible (ADR 0007).
    assert not o.cat_not_allowed


def test_oem_hub_leader_without_oem_eligibility_raises_cat_not_allowed():
    p = _project(hub="OEM-HCK", category="B-OEM", workflow_id="OEM", leader_engineer_id="eng-a")
    _, by = _run(_si(p))
    assert by["p"].cat_not_allowed and not by["p"].left_out


def test_edited_dag_lab_parallel_with_design():
    """PDD-I (TF-1, design) depends on PDD-G instead of PDD-H; PDD-J waits for
    both H and I. Certification (lab) and TF-1 (design) then overlap."""

    steps = tuple(
        replace(t, predecessor_ids=("PDD-G",))
        if t.step_id == "PDD-I"
        else replace(t, predecessor_ids=("PDD-H", "PDD-I"))
        if t.step_id == "PDD-J"
        else t
        for t in default_workflow_templates()
    )
    si = _si(_project(category="A+"), workflow_steps=steps)
    _, by = _run(si)
    o = by["p"]
    w = _weeks(o)
    assert w["PDD-H"] == (59, 64, False)
    assert w["PDD-I"] == (59, 60, False)  # in parallel with H
    assert w["PDD-J"] == (65, 65, False)  # max(H.end, I.end) + 1
    assert o.end_week == 72  # two weeks earlier than the strict chain
    assert o.unconstrained_end_week == 72

    out_cp, _ = run_cp_sat(si)
    assert validate_invariants(si, out_cp, check_determinism=False) == ()


def test_certification_testing_not_required_skips_lab_steps():
    p = _project(category="A+", certification_testing_required=False)
    _, by = _run(_si(p, chambers=()))  # no chamber needed at all
    o = by["p"]
    w = _weeks(o)
    assert w["PDD-F"] == (50, 50, True)
    assert w["PDD-H"] == (52, 52, True)
    assert o.end_week == 62  # 31 + (44 - 12) - 1
    assert not o.left_out and o.no_chamber_step_id is None


# --- Progress: the four statuses, mixed, frozen wins, data_error ----------------


def test_progress_done_is_fixed_history():
    p = _project(
        step_progress=(
            progress(
                "PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20
            ),
            progress(
                "PDD-D", "Done", percent_complete=100, actual_start_week=21, actual_end_week=21
            ),
        )
    )
    _, by = _run(_si(p))
    o = by["p"]
    w = _weeks(o)
    assert w["PDD-A"] == (20, 20, False)  # I11
    assert w["PDD-D"] == (21, 21, False)
    assert w["PDD-E"] == (31, 34, False)  # floored at CURRENT_WEEK
    assert o.start_week == 20 and o.end_week == 46
    assert o.progress_pct == 11  # round((100*1 + 100*1) / 18)
    assert o.unconstrained_end_week == 46


def test_progress_in_progress_books_only_remaining():
    done = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=25, actual_end_week=25),
        progress("PDD-D", "Done", percent_complete=100, actual_start_week=26, actual_end_week=26),
    )
    p = _project(
        step_progress=done
        + (progress("PDD-E", "In Progress", percent_complete=50, actual_start_week=28),)
    )
    _, by = _run(_si(p))
    o = by["p"]
    w = _weeks(o)
    assert w["PDD-E"] == (28, 32, False)  # start fixed; tail = ceil(4 * 0.5) = 2 weeks from 31
    assert w["PDD-H"] == (33, 38, False)
    assert o.end_week == 44
    assert o.progress_pct == 22  # round((100 + 100 + 50*4) / 18)

    p2 = _project(
        step_progress=done
        + (
            progress(
                "PDD-E",
                "In Progress",
                percent_complete=50,
                actual_start_week=28,
                remaining_weeks_override=3,
            ),
        )
    )
    _, by2 = _run(_si(p2))
    assert _weeks(by2["p"])["PDD-E"] == (28, 33, False)  # override wins


def test_progress_not_started_row_is_normal_scheduling():
    plain = run_greedy_sgs(_si(_project()))
    p = _project(step_progress=(progress("PDD-E", "Not Started", percent_complete=30),))
    out, by = _run(_si(p))
    assert by["p"].steps == plain.project_outcomes[0].steps
    # Ruling 3 (P9-R01): the roll-up uses the *stored* percent_complete, the
    # same values the Workspace reads, so both paths agree. (Not Started ⇒ 0
    # is enforced at write time; scheduling still treats the step as Not
    # Started.) round(30 * 4 / 18) = 7.
    assert by["p"].progress_pct == 7


def test_progress_blocked_holds_step_and_successors():
    blocked = _project(
        "p-blocked",
        step_progress=(
            progress(
                "PDD-A", "Done", percent_complete=100, actual_start_week=25, actual_end_week=25
            ),
            progress(
                "PDD-D", "Done", percent_complete=100, actual_start_week=26, actual_end_week=26
            ),
            progress("PDD-E", "Blocked", percent_complete=50, actual_start_week=28),
        ),
    )
    other = _project("p-other", priority="P2")  # same leader, lower priority
    _, by = _run(_si(blocked, other))
    o = by["p-blocked"]
    assert o.blocked
    assert not o.left_out and not o.within_year and not o.spillover
    assert o.projected_end_week is None
    w = _weeks(o)
    assert w["PDD-E"] == (28, 30, False)  # held at the frontier, nothing booked
    assert w["PDD-H"] == (30, 30, False)
    assert all(s.assigned_engineer_id is None for s in o.steps if s.step_id >= "PDD-E")
    # Unconstrained finish assumes the block clears now: tail 31-32, ... N 44.
    assert o.unconstrained_end_week == 44 and o.expected_end_week == 44
    # The held project booked nothing, so the P2 project starts at week 31.
    assert by["p-other"].start_week == 31


def test_progress_mixed_in_progress_keeps_weeks_against_higher_priority():
    """An In Progress tail is pre-booked before any search, so a higher-priority
    Not Started project sharing the leader cannot take those weeks."""

    p1 = _project("p1", priority="P1")
    p2 = _project(
        "p2",
        priority="P2",
        step_progress=(
            progress(
                "PDD-A", "Done", percent_complete=100, actual_start_week=25, actual_end_week=25
            ),
            progress(
                "PDD-D", "Done", percent_complete=100, actual_start_week=26, actual_end_week=26
            ),
            progress("PDD-E", "In Progress", percent_complete=25, actual_start_week=28),
        ),
    )
    si = _si(p1, p2)
    _, by = _run(si)
    assert _weeks(by["p2"])["PDD-E"] == (28, 33, False)  # tail ceil(4*0.75)=3 weeks, 31-33
    assert _weeks(by["p1"])["PDD-A"] == (34, 34, False)  # waits for the in-progress tail
    assert by["p1"].end_week == 51
    assert by["p2"].end_week == 45
    assert by["p1"].end_week > by["p1"].unconstrained_end_week == 48  # capacity delayed it

    out_cp, _ = run_cp_sat(si)
    assert validate_invariants(si, out_cp, check_determinism=False) == ()
    cp_by = {o.project_id: o for o in out_cp.project_outcomes}
    assert _weeks(cp_by["p2"])["PDD-E"] == (28, 33, False)  # anchored on both solvers


def test_frozen_wins_over_progress():
    p = _project(
        frozen=True,
        actual_start_week=10,
        step_progress=(
            progress("PDD-A", "Done", percent_complete=100, actual_start_week=5, actual_end_week=5),
            progress("PDD-E", "Blocked", percent_complete=10, actual_start_week=6),
        ),
    )
    _, by = _run(_si(p))
    o = by["p"]
    w = _weeks(o)
    assert w["PDD-A"] == (10, 10, False)  # locked at actual_start, progress ignored
    assert w["PDD-E"] == (12, 15, False)
    assert o.end_week == 27  # 10 + 18 - 1
    assert not o.blocked and o.data_error is None
    # Ruling 3 (P9-R01, auditor F3): the duration-weighted formula over the
    # stored percents applies to frozen projects too: round((100*1 + 10*4) / 18).
    assert o.progress_pct == 8


def test_data_error_rejects_project_without_booking():
    bad = _project("p-bad", step_progress=(progress("PDD-E", "In Progress", percent_complete=50),))
    other = _project("p-other", priority="P2")
    _, by = _run(_si(bad, other))
    o = by["p-bad"]
    assert o.data_error is not None and "actual_start_week" in o.data_error
    assert o.steps == () and not o.left_out and not o.within_year
    assert o.projected_end_week is None and o.unconstrained_end_week is None
    assert by["p-other"].start_week == 31  # nothing was booked for the rejected project

    for rows, fragment in (
        (
            (progress("PDD-A", "Done", percent_complete=100, actual_start_week=20),),
            "actual_end_week",
        ),
        ((progress("PDD-A", "Paused"),), "unknown status"),
        ((progress("PDD-A", "In Progress", percent_complete=120, actual_start_week=20),), "0..100"),
        ((progress("PDD-A", "Done", actual_start_week=20, actual_end_week=19),), "<"),
        (
            (progress("PDD-A", "In Progress", actual_start_week=20, remaining_weeks_override=-1),),
            "negative",
        ),
        ((progress("OEM-A", "Not Started"),), "unknown step"),
        ((progress("PDD-A", "Not Started"), progress("PDD-A", "Not Started")), "duplicate"),
    ):
        _, by2 = _run(_si(_project(step_progress=rows)))
        assert fragment in (by2["p"].data_error or ""), fragment


# --- Expected / projected / unconstrained ---------------------------------------


def test_expected_projected_unconstrained_values():
    targeted = _project("p1", target_end_week=50, delay_weeks=3)
    _, by = _run(_si(targeted))
    o = by["p1"]
    assert o.end_week == 48 and o.unconstrained_end_week == 48
    assert o.expected_end_week == 50  # target wins
    assert o.projected_end_week == 51  # end + delay
    assert o.within_year  # 51 <= 52

    # Contention: two identical projects, one leader. The second is delayed
    # by capacity; its unconstrained finish is unchanged.
    p1, p2 = _project("p1"), _project("p2", priority="P2")
    _, by2 = _run(_si(p1, p2))
    assert by2["p2"].unconstrained_end_week == 48 == by2["p2"].expected_end_week
    assert by2["p2"].projected_end_week == by2["p2"].end_week > 48


def test_left_out_and_excluded_have_no_projected_week():
    late = _project("p-late", category="A+")
    _, by = _run(_si(late, current_week=60))
    assert by["p-late"].left_out and by["p-late"].projected_end_week is None
    assert by["p-late"].unconstrained_end_week == 103  # 60 + 44 - 1

    gone = _project("p-gone", status="Cancelled")
    _, by2 = _run(_si(gone))
    o = by2["p-gone"]
    assert o.excluded and o.expected_end_week is None and o.projected_end_week is None


# --- Input validation (I15 at input time) ---------------------------------------


def _edit(step_id: str, **kw: object):
    return tuple(
        replace(t, **kw) if t.step_id == step_id else t  # type: ignore[arg-type]
        for t in default_workflow_templates()
    )


@pytest.mark.parametrize(
    ("steps", "fragment"),
    [
        (_edit("PDD-A", predecessor_ids=("PDD-N",)), "cycle"),
        (_edit("PDD-C", predecessor_ids=("PDD-C",)), "references itself"),
        (_edit("PDD-C", predecessor_ids=("OEM-B",)), "not a step of the same workflow"),
        (_edit("PDD-C", predecessor_ids=()), "empty predecessor"),
        (_edit("PDD-C", kind="approval"), "kind"),
        (default_workflow_templates() + default_workflow_templates()[:1], "duplicate"),
    ],
)
def test_invalid_workflow_rejected(steps, fragment):
    with pytest.raises(ValueError, match=fragment):
        run_greedy_sgs(_si(_project(), workflow_steps=steps))


def test_invalid_project_configuration_rejected():
    with pytest.raises(ValueError, match="no lead-time row"):
        run_greedy_sgs(_si(_project(category="A-OEM")))  # PDD workflow, OEM category
    with pytest.raises(ValueError, match="workflow_id"):
        run_greedy_sgs(_si(_project(workflow_id="XYZ")))
    with pytest.raises(ValueError, match="category"):
        run_greedy_sgs(_si(_project(category="Z")))
    lts = default_lead_times()
    with pytest.raises(ValueError, match="negative"):
        run_greedy_sgs(_si(_project(), lead_times=(replace(lts[0], weeks=-1),) + lts[1:]))
    with pytest.raises(ValueError, match="conflicting"):
        run_greedy_sgs(_si(_project(), lead_times=lts + (replace(lts[0], weeks=9),)))


# --- Determinism (I8) over the new inputs ---------------------------------------


def test_determinism_includes_precedence_lead_times_and_progress():
    done_a = progress(
        "PDD-A", "Done", percent_complete=100, actual_start_week=25, actual_end_week=25
    )
    projects = (
        _project("p1", category="A+"),
        _project("p2", priority="P2", step_progress=(done_a,)),
        _project(
            "p3", hub="OEM-HCK", category="B-OEM", workflow_id="OEM", leader_engineer_id="eng-oem"
        ),
    )
    si = _si(*projects)
    out = run_greedy_sgs(si)
    shuffled = _si(
        *reversed(projects),
        workflow_steps=tuple(reversed(default_workflow_templates())),
        lead_times=tuple(reversed(default_lead_times())),
    )
    assert repr(run_greedy_sgs(shuffled)) == repr(out) == repr(run_greedy_sgs(si))
    # Changing a lead time or a precedence edge changes the output.
    lts = tuple(
        replace(lt, weeks=5) if (lt.category, lt.step_id) == ("A+", "PDD-N") else lt
        for lt in default_lead_times()
    )
    assert run_greedy_sgs(_si(*projects, lead_times=lts)) != out
    assert (
        run_greedy_sgs(_si(*projects, workflow_steps=_edit("PDD-L", predecessor_ids=("PDD-J",))))
        != out
    )
