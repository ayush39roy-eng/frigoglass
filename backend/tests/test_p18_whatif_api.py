"""P18-T02: the What-if scenario API (`/whatif/estimate|simulate|solve`).

Disposable Postgres only (the shared testcontainers fixture). Covered: the
role matrix, hub scoping of what is RETURNED (the simulation itself runs on
the whole plan), 422 on bad scenarios, the pure-read proof (row counts), the
time cap, the per-user rate limit, the coalesced audit row, the OQ #47
unattainable semantics, and the OpenAPI shape.
"""

from __future__ import annotations

import json
import time
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

import api.routers.whatif as whatif_router
import domain_constants as dc
import services.whatif as whatif_service
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.engineer import Engineer
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
)
from models.hub import Hub, HubWorkCalendar
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from services.rate_limit import TokenBucketLimiter
from services.whatif_baseline import load_context
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_chamber, make_engineer, make_hub, make_project, make_user

SECRET_CUSTOMER = "Pepsi Secret Customer"
SECRET_TCOGS = 123456.78
GR_ENGINEER = "Zed Secretperson"
IN_ENGINEER = "Ivan Hiddenname"


@pytest.fixture(autouse=True)
def _cleanup():
    for lim in (
        whatif_router.WHATIF_RATE_LIMIT,
        whatif_router.WHATIF_SOLVE_RATE_LIMIT,
        whatif_router.WHATIF_ASK_RATE_LIMIT,
    ):
        lim.reset()
    yield
    for lim in (
        whatif_router.WHATIF_RATE_LIMIT,
        whatif_router.WHATIF_SOLVE_RATE_LIMIT,
        whatif_router.WHATIF_ASK_RATE_LIMIT,
    ):
        lim.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def client_for(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def act_as(db_session, *roles: RoleName, hub_ids=None):
    scope_all = hub_ids is None
    user = await make_user(db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=scope_all)
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=scope_all,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def make_world(db_session) -> SimpleNamespace:
    """Two hubs in two lab regions, one leader and one chamber each, three
    category-C projects per hub. Names, a customer and a cost are planted so a
    leak is detectable."""

    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    ind = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    for hub in (gr, ind):
        db_session.add(
            HubWorkCalendar(
                hub_id=hub.id,
                weekdays_per_week=5,
                national_holiday_days=10,
                medical_leave_days=5,
                casual_leave_days=5,
                annual_leave_days=20,
            )
        )
    cats = [EngineerAllowedCategory.A_PLUS, EngineerAllowedCategory.A, EngineerAllowedCategory.B,
            EngineerAllowedCategory.C]  # fmt: skip
    eng_gr = await make_engineer(db_session, gr, name=GR_ENGINEER, allowed_categories=cats)
    eng_in = await make_engineer(db_session, ind, name=IN_ENGINEER, allowed_categories=cats)
    ch_gr = await make_chamber(
        db_session, code="CH-GR-1", lab_region=LabRegion.GREECE, max_concurrent=2,
        allowed_stages=["PDD-F", "PDD-H"],
    )  # fmt: skip
    ch_in = await make_chamber(
        db_session, code="CH-IN-1", lab_region=LabRegion.INDIA, max_concurrent=2,
        allowed_stages=["PDD-F", "PDD-H"],
    )  # fmt: skip
    projects: dict[str, list[Project]] = {"gr": [], "in": []}
    for key, hub, eng in (("gr", gr, eng_gr), ("in", ind, eng_in)):
        for i, prio in enumerate((ProjectPriority.P1, ProjectPriority.P2, ProjectPriority.P3)):
            projects[key].append(
                await make_project(
                    db_session, hub, leader=eng, name=f"Secret {key} Project {i}",
                    category=ProjectCategory.C, priority=prio, status=ProjectStatus.IN_QUEUE,
                    customer_name=SECRET_CUSTOMER, tcogs_eur=SECRET_TCOGS,
                )
            )  # fmt: skip
    await db_session.flush()
    return SimpleNamespace(
        gr=gr, ind=ind, eng_gr=eng_gr, eng_in=eng_in, ch_gr=ch_gr, ch_in=ch_in, projects=projects
    )


def add_c_projects(hub: str, n: int, category: str = "C") -> dict[str, Any]:
    return {"add_projects": [{"hub": hub, "category": category, "count": n}]}


async def table_counts(db_session) -> dict[str, int]:
    counts = {}
    for model in (
        Project, Engineer, Chamber, Hub, HubWorkCalendar, ScheduleRun,
        ScheduleRunProjectStep, ScheduleRunProjectOutcome, ProjectWorkflowStep,
    ):  # fmt: skip
        counts[model.__tablename__] = (
            await db_session.execute(select(func.count()).select_from(model))
        ).scalar_one()
    return counts


async def whatif_audit_rows(db_session) -> list[AuditLogEntry]:
    return list(
        (
            await db_session.execute(
                select(AuditLogEntry).where(AuditLogEntry.action.like("whatif.%"))
            )
        )
        .scalars()
        .all()
    )


# --- role matrix ---


ENDPOINTS = (
    ("/whatif/estimate", {"scenario": {}}),
    ("/whatif/simulate", {"scenario": {}}),
    ("/whatif/solve", {"scenario": {}}),
)


@pytest.mark.parametrize(
    "role,allowed",
    [
        (RoleName.PORTFOLIO_MANAGER, True),
        (RoleName.HUB_PLANNER, True),
        (RoleName.ADMIN, True),
        (RoleName.SUPER_ADMIN, True),
        (RoleName.EXECUTIVE_VIEWER, False),
        (RoleName.ENGINEER, False),
        (RoleName.AUDITOR, False),
    ],
)
async def test_role_matrix(db_session, role, allowed):
    world = await make_world(db_session)
    hub_ids = [world.gr.id] if role == RoleName.HUB_PLANNER else None
    await act_as(db_session, role, hub_ids=hub_ids)
    async with client_for(db_session) as c:
        for path, body in ENDPOINTS:
            resp = await c.post(path, json=body)
            assert resp.status_code == (200 if allowed else 403), (path, resp.text)
        resp = await c.post("/whatif/ask", json={"question": "hello"})
        # Without a configured key an allowed role gets 503; a denied role is 403 first.
        assert resp.status_code == (503 if allowed else 403)


async def test_unauthenticated_is_401(db_session):
    await make_world(db_session)
    async with client_for(db_session) as c:
        for path, body in ENDPOINTS:
            assert (await c.post(path, json=body)).status_code == 401


# --- estimate: hand-worked numbers ---


async def test_estimate_hand_worked_numbers(db_session):
    """PDD / C is 6 design weeks and 1 lab week (DOMAIN_RULES lead-time table:
    A 1 + D 1 + E 2 + J 1 + K 1 = 6 design; H 1 = lab). Two projects add 12
    design weeks and 2.0 lab weeks."""

    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/estimate", json={"scenario": add_c_projects("R&D-Greece", 2)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "estimate"
    assert body["extra_design_weeks_total"] == 12
    assert body["extra_lab_weeks_total"] == 2.0
    row = next(r for r in body["design"] if r["hub"] == "R&D-Greece")
    assert row["added_projects"] == 2 and row["extra_design_weeks"] == 12
    assert row["new_load_weeks"] == row["baseline_load_weeks"] + 12
    assert row["fte_before"] == 1.0
    # 52 - (10+5+5+20)/5 = 44 working weeks, one FTE -> capacity 44.
    assert row["working_weeks_per_engineer"] == 44.0 and row["capacity_before"] == 44.0
    # Baseline: 3 C projects x 6 = 18 weeks; with 2 more 30 weeks: 68.18 %.
    assert row["baseline_load_weeks"] == 18.0 and row["new_load_weeks"] == 30.0
    assert row["booked_pct_after"] == 68.18 and row["status_after"] == "available"
    assert body["workings"] and body["scope"]["all_hubs"] is True


async def test_estimate_remaining_basis_and_designer_fte(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.post(
            "/whatif/estimate",
            json={
                "scenario": add_c_projects("R&D-Greece", 30),
                "basis": "remaining",
                "designer_fte": 0.5,
            },
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["basis"] == "remaining"
    row = next(r for r in body["design"] if r["hub"] == "R&D-Greece")
    assert row["designer_fte"] == 0.5 and row["min_extra_designers"] >= 1
    assert row["min_extra_fte"] == row["min_extra_designers"] * 0.5


# --- simulate ---


async def test_simulate_adds_projects_and_matches_the_engine(db_session):
    from scheduling.whatif import AddProject, Scenario, simulate

    world = await make_world(db_session)
    user = await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/simulate", json={"scenario": add_c_projects("R&D-Greece", 3)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "simulation"
    assert body["diff"]["new_projects_total"] == 3
    assert len(body["new_project_ids"]) == 3
    assert body["greedy_runs"] == 2 and body["workings"]
    assert sum(body["outcome_counts_after"].values()) == 6 + 3
    assert sum(body["outcome_counts_before"].values()) == 6
    # The wire figures are the pure engine's own, derived from the whole plan.
    ctx = await load_context(db_session, make_principal(RoleName.PORTFOLIO_MANAGER))
    raw = simulate(
        ctx.baseline, Scenario(add_projects=(AddProject(hub="R&D-Greece", category="C", count=3),))
    )
    assert body["outcome_counts_after"] == dict(raw.outcome_counts_after)
    assert body["outcome_counts_before"] == dict(raw.outcome_counts_before)
    assert body["diff"]["within_year_after"] == raw.diff.within_year_after
    assert body["diff"]["within_year_before"] == raw.diff.within_year_before
    assert body["diff"]["existing_within_year_after"] == raw.diff.existing_within_year_after
    assert [p["project_id"] for p in body["projects"]] == [p.project_id for p in raw.projects]
    # P29-T06 (ADR 0042): the service serves capacity-hub rows only; the engine
    # still emits a (zero) row per member hub, which is dropped.
    assert body["utilization_after"] == [
        {k: getattr(u, k) for k in body["utilization_after"][0]}
        for u in raw.utilization_after
        if not (u.scope == "hub" and u.key in dc.HUB_CAPACITY_HUB)
    ]
    assert user is not None and world is not None


async def test_simulate_priority_override_and_downtime(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    scenario = {
        "priority_overrides": [{"project_id": str(world.projects["gr"][2].id), "priority": "P1"}],
        "chamber_downtime": [{"chamber_id": str(world.ch_gr.id), "maintenance_weeks": 10}],
    }
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/simulate", json={"scenario": scenario})
    assert resp.status_code == 200, resp.text
    util = {u["key"]: u for u in resp.json()["utilization_after"]}
    base = {u["key"]: u for u in resp.json()["utilization_before"]}
    # Downtime moves supply, not the schedule.
    assert util["Greece"]["capacity_year"] < base["Greece"]["capacity_year"]


# --- solve and OQ #47 ---


async def test_solve_returns_additions_for_a_big_addition(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.post(
            "/whatif/solve", json={"scenario": add_c_projects("R&D-Greece", 6), "max_runs": 40}
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "solution" and body["target"] == "all_new_within_year"
    assert body["run_cap"] <= 40 and body["runs_used"] <= body["run_cap"]
    assert body["additions"]["total"] == sum(
        d["count"] for d in body["additions"]["designers"]
    ) + sum(c["count"] for c in body["additions"]["chambers"])
    assert body["achieved"]["kind"] == "simulation"
    if body["met"]:
        assert body["unmet_project_ids"] == []
    assert "met_attainable" in body["semantics"]


async def test_solve_reports_unattainable_projects_clearly(db_session):
    """PDD / A is 38 weeks; at CURRENT_WEEK 31 it cannot end by W52 whatever is
    added (OQ #47). It is reported, not chased: met is false, met_attainable
    true, and the project is listed."""

    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.post(
            "/whatif/solve", json={"scenario": add_c_projects("R&D-Greece", 1, category="A")}
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["unattainable_project_ids"]) == 1
    assert body["met"] is False and body["met_attainable"] is True
    (u,) = body["unattainable_projects"]
    assert u["project_id"] == body["unattainable_project_ids"][0]
    assert u["unconstrained_end_week"] > 52 and u["hub"] == "R&D-Greece"
    assert "cannot finish this year" in body["semantics"]


async def test_solve_no_existing_slips_target(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.post(
            "/whatif/solve",
            json={"scenario": add_c_projects("R&D-Greece", 4), "target": "no_existing_slips"},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["target"] == "no_existing_slips"


# --- 422 ---


@pytest.mark.parametrize(
    "scenario",
    [
        # engine rejections (ValueError -> 422 INVALID_SCENARIO)
        {"add_projects": [{"hub": "R&D-Greece", "category": "A-OEM"}]},
        {"add_projects": [{"hub": "OEM-HCK", "category": "A"}]},
        {"remove_engineers": ["not-an-engineer"]},
        {"priority_overrides": [{"project_id": "nope", "priority": "P1"}]},
        {"chamber_downtime": [{"chamber_id": "nope", "maintenance_weeks": 1}]},
        {"add_projects": [{"hub": "R&D-Greece", "category": "C", "workflow_id": "OEM"}]},
    ],
)
@pytest.mark.parametrize("path", ["/whatif/estimate", "/whatif/simulate", "/whatif/solve"])
async def test_engine_rejection_is_422_invalid_scenario(db_session, path, scenario):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.post(path, json={"scenario": scenario})
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "INVALID_SCENARIO"


@pytest.mark.parametrize(
    "scenario",
    [
        {"add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 0}]},
        {"add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 501}]},
        {"add_projects": [{"hub": "Narnia", "category": "C"}]},
        {"add_projects": [{"hub": "R&D-Greece", "category": "C", "tcogs_eur": 5}]},
        {"add_projects": [{"hub": "R&D-Greece", "category": "C", "count": "2"}]},
        {"add_engineers": [{"hub": "R&D-Greece", "fte": 0}]},
        {"add_engineers": [{"hub": "R&D-Greece", "fte": "NaN"}]},
        {"add_chambers": [{"lab_region": "Mars"}]},
        {"add_chambers": [{"lab_region": "Greece", "efficiency": -1}]},
        {"add_chambers": [{"lab_region": "Greece", "allowed_stages": ["'; DROP TABLE x;--"]}]},
        {"surprise": 1},
    ],
)
async def test_malformed_scenario_is_422(db_session, scenario):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/simulate", json={"scenario": scenario})
    assert resp.status_code == 422, resp.text


async def test_extra_top_level_key_and_bad_enums_are_422(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        assert (
            await c.post("/whatif/estimate", json={"scenario": {}, "role": "Admin"})
        ).status_code == 422
        assert (
            await c.post("/whatif/estimate", json={"scenario": {}, "basis": "decade"})
        ).status_code == 422
        assert (
            await c.post("/whatif/solve", json={"scenario": {}, "target": "everything"})
        ).status_code == 422
        assert (
            await c.post("/whatif/solve", json={"scenario": {}, "max_runs": 61})
        ).status_code == 422


# --- hub scoping ---


async def test_hub_planner_sees_only_own_hub_figures(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    scenario = add_c_projects("R&D-Greece", 3)
    async with client_for(db_session) as c:
        est = await c.post("/whatif/estimate", json={"scenario": scenario})
        sim = await c.post("/whatif/simulate", json={"scenario": scenario})
        sol = await c.post("/whatif/solve", json={"scenario": scenario})
    assert est.status_code == sim.status_code == sol.status_code == 200
    est_b, sim_b, sol_b = est.json(), sim.json(), sol.json()
    assert est_b["scope"] == {
        "all_hubs": False, "hubs": ["R&D-Greece"], "lab_regions": ["Greece"],
    }  # fmt: skip
    assert [r["hub"] for r in est_b["design"]] == ["R&D-Greece"]
    assert [r["lab_region"] for r in est_b["lab"]] == ["Greece"]
    # Totals are sums of the visible rows only.
    assert est_b["extra_design_weeks_total"] == 18
    assert {u["key"] for u in sim_b["utilization_after"]} == {"R&D-Greece", "Greece"}
    assert {p["hub"] for p in sim_b["projects"]} == {"R&D-Greece"}
    assert sum(sim_b["outcome_counts_after"].values()) == 3 + 3
    assert sum(sim_b["outcome_counts_before"].values()) == 3
    # Nothing of the other hub, its projects, designer or chamber leaks, in any text.
    for blob in (est_b, sim_b, sol_b):
        text = json.dumps(blob)
        for needle in ("PD-India", "India", "Secret in Project", str(world.eng_in.id),
                       str(world.ch_in.id), IN_ENGINEER, SECRET_CUSTOMER, "CH-IN-1"):  # fmt: skip
            assert needle not in text, needle
    for ln in est_b["workings"] + sim_b["workings"] + sol_b["workings"]:
        assert "India" not in ln


async def test_hub_planner_rows_equal_the_global_rows_for_their_hub(db_session):
    """I23 in spirit: scoping narrows, it never changes a figure."""

    world = await make_world(db_session)
    scenario = add_c_projects("R&D-Greece", 3)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        full = (await c.post("/whatif/estimate", json={"scenario": scenario})).json()
        full_sim = (await c.post("/whatif/simulate", json={"scenario": scenario})).json()
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        part = (await c.post("/whatif/estimate", json={"scenario": scenario})).json()
        part_sim = (await c.post("/whatif/simulate", json={"scenario": scenario})).json()
    assert part["design"][0] == next(r for r in full["design"] if r["hub"] == "R&D-Greece")
    assert part["lab"][0] == next(r for r in full["lab"] if r["lab_region"] == "Greece")
    keep = {"R&D-Greece", "Greece"}
    assert part_sim["utilization_after"] == [
        u for u in full_sim["utilization_after"] if u["key"] in keep
    ]
    assert part_sim["projects"] == [p for p in full_sim["projects"] if p["hub"] == "R&D-Greece"]


async def test_out_of_scope_references(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        # Hub / region names are not secret: 403 with a code.
        for scenario in (
            add_c_projects("PD-India", 1),
            {"add_engineers": [{"hub": "PD-India"}]},
            {"remove_engineer_counts": [{"hub": "PD-India"}]},
            {"add_chambers": [{"lab_region": "India"}]},
        ):
            resp = await c.post("/whatif/simulate", json={"scenario": scenario})
            assert resp.status_code == 403, scenario
            assert resp.json()["code"] == "SCENARIO_OUT_OF_SCOPE"
        # Ids of other hubs' things are answered exactly like unknown ids.
        for scenario in (
            {"remove_engineers": [str(world.eng_in.id)]},
            {"chamber_downtime": [{"chamber_id": str(world.ch_in.id), "breakdown_weeks": 3}]},
            {
                "priority_overrides": [
                    {"project_id": str(world.projects["in"][0].id), "priority": "P1"}
                ]
            },
        ):
            resp = await c.post("/whatif/simulate", json={"scenario": scenario})
            assert resp.status_code == 422, scenario
            assert resp.json()["code"] == "INVALID_SCENARIO"
        # Own things work.
        ok = await c.post(
            "/whatif/simulate",
            json={"scenario": {"remove_engineers": [str(world.eng_gr.id)]}},
        )
        assert ok.status_code == 200, ok.text


async def test_hub_planner_with_no_hubs_gets_nothing(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[])
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/estimate", json={"scenario": {}})
        assert resp.status_code == 200
        assert resp.json()["design"] == [] and resp.json()["lab"] == []
        assert (
            await c.post("/whatif/simulate", json={"scenario": add_c_projects("R&D-Greece", 1)})
        ).status_code == 403


async def test_shared_region_lab_figures_include_other_hubs_load(db_session):
    """A second hub in the same lab region: the Hub Planner's lab row is
    region-wide (as the Capacity surface), but the other hub's design row and
    projects stay hidden."""

    world = await make_world(db_session)
    other = await make_hub(
        db_session, name=HubName.OEM_HCK, lab_region=LabRegion.GREECE, is_oem=True
    )
    eng = await make_engineer(
        db_session, other, name="Oem Person", allowed_categories=[EngineerAllowedCategory.C]
    )
    await make_project(
        db_session, other, leader=eng, name="Oem Secret", category=ProjectCategory.C_OEM,
        priority=ProjectPriority.P1, status=ProjectStatus.IN_QUEUE,
    )  # fmt: skip
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/estimate", json={"scenario": add_c_projects("R&D-Greece", 1)})
    body = resp.json()
    assert [r["hub"] for r in body["design"]] == ["R&D-Greece"]
    lab = body["lab"][0]
    # Greece lab baseline load = 3 Greece C projects x 1 + the OEM C-OEM project's lab weeks.
    assert lab["lab_region"] == "Greece" and lab["baseline_load_weeks"] >= 3.0
    assert "OEM" not in json.dumps(body)


# --- pure read ---


async def test_what_if_never_writes_to_the_plan(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    before = await table_counts(db_session)
    snapshot = [
        (p.name, p.priority, p.status, p.schedule_stale)
        for p in (await db_session.execute(select(Project).order_by(Project.name))).scalars()
    ]
    scenario = {
        "add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 5}],
        "add_engineers": [{"hub": "R&D-Greece"}],
        "remove_engineers": [str(world.eng_in.id)],
        "add_chambers": [{"lab_region": "India"}],
        "chamber_downtime": [{"chamber_id": str(world.ch_gr.id), "breakdown_weeks": 4}],
        "priority_overrides": [{"project_id": str(world.projects["gr"][2].id), "priority": "P1"}],
    }
    async with client_for(db_session) as c:
        for path in ("/whatif/estimate", "/whatif/simulate", "/whatif/solve"):
            assert (await c.post(path, json={"scenario": scenario})).status_code == 200, path
    await db_session.flush()
    assert await table_counts(db_session) == before
    db_session.expire_all()
    after = [
        (p.name, p.priority, p.status, p.schedule_stale)
        for p in (await db_session.execute(select(Project).order_by(Project.name))).scalars()
    ]
    assert after == snapshot
    # The only write is the audit trail.
    assert len(await whatif_audit_rows(db_session)) == 3


# --- time cap, rate limit ---


async def test_time_cap_is_503(db_session, monkeypatch):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)

    def slow(*a, **k):
        time.sleep(0.6)
        raise AssertionError("must have been abandoned by the cap")

    monkeypatch.setattr(whatif_service, "simulate", slow)
    monkeypatch.setattr(whatif_service, "WHATIF_TIME_CAP_SECONDS", 0.05)
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/simulate", json={"scenario": {}})
    assert resp.status_code == 503
    assert resp.json()["code"] == "WHATIF_TIMEOUT"
    assert await whatif_audit_rows(db_session) == []


async def test_solve_time_cap_is_503(db_session, monkeypatch):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    monkeypatch.setattr(whatif_service, "solve_minimum_additions", lambda *a, **k: time.sleep(0.6))
    monkeypatch.setattr(whatif_service, "WHATIF_SOLVE_TIME_CAP_SECONDS", 0.05)
    async with client_for(db_session) as c:
        resp = await c.post("/whatif/solve", json={"scenario": {}})
    assert resp.status_code == 503 and resp.json()["code"] == "WHATIF_TIMEOUT"


async def test_rate_limit_is_per_user_with_retry_after(db_session, monkeypatch):
    await make_world(db_session)
    monkeypatch.setattr(whatif_router, "WHATIF_RATE_LIMIT", TokenBucketLimiter(2, 0.001))
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        assert (await c.post("/whatif/estimate", json={"scenario": {}})).status_code == 200
        assert (await c.post("/whatif/simulate", json={"scenario": {}})).status_code == 200
        limited = await c.post("/whatif/estimate", json={"scenario": {}})
        assert limited.status_code == 429
        assert int(limited.headers["Retry-After"]) >= 1
    # Another user has their own bucket.
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        assert (await c.post("/whatif/estimate", json={"scenario": {}})).status_code == 200


async def test_solve_has_its_own_tighter_limit(db_session, monkeypatch):
    await make_world(db_session)
    monkeypatch.setattr(whatif_router, "WHATIF_SOLVE_RATE_LIMIT", TokenBucketLimiter(1, 0.001))
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        assert (await c.post("/whatif/solve", json={"scenario": {}})).status_code == 200
        assert (await c.post("/whatif/solve", json={"scenario": {}})).status_code == 429
        assert (await c.post("/whatif/estimate", json={"scenario": {}})).status_code == 200


# --- audit ---


async def test_audit_row_is_coalesced_and_names_nothing(db_session):
    world = await make_world(db_session)
    user = await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    scenario = {
        "add_projects": [{"hub": "R&D-Greece", "category": "C", "count": 2}],
        "remove_engineers": [str(world.eng_gr.id)],
        "priority_overrides": [{"project_id": str(world.projects["gr"][0].id), "priority": "P2"}],
    }
    async with client_for(db_session) as c:
        for _ in range(3):
            assert (
                await c.post("/whatif/simulate", json={"scenario": scenario})
            ).status_code == 200
        rows = await whatif_audit_rows(db_session)
        assert len(rows) == 1  # same user, kind and scenario within a minute
        assert (
            await c.post("/whatif/simulate", json={"scenario": add_c_projects("R&D-Greece", 1)})
        ).status_code == 200
        assert (await c.post("/whatif/estimate", json={"scenario": scenario})).status_code == 200
    rows = await whatif_audit_rows(db_session)
    assert sorted(r.action for r in rows) == [
        "whatif.estimate",
        "whatif.simulate",
        "whatif.simulate",
    ]
    first = next(
        r
        for r in rows
        if r.action == "whatif.simulate"
        and r.after_state["scenario"]["add_projects"][0]["count"] == 2
    )
    assert first.actor_user_id == user.id
    shape = first.after_state["scenario"]
    assert shape["add_projects"] == [{"hub": "R&D-Greece", "category": "C", "count": 2}]
    assert shape["remove_engineers_count"] == 1  # a count, never the designer id or name
    assert shape["priority_overrides"] == [
        {"project_id": str(world.projects["gr"][0].id), "priority": "P2"}
    ]
    text = json.dumps([r.after_state for r in rows], default=str)
    for needle in (
        GR_ENGINEER,
        IN_ENGINEER,
        SECRET_CUSTOMER,
        "Secret gr Project",
        str(world.eng_gr.id),
    ):
        assert needle not in text
    for forbidden in ("tcogs", "gross_margin", "selling_price", "customer"):
        assert forbidden not in text


async def test_rejected_scenarios_write_no_audit_row(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        assert (
            await c.post("/whatif/simulate", json={"scenario": {"remove_engineers": ["x"]}})
        ).status_code == 422
    assert await whatif_audit_rows(db_session) == []


# --- OpenAPI ---


def test_openapi_shapes_are_strict_and_typed():
    spec = app.openapi()
    for path in ("/whatif/estimate", "/whatif/simulate", "/whatif/solve", "/whatif/ask"):
        op = spec["paths"][path]["post"]
        assert "422" in op["responses"]
        assert op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
        ok = op["responses"]["200"]["content"]["application/json"]["schema"]
        assert "$ref" in ok  # a named response model, never a bare object
    schemas = spec["components"]["schemas"]
    for name in (
        "ScenarioRequest", "ChatScenario", "AddProjectIn", "AddEngineerIn", "AddChamberIn",
        "EstimateRequest", "SimulateRequest", "SolveRequest", "AskRequest",
    ):  # fmt: skip
        assert schemas[name].get("additionalProperties") is False, name
    for name in ("EstimateResponse", "SimulateResponse", "SolveResponse", "AskResponse",
                 "CapacitySnapshotResponse"):  # fmt: skip
        assert name in schemas
    # The chat's scenario cannot carry designer or project ids.
    assert "remove_engineers" not in schemas["ChatScenario"]["properties"]
    assert "priority_overrides" not in schemas["ChatScenario"]["properties"]
    assert "remove_engineers" in schemas["ScenarioRequest"]["properties"]
    # No financial or name field on any what-if schema.
    blob = json.dumps({k: v for k, v in schemas.items()})
    start = blob.find("EstimateRequest")
    assert start >= 0
    for name, sch in schemas.items():
        if name in {
            "EstimateResponse", "SimulateResponse", "SolveResponse", "AskResponse",
            "ScenarioRequest", "CapacitySnapshotResponse", "ToolRunOut",
        }:  # fmt: skip
            props = json.dumps(sch.get("properties", {}))
            for forbidden in (
                "customer",
                "tcogs",
                "gross_margin",
                "selling_price",
                "engineer_name",
            ):
                assert forbidden not in props, (name, forbidden)
