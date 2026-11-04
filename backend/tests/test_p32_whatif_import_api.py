"""P32-T04: `POST /whatif/import/parse` and `/whatif/import/simulate` (ADR 0044, B2/B3).

Disposable Postgres (the shared testcontainers fixture); the real engine
(`scheduling.plan_import.run_plan_import`); synthetic workbooks only. Covered:
the role matrix, 401, 413 / 422 / 429 / 503, the parse mapping against the
plan (matching, roster, scope), merge replacing a matched project, file_only,
In Development rows, edits, new-designer dedupe, auto-assign, expand_multi,
include=false, caps, hub scoping of what is returned (KPIs recomputed),
the pure-read proof and the audit rows (counts and digests only).
"""

from __future__ import annotations

import hashlib
import json
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

import api.routers.whatif as whatif_router
import services.whatif_import as import_service
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
from scheduling.plan_import import run_plan_import
from scheduling.whatif import WhatIfBudgetExceeded
from schemas.whatif_import import ImportSimulateRequest
from services.rate_limit import TokenBucketLimiter
from services.whatif_baseline import load_context
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_chamber, make_engineer, make_hub, make_project, make_user
from tests.plan_import_helpers import SECRET_CUSTOMER, SECRET_NOTE, build_workbook, row

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
GR_ENGINEER = "Kanarios Hiddenname"
IN_ENGINEER = "Lokesh Hiddenname"
RI_ENGINEER = "Ashish Hiddenname"


@pytest.fixture(autouse=True)
def _cleanup():
    whatif_router.WHATIF_RATE_LIMIT.reset()
    yield
    whatif_router.WHATIF_RATE_LIMIT.reset()
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
            *roles, user_id=user.id, email=user.email, hub_scope_all=scope_all,
            hub_ids=hub_ids or [],
        )
    )  # fmt: skip
    return user


async def make_world(db_session) -> SimpleNamespace:
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    ind = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    ri = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    for hub in (gr, ind, ri):
        db_session.add(
            HubWorkCalendar(
                hub_id=hub.id, weekdays_per_week=5, national_holiday_days=10,
                medical_leave_days=5, casual_leave_days=5, annual_leave_days=20,
            )
        )  # fmt: skip
    cats = [EngineerAllowedCategory.A_PLUS, EngineerAllowedCategory.A, EngineerAllowedCategory.B,
            EngineerAllowedCategory.C]  # fmt: skip
    eng_gr = await make_engineer(db_session, gr, name=GR_ENGINEER, allowed_categories=cats)
    eng_in = await make_engineer(db_session, ind, name=IN_ENGINEER, allowed_categories=cats)
    eng_ri = await make_engineer(db_session, ri, name=RI_ENGINEER, allowed_categories=cats)
    ghost = await make_engineer(db_session, ind, name="Ghosty", allowed_categories=cats, fte=0.0)
    for code, region in (("CH-GR-1", LabRegion.GREECE), ("CH-IN-1", LabRegion.INDIA)):
        await make_chamber(
            db_session, code=code, lab_region=region, max_concurrent=2,
            allowed_stages=["PDD-F", "PDD-H"],
        )  # fmt: skip
    common = dict(category=ProjectCategory.C, status=ProjectStatus.IN_QUEUE,
                  customer_name=SECRET_CUSTOMER)  # fmt: skip
    alpha = await make_project(
        db_session, gr, leader=eng_gr, name="Alpha Cooler", external_code="26-00001",
        priority=ProjectPriority.P2, **common,
    )  # fmt: skip
    gamma = await make_project(db_session, gr, leader=eng_gr, name="Gamma Cooler",
                               priority=ProjectPriority.P3, **common)  # fmt: skip
    beta = await make_project(
        db_session, ind, leader=eng_in, name="Beta Cooler", external_code="26-00002",
        priority=ProjectPriority.P1, **common,
    )  # fmt: skip
    common["status"] = ProjectStatus.ON_HOLD
    delta = await make_project(db_session, ind, leader=eng_in, name="Delta Held",
                               priority=ProjectPriority.P4, **common)  # fmt: skip
    await db_session.flush()
    return SimpleNamespace(
        gr=gr, ind=ind, ri=ri, eng_gr=eng_gr, eng_in=eng_in, eng_ri=eng_ri, ghost=ghost,
        alpha=alpha, gamma=gamma, beta=beta, delta=delta,
    )  # fmt: skip


def standard_file() -> bytes:
    return build_workbook(
        [
            row(sn=1, name="alpha  cooler", code="NEW", hub="Greece", category="C",
                status="Que", engineer="Kanarios"),
            row(sn=2, name="Beta renamed", code="26-00002", hub="India", category="C",
                status="Que", engineer="Lokesh Sharma", priority=1),
            row(sn=3, name="Fresh Auto", hub="Greece", category="C", status="Que"),
            row(sn=4, name="Fresh New", hub="Greece", category="C", status="Que",
                engineer="Zed Newperson"),
            row(sn=5, name="Fresh Dev", hub="India", category="A", stage="PDD-E",
                status="Development", engineer="Ashish Kumar"),
        ]
    )  # fmt: skip


async def parse(c: AsyncClient, data: bytes, name: str = "plan.xlsx", ctype: str = XLSX):
    return await c.post("/whatif/import/parse", files={"file": (name, data, ctype)})


async def table_counts(db_session) -> dict[str, int]:
    out = {}
    for model in (
        Project, Engineer, Chamber, Hub, HubWorkCalendar, ScheduleRun, ScheduleRunProjectStep,
        ScheduleRunProjectOutcome, ProjectWorkflowStep,
    ):  # fmt: skip
        out[model.__tablename__] = (
            await db_session.execute(select(func.count()).select_from(model))
        ).scalar_one()
    return out


async def audit_rows(db_session, action: str) -> list[AuditLogEntry]:
    return list(
        (await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.action == action)))
        .scalars()
        .all()
    )


def sim_body(rows: list[dict[str, Any]], **kw: Any) -> dict[str, Any]:
    return {"rows": rows, **kw}


# --- RBAC -------------------------------------------------------------------------------------


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
        resp = await parse(c, standard_file())
        assert resp.status_code == (200 if allowed else 403), resp.text
        sim = await c.post("/whatif/import/simulate", json=sim_body([]))
        assert sim.status_code == (200 if allowed else 403), sim.text


async def test_unauthenticated_is_401(db_session):
    await make_world(db_session)
    async with client_for(db_session) as c:
        assert (await parse(c, standard_file())).status_code == 401
        assert (await c.post("/whatif/import/simulate", json=sim_body([]))).status_code == 401


# --- parse --------------------------------------------------------------------------------


async def test_parse_maps_against_the_plan_and_audits_counts_only(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    data = standard_file()
    async with client_for(db_session) as c:
        resp = await parse(c, data, name="../../2027 plan.xlsx")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["file_name"] == "2027 plan.xlsx"
    assert body["projects_sheet"] == "draft 1 291026" and body["steps_sheet"] == "Process steps"
    assert body["base_year"] == 2026 and isinstance(body["current_week"], int)
    assert len(body["steps_meta"]) == 28 and len(body["lead_times"]) == 9
    assert {r["name"] for r in body["roster"]} == {GR_ENGINEER, IN_ENGINEER, RI_ENGINEER}
    rows = {r["sn"]: r for r in body["rows"]}
    assert rows["1"]["matched_project_id"] == str(world.alpha.id)
    assert rows["1"]["match_by"] == "name" and rows["1"]["priority"] == "P2"
    assert rows["1"]["priority_source"] == "matched"
    assert rows["1"]["leader"] == {"kind": "existing", "engineer_id": str(world.eng_gr.id),
                                   "name": GR_ENGINEER}  # fmt: skip
    assert rows["2"]["matched_project_id"] == str(world.beta.id) and rows["2"]["match_by"] == "code"
    assert (rows["2"]["rank"], rows["2"]["priority"]) == (1, "P1")
    assert rows["3"]["leader"] == {"kind": "auto"} and rows["3"]["priority"] == "P3"
    assert rows["4"]["leader"] == {"kind": "new", "name": "Zed Newperson"}
    assert rows["5"]["hub"] == "R&D-India"  # India + an R&D-India leader
    assert rows["5"]["stage_step_id"] == "PDD-E" and rows["5"]["status"] == "In Development"
    assert body["counts"] == {"rows": 5, "schedulable": 5, "not_scheduled": 0, "matched": 2,
                              "new": 3, "auto_assign": 1, "new_designers": 1,
                              "projects_after_expansion": 5, "derived_status": 0,
                              "not_a_project": 0}  # fmt: skip
    for secret in (SECRET_CUSTOMER, SECRET_NOTE, "secret business case"):
        assert secret not in resp.text

    (audit,) = await audit_rows(db_session, "whatif.import_parse")
    state = audit.after_state
    assert state["scenario"]["file_sha256"] == hashlib.sha256(data).hexdigest()
    assert state["scenario"]["counts"]["rows"] == 5
    blob = json.dumps(state)
    for leak in ("alpha", "Alpha", "Fresh", "Zed", "Kanarios", "plan.xlsx", SECRET_CUSTOMER):
        assert leak not in blob


async def test_parse_hub_planner_scope(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        resp = await parse(c, standard_file())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    rows = {r["sn"]: r for r in body["rows"]}
    assert rows["1"]["matched_project_id"] == str(world.alpha.id)
    # Beta is outside the scope: never matched (so its existence does not leak).
    assert rows["2"]["matched_project_id"] is None
    assert "Beta Cooler" not in resp.text
    # Roster: the caller's designers plus those the file itself named.
    assert {r["name"] for r in body["roster"]} == {GR_ENGINEER, IN_ENGINEER, RI_ENGINEER}
    async with client_for(db_session) as c:
        only_gr = await parse(c, build_workbook([row(name="x", hub="Greece", status="Que")]))
    assert {r["name"] for r in only_gr.json()["roster"]} == {GR_ENGINEER}


async def test_parse_errors(db_session, monkeypatch):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        big = await parse(c, b"PK\x03\x04" + b"0" * (5 * 1024 * 1024))
        assert big.status_code == 413 and big.json()["code"] == "FILE_TOO_LARGE"
        for name, data in (
            ("plan.csv", b"Project description,Status\nx,Que\n"),
            ("plan.xlsx", b"Project description,Status\nx,Que\n"),
            ("plan.xlsx", b"PK\x03\x04garbage"),
            ("plan.xlsx", b""),
            ("plan", standard_file()),
            ("plan.xlsx", build_workbook([row(name="x")], headers=("Foo", "Bar"))),
        ):
            resp = await parse(c, data, name=name)
            assert resp.status_code == 422, (name, resp.text)
            assert resp.json()["code"] == "IMPORT_FORMAT"
        headerless = await parse(c, build_workbook([row(name="x")], headers=("Foo", "Bar")))
        assert "Project description" in headerless.json()["detail"]
        too_many = await parse(
            c, build_workbook([row(name=f"P{i}", status="Que") for i in range(2001)])
        )
        assert too_many.status_code == 422 and too_many.json()["code"] == "IMPORT_FORMAT"
        assert (await c.post("/whatif/import/parse")).status_code == 422  # no file part

    monkeypatch.setattr(whatif_router, "WHATIF_RATE_LIMIT", TokenBucketLimiter(1, 0.001))
    async with client_for(db_session) as c:
        assert (await parse(c, standard_file())).status_code == 200
        limited = await parse(c, standard_file())
        assert limited.status_code == 429 and limited.headers["Retry-After"]
        limited_sim = await c.post("/whatif/import/simulate", json=sim_body([]))
        assert limited_sim.status_code == 429
    assert len(await audit_rows(db_session, "whatif.import_parse")) == 1


# --- simulate -------------------------------------------------------------------------------


async def _parsed_rows(c: AsyncClient, data: bytes | None = None) -> list[dict[str, Any]]:
    resp = await parse(c, data or standard_file())
    assert resp.status_code == 200, resp.text
    return resp.json()["rows"]


async def test_simulate_merge_replaces_matched_projects(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    before = await table_counts(db_session)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        resp = await c.post("/whatif/import/simulate", json=sim_body(rows))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "merge" and body["plan_year_end_week"] == 104
    assert body["horizon_weeks"] == 130 and body["base_year"] == 2026
    projects = body["projects"]
    refs = [p["ref"] for p in projects]
    assert refs[:5] == [r["key"] for r in rows]  # file rows first, in file order
    plan_refs = [p["ref"] for p in projects if p["source"] == "plan"]
    # Alpha and Beta are replaced by their file rows; Delta (On Hold) is excluded.
    assert plan_refs == [str(world.gamma.id)]
    by_sn = {r["sn"]: r["key"] for r in rows}
    alpha_row = next(p for p in projects if p["ref"] == by_sn["1"])
    assert alpha_row["replaces_project_id"] == str(world.alpha.id)
    assert alpha_row["before_outcome"] is not None
    assert alpha_row["leader_name"] == GR_ENGINEER
    kpis = body["kpis"]
    assert (kpis["file_projects"], kpis["plan_projects"]) == (5, 2)  # Gamma + Delta
    assert kpis["projects_total"] == 7 and kpis["excluded"] == 1
    assert kpis["before_within_plan_year"] is not None

    auto = next(p for p in projects if p["ref"] == by_sn["3"])
    # The What-if picker: the least-loaded designer of the capacity hub (here the
    # new designer, who leads only one project).
    assert auto["leader_auto_assigned"] is True
    assert auto["leader_name"] in (GR_ENGINEER, "Zed Newperson")
    codes = {(i["ref"], i["code"]) for i in body["issues"]}
    assert (by_sn["3"], "LEADER_AUTO_ASSIGNED") in codes
    assert (by_sn["4"], "NEW_DESIGNER") in codes
    new_p = next(p for p in projects if p["ref"] == by_sn["4"])
    assert new_p["leader_ref"] == "new:1" and new_p["leader_name"] == "Zed Newperson"
    new_designers = [d for d in body["capacity"]["designers"] if d["is_new"]]
    assert [(d["ref"], d["name"], d["hub"]) for d in new_designers] == [
        ("new:1", "Zed Newperson", "R&D-Greece")
    ]

    # In Development at PDD-E: A..D done before the import, E In Progress from today.
    dev = next(p for p in projects if p["ref"] == by_sn["5"])
    steps = {s["step_id"]: s for s in dev["steps"]}
    assert len(dev["steps"]) == 14
    for sid in ("PDD-A", "PDD-B", "PDD-C", "PDD-D"):
        assert steps[sid]["done_before_import"] and steps[sid]["status"] == "Done"
        assert steps[sid]["editable"] == "none"
    assert steps["PDD-E"]["status"] == "In Progress" and steps["PDD-E"]["editable"] == "resize"
    assert steps["PDD-E"]["start_week"] == body["current_week"]
    assert steps["PDD-F"]["editable"] == "move_resize"
    assert any(s["chamber_code"] for s in dev["steps"] if s["kind"] == "lab" and not s["skipped"])

    cap = body["capacity"]
    assert {w["key"] for w in cap["windows"]} == {"y0", "y1"}
    assert {h["hub"] for h in cap["hubs"]} >= {"R&D-Greece", "PD-India", "R&D-India"}
    assert cap["weekly"]["weeks"][0] == body["current_week"] and cap["weekly"]["weeks"][-1] == 104
    assert await table_counts(db_session) == before  # nothing persisted


async def test_admin_kpis_equal_the_engine(db_session):
    await make_world(db_session)
    user = await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        body = (await c.post("/whatif/import/simulate", json=sim_body(rows))).json()
    from tests.auth_helpers import make_principal as mp

    ctx = await load_context(db_session, mp(RoleName.ADMIN, user_id=user.id))
    er = import_service.to_engine_request(ctx, ImportSimulateRequest.model_validate(sim_body(rows)))
    raw = run_plan_import(ctx.baseline, er.request)
    assert body["kpis"] == vars(raw.kpis)
    assert body["workings"] == list(raw.workings)


async def test_simulate_file_only(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        resp = await c.post(
            "/whatif/import/simulate",
            json=sim_body(rows, mode="file_only", plan_year_end_week=52),
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "file_only" and body["horizon_weeks"] == 78
    assert all(p["source"] == "file" for p in body["projects"])
    assert all(p["before_outcome"] is None for p in body["projects"])
    k = body["kpis"]
    assert k["plan_projects"] == 0 and k["file_projects"] == 5
    assert k["before_within_plan_year"] is None and k["after_within_plan_year_existing"] is None
    assert body["changes"] == {"newly_slipping": [], "recovered": [], "moved": []}
    assert [w["key"] for w in body["capacity"]["windows"]] == ["y0"]


async def test_simulate_edits(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        key = rows[2]["key"]  # Fresh Auto, category C
        edits = [
            {"project_ref": key, "step_id": "PDD-E", "duration_weeks": 7},
            {"project_ref": key, "step_id": "PDD-J", "start_not_before_week": 80},
            {"project_ref": str(world.gamma.id), "step_id": "PDD-E", "duration_weeks": 9},
        ]
        resp = await c.post("/whatif/import/simulate", json=sim_body(rows, edits=edits))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        file_p = next(p for p in body["projects"] if p["ref"] == key)
        steps = {s["step_id"]: s for s in file_p["steps"]}
        assert steps["PDD-E"]["duration_weeks"] == 7
        assert steps["PDD-J"]["start_week"] >= 80
        assert steps["PDD-J"]["start_not_before_week"] == 80
        gamma = next(p for p in body["projects"] if p["ref"] == str(world.gamma.id))
        assert {s["step_id"]: s for s in gamma["steps"]}["PDD-E"]["duration_weeks"] == 9

        assert gamma["within_plan_year"] is (gamma["outcome"] == "within_year")
        assert gamma["lab_overlap"] is False and gamma["no_leader"] is False

        # Stale edits are dropped, not rejected (orchestrator ruling): an unknown
        # row, an unknown project id, a plan project replaced by a match, a step
        # done before the import, a step skipped for the category, and a floor
        # on a started step (narrowed to nothing).
        dev = rows[4]["key"]  # Fresh Dev: In Development at PDD-E
        stale = [
            {"project_ref": "row-999", "step_id": "PDD-E", "duration_weeks": 3},
            {"project_ref": "00000000-0000-0000-0000-000000000000", "step_id": "PDD-E",
             "duration_weeks": 3},
            {"project_ref": str(world.alpha.id), "step_id": "PDD-E", "duration_weeks": 3},
            {"project_ref": dev, "step_id": "PDD-B", "duration_weeks": 3},
            {"project_ref": key, "step_id": "PDD-B", "duration_weeks": 3},
            {"project_ref": dev, "step_id": "PDD-E", "start_not_before_week": 70},
        ]  # fmt: skip
        r = await c.post("/whatif/import/simulate", json=sim_body(rows, edits=stale))
        assert r.status_code == 200, r.text
        base = await c.post("/whatif/import/simulate", json=sim_body(rows))
        assert r.json()["projects"] == base.json()["projects"]
        # A started step keeps a duration edit.
        r = await c.post(
            "/whatif/import/simulate",
            json=sim_body(rows, edits=[{"project_ref": dev, "step_id": "PDD-E",
                                        "duration_weeks": 9, "start_not_before_week": 70}]),
        )  # fmt: skip
        assert r.status_code == 200, r.text
        dev_p = next(p for p in r.json()["projects"] if p["ref"] == dev)
        e_step = {s["step_id"]: s for s in dev_p["steps"]}["PDD-E"]
        assert e_step["duration_weeks"] == 9 and e_step["start_not_before_week"] is None

        # Malformed: an overlap on a workflow's first step.
        r = await c.post(
            "/whatif/import/simulate",
            json=sim_body(rows, edits=[{"project_ref": key, "step_id": "PDD-A",
                                        "overlap_weeks": 1}]),
        )  # fmt: skip
        assert r.status_code == 422 and r.json()["code"] == "INVALID_IMPORT"
        # Out-of-range values never reach the engine (schema).
        r = await c.post(
            "/whatif/import/simulate",
            json=sim_body(rows, edits=[{"project_ref": key, "step_id": "PDD-E",
                                        "duration_weeks": 0}]),
        )  # fmt: skip
        assert r.status_code == 422


async def test_simulate_expand_include_and_dedupe(db_session):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    data = build_workbook(
        [
            row(name="Multi", hub="Greece", category="C", status="Que", num=3, engineer="Neo One"),
            row(name="Other", hub="Greece", category="C", status="Que", engineer="neo  one"),
            row(name="Skipped", hub="Greece", category="C", status="Que"),
        ]
    )  # fmt: skip
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c, data)
        rows[2]["include"] = False
        edits = [{"project_ref": rows[2]["key"], "step_id": "PDD-E", "duration_weeks": 3}]
        resp = await c.post(
            "/whatif/import/simulate",
            json=sim_body(rows, expand_multi=True, mode="file_only", edits=edits),
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    names = [p["name"] for p in body["projects"]]
    assert names == ["Multi (1/3)", "Multi (2/3)", "Multi (3/3)", "Other"]
    assert [p["ref"] for p in body["projects"]][:3] == [f"{rows[0]['key']}-{k}" for k in (1, 2, 3)]
    assert {p["leader_ref"] for p in body["projects"]} == {"new:1"}
    assert [d["ref"] for d in body["capacity"]["designers"] if d["is_new"]] == ["new:1"]


async def test_num_of_projects_expands_by_default(db_session):
    """Owner rule (2026-11-04): Num of Projects n >= 2 is n projects without
    the caller asking; `expand_multi=false` keeps one; only copy 1 replaces
    the matched plan project; a bad value is read as 1 with a warning; On Hold
    rows are still dropped whatever their count."""

    world = await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    data = build_workbook(
        [
            row(name="Alpha Cooler", hub="Greece", category="C", status="Que", num=5,
                engineer="Kanarios", priority=2),
            row(name="Single", hub="Greece", category="C", status="Que", num=1,
                engineer="Kanarios"),
            row(name="Bad Count", hub="Greece", category="C", status="Que", num="x",
                engineer="Kanarios"),
            row(name="Held Many", hub="Greece", category="C", status="On Hold", num=4),
        ]
    )  # fmt: skip
    async with client_for(db_session) as c:
        resp = await parse(c, data)
        assert resp.status_code == 200, resp.text
        parsed = resp.json()
        rows = parsed["rows"]
        assert [r["num_projects"] for r in rows] == [5, 1, None, 4]
        assert parsed["counts"]["projects_after_expansion"] == 7  # 5 + 1 + 1; On Hold out
        (bad,) = [i for i in parsed["issues"] if i["code"] == "NUM_PROJECTS_INVALID"]
        assert (bad["row_key"], bad["severity"]) == (rows[2]["key"], "warning")

        resp = await c.post("/whatif/import/simulate", json=sim_body(rows))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["kpis"]["file_projects"] == 7
        file_p = [p for p in body["projects"] if p["source"] == "file"]
        key0 = rows[0]["key"]
        assert [p["name"] for p in file_p[:5]] == [f"Alpha Cooler ({k}/5)" for k in range(1, 6)]
        assert [p["ref"] for p in file_p[:5]] == [f"{key0}-{k}" for k in range(1, 6)]
        assert [p["ref"] for p in file_p[5:]] == [rows[1]["key"], rows[2]["key"]]
        assert [p["name"] for p in file_p[5:]] == ["Single", "Bad Count"]
        # Only copy 1 replaces Alpha; copies 2..5 are new.
        assert [p["replaces_project_id"] for p in file_p[:5]] == [str(world.alpha.id)] + [None] * 4
        plan_refs = {p["ref"] for p in body["projects"] if p["source"] == "plan"}
        assert str(world.alpha.id) not in plan_refs
        # Every copy carries the row's hub, category, status, priority, leader.
        for k in ("hub", "category", "status", "priority", "leader_name", "file_row"):
            assert len({p[k] for p in file_p[:5]}) == 1, k
        assert "Held Many" not in resp.text

        resp = await c.post("/whatif/import/simulate", json=sim_body(rows, expand_multi=False))
        assert resp.status_code == 200, resp.text
        off = resp.json()
        assert off["kpis"]["file_projects"] == 3
        names = [p["name"] for p in off["projects"] if p["source"] == "file"]
        assert names == ["Alpha Cooler", "Single", "Bad Count"]


async def test_simulate_request_defaults_to_expansion():
    assert ImportSimulateRequest.model_fields["expand_multi"].default is True


async def test_simulate_invalid_rows_and_caps(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        base = rows[2]

        async def post(r: dict[str, Any], **kw: Any):
            return await c.post("/whatif/import/simulate", json=sim_body([r], **kw))

        cases = [
            {**base, "category": "B-OEM"},
            {**base, "stage_step_id": "OEM-B"},
            {**base, "step_weeks": {k: v for k, v in base["step_weeks"].items() if k != "PDD-N"}},
            {**base, "matched_project_id": "00000000-0000-0000-0000-000000000000"},
            {**base, "leader": {"kind": "existing", "engineer_id": str(world.ghost.id)}},
            {**base, "leader": {"kind": "existing", "engineer_id": "nope"}},
        ]
        for case in cases:
            r = await post(case)
            assert r.status_code == 422 and r.json()["code"] == "INVALID_IMPORT", r.text
        # Strict schema: unknown keys, bad enums, bool-for-int.
        for case in (
            {**base, "surprise": 1},
            {**base, "hub": "Mars"},
            {**base, "file_row": True},
            {**base, "step_weeks": {**base["step_weeks"], "PDD-A": 105}},
        ):
            assert (await post(case)).status_code == 422
        # More than 600 projects after expansion (the default expands).
        many = [{**base, "key": f"row-{100 + i}", "file_row": 100 + i, "num_projects": 100}
                for i in range(7)]  # fmt: skip
        r = await c.post("/whatif/import/simulate", json=sim_body(many))
        assert r.status_code == 422 and r.json()["code"] == "INVALID_IMPORT"
        assert "700 projects after expanding Num of Projects" in r.text
        assert "at most 600" in r.text
        # Without the expansion the same 7 rows are 7 projects.
        r = await c.post("/whatif/import/simulate", json=sim_body(many, expand_multi=False))
        assert r.status_code == 200, r.text
        assert r.json()["kpis"]["file_projects"] == 7
        # More than 2000 rows: schema cap.
        r = await c.post("/whatif/import/simulate", json=sim_body([base] * 2001))
        assert r.status_code == 422


async def test_simulate_hub_planner_scope(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        resp = await c.post("/whatif/import/simulate", json=sim_body(rows))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # The caller's file rows are all returned; plan rows only from R&D-Greece.
        assert sum(1 for p in body["projects"] if p["source"] == "file") == 5
        plan = [p for p in body["projects"] if p["source"] == "plan"]
        assert [p["ref"] for p in plan] == [str(world.gamma.id)]
        assert "Beta Cooler" not in resp.text and "Delta Held" not in resp.text
        k = body["kpis"]
        assert k["plan_projects"] == 1 and k["excluded"] == 0  # Delta is not in scope
        assert k["projects_total"] == 6
        cap = body["capacity"]
        assert [h["hub"] for h in cap["hubs"]] == ["R&D-Greece"]
        assert [r["region"] for r in cap["lab_regions"]] == ["Greece"]
        assert set(cap["weekly"]["hubs"]) == {"R&D-Greece"}
        assert set(cap["weekly"]["lab_regions"]) == {"Greece"}
        assert {d["name"] for d in cap["designers"]} == {GR_ENGINEER, "Zed Newperson"}
        assert all("PD-India" not in w for w in body["workings"])
        # An out-of-scope project id is dropped exactly like an unknown one.
        dropped = await c.post(
            "/whatif/import/simulate",
            json=sim_body(rows, edits=[{"project_ref": str(world.beta.id), "step_id": "PDD-E",
                                        "duration_weeks": 3}]),
        )  # fmt: skip
        assert dropped.status_code == 200
        assert dropped.json()["projects"] == body["projects"]
        forged = [{**rows[2], "matched_project_id": str(world.beta.id)}]
        bad2 = await c.post("/whatif/import/simulate", json=sim_body(forged))
        assert bad2.status_code == 422 and bad2.json()["code"] == "INVALID_IMPORT"


async def test_simulate_timeout_is_503_and_audit_is_counts_only(db_session, monkeypatch):
    await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        resp = await c.post("/whatif/import/simulate", json=sim_body(rows))
        assert resp.status_code == 200
        (audit,) = await audit_rows(db_session, "whatif.import_simulate")
        shape = audit.after_state["scenario"]
        assert (shape["rows"], shape["included"], shape["replacing"]) == (5, 5, 2)
        assert shape["removing"] == 0
        assert (shape["auto_leaders"], shape["new_leaders"], shape["edits"]) == (1, 1, 0)
        blob = json.dumps(audit.after_state)
        for leak in ("Alpha", "alpha", "Fresh", "Zed", "Kanarios", "Lokesh"):
            assert leak not in blob

        def boom(*_a, **_k):
            raise WhatIfBudgetExceeded()

        monkeypatch.setattr(import_service, "run_plan_import", boom)
        resp = await c.post("/whatif/import/simulate", json=sim_body(rows))
        assert resp.status_code == 503 and resp.json()["code"] == "WHATIF_TIMEOUT"


async def test_on_hold_rows_are_not_mapped_and_remove_their_plan_project(db_session):
    """Owner rule (2026-11-04): On Hold / Cancelled / Commercialized rows are
    include=false at parse, never simulated (even if re-included), and a
    matched one removes its plan project from a merge run."""

    world = await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    data = build_workbook(
        [
            row(name="Gamma Cooler", hub="Greece", category="C", status="On HOld"),
            row(name="Held New", hub="Greece", category="C", status="ON Hold"),
            row(name="Live New", hub="Greece", category="C", status="Que", engineer="Kanarios"),
        ]
    )  # fmt: skip
    async with client_for(db_session) as c:
        resp = await parse(c, data)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        rows = body["rows"]
        assert [r["include"] for r in rows] == [False, False, True]
        assert rows[0]["matched_project_id"] == str(world.gamma.id)
        held = [i for i in body["issues"] if i["code"] == "STATUS_NOT_SCHEDULED"]
        assert len(held) == 2 and all("not mapped" in i["message"] for i in held)
        assert body["counts"]["not_scheduled"] == 2

        forced = [{**r, "include": True} for r in rows]  # re-included: still dropped
        edits = [{"project_ref": str(world.gamma.id), "step_id": "PDD-E", "duration_weeks": 4}]
        for payload in (rows, forced):
            sim = await c.post("/whatif/import/simulate", json=sim_body(payload, edits=edits))
            assert sim.status_code == 200, sim.text
            out = sim.json()
            refs = [p["ref"] for p in out["projects"]]
            assert refs[0] == rows[2]["key"] and rows[1]["key"] not in refs
            assert str(world.gamma.id) not in refs  # removed from the run
            assert "Gamma Cooler" not in sim.text and "Held New" not in sim.text
            k = out["kpis"]
            assert k["file_projects"] == 1
            assert k["plan_projects"] == 3  # Alpha, Beta, Delta
            assert k["excluded"] == 1  # Delta (plan, On Hold); no file row counted
            assert k["projects_total"] == 4

        # file_only: nothing is removed from (or added to) the plan.
        fo = await c.post("/whatif/import/simulate", json=sim_body(forced, mode="file_only"))
        assert fo.status_code == 200
        assert [p["ref"] for p in fo.json()["projects"]] == [rows[2]["key"]]


async def test_on_hold_removal_is_scoped(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[world.gr.id])
    async with client_for(db_session) as c:
        rows = await _parsed_rows(
            c, build_workbook([row(name="x", hub="Greece", category="C", status="On Hold")])
        )
        forged = [{**rows[0], "matched_project_id": str(world.beta.id)}]
        r = await c.post("/whatif/import/simulate", json=sim_body(forged))
        assert r.status_code == 422 and r.json()["code"] == "INVALID_IMPORT"


async def test_blank_engineer_on_a_matched_row_keeps_the_plan_leader(db_session):
    world = await make_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    data = build_workbook([row(name="Gamma Cooler", hub="Greece", category="C", status="Que")])
    async with client_for(db_session) as c:
        resp = await parse(c, data)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        (r,) = body["rows"]
        assert r["matched_project_id"] == str(world.gamma.id)
        assert r["leader"] == {"kind": "existing", "engineer_id": str(world.eng_gr.id),
                               "name": GR_ENGINEER}  # fmt: skip
        assert [i["code"] for i in body["issues"] if i["field"] == "engineer"] == [
            "ENGINEER_FROM_PLAN"
        ]
        assert body["counts"]["auto_assign"] == 0
        sim = await c.post("/whatif/import/simulate", json=sim_body(body["rows"]))
        p = next(p for p in sim.json()["projects"] if p["ref"] == r["key"])
        assert p["leader_ref"] == str(world.eng_gr.id) and p["leader_auto_assigned"] is False


# --- P32-R06: the 2026-11-05 "priorities" workbook ------------------------------------------


def priorities_file() -> bytes:
    from tests.plan_import_helpers import build_priorities_workbook

    return build_priorities_workbook(
        [
            row(sn=1, name="Alpha Cooler"),  # every cell blank: all from the plan
            row(sn=2, name="Fresh Run", priority="Running", hub="India", category="A"),
            row(sn=3, name="Fresh Ranked", priority=1, hub="India", category="A",
                engineer="Lokesh"),
            row(sn=4, name="Oem Partner", priority=2, hub="Rom/OEM", category="B"),
            row(sn=5, name="Delta Held", spillover="Yes"),
            row(sn=6, name="R&D CAPEX"),
            row(sn=7, name="Spill One", hub="Greece", category="C", spillover="Yes", num=2),
        ]
    )  # fmt: skip


async def test_priorities_workbook_parse_and_simulate_end_to_end(db_session):
    from models.enums import WorkflowStepStatus

    world = await make_world(db_session)
    # Alpha's live progress: A..D Done, so its current step is after PDD-D.
    for i, sid in enumerate(("PDD-A", "PDD-B", "PDD-C", "PDD-D")):
        db_session.add(
            ProjectWorkflowStep(
                project_id=world.alpha.id, step_template_id=sid, sequence_order=i + 1,
                duration_weeks=1, status=WorkflowStepStatus.DONE, percent_complete=100,
                actual_start_week=20, actual_end_week=30,
            )
        )  # fmt: skip
    await db_session.flush()
    user = await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as c:
        resp = await parse(c, priorities_file())
        assert resp.status_code == 200, resp.text
        body = resp.json()
        rows = {r["sn"]: r for r in body["rows"]}
        codes = {(i["row_key"], i["code"]) for i in body["issues"]}

        a = rows["1"]
        assert a["matched_project_id"] == str(world.alpha.id)
        assert (a["hub"], a["category"], a["status"]) == ("R&D-Greece", "C", "In Queue")
        assert a["leader"]["engineer_id"] == str(world.eng_gr.id)
        assert a["priority"] == "P2" and a["priority_source"] == "matched"
        from tests.auth_helpers import make_principal as mp

        ctx = await load_context(db_session, mp(RoleName.ADMIN, user_id=user.id))
        expected_stage = import_service.plan_current_steps(ctx)[str(world.alpha.id)]
        assert expected_stage not in (None, "PDD-A", "PDD-B", "PDD-C", "PDD-D")
        assert a["stage_step_id"] == expected_stage
        for code in ("HUB_FROM_PLAN", "CATEGORY_FROM_PLAN", "STAGE_FROM_PLAN",
                     "STATUS_FROM_PLAN", "ENGINEER_FROM_PLAN"):  # fmt: skip
            assert (a["key"], code) in codes, code

        f = rows["2"]
        assert (f["status"], f["priority"], f["rank"], f["priority_source"]) == (
            "In Development", "P1", 0, "running")  # fmt: skip
        assert (f["key"], "STATUS_FROM_RUNNING") in codes
        assert rows["3"]["rank"] == 1 and rows["3"]["status"] == "In Queue"
        o = rows["4"]
        assert (o["hub"], o["category"]) == ("OEM-HCK", "B-OEM")
        assert (o["key"], "HUB_MAPPED") in codes and (o["key"], "CATEGORY_MAPPED") in codes
        d = rows["5"]
        assert d["matched_project_id"] == str(world.delta.id)
        assert d["status"] == "On Hold" and d["include"] is False
        b = rows["6"]
        assert b["include"] is False and (b["key"], "NOT_A_PROJECT") in codes
        s = rows["7"]
        assert s["status"] == "In Development" and (s["key"], "STATUS_FROM_SPILLOVER") in codes
        assert s["num_projects"] == 2
        assert (None, "STATUS_NOT_IN_FILE") in codes
        assert not any(code == "STATUS_DEFAULTED" for _, code in codes)
        counts = body["counts"]
        assert (counts["rows"], counts["schedulable"], counts["not_scheduled"]) == (7, 6, 1)
        assert (counts["derived_status"], counts["not_a_project"]) == (4, 1)
        assert counts["projects_after_expansion"] == 6  # 1, 2, 3, 4 and 7 (x2)

        sim = await c.post("/whatif/import/simulate", json=sim_body(body["rows"]))
    assert sim.status_code == 200, sim.text
    out = sim.json()
    file_p = {p["ref"]: p for p in out["projects"] if p["source"] == "file"}
    assert set(file_p) == {a["key"], f["key"], rows["3"]["key"], o["key"],
                           f"{s['key']}-1", f"{s['key']}-2"}  # fmt: skip
    plan_refs = {p["ref"] for p in out["projects"] if p["source"] == "plan"}
    # Alpha replaced, Delta (On Hold in the file and the plan) removed.
    assert str(world.alpha.id) not in plan_refs and str(world.delta.id) not in plan_refs
    assert file_p[a["key"]]["replaces_project_id"] == str(world.alpha.id)
    alpha_steps = {st["step_id"]: st for st in file_p[a["key"]]["steps"]}
    for sid in ("PDD-A", "PDD-B", "PDD-C", "PDD-D"):
        assert alpha_steps[sid]["done_before_import"] is True
    run = file_p[f["key"]]
    assert run["status"] == "In Development" and run["priority"] == "P1"
    first = next(st for st in run["steps"] if not st["skipped"])
    assert first["status"] == "In Progress" and first["start_week"] == out["current_week"]

    # The engine takes ranks 1..9999: every rank is shifted by one, Running first.
    req = ImportSimulateRequest.model_validate(sim_body(body["rows"]))
    er = import_service.to_engine_request(ctx, req)
    ranks = {p.key: p.rank for p in er.request.projects}
    assert ranks[f["key"]] == 1 and ranks[rows["3"]["key"]] == 2
    assert ranks[a["key"]] is None
