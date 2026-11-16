"""ADR 0051 (`docs/API_CONTRACT_MULTISELECT.md`): every filter is multi-select.

- `hub_id` and `region` are repeatable and UNIONED (hub listed OR its lab
  region listed); the RBAC scope is always ANDed, so an out-of-scope hub or
  region in a list contributes nothing (empty rows, never 403, never wider).
- `status_`, `priority`, `leader_engineer_id`, `current_step` (and the audit
  log's `action` / `entity_type` / `actor_user_id`, the check-in history's
  `step_id`) are repeatable: OR within a param, AND across.
- One value is the pre-ADR-0051 behaviour; more than 50 values is a 422.

Seed: the prototype demo seed, scheduled with the real greedy scheduler and
activated inside the per-test savepoint (as `test_p13_region_filter.py`).
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, RoleName, SolverType
from models.hub import Hub
from scheduling.greedy import run_greedy_sgs
from seed import seed_demo_data
from services.hub_scope import (
    global_hub_filter,
    hub_id_list,
    narrowed_hub_filter,
    narrowed_lab_regions,
    region_list,
)
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_user

#: Endpoints behind the global hub / country filter (as test_p13_region_filter).
FILTERED_PATHS = (
    "/dashboard/pipeline-totals",
    "/dashboard/status-overview",
    "/dashboard/hub-type-pipeline",
    "/dashboard/completing-within-year",
    "/dashboard/projects",
    "/dashboard/projects/facets",
    "/dashboard/region-summary",
    "/dashboard/analytics",
    "/capacity/hubs",
    "/capacity/hub-load",
    "/capacity/class-breakdown",
    "/capacity/utilization-matrix",
    "/priorities/summary",
    "/priorities",
    "/priorities/distribution",
    "/priorities/capacity-fill",
    "/gantt",
    "/priority-board",
    "/vip-projects",
    "/vip-board",
    "/planning/capacity-summary",
    "/planning/resource-load/options",
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
    return user


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


def _params(**params: Any) -> list[tuple[str, str]]:
    """Repeated query params: a list value becomes one pair per element."""

    out: list[tuple[str, str]] = []
    for key, value in params.items():
        for v in value if isinstance(value, list | tuple) else [value]:
            out.append((key, str(v)))
    return out


async def _get(client: AsyncClient, path: str, **params: Any):
    resp = await client.get(path, params=_params(**params))
    assert resp.status_code == 200, (path, resp.text)
    return resp.json()


def _ids(body: dict) -> set[str]:
    return {r["project_id"] for r in body["rows"]}


def _without_selected_member(body):
    """A capacity row names the requested hub in `selected_member` (P29)."""

    if isinstance(body, dict) and isinstance(body.get("rows"), list):
        rows = [
            {k: v for k, v in r.items() if k != "selected_member"} if isinstance(r, dict) else r
            for r in body["rows"]
        ]
        return {**body, "rows": rows}
    return body


# --- the predicate (services.hub_scope) -------------------------------------------------


def test_global_hub_filter_lists():
    a, b = uuid.uuid4(), uuid.uuid4()
    assert global_hub_filter(Hub.id, None, None) is None
    assert global_hub_filter(Hub.id, [], []) is None
    one = str(global_hub_filter(Hub.id, [a]))
    assert "hubs.id = " in one and " IN " not in one
    # A bare value (internal callers) is a one-element list.
    assert str(global_hub_filter(Hub.id, a)) == one
    many = str(global_hub_filter(Hub.id, [a, b, a]))
    assert "hubs.id IN " in many
    union = str(global_hub_filter(Hub.id, [a], [LabRegion.GREECE, LabRegion.INDIA]))
    assert " OR " in union and "lab_region IN " in union
    # Values are bound parameters, never interpolated.
    assert "Greece" not in union and str(a) not in union


def test_region_list_never_iterates_a_bare_enum():
    assert region_list(LabRegion.INDIA) == [LabRegion.INDIA]
    assert region_list([LabRegion.INDIA, LabRegion.INDIA, LabRegion.GREECE]) == [
        LabRegion.INDIA,
        LabRegion.GREECE,
    ]
    a = uuid.uuid4()
    assert hub_id_list(a) == [a] and hub_id_list(None) == [] and hub_id_list([a, a]) == [a]


def test_narrowed_hub_filter_ands_scope_onto_the_union():
    a, b = uuid.uuid4(), uuid.uuid4()
    planner = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[a])
    sql = str(narrowed_hub_filter(planner, Hub.id, [a, b], [LabRegion.ROMANIA]))
    # scope AND (hub IN (...) OR region): the OR is inside the AND.
    assert sql.index(" AND ") < sql.index(" OR ")
    assert narrowed_hub_filter(
        make_principal(RoleName.PORTFOLIO_MANAGER, hub_scope_all=True), Hub.id, [], None
    ) is None


async def test_narrowed_lab_regions_union_inside_scope(db_session):
    greece = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    romania = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    pm = make_principal(RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)
    planner = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[india.id])

    assert await narrowed_lab_regions(db_session, pm, None, None) is None
    assert await narrowed_lab_regions(db_session, pm, [greece.id], [LabRegion.ROMANIA]) == {
        LabRegion.GREECE,
        LabRegion.ROMANIA,
    }
    assert await narrowed_lab_regions(db_session, pm, [greece.id, india.id]) == {
        LabRegion.GREECE,
        LabRegion.INDIA,
    }
    # Out-of-scope hubs and regions contribute nothing.
    assert await narrowed_lab_regions(
        db_session, planner, [india.id, greece.id, romania.id]
    ) == {LabRegion.INDIA}
    assert await narrowed_lab_regions(
        db_session, planner, [greece.id], [LabRegion.ROMANIA]
    ) == set()
    assert await narrowed_lab_regions(
        db_session, planner, None, [LabRegion.INDIA, LabRegion.GREECE]
    ) == {LabRegion.INDIA}


# --- union of hubs and regions on the endpoints ----------------------------------------


async def test_multi_hub_is_the_union_of_each_hub(db_session):
    w = await _seeded(db_session)
    a, b = w.hubs["PD-India"].id, w.hubs["PD-Romania"].id
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for path in ("/dashboard/projects", "/gantt"):
            extra = {"limit": 500} if path == "/gantt" else {}
            only_a = await _get(client, path, hub_id=a, **extra)
            only_b = await _get(client, path, hub_id=b, **extra)
            both = await _get(client, path, hub_id=[a, b], **extra)
            assert _ids(only_a) and _ids(only_b), path
            assert _ids(both) == _ids(only_a) | _ids(only_b), path
            assert both["total_count"] == only_a["total_count"] + only_b["total_count"], path
        totals_a = await _get(client, "/dashboard/pipeline-totals", hub_id=a)
        totals_b = await _get(client, "/dashboard/pipeline-totals", hub_id=b)
        totals = await _get(client, "/dashboard/pipeline-totals", hub_id=[b, a])
        assert totals["total_count"] == totals_a["total_count"] + totals_b["total_count"]
        # Order and duplicates do not matter.
        assert await _get(client, "/dashboard/pipeline-totals", hub_id=[a, b, a]) == totals
        hub_rows = await _get(client, "/capacity/hub-load", hub_id=[a, b])
        assert {r["hub"] for r in hub_rows["rows"]} == {"PD-India", "PD-Romania"}


async def test_hub_and_region_union_on_gantt(db_session):
    w = await _seeded(db_session)
    pd_india = w.hubs["PD-India"].id
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        india = await _get(client, "/gantt", hub_id=pd_india, limit=500)
        greece_romania = await _get(
            client, "/gantt", region=["Greece", "Romania"], limit=500
        )
        union = await _get(
            client, "/gantt", hub_id=pd_india, region=["Greece", "Romania"], limit=500
        )
    assert _ids(union) == _ids(india) | _ids(greece_romania)
    assert _ids(india).isdisjoint(_ids(greece_romania))


async def test_every_filtered_endpoint_accepts_lists(db_session):
    """A multi-hub / multi-region request answers 200 everywhere, and the
    two-element list of one hub equals that hub alone."""

    w = await _seeded(db_session)
    a = w.hubs["PD-India"].id
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for path in FILTERED_PATHS:
            assert await _get(client, path, hub_id=[a, a]) == await _get(
                client, path, hub_id=a
            ), path
            await _get(client, path, hub_id=[a, w.hubs["PD-Romania"].id], region=["Greece"])


async def test_out_of_scope_hub_in_a_list_contributes_nothing(db_session):
    """A Hub Planner of PD-India asking for [PD-India, PD-Romania] sees
    exactly PD-India; asking only for out-of-scope values sees nothing, and
    is never 403'd."""

    w = await _seeded(db_session)
    own, other = w.hubs["PD-India"].id, w.hubs["PD-Romania"].id
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[own])
    async with _client(db_session) as client:
        for path in FILTERED_PATHS:
            mixed = await _get(client, path, hub_id=[own, other])
            assert _without_selected_member(mixed) == _without_selected_member(
                await _get(client, path, hub_id=own)
            ), path
            mixed_region = await _get(client, path, region=["India", "Romania"])
            assert _without_selected_member(mixed_region) == _without_selected_member(
                await _get(client, path, region="India")
            ), path
        rows = (await _get(client, "/dashboard/projects", hub_id=[own, other]))["rows"]
        assert rows and {r["hub"] for r in rows} == {"PD-India"}
        gantt = await _get(client, "/gantt", hub_id=[own, other], limit=500)
        assert gantt["rows"] and {r["hub"] for r in gantt["rows"]} == {"PD-India"}
        nothing = await _get(client, "/dashboard/projects", hub_id=[other], region=["Greece"])
        assert nothing["rows"] == [] and nothing["total_count"] == 0
        totals = await _get(client, "/dashboard/pipeline-totals", hub_id=[other])
        assert totals["total_count"] == 0
        engineers = await _get(client, "/engineers", hub_id=[own, other])
        assert engineers and {e["hub_id"] for e in engineers} == {str(own)}
        assert await _get(client, "/engineers", hub_id=[other]) == []


# --- multi status / leader / priority / step --------------------------------------------


async def _union_check(client, path: str, key: str, values: list[str], **extra: Any) -> None:
    singles = [await _get(client, path, **{key: v}, **extra) for v in values]
    both = await _get(client, path, **{key: values}, **extra)
    expected: set[str] = set()
    for body in singles:
        assert _ids(body), (path, key)
        expected |= _ids(body)
    assert _ids(both) == expected, (path, key)
    assert both["total_count"] == sum(b["total_count"] for b in singles), (path, key)


async def test_multi_status_leader_priority_step(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        everything = await _get(client, "/dashboard/projects")
        rows = everything["rows"]
        statuses = sorted({r["status"] for r in rows})[:2]
        priorities = sorted({r["priority"] for r in rows if r["priority"] in {"P1", "P2", "P3"}})[
            :2
        ]
        leaders = sorted({r["leader_engineer_id"] for r in rows if r["leader_engineer_id"]})[:2]
        steps = sorted({r["current_step_code"] for r in rows if r["current_step_code"]})[:2]
        assert len(statuses) == len(priorities) == len(leaders) == len(steps) == 2
        for path, extra in (("/dashboard/projects", {}), ("/gantt", {"limit": 500})):
            await _union_check(client, path, "status_", statuses, **extra)
            await _union_check(client, path, "priority", priorities, **extra)
            await _union_check(client, path, "leader_engineer_id", leaders, **extra)
            await _union_check(client, path, "current_step", steps, **extra)
        # AND across params: two statuses AND two priorities.
        both = await _get(client, "/dashboard/projects", status_=statuses, priority=priorities)
        assert _ids(both) == {
            r["project_id"]
            for r in rows
            if r["status"] in statuses and r["priority"] in priorities
        }
        # Gantt keeps the Queue bucket: Q in a list also selects no priority.
        gantt = await _get(client, "/gantt", limit=500)
        queue = {
            r["project_id"] for r in gantt["rows"] if r["priority"] in (None, "Q")
        }
        p1 = {r["project_id"] for r in gantt["rows"] if r["priority"] == "P1"}
        assert _ids(await _get(client, "/gantt", priority=["P1", "Q"], limit=500)) == queue | p1
        # Priority board and Matrix take status lists too.
        board = await _get(client, "/priority-board", status_=statuses)
        board_statuses = {c["status"] for col in board["columns"] for c in col["cards"]}
        assert board_statuses <= set(statuses)
        matrix = await _get(client, "/priorities", status_=statuses)
        assert {r["status"] for r in matrix} <= set(statuses)


async def test_single_values_still_work(db_session):
    w = await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        one = await _get(client, "/dashboard/projects", status_="In Queue")
        assert one["rows"] and {r["status"] for r in one["rows"]} == {"In Queue"}
        hub = await _get(client, "/dashboard/projects", hub_id=w.hubs["PD-Romania"].id)
        assert hub["rows"] and {r["hub"] for r in hub["rows"]} == {"PD-Romania"}
        region = await _get(client, "/gantt", region="Romania", limit=500)
        assert region["rows"] and {r["hub"] for r in region["rows"]} == {"PD-Romania"}
        listed = await _get(client, "/projects", status_="In Queue", limit=500)
        assert listed and {p["status"] for p in listed} == {"In Queue"}


async def test_bad_value_in_a_list_is_422(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for path, key, values in (
            ("/dashboard/projects", "status_", ["In Queue", "Nope"]),
            ("/dashboard/projects", "hub_id", [str(uuid.uuid4()), "not-a-uuid"]),
            ("/gantt", "priority", ["P1", "P9"]),
            ("/gantt", "region", ["India", "Europe"]),
            ("/dashboard/projects", "current_step", ["PDD-A", "X" * 11]),
            ("/exports/dashboard", "status_", ["Nope"]),
        ):
            resp = await client.get(path, params=_params(**{key: values}))
            assert resp.status_code == 422, (path, key)


async def test_more_than_50_values_is_422(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    ids = [str(uuid.uuid4()) for _ in range(51)]
    async with _client(db_session) as client:
        for path, key, values in (
            ("/dashboard/projects", "hub_id", ids),
            ("/dashboard/projects", "status_", ["In Queue"] * 51),
            ("/dashboard/projects", "leader_engineer_id", ids),
            ("/dashboard/projects", "current_step", ["PDD-A"] * 51),
            ("/dashboard/pipeline-totals", "region", ["India"] * 51),
            ("/dashboard/pipeline-totals", "category", ["A"] * 51),
            ("/gantt", "priority", ["P1"] * 51),
            ("/capacity/hub-load", "hub_id", ids),
            ("/engineers", "hub_id", ids),
            ("/projects", "status_", ["In Queue"] * 51),
            ("/exports/dashboard", "hub_id", ids),
            ("/exports/gantt", "region", ["India"] * 51),
        ):
            resp = await client.get(path, params=_params(**{key: values}))
            assert resp.status_code == 422, (path, key, resp.status_code)
            ok = await client.get(path, params=_params(**{key: values[:50]}))
            assert ok.status_code == 200, (path, key, ok.text)
    await _act_as(db_session, RoleName.AUDITOR)
    async with _client(db_session) as client:
        for key, values in (
            ("action", ["x"] * 51),
            ("entity_type", ["Project"] * 51),
            ("actor_user_id", ids),
            ("hub_id", ids),
        ):
            resp = await client.get("/audit-log", params=_params(**{key: values}))
            assert resp.status_code == 422, key
            ok = await client.get("/audit-log", params=_params(**{key: values[:50]}))
            assert ok.status_code == 200, key


# --- audit log, exports ------------------------------------------------------------------


async def test_audit_log_multi_action_and_entity_type(db_session):
    actor = await make_user(db_session, RoleName.ADMIN)
    for action, entity in (
        ("project.create", "Project"),
        ("project.update", "Project"),
        ("engineer.update", "Engineer"),
        ("chamber.update", "Chamber"),
    ):
        db_session.add(
            AuditLogEntry(
                action=action,
                entity_type=entity,
                entity_id=str(uuid.uuid4()),
                actor_user_id=actor.id,
            )
        )
    await db_session.flush()
    await _act_as(db_session, RoleName.AUDITOR)
    async with _client(db_session) as client:
        two = await _get(client, "/audit-log", action=["project.create", "engineer.update"])
        assert {i["action"] for i in two["items"]} == {"project.create", "engineer.update"}
        assert two["total_count"] == 2
        entities = await _get(client, "/audit-log", entity_type=["Engineer", "Chamber"])
        assert entities["total_count"] == 2
        anded = await _get(
            client, "/audit-log", entity_type=["Project", "Chamber"], action=["project.update"]
        )
        assert anded["total_count"] == 1
        by_actor = await _get(client, "/audit-log", actor_user_id=[actor.id, uuid.uuid4()])
        assert by_actor["total_count"] == 4


async def test_dashboard_export_takes_the_same_lists(db_session):
    w = await _seeded(db_session)
    a, b = w.hubs["PD-India"].id, w.hubs["PD-Romania"].id
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        register = await _get(
            client, "/dashboard/projects", hub_id=[a, b], status_=["In Queue", "In Development"]
        )
        resp = await client.get(
            "/exports/dashboard",
            params=_params(hub_id=[a, b], status_=["In Queue", "In Development"]),
        )
        gantt = await client.get(
            "/exports/gantt", params=_params(hub_id=[a, b], region=["Greece"])
        )
    assert resp.status_code == 200, resp.text
    lines = [line for line in resp.text.splitlines() if line.strip()]
    assert len(lines) - 1 == register["total_count"] > 0
    assert gantt.status_code == 200, gantt.text


# --- weekly check-in --------------------------------------------------------------------


async def test_check_in_history_and_due_take_lists(db_session):
    from tests.p12_helpers import act_as, add_checkin, client_for
    from tests.test_p12_checkins import _world as checkin_world

    w = await checkin_world(db_session)
    author = await make_user(db_session, RoleName.HUB_PLANNER, full_name="Maria Planner")
    for week in (28, 29):
        await add_checkin(db_session, w.led, "PDD-E", week, author)
    await add_checkin(db_session, w.led, "PDD-F", 30, author)
    await add_checkin(db_session, w.led, "PDD-G", 31, author)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        one = await client.get(
            "/check-ins/history", params={"project_id": str(w.led.id), "step_id": "PDD-E"}
        )
        two = await client.get(
            "/check-ins/history",
            params=[("project_id", str(w.led.id)), ("step_id", "PDD-E"), ("step_id", "PDD-F")],
        )
        missing = await client.get("/check-ins/history", params={"project_id": str(w.led.id)})
        too_many = await client.get(
            "/check-ins/history",
            params=[("project_id", str(w.led.id))] + [("step_id", "PDD-E")] * 51,
        )
        due_both = await client.get(
            "/check-ins/due", params=_params(hub_id=[w.gr.id, w.india.id])
        )
        due_gr = await client.get("/check-ins/due", params=_params(hub_id=w.gr.id))
        due_union = await client.get(
            "/check-ins/due", params=_params(hub_id=w.gr.id, region="India")
        )
    assert one.status_code == 200 and [r["week"] for r in one.json()] == [29, 28]
    assert two.status_code == 200 and [r["week"] for r in two.json()] == [30, 29, 28]
    assert missing.status_code == 422 and too_many.status_code == 422
    names = lambda r: {p["name"] for p in r.json()["projects"]}  # noqa: E731
    assert names(due_gr) == {"Led by A", "Shared"}
    assert names(due_both) == names(due_union) == {"Led by A", "Shared", "India project"}
