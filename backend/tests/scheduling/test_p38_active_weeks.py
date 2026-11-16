"""P38-T03 -- What-if and plan-import supply follow the active-weeks rule (ADR 0053 R38-1 / R38-2).

`WhatIfBaseline.engineer_active_weeks` is supply-only: it never reaches
`ScheduleInput` (canonical input and hash unchanged), greedy, CP-SAT or the
validator. Synthetic fixtures only.

Hand figures (the ruling's measured PD-Romania case, reproduced synthetically):

    PD-Romania calendar: 40 leave days / 5 = 8 deduction weeks -> wwpe 44.
    Counted FTE 5.75 (Elena 1.0 + 1.0 + 1.0 + 1.0 + 1.0 + 0.75). CW = 47.
    Before:  year 44 x 5.75 = 253.00;  remaining (5 - 8 x 5/52) x 5.75 = 24.33.
    Elena deactivated at W47 (covers 48..52 and every later week):
             year 44 x (4.75 + 1.0 x 47/52) = 248.77
             remaining (5 - 8 x 5/52) x 4.75 = 20.10
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
from decimal import Decimal
from fractions import Fraction

import pytest

from scheduling import (
    ChamberInput,
    EngineerActiveWeeks,
    EngineerInput,
    InactivePeriod,
    ProjectInput,
    ScheduleInput,
    active_week_count,
    canonical_schedule_input_asdict,
    covered_plan_weeks,
)
from scheduling.greedy import run_greedy_sgs
from scheduling.plan_import import ImportProject, PlanImportRequest, run_plan_import
from scheduling.whatif import (
    AddEngineer,
    AddProject,
    HubCalendarInput,
    RemoveEngineerCount,
    Scenario,
    WhatIfBaseline,
    analytic_requirements,
    simulate,
    to_jsonable,
)
from tests.scheduling._whatif_fixtures import portfolio_baseline

PLAN_YEAR = 2026
HUB = "PD-Romania"
CATS = ("A+", "A", "B", "C")
DEDUCTION_DAYS = 40  # / 5 = 8 weeks -> wwpe 44
OTHERS = (("ro-a", 1.0), ("ro-b", 1.0), ("ro-c", 1.0), ("ro-d", 1.0), ("ro-e", 0.75))
ELENA = ("ro-elena", 1.0)


# =====================================================================================
# The Capacity-page formula (DOMAIN_RULES "Capacity supply" + R38-1), by hand
# =====================================================================================


def capacity_page(
    ftes_no_period: list[float],
    with_period: list[tuple[float, tuple[int, ...]]],
    cw: int,
    deduction_weeks: Fraction = Fraction(8),
) -> tuple[float, float]:
    """R38-1, exactly: Σ fte as Decimal, the week factor as Fraction."""

    wwpe = 52 - deduction_weeks
    rem_wwpe = (52 - cw) - deduction_weeks * Fraction(52 - cw, 52)
    base = sum((Fraction(Decimal(str(f))) for f in ftes_no_period), Fraction(0))
    year_fte = base + sum(
        (
            Fraction(Decimal(str(f))) * Fraction(active_week_count(c, 1, 52), 52)
            for f, c in with_period
        ),
        Fraction(0),
    )
    rem_fte = base
    if cw < 52:
        rem_fte += sum(
            (
                Fraction(Decimal(str(f))) * Fraction(active_week_count(c, cw + 1, 52), 52 - cw)
                for f, c in with_period
            ),
            Fraction(0),
        )
    return float(wwpe * year_fte), float(rem_wwpe * rem_fte)


# =====================================================================================
# Fixture
# =====================================================================================


def _eng(eid: str, fte: float, *, counted: bool = True) -> EngineerInput:
    return EngineerInput(eid, f"Name {eid}", HUB, CATS, fte=fte, counts_in_capacity=counted)


def _projects() -> tuple[ProjectInput, ...]:
    out = []
    leaders = [e for e, _ in OTHERS]
    for k in range(8):
        out.append(
            ProjectInput(
                project_id=f"rp{k:02d}",
                name=f"Romania {k}",
                hub=HUB,
                status="In Queue",
                category=CATS[k % 4],
                priority=("P1", "P2", "P3")[k % 3],
                frozen=False,
                leader_engineer_id=leaders[k % len(leaders)],
            )
        )
    return tuple(out)


def romania(
    *,
    cw: int = 47,
    elena_in_roster: bool = False,
    active_weeks: tuple[EngineerActiveWeeks, ...] = (),
    extra: tuple[EngineerInput, ...] = (),
) -> WhatIfBaseline:
    engs = [_eng(e, f) for e, f in OTHERS]
    if elena_in_roster:
        engs.append(_eng(*ELENA))
    engs.extend(extra)
    si = ScheduleInput(
        projects=_projects(),
        engineers=tuple(sorted(engs, key=lambda e: e.engineer_id)),
        chambers=(ChamberInput("ch-ro", "RO-1", "Romania", 2, ("PDD-F", "PDD-H"), 0.8),),
        current_week=cw,
    )
    return WhatIfBaseline(
        schedule=si,
        calendars=(HubCalendarInput(HUB, 5, DEDUCTION_DAYS, 0, 0, 0),),
        engineer_active_weeks=active_weeks,
    )


def elena_deactivated(week: int = 47) -> EngineerActiveWeeks:
    cov = covered_plan_weeks((InactivePeriod(PLAN_YEAR, week),), PLAN_YEAR)
    return EngineerActiveWeeks(ELENA[0], HUB, ELENA[1], cov)


def elena_gap(d: int, r: int) -> EngineerActiveWeeks:
    cov = covered_plan_weeks((InactivePeriod(PLAN_YEAR, d, PLAN_YEAR, r),), PLAN_YEAR)
    return EngineerActiveWeeks(ELENA[0], HUB, ELENA[1], cov)


ADD_ONE = Scenario(add_projects=(AddProject(HUB, "C"),))


def _design_row(base: WhatIfBaseline, basis: str):  # type: ignore[no-untyped-def]
    res = analytic_requirements(base, ADD_ONE, basis=basis)  # type: ignore[arg-type]
    return next(r for r in res.design if r.hub == HUB)


def _util_row(base: WhatIfBaseline):  # type: ignore[no-untyped-def]
    res = simulate(base, Scenario())
    return next(u for u in res.utilization_before if u.scope == "hub" and u.key == HUB)


def _hub_row(base: WhatIfBaseline, pyew: int = 52):  # type: ignore[no-untyped-def]
    res = run_plan_import(base, PlanImportRequest(projects=(), plan_year_end_week=pyew))
    return res, next(h for h in res.capacity.hubs if h.hub == HUB)


# =====================================================================================
# The helper: whole-week rule
# =====================================================================================


def test_covered_weeks_whole_week_rule() -> None:
    # the deactivation week counts as worked; open -> 52 and all of the next year
    assert covered_plan_weeks((InactivePeriod(2026, 47),), 2026) == tuple(range(48, 105))
    # deactivate + reactivate in the same week covers nothing
    assert covered_plan_weeks((InactivePeriod(2026, 20, 2026, 20),), 2026) == ()
    # closed gap: d+1 .. r
    assert covered_plan_weeks((InactivePeriod(2026, 10, 2026, 20),), 2026) == tuple(range(11, 21))
    # began in an earlier plan year: starts at week 1; closed in this year
    assert covered_plan_weeks((InactivePeriod(2025, 50, 2026, 3),), 2026) == (1, 2, 3)
    # closed in an earlier plan year: nothing
    assert covered_plan_weeks((InactivePeriod(2024, 5, 2025, 9),), 2026) == ()
    # crosses into Y+1: rest of Y, then 1..r of Y+1 as horizon weeks 53..
    assert covered_plan_weeks((InactivePeriod(2026, 50, 2027, 2),), 2026) == (51, 52, 53, 54)
    # recorded at (plan_year, 52) while the year is closed: 0 weeks of Y, all of Y+1
    assert covered_plan_weeks((InactivePeriod(2026, 52),), 2026) == tuple(range(53, 105))
    # starting next plan year: only horizon weeks of Y+1
    assert covered_plan_weeks((InactivePeriod(2027, 2),), 2026) == tuple(range(55, 105))
    # two periods merge, sorted and unique
    two = (InactivePeriod(2026, 30, 2026, 32), InactivePeriod(2026, 5, 2026, 7))
    assert covered_plan_weeks(two, 2026) == (6, 7, 31, 32)


def test_active_week_count_is_a_e() -> None:
    cov = covered_plan_weeks((InactivePeriod(2026, 47),), 2026)
    assert active_week_count(cov, 1, 52) == 47
    assert active_week_count(cov, 48, 52) == 0
    assert active_week_count(cov, 47, 47) == 1
    assert active_week_count(cov, 53, 52) == 0  # empty range (CW = 52)
    e = EngineerActiveWeeks("x", HUB, 1.0, cov)
    assert e.active_weeks(1, 52) == 47 and e.is_active_in(47) and not e.is_active_in(48)


@pytest.mark.parametrize(
    ("kwargs", "exc"),
    [
        ({"from_plan_year": 2026, "from_week": 0}, ValueError),
        ({"from_plan_year": 2026, "from_week": 53}, ValueError),
        ({"from_plan_year": 2026, "from_week": True}, TypeError),
        ({"from_plan_year": 2026, "from_week": 5, "to_plan_year": 2026}, ValueError),
        ({"from_plan_year": 2026, "from_week": 5, "to_plan_year": 2026, "to_week": 4}, ValueError),
        ({"from_plan_year": 2026, "from_week": 5, "to_plan_year": 2025, "to_week": 9}, ValueError),
    ],
)
def test_inactive_period_validation(kwargs: dict[str, object], exc: type[Exception]) -> None:
    with pytest.raises(exc):
        InactivePeriod(**kwargs)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("fte", "weeks", "exc"),
    [
        (-0.5, (), ValueError),
        ("1", (), TypeError),
        (True, (), TypeError),
        (1.0, (3, 2), ValueError),
        (1.0, (2, 2), ValueError),
        (1.0, (0,), ValueError),
        (1.0, (105,), ValueError),
        (1.0, (1.0,), TypeError),
    ],
)
def test_engineer_active_weeks_validation(
    fte: object, weeks: tuple[object, ...], exc: type[Exception]
) -> None:
    with pytest.raises(exc):
        EngineerActiveWeeks("x", HUB, fte, weeks)  # type: ignore[arg-type]


def test_baseline_rejects_duplicate_entries() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        romania(active_weeks=(elena_deactivated(), elena_deactivated()))


# =====================================================================================
# I43 / R38-9: with the field empty, everything is byte-identical
# =====================================================================================

# sha256 of `to_jsonable` (sorted-key JSON) on `portfolio_baseline()`, measured on the
# code BEFORE P38-T03 (HEAD whatif.py / plan_import.py) and after: identical.
_PRE_P38_HASHES = {
    "analytic_add_remaining": "9b770885b59e552c509c3b310b0c0e0c6a62a11461eabcd8f40aa1b15ccafd43",
    "analytic_add_year": "f7fcb3ffb11f1050d96664d5fd44a7e9b2a8f8632fa335ba7cf7753f3e4d2283",
    "analytic_remove_remaining": "307783eb782b3626899f02485a0996b2e779947ad91bd8e21bb242d5d9fb5e72",
    "analytic_remove_year": "510a3ea433f1f784d532ec93dec0a69e9d94a384e35d706195206b273f252ea3",
    "plan_import_104": "18949e488865b1667d99e0693cad3a5159d71a29cf2bf85978bbfe9a0bc2929a",
    "plan_import_52": "9c6fa3bed306ab5bbad58ab3934e94feb16fd8d7853022761d37469c605daa41",
    "simulate_add": "5fcdccbff2f9c59239571db66f0b8794ac72cdf2fff81c86218cbc5b71b99e07",
    "simulate_remove": "6e0d20de8523ee0791eca2169c1fd8f74d203aeab44a7620c594cb4249b78abb",
}


def _h(x: object) -> str:
    return hashlib.sha256(json.dumps(to_jsonable(x), sort_keys=True).encode()).hexdigest()


def test_empty_field_is_byte_identical_to_pre_p38() -> None:
    b = portfolio_baseline()
    assert b.engineer_active_weeks == ()
    scens = {
        "add": Scenario(add_projects=(AddProject("PD-Romania", "B", count=3),)),
        "remove": Scenario(
            remove_engineer_counts=(RemoveEngineerCount("PD-Romania", 1),),
            add_engineers=(AddEngineer("R&D-India", 0.5),),
        ),
    }
    got: dict[str, str] = {}
    for k, sc in scens.items():
        for basis in ("year", "remaining"):
            got[f"analytic_{k}_{basis}"] = _h(analytic_requirements(b, sc, basis=basis))
        got[f"simulate_{k}"] = _h(simulate(b, sc))
    rows = tuple(
        ImportProject(
            key=f"r{i}",
            name=f"I{i}",
            hub=hub,
            category=cat,
            status="In Queue",
            priority="P2",
            rank=None,
            file_row=i + 1,
            leader=None,
            current_step_id=None,
            step_weeks=(),
        )
        for i, (hub, cat) in enumerate(
            [("PD-Romania", "B"), ("R&D-Greece", "A"), ("PD-India", "C"), ("OEM-HCK", "B-OEM")]
        )
    )
    for y in (52, 104):
        got[f"plan_import_{y}"] = _h(
            run_plan_import(b, PlanImportRequest(projects=rows, plan_year_end_week=y))
        )
    assert got == _PRE_P38_HASHES


def test_field_is_not_on_schedule_input() -> None:
    names = {f.name for f in dataclasses.fields(ScheduleInput)}
    assert "engineer_active_weeks" not in names
    base = romania(active_weeks=(elena_deactivated(),))
    plain = romania()
    assert canonical_schedule_input_asdict(base.schedule) == canonical_schedule_input_asdict(
        plain.schedule
    )


def test_no_period_figures_equal_the_capacity_page() -> None:
    base = romania(elena_in_roster=True)
    year, rem = capacity_page([f for _, f in OTHERS] + [ELENA[1]], [], 47)
    assert round(year, 2) == 253.00 and round(rem, 2) == 24.33
    assert _design_row(base, "year").capacity_before == round(year, 2)
    assert _design_row(base, "remaining").capacity_before == round(rem, 2)
    u = _util_row(base)
    assert (u.capacity_year, u.capacity_remaining) == (253.0, 24.33)


# =====================================================================================
# Deactivated engineer (open period): the ruling's PD-Romania case
# =====================================================================================


def test_deactivated_engineer_reproduces_the_ruling_figures() -> None:
    entry = elena_deactivated(47)
    base = romania(active_weeks=(entry,))  # the builder left Elena out of the input
    year, rem = capacity_page([f for _, f in OTHERS], [(ELENA[1], entry.covered_weeks)], 47)
    assert (round(year, 2), round(rem, 2)) == (248.77, 20.10)

    y_row, r_row = _design_row(base, "year"), _design_row(base, "remaining")
    assert y_row.capacity_before == 248.77 and r_row.capacity_before == 20.10
    # the FTE shown multiplies the per-engineer weeks on the basis
    assert y_row.fte_before == round(4.75 + 47 / 52, 2) and r_row.fte_before == 4.75
    u = _util_row(base)
    assert (u.capacity_year, u.capacity_remaining) == (248.77, 20.10)
    assert u.units == 4.75  # headcount FTE: active in week CW + 1


def test_without_the_field_an_inactive_engineer_vanishes_for_the_whole_year() -> None:
    # R38-2's divergence, which the field closes
    u = _util_row(romania())
    assert u.capacity_year == round(44 * 4.75, 2) != 248.77


def test_entry_for_an_engineer_still_in_the_roster_is_not_double_counted() -> None:
    entry = elena_deactivated(47)
    a = _util_row(romania(active_weeks=(entry,)))
    b = _util_row(romania(elena_in_roster=True, active_weeks=(entry,)))
    assert (a.capacity_year, a.capacity_remaining) == (b.capacity_year, b.capacity_remaining)


def test_field_changes_supply_only_never_outcomes() -> None:
    with_field = simulate(romania(active_weeks=(elena_deactivated(),)), ADD_ONE)
    without = simulate(romania(), ADD_ONE)
    assert with_field.projects == without.projects
    assert with_field.outcome_counts_after == without.outcome_counts_after
    si = romania(active_weeks=(elena_deactivated(),)).schedule
    assert run_greedy_sgs(si) == run_greedy_sgs(romania().schedule)


def test_plan_import_weekly_supply_is_zero_in_covered_weeks() -> None:
    entry = elena_deactivated(47)
    res, row = _hub_row(romania(active_weeks=(entry,)), pyew=104)
    weeks = res.capacity.weekly.weeks
    series = res.capacity.weekly.hubs[HUB].capacity
    full, less = round(5.75 * 44 / 52, 2), round(4.75 * 44 / 52, 2)
    assert weeks[0] == 47
    assert series[0] == full  # the deactivation week counts as worked
    assert all(x == less for x in series[1:])  # 48..52 and all of Y+1
    y0 = next(w for w in row.windows if w.key == "y0")
    assert y0.capacity_weeks == round(44 / 52 * (5.75 + 5 * 4.75), 2)
    y1 = next(w for w in row.windows if w.key == "y1")
    assert y1.capacity_weeks == round(44 * 4.75, 2)
    assert row.fte == 4.75


def test_plan_import_without_entries_keeps_a_flat_series() -> None:
    res, row = _hub_row(romania(elena_in_roster=True))
    assert set(res.capacity.weekly.hubs[HUB].capacity) == {round(5.75 * 44 / 52, 2)}
    assert row.fte == 5.75


# =====================================================================================
# Reactivated engineer: a closed gap
# =====================================================================================


def test_reactivation_gap_counts_only_the_covered_weeks() -> None:
    entry = elena_gap(10, 20)  # inactive 11..20, back from 21
    assert entry.covered_weeks == tuple(range(11, 21))
    base = romania(elena_in_roster=True, active_weeks=(entry,))
    year, rem = capacity_page([f for _, f in OTHERS], [(ELENA[1], entry.covered_weeks)], 47)
    assert round(year, 2) == round(44 * (4.75 + 42 / 52), 2)
    assert round(rem, 2) == 24.33  # active now: remaining unchanged
    u = _util_row(base)
    assert (u.capacity_year, u.capacity_remaining) == (round(year, 2), round(rem, 2))
    assert u.units == 5.75
    assert _design_row(base, "year").capacity_before == round(year, 2)


def test_reactivation_gap_under_a_lowered_pin_shows_in_the_weekly_series() -> None:
    # CW 31; inactive 41..45: the plan-import weekly series dips in those weeks
    entry = elena_gap(40, 45)
    base = romania(cw=31, elena_in_roster=True, active_weeks=(entry,))
    res, row = _hub_row(base)
    series = dict(
        zip(res.capacity.weekly.weeks, res.capacity.weekly.hubs[HUB].capacity, strict=True)
    )
    full, less = round(5.75 * 44 / 52, 2), round(4.75 * 44 / 52, 2)
    assert [w for w, x in series.items() if x == less] == list(range(41, 46))
    assert all(x == full for w, x in series.items() if not 41 <= w <= 45)
    # remaining (W32..W52) gets A_e = 21 - 5 = 16 of 21 weeks
    year, rem = capacity_page([f for _, f in OTHERS], [(ELENA[1], entry.covered_weeks)], 31)
    u = _util_row(base)
    assert (u.capacity_year, u.capacity_remaining) == (round(year, 2), round(rem, 2))
    # the reactivated designer's availability excludes the gap
    d = next(x for x in res.capacity.designers if x.ref == ELENA[0])
    y0 = next(w for w in d.windows if w.key == "y0")
    assert y0.available_weeks == round(44 / 52 * (52 - 31 + 1 - 5), 2)


def test_removing_a_reactivated_engineer_drops_their_entry_after() -> None:
    entry = elena_gap(10, 20)
    base = romania(elena_in_roster=True, active_weeks=(entry,))
    res = simulate(base, Scenario(remove_engineers=(ELENA[0],)))
    after = next(u for u in res.utilization_after if u.scope == "hub" and u.key == HUB)
    assert after.capacity_year == round(44 * 4.75, 2)
    req = analytic_requirements(base, Scenario(remove_engineers=(ELENA[0],)))
    row = next(r for r in req.design if r.hub == HUB)
    assert row.capacity_after_scenario == round(44 * 4.75, 2)
    assert row.capacity_before == round(44 * (4.75 + 42 / 52), 2)


def test_entry_for_a_non_counted_roster_engineer_supplies_nothing() -> None:
    nc = _eng("ro-nc", 1.0, counted=False)
    entry = EngineerActiveWeeks("ro-nc", HUB, 1.0, tuple(range(11, 21)))
    a = _util_row(romania(extra=(nc,), active_weeks=(entry,)))
    b = _util_row(romania(extra=(nc,)))
    assert (a.capacity_year, a.capacity_remaining) == (b.capacity_year, b.capacity_remaining)


def test_current_week_52_remaining_is_zero() -> None:
    base = romania(cw=52, active_weeks=(elena_deactivated(30),))
    u = _util_row(base)
    assert u.capacity_remaining == 0.0
    assert u.capacity_year == round(44 * (4.75 + 30 / 52), 2)


def test_deterministic() -> None:
    base = romania(active_weeks=(elena_deactivated(),))
    assert _h(simulate(base, ADD_ONE)) == _h(simulate(base, ADD_ONE))
    assert _h(run_plan_import(base, PlanImportRequest(projects=()))) == _h(
        run_plan_import(base, PlanImportRequest(projects=()))
    )
