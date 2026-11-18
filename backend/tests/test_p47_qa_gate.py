"""P47-T04 QA gate (ADR 0059): thin-coverage tests added by qa-inspector.

Fills the gaps left by `test_p47_project_conflicts.py` /
`test_p47_endpoint_conflicts.py`:

- the register batch: two clients edit *different* fields of the *same*
  project, both succeed and both values are kept;
- a register batch 409 writes no audit row anywhere (global count), marks
  nothing stale on any project of the batch and dispatches no run, while the
  same batch with fresh bases does all three;
- "Keep mine" (resend with base = the stored value) succeeds and is audited;
- `base: {}` is the same as no `base`; `base: null` is a 422;
- engineers: two clients, different fields, both kept (each with its own
  fresh base for its own field and a stale base for the other's field).
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
from models.enums import HubName, LabRegion, ProjectCategory, RoleName
from models.project import Project
from models.schedule import ScheduleRun
from models.user import User
from services import priority_move
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_schedule_run, make_user
from tests.p12_helpers import client_for, live_step, plan_step, stepped_project
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[Any] = []

    def _fake_delay(*args: Any, **kwargs: Any) -> SimpleNamespace:
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    return calls


async def _user(db, name: str) -> User:
    return await make_user(db, RoleName.ADMIN, full_name=name, hub_scope_all=True)


def _as(user: User) -> None:
    override_current_principal(
        make_principal(RoleName.ADMIN, user_id=user.id, email=user.email, hub_scope_all=True)
    )


async def _project(db, name: str, hub=None, **kw: Any) -> Project:
    hub = hub or await make_hub(db)
    leader = await make_engineer(db, hub, name=f"Lead {name}")
    return await stepped_project(
        db, hub, name=name, leader=leader, category=ProjectCategory.B, **kw
    )


async def _count(db, model: Any) -> int:
    return int((await db.execute(select(func.count()).select_from(model))).scalar_one())


# --------------------------------------------------------------------------
# register batch: different fields, same project
# --------------------------------------------------------------------------


async def test_register_batch_two_clients_different_fields_same_project(db_session, dispatch):
    project = await _project(db_session, "Gate Diff", actual_start_week=10)
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    pid = str(project.id)
    async with client_for(db_session) as client:
        # Both opened the register at the same moment: status In Development,
        # actual_end_week empty.
        _as(alice)
        r1 = await client.post(
            "/projects/register-edits",
            json={
                "edits": [
                    {"project_id": pid, "status": "On Hold", "base": {"status": "In Development"}}
                ]
            },
        )
        assert r1.status_code == 200, r1.text
        _as(bob)
        r2 = await client.post(
            "/projects/register-edits",
            json={
                "edits": [
                    {"project_id": pid, "actual_end_week": 30, "base": {"actual_end_week": None}}
                ]
            },
        )
        assert r2.status_code == 200, r2.text
    await db_session.refresh(project)
    assert project.status.value == "On Hold"
    assert project.actual_end_week == 30


# --------------------------------------------------------------------------
# register batch 409: no audit row anywhere, nothing stale, no run
# --------------------------------------------------------------------------


async def test_register_batch_409_no_audit_no_stale_no_dispatch_then_keep_mine(
    db_session, dispatch
):
    hub_a = await make_hub(db_session)
    hub_b = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    p1 = await _project(db_session, "Gate A", hub=hub_a, actual_start_week=10)
    p2 = await _project(db_session, "Gate B", hub=hub_b, actual_start_week=11)
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    p1_id, p2_id = str(p1.id), str(p2.id)
    async with client_for(db_session) as client:
        _as(alice)
        r1 = await client.post(
            "/projects/register-edits",
            json={
                "edits": [
                    {"project_id": p2_id, "status": "On Hold", "base": {"status": "In Development"}}
                ]
            },
        )
        assert r1.status_code == 200, r1.text
        # Reset the stale flags Alice's edit may have set, so a write by the
        # refused batch would be visible.
        for p in (p1, p2):
            await db_session.refresh(p)
            p.schedule_stale = False
        # Committed (the request joins this session; a 409 rolls back to here).
        await db_session.commit()
        audits, runs, dispatched = (
            await _count(db_session, AuditLogEntry),
            await _count(db_session, ScheduleRun),
            len(dispatch),
        )
        batch = [
            {"project_id": p1_id, "status": "On Hold", "base": {"status": "In Development"}},
            {"project_id": p2_id, "status": "In Queue", "base": {"status": "In Development"}},
        ]
        _as(bob)
        resp = await client.post("/projects/register-edits", json={"edits": batch})
        assert resp.status_code == 409, resp.text
        body = resp.json()
        assert body["code"] == "EDIT_CONFLICT"
        assert [(c["id"], c["field"]) for c in body["conflicts"]] == [(p2_id, "status")]
        assert body["conflicts"][0]["current_value"] == "On Hold"
        assert body["conflicts"][0]["changed_by"] == "Alice Writer"

        assert await _count(db_session, AuditLogEntry) == audits
        assert await _count(db_session, ScheduleRun) == runs
        assert len(dispatch) == dispatched
        for p in (p1, p2):
            await db_session.refresh(p)
            assert p.schedule_stale is False
        assert p1.status.value == "In Development"
        assert p2.status.value == "On Hold"

        # Keep mine: resend with base = the stored value. A deliberate,
        # audited overwrite.
        batch[1]["base"] = {"status": body["conflicts"][0]["current_value"]}
        keep = await client.post("/projects/register-edits", json={"edits": batch})
        assert keep.status_code == 200, keep.text
    await db_session.refresh(p1)
    await db_session.refresh(p2)
    assert (p1.status.value, p2.status.value) == ("On Hold", "In Queue")
    assert await _count(db_session, AuditLogEntry) > audits
    # Positive control: the same batch accepted does mark stale / dispatch,
    # so the 409 assertions above are not vacuous.
    assert p1.schedule_stale or p2.schedule_stale or len(dispatch) > dispatched


async def test_register_batch_use_theirs_resend_without_conflicting_field(db_session, dispatch):
    """Use theirs = drop the conflicting field; the rest of the row saves."""

    project = await _project(db_session, "Gate Theirs", actual_start_week=10)
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    pid = str(project.id)
    async with client_for(db_session) as client:
        _as(alice)
        assert (
            await client.post(
                "/projects/register-edits",
                json={
                    "edits": [
                        {
                            "project_id": pid,
                            "status": "On Hold",
                            "base": {"status": "In Development"},
                        }
                    ]
                },
            )
        ).status_code == 200
        _as(bob)
        mine = {
            "project_id": pid,
            "status": "In Queue",
            "actual_end_week": 40,
            "base": {"status": "In Development", "actual_end_week": None},
        }
        assert (
            await client.post("/projects/register-edits", json={"edits": [mine]})
        ).status_code == 409
        theirs = {"project_id": pid, "actual_end_week": 40, "base": {"actual_end_week": None}}
        r = await client.post("/projects/register-edits", json={"edits": [theirs]})
        assert r.status_code == 200, r.text
    await db_session.refresh(project)
    assert (project.status.value, project.actual_end_week) == ("On Hold", 40)


# --------------------------------------------------------------------------
# base shape: {} = no base; null = 422
# --------------------------------------------------------------------------


async def test_empty_base_is_no_check_and_null_base_is_422(db_session, dispatch):
    project = await _project(db_session, "Gate Shape", actual_start_week=20)
    alice = await _user(db_session, "Alice Writer")
    _as(alice)
    url = f"/projects/{project.id}"
    async with client_for(db_session) as client:
        assert (await client.patch(url, json={"actual_start_week": 22})).status_code == 200
        r = await client.patch(url, json={"actual_start_week": 25, "base": {}})
        assert r.status_code == 200, r.text
        assert r.json()["actual_start_week"] == 25
        r = await client.patch(url, json={"actual_start_week": 26, "base": None})
        assert r.status_code == 422, r.text
        r = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(project.id), "actual_start_week": 27, "base": {}}]},
        )
        assert r.status_code == 200, r.text


# --------------------------------------------------------------------------
# engineers: different fields, both kept
# --------------------------------------------------------------------------


async def test_engineer_two_clients_different_fields_both_kept(db_session, dispatch):
    hub = await make_hub(db_session)
    eng = await make_engineer(db_session, hub, name="Gina Gate", fte=1.0)
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    url = f"/engineers/{eng.id}"
    async with client_for(db_session) as client:
        _as(alice)
        r1 = await client.patch(url, json={"fte": 0.5, "base": {"fte": 1.0}})
        assert r1.status_code == 200, r1.text
        _as(bob)
        r2 = await client.patch(url, json={"name": "Gina G.", "base": {"name": "Gina Gate"}})
        assert r2.status_code == 200, r2.text
        assert (r2.json()["name"], r2.json()["fte"]) == ("Gina G.", 0.5)
        # Bob then edits fte from his stale screen: conflict, names Alice.
        r3 = await client.patch(url, json={"fte": 0.8, "base": {"fte": 1.0}})
        assert r3.status_code == 409, r3.text
        (c,) = r3.json()["conflicts"]
        assert (c["field"], c["current_value"], c["changed_by"]) == ("fte", 0.5, "Alice Writer")
        # Keep mine.
        r4 = await client.patch(url, json={"fte": 0.8, "base": {"fte": c["current_value"]}})
        assert r4.status_code == 200, r4.text
        assert r4.json()["fte"] == 0.8
    assert uuid.UUID(str(eng.id))


# --------------------------------------------------------------------------
# stage PATCH: a subset with base keeps a concurrent different-field change;
# the all-six shape the workspace stage row sends (stage-row.tsx:157-166) 409s
# on a field the user never touched.
# --------------------------------------------------------------------------


async def test_stage_patch_subset_vs_all_six_fields(db_session, dispatch):
    hub = await make_hub(db_session)
    run = await make_schedule_run(db_session, is_active=True)
    project = await stepped_project(db_session, hub, name="Gate Stage")
    await plan_step(db_session, run, project, "PDD-E", 28, 34)
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    url = f"/projects/{project.id}/stages/PDD-E"
    async with client_for(db_session) as client:
        _as(alice)
        r = await client.patch(
            url, json={"status": "In Progress", "percent_complete": 10, "actual_start_week": 30}
        )
        assert r.status_code == 200, r.text
        # Both now read: In Progress, 10 %, start W30.
        read = {
            "status": "In Progress",
            "percent_complete": 10,
            "actual_start_week": 30,
            "actual_end_week": None,
            "remaining_weeks_override": None,
            "blocked_reason": None,
        }
        r = await client.patch(url, json={"percent_complete": 40, "base": {"percent_complete": 10}})
        assert r.status_code == 200, r.text
        _as(bob)
        # The workspace stage row's shape: all six fields, each with a base.
        six = {**read, "actual_start_week": 29, "base": dict(read)}
        r = await client.patch(url, json=six)
        assert r.status_code == 409, r.text
        assert [c["field"] for c in r.json()["conflicts"]] == ["PDD-E.percent_complete"]
        # Only the changed field, with its base: succeeds, Alice's 40 % kept.
        r = await client.patch(
            url, json={"actual_start_week": 29, "base": {"actual_start_week": 30}}
        )
        assert r.status_code == 200, r.text
    step = await live_step(db_session, project, "PDD-E")
    await db_session.refresh(step)
    assert (step.percent_complete, step.actual_start_week) == (40, 29)


# --------------------------------------------------------------------------
# P47-QA-2 (fixed by P47-R02/R03): a score-only edit no longer sends
# `hard_gates`, and the server writes `hard_gates` only when sent, so a
# concurrent gate change by someone else is kept (Matrix grid and PUT).
# --------------------------------------------------------------------------


async def test_matrix_grid_score_edit_does_not_revert_concurrent_gate_change(db_session, dispatch):
    from models.enums import HardGateReason
    from seed.initial_scoring_rubric import INITIAL_KEYS

    hub = await make_hub(db_session)
    project = await stepped_project(db_session, hub, name="Gate Gates")
    pid = str(project.id)
    key, other = INITIAL_KEYS[0], INITIAL_KEYS[1]
    gate = HardGateReason.REGULATORY_DEADLINE_6MO.value
    alice = await _user(db_session, "Alice Writer")
    bob = await _user(db_session, "Bob Writer")
    async with client_for(db_session) as client:
        # Both read: no score, no gate. Alice sets a gate.
        _as(alice)
        r = await client.put(
            f"/priorities/{pid}",
            json={"scores": {}, "hard_gates": [gate], "base": {"hard_gates": []}},
        )
        assert r.status_code == 200, r.text
        # Bob's Matrix grid edits one score only: the fixed request shape
        # (no `hard_gates` in the body or in `base`).
        _as(bob)
        r = await client.post(
            "/scenarios/apply",
            json={
                "priority_scores": [
                    {"project_id": pid, "scores": {key: 2}, "base": {"scores": {key: None}}}
                ]
            },
        )
        assert r.status_code == 201, r.text
        got = (await client.get(f"/priorities/{pid}")).json()
        assert got["hard_gates"] == [gate], "Alice's gate was silently reverted"
        # The scoring section's PUT, same shape: gate still kept.
        r = await client.put(
            f"/priorities/{pid}",
            json={"scores": {other: 3}, "base": {"scores": {other: None}}},
        )
        assert r.status_code == 200, r.text
        got = (await client.get(f"/priorities/{pid}")).json()
    assert got["hard_gates"] == [gate]
    scores = {d["key"]: d["score"] for d in got["dimension_scores"]}
    assert (scores[key], scores[other]) == (2, 3)
