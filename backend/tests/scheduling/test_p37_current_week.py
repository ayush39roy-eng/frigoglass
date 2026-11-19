"""P37-T03 (ADR 0052, DOMAIN_RULES "The current week follows the calendar").

`ScheduleInput.current_week` is required and keyword-only: no value is bound
at import. These tests pin:

- the field has no default and no new canonical field exists (pin condition
  (ii)): the field list, the canonical input hash and the greedy output hash of
  a fixed input are the values recorded before the change (byte-identical);
- the range checks (`validate_current_week` structural, `require_plan_week`
  the I41 domain 1..52);
- a solve at W47 vs W42 on the same input differs only through the week, and
  two solves at one week are byte-identical (I8);
- no scheduling module reads `domain_constants.CURRENT_WEEK` (statically, and
  by patching it at runtime);
- the validator's I38 / I41 checks.
"""

from __future__ import annotations

import ast
import dataclasses
import hashlib
import json
from pathlib import Path

import pytest

import domain_constants as dc
import scheduling
from scheduling import (
    PLAN_WEEK_MAX,
    PLAN_WEEK_MIN,
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ScheduleInput,
    check_i38_run_week,
    check_i41_week_domain,
    forecast_delivery,
    require_plan_week,
    run_cp_sat,
    run_greedy_sgs,
    validate_current_week,
    validate_invariants,
)
from scheduling._selftest_common import SELFTEST_WEEK
from scheduling.whatif import AddProject, Scenario, simulate
from scheduling.workflow import (
    canonical_schedule_input_asdict,
    canonical_schedule_output_asdict,
)
from tests.scheduling._whatif_fixtures import tiny_baseline

ENG = EngineerInput("eng-a", "A", "R&D-Greece", ("A+", "A", "B", "C"))
ENG_OEM = EngineerInput("eng-o", "O", "OEM-HCK", ("B-OEM",))
CH = ChamberInput(
    "ch", "GR", "Greece", max_concurrent=1, allowed_stages=("OEM-E", "OEM-H", "PDD-F", "PDD-H")
)


def _projects() -> tuple[ProjectInput, ...]:
    pdd = tuple(
        ProjectInput(
            project_id=f"p{i}",
            name=f"p{i}",
            hub="R&D-Greece",
            status="In Development",
            category=cat,
            priority=prio,
            frozen=False,
            leader_engineer_id="eng-a",
        )
        for i, (cat, prio) in enumerate([("A+", "P1"), ("B", "P2"), ("A", "P1"), ("C", "P3")])
    )
    oem = ProjectInput(
        project_id="po",
        name="po",
        hub="OEM-HCK",
        status="In Queue",
        category="B-OEM",
        workflow_id="OEM",
        priority="P2",
        frozen=False,
        leader_engineer_id="eng-o",
    )
    return (*pdd, oem)


def _si(week: int) -> ScheduleInput:
    return ScheduleInput(
        projects=_projects(), engineers=(ENG, ENG_OEM), chambers=(CH,), current_week=week
    )


def _digest(obj: object) -> str:
    blob = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# --- No default; no new canonical field (pin condition (ii)) ------------------


def test_current_week_is_required_and_keyword_only() -> None:
    f = {x.name: x for x in dataclasses.fields(ScheduleInput)}["current_week"]
    assert f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING
    assert f.kw_only is True
    with pytest.raises(TypeError, match="current_week"):
        ScheduleInput(projects=(), engineers=(), chambers=())  # type: ignore[call-arg]


def test_field_set_and_order_unchanged() -> None:
    # The pre-P37 field list, in declaration order (asdict / canonical order).
    assert [x.name for x in dataclasses.fields(ScheduleInput)] == [
        "projects",
        "engineers",
        "chambers",
        "workflow_steps",
        "lead_times",
        "current_week",
        "horizon_weeks",
        "within_year_week",
        "categories",
    ]
    data = canonical_schedule_input_asdict(_si(SELFTEST_WEEK))
    assert list(data) == [
        "projects",
        "engineers",
        "chambers",
        "workflow_steps",
        "lead_times",
        "current_week",
        "horizon_weeks",
        "within_year_week",
    ]


def test_canonical_hash_and_greedy_output_byte_identical_to_pre_p37() -> None:
    """Hex digests recorded on the pre-P37 code (default `dc.CURRENT_WEEK`
    under the suite pin 31) for this exact input. The explicit W31 input
    must hash and solve to the same bytes."""

    # P53 (R53-2, ADR 0063): the default search limit is now cw + 52 x 5; the
    # pre-P37 digests were taken at the 78-week search, pinned explicitly here
    # (an old-rules-epoch input). With it the bytes are unchanged.
    si = dataclasses.replace(_si(31), horizon_weeks=78)
    assert (
        _digest(canonical_schedule_input_asdict(si))
        == "87341158d09004a259e7765a28e5976ec10195476435db8b0340d7fd1e5c0b96"
    )
    # P40 (ADR 0054, I48(a)): `ProjectInput.step_pins` and the four output
    # flags are new dataclass fields, so a *raw* `asdict` now carries them at
    # their defaults. The forms that are hashed or stored drop them there
    # (`canonical_schedule_input_asdict` above, `canonical_schedule_output_asdict`
    # here), and with them removed the pre-P37 / pre-P40 digests are unchanged.
    raw = dataclasses.asdict(si)
    for project in raw["projects"]:
        assert project.pop("step_pins") == ()
        assert project.pop("actual_end_week") is None  # P53 (R53-2b): omitted at None
    assert _digest(raw) == "d3542beb18c2f126d99a7a05188b0bbd9b049eb3cb2bc50e0d527cab68172d4f"
    assert (
        _digest(canonical_schedule_output_asdict(run_greedy_sgs(si)))
        == "27bf165b9926aed1b5046d64cd7ff66dc06437920312f427f3f9c64134a2917b"
    )


# --- Range checks ------------------------------------------------------------------


@pytest.mark.parametrize("week", [0, -1])
def test_out_of_range_week_rejected(week: int) -> None:
    with pytest.raises(ValueError, match="current_week"):
        _si(week)


@pytest.mark.parametrize("week", [79, 1000])
def test_any_absolute_week_solves_with_the_derived_horizon(week: int) -> None:
    # P53 (R53-1 / R53-2): weeks are absolute; the default horizon is derived
    # from the week (cw + 260), so a later week is no longer out of range.
    si = _si(week)
    assert (si.horizon_weeks, si.current_week) == (week + 260, week)
    with pytest.raises(ValueError, match="current_week"):
        dataclasses.replace(si, horizon_weeks=week - 1)


@pytest.mark.parametrize("week", [True, False, "31", 31.0, None])
def test_non_int_week_rejected(week: object) -> None:
    with pytest.raises(TypeError, match="current_week"):
        _si(week)  # type: ignore[arg-type]


def test_week_bounded_by_horizon_not_by_52_in_the_engine() -> None:
    # Engine-only golden scenarios solve past W52 (horizon overflow); the
    # structural bound is the horizon. `replace` re-validates.
    assert _si(78).current_week == 78
    with pytest.raises(ValueError):
        dataclasses.replace(_si(40), horizon_weeks=39)
    validate_current_week(1, 1)
    with pytest.raises(ValueError):
        validate_current_week(2, 1)


@pytest.mark.parametrize("week", [PLAN_WEEK_MIN, 31, 47, 52, 53, 104, 105, 364, 365, PLAN_WEEK_MAX])
def test_require_plan_week_accepts_absolute_weeks(week: int) -> None:
    # I41 amended by R53-1: an absolute week >= 1 (5200 = 100-year sanity bound).
    assert (PLAN_WEEK_MIN, PLAN_WEEK_MAX) == (1, 5200)
    assert require_plan_week(week) == week
    assert check_i41_week_domain(week) == []


@pytest.mark.parametrize("week", [0, -5, 5201])
def test_require_plan_week_rejects_out_of_range(week: int) -> None:
    with pytest.raises(ValueError, match="I41"):
        require_plan_week(week)
    [v] = check_i41_week_domain(week)
    assert v.invariant == "I41" and v.week == week


@pytest.mark.parametrize("week", [True, "47", 47.0])
def test_require_plan_week_rejects_non_int(week: object) -> None:
    with pytest.raises(TypeError):
        require_plan_week(week)
    [v] = check_i41_week_domain(week)
    assert v.invariant == "I41"


# --- W47 vs W42; I8 at one week --------------------------------------------------------


def test_w47_vs_w42_differs_only_through_the_week() -> None:
    a, b = _si(42), _si(47)
    da, db = canonical_schedule_input_asdict(a), canonical_schedule_input_asdict(b)
    # P53: the derived search limit H = cw + 260 moves with the week.
    assert {k for k in da if da[k] != db[k]} == {"current_week", "horizon_weeks"}
    assert dataclasses.replace(a, current_week=47, horizon_weeks=47 + 260) == b

    oa, ob = run_greedy_sgs(a), run_greedy_sgs(b)
    assert oa != ob
    # Nothing starts before the input week (the only week the solver reads).
    for out, week in ((oa, 42), (ob, 47)):
        assert all(s.start_week >= week for o in out.project_outcomes for s in o.steps)
    # No project has progress, so every unconstrained finish (a function of
    # the input week and the lead times only) moves by exactly the difference.
    ua = {o.project_id: o.unconstrained_end_week for o in oa.project_outcomes}
    ub = {o.project_id: o.unconstrained_end_week for o in ob.project_outcomes}
    assert all(ua[p] is not None for p in ua)
    assert ub == {p: w + 5 for p, w in ua.items() if w is not None}
    assert validate_invariants(a, oa) == () and validate_invariants(b, ob) == ()


def test_two_solves_at_one_week_are_byte_identical() -> None:
    o1, o2 = run_greedy_sgs(_si(47)), run_greedy_sgs(_si(47))
    assert _digest(dataclasses.asdict(o1)) == _digest(dataclasses.asdict(o2))
    c1, _ = run_cp_sat(_si(47), deterministic_time=2.0, earliness_deterministic_time=1.0)
    c2, _ = run_cp_sat(_si(47), deterministic_time=2.0, earliness_deterministic_time=1.0)
    assert _digest(dataclasses.asdict(c1)) == _digest(dataclasses.asdict(c2))


# --- The engine reads the week only from the input ----------------------------------


def test_no_scheduling_module_reads_domain_constants_current_week() -> None:
    pkg = Path(scheduling.__file__).parent
    offenders: list[str] = []
    for path in sorted(pkg.glob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr == "CURRENT_WEEK":
                offenders.append(f"{path.name}:{node.lineno}")
            if isinstance(node, ast.ImportFrom) and any(
                a.name == "CURRENT_WEEK" for a in node.names
            ):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == []


def test_patching_the_module_constant_changes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    si = _si(42)
    base = tiny_baseline()
    scenario = Scenario(add_projects=(AddProject("R&D-Greece", "B", count=2),))

    def solve_all() -> tuple[str, ...]:
        g = run_greedy_sgs(si)
        c, _ = run_cp_sat(si, deterministic_time=2.0, earliness_deterministic_time=1.0)
        w = simulate(base, scenario)
        m = forecast_delivery(si, iterations=8)
        return tuple(_digest(dataclasses.asdict(x)) for x in (g, c, w, m))

    before = solve_all()
    # `raising=False`: P37-T04 may remove the module constant altogether.
    monkeypatch.setattr(dc, "CURRENT_WEEK", 5, raising=False)
    assert solve_all() == before


# --- I38 / I41 in the validator -------------------------------------------------------


def test_i38_run_week_equals_input_week() -> None:
    si = _si(47)
    out = run_greedy_sgs(si)
    assert check_i38_run_week(si, 47) == []
    assert validate_invariants(si, out, check_determinism=False, run_week=47) == ()

    [v] = check_i38_run_week(si, 42)
    assert v.invariant == "I38" and v.week == 42
    got = validate_invariants(si, out, check_determinism=False, run_week=42)
    assert [x.invariant for x in got] == ["I38"]


def test_i38_with_a_week_outside_the_domain_reports_i41_too() -> None:
    # P53 (I41 amended): W60 (2027 W8) is a valid absolute week now.
    si = _si(60)
    out = run_greedy_sgs(si)
    assert check_i38_run_week(si, 60) == []
    got = [v.invariant for v in check_i38_run_week(si, "60")]
    assert got == ["I41", "I38"]
    live = validate_invariants(si, out, check_determinism=False, live_state=True)
    assert [v.invariant for v in live if v.invariant == "I41"] == []
    got = [v.invariant for v in check_i38_run_week(si, 0)]
    assert got == ["I41", "I38"]
