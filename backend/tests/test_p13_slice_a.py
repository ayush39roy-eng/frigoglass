"""P13 wave 2, slice A (docs/API_CONTRACT_P13.md §5): P13-T10, T16, T17 backend.

- `CompletingWithinYearRow.type`.
- `GET /dashboard/analytics`: shape, reconciliation with `/pipeline-totals`,
  `/hub-type-pipeline` and `/completing-within-year`, hub / region narrowing
  (never widens), empty `completing_*` without an active run, shares.
- `GET /workflow-settings/category-timelines` and `/b-equivalent`: the
  DOMAIN_RULES lead-time table walked over the DAG (strict chain and a
  parallel pair), ratios against B / B-OEM, RBAC.
- `q` on `GET /projects`.

Seed for the dashboard tests: the prototype demo seed, scheduled with the
real greedy scheduler and activated inside the per-test savepoint (same as
`test_p13_region_filter.py`).
"""

from __future__ import annotations

import uuid
from collections import Counter
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    ProjectType,
    RoleName,
    SolverType,
)
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRun
from scheduling.greedy import run_greedy_sgs
from scheduling.types import WorkflowStepTemplate as SchedTemplate
from scheduling.workflow import build_workflows
from seed import seed_demo_data
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from services.workflow_previews import category_preview, ratio
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_project, make_user

REGIONS = ("Greece", "India", "Romania")
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


async def _seeded(db_session, *, schedule: bool = True) -> SimpleNamespace:
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    run = None
    if schedule:
        schedule_input = await build_schedule_input_from_db(db_session)
        run = await persist_schedule_output(
            db_session, schedule_input, run_greedy_sgs(schedule_input),
            solver_type=SolverType.GREEDY, trigger_reason="test", activate=True,
        )
    return SimpleNamespace(hubs=hubs, run=run)


async def _get(client: AsyncClient, path: str, **params):
    resp = await client.get(path, params={k: str(v) for k, v in params.items()})
    assert resp.status_code == 200, (path, resp.text)
    return resp.json()


def _share(part: int, whole: int) -> float:
    return round(part / whole * 100, 2) if whole else 0.0


# --- T10: CompletingWithinYearRow.type ------------------------------------------------


async def test_completing_rows_carry_the_project_type(db_session):
    await _seeded(db_session)
    types = {
        str(pid): t.value if t is not None else None
        for pid, t in (await db_session.execute(select(Project.id, Project.type))).all()
    }
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _get(client, "/dashboard/completing-within-year")
    assert body["rows"]
    for row in body["rows"]:
        assert row["type"] == types[row["project_id"]]


# --- T10: GET /dashboard/analytics -------------------------------------------------------


async def test_analytics_shape_and_reconciliation(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _get(client, "/dashboard/analytics")
        totals = await _get(client, "/dashboard/pipeline-totals")
        hub_type = await _get(client, "/dashboard/hub-type-pipeline")
        cwy = await _get(client, "/dashboard/completing-within-year")

    assert set(body) == {
        "by_type", "by_category", "by_hub", "by_reg_year", "completing_hub_type",
        "completing_by_type", "completing_by_hub", "has_active_schedule_run",
    }
    assert body["has_active_schedule_run"] is True
    total = totals["total_count"]
    assert total > 0
    for key in ("by_type", "by_category", "by_hub", "by_reg_year"):
        buckets = body[key]
        assert sum(b["count"] for b in buckets) == total, key
        for b in buckets:
            assert set(b) == {"key", "count", "share_pct"}
            assert b["share_pct"] == _share(b["count"], total), (key, b)

    # Every type and category is listed (zeros included), "Unmapped" only if any.
    type_keys = [b["key"] for b in body["by_type"]]
    assert type_keys[: len(ProjectType)] == [t.value for t in ProjectType]
    assert type_keys[len(ProjectType):] in ([], ["Unmapped"])
    cat_keys = [b["key"] for b in body["by_category"]]
    assert cat_keys[: len(ProjectCategory)] == [c.value for c in ProjectCategory]
    assert cat_keys[len(ProjectCategory):] in ([], ["Unmapped"])
    assert {b["key"] for b in body["by_hub"]} == {h.value for h in HubName}

    # by_type / by_hub reconcile with the hub × type cross-tab.
    by_type = Counter()
    by_hub = Counter()
    cells = {}
    for r in hub_type:
        by_type[r["type"] or "Unmapped"] += r["count"]
        by_hub[r["hub"]] += r["count"]
        cells[(r["hub"], r["type"])] = r["count"]
    assert {b["key"]: b["count"] for b in body["by_type"] if b["count"]} == dict(by_type)
    assert {b["key"]: b["count"] for b in body["by_hub"] if b["count"]} == dict(by_hub)

    # by_reg_year against the live table (pipeline basis), "Unknown" last.
    years = Counter(
        y for (y,) in (await db_session.execute(select(Project.reg_year))).all()
    )
    expected_years = {str(y): c for y, c in years.items() if y is not None}
    if years.get(None):
        expected_years["Unknown"] = years[None]
    assert {b["key"]: b["count"] for b in body["by_reg_year"]} == expected_years
    year_keys = [b["key"] for b in body["by_reg_year"]]
    numeric = [k for k in year_keys if k != "Unknown"]
    assert numeric == sorted(numeric, key=int)
    assert "Unknown" not in year_keys[:-1]

    # completing_hub_type: one row per pipeline cell, completing from the run.
    assert {(r["hub"], r["type"]): r["pipeline_count"] for r in body["completing_hub_type"]} == (
        cells
    )
    statuses = dict((await db_session.execute(select(Project.id, Project.status))).all())
    within = Counter(
        (r["hub"], r["type"]) for r in cwy["rows"]
        if r["within_year"] and not r["blocked"]
    )
    for r in body["completing_hub_type"]:
        assert r["completing_count"] == within.get((r["hub"], r["type"]), 0), r
        assert r["completing_pct"] == _share(r["completing_count"], r["pipeline_count"])
    completing_total = sum(r["completing_count"] for r in body["completing_hub_type"])
    assert completing_total == sum(within.values())
    # Reconciliation with the Dashboard's within-year card (I9): since P17
    # (ADR 0030) the analytics basis includes Commercialized, which the run
    # marks `within_year` ("trivially done"), so the cross-tab total equals the
    # card exactly.
    commercialized_within = sum(
        1 for r in cwy["rows"]
        if r["within_year"] and not r["blocked"]
        and statuses[uuid.UUID(r["project_id"])] == ProjectStatus.COMMERCIALIZED
    )
    assert commercialized_within > 0  # the demo seed exercises the difference
    assert completing_total == cwy["within_year_count"]
    assert completing_total > 0

    # completing_by_type: same keys and order as by_type, sums per type.
    assert [r["key"] for r in body["completing_by_type"]] == type_keys
    done_by_type = Counter()
    for r in body["completing_hub_type"]:
        done_by_type[r["type"] or "Unmapped"] += r["completing_count"]
    for r, b in zip(body["completing_by_type"], body["by_type"], strict=True):
        assert r["pipeline_count"] == b["count"]
        assert r["completing_count"] == done_by_type.get(r["key"], 0)
        assert r["completing_pct"] == _share(r["completing_count"], r["pipeline_count"])

    # completing_by_hub: the per-hub Total column, the sum of that hub's cells,
    # hubs with pipeline > 0 only, in by_hub order.
    hub_pipeline = Counter()
    hub_done = Counter()
    for r in body["completing_hub_type"]:
        hub_pipeline[r["hub"]] += r["pipeline_count"]
        hub_done[r["hub"]] += r["completing_count"]
    hub_order = [b["key"] for b in body["by_hub"] if b["count"] > 0]
    assert [r["key"] for r in body["completing_by_hub"]] == hub_order
    for r in body["completing_by_hub"]:
        assert set(r) == {"key", "pipeline_count", "completing_count", "completing_pct"}
        assert r["pipeline_count"] == hub_pipeline[r["key"]] > 0
        assert r["completing_count"] == hub_done[r["key"]]
        assert r["completing_pct"] == _share(r["completing_count"], r["pipeline_count"])
    assert sum(r["pipeline_count"] for r in body["completing_by_hub"]) == total
    assert sum(r["completing_count"] for r in body["completing_by_hub"]) == completing_total

    text = str(body).lower()
    for field in _FINANCIAL:
        assert field not in text


async def test_analytics_includes_commercialized(db_session):
    await _seeded(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        before = await _get(client, "/dashboard/analytics")
        project = (
            await db_session.execute(
                select(Project).where(Project.status != ProjectStatus.COMMERCIALIZED).limit(1)
            )
        ).scalar_one()
        project.status = ProjectStatus.COMMERCIALIZED
        await db_session.flush()
        after = await _get(client, "/dashboard/analytics")
        totals = await _get(client, "/dashboard/pipeline-totals")
    # ADR 0030: the status change moves nothing out of the basis.
    assert sum(b["count"] for b in after["by_hub"]) == (
        sum(b["count"] for b in before["by_hub"])
    ) == totals["total_count"]
    for r in after["completing_hub_type"]:
        assert r["completing_count"] <= r["pipeline_count"]


async def test_analytics_without_active_run_has_empty_completing_lists(db_session):
    await _seeded(db_session, schedule=False)
    assert (
        await db_session.execute(select(ScheduleRun).where(ScheduleRun.is_active.is_(True)))
    ).scalar_one_or_none() is None
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        body = await _get(client, "/dashboard/analytics")
        totals = await _get(client, "/dashboard/pipeline-totals")
    assert body["has_active_schedule_run"] is False
    assert body["completing_hub_type"] == []
    assert body["completing_by_type"] == []
    assert body["completing_by_hub"] == []
    assert sum(b["count"] for b in body["by_type"]) == totals["total_count"] > 0


async def test_analytics_region_and_hub_narrowing(db_session):
    w = await _seeded(db_session)
    region_of = {
        h.name.value: h.lab_region.value for h in (await db_session.execute(select(Hub))).scalars()
    }
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        everything = await _get(client, "/dashboard/analytics")
        for region in REGIONS:
            body = await _get(client, "/dashboard/analytics", region=region)
            totals = await _get(client, "/dashboard/pipeline-totals", region=region)
            assert {b["key"] for b in body["by_hub"]} == {
                h for h, r in region_of.items() if r == region
            }
            assert sum(b["count"] for b in body["by_type"]) == totals["total_count"]
            assert body["completing_hub_type"] == [
                r for r in everything["completing_hub_type"] if region_of[r["hub"]] == region
            ]
            assert body["completing_by_hub"] == [
                r for r in everything["completing_by_hub"] if region_of[r["key"]] == region
            ]
            for b in body["by_type"]:
                assert b["share_pct"] == _share(b["count"], totals["total_count"])
        pd_india = w.hubs["PD-India"].id
        anded = await _get(client, "/dashboard/analytics", hub_id=pd_india, region="Greece")
        assert anded["by_hub"] == []
        assert all(b["count"] == 0 for b in anded["by_type"])
        assert anded["completing_hub_type"] == []
        assert await _get(client, "/dashboard/analytics", hub_id=pd_india, region="India") == (
            await _get(client, "/dashboard/analytics", hub_id=pd_india)
        )
        resp = await client.get("/dashboard/analytics", params={"region": "Europe"})
        assert resp.status_code == 422


async def test_analytics_never_widens_the_hub_planner_scope(db_session):
    w = await _seeded(db_session)
    greece = w.hubs["R&D-Greece"]
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with _client(db_session) as client:
        own = await _get(client, "/dashboard/analytics")
        assert [b["key"] for b in own["by_hub"]] == ["R&D-Greece"]
        assert await _get(client, "/dashboard/analytics", region="Greece") == own
        for region in ("India", "Romania"):
            body = await _get(client, "/dashboard/analytics", region=region)
            assert body["by_hub"] == [] and body["by_reg_year"] == []
            assert all(b["count"] == 0 and b["share_pct"] == 0.0 for b in body["by_type"])
            assert body["completing_hub_type"] == body["completing_by_hub"] == []
            assert all(r["pipeline_count"] == 0 for r in body["completing_by_type"])
        other = await _get(client, "/dashboard/analytics", hub_id=w.hubs["PD-India"].id)
        assert other["by_hub"] == []


async def test_analytics_requires_dashboard_read(db_session):
    await _act_as(db_session, RoleName.ENGINEER)
    async with _client(db_session) as client:
        resp = await client.get("/dashboard/analytics")
    assert resp.status_code == 403


# --- T16: workflow previews -----------------------------------------------------------

# DOMAIN_RULES "Lead times": (design_weeks, lab_weeks, total_weeks) per category.
_PDD_EXPECTED = {"A+": (22, 12, 44), "A": (18, 10, 38), "B": (10, 6, 18), "C": (6, 1, 8)}
_OEM_EXPECTED = {"A-OEM": (9, 8, 21), "B-OEM": (5, 6, 14), "C-OEM": (2, 2, 4)}


async def test_category_timelines_follow_the_lead_time_table(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        pdd = await _get(client, "/workflow-settings/category-timelines", workflow="PDD")
        oem = await _get(client, "/workflow-settings/category-timelines", workflow="OEM")
        default = await _get(client, "/workflow-settings/category-timelines")
    assert default == pdd
    for body, expected in ((pdd, _PDD_EXPECTED), (oem, _OEM_EXPECTED)):
        assert [c["category"] for c in body] == list(expected)
        for c in body:
            assert set(c) == {"category", "total_weeks", "design_weeks", "lab_weeks", "steps"}
            assert (c["design_weeks"], c["lab_weeks"], c["total_weeks"]) == expected[
                c["category"]
            ]
            assert len(c["steps"]) == 14
            # Strict chain: each step starts where the previous one ends.
            cursor = 0
            for s in c["steps"]:
                assert set(s) == {
                    "code", "name", "resource_kind", "start_week", "duration_weeks",
                }
                assert s["start_week"] == cursor
                cursor += s["duration_weeks"]
            assert cursor == c["total_weeks"]
    b = next(c for c in pdd if c["category"] == "B")
    assert b["steps"][4] == {
        "code": "PDD-E", "name": "Design Detailing", "resource_kind": "design",
        "start_week": 2, "duration_weeks": 4,
    }
    # PDD-B and PDD-C are 0 for B: skipped, transparent (start = end = pred end).
    assert [(s["start_week"], s["duration_weeks"]) for s in b["steps"][1:3]] == [(1, 0), (1, 0)]


async def test_category_timelines_follow_a_parallel_dag(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        settings = await _get(client, "/workflow-settings")
        steps = [
            {"step_id": s["step_id"], "kind": s["kind"], "predecessor_ids": s["predecessor_ids"]}
            for s in next(w for w in settings["workflows"] if w["id"] == "PDD")["steps"]
        ]
        # TF-1 (PDD-I) runs beside Certification (PDD-H); Pre-Production waits for both.
        steps[8]["predecessor_ids"] = ["PDD-G"]
        steps[9]["predecessor_ids"] = ["PDD-H", "PDD-I"]
        resp = await client.put("/workflow-settings/steps/PDD", json={"steps": steps})
        assert resp.status_code == 200, resp.text
        pdd = await _get(client, "/workflow-settings/category-timelines", workflow="PDD")
    a_plus = next(c for c in pdd if c["category"] == "A+")
    by_code = {s["code"]: s for s in a_plus["steps"]}
    assert by_code["PDD-H"]["start_week"] == by_code["PDD-I"]["start_week"] == 28
    assert by_code["PDD-J"]["start_week"] == 34
    # The critical path drops TF-1's 2 weeks; the design sum does not.
    assert (a_plus["total_weeks"], a_plus["design_weeks"]) == (42, 22)


async def test_b_equivalent_ratios(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        pdd = await _get(client, "/workflow-settings/b-equivalent", workflow="PDD")
        oem = await _get(client, "/workflow-settings/b-equivalent", workflow="OEM")
        timelines = await _get(client, "/workflow-settings/category-timelines", workflow="PDD")
    assert pdd == [
        {"category": "A+", "design_weeks": 22, "lab_weeks": 12, "design_ratio": 2.2,
         "lab_ratio": 2.0},
        {"category": "A", "design_weeks": 18, "lab_weeks": 10, "design_ratio": 1.8,
         "lab_ratio": 1.67},
        {"category": "B", "design_weeks": 10, "lab_weeks": 6, "design_ratio": 1.0,
         "lab_ratio": 1.0},
        {"category": "C", "design_weeks": 6, "lab_weeks": 1, "design_ratio": 0.6,
         "lab_ratio": 0.17},
    ]
    assert oem == [
        {"category": "A-OEM", "design_weeks": 9, "lab_weeks": 8, "design_ratio": 1.8,
         "lab_ratio": 1.33},
        {"category": "B-OEM", "design_weeks": 5, "lab_weeks": 6, "design_ratio": 1.0,
         "lab_ratio": 1.0},
        {"category": "C-OEM", "design_weeks": 2, "lab_weeks": 2, "design_ratio": 0.4,
         "lab_ratio": 0.33},
    ]
    # Same figures as the timelines.
    assert [(r["design_weeks"], r["lab_weeks"]) for r in pdd] == [
        (c["design_weeks"], c["lab_weeks"]) for c in timelines
    ]


async def test_b_equivalent_follows_a_lead_time_edit_and_zero_reference_is_null(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    rows = [
        {"workflow_id": "PDD", "category": "B", "step_id": "PDD-F", "weeks": 0},
        {"workflow_id": "PDD", "category": "B", "step_id": "PDD-H", "weeks": 0},
    ]
    async with _client(db_session) as client:
        resp = await client.put("/workflow-settings/lead-times", json={"lead_times": rows})
        assert resp.status_code == 200, resp.text
        pdd = await _get(client, "/workflow-settings/b-equivalent", workflow="PDD")
    b = next(r for r in pdd if r["category"] == "B")
    assert (b["lab_weeks"], b["lab_ratio"], b["design_ratio"]) == (0, None, 1.0)
    assert all(r["lab_ratio"] is None for r in pdd)


@pytest.mark.parametrize(
    "role,code", [(RoleName.ADMIN, 200), (RoleName.SUPER_ADMIN, 200), (RoleName.HUB_PLANNER, 403),
                  (RoleName.PORTFOLIO_MANAGER, 403), (RoleName.ENGINEER, 403)],
)
async def test_previews_rbac(db_session, role, code):
    await _act_as(db_session, role, hub_ids=[] if role == RoleName.HUB_PLANNER else None)
    async with _client(db_session) as client:
        for path in ("/workflow-settings/category-timelines", "/workflow-settings/b-equivalent"):
            resp = await client.get(path)
            assert resp.status_code == code, (role, path, resp.text)


async def test_previews_reject_an_unknown_workflow(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        for path in ("/workflow-settings/category-timelines", "/workflow-settings/b-equivalent"):
            resp = await client.get(path, params={"workflow": "XYZ"})
            assert resp.status_code == 422, path


def test_category_preview_is_pure_and_walks_parallel_branches():
    templates = (
        SchedTemplate("W", "W-A", "A", "a", "design", 1, ()),
        SchedTemplate("W", "W-B", "B", "b", "lab", 2, ("W-A",)),
        SchedTemplate("W", "W-C", "C", "c", "elapsed", 3, ("W-A",)),
        SchedTemplate("W", "W-D", "D", "d", "design", 4, ("W-B", "W-C")),
    )
    workflow = build_workflows(templates)["W"]
    preview = category_preview(workflow, ProjectCategory.A, {"W-A": 2, "W-B": 5, "W-C": 3})
    assert [(s.step_id, s.start_week, s.duration_weeks) for s in preview.steps] == [
        ("W-A", 0, 2), ("W-B", 2, 5), ("W-C", 2, 3), ("W-D", 7, 0),
    ]
    assert (preview.total_weeks, preview.design_weeks, preview.lab_weeks) == (7, 2, 5)
    assert ratio(5, 3) == 1.67 and ratio(1, 0) is None


# --- T17: q on GET /projects ----------------------------------------------------------


async def test_projects_list_q_matches_name_or_code_literally_and_stays_scoped(db_session):
    greece = await make_hub(db_session)
    romania = await make_hub(
        db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA
    )
    match_name = await make_project(db_session, greece, name="Cooler Alpha")
    match_code = await make_project(
        db_session, greece, name="Fridge", external_code="24-ALP_1%"
    )
    await make_project(db_session, greece, name="Other", external_code="24-00001")
    hidden = await make_project(db_session, romania, name="Alpha Romania")
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with _client(db_session) as client:
        got = await _get(client, "/projects", q="  alp ")
        assert [r["id"] for r in got] == [str(match_name.id), str(match_code.id)]
        assert str(hidden.id) not in {r["id"] for r in got}
        assert [r["id"] for r in await _get(client, "/projects", q="_1%")] == [
            str(match_code.id)
        ]
        assert await _get(client, "/projects", q="%") == [
            r for r in await _get(client, "/projects") if r["id"] == str(match_code.id)
        ]
        assert len(await _get(client, "/projects", q="   ")) == 3
        assert await _get(client, "/projects", q="alpha", status_="Commercialized") == []
        resp = await client.get("/projects", params={"q": "x" * 101})
        assert resp.status_code == 422


async def test_registration_export_follows_q_sync_and_job_path(db_session):
    import csv
    import io

    from models.enums import ExportSurface
    from services.export_builder import build_export_sheets

    hub = await make_hub(db_session)
    alpha = await make_project(db_session, hub, name="Cooler Alpha")
    coded = await make_project(db_session, hub, name="Fridge", external_code="24-ALP_1%")
    await make_project(db_session, hub, name="Other", external_code="24-00001")
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.get(
            "/exports/project-registration", params={"format": "csv", "q": " alp "}
        )
        assert resp.status_code == 200, resp.text
        rows = list(csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))))
        assert [r["id"] for r in rows] == [str(alpha.id), str(coded.id)]
        resp = await client.get(
            "/exports/project-registration", params={"format": "csv", "q": "_1%"}
        )
        rows = list(csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig"))))
        assert [r["id"] for r in rows] == [str(coded.id)]
        resp = await client.get(
            "/exports/project-registration", params={"format": "csv", "q": "x" * 101}
        )
        assert resp.status_code == 422
    # The async job path calls the same builder with the stored filter dict.
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)
    sheets = await build_export_sheets(
        db_session, principal, surface=ExportSurface.PROJECT_REGISTRATION.value,
        filters={"hub_id": None, "category": None, "status_": None, "priority": None,
                 "type_": None, "q": "alpha"},
    )
    _, data = sheets["Projects"]
    assert [row["id"] for row in data] == [str(alpha.id)]
