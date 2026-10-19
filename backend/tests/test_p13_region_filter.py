"""P13-T01: country filter (ADR 0025, docs/API_CONTRACT_P13.md §1–§3).

- `region` on every hub-filtered endpoint, ANDed with the RBAC scope and with
  `hub_id`; never widens (out-of-scope region → empty rows / zero totals, not
  403); a bad value is 422.
- Capacity under a region: that region's hub rows, the containing area, the
  region's chambers.
- `GET /dashboard/region-summary` reconciles with `/pipeline-totals` and
  `/status-overview`.
- The enriched `GET /dashboard/projects` (q, type, leader, current step,
  sort, region) and `GET /dashboard/projects/facets`; no financial field.

Seed: the prototype demo seed, scheduled with the real greedy scheduler and
activated inside the per-test savepoint (same as `test_p12_hub_filter.py`).
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.engineer import Engineer
from models.enums import LabRegion, ProjectStatus, RoleName, SolverType
from models.hub import Hub
from models.project import Project
from scheduling.greedy import run_greedy_sgs
from seed import seed_demo_data
from services.hub_scope import global_hub_filter, narrowed_hub_filter
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_user

REGIONS = ("Greece", "India", "Romania")

FILTERED_PATHS = (
    "/dashboard/pipeline-totals",
    "/dashboard/status-overview",
    "/dashboard/hub-type-pipeline",
    "/dashboard/completing-within-year",
    "/dashboard/projects",
    "/dashboard/projects/facets",
    "/dashboard/region-summary",
    "/capacity/hubs",
    "/capacity/hub-load",
    "/capacity/class-breakdown",
    "/capacity/utilization-matrix",
    "/priorities/summary",
    "/priorities",
    "/gantt",
    "/priority-board",
    "/vip-projects",
)

_FINANCIAL = ("customer_name", "tcogs", "selling_price", "gross_margin")


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


async def _get(client: AsyncClient, path: str, **params):
    resp = await client.get(path, params={k: str(v) for k, v in params.items()})
    assert resp.status_code == 200, (path, resp.text)
    return resp.json()


def _zeroed(path: str, body) -> None:
    if path == "/dashboard/pipeline-totals":
        assert body == {"spillover_count": 0, "new_count": 0, "total_count": 0}
    elif path == "/dashboard/status-overview":
        assert (body["in_buyoff"], body["under_industrialization"], body["in_development"],
                body["in_queue"], body["other_counts"]) == (0, 0, 0, 0, {})
    elif path in ("/dashboard/hub-type-pipeline", "/priorities"):
        assert body == []
    elif path == "/dashboard/completing-within-year":
        assert (body["within_year_count"], body["spillover_count"], body["left_out_count"],
                body["blocked_count"], body["rows"]) == (0, 0, 0, 0, [])
    elif path == "/dashboard/projects":
        assert body == {"total_count": 0, "rows": []}
    elif path == "/dashboard/projects/facets":
        assert body == {"leaders": [], "steps": []}
    elif path == "/dashboard/region-summary":
        assert body["total_count"] == 0
        assert [r["region"] for r in body["regions"]] == list(REGIONS)
        for r in body["regions"]:
            assert r["total_count"] == r["spillover_count"] == r["newly_registered_count"] == 0
            assert set(r["status_counts"].values()) == {0}
            assert r["share_pct"] == 0.0
    elif path in ("/capacity/hubs", "/capacity/hub-load"):
        assert body["rows"] == [] and body["areas"] == []
    elif path == "/capacity/class-breakdown":
        assert all(r["deliverable_count"] == 0 and r["left_out_count"] == 0 for r in body["rows"])
    elif path == "/capacity/utilization-matrix":
        assert body["engineers"] == [] and body["chambers"] == []
    elif path == "/priorities/summary":
        assert body["total_projects"] == 0 and body["set_priority_counts"] == {}
    elif path == "/gantt":
        assert body["total_count"] == 0 and body["rows"] == []
    elif path == "/priority-board":
        assert all(c["count"] == 0 and c["cards"] == [] for c in body["columns"])
    elif path == "/vip-projects":
        assert body["hubs"] == []
    elif path == "/check-ins/due":
        assert body["projects"] == []
    else:  # pragma: no cover - test table error
        raise AssertionError(path)


async def _region_of(db_session) -> dict[str, str]:
    return {
        h.name.value: h.lab_region.value
        for h in (await db_session.execute(select(Hub))).scalars()
    }


# --- §1: never widens ----------------------------------------------------------------------


async def test_out_of_scope_region_gives_zeros_and_own_region_equals_unfiltered(db_session):
    w = await _seeded(db_session)
    greece = w.hubs["R&D-Greece"]
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with _client(db_session) as client:
        for path in FILTERED_PATHS:
            for region in ("India", "Romania"):
                _zeroed(path, await _get(client, path, region=region))
            assert await _get(client, path, region="Greece") == await _get(client, path), path


async def test_check_ins_due_follows_region(db_session):
    w = await _seeded(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hubs["PD-India"].id])
    async with _client(db_session) as client:
        _zeroed("/check-ins/due", await _get(client, "/check-ins/due", region="Greece"))
        assert await _get(client, "/check-ins/due", region="India") == await _get(
            client, "/check-ins/due"
        )


async def test_hub_id_and_region_are_anded(db_session):
    w = await _seeded(db_session)
    pd_india = w.hubs["PD-India"].id
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for path in FILTERED_PATHS:
            _zeroed(path, await _get(client, path, hub_id=pd_india, region="Greece"))
            assert await _get(client, path, hub_id=pd_india, region="India") == await _get(
                client, path, hub_id=pd_india
            ), path


async def test_bad_region_is_422(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for path in ("/dashboard/pipeline-totals", "/dashboard/projects", "/capacity/hubs",
                     "/gantt", "/dashboard/region-summary", "/exports/dashboard"):
            resp = await client.get(path, params={"region": "Europe"})
            assert resp.status_code == 422, path


async def test_region_still_requires_the_surface_permission(db_session):
    await _act_as(db_session, RoleName.ENGINEER)
    async with _client(db_session) as client:
        for path in ("/dashboard/region-summary", "/dashboard/projects/facets", "/capacity/hubs"):
            resp = await client.get(path, params={"region": "India"})
            assert resp.status_code == 403, path


async def test_region_rows_are_exactly_the_regions_hubs(db_session):
    await _seeded(db_session)
    region_of = await _region_of(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        all_projects = await _get(client, "/dashboard/projects")
        all_hub_type = await _get(client, "/dashboard/hub-type-pipeline")
        all_gantt = await _get(client, "/gantt", limit=500)
        for region in REGIONS:
            expected = {
                r["project_id"] for r in all_projects["rows"] if region_of[r["hub"]] == region
            }
            projects = await _get(client, "/dashboard/projects", region=region)
            assert {r["project_id"] for r in projects["rows"]} == expected
            assert projects["total_count"] == len(expected)
            assert all(r["region"] == region for r in projects["rows"])
            hub_type = await _get(client, "/dashboard/hub-type-pipeline", region=region)
            assert hub_type == [r for r in all_hub_type if region_of[r["hub"]] == region]
            gantt = await _get(client, "/gantt", region=region, limit=500)
            assert {p["project_id"] for p in gantt["rows"]} == {
                p["project_id"] for p in all_gantt["rows"] if region_of[p["hub"]] == region
            }
    assert all_projects["total_count"] > 0


async def test_capacity_region_reduces_rows_area_and_lab(db_session):
    await _seeded(db_session)
    region_of = await _region_of(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        unfiltered = await _get(client, "/capacity/hubs")
        all_matrix = await _get(client, "/capacity/utilization-matrix")
        for region, area_name in (("Greece", "Europe"), ("India", "India"),
                                  ("Romania", "Europe")):
            filtered = await _get(client, "/capacity/hubs", region=region)
            expected_rows = [r for r in unfiltered["rows"] if r["lab_region"] == region]
            assert filtered["rows"] == expected_rows
            (area,) = filtered["areas"]
            assert area["area"] == area_name
            assert area["lab_regions"] == [region]
            assert sorted(area["hubs"]) == sorted(r["hub"] for r in expected_rows)
            assert area["lab_load_weeks"] == expected_rows[0]["lab_load_weeks"]
            matrix = await _get(client, "/capacity/utilization-matrix", region=region)
            assert {c["lab_region"] for c in matrix["chambers"]} == {region}
            assert len(matrix["chambers"]) == sum(
                1 for c in all_matrix["chambers"] if c["lab_region"] == region
            )
            assert {e["hub"] for e in matrix["engineers"]} <= {
                h for h, r in region_of.items() if r == region
            }


# --- §2: region summary -----------------------------------------------------------------


async def test_region_summary_reconciles_with_pipeline_and_status_cards(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        summary = await _get(client, "/dashboard/region-summary")
        totals = await _get(client, "/dashboard/pipeline-totals")
        overview = await _get(client, "/dashboard/status-overview")
        regions = summary["regions"]
        assert [r["region"] for r in regions] == list(REGIONS)
        assert summary["total_count"] == totals["total_count"]
        assert sum(r["spillover_count"] for r in regions) == totals["spillover_count"]
        assert sum(r["newly_registered_count"] for r in regions) == totals["new_count"]
        for r in regions:
            assert r["total_count"] == r["spillover_count"] + r["newly_registered_count"]
            assert set(r["status_counts"]) == {s.value for s in ProjectStatus}
            # The region's own pipeline-totals card equals its chip.
            own = await _get(client, "/dashboard/pipeline-totals", region=r["region"])
            assert (own["total_count"], own["spillover_count"], own["new_count"]) == (
                r["total_count"], r["spillover_count"], r["newly_registered_count"]
            )
            assert r["share_pct"] == round(r["total_count"] / summary["total_count"] * 100, 2)
        # Status chips reconcile with the status-overview cards (all statuses).
        overview_by_status = {
            "In Buyoff": overview["in_buyoff"],
            "Under Industrialization": overview["under_industrialization"],
            "In Development": overview["in_development"],
            "In Queue": overview["in_queue"],
            **overview["other_counts"],
        }
        for status in ProjectStatus:
            count = sum(r["status_counts"][status.value] for r in regions)
            assert count == overview_by_status.get(status.value, 0), status
            if count:
                shares = sum(r["status_share_pct"][status.value] for r in regions)
                assert abs(shares - 100.0) <= 0.03
            else:
                assert all(r["status_share_pct"][status.value] == 0.0 for r in regions)
        assert abs(sum(r["share_pct"] for r in regions) - 100.0) <= 0.03

        # Filtered: the chosen region carries everything, the others are zero.
        india = await _get(client, "/dashboard/region-summary", region="India")
        india_row = next(r for r in regions if r["region"] == "India")
        filtered_india = next(r for r in india["regions"] if r["region"] == "India")
        assert india["total_count"] == india_row["total_count"]
        assert filtered_india["status_counts"] == india_row["status_counts"]
        assert all(
            r["total_count"] == 0 for r in india["regions"] if r["region"] != "India"
        )


async def test_region_summary_excludes_commercialized_from_pipeline_only(db_session):
    w = await _seeded(db_session)
    project = (
        await db_session.execute(
            select(Project).where(Project.hub_id == w.hubs["PD-Romania"].id).limit(1)
        )
    ).scalar_one()
    project.status = ProjectStatus.COMMERCIALIZED
    await db_session.flush()
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        summary = await _get(client, "/dashboard/region-summary")
        totals = await _get(client, "/dashboard/pipeline-totals")
    romania = next(r for r in summary["regions"] if r["region"] == "Romania")
    assert romania["status_counts"]["Commercialized"] >= 1
    assert summary["total_count"] == totals["total_count"]
    assert romania["total_count"] == sum(
        c for s, c in romania["status_counts"].items() if s != "Commercialized"
    )


# --- §3: the register ---------------------------------------------------------------------


async def test_projects_new_fields_and_no_financials(db_session):
    await _seeded(db_session)
    project = (await db_session.execute(select(Project).limit(1))).scalars().first()
    project.customer_name = "ACME SECRET CUSTOMER"
    project.tcogs_eur = 123456.78
    project.selling_price_eur = 234567.89
    project.gross_margin_pct = 42.42
    await db_session.flush()
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.get("/dashboard/projects")
        export = await client.get("/exports/dashboard", params={"format": "csv"})
    assert resp.status_code == 200
    body = resp.json()
    for secret in ("ACME SECRET CUSTOMER", "123456.78", "234567.89", "42.42"):
        assert secret not in resp.text
        assert secret not in export.text
    new_fields = {
        "external_code", "type", "region", "leader_name", "leader_engineer_id",
        "current_step_code", "current_step_name", "end_week", "outcome", "reg_year",
        "carry_over", "priority_rank",
    }
    for row in body["rows"]:
        assert new_fields <= set(row)
        assert not any(f in key for key in row for f in _FINANCIAL)
        assert row["outcome"] in (None, "WITHIN_YEAR", "SPILLOVER", "LEFT_OUT", "BLOCKED")
        # ADR 0028: leader names are served.
        assert (row["leader_name"] is not None) == (row["leader_engineer_id"] is not None)
    assert any(r["current_step_code"] for r in body["rows"])
    assert any(r["end_week"] is not None for r in body["rows"])
    assert any(r["external_code"] for r in body["rows"])


async def test_projects_end_week_and_outcome_follow_the_active_run(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        projects = await _get(client, "/dashboard/projects")
        within = await _get(client, "/dashboard/completing-within-year")
    by_id = {r["project_id"]: r for r in projects["rows"]}
    counts = {"WITHIN_YEAR": 0, "SPILLOVER": 0, "LEFT_OUT": 0, "BLOCKED": 0}
    for row in projects["rows"]:
        if row["outcome"] is not None:
            counts[row["outcome"]] += 1
    assert counts["WITHIN_YEAR"] == within["within_year_count"]
    assert counts["SPILLOVER"] == within["spillover_count"]
    assert counts["LEFT_OUT"] == within["left_out_count"]
    assert counts["BLOCKED"] == within["blocked_count"]
    for r in within["rows"]:
        assert by_id[r["project_id"]]["outcome"] is not None or not (
            r["within_year"] or r["spillover"] or r["left_out"] or r["blocked"]
        )


async def test_projects_q_matches_name_and_code_and_escapes_wildcards(db_session):
    await _seeded(db_session)
    project = (
        await db_session.execute(select(Project).order_by(Project.name).limit(1))
    ).scalar_one()
    project.external_code = "ZZ-100%_X"
    await db_session.flush()
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        everything = await _get(client, "/dashboard/projects")
        needle = project.name[1:5].upper()
        by_name = await _get(client, "/dashboard/projects", q=needle)
        expected = {
            r["project_id"] for r in everything["rows"]
            if needle.lower() in r["project_name"].lower()
            or needle.lower() in (r["external_code"] or "").lower()
        }
        assert {r["project_id"] for r in by_name["rows"]} == expected
        assert str(project.id) in expected
        by_code = await _get(client, "/dashboard/projects", q="zz-100%_x")
        assert [r["project_id"] for r in by_code["rows"]] == [str(project.id)]
        # `%` and `_` are literal: exactly the rows containing them match.
        for literal in ("%", "_", "0%_"):
            got = (await _get(client, "/dashboard/projects", q=literal))["rows"]
            assert {r["project_id"] for r in got} == {
                r["project_id"] for r in everything["rows"]
                if literal in r["project_name"] or literal in (r["external_code"] or "")
            }, literal
            assert str(project.id) in {r["project_id"] for r in got}
        assert [r["project_id"] for r in (await _get(
            client, "/dashboard/projects", q="0%_"))["rows"]] == [str(project.id)]
        # Blank q is no filter; over 100 characters is 422.
        assert (await _get(client, "/dashboard/projects", q="   "))["total_count"] == (
            everything["total_count"]
        )
        resp = await client.get("/dashboard/projects", params={"q": "x" * 101})
        assert resp.status_code == 422


async def test_projects_type_leader_and_current_step_filters(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        everything = (await _get(client, "/dashboard/projects"))["rows"]

        types = {r["type"] for r in everything if r["type"]}
        assert types
        for t in types:
            rows = (await _get(client, "/dashboard/projects", type=t))["rows"]
            assert {r["project_id"] for r in rows} == {
                r["project_id"] for r in everything if r["type"] == t
            }

        leader = next(r["leader_engineer_id"] for r in everything if r["leader_engineer_id"])
        rows = (await _get(client, "/dashboard/projects", leader_engineer_id=leader))["rows"]
        assert rows and {r["project_id"] for r in rows} == {
            r["project_id"] for r in everything if r["leader_engineer_id"] == leader
        }

        step = next(r["current_step_code"] for r in everything if r["current_step_code"])
        rows = (await _get(client, "/dashboard/projects", current_step=step))["rows"]
        assert rows and {r["project_id"] for r in rows} == {
            r["project_id"] for r in everything if r["current_step_code"] == step
        }
        assert {r["current_step_name"] for r in rows} == {
            r["current_step_name"] for r in everything if r["current_step_code"] == step
        }
        none = await _get(client, "/dashboard/projects", current_step="NOPE")
        assert none == {"total_count": 0, "rows": []}
        assert (await client.get("/dashboard/projects", params={"type": "XX"})).status_code == 422


async def test_projects_priority_rank_and_sort(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        by_name = (await _get(client, "/dashboard/projects"))["rows"]
        by_priority = (await _get(client, "/dashboard/projects", sort="priority"))["rows"]
        explicit_name = (await _get(client, "/dashboard/projects", sort="name"))["rows"]
        india = (await _get(client, "/dashboard/projects", region="India"))["rows"]
        bad = await client.get("/dashboard/projects", params={"sort": "score"})
    assert bad.status_code == 422
    # Default order is unchanged (by name, DB collation): `sort=name` is it.
    assert [r["project_id"] for r in by_name] == [r["project_id"] for r in explicit_name]
    assert sorted(r["project_id"] for r in by_priority) == sorted(
        r["project_id"] for r in by_name
    )
    ranks = [r["priority_rank"] for r in by_name if r["priority_rank"] is not None]
    assert sorted(ranks) == list(range(1, len(ranks) + 1))
    ranked = [r["priority_rank"] for r in by_priority if r["priority_rank"] is not None]
    assert ranked == sorted(ranked)
    # Unranked rows come last.
    first_null = next(
        (i for i, r in enumerate(by_priority) if r["priority_rank"] is None), len(by_priority)
    )
    assert all(r["priority_rank"] is None for r in by_priority[first_null:])
    # Rank is within the filtered set.
    india_ranks = [r["priority_rank"] for r in india if r["priority_rank"] is not None]
    assert sorted(india_ranks) == list(range(1, len(india_ranks) + 1))


async def test_leader_name_is_served_to_every_reader(db_session):
    await _seeded(db_session)
    user = await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    engineer = (
        await db_session.execute(
            select(Engineer)
            .join(Project, Project.leader_engineer_id == Engineer.id)
            .limit(1)
        )
    ).scalars().first()
    engineer.user_id = user.id
    await db_session.flush()
    async with _client(db_session) as client:
        rows = (await _get(client, "/dashboard/projects"))["rows"]
        facets = await _get(client, "/dashboard/projects/facets")
    for r in rows:
        if r["leader_engineer_id"] == str(engineer.id):
            assert r["leader_name"] == engineer.name
        elif r["leader_engineer_id"] is not None:
            assert r["leader_name"]  # ADR 0028
    for leader in facets["leaders"]:
        assert leader["name"]


async def test_facets_list_only_values_present_in_the_filtered_set(db_session):
    w = await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        for params in ({}, {"region": "India"}, {"hub_id": w.hubs["R&D-Greece"].id}):
            rows = (await _get(client, "/dashboard/projects", **params))["rows"]
            facets = await _get(client, "/dashboard/projects/facets", **params)
            assert {f["id"] for f in facets["leaders"]} == {
                r["leader_engineer_id"] for r in rows if r["leader_engineer_id"]
            }
            assert {(f["code"], f["name"]) for f in facets["steps"]} == {
                (r["current_step_code"], r["current_step_name"])
                for r in rows
                if r["current_step_code"]
            }
            assert len(facets["leaders"]) == len({f["id"] for f in facets["leaders"]})


async def test_dashboard_export_follows_region(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        india = await _get(client, "/dashboard/projects", region="India")
        export = await client.get("/exports/dashboard", params={"region": "India"})
    assert export.status_code == 200
    lines = [line for line in export.text.splitlines() if line.strip()]
    assert len(lines) - 1 == india["total_count"]


def test_facets_shape():
    """Pins `ProjectFacets` (the contract test cannot parse its inline TS
    element types): `{leaders: [{id, name|null}], steps: [{code, name}]}`."""

    schemas = app.openapi()["components"]["schemas"]
    facets = schemas["ProjectFacets"]
    assert set(facets["properties"]) == {"leaders", "steps"}
    leader = schemas["NamedId"]
    assert set(leader["properties"]) == {"id", "name"}
    assert {"type": "null"} in leader["properties"]["name"]["anyOf"]
    step = schemas["StepFacet"]
    assert set(step["properties"]) == {"code", "name"}
    assert set(step["required"]) == {"code", "name"}


# --- the predicate itself -----------------------------------------------------------------


def test_region_predicate_composes_with_scope_and_hub():
    a, b = uuid.uuid4(), uuid.uuid4()
    unrestricted = make_principal(RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)
    planner = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[a])

    assert global_hub_filter(Hub.id, None, None) is None
    only_region = narrowed_hub_filter(unrestricted, Hub.id, None, LabRegion.INDIA)
    assert only_region is not None and "lab_region" in str(only_region)
    both = narrowed_hub_filter(planner, Hub.id, b, LabRegion.GREECE)
    sql = str(both)
    assert sql.count(" AND ") >= 2 and "lab_region" in sql and "hubs.id = " in sql
    # The region value is a bound parameter, never interpolated.
    assert "Greece" not in sql and "GREECE" not in sql
