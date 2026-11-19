"""P36-T02 -- rank within a priority band (ADR 0050 as ruled, R36-1..R36-10).

DOMAIN_RULES "Scheduling order" key 3a: `band_rank` ascending, None last,
after priority and before status. `ProjectInput.band_rank` defaults to None
and the canonical input omits it then, so every pre-P36 golden file / token is
byte-identical (the golden-file suites cover the default path; the explicit
checks below cover the field itself). Pure, in-process; no DB.
"""

from __future__ import annotations

import dataclasses

import pytest

from scheduling import ProjectInput, ScheduleInput, run_cp_sat, run_greedy_sgs, validate_invariants
from scheduling._selftest_common import SELFTEST_WEEK, load_seed_schedule_input
from scheduling.band_rank import (
    BandRankError,
    append_all_last,
    append_last,
    band_of,
    band_orders_from_inputs,
    is_band_member,
    move_band_inputs,
    order_by_rank,
    place,
    place_inputs,
    ranks,
    remove,
    transition,
)
from scheduling.cp_sat import objective_weights
from scheduling.greedy import _sort_key
from scheduling.invariants import (
    check_i37b_band_ranks_dense,
    check_i37c_placement,
)
from scheduling.plan_import import PlanImportRequest, build_plan_import_input
from scheduling.types import ScheduleOutput
from scheduling.whatif import Scenario, build_scenario_input
from scheduling.workflow import canonical_schedule_input_asdict
from tests.scheduling._fixtures import (
    CHAMBER_GR1,
    ENGINEER_A,
    ENGINEER_B,
    LEAD_TIMES,
    TEMPLATE,
    base_project,
)
from tests.scheduling._whatif_fixtures import tiny_baseline
from tests.scheduling.test_p32_plan_import import plan_project, row


def _input(*projects: ProjectInput, **kw: object) -> ScheduleInput:
    return ScheduleInput(
        projects=projects,
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        lead_times=LEAD_TIMES,
        **{"current_week": SELFTEST_WEEK, **kw},  # type: ignore[arg-type]
    )


def _codes(violations: tuple[object, ...]) -> list[str]:
    return [v.invariant for v in violations]  # type: ignore[attr-defined]


# =====================================================================================
# Field default and byte-identity (R36-1)
# =====================================================================================


def test_band_rank_defaults_none() -> None:
    assert base_project().band_rank is None
    assert ProjectInput.__dataclass_fields__["band_rank"].default is None


def test_canonical_asdict_omits_none_band_rank_and_keeps_a_set_one() -> None:
    si = _input(base_project(project_id="a"), base_project(project_id="b", band_rank=2))
    data = canonical_schedule_input_asdict(si)
    assert "band_rank" not in data["projects"][0]
    assert data["projects"][1]["band_rank"] == 2
    raw = dataclasses.asdict(si)
    del raw["categories"]
    del raw["projects"][0]["band_rank"]
    for project in raw["projects"]:
        del project["step_pins"]  # P40 (R40-12): omitted when empty
        del project["actual_end_week"]  # P53 (R53-2b): omitted when None
    assert data == raw


def test_seed_all_none_is_byte_identical_to_explicit_none() -> None:
    si = load_seed_schedule_input()
    assert all(p.band_rank is None for p in si.projects)
    explicit = dataclasses.replace(
        si, projects=tuple(dataclasses.replace(p, band_rank=None) for p in si.projects)
    )
    assert repr(run_greedy_sgs(si)) == repr(run_greedy_sgs(explicit))
    assert canonical_schedule_input_asdict(si) == canonical_schedule_input_asdict(explicit)


def test_backfill_identity_on_seed() -> None:
    """R36-1: ranking every banded project by its current in-band order
    (status, category rank, id) gives the identical schedule, VIP / frozen
    included."""

    si = load_seed_schedule_input()
    base = run_greedy_sgs(si)
    by_id = {p.project_id: p for p in si.projects}
    counter: dict[str, int] = {}
    rank_of: dict[str, int] = {}
    # The current in-band order ignoring frozen / VIP = the walk order sorted
    # by (priority, status, category, id), i.e. _sort_key without keys 1, 1a
    # (P42) and 2.
    for p in sorted((by_id[i] for i in base.scheduling_order), key=lambda p: _sort_key(p)[3:]):
        counter[p.priority] = counter.get(p.priority, 0) + 1  # type: ignore[index]
        rank_of[p.project_id] = counter[p.priority]  # type: ignore[index]
    ranked = dataclasses.replace(
        si,
        projects=tuple(
            dataclasses.replace(p, band_rank=rank_of.get(p.project_id)) for p in si.projects
        ),
    )
    out = run_greedy_sgs(ranked)
    assert out.scheduling_order == base.scheduling_order
    assert out.project_outcomes == base.project_outcomes
    assert validate_invariants(ranked, out, check_determinism=False, live_state=False) == ()


# =====================================================================================
# Sort key (key 3a) -- greedy and CP-SAT order
# =====================================================================================


def test_sort_key_band_rank_between_priority_and_status() -> None:
    buyoff_r3 = base_project(project_id="a", status="In Buyoff", band_rank=3)
    queue_r1 = base_project(project_id="b", status="In Queue", band_rank=1)
    unranked_buyoff = base_project(project_id="c", status="In Buyoff")
    p2_r1 = base_project(project_id="d", priority="P2", band_rank=1)
    vip_r9 = base_project(project_id="e", is_vip=True, band_rank=9)
    order = [
        p.project_id
        for p in sorted([p2_r1, unranked_buyoff, buyoff_r3, queue_r1, vip_r9], key=_sort_key)
    ]
    # VIP above everything non-frozen; in P1: rank 1, rank 3, then unranked; P2 last.
    assert order == ["e", "b", "a", "c", "d"]
    # category rank is the value at index 6 (P42: key 1a sits at index 1)
    assert _sort_key(base_project(category="C"), {"C": 40})[6] == 40


def test_greedy_honours_rank_on_shared_leader() -> None:
    """Both P1, same leader. Without ranks the In Buyoff project goes first
    (status); with ranks the In Queue project ranked 1 books first."""

    buyoff = base_project(project_id="p-buy", status="In Buyoff")
    queue = base_project(project_id="p-q", status="In Queue")
    assert run_greedy_sgs(_input(buyoff, queue)).scheduling_order == ("p-buy", "p-q")

    si = _input(dataclasses.replace(buyoff, band_rank=2), dataclasses.replace(queue, band_rank=1))
    out = run_greedy_sgs(si)
    assert out.scheduling_order == ("p-q", "p-buy")
    o = {x.project_id: x for x in out.project_outcomes}
    q_a = next(s for s in o["p-q"].steps if s.step_id == "PDD-A")
    b_a = next(s for s in o["p-buy"].steps if s.step_id == "PDD-A")
    assert q_a.start_week < b_a.start_week
    assert validate_invariants(si, out) == ()


def test_frozen_rank_change_moves_no_frozen_date() -> None:
    """R36-2: re-ranking a frozen project changes no date of it (I10)."""

    frozen = base_project(project_id="f", frozen=True, actual_start_week=10, band_rank=2)
    other = base_project(project_id="o", band_rank=1, leader_engineer_id="eng-b")
    a = run_greedy_sgs(_input(frozen, other, current_week=10))
    b = run_greedy_sgs(
        _input(
            dataclasses.replace(frozen, band_rank=1),
            dataclasses.replace(other, band_rank=2),
            current_week=10,
        )
    )
    fa = next(o for o in a.project_outcomes if o.project_id == "f")
    fb = next(o for o in b.project_outcomes if o.project_id == "f")
    assert fa.steps == fb.steps


def test_cp_sat_order_honours_rank_and_objective_ignores_it() -> None:
    buyoff = base_project(project_id="p-buy", status="In Buyoff", band_rank=2)
    queue = base_project(project_id="p-q", status="In Queue", band_rank=1)
    si = _input(buyoff, queue, current_week=10, within_year_week=40)
    out, _ = run_cp_sat(si, deterministic_time=1.0, earliness_deterministic_time=0.5)
    assert out.scheduling_order == ("p-q", "p-buy")
    assert validate_invariants(si, out, check_determinism=False) == ()
    # R36-4: the objective weights are the band weights whatever the rank.
    unranked = [dataclasses.replace(p, band_rank=None) for p in si.projects]
    assert objective_weights(si.projects) == objective_weights(unranked)


# =====================================================================================
# What-if (R36-5) and plan import (R36-7)
# =====================================================================================


def test_whatif_override_to_other_band_clears_rank_same_band_keeps() -> None:
    p1 = dataclasses.replace(plan_project("p1", prio="P2"), band_rank=1)
    p2 = dataclasses.replace(plan_project("p2", prio="P2"), band_rank=2)
    base = tiny_baseline(projects=(p1, p2))
    inp = build_scenario_input(base, Scenario(priority_overrides=(("p1", "P1"), ("p2", "P2"))))
    got = {p.project_id: p for p in inp.projects}
    assert (got["p1"].priority, got["p1"].band_rank) == ("P1", None)
    assert (got["p2"].priority, got["p2"].band_rank) == ("P2", 2)


def test_plan_import_merge_inherits_rank_only_when_band_kept() -> None:
    p1 = dataclasses.replace(plan_project("p1", prio="P3"), band_rank=4)
    p2 = dataclasses.replace(plan_project("p2", prio="P2"), band_rank=1)
    base = tiny_baseline(projects=(p1, p2), engineers=2)
    req = PlanImportRequest(
        projects=(row(5, replaces="p1", prio="P3"), row(6, replaces="p2", prio="P1"), row(7)),
        mode="merge",
    )
    si = build_plan_import_input(base, req)
    by_name = {p.name: p for p in si.projects}
    assert by_name["Imported 5"].band_rank == 4  # replaced p1, same band P3
    assert by_name["Imported 6"].band_rank is None  # band changed P2 -> P1
    assert by_name["Imported 7"].band_rank is None  # no replacement


def test_plan_import_file_only_is_unranked() -> None:
    p1 = dataclasses.replace(plan_project("p1", prio="P3"), band_rank=1)
    base = tiny_baseline(projects=(p1,))
    req = PlanImportRequest(projects=(row(5, replaces="p1", prio="P3"),), mode="file_only")
    si = build_plan_import_input(base, req)
    assert all(p.band_rank is None for p in si.projects)


# =====================================================================================
# Invariants: I30 revised, I37a/b/c
# =====================================================================================


def _out(order: tuple[str, ...]) -> ScheduleOutput:
    return ScheduleOutput(project_outcomes=(), scheduling_order=order)


def _i30_i37(si: ScheduleInput, order: tuple[str, ...]) -> list[str]:
    from scheduling.invariants import (
        _build_ctx,
        _check_i30_category_order,
        _check_i37a_band_rank_order,
    )

    ctx, _ = _build_ctx(si, _out(order))
    return _codes(tuple(_check_i30_category_order(ctx) + _check_i37a_band_rank_order(ctx)))


def test_i30_no_false_positive_across_ranks() -> None:
    """R36-9: same status, different rank, decreasing category -> not I30."""

    a = base_project(project_id="a", category="C", band_rank=1)
    b = base_project(project_id="b", category="A", band_rank=2)
    assert _i30_i37(_input(a, b), ("a", "b")) == []
    # equal rank (both None) still falls through to I30
    a0, b0 = dataclasses.replace(a, band_rank=None), dataclasses.replace(b, band_rank=None)
    assert _i30_i37(_input(a0, b0), ("a", "b")) == ["I30"]


def test_i37a_rank_decrease_and_none_before_int() -> None:
    a = base_project(project_id="a", band_rank=2)
    b = base_project(project_id="b", band_rank=1)
    assert _i30_i37(_input(a, b), ("a", "b")) == ["I37a"]
    n = base_project(project_id="n")
    assert _i30_i37(_input(n, b), ("n", "b")) == ["I37a"]
    assert _i30_i37(_input(n, b), ("b", "n")) == []


def test_i37a_non_contiguous_group() -> None:
    a = base_project(project_id="a", band_rank=1)
    x = base_project(project_id="x", priority="P2", band_rank=1)
    b = base_project(project_id="b", band_rank=2)
    assert "I37a" in _i30_i37(_input(a, x, b), ("a", "x", "b"))


def test_i37a_invalid_rank_value() -> None:
    a = base_project(project_id="a", band_rank=0)
    assert _i30_i37(_input(a), ("a",)) == ["I37a"]


def test_i37b_dense_and_membership() -> None:
    ok = [
        base_project(project_id="a", band_rank=1),
        base_project(project_id="b", band_rank=2),
        base_project(project_id="c", priority="P2", band_rank=1),
        base_project(project_id="h", status="On Hold"),
    ]
    assert check_i37b_band_ranks_dense(ok) == ()
    gap = [base_project(project_id="a", band_rank=1), base_project(project_id="b", band_rank=3)]
    assert _codes(check_i37b_band_ranks_dense(gap)) == ["I37b"]
    held_ranked = [base_project(project_id="h", status="On Hold", band_rank=1)]
    assert _codes(check_i37b_band_ranks_dense(held_ranked)) == ["I37b"]
    unranked_member = [base_project(project_id="a")]
    assert _codes(check_i37b_band_ranks_dense(unranked_member)) == ["I37b", "I37b"]


def test_validate_invariants_live_state_runs_i37b() -> None:
    si = _input(base_project(project_id="a", band_rank=2))
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out, check_determinism=False) == ()
    assert _codes(validate_invariants(si, out, check_determinism=False, live_state=True)) == [
        "I37b"
    ]


def test_i37c_placement_checks() -> None:
    before = ["a", "b", "c", "d"]
    assert check_i37c_placement(before, ["a", "d", "b", "c"], "d", before_project_id="b") == ()
    assert check_i37c_placement(before, ["a", "b", "d", "c"], "d", after_project_id="b") == ()
    assert check_i37c_placement(before, ["b", "c", "d", "a"], "a") == ()
    bad = [
        check_i37c_placement(before, ["a", "d", "c", "b"], "d", before_project_id="c"),
        check_i37c_placement(before, ["a", "b", "c", "d"], "d", before_project_id="b"),
        check_i37c_placement(before, ["a", "b", "d", "c"], "d", after_project_id="a"),
        check_i37c_placement(before, ["a", "b", "d", "c"], "d"),
        check_i37c_placement(before, ["a", "b", "c"], "d"),
        check_i37c_placement(
            before, ["d", "a", "b", "c"], "d", before_project_id="a", after_project_id="b"
        ),
    ]
    assert all(v and v[0].invariant == "I37c" for v in bad)
    # "after" anchor at the very front
    assert check_i37c_placement(["a", "b"], ["b", "a"], "b", after_project_id="a")


# =====================================================================================
# band_rank helper module
# =====================================================================================


def test_place_before_after_last_and_entering() -> None:
    band = ["a", "b", "c", "d"]
    assert place(band, "d", before="b") == ["a", "d", "b", "c"]
    assert place(band, "a", after="c") == ["b", "c", "a", "d"]
    assert place(band, "b") == ["a", "c", "d", "b"]
    assert place(band, "a", before="b") == band  # unchanged
    assert place(band, "d") == band  # already last: unchanged
    assert place(band, "x", before="a") == ["x", "a", "b", "c", "d"]  # entering
    assert place(band, "x", after="d") == ["a", "b", "c", "d", "x"]
    assert place([], "x") == ["x"]
    assert band == ["a", "b", "c", "d"]  # input not mutated


def test_place_filtered_board_keeps_hidden_order() -> None:
    """The board shows only b and d (a, c, e hidden). Dropping e above d or
    below b lands it next to the visible card; hidden cards keep their
    order (I37c)."""

    band = ["a", "b", "c", "d", "e"]
    after = place(band, "e", before="d")
    assert after == ["a", "b", "c", "e", "d"]
    assert check_i37c_placement(band, after, "e", before_project_id="d") == ()
    after2 = place(band, "a", after="d")
    assert after2 == ["b", "c", "d", "a", "e"]
    assert check_i37c_placement(band, after2, "a", after_project_id="d") == ()


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [
        ({"before": "a", "after": "b"}, "BOTH_ANCHORS"),
        ({"before": "c"}, "SELF_ANCHOR"),
        ({"after": "zz"}, "NOT_SAME_BAND"),
        ({"before": "zz"}, "NOT_SAME_BAND"),
    ],
)
def test_place_errors(kwargs: dict[str, str], code: str) -> None:
    with pytest.raises(BandRankError) as exc:
        place(["a", "b", "c"], "c", **kwargs)
    assert exc.value.code == code
    assert isinstance(exc.value, ValueError)


def test_duplicate_ids_rejected() -> None:
    with pytest.raises(BandRankError) as exc:
        ranks(["a", "a"])
    assert exc.value.code == "DUPLICATE_ID"


def test_append_remove_ranks_order() -> None:
    assert append_last(["a", "b"], "c") == ["a", "b", "c"]
    with pytest.raises(BandRankError, match="ALREADY_IN_BAND"):
        append_last(["a", "b"], "a")
    assert append_all_last(["z"], ["c", "a", "c"]) == ["z", "a", "c"]
    assert remove(["a", "b", "c"], "b") == ["a", "c"]
    with pytest.raises(BandRankError, match="NOT_IN_BAND"):
        remove(["a"], "b")
    assert ranks(["c", "a"]) == {"c": 1, "a": 2}
    assert order_by_rank([("b", 5), ("a", 5), ("c", 1)]) == ["c", "a", "b"]


def test_membership() -> None:
    assert is_band_member("In Queue", "P1")
    assert not is_band_member("On Hold", "P1")
    assert not is_band_member("In Queue", None)
    assert band_of("In Development", "P2") == "P2"
    assert band_of("Draft", "P2") is None


def test_transition_lifecycle() -> None:
    orders = {"P1": ["a", "b"], "P2": ["c"]}
    assert transition(orders, "a", band_before="P1", band_after="P1") == {}
    assert transition(orders, "a", band_before="P1", band_after="P2") == {
        "P1": ["b"],
        "P2": ["c", "a"],
    }
    assert transition(orders, "a", band_before="P1", band_after=None) == {"P1": ["b"]}
    assert transition(orders, "n", band_before=None, band_after="P3") == {"P3": ["n"]}
    assert transition(orders, "n", band_before=None, band_after=None) == {}


def _ranks_of(projects: tuple[ProjectInput, ...]) -> dict[str, int | None]:
    return {p.project_id: p.band_rank for p in projects}


def test_move_band_inputs_priority_move() -> None:
    projects = (
        base_project(project_id="a", band_rank=1),
        base_project(project_id="b", band_rank=2),
        base_project(project_id="c", band_rank=3),
        base_project(project_id="x", priority="P2", band_rank=1),
    )
    moved = move_band_inputs(projects, "a", priority="P2")
    assert _ranks_of(moved) == {"a": 2, "b": 1, "c": 2, "x": 1}
    assert [p.project_id for p in moved] == ["a", "b", "c", "x"]
    assert next(p for p in moved if p.project_id == "a").priority == "P2"
    assert check_i37b_band_ranks_dense(moved) == ()
    # same band, schedulable -> schedulable status: rank kept (R36-3)
    same = move_band_inputs(projects, "b", priority="P1", status="In Buyoff")
    assert _ranks_of(same) == _ranks_of(projects)
    assert next(p for p in same if p.project_id == "b").status == "In Buyoff"
    # leaving every band: cleared, old band renumbered
    held = move_band_inputs(projects, "a", priority="P1", status="On Hold")
    assert _ranks_of(held) == {"a": None, "b": 1, "c": 2, "x": 1}
    assert check_i37b_band_ranks_dense(held) == ()
    # entering from On Hold: last
    back = move_band_inputs(held, "a", priority="P1", status="In Queue")
    assert _ranks_of(back) == {"a": 3, "b": 1, "c": 2, "x": 1}
    with pytest.raises(KeyError):
        move_band_inputs(projects, "nope", priority="P1")


def test_place_inputs_rerank_and_errors() -> None:
    projects = (
        base_project(project_id="a", band_rank=1),
        base_project(project_id="b", band_rank=2),
        base_project(project_id="c", band_rank=3),
        base_project(project_id="x", priority="P2", band_rank=1),
    )
    out = place_inputs(projects, "c", before="a")
    assert _ranks_of(out) == {"a": 2, "b": 3, "c": 1, "x": 1}
    assert band_orders_from_inputs(out) == {"P1": ["c", "a", "b"], "P2": ["x"]}
    assert place_inputs(projects, "c") == projects  # already last: unchanged
    with pytest.raises(BandRankError, match="NOT_SAME_BAND"):
        place_inputs(projects, "c", before="x")
    held = (*projects, base_project(project_id="h", status="On Hold"))
    with pytest.raises(BandRankError, match="NOT_A_MEMBER"):
        place_inputs(held, "h")
    with pytest.raises(BandRankError, match="NOT_SAME_BAND"):
        place_inputs(held, "a", before="h")  # a held P1 project is not in the band
