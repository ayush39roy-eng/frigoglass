"""P12-T02: global hub filter (ADR 0020, docs/API_CONTRACT_P12.md §4, I23).

Every listed read endpoint takes an optional `hub_id` that is ANDed with the
RBAC hub scope:
- it never widens scope: a Hub Planner asking for another hub, or anyone
  asking for an unknown hub, gets empty rows and zero totals (not 403);
- a planner asking for their own hub gets exactly the unfiltered answer;
- I23 on the seed: for every hub, each hub-filtered Dashboard total equals
  the corresponding unfiltered per-hub figure, and the Gantt, Capacity and
  Dashboard agree for that hub (design load, project counts);
- Capacity under a filter: one hub row, `areas[]` reduced to that hub's area,
  lab figures region-wide.

The seed is the demo seed (`seed/seed_demo_data.py`), scheduled with the real
greedy scheduler and activated, all inside the per-test savepoint.
"""

from __future__ import annotations

import uuid
from collections import Counter
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

import domain_constants as dc
from api.db import get_db
from api.main import app
from core.principal import Principal
from models.enums import RoleName, SolverType
from models.hub import Hub
from models.project import Project
from scheduling.greedy import run_greedy_sgs
from seed import seed_demo_data
from services.hub_scope import narrowed_hub_filter
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_user

DASHBOARD_AGGREGATES = (
    "/dashboard/pipeline-totals",
    "/dashboard/status-overview",
    "/dashboard/hub-type-pipeline",
    "/dashboard/completing-within-year",
    "/dashboard/projects",
)


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, *roles: RoleName, hub_ids=None):
    user = await make_user(
        db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=hub_ids is None
    )
    override_current_principal(
        make_principal(
            *roles, user_id=user.id, email=user.email, hub_scope_all=hub_ids is None,
            hub_ids=hub_ids or [],
        )
    )


async def _seeded(db_session) -> SimpleNamespace:
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session)
    output = run_greedy_sgs(schedule_input)
    run = await persist_schedule_output(
        db_session, schedule_input, output, solver_type=SolverType.GREEDY,
        trigger_reason="test", activate=True,
    )
    return SimpleNamespace(hubs=hubs, run=run)


async def _get(client: AsyncClient, path: str, **params):
    resp = await client.get(path, params={k: str(v) for k, v in params.items()})
    assert resp.status_code == 200, (path, resp.text)
    return resp.json()


def _zeroed(path: str, body) -> None:
    """Assert `body` is the empty/zero answer of `path`."""

    if path == "/dashboard/pipeline-totals":
        assert body == {"spillover_count": 0, "new_count": 0, "total_count": 0}
    elif path == "/dashboard/status-overview":
        assert body == {
            "in_buyoff": 0, "under_industrialization": 0, "in_development": 0, "in_queue": 0,
            "other_counts": {},
        }
    elif path == "/dashboard/hub-type-pipeline":
        assert body == []
    elif path == "/dashboard/completing-within-year":
        assert (body["within_year_count"], body["spillover_count"], body["left_out_count"],
                body["blocked_count"], body["rows"]) == (0, 0, 0, 0, [])
    elif path == "/dashboard/projects":
        assert body == {"total_count": 0, "rows": []}
    elif path in ("/capacity/hubs", "/capacity/hub-load"):
        assert body["rows"] == [] and body["areas"] == []
    elif path == "/capacity/class-breakdown":
        assert all(r["deliverable_count"] == 0 and r["left_out_count"] == 0 for r in body["rows"])
    elif path == "/capacity/utilization-matrix":
        assert body["engineers"] == [] and body["chambers"] == []
    elif path == "/priorities/summary":
        assert body["total_projects"] == 0 and body["set_priority_counts"] == {}
    elif path == "/priorities":
        assert body == []
    elif path == "/gantt":
        assert body["total_count"] == 0 and body["rows"] == []
    else:  # pragma: no cover - test table error
        raise AssertionError(path)


FILTERED_PATHS = DASHBOARD_AGGREGATES + (
    "/capacity/hubs",
    "/capacity/hub-load",
    "/capacity/class-breakdown",
    "/capacity/utilization-matrix",
    "/priorities/summary",
    "/priorities",
    "/gantt",
)


# --- never widens ---------------------------------------------------------------------


async def test_out_of_scope_hub_gives_zeros_not_403_and_own_hub_equals_unfiltered(db_session):
    w = await _seeded(db_session)
    greece, india = w.hubs["R&D-Greece"], w.hubs["PD-India"]
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with _client(db_session) as client:
        for path in FILTERED_PATHS:
            _zeroed(path, await _get(client, path, hub_id=india.id))
            assert await _get(client, path, hub_id=greece.id) == await _get(client, path), path


async def test_unknown_hub_gives_zeros_for_an_all_hubs_reader(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for path in FILTERED_PATHS:
            _zeroed(path, await _get(client, path, hub_id=uuid.uuid4()))


async def test_malformed_hub_id_is_422(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.get("/dashboard/pipeline-totals", params={"hub_id": "Greece"})
    assert resp.status_code == 422


async def test_filter_still_requires_the_surface_permission(db_session):
    await _act_as(db_session, RoleName.ENGINEER)
    async with _client(db_session) as client:
        for path in ("/dashboard/pipeline-totals", "/capacity/hubs", "/priorities/summary"):
            resp = await client.get(path, params={"hub_id": str(uuid.uuid4())})
            assert resp.status_code == 403, path


# --- I23 on the seed ----------------------------------------------------------------------


async def test_i23_filtered_figures_equal_unfiltered_per_hub_figures(db_session):
    w = await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        all_projects = await _get(client, "/dashboard/projects")
        all_hub_type = await _get(client, "/dashboard/hub-type-pipeline")
        all_within = await _get(client, "/dashboard/completing-within-year")
        all_capacity = await _get(client, "/capacity/hubs")
        all_class = await _get(client, "/capacity/class-breakdown")
        statuses = {
            p.id: p.status.value
            for p in (await db_session.execute(select(Project))).scalars()
        }
        kinds = {
            s["step_id"]: s["kind"]
            for wf in w.run.workflow_snapshot["workflows"]
            for s in wf["steps"]
        }
        checked_hubs = 0
        for name, hub in w.hubs.items():
            projects_h = [r for r in all_projects["rows"] if r["hub"] == name]

            # Pipeline totals = the hub's slice of the unfiltered hub × type cross-tab.
            totals = await _get(client, "/dashboard/pipeline-totals", hub_id=hub.id)
            hub_type_h = [r for r in all_hub_type if r["hub"] == name]
            assert totals["total_count"] == sum(r["count"] for r in hub_type_h), name
            assert await _get(client, "/dashboard/hub-type-pipeline", hub_id=hub.id) == hub_type_h

            # Status overview = the hub's unfiltered project list by status.
            overview = await _get(client, "/dashboard/status-overview", hub_id=hub.id)
            by_status = Counter(statuses[uuid.UUID(r["project_id"])] for r in projects_h)
            assert overview["in_queue"] == by_status.pop("In Queue", 0)
            assert overview["in_development"] == by_status.pop("In Development", 0)
            assert overview["under_industrialization"] == by_status.pop(
                "Under Industrialization", 0
            )
            assert overview["in_buyoff"] == by_status.pop("In Buyoff", 0)
            assert overview["other_counts"] == dict(by_status)

            # Completing within year (I9): the hub's rows of the unfiltered answer,
            # bucketed exclusively (blocked, within year, spillover, left out).
            within = await _get(client, "/dashboard/completing-within-year", hub_id=hub.id)
            rows_h = [r for r in all_within["rows"] if r["hub"] == name]
            assert sorted(r["project_id"] for r in within["rows"]) == sorted(
                r["project_id"] for r in rows_h
            )
            buckets: Counter[str] = Counter()
            for r in rows_h:
                for flag in ("blocked", "within_year", "spillover", "left_out"):
                    if r[flag]:
                        buckets[flag] += 1
                        break
            assert within["blocked_count"] == buckets["blocked"]
            assert within["within_year_count"] == buckets["within_year"]
            assert within["spillover_count"] == buckets["spillover"]
            assert within["left_out_count"] == buckets["left_out"]

            # Class breakdown: the hub's categorised outcome rows of schedulable
            # projects only (P13-F06, 2026-10-19).
            klass = await _get(client, "/capacity/class-breakdown", hub_id=hub.id)
            assert sum(r["deliverable_count"] + r["left_out_count"] for r in klass["rows"]) == (
                sum(
                    1
                    for r in rows_h
                    if r["category"] is not None
                    and statuses[uuid.UUID(r["project_id"])] in dc.SCHEDULABLE_STATUS_ORDER
                )
            )

            # Priorities summary and the filtered project list count the same projects.
            summary = await _get(client, "/priorities/summary", hub_id=hub.id)
            filtered_projects = await _get(client, "/dashboard/projects", hub_id=hub.id)
            assert summary["total_projects"] == len(projects_h)
            assert filtered_projects["total_count"] == len(projects_h)

            # Capacity: exactly the unfiltered row; one area; lab region-wide.
            capacity = await _get(client, "/capacity/hubs", hub_id=hub.id)
            (row,) = capacity["rows"]
            assert row == next(r for r in all_capacity["rows"] if r["hub"] == name)
            (area,) = capacity["areas"]
            assert area["area"] == row["area"] and area["hubs"] == [name]
            assert area["lab_regions"] == [row["lab_region"]]
            assert area["design_load_weeks"] == row["design_load_weeks"]
            assert area["design_capacity_year"] == row["design_capacity_year"]
            assert area["lab_load_weeks"] == row["lab_load_weeks"]
            assert area["lab_capacity_year"] == row["lab_capacity_year"]

            # Gantt agrees with Capacity and the Dashboard for the hub (I23).
            gantt = await _get(client, "/gantt", hub_id=hub.id, limit=500)
            assert gantt["total_count"] == len(projects_h)
            gantt_design = sum(
                s["duration_weeks"]
                for p in gantt["rows"]
                for s in p["steps"]
                if not s["skipped"] and kinds.get(s["step_id"]) == "design"
            )
            assert gantt_design == row["design_load_weeks"], name
            assert sum(1 for p in gantt["rows"] if p["blocked"]) == within["blocked_count"]
            if projects_h:
                checked_hubs += 1

        # The class breakdown sums over hubs to the unfiltered one.
        assert sum(
            r["deliverable_count"] + r["left_out_count"] for r in all_class["rows"]
        ) == sum(
            1
            for r in all_within["rows"]
            if r["category"] is not None
            and statuses[uuid.UUID(r["project_id"])] in dc.SCHEDULABLE_STATUS_ORDER
        )
    assert checked_hubs >= 2  # the seed spreads projects over several hubs


async def test_capacity_filter_keeps_lab_figures_region_wide(db_session):
    # PD-India and R&D-India share the India lab region: filtering to one of
    # them must not shrink the region's lab load or capacity.
    w = await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        unfiltered = await _get(client, "/capacity/hubs")
        filtered = await _get(client, "/capacity/hubs", hub_id=w.hubs["PD-India"].id)
        matrix = await _get(client, "/capacity/utilization-matrix", hub_id=w.hubs["PD-India"].id)
        all_matrix = await _get(client, "/capacity/utilization-matrix")
    india_rows = [r for r in unfiltered["rows"] if r["lab_region"] == "India"]
    (row,) = filtered["rows"]
    assert {r["lab_load_weeks"] for r in india_rows} == {row["lab_load_weeks"]}
    india_area = next(a for a in unfiltered["areas"] if a["area"] == "India")
    (area,) = filtered["areas"]
    assert area["lab_load_weeks"] == india_area["lab_load_weeks"]
    assert area["lab_capacity_year"] == india_area["lab_capacity_year"]
    assert area["design_load_weeks"] == row["design_load_weeks"] <= india_area["design_load_weeks"]
    # Engineers narrowed to the hub; chambers to its lab region, counts unchanged.
    hubs = {e["hub"] for e in matrix["engineers"]}
    assert hubs <= {"PD-India"}
    assert {c["lab_region"] for c in matrix["chambers"]} <= {"India"}
    all_chambers = {c["chamber_id"]: c for c in all_matrix["chambers"]}
    for c in matrix["chambers"]:
        assert c == all_chambers[c["chamber_id"]]
    assert len(matrix["chambers"]) == sum(
        1 for c in all_matrix["chambers"] if c["lab_region"] == "India"
    )


# --- the predicate itself -----------------------------------------------------------------


def _principal(**kwargs) -> Principal:
    return make_principal(RoleName.HUB_PLANNER, **kwargs)


def test_narrowed_hub_filter_composes_scope_and_choice():
    a, b = uuid.uuid4(), uuid.uuid4()
    unrestricted = _principal(hub_scope_all=True)
    planner = _principal(hub_scope_all=False, hub_ids=[a])

    assert narrowed_hub_filter(unrestricted, Hub.id, None) is None
    only_b = narrowed_hub_filter(unrestricted, Hub.id, b)
    assert only_b is not None and "hubs.id = " in str(only_b)
    scoped = narrowed_hub_filter(planner, Hub.id, None)
    assert scoped is not None and " IN " in str(scoped)
    both = narrowed_hub_filter(planner, Hub.id, b)
    assert both is not None and " AND " in str(both) and " IN " in str(both)
