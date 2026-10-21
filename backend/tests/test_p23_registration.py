"""P23-T02 (ADR 0034, docs/API_CONTRACT_P23.md): Draft is retired from
registration.

- `POST /projects` with every hard-gate field creates the project In Queue,
  marked stale, with one redacted `project.create` audit row and its 14 stages.
- A missing hard-gate field is a 422 `HARD_GATE_FIELDS_MISSING` with
  per-field errors, and nothing is written (no project, no stage, no audit).
- `PATCH` with `status: "Draft"` is a 422 `DRAFT_RETIRED`; `In Buyoff` stays
  settable.
- A legacy Draft row still leaves Draft through `/submit`, whose 422 has the
  same shape as create's.
- The Registration role matrix is unchanged; hub scoping still applies.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, ProjectStatus, RoleName
from models.project import Project
from models.workflow import ProjectWorkflowStep
from services.project_hard_gates import HARD_GATE_FIELDS
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_project, make_user, registration_body

GATE_NAMES = [name for name, _label in HARD_GATE_FIELDS]


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
        make_principal(*roles, user_id=user.id, hub_scope_all=not scoped, hub_ids=hub_ids or [])
    )
    return user


async def _count(db_session, model, *where) -> int:
    return (
        await db_session.execute(select(func.count()).select_from(model).where(*where))
    ).scalar_one()


# --- create -------------------------------------------------------------------------------


async def test_create_with_all_gate_fields_is_in_queue_stale_and_audited(db_session):
    user = await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    body = registration_body(hub, leader, customer_name="Secret Customer")
    async with _client(db_session) as client:
        resp = await client.post("/projects", json=body)
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert created["status"] == "In Queue"
    assert created["schedule_stale"] is True
    assert created["priority"] == "P3"
    assert created["tcogs_eur"] == 100.0  # authorized read returns the value
    pid = uuid.UUID(created["id"])

    rows = (
        (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.entity_id == str(pid), AuditLogEntry.action == "project.create"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    audit = rows[0]
    assert audit.actor_user_id == user.id
    assert audit.before_state is None
    assert audit.after_state["status"] == "In Queue"
    for field in ("tcogs_eur", "selling_price_eur", "gross_margin_pct", "customer_name"):
        assert audit.after_state[field] == "<redacted>"
    assert "Secret Customer" not in str(audit.after_state)
    assert (
        await _count(db_session, ProjectWorkflowStep, ProjectWorkflowStep.project_id == pid) == 14
    )


@pytest.mark.parametrize("missing", GATE_NAMES)
async def test_create_missing_one_gate_field_is_422_and_writes_nothing(db_session, missing):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    body = registration_body(hub, leader)
    del body[missing]
    async with _client(db_session) as client:
        resp = await client.post("/projects", json=body)
    assert resp.status_code == 422, resp.text
    payload = resp.json()
    assert payload["code"] == "HARD_GATE_FIELDS_MISSING"
    assert list(payload["detail"]["field_errors"]) == [missing]
    assert payload["detail"]["missing_fields"] == [dict(HARD_GATE_FIELDS)[missing]]
    assert await _count(db_session, Project) == 0
    assert await _count(db_session, ProjectWorkflowStep) == 0
    assert await _count(db_session, AuditLogEntry, AuditLogEntry.action == "project.create") == 0


async def test_create_with_only_name_and_hub_lists_every_gate_field(db_session):
    await _act_as(db_session, RoleName.HUB_PLANNER)
    hub = await make_hub(db_session)
    async with _client(db_session) as client:
        resp = await client.post(
            "/projects",
            json={
                "name": "Bare",
                "hub_id": str(hub.id),
                "tcogs_eur": None,
                "customer_name": "Secret Customer",
            },
        )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert list(detail["field_errors"]) == GATE_NAMES
    assert detail["missing_fields"] == [label for _n, label in HARD_GATE_FIELDS]
    assert detail["field_errors"]["tcogs_eur"] == "TCOGS is required."
    assert detail["field_errors"]["actual_start_week"] == "Actual start date is required."
    assert detail["message"] == "Project cannot be registered: required fields missing."
    assert "Secret" not in resp.text  # no submitted value echoed
    assert await _count(db_session, Project) == 0


async def test_create_status_field_still_rejected(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    async with _client(db_session) as client:
        resp = await client.post("/projects", json=registration_body(hub, leader, status="Draft"))
    assert resp.status_code == 422  # extra="forbid"
    assert await _count(db_session, Project) == 0


async def test_create_unknown_leader_is_422(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    async with _client(db_session) as client:
        resp = await client.post(
            "/projects",
            json=registration_body(hub, leader, leader_engineer_id=str(uuid.uuid4())),
        )
    assert resp.status_code == 422
    assert resp.json()["code"] == "UNKNOWN_LEADER"
    assert resp.json()["detail"][0]["loc"] == ["body", "leader_engineer_id"]
    assert await _count(db_session, Project) == 0


async def test_create_out_of_scope_hub_is_403_before_gate_check(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub_a.id])
    leader = await make_engineer(db_session, hub_b)
    async with _client(db_session) as client:
        incomplete = await client.post("/projects", json={"name": "X", "hub_id": str(hub_b.id)})
        complete = await client.post("/projects", json=registration_body(hub_b, leader))
        in_scope = await client.post(
            "/projects", json=registration_body(hub_a, leader, name="In scope")
        )
    assert incomplete.status_code == 403
    assert complete.status_code == 403
    assert in_scope.status_code == 201, in_scope.text
    assert await _count(db_session, Project) == 1


@pytest.mark.parametrize(
    "role,expected",
    [
        (RoleName.PORTFOLIO_MANAGER, 201),
        (RoleName.HUB_PLANNER, 201),
        (RoleName.ADMIN, 201),
        (RoleName.SUPER_ADMIN, 201),
        (RoleName.ENGINEER, 403),
        (RoleName.EXECUTIVE_VIEWER, 403),
        (RoleName.AUDITOR, 403),
    ],
)
async def test_create_role_matrix_unchanged(db_session, role, expected):
    await _act_as(db_session, role)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    async with _client(db_session) as client:
        full = await client.post("/projects", json=registration_body(hub, leader))
        bare = await client.post("/projects", json={"name": "Bare", "hub_id": str(hub.id)})
    assert full.status_code == expected, full.text
    # A forbidden role gets 403, never the 422 that would reveal the gate.
    assert bare.status_code == (422 if expected == 201 else 403)


# --- PATCH --------------------------------------------------------------------------------


async def test_patch_to_draft_is_422_and_unchanged(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, status=ProjectStatus.IN_DEVELOPMENT)
    legacy = await make_project(db_session, hub, name="Legacy", status=ProjectStatus.DRAFT)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"status": "Draft"})
        legacy_noop = await client.patch(f"/projects/{legacy.id}", json={"status": "Draft"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "DRAFT_RETIRED"
    assert resp.json()["detail"][0]["loc"] == ["body", "status"]
    assert legacy_noop.status_code == 422
    await db_session.refresh(project)
    assert project.status == ProjectStatus.IN_DEVELOPMENT
    assert await _count(db_session, AuditLogEntry, AuditLogEntry.action == "project.update") == 0


async def test_patch_to_in_buyoff_still_allowed(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, status=ProjectStatus.IN_DEVELOPMENT)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"status": "In Buyoff"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "In Buyoff"
    assert resp.json()["schedule_stale"] is True


# --- legacy Draft rows --------------------------------------------------------------------


async def test_legacy_draft_row_can_still_leave_draft(db_session):
    await _act_as(db_session, RoleName.HUB_PLANNER)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    legacy = await make_project(
        db_session,
        hub,
        leader=leader,
        status=ProjectStatus.DRAFT,
        actual_start_week=31,
        tcogs_eur=1,
        selling_price_eur=2,
        gross_margin_pct=3,
    )
    async with _client(db_session) as client:
        gate = await client.get(f"/projects/{legacy.id}/hard-gate-status")
        ok = await client.post(f"/projects/{legacy.id}/submit", json={})
    assert gate.json() == {"can_leave_draft": True, "missing_fields": []}
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "In Queue"
    assert ok.json()["schedule_stale"] is True
    assert (
        await _count(
            db_session,
            AuditLogEntry,
            AuditLogEntry.action == "project.submit",
            AuditLogEntry.entity_id == str(legacy.id),
        )
        == 1
    )


async def test_legacy_draft_submit_422_has_the_create_shape(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    legacy = await make_project(
        db_session, hub, status=ProjectStatus.DRAFT, category=None, priority=None
    )
    async with _client(db_session) as client:
        gate = await client.get(f"/projects/{legacy.id}/hard-gate-status")
        resp = await client.post(f"/projects/{legacy.id}/submit", json={})
    assert resp.status_code == 422
    payload = resp.json()
    assert payload["code"] == "HARD_GATE_FIELDS_MISSING"
    names = list(payload["detail"]["field_errors"])
    assert names == [
        "leader_engineer_id",
        "category",
        "actual_start_week",
        "tcogs_eur",
        "selling_price_eur",
        "gross_margin_pct",
        "priority",
    ]
    assert payload["detail"]["missing_fields"] == gate.json()["missing_fields"]
    await db_session.refresh(legacy)
    assert legacy.status == ProjectStatus.DRAFT


async def test_no_registration_path_defaults_to_draft(db_session):
    """ADR 0034: the ORM no longer defaults `status` to Draft."""

    assert Project.__table__.c.status.default is None
