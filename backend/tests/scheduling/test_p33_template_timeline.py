"""P33-T04 — `scheduling.template_timeline` (contract P33 F3; ADR 0046 §5 as
ruled; DOMAIN_RULES "Category templates" §D "Template preview").

0-based, end-exclusive weeks; from week 0; no capacity; FTE 1.0; the
one-leader rule. With every gap 0 it reproduces the pre-P33 category timeline
(`services.workflow_previews.category_preview`: `start = max(end of
predecessors)`, `end = start + length`) for all seven categories.

PDD / B with no gaps (lengths A1 B0 C0 D1 E4 F0 G0 H6 I0 J1 K2 L1 M1 N1):

    start: A0 B1 C1 D1 E2 F6 G6 H6 I12 J12 K13 L15 M16 N17   total 18
"""

from __future__ import annotations

import random
from collections.abc import Mapping

import pytest

from scheduling import (
    FLAG_ANCHOR_CLAMPED,
    FLAG_GAP_IGNORED_ZERO_LENGTH,
    FLAG_SAME_LEADER_SERIALISED,
    TEMPLATE_FLAGS,
    TEMPLATE_VIEW_NOTE,
    ProjectInput,
    StepTimingInput,
    TemplateTimeline,
    WorkflowStepTemplate,
    analyse_project,
    build_lead_time_table,
    build_workflows,
    template_timeline,
    unconstrained_end_week,
)
from scheduling.types import CATEGORY_RANK, default_lead_times, default_workflow_templates
from scheduling.workflow import Workflow

WORKFLOWS = build_workflows(default_workflow_templates())
TABLE = build_lead_time_table(default_lead_times())


def _wf(category: str) -> Workflow:
    return WORKFLOWS["OEM" if category.endswith("-OEM") else "PDD"]


def _lengths(category: str) -> dict[str, int]:
    wf = _wf(category)
    return {s.step_id: TABLE[(wf.workflow_id, category, s.step_id)] for s in wf.steps}


def _starts(tl: TemplateTimeline) -> dict[str, int]:
    return {s.step_id: s.start_week for s in tl.steps}


def _step(tl: TemplateTimeline, step_id: str):  # type: ignore[no-untyped-def]
    return next(s for s in tl.steps if s.step_id == step_id)


def _pre_p33_walk(workflow: Workflow, weeks: Mapping[str, int]) -> tuple[dict[str, int], int]:
    """The P13-T16 walk, transcribed: start = max(end of preds) (0 first), end =
    start + weeks; total = max end."""

    ends: dict[str, int] = {}
    starts: dict[str, int] = {}
    for sid in workflow.walk_order:
        start = max((ends[p] for p in workflow.steps_by_id[sid].predecessor_ids), default=0)
        starts[sid] = start
        ends[sid] = start + weeks.get(sid, 0)
    return starts, max(ends.values(), default=0)


#: Today's served category timelines (start weeks in sequence order A..N and the
#: total), recorded from `services.workflow_previews.category_preview` on the
#: seeded table before P33.
TODAY: dict[str, tuple[tuple[int, ...], int, int, int]] = {
    "A+": ((0, 1, 9, 13, 14, 20, 26, 28, 34, 36, 37, 39, 42, 43), 44, 22, 12),
    "A": ((0, 1, 5, 9, 10, 16, 20, 22, 28, 30, 31, 33, 36, 37), 38, 18, 10),
    "B": ((0, 1, 1, 1, 2, 6, 6, 6, 12, 12, 13, 15, 16, 17), 18, 10, 6),
    "C": ((0, 1, 1, 1, 2, 4, 4, 4, 5, 5, 6, 7, 7, 7), 8, 6, 1),
    "A-OEM": ((0, 1, 2, 3, 5, 7, 9, 13, 19, 19, 20, 20, 20, 20), 21, 9, 8),
    "B-OEM": ((0, 1, 2, 3, 3, 3, 5, 7, 13, 13, 14, 14, 14, 14), 14, 5, 6),
    "C-OEM": ((0, 0, 0, 0, 0, 0, 0, 2, 4, 4, 4, 4, 4, 4), 4, 2, 2),
}


@pytest.mark.parametrize("category", CATEGORY_RANK)
def test_reproduces_todays_category_timeline_with_all_gaps_zero(category: str) -> None:
    wf = _wf(category)
    lengths = _lengths(category)
    tl = template_timeline(workflow=wf, lengths=lengths, gaps={})
    starts, total, design, lab = TODAY[category]
    assert tuple(s.start_week for s in tl.steps) == starts
    assert (tl.total_weeks, tl.design_weeks, tl.lab_weeks) == (total, design, lab)
    ref_starts, ref_total = _pre_p33_walk(wf, lengths)
    assert _starts(tl) == ref_starts and tl.total_weeks == ref_total
    for s in tl.steps:
        assert s.duration_weeks == lengths[s.step_id]
        assert s.end_week == s.start_week + s.duration_weeks
        assert (s.requested_gap_weeks, s.effective_gap_weeks, s.flags) == (0, 0, frozenset())
    # An explicit zero-gap map is the same as none.
    zero = template_timeline(workflow=wf, lengths=lengths, gaps={sid: 0 for sid in lengths})
    assert zero == tl
    assert tl.note == TEMPLATE_VIEW_NOTE
    assert tl.workflow_id == wf.workflow_id


def test_wait() -> None:
    """B, H waits 3: release(H) = 6 -> H 9-15, I/J at 15, K 16, L 18, M 19, N 20."""

    tl = template_timeline(workflow=WORKFLOWS["PDD"], lengths=_lengths("B"), gaps={"PDD-H": 3})
    h = _step(tl, "PDD-H")
    assert (h.start_week, h.end_week, h.requested_gap_weeks, h.effective_gap_weeks) == (9, 15, 3, 3)
    assert h.flags == frozenset()
    assert _starts(tl)["PDD-K"] == 16
    assert _starts(tl)["PDD-N"] == 20
    assert tl.total_weeks == 21
    assert (tl.design_weeks, tl.lab_weeks) == (10, 6)  # a wait books nothing


def test_lab_parallel_to_design() -> None:
    """B, H overlaps 4 onto E (2-6): gate = max(6 - 4, start(E) = 2, 0) = 2 ->
    H 2-8 alongside E. G(H) = 8: J 8, K 9, L 11, M 12, N 13, total 14."""

    tl = template_timeline(workflow=WORKFLOWS["PDD"], lengths=_lengths("B"), gaps={"PDD-H": -4})
    h = _step(tl, "PDD-H")
    assert (h.start_week, h.end_week, h.effective_gap_weeks, h.flags) == (2, 8, -4, frozenset())
    assert _starts(tl)["PDD-J"] == 8
    assert _starts(tl)["PDD-N"] == 13
    assert tl.total_weeks == 14


def test_anchor_clamped() -> None:
    """B, H asks for 6 weeks of overlap: 6 - 6 = 0 < start(E) = 2, so H is
    clamped to start with E (2): effective gap -4."""

    tl = template_timeline(workflow=WORKFLOWS["PDD"], lengths=_lengths("B"), gaps={"PDD-H": -6})
    h = _step(tl, "PDD-H")
    assert (h.start_week, h.requested_gap_weeks, h.effective_gap_weeks) == (2, -6, -4)
    assert h.flags == frozenset({FLAG_ANCHOR_CLAMPED})


def test_design_on_design_is_serialised_same_leader() -> None:
    """B, E overlaps 1 onto D (1-2): gate = max(2 - 1, start(D) = 1, 0) = 1, but
    the one leader is on D at week 1, so E runs back-to-back: 2-6, the baseline."""

    lengths = _lengths("B")
    tl = template_timeline(workflow=WORKFLOWS["PDD"], lengths=lengths, gaps={"PDD-E": -1})
    e = _step(tl, "PDD-E")
    assert (e.start_week, e.requested_gap_weeks, e.effective_gap_weeks) == (2, -1, 0)
    assert e.flags == frozenset({FLAG_SAME_LEADER_SERIALISED})
    base = template_timeline(workflow=WORKFLOWS["PDD"], lengths=lengths, gaps={})
    assert _starts(tl) == _starts(base) and tl.total_weeks == base.total_weeks


def test_design_overlap_onto_elapsed_is_not_serialised() -> None:
    """A, D (design 1) overlaps 2 onto C (elapsed 5-9): gate = max(9 - 2,
    start(C) = 5, 0) = 7; the leader's previous design step B ended at 5, so D
    runs 7-8 in parallel with C, unflagged."""

    tl = template_timeline(workflow=WORKFLOWS["PDD"], lengths=_lengths("A"), gaps={"PDD-D": -2})
    d = _step(tl, "PDD-D")
    assert (d.start_week, d.end_week, d.effective_gap_weeks, d.flags) == (7, 8, -2, frozenset())


def test_gap_ignored_on_a_zero_length_step() -> None:
    lengths = _lengths("B")  # F (lab) is 0 for B
    tl = template_timeline(workflow=WORKFLOWS["PDD"], lengths=lengths, gaps={"PDD-F": 2})
    f = _step(tl, "PDD-F")
    assert (f.start_week, f.end_week, f.requested_gap_weeks, f.effective_gap_weeks) == (6, 6, 2, 0)
    assert f.flags == frozenset({FLAG_GAP_IGNORED_ZERO_LENGTH})
    base = template_timeline(workflow=WORKFLOWS["PDD"], lengths=lengths, gaps={})
    assert _starts(tl) == _starts(base)


def test_parallel_design_branches_are_serialised() -> None:
    steps = (
        WorkflowStepTemplate("X", "X-A", "A", "A", "design", 1, ()),
        WorkflowStepTemplate("X", "X-B", "B", "B", "design", 2, ("X-A",)),
        WorkflowStepTemplate("X", "X-C", "C", "C", "design", 3, ("X-A",)),
        WorkflowStepTemplate("X", "X-D", "D", "D", "lab", 4, ("X-A",)),
        WorkflowStepTemplate("X", "X-E", "E", "E", "elapsed", 5, ("X-B", "X-C", "X-D")),
    )
    wf = build_workflows(steps)["X"]
    tl = template_timeline(
        workflow=wf, lengths={"X-A": 1, "X-B": 2, "X-C": 3, "X-D": 4, "X-E": 1}, gaps={}
    )
    assert _starts(tl) == {"X-A": 0, "X-B": 1, "X-C": 3, "X-D": 1, "X-E": 6}
    assert _step(tl, "X-C").flags == frozenset({FLAG_SAME_LEADER_SERIALISED})
    assert _step(tl, "X-C").effective_gap_weeks == 2
    assert _step(tl, "X-D").flags == frozenset()  # lab runs in parallel with the leader
    assert tl.total_weeks == 7


def test_flags_are_the_contract_set() -> None:
    assert set(TEMPLATE_FLAGS) == {
        "same_leader_serialised",
        "anchor_clamped",
        "gap_ignored_zero_length",
    }
    assert "engineers and chambers" in TEMPLATE_VIEW_NOTE


@pytest.mark.parametrize(
    ("lengths", "gaps", "match"),
    [
        ({}, {"PDD-A": 1}, "first step"),
        ({}, {"PDD-Z": 1}, "unknown step"),
        ({"PDD-Z": 1}, {}, "unknown step"),
        ({"PDD-E": 105}, {}, "outside 0..104"),
        ({"PDD-E": -1}, {}, "outside 0..104"),
        ({"PDD-E": True}, {}, "outside 0..104"),
        ({}, {"PDD-E": 105}, "outside -104..104"),
        ({}, {"PDD-E": -105}, "outside -104..104"),
        ({}, {"PDD-E": False}, "outside -104..104"),
    ],
)
def test_validation(lengths: dict[str, int], gaps: dict[str, int], match: str) -> None:
    with pytest.raises(ValueError, match=match):
        template_timeline(workflow=WORKFLOWS["PDD"], lengths=lengths, gaps=gaps)


def test_missing_length_counts_as_zero() -> None:
    tl = template_timeline(workflow=WORKFLOWS["PDD"], lengths={}, gaps={})
    assert tl.total_weeks == 0
    assert all(s.start_week == s.end_week == 0 for s in tl.steps)


def test_is_deterministic() -> None:
    args = dict(workflow=WORKFLOWS["PDD"], lengths=_lengths("A+"), gaps={"PDD-H": -3})
    assert repr(template_timeline(**args)) == repr(template_timeline(**args))  # type: ignore[arg-type]


# --- Agrees with the unconstrained finish of a fresh project (R33-6) -------------------------


def _fresh_project(category: str, lengths: Mapping[str, int], gaps: Mapping[str, int]):  # type: ignore[no-untyped-def]
    wf = _wf(category)
    rows = tuple(
        StepTimingInput(
            step_id=sid,
            duration_override_weeks=None,
            start_not_before_week=None,
            overlap_weeks=max(0, -gaps.get(sid, 0)),
            wait_weeks=max(0, gaps.get(sid, 0)),
            lead_weeks=lengths[sid],
        )
        for sid in sorted(lengths)
    )
    return ProjectInput(
        project_id="fresh",
        name="fresh",
        hub="OEM-HCK" if wf.workflow_id == "OEM" else "R&D-Greece",
        status="In Queue",
        category=category,
        priority="P2",
        frozen=False,
        leader_engineer_id="eng",
        workflow_id=wf.workflow_id,
        step_timing=rows,
    )


def test_agrees_with_the_unconstrained_finish_on_fresh_projects() -> None:
    rng = random.Random(3301)
    cw = 31
    checked = 0
    for category in CATEGORY_RANK:
        wf = _wf(category)
        for _ in range(40):
            lengths = {s.step_id: rng.choice((0, 0, 1, 2, 3, 5, 8)) for s in wf.steps}
            gaps = {
                s.step_id: rng.choice((-6, -3, -1, 0, 0, 0, 2, 4))
                for s in wf.steps
                if s.predecessor_ids
            }
            tl = template_timeline(workflow=wf, lengths=lengths, gaps=gaps)
            project = _fresh_project(category, lengths, gaps)
            plan = analyse_project(project, wf, TABLE, leader_fte=1.0)
            finish = unconstrained_end_week(plan, cw)
            if tl.total_weeks == 0:
                assert finish is None
                continue
            assert finish == cw + tl.total_weeks - 1, (category, lengths, gaps)
            checked += 1
    assert checked > 200
