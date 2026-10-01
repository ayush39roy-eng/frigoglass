"""P9-T03: Workflow Settings (docs/API_CONTRACT_P9.md §3; ADRs 0007, 0008, 0009).

GET shape (28 steps, 98 lead times, derived calendar/chamber figures), the
steps PUT's 422 codes (the scheduler's own `build_workflows` is the final
authority), lead-time edits recomputing live durations, calendar and
chamber PUTs, `schedule_stale` + `X-Schedule-Stale-Count` + audit on every
PUT, and the RBAC split (Admin reads, Super Admin writes, Hub Planner edits
own-region chambers through the Capacity Planning path).
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.enums import HubName, LabRegion, ProjectStatus, RoleName
from models.hub import HubWorkCalendar
from models.project import Project
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime, WorkflowStepTemplate
from services.project_steps import sync_project_steps
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_chamber, make_hub, make_project, make_user

PDD_IDS = [f"PDD-{c}" for c in "ABCDEFGHIJKLMN"]


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _act_as(db_session, *roles: RoleName, hub_ids: list[uuid.UUID] | None = None):
    scoped = RoleName.HUB_PLANNER in roles
    user = await make_user(
        db_session, *roles, hub_scope_all=not scoped, hub_ids=hub_ids or []
    )
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=not scoped,
            hub_ids=hub_ids or [],
        )
    )
    return user


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _chain_steps() -> list[dict]:
    """The seeded strict chain for PDD, in PUT-body form."""

    kinds = {s[1]: s[4] for s in dc.WORKFLOW_STEP_TEMPLATE_SEED if s[0] == "PDD"}
    return [
        {"step_id": sid, "kind": kinds[sid], "predecessor_ids": [] if i == 0 else [PDD_IDS[i - 1]]}
        for i, sid in enumerate(PDD_IDS)
    ]


async def _india_setup(db_session):
    hub = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    db_session.add(
        HubWorkCalendar(
            hub_id=hub.id,
            weekdays_per_week=6,
            national_holiday_days=13,
            medical_leave_days=7,
            casual_leave_days=7,
            annual_leave_days=20,
        )
    )
    chamber = Chamber(
        code="IN-CH2-T",
        lab_region=LabRegion.INDIA,
        max_concurrent=4,
        platforms=4,
        efficiency=0.6,
        maintenance_weeks=2,
        breakdown_weeks=11,
        calibration_weeks=1,
        allowed_stages=["PDD-F", "PDD-H"],
    )
    db_session.add(chamber)
    await db_session.flush()
    return hub, chamber


async def test_get_settings_shape_and_derived_figures(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub, chamber = await _india_setup(db_session)
    async with _client(db_session) as client:
        resp = await client.get("/workflow-settings")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [w["id"] for w in body["workflows"]] == ["OEM", "PDD"]
    pdd = next(w for w in body["workflows"] if w["id"] == "PDD")
    assert [s["step_id"] for s in pdd["steps"]] == PDD_IDS
    assert pdd["steps"][0] == {
        "step_id": "PDD-A",
        "code": "MKTG_BRF",
        "name": "Marketing Brief",
        "kind": "design",
        "sequence_order": 1,
        "predecessor_ids": [],
    }
    assert len(body["lead_times"]) == 98
    assert body["lead_times"][0] == {
        "workflow_id": "OEM", "category": "A-OEM", "step_id": "OEM-A", "weeks": 1,
    }
    cal = next(c for c in body["hub_calendars"] if c["hub_id"] == str(hub.id))
    # 52 − 47/6 = 44.1667 (ADR 0008: every deduction divides by the hub's own weekdays).
    assert cal["working_weeks_per_engineer"] == 44.17
    assert cal["hub"] == "PD-India"
    ch = next(c for c in body["chambers"] if c["chamber_id"] == str(chamber.id))
    # 52 − 13/6 − 2 − 11 − 1 = 35.8333; × 0.6 × 4 = 86.0
    assert ch["working_weeks_per_chamber"] == 35.83
    assert ch["efficient_lab_weeks"] == 86.0
    assert body["current_week"] == dc.CURRENT_WEEK
    assert body["updated_by"] is None


@pytest.mark.parametrize(
    "role,read,write",
    [
        (RoleName.ADMIN, 200, 403),
        (RoleName.SUPER_ADMIN, 200, 200),
        (RoleName.PORTFOLIO_MANAGER, 403, 403),
        (RoleName.EXECUTIVE_VIEWER, 403, 403),
        (RoleName.AUDITOR, 403, 403),
    ],
)
async def test_settings_rbac(db_session, role, read, write):
    await _act_as(db_session, role)
    async with _client(db_session) as client:
        assert (await client.get("/workflow-settings")).status_code == read
        put = await client.put("/workflow-settings/steps/PDD", json={"steps": _chain_steps()})
        assert put.status_code == write
        lt = await client.put(
            "/workflow-settings/lead-times",
            json={"lead_times": [{"workflow_id": "PDD", "category": "A", "step_id": "PDD-B",
                                  "weeks": 4}]},
        )
        assert lt.status_code == write


async def test_hub_planner_cannot_read_settings(db_session):
    hub = await make_hub(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub.id])
    async with _client(db_session) as client:
        assert (await client.get("/workflow-settings")).status_code == 403
        assert (
            await client.put(f"/workflow-settings/hub-calendars/{hub.id}", json={
                "weekdays_per_week": 5, "national_holiday_days": 1, "medical_leave_days": 0,
                "casual_leave_days": 0, "annual_leave_days": 0,
            })
        ).status_code == 403


@pytest.mark.parametrize(
    "mutate,code",
    [
        (lambda s: s.pop(), "BAD_STEP_SET"),
        (lambda s: s.append(dict(s[0])), "BAD_STEP_SET"),
        (lambda s: s[3].update(predecessor_ids=["PDD-D"]), "SELF_REFERENCE"),
        (lambda s: s[3].update(predecessor_ids=["OEM-C"]), "BAD_PREDECESSOR"),
        (lambda s: s[3].update(predecessor_ids=["PDD-C", "PDD-C"]), "BAD_PREDECESSOR"),
        (lambda s: s[3].update(predecessor_ids=[]), "EMPTY_PREDECESSORS"),
        (lambda s: s[1].update(predecessor_ids=["PDD-C"]), "CYCLE"),
        (lambda s: s[0].update(predecessor_ids=["PDD-N"]), "CYCLE"),
    ],
)
async def test_steps_put_validation_codes(db_session, mutate, code):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    steps = _chain_steps()
    mutate(steps)
    async with _client(db_session) as client:
        resp = await client.put("/workflow-settings/steps/PDD", json={"steps": steps})
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == code
    assert isinstance(resp.json()["detail"], str)


async def test_steps_put_bad_kind_and_unknown_workflow(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    steps = _chain_steps()
    steps[2]["kind"] = "bogus"
    async with _client(db_session) as client:
        bad_kind = await client.put("/workflow-settings/steps/PDD", json={"steps": steps})
        unknown = await client.put("/workflow-settings/steps/XYZ", json={"steps": _chain_steps()})
    assert bad_kind.status_code == 422
    assert unknown.status_code == 404


async def test_steps_put_kind_in_use_by_chamber(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    await make_chamber(db_session, allowed_stages=["PDD-F"])
    steps = _chain_steps()
    steps[5]["kind"] = "elapsed"  # PDD-F lab → elapsed while a chamber books it
    async with _client(db_session) as client:
        resp = await client.put("/workflow-settings/steps/PDD", json={"steps": steps})
    assert resp.status_code == 422
    assert resp.json()["code"] == "KIND_IN_USE"


async def test_steps_put_parallel_pair_marks_stale_and_audits(db_session):
    actor = await _act_as(db_session, RoleName.SUPER_ADMIN)
    hub = await make_hub(db_session)
    live = await make_project(db_session, hub, name="Live")
    await make_project(db_session, hub, name="Held", status=ProjectStatus.ON_HOLD)
    await make_project(db_session, hub, name="Draft", status=ProjectStatus.DRAFT)
    steps = _chain_steps()
    # Certification (PDD-H) may run in parallel with TF-1 (PDD-I): both after PDD-G.
    steps[8]["predecessor_ids"] = ["PDD-G"]
    steps[9]["predecessor_ids"] = ["PDD-H", "PDD-I"]
    async with _client(db_session) as client:
        resp = await client.put("/workflow-settings/steps/PDD", json={"steps": steps})
    assert resp.status_code == 200, resp.text
    assert resp.headers["X-Schedule-Stale-Count"] == "1"
    pdd = next(w for w in resp.json()["workflows"] if w["id"] == "PDD")
    assert pdd["steps"][8]["predecessor_ids"] == ["PDD-G"]
    assert resp.json()["updated_by"] == "Test User"
    tmpl = await db_session.get(WorkflowStepTemplate, "PDD-J")
    await db_session.refresh(tmpl)
    assert tmpl.predecessor_ids == ["PDD-H", "PDD-I"]
    stale = dict(
        (await db_session.execute(select(Project.name, Project.schedule_stale))).tuples().all()
    )
    assert stale == {"Live": True, "Held": False, "Draft": False}
    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "workflow_settings.steps_update")
        )
    ).scalar_one()
    assert audit.actor_user_id == actor.id
    assert audit.before_state["steps"]["PDD-I"]["predecessor_ids"] == ["PDD-H"]
    assert audit.after_state["steps"]["PDD-I"]["predecessor_ids"] == ["PDD-G"]
    assert audit.after_state["schedule_stale_count"] == 1
    assert live.id is not None


async def test_lead_times_put_recomputes_live_durations(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)  # PDD / category A
    await sync_project_steps(db_session, project, False)
    async with _client(db_session) as client:
        resp = await client.put(
            "/workflow-settings/lead-times",
            json={"lead_times": [
                {"workflow_id": "PDD", "category": "A", "step_id": "PDD-E", "weeks": 9},
                {"workflow_id": "PDD", "category": "A", "step_id": "PDD-B", "weeks": 0},
            ]},
        )
    assert resp.status_code == 200, resp.text
    assert resp.headers["X-Schedule-Stale-Count"] == "1"
    rows = {
        r.step_template_id: r.duration_weeks
        for r in (
            await db_session.execute(
                select(ProjectWorkflowStep)
                .where(ProjectWorkflowStep.project_id == project.id)
                .execution_options(populate_existing=True)
            )
        ).scalars()
    }
    assert rows["PDD-E"] == 9 and rows["PDD-B"] == 0 and rows["PDD-A"] == 1
    lt = (
        await db_session.execute(
            select(WorkflowLeadTime.weeks).where(
                WorkflowLeadTime.workflow_id == "PDD",
                WorkflowLeadTime.step_id == "PDD-E",
                WorkflowLeadTime.category == "A",
            )
        )
    ).scalar_one()
    assert lt == 9


@pytest.mark.parametrize(
    "row,code",
    [
        ({"workflow_id": "PDD", "category": "A", "step_id": "OEM-E", "weeks": 1}, "BAD_LEAD_TIME"),
        ({"workflow_id": "PDD", "category": "A-OEM", "step_id": "PDD-E", "weeks": 1},
         "BAD_LEAD_TIME"),
        ({"workflow_id": "OEM", "category": "A", "step_id": "OEM-E", "weeks": 1}, "BAD_LEAD_TIME"),
    ],
)
async def test_lead_times_put_rejects_mismatched_rows(db_session, row, code):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.put("/workflow-settings/lead-times", json={"lead_times": [row]})
    assert resp.status_code == 422
    assert resp.json()["code"] == code


async def test_lead_times_put_rejects_duplicates_and_negative(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    row = {"workflow_id": "PDD", "category": "A", "step_id": "PDD-E", "weeks": 1}
    async with _client(db_session) as client:
        dup = await client.put("/workflow-settings/lead-times", json={"lead_times": [row, row]})
        neg = await client.put(
            "/workflow-settings/lead-times", json={"lead_times": [{**row, "weeks": -1}]}
        )
    assert dup.status_code == 422 and dup.json()["code"] == "DUPLICATE_LEAD_TIME"
    assert neg.status_code == 422


async def test_hub_calendar_put(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    hub, _ = await _india_setup(db_session)
    other = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    body = {
        "weekdays_per_week": 5,
        "national_holiday_days": 13,
        "medical_leave_days": 7,
        "casual_leave_days": 0,
        "annual_leave_days": 20,
    }
    async with _client(db_session) as client:
        resp = await client.put(f"/workflow-settings/hub-calendars/{hub.id}", json=body)
        created = await client.put(f"/workflow-settings/hub-calendars/{other.id}", json=body)
        silly = await client.put(
            f"/workflow-settings/hub-calendars/{hub.id}",
            json={**body, "annual_leave_days": 300},
        )
        unknown = await client.put(f"/workflow-settings/hub-calendars/{uuid.uuid4()}", json=body)
    assert resp.status_code == 200, resp.text
    cal = next(c for c in resp.json()["hub_calendars"] if c["hub_id"] == str(hub.id))
    assert cal["working_weeks_per_engineer"] == 44.0  # 52 − 40/5, the workbook's Romania figure
    assert created.status_code == 200
    assert any(c["hub_id"] == str(other.id) for c in created.json()["hub_calendars"])
    assert silly.status_code == 422 and silly.json()["code"] == "BAD_CALENDAR"
    assert unknown.status_code == 404
    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "workflow_settings.hub_calendar_update",
                AuditLogEntry.entity_id == str(hub.id),
            )
        )
    ).scalars().all()
    assert audit and audit[0].hub_id == hub.id


async def test_chamber_put_super_admin_syncs_max_concurrent(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    _, chamber = await _india_setup(db_session)
    async with _client(db_session) as client:
        resp = await client.put(
            f"/workflow-settings/chambers/{chamber.id}",
            json={"platforms": 2, "breakdown_weeks": 3},
        )
        null = await client.put(
            f"/workflow-settings/chambers/{chamber.id}", json={"platforms": None}
        )
    assert resp.status_code == 200, resp.text
    assert "X-Schedule-Stale-Count" in resp.headers
    await db_session.refresh(chamber)
    assert chamber.platforms == 2 and chamber.max_concurrent == 2
    assert float(chamber.breakdown_weeks) == 3.0
    row = next(c for c in resp.json()["chambers"] if c["chamber_id"] == str(chamber.id))
    # 52 − 13/6 − 2 − 3 − 1 = 43.8333; × 0.6 × 2 = 52.6
    assert row["efficient_lab_weeks"] == 52.6
    assert null.status_code == 422


async def test_chamber_put_hub_planner_own_region_only(db_session):
    india_hub, india_chamber = await _india_setup(db_session)
    greece_chamber = await make_chamber(db_session, lab_region=LabRegion.GREECE)
    await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[india_hub.id])
    async with _client(db_session) as client:
        own = await client.put(
            f"/workflow-settings/chambers/{india_chamber.id}", json={"maintenance_weeks": 3}
        )
        foreign = await client.put(
            f"/workflow-settings/chambers/{greece_chamber.id}", json={"maintenance_weeks": 3}
        )
    assert own.status_code == 200, own.text
    body = own.json()
    # Scoped payload: no workflow/lead-time data for a role without Workflow Settings READ.
    assert body["workflows"] == [] and body["lead_times"] == []
    assert [c["chamber_id"] for c in body["chambers"]] == [str(india_chamber.id)]
    assert [c["hub_id"] for c in body["hub_calendars"]] == [str(india_hub.id)]
    assert foreign.status_code == 404


async def test_chamber_put_forbidden_without_write(db_session):
    _, chamber = await _india_setup(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.put(f"/workflow-settings/chambers/{chamber.id}", json={"platforms": 1})
    assert resp.status_code == 403


async def test_admin_can_edit_any_chamber_via_capacity_planning(db_session):
    _, chamber = await _india_setup(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.put(
            f"/workflow-settings/chambers/{chamber.id}", json={"efficiency": 0.5}
        )
    assert resp.status_code == 200
    assert resp.json()["workflows"]  # Admin reads Workflow Settings: full payload


# --- Capacity Planning chamber CRUD (orchestrator decision, P9-T03) ------------------


async def test_chamber_crud_read_has_derived_figures_and_ignores_weeks_per_chamber(db_session):
    india_hub, _ = await _india_setup(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[india_hub.id])
    async with _client(db_session) as client:
        created = await client.post(
            "/chambers",
            json={
                "code": "IN-NEW",
                "lab_region": "India",
                "max_concurrent": 2,
                "platforms": 2,
                "efficiency": 0.6,
                "breakdown_weeks": 7,
                "allowed_stages": ["PDD-H"],
                "weeks_per_chamber": 38,  # retired; accepted and ignored for one release
            },
        )
        cid = created.json()["id"]
        patched = await client.patch(
            f"/chambers/{cid}", json={"calibration_weeks": 2, "weeks_per_chamber": 1}
        )
        listed = await client.get("/chambers")
        single = await client.get(f"/chambers/{cid}")
        unknown_key = await client.patch(f"/chambers/{cid}", json={"bogus": 1})
        foreign_region = await client.post(
            "/chambers",
            json={"code": "GR-X", "lab_region": "Greece", "max_concurrent": 1},
        )
    assert created.status_code == 201, created.text
    body = created.json()
    assert "weeks_per_chamber" not in body
    # 52 − 13/6 − 2 − 7 − 1 = 39.8333; × 0.6 × 2 = 47.8
    assert body["working_weeks_per_chamber"] == 39.83
    assert body["efficient_lab_weeks"] == 47.8
    assert (body["maintenance_weeks"], body["breakdown_weeks"], body["calibration_weeks"]) == (
        2.0, 7.0, 1.0,
    )
    assert patched.status_code == 200 and patched.json()["working_weeks_per_chamber"] == 38.83
    assert {c["code"] for c in listed.json()} == {"IN-CH2-T", "IN-NEW"}
    assert single.json()["efficient_lab_weeks"] == round((52 - 13 / 6 - 2 - 7 - 2) * 1.2, 2)
    assert unknown_key.status_code == 422
    assert foreign_region.status_code == 403
