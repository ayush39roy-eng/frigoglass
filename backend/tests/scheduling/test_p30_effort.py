"""P30-T01 — ADR 0041 (per-project effort drives schedule and load), the
scheduler side: the one skip predicate (R5), the 0..104 solver-input domain
(R4), the exact effort split (R2, R3, R7), the validator's input-derived I5,
the R3 input check, I25 / I26 over live rows, the Monte Carlo floor (R10) and
the OEM-Seitek spelling (R14).

Every expected week is hand-derived from `docs/DOMAIN_RULES.md` (CURRENT_WEEK
31) with the default strict chain and lead-time table. PDD / B:

    step:  A B C D E F G H I J K L M N
    lead:  1 0 0 1 4 0 0 6 0 1 2 1 1 1
    kind:  d d e d d l e l d d d e d e

A design figure of 4 splits (R2) to A 1, D 0, E 2, J 0, K 1, M 0 (quotas
2/5, 2/5, 8/5, 2/5, 4/5, 2/5; floors E 1; the remainder 3 goes to K (4/5),
E (3/5), then A (2/5, ties with D/J/M on fraction and t = 1, first by
sequence order)). With eff = 0 ⇒ skipped, the run at FTE 1.0 is A 31,
E 32-33, H 34-39, K 40, L 41, N 42; at FTE 0.63 (ADR 0032 span = ceil(e /
0.63)): A 31-32, E 33-36, H 37-42, K 43-44, L 45, N 46.
"""

from __future__ import annotations

import math
import random
from dataclasses import replace
from decimal import Decimal
from fractions import Fraction

import pytest

import scheduling.invariants as inv
from scheduling import (
    ChamberInput,
    EffortSplitRejected,
    EffortStepInput,
    EngineerInput,
    LiveProjectRow,
    LiveStepRow,
    ProjectInput,
    ScheduleInput,
    ScheduleOutput,
    ServedDesignLoad,
    ServedLabLoad,
    StepTimingInput,
    apportion_effort,
    canonical_hub_name,
    check_i25_demand,
    check_i26_effort_split,
    check_scheduler_determinism,
    compute_demand_load,
    compute_design_load_by_hub,
    derive_project_effort,
    effort_target_weeks,
    forecast_delivery,
    is_step_skipped,
    merged_step_override,
    round_half_up,
    run_cp_sat,
    run_greedy_sgs,
    step_effective_weeks,
    validate_invariants,
)
from scheduling._selftest_common import load_seed_schedule_input
from scheduling.effort_split import (
    NOT_APPLIED_CERTIFICATION_OFF,
    NOT_APPLIED_NO_FIGURE,
    NOT_APPLIED_NO_NONZERO_STEP,
)
from scheduling.hubs import HUB_LAB_REGION, OEM_HUBS, constants_hub_name
from scheduling.monte_carlo import _perturbed_step_timing
from scheduling.types import (
    PDD_CATEGORIES,
    default_lead_times,
    default_workflow_templates,
)
from scheduling.workflow import analyse_project, validate_step_timing
from tests.scheduling._fixtures import progress

LEAD = {(lt.workflow_id, lt.category, lt.step_id): lt.weeks for lt in default_lead_times()}
TEMPLATES = default_workflow_templates()
CATEGORIES = {"PDD": PDD_CATEGORIES, "OEM": ("A-OEM", "B-OEM", "C-OEM")}
CH_GR = ChamberInput("ch-gr", "GR", "Greece", max_concurrent=1, allowed_stages=("PDD-F", "PDD-H"))


def _eng(fte: float = 1.0) -> EngineerInput:
    return EngineerInput("eng-a", "A", "R&D-Greece", ("A+", "A", "B", "C"), fte=fte)


def _steps(
    workflow: str, category: str, started: frozenset[str] = frozenset()
) -> tuple[EffortStepInput, ...]:
    return tuple(
        EffortStepInput(
            step_id=t.step_id,
            sequence_order=t.sequence_order,
            kind=t.kind,
            lead_weeks=LEAD[(workflow, category, t.step_id)],
            started=t.step_id in started,
        )
        for t in TEMPLATES
        if t.workflow_id == workflow
    )


def _split(workflow: str, category: str, kind: str, figure: object) -> dict[str, int]:
    return apportion_effort(figure, _steps(workflow, category), kind=kind).weeks_by_step()  # type: ignore[arg-type]


def _timing(effort: tuple[tuple[str, int | None], ...]) -> tuple[StepTimingInput, ...]:
    return tuple(StepTimingInput(sid, w, None) for sid, w in effort if w is not None)


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


def _si(*projects: ProjectInput, fte: float = 1.0) -> ScheduleInput:
    return ScheduleInput(projects=projects, engineers=(_eng(fte),), chambers=(CH_GR,))


def _cp(si: ScheduleInput) -> ScheduleOutput:
    out = run_cp_sat(si)
    return out[0] if isinstance(out, tuple) else out


def _rows(out: ScheduleOutput, pid: str = "p") -> dict[str, tuple[int, int, int, bool]]:
    o = next(o for o in out.project_outcomes if o.project_id == pid)
    return {s.step_id: (s.start_week, s.end_week, s.duration_weeks, s.skipped) for s in o.steps}


def _skipped_flags(out: ScheduleOutput) -> dict[tuple[str, str], bool]:
    return {(o.project_id, s.step_id): s.skipped for o in out.project_outcomes for s in o.steps}


B_DESIGN_4 = derive_project_effort(
    design_effort_weeks=Decimal("4"),
    lab_effort_weeks=None,
    certification_testing_required=True,
    steps=_steps("PDD", "B"),
)


# =====================================================================================
# R5 — the one skip predicate
# =====================================================================================


@pytest.mark.parametrize(
    ("lead", "kind", "cert", "override", "eff"),
    [
        (4, "design", True, None, 4),  # lead time
        (4, "design", True, 7, 7),  # merged override wins
        (4, "design", True, 0, 0),  # ADR 0041: an override of 0 zeroes the step
        (0, "design", True, 5, 0),  # lead 0 stays skipped: an override never revives it
        (6, "lab", False, 10, 0),  # cert off: lab skipped whatever the override (R7)
        (6, "lab", True, None, 6),
        (6, "lab", True, 0, 0),
        (2, "elapsed", False, None, 2),  # cert gates lab only
        (2, "elapsed", True, 0, 0),
    ],
)
def test_skip_predicate_truth_table(
    lead: int, kind: str, cert: bool, override: int | None, eff: int
) -> None:
    kw = dict(
        lead_weeks=lead, kind=kind, certification_testing_required=cert, override_weeks=override
    )
    assert step_effective_weeks(**kw) == eff  # type: ignore[arg-type]
    assert is_step_skipped(**kw) is (eff == 0)  # type: ignore[arg-type]


def test_merged_override_precedence_is_user_then_effort() -> None:
    assert merged_step_override(3, 0) == 3  # a user override keeps a zeroed step (R4)
    assert merged_step_override(None, 0) == 0
    assert merged_step_override(None, 2) == 2
    assert merged_step_override(None, None) is None


def test_step_timing_domain_is_0_to_104() -> None:
    from scheduling.workflow import build_workflows

    wf = build_workflows(TEMPLATES)["PDD"]
    for ok in (0, 1, 104):
        validate_step_timing(
            _project(step_timing=(StepTimingInput("PDD-E", ok, None),)), wf, horizon_weeks=78
        )
    for bad in (-1, 105):
        with pytest.raises(ValueError, match=r"outside 0\.\.104"):
            validate_step_timing(
                _project(step_timing=(StepTimingInput("PDD-E", bad, None),)), wf, horizon_weeks=78
            )


# =====================================================================================
# R2 / R3 / R7 — the exact effort split
# =====================================================================================


def test_b_example_is_a1_e2_k1() -> None:
    assert _split("PDD", "B", "design", 4) == {
        "PDD-A": 1,
        "PDD-D": 0,
        "PDD-E": 2,
        "PDD-J": 0,
        "PDD-K": 1,
        "PDD-M": 0,
    }
    # The effort column: lead-0 and other-kind steps carry nothing.
    assert B_DESIGN_4.effort_weeks == (
        ("PDD-A", 1),
        ("PDD-B", None),
        ("PDD-C", None),
        ("PDD-D", 0),
        ("PDD-E", 2),
        ("PDD-F", None),
        ("PDD-G", None),
        ("PDD-H", None),
        ("PDD-I", None),
        ("PDD-J", 0),
        ("PDD-K", 1),
        ("PDD-L", None),
        ("PDD-M", 0),
        ("PDD-N", None),
    )
    assert B_DESIGN_4.design.target_weeks == 4 and B_DESIGN_4.design.total_weeks == 4
    assert not B_DESIGN_4.lab.applied and B_DESIGN_4.lab.not_applied_reason == NOT_APPLIED_NO_FIGURE


@pytest.mark.parametrize(
    ("workflow", "category", "kind", "figure", "expected"),
    [
        ("PDD", "C", "design", 3, {"PDD-A": 1, "PDD-D": 1, "PDD-E": 1, "PDD-J": 0, "PDD-K": 0}),
        ("PDD", "B", "lab", 10, {"PDD-H": 10}),
        ("PDD", "A+", "lab", 4, {"PDD-F": 2, "PDD-H": 2}),
        ("PDD", "B", "lab", 70, {"PDD-H": 70}),
        ("PDD", "B", "lab", Decimal("1.5"), {"PDD-H": 2}),  # 1.5 rounds half up to 2
        ("PDD", "B", "lab", Decimal("2.5"), {"PDD-H": 3}),  # never half-to-even
        ("PDD", "B", "lab", Decimal("0.40"), {"PDD-H": 1}),  # E = max(1, 0)
        ("PDD", "B", "lab", "104", {"PDD-H": 104}),  # the maximum is accepted
        ("PDD", "A+", "lab", 1, {"PDD-F": 1, "PDD-H": 0}),  # tie 1/2 vs 1/2, t 6 = 6 -> seq F
    ],
)
def test_adr_worked_examples(
    workflow: str, category: str, kind: str, figure: object, expected: dict[str, int]
) -> None:
    assert _split(workflow, category, kind, figure) == expected


def test_round_half_up_and_target_on_the_stored_decimal() -> None:
    assert [round_half_up(x) for x in ("0.5", "1.5", "2.5", "2.49", Decimal("3.50"))] == [
        1,
        2,
        3,
        2,
        4,
    ]
    assert round_half_up(2.675) == 3  # a float is read through its decimal repr
    assert effort_target_weeks(None) is None
    assert effort_target_weeks(Decimal("0.00")) is None  # a typed 0 is a blank
    assert effort_target_weeks(Decimal("0.01")) == 1
    with pytest.raises(ValueError, match="negative"):
        effort_target_weeks(Decimal("-1"))
    with pytest.raises(ValueError, match="not a number"):
        effort_target_weeks("abc")
    with pytest.raises(ValueError, match="not finite"):
        effort_target_weeks("NaN")


def _reference_split(steps: list[tuple[str, int, int]], e: int) -> dict[str, int]:
    """An independent exact implementation (R2): Fraction quotas, remainder
    ranked by (fraction desc, t desc, sequence asc, step_id asc)."""

    members = [(sid, seq, t) for sid, seq, t in steps if t > 0]
    total = sum(t for _, _, t in members)
    q = {sid: Fraction(e * t, total) for sid, _, t in members}
    base = {sid: q[sid].numerator // q[sid].denominator for sid in q}
    order = sorted(members, key=lambda r: (base[r[0]] - q[r[0]], -r[2], r[1], r[0]))
    for sid, _, _ in order[: e - sum(base.values())]:
        base[sid] += 1
    return base


def _float_split(steps: list[tuple[str, int, int]], e: int) -> dict[str, int]:
    """The naive binary-float version the ruling warns against."""

    members = [(sid, seq, t) for sid, seq, t in steps if t > 0]
    total = sum(t for _, _, t in members)
    q = {sid: e * t / total for sid, _, t in members}
    base = {sid: math.floor(q[sid]) for sid in q}
    order = sorted(members, key=lambda r: (-(q[r[0]] - base[r[0]]), -r[2], r[1]))
    for sid, _, _ in order[: e - sum(base.values())]:
        base[sid] += 1
    return base


def test_split_matches_exact_arithmetic_everywhere_and_float_disagrees_52_times() -> None:
    """The ruling's 52 float-vs-exact disagreements over E = 1..300 (they are
    18 in PDD/A design and 34 in OEM/A-OEM design; every other cell agrees).
    The implementation must equal exact arithmetic in every one of them."""

    disagreements: dict[tuple[str, str, str], list[int]] = {}
    for workflow, cats in CATEGORIES.items():
        for category in cats:
            for kind in ("design", "lab"):
                raw = [
                    (t.step_id, t.sequence_order, LEAD[(workflow, category, t.step_id)])
                    for t in TEMPLATES
                    if t.workflow_id == workflow and t.kind == kind
                ]
                if not any(t for _, _, t in raw):
                    continue
                for e in range(1, 301):
                    exact = _reference_split(raw, e)
                    if max(exact.values()) > 104:
                        # R7: a step above 104 weeks is rejected, never clamped.
                        with pytest.raises(EffortSplitRejected):
                            _split(workflow, category, kind, e)
                    else:
                        got = _split(workflow, category, kind, e)
                        assert got == exact, (workflow, category, kind, e)
                        assert sum(got.values()) == e
                    if _float_split(raw, e) != exact:
                        disagreements.setdefault((workflow, category, kind), []).append(e)
    assert sum(len(v) for v in disagreements.values()) == 52
    assert {k: len(v) for k, v in disagreements.items()} == {
        ("PDD", "A", "design"): 18,
        ("OEM", "A-OEM", "design"): 34,
    }
    assert disagreements[("PDD", "A", "design")][:4] == [6, 12, 24, 48]


def test_remainder_tie_order_fraction_then_lead_then_sequence_then_step_id() -> None:
    def s(sid: str, seq: int, t: int) -> EffortStepInput:
        return EffortStepInput(sid, seq, "design", t)

    # Larger fractional part first: quotas 3·(1/6)=0.5, 3·(2/6)=1, 3·(3/6)=1.5.
    assert apportion_effort(3, [s("X", 1, 1), s("Y", 2, 2), s("Z", 3, 3)]).weeks_by_step() == {
        "X": 0,
        "Y": 1,
        "Z": 2,
    }
    # Equal fraction (1/2 each): the larger t wins over an earlier sequence.
    assert apportion_effort(1, [s("X", 1, 1), s("Y", 2, 3)]).weeks_by_step() == {
        "X": 0,
        "Y": 1,
    }
    # Equal fraction and t: the smaller sequence_order.
    assert apportion_effort(1, [s("Y", 1, 2), s("X", 2, 2)]).weeks_by_step() == {"Y": 1, "X": 0}
    # Equal fraction, t and sequence_order: the smaller step_id.
    assert apportion_effort(1, [s("Y", 1, 2), s("X", 1, 2)]).weeks_by_step() == {"X": 1, "Y": 0}


def test_split_is_independent_of_input_order() -> None:
    steps = list(_steps("PDD", "A"))
    want = apportion_effort(Decimal("7.5"), steps)
    rng = random.Random(41)
    for _ in range(20):
        rng.shuffle(steps)
        assert apportion_effort(Decimal("7.5"), steps) == want


def test_r3_started_steps_are_raised_to_one() -> None:
    split = apportion_effort(4, _steps("PDD", "B", started=frozenset({"PDD-D", "PDD-E"})))
    # D (Done / In Progress) would get 0; it is raised to 1. E already has 2.
    assert split.weeks_by_step() == {
        "PDD-A": 1,
        "PDD-D": 1,
        "PDD-E": 2,
        "PDD-J": 0,
        "PDD-K": 1,
        "PDD-M": 0,
    }
    assert split.raised_step_ids == ("PDD-D",)
    assert split.target_weeks == 4
    assert split.total_weeks == split.target_weeks + len(split.raised_step_ids) == 5


def test_r7_edge_cases() -> None:
    zero_table = [EffortStepInput("X", 1, "design", 0), EffortStepInput("Y", 2, "design", 0)]
    t0 = apportion_effort(5, zero_table)
    assert not t0.applied and t0.not_applied_reason == NOT_APPLIED_NO_NONZERO_STEP
    assert t0.step_weeks == () and t0.target_weeks == 5

    cert_off = apportion_effort(
        10, _steps("PDD", "B"), kind="lab", certification_testing_required=False
    )
    assert not cert_off.applied and cert_off.not_applied_reason == NOT_APPLIED_CERTIFICATION_OFF

    for blank in (None, 0, Decimal("0.00")):
        assert (
            apportion_effort(blank, _steps("PDD", "B")).not_applied_reason == NOT_APPLIED_NO_FIGURE
        )

    with pytest.raises(EffortSplitRejected) as exc:
        apportion_effort(Decimal("104.5"), _steps("PDD", "B"), kind="lab")  # E = 105 on H
    assert exc.value.step_id == "PDD-H" and exc.value.weeks == 105
    assert isinstance(exc.value, ValueError)

    with pytest.raises(ValueError, match="kind"):
        apportion_effort(4, _steps("PDD", "B"), kind="elapsed")
    with pytest.raises(ValueError, match="more than once"):
        apportion_effort(4, [*_steps("PDD", "B"), EffortStepInput("PDD-A", 1, "design", 1)])
    with pytest.raises(ValueError, match="negative lead"):
        apportion_effort(4, [EffortStepInput("X", 1, "design", -1)])


def test_derive_project_effort_with_cert_off_leaves_lab_steps_without_effort() -> None:
    d = derive_project_effort(
        design_effort_weeks=3,
        lab_effort_weeks=10,
        certification_testing_required=False,
        steps=_steps("PDD", "C"),
    )
    col = d.effort_weeks_by_step()
    assert {k: v for k, v in col.items() if v is not None} == {
        "PDD-A": 1,
        "PDD-D": 1,
        "PDD-E": 1,
        "PDD-J": 0,
        "PDD-K": 0,
    }
    assert col["PDD-H"] is None and d.lab.not_applied_reason == NOT_APPLIED_CERTIFICATION_OFF


# =====================================================================================
# The solver on 0-effective steps (R5 + domain 0..104), greedy and CP-SAT
# =====================================================================================

EXPECTED_B4 = {
    1.0: {
        "PDD-A": (31, 31, 1, False),
        "PDD-D": (31, 31, 0, True),
        "PDD-E": (32, 33, 2, False),
        "PDD-H": (34, 39, 6, False),
        "PDD-J": (39, 39, 0, True),
        "PDD-K": (40, 40, 1, False),
        "PDD-L": (41, 41, 1, False),
        "PDD-M": (41, 41, 0, True),
        "PDD-N": (42, 42, 1, False),
    },
    0.63: {
        "PDD-A": (31, 32, 1, False),
        "PDD-D": (32, 32, 0, True),
        "PDD-E": (33, 36, 2, False),
        "PDD-H": (37, 42, 6, False),
        "PDD-J": (42, 42, 0, True),
        "PDD-K": (43, 44, 1, False),
        "PDD-L": (45, 45, 1, False),
        "PDD-M": (45, 45, 0, True),
        "PDD-N": (46, 46, 1, False),
    },
}


@pytest.mark.parametrize("fte", [1.0, 0.63])
@pytest.mark.parametrize("solver", ["greedy", "cp_sat"])
def test_zero_effective_steps_are_skipped_and_invariants_hold(fte: float, solver: str) -> None:
    si = _si(_project(step_timing=_timing(B_DESIGN_4.effort_weeks)), fte=fte)
    out = run_greedy_sgs(si) if solver == "greedy" else _cp(si)
    rows = _rows(out)
    for sid, want in EXPECTED_B4[fte].items():
        assert rows[sid] == want, sid
    assert len(rows) == 14
    assert validate_invariants(si, out) == ()
    # Load (I6) is the effort, 4 weeks, never the span.
    assert compute_design_load_by_hub(si, out) == {"R&D-Greece": 4}


def _apportioned_seed(fte: float | None) -> ScheduleInput:
    """The 46-project prototype seed with every non-frozen project's design
    and lab figure apportioned (design ≈ 40 % of its table, lab ≈ 60 %), so
    many steps are zeroed (the auditor's probe shape)."""

    si = load_seed_schedule_input()
    projects = []
    for p in si.projects:
        if p.frozen or p.category is None:
            projects.append(p)
            continue
        steps = _steps(p.workflow_id, p.category)
        design_t = sum(s.lead_weeks for s in steps if s.kind == "design")
        lab_t = sum(s.lead_weeks for s in steps if s.kind == "lab")
        d = derive_project_effort(
            design_effort_weeks=Decimal(design_t) * Decimal("0.4"),
            lab_effort_weeks=Decimal(lab_t) * Decimal("0.6"),
            certification_testing_required=p.certification_testing_required,
            steps=steps,
        )
        projects.append(replace(p, step_timing=_timing(d.effort_weeks)))
    engineers = si.engineers if fte is None else tuple(replace(e, fte=fte) for e in si.engineers)
    return replace(si, projects=tuple(projects), engineers=engineers)


@pytest.mark.parametrize("fte", [1.0, 0.63])
def test_seed_with_every_figure_apportioned_is_clean_on_both_solvers(fte: float) -> None:
    si = _apportioned_seed(fte)
    zeroed = sum(1 for p in si.projects for r in p.step_timing if r.duration_override_weeks == 0)
    assert zeroed > 50
    greedy = run_greedy_sgs(si)
    cp = _cp(si)
    assert validate_invariants(si, greedy) == ()
    assert validate_invariants(si, cp, check_determinism=False) == ()
    assert check_scheduler_determinism(si) == ()
    assert repr(run_greedy_sgs(si)) == repr(greedy)
    # Greedy and CP-SAT agree on every skipped flag they both emit.
    g, c = _skipped_flags(greedy), _skipped_flags(cp)
    common = sorted(set(g) & set(c))
    assert len(common) > 300
    assert all(g[k] == c[k] for k in common)
    # Every zeroed step that is emitted is skipped.
    for p in si.projects:
        for r in p.step_timing:
            if r.duration_override_weeks == 0 and (p.project_id, r.step_id) in g:
                assert g[(p.project_id, r.step_id)] is True


def test_cp_sat_is_deterministic_on_zeroed_input() -> None:
    si = _apportioned_seed(None)
    assert repr(_cp(si)) == repr(_cp(si))


# =====================================================================================
# Validator — I5 derives "skipped" from the inputs; R3 at the input
# =====================================================================================


def test_i5_reads_the_inputs_not_analyse_project(monkeypatch: pytest.MonkeyPatch) -> None:
    si = _si(_project(step_timing=_timing(B_DESIGN_4.effort_weeks)))
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out, check_determinism=False) == ()

    # A pre-ADR-0041 output: PDD-D (merged duration 0) emitted as a
    # non-skipped 0-week row (`end = start - 1`, the degenerate shape the
    # ruling measured).
    bad = replace(
        out,
        project_outcomes=tuple(
            replace(
                o,
                steps=tuple(
                    replace(s, skipped=False, start_week=32, end_week=31)
                    if s.step_id == "PDD-D"
                    else s
                    for s in o.steps
                ),
            )
            for o in out.project_outcomes
        ),
    )
    i5 = [v for v in validate_invariants(si, bad, check_determinism=False) if v.invariant == "I5"]
    assert {v.step_id for v in i5} == {"PDD-D"}
    assert any("inputs" in v.description for v in i5)
    assert any("must be skipped" in v.description for v in i5)

    # Even if `analyse_project` regressed to the old predicate, I5 still fires.
    real = analyse_project

    def old_predicate(project, workflow, table, **kw):  # type: ignore[no-untyped-def]
        stripped = replace(
            project,
            step_timing=tuple(r for r in project.step_timing if r.duration_override_weeks != 0),
        )
        return real(stripped, workflow, table, **kw)

    monkeypatch.setattr(inv, "analyse_project", old_predicate)
    i5 = [v for v in validate_invariants(si, bad, check_determinism=False) if v.invariant == "I5"]
    assert {v.step_id for v in i5} == {"PDD-D"}


def test_r3_recorded_work_on_a_split_step_never_vanishes() -> None:
    """The R3 path: D is Done (actuals W29) when the figure 4 is applied. The
    split raises D to 1, so the run keeps D at its recorded weeks (I11) and
    every invariant holds."""

    done_d = (
        progress("PDD-A", "Done", percent_complete=100, actual_start_week=28, actual_end_week=28),
        progress("PDD-D", "Done", percent_complete=100, actual_start_week=29, actual_end_week=29),
    )
    started = frozenset(pr.step_id for pr in done_d)
    d = derive_project_effort(
        design_effort_weeks=4,
        lab_effort_weeks=None,
        certification_testing_required=True,
        steps=_steps("PDD", "B", started=started),
    )
    assert d.design.raised_step_ids == ("PDD-D",)
    assert d.effort_weeks_by_step()["PDD-D"] == 1
    for fte in (1.0, 0.63):
        si = _si(_project(step_progress=done_d, step_timing=_timing(d.effort_weeks)), fte=fte)
        for out in (run_greedy_sgs(si), _cp(si)):
            rows = _rows(out)
            assert rows["PDD-A"] == (28, 28, 1, False)
            assert rows["PDD-D"] == (29, 29, 1, False)
            assert validate_invariants(si, out, check_determinism=False) == ()


def test_zeroing_a_started_step_is_reported_not_silent() -> None:
    """Bypassing R3 (a 0 merged duration on a Done step) is flagged I26 by
    the validator; before ADR 0041 nothing fired (I11 exempts skipped steps)."""

    done_d = (
        progress("PDD-D", "Done", percent_complete=100, actual_start_week=29, actual_end_week=29),
    )
    in_progress_j = (progress("PDD-J", "In Progress", percent_complete=50, actual_start_week=30),)
    si = _si(
        _project(step_progress=done_d + in_progress_j, step_timing=_timing(B_DESIGN_4.effort_weeks))
    )
    out = run_greedy_sgs(si)
    rows = _rows(out)
    assert rows["PDD-D"][3] is True and rows["PDD-J"][3] is True  # the predicate skips them
    v = validate_invariants(si, out, check_determinism=False)
    assert [(x.invariant, x.step_id) for x in v] == [("I26", "PDD-D"), ("I26", "PDD-J")]
    # Frozen projects and lead-0 / cert-off steps are not reported.
    frozen = _project(
        frozen=True,
        actual_start_week=31,
        step_progress=done_d,
        step_timing=_timing(B_DESIGN_4.effort_weeks),
    )
    si2 = _si(frozen)
    assert [x for x in validate_invariants(si2, run_greedy_sgs(si2)) if x.invariant == "I26"] == []
    cert_off = _project(
        certification_testing_required=False,
        step_progress=(
            progress("PDD-H", "In Progress", percent_complete=10, actual_start_week=30),
        ),
        step_timing=(StepTimingInput("PDD-H", 0, None),),
    )
    si3 = _si(cert_off)
    assert [x for x in validate_invariants(si3, run_greedy_sgs(si3)) if x.invariant == "I26"] == []


# =====================================================================================
# R10 — Monte Carlo
# =====================================================================================


def test_monte_carlo_keeps_zero_at_zero_and_floors_nonzero_at_one() -> None:
    rows = (
        StepTimingInput("PDD-D", 0, None),
        StepTimingInput("PDD-E", 1, None),
        StepTimingInput("PDD-K", 100, None),
        StepTimingInput("PDD-L", None, 40),
    )
    for factor in (0.3, 0.85, 1.0, 1.3):
        got = {r.step_id: r.duration_override_weeks for r in _perturbed_step_timing(rows, factor)}
        assert got["PDD-D"] == 0
        assert got["PDD-E"] == max(1, round(factor))
        assert got["PDD-K"] == min(104, max(1, round(100 * factor)))
        assert got["PDD-L"] is None


def test_monte_carlo_never_revives_a_zeroed_step() -> None:
    si = _si(_project(step_timing=_timing(B_DESIGN_4.effort_weeks)))
    fc = forecast_delivery(si, iterations=40, seed=7)
    again = forecast_delivery(si, iterations=40, seed=7)
    assert fc == again
    (pf,) = fc.project_forecasts
    assert pf.iterations_scheduled == 40
    # Zeroed D / J / M never come back: the critical path is A + E + H + K + L
    # + N = 1 + 2 + 6 + 1 + 1 + 1 at factor 1 (W42); the factor's range keeps it
    # far below the 10-week-design baseline's W48 lower bound.
    assert pf.min_completion_week is not None and pf.min_completion_week <= 42


# =====================================================================================
# I25 — demand load over live rows
# =====================================================================================


def _live_steps(
    workflow: str,
    category: str,
    effort: dict[str, int | None] | None = None,
    user: dict[str, int] | None = None,
    progress_rows: dict[str, tuple[str, int, int | None]] | None = None,
) -> tuple[LiveStepRow, ...]:
    effort = effort or {}
    user = user or {}
    progress_rows = progress_rows or {}
    out = []
    for t in TEMPLATES:
        if t.workflow_id != workflow:
            continue
        status, pct, rem = progress_rows.get(t.step_id, ("Not Started", 0, None))
        out.append(
            LiveStepRow(
                step_id=t.step_id,
                sequence_order=t.sequence_order,
                kind=t.kind,
                lead_weeks=LEAD[(workflow, category, t.step_id)],
                user_override_weeks=user.get(t.step_id),
                effort_weeks=effort.get(t.step_id),
                status=status,
                percent_complete=pct,
                remaining_weeks_override=rem,
            )
        )
    return tuple(out)


def _live(
    pid: str,
    *,
    hub: str = "R&D-Greece",
    capacity_hub: str | None = None,
    status: str = "In Queue",
    category: str = "B",
    frozen: bool = False,
    cert: bool = True,
    design: object = None,
    lab: object = None,
    steps: tuple[LiveStepRow, ...] | None = None,
) -> LiveProjectRow:
    workflow = "OEM" if hub in OEM_HUBS else "PDD"
    return LiveProjectRow(
        project_id=pid,
        hub=hub,
        capacity_hub=capacity_hub or hub,
        status=status,
        frozen=frozen,
        certification_testing_required=cert,
        design_effort_weeks=design,  # type: ignore[arg-type]
        lab_effort_weeks=lab,  # type: ignore[arg-type]
        steps=steps if steps is not None else _live_steps(workflow, category),
    )


B4_EFFORT = {k: v for k, v in B_DESIGN_4.effort_weeks}


def _demand_fixture() -> list[LiveProjectRow]:
    return [
        # B, figure 4 -> design 4; lab H 6 (table). E In Progress 50 %: rem 1.
        _live(
            "g-1",
            status="In Development",
            design=4,
            steps=_live_steps(
                "PDD", "B", effort=B4_EFFORT, progress_rows={"PDD-E": ("In Progress", 50, None)}
            ),
        ),
        # B, table: design 10, lab 6; a stale user override on lead-0 PDD-B is
        # never revived (R5); K has a user override 5 (design 13); A Done.
        _live(
            "g-2",
            steps=_live_steps(
                "PDD",
                "B",
                user={"PDD-B": 9, "PDD-K": 5},
                progress_rows={"PDD-A": ("Done", 100, None)},
            ),
        ),
        # Cert off: lab 0. Commercialized: full year only.
        _live("g-3", status="Commercialized", cert=False),
        # Excluded from both: Cancelled and Draft.
        _live("g-4", status="Cancelled"),
        _live("g-5", status="Draft"),
        # OEM-Seitek (new spelling) under Greece: B-OEM design 1+1+2+1 = 5, lab H 6.
        _live("o-1", hub="OEM-Seitek", capacity_hub="R&D-Greece", category="B-OEM"),
        # PD-India On Hold: full year only, In Progress remaining override ignored.
        _live(
            "i-1",
            hub="PD-India",
            status="On Hold",
            category="C",
            steps=_live_steps("PDD", "C", progress_rows={"PDD-E": ("Blocked", 0, 1)}),
        ),
    ]


def test_i25_demand_figures_by_hand() -> None:
    d = compute_demand_load(_demand_fixture())
    # Greece: g-1 4 + g-2 13 + g-3 10 + o-1 5 = 32; remaining g-1 (1 + 1 rem E + 1) = 3,
    # g-2 13 - A 1 = 12, o-1 5 -> 20.
    assert d.design_full_year == {"PD-India": 6, "R&D-Greece": 32}
    assert d.design_remaining == {"R&D-Greece": 20}
    # Lab Greece: g-1 6 + g-2 6 + g-3 0 (cert off) + o-1 6 (B-OEM: E 0, H 6) = 18;
    # remaining the same (g-3 is not open). India: C lab H 1.
    assert d.lab_full_year == {"Greece": 18.0, "India": 1.0}
    assert d.lab_remaining == {"Greece": 18.0}


def test_i25_check_matches_served_and_catches_drift() -> None:
    rows = _demand_fixture()
    design = [
        ServedDesignLoad("R&D-Greece", 32, Decimal("20")),
        ServedDesignLoad("PD-India", 6, 0),
        ServedDesignLoad("PD-Romania", 0, 0),
    ]
    lab = [
        ServedLabLoad("Greece", Decimal("18.00"), 18.004),
        ServedLabLoad("India", 1.0, 0),
    ]
    assert check_i25_demand(rows, design, lab) == ()
    drift = check_i25_demand(
        rows,
        [ServedDesignLoad("R&D-Greece", 42, 20), ServedDesignLoad("PD-Romania", 1, 0)],
        [ServedLabLoad("Greece", 18.01, 18)],
    )
    assert [(v.invariant, v.hub) for v in drift if v.hub] == [
        ("I25", "PD-India"),  # not served, but 6 weeks of demand
        ("I25", "PD-Romania"),  # served 1, no demand
        ("I25", "R&D-Greece"),  # 42 vs 32 (the bare-coalesce revival would read 41)
    ]
    assert sum(1 for v in drift if "lab region 'Greece'" in v.description) == 1
    assert sum(1 for v in drift if "lab region 'India'" in v.description) == 1


def test_i25_rejects_unknown_status_and_hub() -> None:
    with pytest.raises(ValueError, match="unknown status"):
        compute_demand_load(
            [
                _live(
                    "x", steps=_live_steps("PDD", "B", progress_rows={"PDD-A": ("Paused", 0, None)})
                )
            ]
        )
    with pytest.raises(ValueError, match="unknown hub"):
        compute_demand_load([_live("x", hub="Atlantis")])


# =====================================================================================
# I26 — effort split over live rows
# =====================================================================================


def test_i26_holds_on_a_correct_split_and_flags_every_drift() -> None:
    good = _live("g", design=Decimal("4.00"), steps=_live_steps("PDD", "B", effort=B4_EFFORT))
    assert check_i26_effort_split([good]) == ()

    # A float-style split (A1 D1 E1 K1, the draft's wrong example) is caught.
    wrong = dict(B4_EFFORT, **{"PDD-D": 1, "PDD-E": 1})
    bad = _live("b", design=4, steps=_live_steps("PDD", "B", effort=wrong))
    assert [(v.invariant, v.step_id) for v in check_i26_effort_split([bad])] == [
        ("I26", "PDD-D"),
        ("I26", "PDD-E"),
    ]

    # R3: a Done step with derived 0 must read 1.
    started = _live(
        "r3",
        design=4,
        steps=_live_steps(
            "PDD", "B", effort=B4_EFFORT, progress_rows={"PDD-J": ("Done", 100, None)}
        ),
    )
    assert [v.step_id for v in check_i26_effort_split([started])] == ["PDD-J"]

    # A blank figure must leave no derived effort (table fallback).
    stale = _live("s", design=None, steps=_live_steps("PDD", "B", effort=B4_EFFORT))
    assert len(check_i26_effort_split([stale])) == 6

    # Frozen: exempt (R6 no-op).
    assert check_i26_effort_split([replace(stale, frozen=True)]) == ()

    # Lab with cert off: not checked.
    lab_off = _live("l", cert=False, lab=10, steps=_live_steps("PDD", "B", effort={"PDD-H": 99}))
    assert check_i26_effort_split([lab_off]) == ()
    lab_on = replace(lab_off, certification_testing_required=True)
    assert [v.step_id for v in check_i26_effort_split([lab_on])] == ["PDD-H"]

    # R7: a stored figure that would put a step above 104 weeks.
    too_big = _live("t", lab=200, steps=_live_steps("PDD", "B"))
    (v,) = check_i26_effort_split([too_big])
    assert v.invariant == "I26" and v.step_id == "PDD-H" and "rejected at write" in v.description


# =====================================================================================
# R14 — OEM-Seitek spelling
# =====================================================================================


def test_both_hub_spellings_are_accepted_and_schedule_identically() -> None:
    assert canonical_hub_name("OEM-Seltek") == "OEM-Seitek"
    assert canonical_hub_name("PD-India") == "PD-India"
    assert HUB_LAB_REGION["OEM-Seltek"] == HUB_LAB_REGION["OEM-Seitek"] == "Greece"
    assert {"OEM-Seltek", "OEM-Seitek", "OEM-HCK"} <= OEM_HUBS
    assert constants_hub_name("OEM-Seitek") in ("OEM-Seltek", "OEM-Seitek")
    assert constants_hub_name("OEM-Seltek") == constants_hub_name("OEM-Seitek")

    ch = ChamberInput("ch-gr", "GR", "Greece", 1, ("OEM-E", "OEM-H"))
    eng = EngineerInput("eng-a", "A", "R&D-Greece", ("B-OEM",))
    outs = []
    for spelling in ("OEM-Seltek", "OEM-Seitek"):
        p = _project(hub=spelling, category="B-OEM", workflow_id="OEM", capacity_hub="R&D-Greece")
        si = ScheduleInput(projects=(p,), engineers=(eng,), chambers=(ch,))
        g, c = run_greedy_sgs(si), _cp(si)
        assert validate_invariants(si, g) == ()
        assert validate_invariants(si, c, check_determinism=False) == ()
        assert not g.project_outcomes[0].cat_not_allowed
        outs.append((repr(g), repr(c)))
    assert outs[0] == outs[1]

    with pytest.raises(ValueError, match="hub"):
        run_greedy_sgs(_si(_project(hub="OEM-Seltec")))


def test_scheduler_fixtures_use_the_new_spelling() -> None:
    si = load_seed_schedule_input()
    hubs_used = {p.hub for p in si.projects}
    assert "OEM-Seitek" in hubs_used and "OEM-Seltek" not in hubs_used
