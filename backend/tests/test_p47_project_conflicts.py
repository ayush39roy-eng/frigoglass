"""P47-T02 (ADR 0059 C1/C3): field-level conflict check on the project
edits: `PATCH /projects/{id}`, `POST /projects/register-edits` (inline,
popup, bulk) and `POST /projects/{id}/priority`.

For each: a stale `base` is a 409 `EDIT_CONFLICT` and nothing changes (row,
audit, `schedule_stale`, run dispatch); a matching `base` succeeds; no
`base` is the old behaviour. Two clients on the same field: the second gets
the 409 naming the first; on different fields both succeed. A batch is
atomic. Financial values are `"<hidden>"` in the 409. `changed_by` respects
hub scope.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select

from api.db import get_db
from api.main import app
from api.routers import projects as projects_router
from models.audit import AuditLogEntry
from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
)
from models.project import Project
from models.schedule import ScheduleRun
from models.user import User
from services import priority_move
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_user
from tests.p12_helpers import client_for, stepped_project
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    projects_router.PRIORITY_CONFIRM_RATE_LIMIT.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    projects_router.PRIORITY_CONFIRM_RATE_LIMIT.reset()


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    return calls


async def _user(db, name: str, *roles: RoleName, hub_ids: list[uuid.UUID] | None = None) -> User:
    roles = roles or (RoleName.ADMIN,)
    scope_all = hub_ids is None
    return await make_user(
        db, *roles, full_name=name, hub_ids=hub_ids or [], hub_scope_all=scope_all
    )


def _as(user: User, *roles: RoleName, hub_ids: list[uuid.UUID] | None = None) -> None:
    override_current_principal(
        make_principal(
            *(roles or (RoleName.ADMIN,)),
            user_id=user.id,
            email=user.email,
            hub_scope_all=hub_ids is None,
            hub_ids=hub_ids or [],
        )
    )


async def _project(db, name: str = "P47 Alpha", **kw: Any) -> Project:
    hub = kw.pop("hub", None) or await make_hub(db)
    leader = await make_engineer(db, hub, name=f"Lead {name}")
    return await stepped_project(
        db, hub, name=name, leader=leader, category=ProjectCategory.B, **kw
    )


async def _audit_count(db, project: Project) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(AuditLogEntry)
            .where(AuditLogEntry.entity_id == str(project.id))
        )
    ).scalar_one()


async def _runs(db) -> int:
    return (await db.execute(select(func.count()).select_from(ScheduleRun))).scalar_one()


async def _snapshot(db, project: Project) -> dict[str, Any]:
    await db.refresh(project)
    return {
        "status": project.status,
        "priority": project.priority,
        "actual_start_week": project.actual_start_week,
        "actual_end_week": project.actual_end_week,
        "delay_weeks": project.delay_weeks,
        "schedule_stale": project.schedule_stale,
        "audits": await _audit_count(db, project),
        "runs": await _runs(db),
    }


# --------------------------------------------------------------------------
# PATCH /projects/{id}
# --------------------------------------------------------------------------


async def test_patch_stale_base_is_409_and_nothing_changes(db_session, dispatch):
    project = await _project(db_session, actual_start_week=20)
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    async with client_for(db_session) as client:
        # Alice saves first, from the value both of them read (20).
        _as(alice)
        resp = await client.patch(
            f"/projects/{project.id}",
            json={"actual_start_week": 22, "base": {"actual_start_week": 20}},
        )
        assert resp.status_code == 200, resp.text
        before = await _snapshot(db_session, project)

        # Bob saves the same field from the stale value.
        _as(bob)
        resp = await client.patch(
            f"/projects/{project.id}",
            json={
                "actual_start_week": 25,
                "status": "On Hold",
                "base": {"actual_start_week": 20, "status": "In Development"},
            },
        )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "EDIT_CONFLICT"
    assert body["detail"] == "Someone else changed this while you were editing."
    (conflict,) = body["conflicts"]
    assert conflict == {
        "entity": "project",
        "id": str(project.id),
        "label": "P47 Alpha",
        "field": "actual_start_week",
        "your_value": 25,
        "current_value": 22,
        "changed_by": "Alice Writer",
        "changed_at": conflict["changed_at"],
    }
    assert conflict["changed_at"] is not None
    assert await _snapshot(db_session, project) == before
    assert dispatch == []


async def test_patch_matching_base_succeeds(db_session, dispatch):
    project = await _project(db_session, actual_start_week=20)
    alice = await _user(db_session, "Alice Writer")
    _as(alice)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{project.id}",
            json={
                "actual_start_week": 21,
                "status": "On Hold",
                "base": {"actual_start_week": 20, "status": "In Development"},
            },
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["actual_start_week"] == 21
    assert resp.json()["status"] == "On Hold"
    assert resp.json()["schedule_stale"] is True


async def test_patch_without_base_is_last_write_wins(db_session, dispatch):
    project = await _project(db_session, actual_start_week=20)
    alice = await _user(db_session, "Alice Writer")
    _as(alice)
    async with client_for(db_session) as client:
        r1 = await client.patch(f"/projects/{project.id}", json={"actual_start_week": 22})
        r2 = await client.patch(f"/projects/{project.id}", json={"actual_start_week": 25})
    assert r1.status_code == r2.status_code == 200
    assert r2.json()["actual_start_week"] == 25


async def test_patch_different_fields_both_succeed(db_session, dispatch):
    project = await _project(db_session, actual_start_week=20, delay_weeks=0)
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    async with client_for(db_session) as client:
        _as(alice)
        r1 = await client.patch(
            f"/projects/{project.id}",
            json={"actual_start_week": 22, "base": {"actual_start_week": 20}},
        )
        _as(bob)
        # Bob's base for actual_start_week is stale, but he does not send it.
        r2 = await client.patch(
            f"/projects/{project.id}",
            json={"delay_weeks": 3, "base": {"delay_weeks": 0, "actual_start_week": 20}},
        )
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text
    assert (r2.json()["actual_start_week"], r2.json()["delay_weeks"]) == (22, 3)


async def test_patch_same_value_as_stored_is_not_a_conflict(db_session, dispatch):
    project = await _project(db_session, actual_start_week=20)
    alice = await _user(db_session, "Alice Writer")
    _as(alice)
    async with client_for(db_session) as client:
        await client.patch(f"/projects/{project.id}", json={"actual_start_week": 22})
        resp = await client.patch(
            f"/projects/{project.id}",
            json={"actual_start_week": 22, "base": {"actual_start_week": 20}},
        )
    assert resp.status_code == 200, resp.text


async def test_patch_financial_values_hidden_in_409(db_session, dispatch):
    project = await _project(
        db_session, tcogs_eur=1000.0, customer_name="Acme Secret", gross_margin_pct=12.5
    )
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    async with client_for(db_session) as client:
        _as(alice)
        r1 = await client.patch(
            f"/projects/{project.id}",
            json={
                "tcogs_eur": 1500.0,
                "customer_name": "Other Corp",
                "gross_margin_pct": 14.0,
                "base": {"tcogs_eur": 1000, "customer_name": "Acme Secret",
                         "gross_margin_pct": 12.5},
            },
        )
        assert r1.status_code == 200, r1.text
        _as(bob)
        resp = await client.patch(
            f"/projects/{project.id}",
            json={
                "tcogs_eur": 1700.0,
                "customer_name": "Bob Corp",
                "gross_margin_pct": 9.0,
                "base": {"tcogs_eur": 1000.0, "customer_name": "Acme Secret",
                         "gross_margin_pct": 12.5},
            },
        )
    assert resp.status_code == 409, resp.text
    conflicts = resp.json()["conflicts"]
    assert {c["field"] for c in conflicts} == {"tcogs_eur", "customer_name", "gross_margin_pct"}
    for c in conflicts:
        assert c["your_value"] == "<hidden>" and c["current_value"] == "<hidden>"
    # No value appears anywhere in the body (ids / times aside).
    for c in conflicts:
        assert {k: v for k, v in c.items() if k not in ("id", "changed_at")} == {
            "entity": "project", "label": "P47 Alpha", "field": c["field"],
            "your_value": "<hidden>", "current_value": "<hidden>", "changed_by": "Alice Writer",
        }
    for secret in ("Other Corp", "Bob Corp", "Acme Secret", "1500", "1700"):
        assert secret not in resp.text
    # A matching financial base (number written differently) succeeds.
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{project.id}",
            json={"tcogs_eur": 1700.0, "base": {"tcogs_eur": 1500}},
        )
    assert resp.status_code == 200, resp.text


async def test_patch_changed_by_null_when_audit_hub_out_of_scope(db_session, dispatch):
    greece = await make_hub(db_session)
    india = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    project = await _project(db_session, hub=india, actual_start_week=20)
    alice = await _user(db_session, "Alice Writer")
    planner = await _user(db_session, "Gr Planner", RoleName.HUB_PLANNER, hub_ids=[greece.id])
    async with client_for(db_session) as client:
        _as(alice)
        # Alice edits while the project is in India, then moves it to Greece.
        assert (
            await client.patch(f"/projects/{project.id}", json={"actual_start_week": 22})
        ).status_code == 200
        assert (
            await client.patch(f"/projects/{project.id}", json={"hub_id": str(greece.id)})
        ).status_code == 200
        _as(planner, RoleName.HUB_PLANNER, hub_ids=[greece.id])
        resp = await client.patch(
            f"/projects/{project.id}",
            json={"actual_start_week": 30, "base": {"actual_start_week": 20}},
        )
    assert resp.status_code == 409, resp.text
    (conflict,) = resp.json()["conflicts"]
    # The row that changed the field was written in India, outside the
    # planner's scope: the name is withheld.
    assert conflict["changed_by"] is None
    assert conflict["changed_at"] is not None


async def test_patch_priority_conflict_dispatches_nothing(db_session, dispatch):
    project = await _project(db_session, priority=ProjectPriority.P2)
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    async with client_for(db_session) as client:
        _as(alice)
        r1 = await client.patch(
            f"/projects/{project.id}", json={"priority": "P1", "base": {"priority": "P2"}}
        )
        assert r1.status_code == 200, r1.text
        dispatched = len(dispatch)
        before = await _snapshot(db_session, project)
        _as(bob)
        resp = await client.patch(
            f"/projects/{project.id}", json={"priority": "P3", "base": {"priority": "P2"}}
        )
    assert resp.status_code == 409, resp.text
    (conflict,) = resp.json()["conflicts"]
    assert (conflict["field"], conflict["your_value"], conflict["current_value"]) == (
        "priority", "P3", "P1",
    )
    assert conflict["changed_by"] == "Alice Writer"
    assert len(dispatch) == dispatched
    assert await _snapshot(db_session, project) == before


# --------------------------------------------------------------------------
# POST /projects/{id}/priority
# --------------------------------------------------------------------------


async def test_priority_move_stale_base_is_409(db_session, dispatch):
    project = await _project(db_session, priority=ProjectPriority.P2)
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    async with client_for(db_session) as client:
        _as(alice)
        r1 = await client.post(
            f"/projects/{project.id}/priority", json={"priority": "P1", "base": {"priority": "P2"}}
        )
        assert r1.status_code == 200, r1.text
        dispatched = len(dispatch)
        before = await _snapshot(db_session, project)
        _as(bob)
        r2 = await client.post(
            f"/projects/{project.id}/priority", json={"priority": "P4", "base": {"priority": "P2"}}
        )
        assert r2.status_code == 409, r2.text
        assert r2.json()["conflicts"][0]["changed_by"] == "Alice Writer"
        assert len(dispatch) == dispatched
        assert await _snapshot(db_session, project) == before
        # No base: the old behaviour.
        r3 = await client.post(f"/projects/{project.id}/priority", json={"priority": "P4"})
        assert r3.status_code == 200, r3.text
        assert r3.json()["priority_after"] == "P4"


# --------------------------------------------------------------------------
# POST /projects/register-edits
# --------------------------------------------------------------------------


async def test_register_batch_conflict_is_atomic(db_session, dispatch):
    hub = await make_hub(db_session)
    p1 = await _project(db_session, "Reg One", hub=hub, actual_start_week=10)
    p2 = await _project(db_session, "Reg Two", hub=hub, actual_start_week=11)
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    p2_id = str(p2.id)
    async with client_for(db_session) as client:
        _as(alice)
        r1 = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(p2.id), "status": "On Hold",
                             "base": {"status": "In Development"}}]},
        )
        assert r1.status_code == 200, r1.text
        before1 = await _snapshot(db_session, p1)
        before2 = await _snapshot(db_session, p2)
        dispatched = len(dispatch)
        _as(bob)
        resp = await client.post(
            "/projects/register-edits",
            json={
                "edits": [
                    # p1 is fine on its own...
                    {"project_id": str(p1.id), "actual_start_week": 12,
                     "base": {"actual_start_week": 10}},
                    # ...but p2's status was changed by Alice.
                    {"project_id": str(p2.id), "status": "In Queue",
                     "actual_end_week": 30,
                     "base": {"status": "In Development", "actual_end_week": None}},
                ]
            },
        )
    assert resp.status_code == 409, resp.text
    (conflict,) = resp.json()["conflicts"]
    assert conflict["id"] == p2_id and conflict["field"] == "status"
    assert conflict["label"] == "Reg Two"
    assert (conflict["your_value"], conflict["current_value"]) == ("In Queue", "On Hold")
    assert conflict["changed_by"] == "Alice Writer"
    # Nothing of the batch was written, no run.
    assert await _snapshot(db_session, p1) == before1
    assert await _snapshot(db_session, p2) == before2
    assert len(dispatch) == dispatched


async def test_register_batch_matching_and_no_base(db_session, dispatch):
    hub = await make_hub(db_session)
    p1 = await _project(db_session, "Reg One", hub=hub, actual_start_week=10)
    p2 = await _project(db_session, "Reg Two", hub=hub, actual_start_week=11)
    alice = await _user(db_session, "Alice Writer")
    _as(alice)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/projects/register-edits",
            json={
                "edits": [
                    {"project_id": str(p1.id), "actual_start_week": 12,
                     "base": {"actual_start_week": 10}},
                    {"project_id": str(p2.id), "actual_start_week": 13},
                ]
            },
        )
    assert resp.status_code == 200, resp.text
    await db_session.refresh(p1)
    await db_session.refresh(p2)
    assert (p1.actual_start_week, p2.actual_start_week) == (12, 13)


async def test_register_step_exclusion_and_current_step_conflicts(db_session, dispatch):
    project = await _project(db_session, "Reg Steps")
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    async with client_for(db_session) as client:
        _as(alice)
        steps = (await client.get(f"/projects/{project.id}/register-steps")).json()
        excludable = next(s for s in steps["steps"] if s["excludable"] and not s["step_excluded"])
        code = excludable["step_code"]
        r1 = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(project.id),
                             "step_exclusions": [{"step_code": code, "step_excluded": True}],
                             "base": {"step_exclusions": {code: False}}}]},
        )
        assert r1.status_code == 200, r1.text
        _as(bob)
        resp = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(project.id),
                             "step_exclusions": [{"step_code": code, "step_excluded": False}],
                             "base": {"step_exclusions": [
                                 {"step_code": code, "step_excluded": False}]}}]},
        )
    assert resp.status_code == 409, resp.text
    (conflict,) = resp.json()["conflicts"]
    assert conflict["field"] == f"step_exclusions.{code}"
    assert (conflict["your_value"], conflict["current_value"]) == (False, True)
    assert conflict["changed_by"] == "Alice Writer"


async def test_register_current_step_conflict(db_session, dispatch):
    project = await _project(db_session, "Reg Current")
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    async with client_for(db_session) as client:
        _as(alice)
        steps = (await client.get(f"/projects/{project.id}/register-steps")).json()
        current = steps["current_step_code"]
        later = [s["step_code"] for s in steps["steps"] if s["applicable"] and not s["is_current"]]
        r1 = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(project.id), "current_step_code": later[1],
                             "base": {"current_step_code": current}}]},
        )
        assert r1.status_code == 200, r1.text
        _as(bob)
        resp = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(project.id), "current_step_code": later[2],
                             "base": {"current_step_code": current}}]},
        )
    assert resp.status_code == 409, resp.text
    (conflict,) = resp.json()["conflicts"]
    assert conflict["field"] == "current_step_code"
    assert conflict["current_value"] == later[1]
    assert conflict["changed_by"] == "Alice Writer"


async def test_register_rejects_unknown_shape_of_base(db_session, dispatch):
    project = await _project(db_session)
    alice = await _user(db_session, "Alice Writer")
    _as(alice)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(project.id), "actual_start_week": 3,
                             "base": ["not", "an", "object"]}]},
        )
    assert resp.status_code == 422


def test_project_status_enum_used():
    # The 409 serves enum values as the read endpoint does.
    assert ProjectStatus.ON_HOLD.value == "On Hold"
