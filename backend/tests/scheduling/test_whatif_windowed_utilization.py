"""BUG-2 (2026-11-23): What-if utilization counts only the load inside its window.

P53 schedules P1-P3 to completion over an open multi-year horizon. The "Booked,
full year" figure divides the plan-year load by the plan-year capacity and
"Booked, remaining weeks" the load of weeks cw+1 .. plan-year end by the
remaining capacity (52 - week_of_year(cw) weeks). A step that crosses a window
edge books its effort pro rata per calendar week of its span.
"""

from __future__ import annotations

from collections import defaultdict
from fractions import Fraction

import domain_constants as dc
from scheduling import ProjectInput, run_greedy_sgs
from scheduling.weeks import plan_year_end_week, plan_year_start_week
from scheduling.whatif import (
    AddProject,
    Scenario,
    UtilizationRow,
    build_scenario_input,
    simulate,
    window_share,
)
from tests.scheduling._whatif_fixtures import CURRENT_WEEK, portfolio_baseline, tiny_baseline


def _row(rows: tuple[UtilizationRow, ...], scope: str, key: str) -> UtilizationRow:
    return next(u for u in rows if u.scope == scope and u.key == key)


def test_window_share_splits_a_step_pro_rata() -> None:
    # 6 effort weeks over W50..W55: 3 in 2026 (W50-W52), 3 in 2027.
    assert window_share(50, 55, 6, 1, 52) == 3
    assert window_share(50, 55, 6, 53, 104) == 3
    # A design step stretched by FTE (4 effort weeks over 8 calendar weeks).
    assert window_share(49, 56, 4, 1, 52) == 2
    assert window_share(40, 45, 6, 1, 52) == 6  # wholly inside
    assert window_share(60, 65, 6, 1, 52) == 0  # wholly outside
    assert window_share(10, 10, 0, 1, 52) == 0  # skipped / zero effort
    assert window_share(10, 20, 5, 30, 20) == 0  # empty window


def test_step_crossing_the_year_end_is_split() -> None:
    """One PDD/A at CW 31: design W31..W67 (18 effort weeks), only W31..W46 in
    2026 (1 + 4 + 1 + 6 = 12); lab PDD-F W47..W50 (4) in 2026, PDD-H W53..W58
    (6) in 2027."""

    p = ProjectInput("x1", "X", "R&D-Greece", "In Development", "A", "P2", False, "e0")
    base = tiny_baseline(projects=(p,))
    res = simulate(base, Scenario())
    d = _row(res.utilization_before, "hub", "R&D-Greece")
    assert d.load_weeks == 12.0  # was 18 (every design step of the run)
    assert d.load_remaining_weeks == 11.0  # W32..W52: PDD-A at W31 is past
    assert d.booked_pct_remaining == round(11.0 / d.capacity_remaining * 100, 2)
    lab = _row(res.utilization_before, "lab_region", "Greece")
    per = dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK
    assert lab.load_weeks == round(4 * per, 2)  # was 10 x per

    # A lab step straddling the year end books per week on each side.
    out = run_greedy_sgs(base.schedule)
    h = next(s for s in out.project_outcomes[0].steps if s.step_id == "PDD-H")
    assert (h.start_week, h.end_week) == (53, 58)
    assert window_share(48, 53, 6, 1, 52) == 5


def test_multi_year_scenario_books_only_its_share_of_the_year() -> None:
    """+5 R&D-India A P1 on the portfolio pushes work into 2027+. Booked %
    covers only the work inside each window, never the whole open horizon."""

    base = portfolio_baseline()
    sc = Scenario(add_projects=(AddProject("R&D-India", "A", count=5, priority="P1"),))
    res = simulate(base, sc)
    inp = build_scenario_input(base, sc)
    out = run_greedy_sgs(inp)
    cw = inp.current_week
    assert cw == CURRENT_WEEK
    year = (plan_year_start_week(cw), plan_year_end_week(cw))
    rem = (cw + 1, plan_year_end_week(cw))

    proj = {p.project_id: p for p in inp.projects}
    total: dict[str, Fraction] = defaultdict(Fraction)
    in_year: dict[str, Fraction] = defaultdict(Fraction)
    in_rem: dict[str, Fraction] = defaultdict(Fraction)
    beyond = False
    for o in out.project_outcomes:
        p = proj[o.project_id]
        if p.hub not in dc.HUB_LAB_REGION:
            continue
        for st in o.steps:
            if st.skipped or st.kind != "design":
                continue
            total[p.capacity_hub] += st.duration_weeks
            in_year[p.capacity_hub] += window_share(
                st.start_week, st.end_week, st.duration_weeks, *year
            )
            in_rem[p.capacity_hub] += window_share(
                st.start_week, st.end_week, st.duration_weeks, *rem
            )
            beyond = beyond or st.end_week > year[1]
    assert beyond, "the scenario must book work past the plan year"

    some_less = False
    for u in res.utilization_after:
        if u.scope != "hub":
            continue
        assert u.load_weeks == round(float(in_year[u.key]), 2)
        assert u.load_remaining_weeks == round(float(in_rem[u.key]), 2)
        assert u.load_remaining_weeks <= u.load_weeks <= float(total[u.key])
        some_less = some_less or u.load_weeks < float(total[u.key])
        if u.capacity_year > 0:
            assert u.booked_pct_year == round(u.load_weeks / u.capacity_year * 100, 2)
        if u.capacity_remaining > 0:
            assert u.booked_pct_remaining == round(
                u.load_remaining_weeks / u.capacity_remaining * 100, 2
            )
    assert some_less
