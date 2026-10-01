"""P9-T03: the *extended* existing endpoints (docs/API_CONTRACT_P9.md §5, §6)
and the run-lifecycle hooks:

- Gantt rows gain the completion weeks, slip, blocked, stale and workflow;
  step rows gain skipped / status / percent and the run-snapshot kind.
- Projects gain the four new fields, `schedule_stale`, `workflow_id`,
  category↔hub validation (422 `CATEGORY_WORKFLOW_MISMATCH`), `Cancelled`,
  14 live stage rows on create, and stale-on-scheduler-input edits.
- `GET /reference/categories?hub_id=`.
- Activating a run clears `schedule_stale` for its projects; a queued run
  carries a `workflow_snapshot`.
"""

from __future__ import annotations

import uuid

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
    RoleName,
    SolverType,
    WorkflowStepStatus,
)
from models.project import Project
from models.schedule import ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from services.schedule_persistence import create_queued_schedule_run
from services.schedule_stale import clear_stale_for_run
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_project, make_schedule_run, make_user


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
    scoped = hub_ids is not None
    user = await make_user(db_session, *roles, hub_scope_all=not scoped, hub_ids=hub_ids or [])
    override_current_principal(
        make_principal(
            *roles, user_id=user.id, hub_scope_all=not scoped, hub_ids=hub_ids or []
        )
    )
    return user


# --- Gantt (§5) ----------------------------------------------------------------------


async def test_gantt_rows_carry_p9_fields(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, target_end_week=45, schedule_stale=True)
    db_session.add(
        ProjectWorkflowStep(
            project_id=project.id, step_template_id="PDD-A", sequence_order=1, duration_weeks=1,
            status=WorkflowStepStatus.IN_PROGRESS, percent_complete=40, actual_start_week=30,
        )
    )
    run = await make_schedule_run(
        db_session,
        is_active=True,
        workflow_snapshot={"workflows": [{"id": "PDD", "steps": [
            {"step_id": "PDD-A", "kind": "design"}, {"step_id": "PDD-C", "kind": "elapsed"},
        ]}], "lead_times": []},
    )
    for seq, sid, skipped in ((1, "PDD-A", False), (3, "PDD-C", True)):
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id, project_id=project.id, step_template_id=sid,
                sequence_order=seq, duration_weeks=0 if skipped else 1, start_week=31,
                end_week=31, skipped=skipped,
            )
        )
    db_session.add(
        ScheduleRunProjectOutcome(
            schedule_run_id=run.id, project_id=project.id, within_year=True,
            last_step_end_week=48, delay_weeks_applied=2, unconstrained_end_week=40,
            expected_end_week=45, projected_end_week=50, blocked=True,
        )
    )
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.get("/gantt")
    assert resp.status_code == 200, resp.text
    row = resp.json()["rows"][0]
    assert row["target_end_week"] == 45
    assert row["expected_end_week"] == 45
    assert row["projected_end_week"] == 50
    assert row["unconstrained_end_week"] == 40
    assert row["slip_weeks"] == 5
    assert row["blocked"] is True
    assert row["schedule_stale"] is True
    assert row["workflow_id"] == "PDD"
    a, c = row["steps"]
    assert a["kind"] == "design" and a["skipped"] is False
    assert a["status"] == "In Progress" and a["percent_complete"] == 40
    assert c["kind"] == "elapsed" and c["skipped"] is True
    assert c["status"] == "Not Started" and c["percent_complete"] == 0


async def test_gantt_slip_null_when_expected_missing(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    project = await make_project(db_session, hub, category=ProjectCategory.B_OEM)
    run = await make_schedule_run(db_session, is_active=True)
    db_session.add(
        ScheduleRunProjectOutcome(
            schedule_run_id=run.id, project_id=project.id, left_out=True,
            projected_end_week=None, expected_end_week=30,
        )
    )
    await db_session.flush()
    async with _client(db_session) as client:
        row = (await client.get("/gantt")).json()["rows"][0]
    assert row["slip_weeks"] is None
    assert row["workflow_id"] == "OEM"


# --- Projects (§6) -----------------------------------------------------------------------


async def test_create_project_new_fields_and_stage_rows(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    async with _client(db_session) as client:
        resp = await client.post(
            "/projects",
            json={
                "name": "New cooler",
                "hub_id": str(hub.id),
                "category": "B",
                "target_end_week": 50,
                "certification_testing_required": False,
                "estimated_design_weeks": 12.5,
                "estimated_lab_weeks": 3,
            },
        )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["target_end_week"] == 50
    assert body["certification_testing_required"] is False
    assert body["estimated_design_weeks"] == 12.5
    assert body["estimated_lab_weeks"] == 3.0
    assert body["schedule_stale"] is False
    assert body["workflow_id"] == "PDD"
    rows = (
        (
            await db_session.execute(
                select(ProjectWorkflowStep)
                .where(ProjectWorkflowStep.project_id == uuid.UUID(body["id"]))
                .order_by(ProjectWorkflowStep.sequence_order)
            )
        )
        .scalars()
        .all()
    )
    assert [r.step_template_id for r in rows] == [f"PDD-{c}" for c in "ABCDEFGHIJKLMN"]
    # PDD / B lead times: 1 0 0 1 4 0 0 6 0 1 2 1 1 1
    assert [r.duration_weeks for r in rows] == [1, 0, 0, 1, 4, 0, 0, 6, 0, 1, 2, 1, 1, 1]
    assert all(r.status == WorkflowStepStatus.NOT_STARTED for r in rows)


@pytest.mark.parametrize(
    "is_oem,category",
    [(True, "A"), (True, "A+"), (False, "A-OEM"), (False, "C-OEM")],
)
async def test_category_workflow_mismatch_on_create(db_session, is_oem, category):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(
        db_session,
        name=HubName.OEM_SELTEK if is_oem else HubName.PD_ROMANIA,
        lab_region=LabRegion.INDIA if is_oem else LabRegion.ROMANIA,
        is_oem=is_oem,
    )
    async with _client(db_session) as client:
        resp = await client.post(
            "/projects", json={"name": "X", "hub_id": str(hub.id), "category": category}
        )
    assert resp.status_code == 422
    assert resp.json()["code"] == "CATEGORY_WORKFLOW_MISMATCH"


async def test_update_project_category_mismatch_and_hub_move(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    pdd_hub = await make_hub(db_session)
    oem_hub = await make_hub(
        db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True
    )
    async with _client(db_session) as client:
        created = (
            await client.post(
                "/projects", json={"name": "Mover", "hub_id": str(pdd_hub.id), "category": "A"}
            )
        ).json()
        pid = created["id"]
        bad_cat = await client.patch(f"/projects/{pid}", json={"category": "A-OEM"})
        bad_move = await client.patch(f"/projects/{pid}", json={"hub_id": str(oem_hub.id)})
        good_move = await client.patch(
            f"/projects/{pid}", json={"hub_id": str(oem_hub.id), "category": "A-OEM"}
        )
    assert bad_cat.status_code == 422 and bad_cat.json()["code"] == "CATEGORY_WORKFLOW_MISMATCH"
    assert bad_move.status_code == 422 and bad_move.json()["code"] == "CATEGORY_WORKFLOW_MISMATCH"
    assert good_move.status_code == 200, good_move.text
    assert good_move.json()["workflow_id"] == "OEM"
    assert good_move.json()["schedule_stale"] is True
    steps = (
        await db_session.execute(
            select(ProjectWorkflowStep.step_template_id, ProjectWorkflowStep.duration_weeks)
            .where(ProjectWorkflowStep.project_id == uuid.UUID(pid))
            .order_by(ProjectWorkflowStep.sequence_order)
        )
    ).all()
    assert [s for s, _ in steps] == [f"OEM-{c}" for c in "ABCDEFGHIJKLMN"]
    # OEM / A-OEM: 1 1 1 2 2 2 4 6 0 1 0 0 0 1
    assert [d for _, d in steps] == [1, 1, 1, 2, 2, 2, 4, 6, 0, 1, 0, 0, 0, 1]


async def test_workflow_change_refused_once_progress_exists(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    pdd_hub = await make_hub(db_session)
    oem_hub = await make_hub(
        db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True
    )
    async with _client(db_session) as client:
        pid = (
            await client.post(
                "/projects", json={"name": "P", "hub_id": str(pdd_hub.id), "category": "A"}
            )
        ).json()["id"]
    row = (
        await db_session.execute(
            select(ProjectWorkflowStep).where(
                ProjectWorkflowStep.project_id == uuid.UUID(pid),
                ProjectWorkflowStep.step_template_id == "PDD-A",
            )
        )
    ).scalar_one()
    row.status = WorkflowStepStatus.DONE
    row.percent_complete = 100
    row.actual_start_week = 20
    row.actual_end_week = 20
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{pid}", json={"hub_id": str(oem_hub.id), "category": "A-OEM"}
        )
    assert resp.status_code == 422
    assert resp.json()["code"] == "WORKFLOW_CHANGE_WITH_PROGRESS"


async def test_update_marks_stale_only_for_scheduler_inputs(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, status=ProjectStatus.IN_DEVELOPMENT)
    async with _client(db_session) as client:
        cosmetic = await client.patch(f"/projects/{project.id}", json={"comments": "note"})
        same = await client.patch(f"/projects/{project.id}", json={"delay_weeks": 0})
        cancelled = await client.patch(f"/projects/{project.id}", json={"status": "Cancelled"})
        null_name = await client.patch(f"/projects/{project.id}", json={"name": None})
    assert cosmetic.json()["schedule_stale"] is False
    assert same.json()["schedule_stale"] is False
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "Cancelled"
    assert cancelled.json()["schedule_stale"] is True
    assert null_name.status_code == 422


async def test_submit_rejects_cancelled_target_and_marks_stale(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    project = await make_project(
        db_session, hub, leader=leader, status=ProjectStatus.DRAFT, actual_start_week=31,
        tcogs_eur=1, selling_price_eur=2, gross_margin_pct=3,
    )
    async with _client(db_session) as client:
        cancel = await client.post(
            f"/projects/{project.id}/submit", json={"target_status": "Cancelled"}
        )
        ok = await client.post(f"/projects/{project.id}/submit", json={})
    assert cancel.status_code == 400
    assert ok.status_code == 200, ok.text
    assert ok.json()["schedule_stale"] is True


# --- Reference categories -----------------------------------------------------------------


async def test_reference_categories(db_session):
    pdd = await make_hub(db_session)
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    async with _client(db_session) as client:
        # P9-R02 (S-07): reference data now needs an authenticated principal.
        anonymous = [
            await client.get("/reference/categories", params={"hub_id": str(pdd.id)}),
            await client.get("/hubs"),
            await client.get("/workflow-step-templates"),
            await client.get("/currency-rates"),
        ]
        assert [r.status_code for r in anonymous] == [401] * 4
        await _act_as(db_session, RoleName.AUDITOR)  # any role will do
        pdd_cats = await client.get("/reference/categories", params={"hub_id": str(pdd.id)})
        oem_cats = await client.get("/reference/categories", params={"hub_id": str(oem.id)})
        missing = await client.get("/reference/categories", params={"hub_id": str(uuid.uuid4())})
        no_param = await client.get("/reference/categories")
        templates = await client.get("/workflow-step-templates")
        hubs = await client.get("/hubs")
        rates = await client.get("/currency-rates")
    assert hubs.status_code == 200 and rates.status_code == 200
    assert pdd_cats.json() == ["A+", "A", "B", "C"]
    assert oem_cats.json() == ["A-OEM", "B-OEM", "C-OEM"]
    assert missing.status_code == 404
    assert no_param.status_code == 422
    ids = [t["id"] for t in templates.json()]
    assert ids[:14] == [f"OEM-{c}" for c in "ABCDEFGHIJKLMN"]
    assert ids[14:] == [f"PDD-{c}" for c in "ABCDEFGHIJKLMN"]


# --- Run lifecycle --------------------------------------------------------------------------


async def test_clear_stale_for_run_only_touches_projects_in_run(db_session):
    hub = await make_hub(db_session)
    in_run = await make_project(db_session, hub, name="In", schedule_stale=True)
    out_of_run = await make_project(db_session, hub, name="Out", schedule_stale=True)
    run = await make_schedule_run(db_session)
    db_session.add(ScheduleRunProjectOutcome(schedule_run_id=run.id, project_id=in_run.id))
    await db_session.flush()
    await clear_stale_for_run(db_session, run.id)
    flags = dict(
        (
            await db_session.execute(
                select(Project.name, Project.schedule_stale).where(
                    Project.id.in_([in_run.id, out_of_run.id])
                )
            )
        )
        .tuples()
        .all()
    )
    assert flags == {"In": False, "Out": True}


async def test_greedy_recalc_activation_clears_stale(db_session):
    user = await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    project = await make_project(db_session, hub, leader=leader, schedule_stale=True)
    async with _client(db_session) as client:
        resp = await client.post("/schedule-runs/greedy-recalc")
    assert resp.status_code == 201, resp.text
    await db_session.refresh(project)
    assert project.schedule_stale is False
    assert user.id is not None


async def test_queued_run_carries_workflow_snapshot(db_session):
    run = await create_queued_schedule_run(
        db_session, solver_type=SolverType.CP_SAT, trigger_reason="t", triggered_by_user_id=None
    )
    snap = run.workflow_snapshot
    assert snap is not None
    assert [w["id"] for w in snap["workflows"]] == ["OEM", "PDD"]
    assert len(snap["lead_times"]) == 98
