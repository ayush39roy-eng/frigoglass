"""P18-R02: API-layer remediation after the P18 gate.

* D1 (I9): What-if "within the year" is the Dashboard's bucket
  (`within_year AND NOT blocked`), Commercialized projects included.
* D2: estimate "before" figures equal the Capacity surface (and simulate's
  `utilization_before`) to 2 dp, for everyone, including the shared-lab rule.
* D2b: headline totals cover only the hubs / lab regions the scenario touches.
* D3: the served `semantics` sentence explains `exact`.
* S18-M1: strict-model caps (422 INVALID_SCENARIO), engine deadline, 503
  WHATIF_TIMEOUT, per-user in-flight limit (429), chat tools under the same limit.
* S18-L1..L4: https-only base URL, no provider message in logs, provider
  garbage is 502, the DB transaction is released before the model call.
* Chat advisory: spelled-out numbers are flagged, "1,078" is one number.

Disposable Postgres only (the shared testcontainers fixture); no network.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from typing import Any

import httpx
import pytest

import api.routers.whatif as whatif_router
import scheduling.whatif as engine
import services.whatif as whatif_service
from core.config import GroqSettings, get_groq_settings
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    SolverType,
)
from models.hub import HubWorkCalendar
from scheduling.greedy import run_greedy_sgs
from schemas.whatif import ScenarioRequest
from services.llm_client import LlmProviderError, OpenAICompatibleClient
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from services.whatif import (
    _acquire_slot,
    _release_slot,
    in_flight_count,
    number_value,
    numbers_in,
    run_capped,
    spelled_numbers_in,
    within_year_bucket,
)
from services.whatif_baseline import load_context
from services.whatif_chat import SYSTEM_PROMPT_TEMPLATE, ungrounded_numbers
from tests.auth_helpers import make_principal
from tests.factories import make_chamber, make_engineer, make_hub, make_project
from tests.test_p18_whatif_api import (  # noqa: F401  (autouse cleanup fixture)
    _cleanup,
    act_as,
    add_c_projects,
    client_for,
    make_world,
    table_counts,
)
from tests.test_p18_whatif_chat import FakeLlm, call, calls, say, use
from tests.test_p18_whatif_chat import _cleanup as _chat_cleanup  # noqa: F401

ALL_CATS = [
    EngineerAllowedCategory.A_PLUS,
    EngineerAllowedCategory.A,
    EngineerAllowedCategory.B,
    EngineerAllowedCategory.C,
]


async def activate_greedy_run(db_session) -> None:
    """Persist the greedy schedule of the DB as the active run (what the
    Dashboard and Capacity read)."""

    si = await build_schedule_input_from_db(db_session)
    await persist_schedule_output(
        db_session,
        si,
        run_greedy_sgs(si),
        solver_type=SolverType.GREEDY,
        trigger_reason="p18-r02-test",
        activate=True,
    )
    await db_session.flush()


async def add_commercialized(db_session, world) -> None:
    """One Commercialized project per hub: outcome class `excluded`, but the
    Dashboard counts it as within the year."""

    for hub, eng in ((world.gr, world.eng_gr), (world.ind, world.eng_in)):
        await make_project(
            db_session, hub, leader=eng, name=f"Done {hub.name.value}",
            category=ProjectCategory.C, priority=ProjectPriority.P3,
            status=ProjectStatus.COMMERCIALIZED,
        )  # fmt: skip
    await db_session.flush()


async def dashboard_wy(c) -> int:
    resp = await c.get("/dashboard/completing-within-year")
    assert resp.status_code == 200, resp.text
    return resp.json()["within_year_count"]


# --- D1 ---------------------------------------------------------------------------------


def test_within_year_bucket_is_flag_and_not_blocked():
    assert within_year_bucket(True, "within_year")
    assert within_year_bucket(True, "excluded")  # Commercialized
    assert not within_year_bucket(False, "spillover")
    assert not within_year_bucket(True, "blocked")


@pytest.mark.parametrize("restricted", [False, True])
async def test_zero_scenario_within_year_equals_the_dashboard(db_session, restricted):
    world = await make_world(db_session)
    await add_commercialized(db_session, world)
    await activate_greedy_run(db_session)
    if restricted:
        await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    else:
        await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        dash = await dashboard_wy(c)
        sim = (await c.post("/whatif/simulate", json={"scenario": {}})).json()
    d = sim["diff"]
    assert d["within_year_before"] == d["within_year_after"] == dash
    assert d["within_year_delta"] == 0
    # The class count alone would have dropped the Commercialized project(s).
    class_wy = sim["outcome_counts_after"]["within_year"]
    assert dash == class_wy + (1 if restricted else 2)
    assert sim["outcome_counts_after"]["excluded"] == (1 if restricted else 2)
    assert f"{dash} -> {dash}" in sim["workings"][1]


async def test_zero_scenario_matches_the_dashboard_for_every_hub_scope(db_session):
    world = await make_world(db_session)
    await add_commercialized(db_session, world)
    await activate_greedy_run(db_session)
    for hub in (world.gr, world.ind):
        await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub.id])
        async with client_for(db_session) as c:
            dash = await dashboard_wy(c)
            sim = (await c.post("/whatif/simulate", json={"scenario": {}})).json()
        assert sim["diff"]["within_year_before"] == sim["diff"]["within_year_after"] == dash


async def test_added_projects_keep_the_commercialized_ones_in_before_and_after(db_session):
    world = await make_world(db_session)
    await add_commercialized(db_session, world)
    await activate_greedy_run(db_session)
    user = await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    principal = make_principal(
        RoleName.PORTFOLIO_MANAGER, user_id=user.id, email=user.email, hub_scope_all=True
    )
    scenario = add_c_projects("R&D-Greece", 3)
    async with client_for(db_session) as c:
        dash = await dashboard_wy(c)
        d = (await c.post("/whatif/simulate", json={"scenario": scenario})).json()["diff"]
    raw = engine.simulate(
        (await load_context(db_session, principal)).baseline,
        whatif_service.to_engine_scenario(ScenarioRequest(**scenario)),
    )
    assert d["within_year_before"] == dash == raw.diff.within_year_before
    assert d["within_year_after"] == raw.diff.within_year_after
    assert d["within_year_delta"] == raw.diff.within_year_delta
    assert d["existing_within_year_after"] == raw.diff.existing_within_year_after
    assert d["new_projects_within_year"] == raw.diff.new_projects_within_year


# --- D2 ---------------------------------------------------------------------------------


async def make_india_world(db_session):
    """R&D-India and PD-India share the India lab; the Hub Planner of PD-India
    must still see the region-wide lab figure, equal to Capacity's."""

    rd = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    pd = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    for hub in (rd, pd):
        db_session.add(
            HubWorkCalendar(
                hub_id=hub.id, weekdays_per_week=5, national_holiday_days=10,
                medical_leave_days=5, casual_leave_days=5, annual_leave_days=20,
            )
        )  # fmt: skip
    e_rd = await make_engineer(db_session, rd, name="Rd Person", allowed_categories=ALL_CATS)
    e_pd = await make_engineer(db_session, pd, name="Pd Person", allowed_categories=ALL_CATS)
    await make_chamber(
        db_session, code="CH-IN-A", lab_region=LabRegion.INDIA, allowed_stages=["PDD-F", "PDD-H"]
    )
    for hub, eng, n in ((rd, e_rd, 4), (pd, e_pd, 3)):
        for i in range(n):
            await make_project(
                db_session, hub, leader=eng, name=f"P {hub.name.value} {i}",
                category=ProjectCategory.C, priority=ProjectPriority.P3,
                status=ProjectStatus.IN_QUEUE,
            )  # fmt: skip
    await db_session.flush()
    return rd, pd


def _capacity_by_hub(summary: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {r["hub"]: r for r in summary["rows"]}


async def _assert_estimate_before_equals_capacity(c) -> tuple[dict, dict]:
    cap = (await c.get("/capacity/hub-load")).json()
    assert cap["has_active_schedule_run"] is True
    rows = _capacity_by_hub(cap)
    year = (await c.post("/whatif/estimate", json={"scenario": {}, "basis": "year"})).json()
    rem = (await c.post("/whatif/estimate", json={"scenario": {}, "basis": "remaining"})).json()
    sim = (await c.post("/whatif/simulate", json={"scenario": {}})).json()
    assert year["design"] and year["lab"]
    # ADR 0041 R12: the what-if "before" reconciles with the run-BOOKED load
    # (`*_load_booked_weeks`); the Capacity page's own booked % is on demand
    # (I19 rev.), so the expected figure is booked / capacity here.
    def _pct(load: float, cap: float) -> float | None:
        return None if cap == 0 else round(load / cap * 100, 2)

    for est, suffix in ((year, "year"), (rem, "remaining")):
        for d in est["design"]:
            row = rows[d["hub"]]
            assert d["booked_pct_before"] == pytest.approx(
                _pct(row["design_load_booked_weeks"], row[f"design_capacity_{suffix}"]),
                abs=0.005,
            ), (d["hub"], suffix)
            assert d["capacity_before"] == pytest.approx(
                rows[d["hub"]][f"design_capacity_{suffix}"], abs=0.005
            )
        for lab in est["lab"]:
            region_rows = [r for r in rows.values() if r["lab_region"] == lab["lab_region"]]
            assert region_rows
            for r in region_rows:
                assert lab["booked_pct_before"] == pytest.approx(
                    _pct(r["lab_load_booked_weeks"], r[f"lab_capacity_{suffix}"]), abs=0.005
                ), (lab["lab_region"], suffix)
                assert lab["baseline_load_weeks"] == pytest.approx(
                    r["lab_load_booked_weeks"], abs=0.005
                )
    # ... and simulate's utilization_before is the same single source.
    util = {(u["scope"], u["key"]): u for u in sim["utilization_before"]}
    for d in year["design"]:
        assert d["booked_pct_before"] == pytest.approx(
            util[("hub", d["hub"])]["booked_pct_year"], abs=0.005
        )
    for lab in year["lab"]:
        assert lab["booked_pct_before"] == pytest.approx(
            util[("lab_region", lab["lab_region"])]["booked_pct_year"], abs=0.005
        )
    return year, cap


async def test_estimate_before_equals_capacity_booked_pct(db_session):
    world = await make_world(db_session)
    await add_commercialized(db_session, world)
    await activate_greedy_run(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        year, _ = await _assert_estimate_before_equals_capacity(c)
    assert any((d["booked_pct_before"] or 0) > 0 for d in year["design"])
    assert any((r["booked_pct_before"] or 0) > 0 for r in year["lab"])


async def test_estimate_before_equals_capacity_for_a_hub_planner_and_shared_lab(db_session):
    rd, pd = await make_india_world(db_session)
    await activate_greedy_run(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        full_year, full_cap = await _assert_estimate_before_equals_capacity(c)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[pd.id])
    async with client_for(db_session) as c:
        part_year, part_cap = await _assert_estimate_before_equals_capacity(c)
    assert [d["hub"] for d in part_year["design"]] == ["PD-India"]
    assert [r["lab_region"] for r in part_year["lab"]] == ["India"]
    # Shared-lab rule: the planner's India lab row is the region-wide row (it
    # includes R&D-India's lab load), exactly the PM's and Capacity's.
    pm_lab = next(r for r in full_year["lab"] if r["lab_region"] == "India")
    assert part_year["lab"][0] == pm_lab
    cap_pd = next(r for r in part_cap["rows"] if r["hub"] == "PD-India")
    cap_full_pd = next(r for r in full_cap["rows"] if r["hub"] == "PD-India")
    assert cap_pd["lab_load_booked_weeks"] == cap_full_pd["lab_load_booked_weeks"] > 0


# --- D2b --------------------------------------------------------------------------------


async def overbooked_world(db_session):
    """make_world plus a lot of India work, so India has a real deficit that a
    Greece-only scenario must NOT report as its own."""

    world = await make_world(db_session)
    for i in range(14):
        await make_project(
            db_session, world.ind, leader=world.eng_in, name=f"Extra {i}",
            category=ProjectCategory.C, priority=ProjectPriority.P3,
            status=ProjectStatus.IN_QUEUE,
        )  # fmt: skip
    await db_session.flush()
    await activate_greedy_run(db_session)
    return world


async def test_zero_scenario_totals_are_zero_despite_a_real_deficit(db_session):
    world = await overbooked_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        est = (await c.post("/whatif/estimate", json={"scenario": {}})).json()
    india = next(r for r in est["design"] if r["hub"] == "PD-India")
    assert india["min_extra_designers"] > 0  # the row still shows the deficit ...
    assert est["touched_hubs"] == [] and est["touched_lab_regions"] == []
    assert est["extra_design_weeks_total"] == 0
    assert est["extra_lab_weeks_total"] == 0
    assert est["min_extra_designers_total"] == 0  # ... but it is not "needed" by nothing
    assert est["min_extra_chambers_total"] == 0
    assert world is not None


async def test_totals_cover_only_touched_hubs_and_regions(db_session):
    await overbooked_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        est = (
            await c.post("/whatif/estimate", json={"scenario": add_c_projects("R&D-Greece", 3)})
        ).json()
    assert est["touched_hubs"] == ["R&D-Greece"]
    assert est["touched_lab_regions"] == ["Greece"]
    gr = next(r for r in est["design"] if r["hub"] == "R&D-Greece")
    gr_lab = next(r for r in est["lab"] if r["lab_region"] == "Greece")
    assert est["min_extra_designers_total"] == gr["min_extra_designers"]
    assert est["min_extra_chambers_total"] == gr_lab["min_extra_chambers"]
    assert est["extra_design_weeks_total"] == gr["extra_design_weeks"] == 18
    india = next(r for r in est["design"] if r["hub"] == "PD-India")
    assert india["min_extra_designers"] > 0  # untouched deficit stays a row figure only
    assert {r["hub"] for r in est["design"]} == {"R&D-Greece", "PD-India"}


async def test_hub_planner_totals_come_from_visible_touched_rows(db_session):
    world = await overbooked_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        est = (
            await c.post("/whatif/estimate", json={"scenario": add_c_projects("R&D-Greece", 3)})
        ).json()
        zero = (await c.post("/whatif/estimate", json={"scenario": {}})).json()
    assert est["touched_hubs"] == ["R&D-Greece"] and est["touched_lab_regions"] == ["Greece"]
    gr = est["design"][0]
    assert est["min_extra_designers_total"] == gr["min_extra_designers"]
    assert est["extra_design_weeks_total"] == 18
    assert "India" not in str(est)
    assert zero["touched_hubs"] == [] and zero["min_extra_designers_total"] == 0


async def test_totals_from_touched_include_the_lab_region_of_a_touched_hub(db_session):
    await overbooked_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        est = (
            await c.post(
                "/whatif/estimate", json={"scenario": {"add_engineers": [{"hub": "PD-India"}]}}
            )
        ).json()
    assert est["touched_hubs"] == ["PD-India"] and est["touched_lab_regions"] == ["India"]


# --- D3 ---------------------------------------------------------------------------------


async def test_solve_semantics_explains_exact(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        sol = (
            await c.post("/whatif/solve", json={"scenario": add_c_projects("R&D-Greece", 2)})
        ).json()
    assert "exact: true only when every smaller combination" in sol["semantics"]
    assert "smallest found" in sol["semantics"]
    assert "never hurts" in sol["semantics"]


# --- S18-M1 -----------------------------------------------------------------------------

OVERSIZED = [
    ("projects", {"add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 120},
                                   {"hub": "PD-India", "category": "C", "count": 81}]}),
    ("designers", {"add_engineers": [{"hub": "R&D-Greece", "count": 30},
                                     {"hub": "PD-India", "count": 21}]}),
    ("removed", {"remove_engineer_counts": [{"hub": "R&D-Greece", "count": 30},
                                            {"hub": "PD-India", "count": 21}]}),
    ("removed-ids", {"remove_engineer_counts": [{"hub": "R&D-Greece", "count": 50}],
                     "remove_engineers": ["a"]}),
    ("chambers", {"add_chambers": [{"lab_region": "Greece", "count": 11},
                                   {"lab_region": "India", "count": 10}]}),
]  # fmt: skip


@pytest.mark.parametrize("path", ["estimate", "simulate", "solve"])
@pytest.mark.parametrize("name,scenario", OVERSIZED, ids=[o[0] for o in OVERSIZED])
async def test_oversized_scenario_is_422_invalid_scenario_before_anything_loads(
    db_session, monkeypatch, path, name, scenario
):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)

    async def boom(*a: Any, **k: Any):
        raise AssertionError("the baseline must not be loaded for an oversized scenario")

    monkeypatch.setattr(whatif_router, "load_context", boom)
    async with client_for(db_session) as c:
        resp = await c.post(f"/whatif/{path}", json={"scenario": scenario})
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "INVALID_SCENARIO"
    assert "at most" in str(resp.json()["detail"])


@pytest.mark.parametrize(
    "scenario",
    [
        {"add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 201}]},
        {"add_engineers": [{"hub": "R&D-Greece", "count": 51}]},
        {"remove_engineer_counts": [{"hub": "R&D-Greece", "count": 51}]},
        {"add_chambers": [{"lab_region": "Greece", "count": 21}]},
    ],
)
async def test_per_line_limits_are_422(db_session, scenario):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        assert (await c.post("/whatif/simulate", json={"scenario": scenario})).status_code == 422


async def test_scenario_exactly_at_the_caps_is_accepted(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    scenario = {
        "add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 200}],
        "add_engineers": [{"hub": "R&D-Greece", "count": 50}],
        "add_chambers": [{"lab_region": "Greece", "count": 20}],
    }
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/estimate", json={"scenario": scenario})
    assert resp.status_code == 200, resp.text


async def test_chat_scenario_has_the_same_caps_so_a_tool_call_is_refused(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    lines = [
        {"hub": "R&D-Greece", "category": "C", "count": 150},
        {"hub": "PD-India", "category": "C", "count": 100},
    ]
    big = {"scenario": {"add_projects": lines}}
    fake = FakeLlm(calls(call("simulate_scenario", big)), say("Cannot do that."))
    use(fake)
    before = await table_counts(db_session)
    async with client_for(db_session) as c:
        body = (await c.post("/whatif/ask", json={"question": "what if?"})).json()
    assert body["results"][0]["error"] and "at most" in body["results"][0]["error"]
    assert body["results"][0]["result"] is None
    assert await table_counts(db_session) == before


async def test_deadlines_are_passed_to_the_engine(db_session, monkeypatch):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    seen: dict[str, Any] = {}
    real = {
        "analytic_requirements": whatif_service.analytic_requirements,
        "simulate": whatif_service.simulate,
        "solve_minimum_additions": whatif_service.solve_minimum_additions,
    }

    def spy(name: str):
        def inner(*a: Any, **k: Any):
            seen[name] = k.get("deadline_s")
            return real[name](*a, **k)

        return inner

    for name in real:
        monkeypatch.setattr(whatif_service, name, spy(name))
    async with client_for(db_session) as c:
        for path in ("estimate", "simulate", "solve"):
            assert (await c.post(f"/whatif/{path}", json={"scenario": {}})).status_code == 200
    assert seen == {
        "analytic_requirements": 18.0,
        "simulate": 18.0,
        "solve_minimum_additions": 38.0,
    }
    assert whatif_service.WHATIF_DEADLINE_SECONDS < whatif_service.WHATIF_TIME_CAP_SECONDS
    assert (
        whatif_service.WHATIF_SOLVE_DEADLINE_SECONDS < whatif_service.WHATIF_SOLVE_TIME_CAP_SECONDS
    )


@pytest.mark.parametrize(
    "path,attr",
    [("estimate", "analytic_requirements"), ("simulate", "simulate"),
     ("solve", "solve_minimum_additions")],
)  # fmt: skip
async def test_engine_budget_exceeded_is_503_whatif_timeout(db_session, monkeypatch, path, attr):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)

    def expire(*a: Any, **k: Any):
        raise engine.WhatIfBudgetExceeded("deadline")

    monkeypatch.setattr(whatif_service, attr, expire)
    async with client_for(db_session) as c:
        resp = await c.post(f"/whatif/{path}", json={"scenario": {}})
    assert resp.status_code == 503
    assert resp.json()["code"] == "WHATIF_TIMEOUT"
    assert resp.json()["detail"]


async def test_second_heavy_job_of_the_same_user_is_429_until_the_first_ends(
    db_session, monkeypatch
):
    await make_world(db_session)
    user = await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    started, release = threading.Event(), threading.Event()
    real = whatif_service.simulate

    def slow(*a: Any, **k: Any):
        started.set()
        assert release.wait(10)
        return real(*a, **k)

    monkeypatch.setattr(whatif_service, "simulate", slow)
    async with client_for(db_session) as c:
        first = asyncio.create_task(c.post("/whatif/simulate", json={"scenario": {}}))
        assert await asyncio.to_thread(started.wait, 10)
        assert in_flight_count(str(user.id)) == 1
        # Every heavy endpoint of the same user is refused meanwhile.
        for path in ("estimate", "simulate", "solve"):
            resp = await c.post(f"/whatif/{path}", json={"scenario": {}})
            assert resp.status_code == 429, path
            assert resp.headers["Retry-After"] == "2"
        release.set()
        assert (await first).status_code == 200
        assert in_flight_count(str(user.id)) == 0
        monkeypatch.setattr(whatif_service, "simulate", real)
        assert (await c.post("/whatif/simulate", json={"scenario": {}})).status_code == 200


async def test_the_slot_is_held_until_the_thread_ends_even_after_a_503(db_session, monkeypatch):
    await make_world(db_session)
    user = await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    real = whatif_service.simulate

    def slow(*a: Any, **k: Any):
        time.sleep(0.6)
        return real(*a, **k)

    monkeypatch.setattr(whatif_service, "simulate", slow)
    monkeypatch.setattr(whatif_service, "WHATIF_TIME_CAP_SECONDS", 0.05)
    async with client_for(db_session) as c:
        assert (await c.post("/whatif/simulate", json={"scenario": {}})).status_code == 503
        # the request gave up but the thread still runs: still one in flight
        assert in_flight_count(str(user.id)) == 1
        assert (await c.post("/whatif/simulate", json={"scenario": {}})).status_code == 429
        for _ in range(100):
            if in_flight_count(str(user.id)) == 0:
                break
            await asyncio.sleep(0.05)
        assert in_flight_count(str(user.id)) == 0


async def test_in_flight_limit_is_per_user():
    started, release = threading.Event(), threading.Event()

    def blocker() -> str:
        started.set()
        release.wait(10)
        return "a"

    task = asyncio.create_task(run_capped(blocker, 10, user_key="user-a"))
    assert await asyncio.to_thread(started.wait, 10)
    with pytest.raises(Exception) as exc_a:  # noqa: PT011
        await run_capped(lambda: "x", 5, user_key="user-a")
    assert getattr(exc_a.value, "status_code", None) == 429
    assert await run_capped(lambda: "b", 5, user_key="user-b") == "b"  # another user is fine
    release.set()
    assert await task == "a"
    assert in_flight_count("user-a") == 0
    assert await run_capped(lambda: "again", 5, user_key="user-a") == "again"


async def test_chat_tool_calls_share_the_in_flight_limit(db_session):
    await make_world(db_session)
    user = await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    args = {"scenario": {"add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 2}]}}
    fake = FakeLlm(calls(call("simulate_scenario", args)), say("Please try again shortly."))
    use(fake)
    assert _acquire_slot(str(user.id))  # a form run of the same user is in flight
    try:
        async with client_for(db_session) as c:
            resp = await c.post("/whatif/ask", json={"question": "what if we add 2?"})
    finally:
        _release_slot(str(user.id))
    assert resp.status_code == 200, resp.text
    run = resp.json()["results"][0]
    assert run["result"] is None and "still running" in run["error"]


# --- S18-L1 -----------------------------------------------------------------------------


def settings_with(monkeypatch, url: str, insecure: str | None = None) -> GroqSettings:
    monkeypatch.setenv("RPD_GROQ_BASE_URL", url)
    if insecure is None:
        monkeypatch.delenv("RPD_GROQ_ALLOW_INSECURE_BASE_URL", raising=False)
    else:
        monkeypatch.setenv("RPD_GROQ_ALLOW_INSECURE_BASE_URL", insecure)
    return GroqSettings()


@pytest.mark.parametrize(
    "url",
    ["https://api.groq.com/openai/v1", "https://llm.example.com/v1/", "https://10.0.0.5/v1"],
)
def test_https_is_always_accepted(monkeypatch, url):
    assert settings_with(monkeypatch, url).base_url.startswith("https://")


@pytest.mark.parametrize(
    "url",
    ["http://api.groq.com/openai/v1", "http://localhost:8000/v1", "http://10.0.0.5:8000/v1",
     "http://llm:8000/v1", "http://8.8.8.8/v1", "http://llm.example.com/v1",
     "http://10.0.0.5.evil.com/v1"],
)  # fmt: skip
def test_http_is_rejected_without_the_opt_in(monkeypatch, url):
    with pytest.raises(ValueError, match="must be https"):
        settings_with(monkeypatch, url)
    with pytest.raises(ValueError, match="must be https"):
        settings_with(monkeypatch, url, "false")


@pytest.mark.parametrize(
    "url",
    ["http://localhost:8000/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1",
     "http://10.0.0.5:8000/v1", "http://192.168.1.20/v1", "http://172.16.4.2/v1",
     "http://vllm:8000/v1", "http://ollama.localhost/v1"],
)  # fmt: skip
def test_http_is_accepted_for_loopback_or_private_hosts_with_the_opt_in(monkeypatch, url):
    assert settings_with(monkeypatch, url, "true").base_url.startswith("http://")


@pytest.mark.parametrize(
    "url",
    ["http://api.groq.com/openai/v1", "http://8.8.8.8/v1", "http://llm.example.com/v1",
     "http://10.0.0.5.evil.com/v1"],
)  # fmt: skip
def test_the_opt_in_never_allows_a_public_host(monkeypatch, url):
    with pytest.raises(ValueError, match="must be https"):
        settings_with(monkeypatch, url, "true")


def test_non_http_scheme_is_still_rejected(monkeypatch):
    with pytest.raises(ValueError, match="http"):
        settings_with(monkeypatch, "ftp://x/v1", "true")


# --- S18-L2 / L3 ------------------------------------------------------------------------

KEY = "gsk_SECRETSECRETSECRET123"


def mock_provider(monkeypatch, handler) -> None:
    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **k: real(transport=httpx.MockTransport(handler), **k)
    )


def client() -> OpenAICompatibleClient:
    return OpenAICompatibleClient(base_url="https://llm.example/v1", api_key=KEY, model="m")


async def test_provider_error_message_and_key_are_never_logged(monkeypatch, caplog):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={"error": {
                "message": f"Invalid API Key {KEY[:12]}... and customer Acme Corp asked 1234",
                "type": f"invalid_request_error_{KEY}",
                "code": "invalid_api_key",
            }},
        )  # fmt: skip

    mock_provider(monkeypatch, handler)
    with caplog.at_level(logging.DEBUG), pytest.raises(httpx.HTTPStatusError):
        await client().chat([{"role": "user", "content": "SECRET QUESTION"}], None, max_tokens=5)
    text = "\n".join(r.getMessage() + str(r.exc_info) for r in caplog.records)
    assert "status=401" in text and "code=invalid_api_key" in text
    assert KEY not in text and KEY[:8] not in text
    assert "Acme" not in text and "Invalid API Key" not in text and "SECRET QUESTION" not in text
    assert "[redacted]" in text


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, text="<html>gateway</html>"),
        httpx.Response(200, json={"unexpected": True}),
        httpx.Response(200, json={"choices": []}),
        httpx.Response(200, json={"choices": [{"nothing": 1}]}),
        httpx.Response(200, json={"choices": [{"message": {"tool_calls": "oops"}}]}),
        httpx.Response(200, json=["not", "an", "object"]),
        httpx.Response(200, json={"choices": [{"message": {"tool_calls": [{"function": None}]}}]}),
    ],
)
async def test_non_json_or_wrong_shape_200_is_a_provider_error(monkeypatch, response):
    mock_provider(monkeypatch, lambda request: response)
    with pytest.raises(LlmProviderError):
        await client().chat([{"role": "user", "content": "q"}], None, max_tokens=5)
    assert issubclass(LlmProviderError, httpx.HTTPError)  # the router's 502 path


async def test_ask_maps_a_garbage_200_to_502(db_session, monkeypatch):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    mock_provider(monkeypatch, lambda request: httpx.Response(200, text="not json"))
    monkeypatch.setenv("RPD_GROQ_API_KEY", KEY)
    monkeypatch.delenv("RPD_GROQ_BASE_URL", raising=False)
    get_groq_settings.cache_clear()
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/ask", json={"question": "what if?"})
    assert resp.status_code == 502
    assert KEY not in resp.text and "not json" not in resp.text


# --- S18-L4 -----------------------------------------------------------------------------


class SessionProbeLlm(FakeLlm):
    """Records whether the DB session had an open transaction at every model call."""

    def __init__(self, session, *steps):
        super().__init__(*steps)
        self.session = session
        self.in_txn: list[bool] = []

    async def chat(self, messages, tools, *, max_tokens):
        self.in_txn.append(self.session.in_transaction())
        return await super().chat(messages, tools, max_tokens=max_tokens)


async def test_no_db_transaction_is_open_during_any_model_call(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    args = {"scenario": {"add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 2}]}}
    fake = SessionProbeLlm(
        db_session,
        calls(call("get_capacity_snapshot", {}, "c1")),  # a tool that reads the DB
        calls(call("simulate_scenario", args, "c2")),
        say("Done."),
    )
    use(fake)
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/ask", json={"question": "what if we add 2 projects?"})
    assert resp.status_code == 200, resp.text
    assert len(fake.in_txn) == 3
    assert fake.in_txn == [False, False, False]
    # and the audit row is still written afterwards
    assert len(resp.json()["results"]) == 2


# --- chat advisory ----------------------------------------------------------------------


def test_thousands_separator_is_one_number():
    assert numbers_in("load 1,078 weeks, 1,234,567.5 and 12,34") == [
        "1,078",
        "1,234,567.5",
        "12",
        "34",
    ]
    assert number_value("1,078") == 1078.0
    assert ungrounded_numbers("Load is 1,078 weeks.", {1078.0}) == []
    assert ungrounded_numbers("Load is 1,079 weeks.", {1078.0}) == ["1,079"]
    # not split into 1 and 078
    assert ungrounded_numbers("Load is 1,078 weeks.", {1.0, 78.0}) == ["1,078"]


@pytest.mark.parametrize(
    "text,expected",
    [
        ("You need twelve more designers.", ["twelve"]),
        ("Twenty-five projects slip.", ["Twenty-five"]),
        ("about two hundred weeks", ["two", "hundred"]),
        ("a thirteenfold increase", ["thirteenfold"]),
        ("by the dozen", ["dozen"]),
        ("hundreds of weeks", ["hundreds"]),
        ("No one is affected; tenth, someone, often and tone are not numbers.", []),
        ("Nothing spelled here: 12 designers.", []),
    ],
)
def test_spelled_out_numbers_are_detected(text, expected):
    assert spelled_numbers_in(text) == expected


def test_guard_flags_number_words_unless_the_user_typed_them():
    assert ungrounded_numbers("Add twelve designers (12).", {12.0}) == ["twelve"]
    assert ungrounded_numbers("Add 12 designers.", {12.0}) == []
    assert ungrounded_numbers("Add twelve designers.", set(), quoted="what if twelve more") == []
    # digits first (numeric order), then words
    assert ungrounded_numbers("seven of 99 and 5", {5.0}) == ["99", "seven"]


def test_system_prompt_forbids_number_words():
    text = SYSTEM_PROMPT_TEMPLATE
    assert "Never spell a number as a word" in text and "digits" in text


async def test_a_spelled_out_number_gets_one_retry_then_the_fixed_notice(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    args = {"scenario": {"add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 2}]}}
    fake = FakeLlm(
        calls(call("simulate_scenario", args)),
        say("Two projects are added and twelve designers are needed."),
        say("Still twelve."),
    )
    use(fake)
    async with client_for(db_session) as c:
        body = (await c.post("/whatif/ask", json={"question": "add projects"})).json()
    assert body["grounded"] is False
    assert "twelve" in body["ungrounded_numbers"]
    retry = fake.calls[2]["messages"][-1]["content"]
    assert "spelled as words" in retry and "twelve" in retry


async def test_an_answer_quoting_the_results_stays_grounded(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    args = {"scenario": {"add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 2}]}}

    def answer(messages: list[dict[str, Any]]):
        view = json.loads([m for m in messages if m["role"] == "tool"][-1]["content"])
        return say(f"{view['within_year_after']} projects finish within the year.")

    fake = FakeLlm(calls(call("simulate_scenario", args)), answer)
    use(fake)
    async with client_for(db_session) as c:
        body = (await c.post("/whatif/ask", json={"question": "what if we add 2 projects?"})).json()
    assert body["grounded"] is True
