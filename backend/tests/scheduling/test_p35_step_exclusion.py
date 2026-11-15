"""P35-T04 — per-project step exclusion on the scheduler side (ADR 0049 as
ruled by the workflow-auditor, MEMORY "[2026-11-13] P35-T03": R35-1, R35-3,
R35-5, R35-8, R35-9; I26 rev. 2, I33, I34 (i), I35).

- R35-3: `EffortStepInput.excluded` takes the step out of S′, the set the R2
  split and the R3 raise run over. An excluded step gets no share, is never
  raised and carries `effort_weeks = None`.
- R35-9: there is no scheduler field. The builder sends an excluded step as
  `lead_weeks = 0` (None when the table is already 0) with no override, and
  every solver path already skips a step whose lead is 0. These tests pin
  that for greedy, CP-SAT, Monte Carlo, the validator, the unconstrained
  finish and frozen projects, and that a gap on the step is ignored (R35-8).

Every week below is hand-derived with CURRENT_WEEK = 31 and the default
table. The base project is PDD / B (as in the P12, P32 and P33 suites):

    step:  A B C D E F G H I J K L M N
    lead:  1 0 0 1 4 0 0 6 0 1 2 1 1 1
    kind:  d d e d d l e l d d d e d e

Baseline: A 31, D 32, E 33-36, H 37-42, J 43, K 44-45, L 46, M 47, N 48.
"""

from __future__ import annotations

import dataclasses
from decimal import Decimal

import pytest

from scheduling import (
    EffortSplit,
    EffortStepInput,
    LiveProjectRow,
    LiveStepRow,
    ProjectScheduleOutcome,
    ScheduleInput,
    StepTimingInput,
    apportion_effort,
    check_i26_effort_split,
    check_i33_step_exclusion,
    check_i34_excluded_not_done,
    compute_demand_load,
    derive_project_effort,
    forecast_delivery,
    run_greedy_sgs,
    validate_invariants,
)
from scheduling.effort_split import (
    NOT_APPLIED_ALL_EXCLUDED,
    NOT_APPLIED_CERTIFICATION_OFF,
    NOT_APPLIED_NO_NONZERO_STEP,
)
from scheduling.monte_carlo import _perturbed_project
from scheduling.types import default_lead_times, default_workflow_templates
from tests.scheduling._fixtures import progress
from tests.scheduling.test_p33_gaps import BASELINE, _cp, _project, _run, _si, _skipped, _t, _weeks

TEMPLATES = {t.step_id: t for t in default_workflow_templates()}
LEAD = {(lt.workflow_id, lt.category, lt.step_id): lt.weeks for lt in default_lead_times()}
PDD = sorted((sid for sid, t in TEMPLATES.items() if t.workflow_id == "PDD"), key=lambda s: s)


def _x(step_id: str, **kw: object) -> StepTimingInput:
    """An excluded step as the R35-9 builder sends it: lead 0, no override."""

    return _t(step_id, lead=0, **kw)  # type: ignore[arg-type]


# --- R35-3: the effort split over S′ ---------------------------------------------------


def _effort_steps(
    category: str = "B",
    *,
    excluded: str = "",
    started: str = "",
    workflow: str = "PDD",
) -> list[EffortStepInput]:
    return [
        EffortStepInput(
            step_id=sid,
            sequence_order=t.sequence_order,
            kind=t.kind,
            lead_weeks=LEAD[(workflow, category, sid)],
            started=sid[-1] in started,
            excluded=sid[-1] in excluded,
        )
        for sid, t in sorted(TEMPLATES.items())
        if t.workflow_id == workflow
    ]


def _split(figure: object, **kw: str) -> str:
    """The design split as `A1 D0 E2 …` (S′ only, sequence order)."""

    r = apportion_effort(figure, _effort_steps(**kw), kind="design")  # type: ignore[arg-type]
    return " ".join(f"{sid[-1]}{w}" for sid, w in r.step_weeks)


def test_probe_no_exclusion_is_unchanged() -> None:
    """DOMAIN_RULES R2 example: PDD/B design 4 → A 1, E 2, K 1 (D, J, M 0)."""

    assert _split(4) == "A1 D0 E2 J0 K1 M0"


def test_probe_exclude_a_moves_its_share_and_revives_d() -> None:
    """Auditor's probe row 2. S′ = D1 E4 J1 K2 M1, T = 9, E = 4: quotas
    D 4/9, E 16/9, J 4/9, K 8/9, M 4/9; floors E 1; remainder 3 → K (.889),
    E (.778), then D (.444, tie on fraction and lead, smaller sequence)."""

    r = apportion_effort(4, _effort_steps(excluded="A"), kind="design")
    assert _split(4, excluded="A") == "D1 E2 J0 K1 M0"
    assert r.total_weeks == 4
    assert "PDD-A" not in r.weeks_by_step()


def test_probe_exclude_a_and_d_revives_j() -> None:
    """Probe row 3. S′ = E4 J1 K2 M1, T = 8: quotas E 2, J 0.5, K 1, M 0.5;
    remainder 1 → J (tie with M on fraction and lead, J earlier)."""

    assert _split(4, excluded="AD") == "E2 J1 K1 M0"


def test_probe_exclude_every_split_zeroed_step() -> None:
    """Probe row 4: A, D, J, M excluded → E 3, K 1."""

    assert _split(4, excluded="ADJM") == "E3 K1"


def test_probe_excluded_in_progress_step_gets_no_raise() -> None:
    """Probe row 5: E In Progress and excluded, A started. S′ = A D J K M,
    T = 6: A, D, J, M 4/6, K 8/6 → K 1 + three of the 2/3 claims by sequence
    (A, D, J). E is not in S′: no share, no R3 raise, None. Σ stays 4."""

    r = apportion_effort(4, _effort_steps(excluded="E", started="AE"), kind="design")
    assert _split(4, excluded="E", started="AE") == "A1 D1 J1 K1 M0"
    assert r.raised_step_ids == ()
    assert r.total_weeks == 4


def test_r3_raises_a_started_step_of_s_prime_but_not_an_excluded_one() -> None:
    """A excluded, M In Progress: R2 gives D1 E2 K1 (M 0), R3 raises M to 1
    (Σ = 5). With M excluded as well, M is not raised and has no share."""

    raised = apportion_effort(4, _effort_steps(excluded="A", started="M"), kind="design")
    assert raised.weeks_by_step()["PDD-M"] == 1
    assert raised.raised_step_ids == ("PDD-M",)
    assert raised.total_weeks == 5

    excl = apportion_effort(4, _effort_steps(excluded="AM", started="M"), kind="design")
    assert "PDD-M" not in excl.weeks_by_step()
    assert excl.raised_step_ids == ()
    assert " ".join(f"{s[-1]}{w}" for s, w in excl.step_weeks) == "D1 E2 J0 K1"


def test_empty_s_prime_is_not_applied_and_does_not_crash() -> None:
    """Every weighted design step excluded (R35-5's guard is the backend's):
    the split is not applied with a reason the guard can test, not a
    division by zero."""

    r = apportion_effort(4, _effort_steps(excluded="ADEJKM"), kind="design")
    assert (r.applied, r.not_applied_reason, r.step_weeks) == (False, NOT_APPLIED_ALL_EXCLUDED, ())
    assert r.target_weeks == 4


def test_no_weighted_step_keeps_its_reason_whatever_is_excluded() -> None:
    """R7's own T = 0 (no step of the kind has a weight) is reported as
    before, even with steps excluded; certification off is checked first."""

    # No default category has a design / lab kind with T = 0, so a synthetic one.
    zero = [
        EffortStepInput("X-1", 1, "design", 0, excluded=True),
        EffortStepInput("X-2", 2, "design", 0),
    ]
    assert apportion_effort(2, zero).not_applied_reason == NOT_APPLIED_NO_NONZERO_STEP
    lab = apportion_effort(
        10,
        _effort_steps(excluded="H"),
        kind="lab",
        certification_testing_required=False,
    )
    assert lab.not_applied_reason == NOT_APPLIED_CERTIFICATION_OFF


def test_lab_split_over_s_prime() -> None:
    """PDD/A+ lab 4 → F 2, H 2 (R2 example); F excluded → H 4; both → not
    applied."""

    def lab(excluded: str) -> EffortSplit:
        return apportion_effort(4, _effort_steps("A+", excluded=excluded), kind="lab")

    assert lab("").weeks_by_step() == {"PDD-F": 2, "PDD-H": 2}
    assert lab("F").weeks_by_step() == {"PDD-H": 4}
    assert lab("FH").not_applied_reason == NOT_APPLIED_ALL_EXCLUDED


def test_derive_project_effort_writes_none_on_excluded_steps() -> None:
    d = derive_project_effort(
        design_effort_weeks=Decimal("4"),
        lab_effort_weeks=Decimal("10"),
        certification_testing_required=True,
        steps=_effort_steps(excluded="AE", started="E"),
    )
    by = d.effort_weeks_by_step()
    assert by["PDD-A"] is None and by["PDD-E"] is None
    assert {k: v for k, v in by.items() if v is not None} == {
        "PDD-D": 1,
        "PDD-H": 10,
        "PDD-J": 1,
        "PDD-K": 1,
        "PDD-M": 1,
    }


def test_split_is_order_independent_and_excluded_must_be_bool() -> None:
    steps = _effort_steps(excluded="A")
    assert apportion_effort(4, reversed(steps)) == apportion_effort(4, steps)
    bad = [dataclasses.replace(steps[0], excluded=1)]  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="excluded must be a bool"):
        apportion_effort(4, bad)


def test_exclusion_never_changes_a_split_without_it() -> None:
    """Every category and figure 1..30: `excluded=False` everywhere gives the
    same split as the pre-P35 input (the field defaults to False)."""

    for wf, cat in sorted({(w, c) for w, c, _ in LEAD}):
        plain = [
            EffortStepInput(s.step_id, s.sequence_order, s.kind, s.lead_weeks)
            for s in _effort_steps(cat, workflow=wf)
        ]
        for x in range(1, 31):
            for kind in ("design", "lab"):
                assert apportion_effort(x, plain, kind=kind) == apportion_effort(
                    x, _effort_steps(cat, workflow=wf), kind=kind
                )


# --- R35-9: lead_weeks = 0 is a skip on every scheduler path ---------------------------

# E excluded (Not Started): E skipped at G(D) = 32; H 33-38, J 39, K 40-41,
# L 42, M 43, N 44.
E_EXCLUDED = {
    "PDD-A": (31, 31),
    "PDD-D": (32, 32),
    "PDD-H": (33, 38),
    "PDD-J": (39, 39),
    "PDD-K": (40, 41),
    "PDD-L": (42, 42),
    "PDD-M": (43, 43),
    "PDD-N": (44, 44),
}


def _row(o: ProjectScheduleOutcome, step_id: str) -> tuple[bool, int, int, int]:
    s = next(s for s in o.steps if s.step_id == step_id)
    return s.skipped, s.duration_weeks, s.start_week, s.end_week


def test_greedy_skips_an_excluded_step() -> None:
    _, by = _run(_si(_project(step_timing=(_x("PDD-E"),))))
    o = by["p"]
    assert _weeks(o) == E_EXCLUDED
    assert _row(o, "PDD-E") == (True, 0, 32, 32)
    assert len(o.steps) == 14  # I5 shape kept
    assert o.end_week == 44
    assert o.unconstrained_end_week == 44


def test_cp_sat_matches_greedy_on_an_excluded_step() -> None:
    si = _si(_project(step_timing=(_x("PDD-E"),)))
    assert _weeks(_cp(si)["p"]) == E_EXCLUDED
    assert _row(_cp(si)["p"], "PDD-E")[:2] == (True, 0)


def test_lead_zero_beats_an_override() -> None:
    """A what-if override cannot revive an excluded step (R33-1, OQ #81)."""

    _, by = _run(_si(_project(step_timing=(_t("PDD-E", lead=0, duration=5),))))
    assert _weeks(by["p"]) == E_EXCLUDED


def test_no_exclusion_is_the_baseline() -> None:
    """Byte-identity guard: no exclusion → the P33 baseline rows."""

    _, by = _run(_si(_project()))
    assert _weeks(by["p"]) == BASELINE


def _started_project(e_status: str, *, excluded: bool) -> ScheduleInput:
    return _si(
        _project(
            actual_start_week=29,
            step_progress=(
                progress(
                    "PDD-A", "Done", percent_complete=100, actual_start_week=29, actual_end_week=29
                ),
                progress(
                    "PDD-D", "Done", percent_complete=100, actual_start_week=30, actual_end_week=30
                ),
                progress("PDD-E", e_status, percent_complete=50, actual_start_week=31),
            ),
            step_timing=(_x("PDD-E"),) if excluded else (),
        )
    )


def test_excluded_in_progress_step_is_normalised_greedy_equals_cp_sat() -> None:
    """E In Progress (50 %) and excluded: the step is skipped (treated as
    complete, R35-4); its progress is ignored, not rewritten. H runs from
    CURRENT_WEEK: H 31-36, J 37, K 38-39, L 40, M 41, N 42. The validator's
    I26 input check does not report it (lead 0, not a zeroed override)."""

    si = _started_project("In Progress", excluded=True)
    _, by = _run(si)
    o = by["p"]
    want = {
        "PDD-A": (29, 29),
        "PDD-D": (30, 30),
        "PDD-H": (31, 36),
        "PDD-J": (37, 37),
        "PDD-K": (38, 39),
        "PDD-L": (40, 40),
        "PDD-M": (41, 41),
        "PDD-N": (42, 42),
    }
    assert _weeks(o) == want
    assert _row(o, "PDD-E")[:2] == (True, 0)
    assert _weeks(_cp(si)["p"]) == want
    # The input's progress row is untouched (no progress write, R35-4).
    assert si.projects[0].step_progress[2].status == "In Progress"
    # Without the exclusion E keeps its 2-week tail: H moves later.
    _, plain = _run(_started_project("In Progress", excluded=False))
    assert _weeks(plain["p"])["PDD-H"][0] > 31


def test_excluded_blocked_step_releases_the_hold() -> None:
    """A Blocked step holds its project; excluded, it is skipped and the
    project is scheduled (R35-4 Blocked note, OQ #82 assumption)."""

    _, held = _run(_started_project("Blocked", excluded=False))
    assert held["p"].blocked
    _, by = _run(_started_project("Blocked", excluded=True))
    assert not by["p"].blocked
    assert by["p"].end_week == 42


def test_frozen_project_honours_an_exclusion() -> None:
    """A frozen project honours `lead_weeks` (R33-4, R35-11): same weeks as
    the live walk from 31."""

    _, by = _run(_si(_project(frozen=True, actual_start_week=31, step_timing=(_x("PDD-E"),))))
    assert _weeks(by["p"]) == E_EXCLUDED
    assert _row(by["p"], "PDD-E")[:2] == (True, 0)


def test_gap_on_an_excluded_step_is_ignored() -> None:
    """R35-8: H (lab) excluded with a wait of 3 → the wait is ignored: E
    33-36, H skipped at 36, J 37, K 38-39, L 40, M 41, N 42. The same as H
    excluded with no wait."""

    _, waited = _run(_si(_project(step_timing=(_x("PDD-H", wait=3),))))
    _, plain = _run(_si(_project(step_timing=(_x("PDD-H"),))))
    assert _weeks(waited["p"]) == _weeks(plain["p"])
    assert _weeks(plain["p"])["PDD-J"] == (37, 37)
    assert _weeks(plain["p"])["PDD-N"] == (42, 42)
    assert _skipped(plain["p"])["PDD-H"] == 36


def test_successor_wait_counts_from_the_release_through_an_excluded_step() -> None:
    """R35-8: H excluded, J waits 2: release(J) = G(H) = end(E) = 36, gate
    = 39. J 39, K 40-41, L 42, M 43, N 44."""

    si = _si(_project(step_timing=(_x("PDD-H"), _t("PDD-J", wait=2))))
    _, by = _run(si)
    assert _weeks(by["p"])["PDD-J"] == (39, 39)
    assert by["p"].end_week == 44
    assert _weeks(_cp(si)["p"]) == _weeks(by["p"])


def test_first_step_excluded_successor_wait_counts_from_the_frontier() -> None:
    """A excluded: release(D) = frontier − 1 = 30. With no wait D 31; with a
    wait of 2, D 33 and everything after it two weeks later (N 49)."""

    _, plain = _run(_si(_project(step_timing=(_x("PDD-A"),))))
    assert _weeks(plain["p"])["PDD-D"] == (31, 31)
    assert plain["p"].end_week == 47
    _, waited = _run(_si(_project(step_timing=(_x("PDD-A"), _t("PDD-D", wait=2)))))
    assert _weeks(waited["p"])["PDD-D"] == (33, 33)
    assert waited["p"].end_week == 49


def test_overlap_successor_anchors_on_nearest_non_skipped_predecessor() -> None:
    """E excluded, H overlaps 1: release(H) = G(E) = G(D) = 32; gate(H) =
    max(32 + 1 − 1, start(D) = 32, 31) = 32. H 32-37, J 38, …, N 43."""

    si = _si(_project(step_timing=(_x("PDD-E"), _t("PDD-H", overlap=1))))
    _, by = _run(si)
    assert _weeks(by["p"])["PDD-H"] == (32, 37)
    assert by["p"].end_week == 43
    assert _weeks(_cp(si)["p"]) == _weeks(by["p"])


def test_monte_carlo_never_revives_an_excluded_step() -> None:
    """R10: a 0 stays 0 under every sampled factor; with no perturbation one
    iteration reproduces the greedy completion week (44)."""

    p = _project(step_timing=(_x("PDD-E"), _t("PDD-H", lead=6)))
    for factor in (0.5, 0.8, 1.0, 1.3, 2.0):
        rows = {r.step_id: r for r in _perturbed_project(p, 0, factor).step_timing}
        assert rows["PDD-E"].lead_weeks == 0
        assert rows["PDD-E"].duration_override_weeks is None
        assert rows["PDD-H"].lead_weeks >= 1  # type: ignore[operator]
    one = forecast_delivery(
        _si(_project(step_timing=(_x("PDD-E"),))),
        iterations=1,
        delay_perturbation=False,
        duration_perturbation=False,
    )
    assert one.project_forecasts[0].completion_weeks == (44,)
    many = forecast_delivery(_si(p), iterations=12, seed=7)
    assert many.project_forecasts[0].iterations_scheduled == 12


# --- Validator: I5 / I29 read the exclusion from the input, I35 -------------------------


def test_validator_rejects_a_run_that_ignores_the_exclusion() -> None:
    """The baseline output checked against an input with E excluded: I5 and
    I29 both see that E should be skipped."""

    si = _si(_project(step_timing=(_x("PDD-E"),)))
    wrong = run_greedy_sgs(_si(_project()))
    found = {
        (v.invariant, v.step_id) for v in validate_invariants(si, wrong, check_determinism=False)
    }
    # I5 reports the skip flag; the duration term is I6's (I29 reports only
    # what no other check does, P33-T02).
    assert ("I5", "PDD-E") in found
    assert ("I6", "PDD-E") in found


def _all_excluded(**kw: object) -> ScheduleInput:
    return _si(_project("ghost", step_timing=tuple(_x(s) for s in PDD), **kw))


def test_i35_flags_a_project_with_every_step_skipped() -> None:
    """The auditor's ghost outcome: no end week, no bucket. I35 names it."""

    si = _all_excluded()
    out = run_greedy_sgs(si)
    o = out.project_outcomes[0]
    assert (o.end_week, o.left_out, o.within_year, o.spillover) == (None, False, False, False)
    v = validate_invariants(si, out, check_determinism=False)
    assert [(x.invariant, x.project_id) for x in v if x.invariant == "I35"] == [("I35", "ghost")]
    # The ghost also trips I9 (no end week to derive within_year from).
    assert {x.invariant for x in v} == {"I9", "I35"}


def test_i35_ignores_non_schedulable_projects_and_partial_exclusion() -> None:
    on_hold = _all_excluded(status="On Hold")
    assert not [
        v
        for v in validate_invariants(on_hold, run_greedy_sgs(on_hold), check_determinism=False)
        if v.invariant == "I35"
    ]
    # Every design step excluded, the lab step H left: not empty.
    partial = _si(_project(step_timing=tuple(_x(s) for s in PDD if s != "PDD-H")))
    _run(partial)


def test_i35_holds_on_the_default_golden_inputs() -> None:
    """No existing project is empty: every PDD / OEM category has a non-zero
    step, so I35 adds no violation anywhere without exclusions."""

    for wf, cat in sorted({(w, c) for w, c, _ in LEAD}):
        assert any(LEAD[(wf, cat, s)] > 0 for (w, c, s) in LEAD if (w, c) == (wf, cat))


# --- Live rows: I25, I26 rev. 2, I33, I34 (i) -------------------------------------------


def _live_steps(
    *,
    effort: dict[str, int | None] | None = None,
    excluded: str = "",
    status: dict[str, str] | None = None,
) -> tuple[LiveStepRow, ...]:
    effort = effort or {}
    status = status or {}
    return tuple(
        LiveStepRow(
            step_id=sid,
            sequence_order=TEMPLATES[sid].sequence_order,
            kind=TEMPLATES[sid].kind,
            lead_weeks=LEAD[("PDD", "B", sid)],
            user_override_weeks=None,
            effort_weeks=effort.get(sid),
            status=status.get(sid, "Not Started"),
            percent_complete=50 if status.get(sid) == "In Progress" else 0,
            excluded=sid[-1] in excluded,
        )
        for sid in PDD
    )


def _live(steps: tuple[LiveStepRow, ...], *, design: object = None) -> LiveProjectRow:
    return LiveProjectRow(
        project_id="p",
        hub="R&D-Greece",
        capacity_hub="R&D-Greece",
        status="In Development",
        frozen=False,
        certification_testing_required=True,
        design_effort_weeks=design,  # type: ignore[arg-type]
        lab_effort_weeks=None,
        steps=steps,
    )


def test_i26_rev2_accepts_the_split_over_s_prime() -> None:
    ok = _live(
        _live_steps(
            effort={"PDD-D": 1, "PDD-E": 2, "PDD-J": 0, "PDD-K": 1, "PDD-M": 0}, excluded="A"
        ),
        design=Decimal("4"),
    )
    assert check_i26_effort_split([ok]) == ()


def test_i26_rev2_rejects_effort_on_an_excluded_step_and_the_old_split() -> None:
    stale = _live(
        _live_steps(
            effort={"PDD-A": 1, "PDD-D": 0, "PDD-E": 2, "PDD-J": 0, "PDD-K": 1, "PDD-M": 0},
            excluded="A",
        ),
        design=Decimal("4"),
    )
    found = {(v.invariant, v.step_id) for v in check_i26_effort_split([stale])}
    assert found == {("I26", "PDD-A"), ("I26", "PDD-D")}


def test_i26_rev2_excluded_in_progress_step_is_not_raised() -> None:
    """E In Progress and excluded, A started → A1 D1 J1 K1, E None."""

    steps = _live_steps(
        effort={"PDD-A": 1, "PDD-D": 1, "PDD-J": 1, "PDD-K": 1, "PDD-M": 0},
        excluded="E",
        status={"PDD-A": "Done", "PDD-E": "In Progress"},
    )
    assert check_i26_effort_split([_live(steps, design=4)]) == ()
    raised = _live_steps(
        effort={"PDD-A": 1, "PDD-D": 1, "PDD-E": 1, "PDD-J": 1, "PDD-K": 1, "PDD-M": 0},
        excluded="E",
        status={"PDD-A": "Done", "PDD-E": "In Progress"},
    )
    assert [v.step_id for v in check_i26_effort_split([_live(raised, design=4)])] == ["PDD-E"]


def test_i26_rev2_flags_a_figure_in_force_with_an_empty_s_prime() -> None:
    steps = _live_steps(excluded="ADEJKM")
    v = check_i26_effort_split([_live(steps, design=4)])
    assert [(x.invariant, x.step_id) for x in v] == [("I26", None)]
    assert "S′ is empty" in v[0].description
    # No figure: nothing to split, nothing to flag.
    assert check_i26_effort_split([_live(steps)]) == ()


def test_i25_excluded_step_drops_its_whole_effort_and_remainder() -> None:
    """R35-1 / Q1: full-year demand drops the excluded In Progress step's
    whole eff (4), remaining demand its remainder (2)."""

    plain = _live(_live_steps(status={"PDD-E": "In Progress"}))
    excl = _live(_live_steps(status={"PDD-E": "In Progress"}, excluded="E"))
    a, b = compute_demand_load([plain]), compute_demand_load([excl])
    assert a.design_full_year["R&D-Greece"] - b.design_full_year["R&D-Greece"] == 4
    assert a.design_remaining["R&D-Greece"] - b.design_remaining["R&D-Greece"] == 2


def test_i34_no_excluded_done_step() -> None:
    ok = _live(_live_steps(excluded="E", status={"PDD-E": "In Progress"}))
    assert check_i34_excluded_not_done([ok]) == ()
    bad = _live(_live_steps(excluded="A", status={"PDD-A": "Done"}))
    v = check_i34_excluded_not_done([bad])
    assert [(x.invariant, x.step_id) for x in v] == [("I34", "PDD-A")]


def test_i33_holds_for_the_r35_9_builder_mapping() -> None:
    """E excluded → lead_weeks 0; B (table 0 for category B) excluded →
    no lead_weeks needed. The run rows are skipped with duration 0."""

    live = _live(_live_steps(excluded="BE"))
    si = _si(_project(step_timing=(_x("PDD-E"),)))
    assert check_i33_step_exclusion([live], si, run_greedy_sgs(si)) == ()
    assert check_i33_step_exclusion([live], si) == ()


def test_i33_detects_a_builder_that_drops_or_misstates_the_exclusion() -> None:
    live = _live(_live_steps(excluded="E"))
    missing = _si(_project())
    v = check_i33_step_exclusion([live], missing, run_greedy_sgs(missing))
    # No lead_weeks (table 4) and an unskipped run row.
    assert [x.invariant for x in v] == ["I33", "I33"]
    with_override = _si(_project(step_timing=(_t("PDD-E", lead=0, duration=3),)))
    v2 = check_i33_step_exclusion([live], with_override)
    assert len(v2) == 1 and "duration_override_weeks=[3]" in v2[0].description
    wrong_lead = _si(_project(step_timing=(_t("PDD-E", lead=2),)))
    v3 = check_i33_step_exclusion([live], wrong_lead)
    assert len(v3) == 1 and "lead_weeks=[2]" in v3[0].description
    # A project not in the run input is checked on its live eff only.
    assert check_i33_step_exclusion([live], _si()) == ()
