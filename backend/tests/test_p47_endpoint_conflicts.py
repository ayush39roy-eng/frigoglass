"""P47-T02 (ADR 0059 C1/C3): the field-level conflict check on every other
edit endpoint of the inventory (projects are in
`tests/test_p47_project_conflicts.py`).

Per endpoint: two clients race on the same field (the second gets 409
`EDIT_CONFLICT` naming the first, and nothing changes: row, audit, stale
flag, run dispatch); a matching `base` succeeds; no `base` is the old
behaviour. Batches (check-ins, step pins, scenario Apply, steps PUT) are
atomic. Different fields of one record both succeed.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import func, select

import api.routers.checkins as checkins_router
import api.routers.gantt as gantt_router
import api.routers.whatif as whatif_router
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.checkin import StageCheckin
from models.currency import CurrencyRate
from models.enums import CurrencyCode, HubName, LabRegion, ProjectFileCategory, RoleName
from models.hub import HubWorkCalendar
from models.project import Project
from models.schedule import ScheduleRun
from models.user import User
from models.workspace import ProjectFile
from seed.initial_scoring_rubric import INITIAL_KEYS
from services import edit_conflict, priority_move
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_chamber, make_engineer, make_hub, make_schedule_run, make_user
from tests.p12_helpers import client_for, live_step, plan_step, stepped_project
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    gantt_router.STEP_PINS_RATE_LIMIT.reset()
    checkins_router.CHECKIN_RATE_LIMIT.reset()
    whatif_router.WHATIF_RATE_LIMIT.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)
    gantt_router.STEP_PINS_RATE_LIMIT.reset()
    checkins_router.CHECKIN_RATE_LIMIT.reset()
    whatif_router.WHATIF_RATE_LIMIT.reset()


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[Any] = []

    def _fake_delay(*args: Any, **kwargs: Any) -> SimpleNamespace:
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    monkeypatch.setattr(checkins_router, "publish_progress", lambda *a, **k: None)
    return calls


class Pair:
    """Two named people taking turns on one client."""

    def __init__(self, alice: User, bob: User, role: RoleName) -> None:
        self.alice, self.bob, self.role = alice, bob, role

    def as_(self, user: User) -> None:
        override_current_principal(
            make_principal(self.role, user_id=user.id, email=user.email, hub_scope_all=True)
        )


async def _pair(db, role: RoleName = RoleName.ADMIN) -> Pair:
    alice = await make_user(db, role, full_name="Alice Writer", hub_scope_all=True)
    bob = await make_user(db, role, full_name="Bob Writer", hub_scope_all=True)
    return Pair(alice, bob, role)


async def _count(db, model: Any, *where: Any) -> int:
    stmt = select(func.count()).select_from(model)
    for w in where:
        stmt = stmt.where(w)
    return int((await db.execute(stmt)).scalar_one())


async def _state(db) -> tuple[int, int]:
    """Audit rows and schedule runs: neither may move on a 409."""

    return await _count(db, AuditLogEntry), await _count(db, ScheduleRun)


def _conflict(resp: Response) -> list[dict[str, Any]]:
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "EDIT_CONFLICT"
    assert body["detail"] == "Someone else changed this while you were editing."
    return list(body["conflicts"])


# --------------------------------------------------------------------------
# helpers (pure)
# --------------------------------------------------------------------------


def test_normalisation_matches_the_read_shape():
    same = edit_conflict.same
    assert same(12, 12.0) and same("0.85", Decimal("0.850")) and same(1.08, Decimal("1.0800"))
    assert same(["b", "a"], ("a", "b"))
    assert same("", None) and same("  ", None)
    assert not same(True, 1) and not same(False, 0) and not same(None, 0)
    u = uuid.uuid4()
    assert same(u, str(u).upper())
    assert same(RoleName.ADMIN, RoleName.ADMIN.value)
    assert same({"a": [2, 1]}, {"a": [1, 2]})
    assert not same("P1", "P2")
    assert edit_conflict.is_financial("tcogs_eur") and edit_conflict.is_financial("x.customer_name")
    assert not edit_conflict.is_financial("name")


def test_find_conflicts_rules():
    found = edit_conflict.find_conflicts(
        entity="project",
        entity_id="1",
        label="P",
        base={"a": 1, "b": 1, "c": 1, "d": 1},
        # `a`: stored = base -> fine. `b`: stale base, same value wanted -> fine.
        # `c`: stale base, another value -> conflict. `d`: not in the request.
        # `e`: not in base -> never checked.
        requested={"a": 5, "b": 2, "c": 3, "e": 9},
        current={"a": 1, "b": 2, "c": 2, "d": 7, "e": 0},
        refs=edit_conflict.field_refs("Project", "1"),
    )
    assert [(c.field, c.your_value, c.current_value) for c in found] == [("c", 3, 2)]
    assert edit_conflict.find_conflicts(
        entity="project", entity_id="1", label=None, base=None, requested={"c": 3},
        current={"c": 2}, refs=edit_conflict.field_refs("Project", "1"),
    ) == []


# --------------------------------------------------------------------------
# Gantt freeze toggle
# --------------------------------------------------------------------------


async def test_freeze_toggle(db_session, dispatch):
    hub = await make_hub(db_session)
    project = await stepped_project(db_session, hub, name="Freezer", actual_start_week=20)
    pid = project.id
    pair = await _pair(db_session)
    url = f"/gantt/projects/{pid}/freeze"
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.post(url, json={"frozen": True, "actual_start_week": 22,
                                          "base": {"frozen": False, "actual_start_week": 20}})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        r2 = await client.post(url, json={"frozen": True, "actual_start_week": 25,
                                          "base": {"frozen": False, "actual_start_week": 20}})
        (c,) = _conflict(r2)
        # `frozen` is what Bob wanted too: only the start week conflicts.
        assert (c["field"], c["your_value"], c["current_value"]) == ("actual_start_week", 25, 22)
        assert c["changed_by"] == "Alice Writer"
        assert await _state(db_session) == before
        stored = (await db_session.execute(select(Project).where(Project.id == pid))).scalar_one()
        await db_session.refresh(stored)
        assert (stored.frozen, stored.actual_start_week) == (True, 22)
        # Matching base, then no base.
        r3 = await client.post(url, json={"frozen": False, "base": {"frozen": True}})
        assert r3.status_code == 200, r3.text
        r4 = await client.post(url, json={"frozen": True})
        assert r4.status_code == 200, r4.text


# --------------------------------------------------------------------------
# Manual step weeks (PUT /gantt/step-pins), a batch
# --------------------------------------------------------------------------


def _pin(pid: uuid.UUID, step: str, start: int | None, end: int | None, **kw: Any) -> dict:
    return {"project_id": str(pid), "step_template_id": step, "manual_start_week": start,
            "manual_end_week": end, **kw}


async def test_step_pins_race_and_batch_atomicity(db_session, dispatch):
    hub = await make_hub(db_session)
    a = await stepped_project(db_session, hub, name="Alpha")
    b = await stepped_project(db_session, hub, name="Beta")
    a_id, b_id = a.id, b.id
    pair = await _pair(db_session)
    empty = {"manual_start_week": None, "manual_end_week": None}
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.put("/gantt/step-pins", json={"items": [
            _pin(a_id, "PDD-E", 40, 43, base=empty)]})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        dispatched = len(dispatch)
        stale_before = (await db_session.execute(
            select(Project.schedule_stale).where(Project.id == b_id))).scalar_one()
        pair.as_(pair.bob)
        r2 = await client.put("/gantt/step-pins", json={"items": [
            _pin(b_id, "PDD-E", 44, 45, base=empty),  # fine on its own
            _pin(a_id, "PDD-E", 45, 47, base=empty),  # Alice pinned it first
        ]})
        conflicts = _conflict(r2)
        assert {c["field"] for c in conflicts} == {
            "PDD-E.manual_start_week", "PDD-E.manual_end_week"}
        assert all(c["entity"] == "project_step" and c["id"] == str(a_id) for c in conflicts)
        assert all(c["changed_by"] == "Alice Writer" for c in conflicts)
        assert await _state(db_session) == before
        assert len(dispatch) == dispatched
        row_b = await live_step(db_session, b, "PDD-E")
        await db_session.refresh(row_b)
        assert (row_b.manual_start_week, row_b.manual_end_week) == (None, None)
        assert (await db_session.execute(
            select(Project.schedule_stale).where(Project.id == b_id))).scalar_one() == stale_before
        # Another step of the same project: no conflict.
        r3 = await client.put("/gantt/step-pins", json={"items": [
            _pin(a_id, "PDD-F", 44, 45, base=empty)]})
        assert r3.status_code == 200, r3.text
        # No base: the old last-write-wins.
        r4 = await client.put("/gantt/step-pins", json={"items": [_pin(a_id, "PDD-E", 45, 47)]})
        assert r4.status_code == 200, r4.text


# --------------------------------------------------------------------------
# Engineers / chambers (Capacity and Planning cards) and the settings chamber PUT
# --------------------------------------------------------------------------


async def test_engineer_patch(db_session, dispatch):
    hub = await make_hub(db_session)
    eng = await make_engineer(db_session, hub, name="Eva Engineer", fte=1.0)
    url = f"/engineers/{eng.id}"
    pair = await _pair(db_session)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        assert (await client.patch(url, json={"fte": 0.5, "base": {"fte": 1.0}})).status_code == 200
        before = await _state(db_session)
        pair.as_(pair.bob)
        (c,) = _conflict(await client.patch(url, json={"fte": 0.8, "base": {"fte": 1}}))
        assert (c["entity"], c["label"], c["your_value"], c["current_value"]) == (
            "engineer", "Eva Engineer", 0.8, 0.5)
        assert c["changed_by"] == "Alice Writer"
        assert await _state(db_session) == before
        # A different field from the same stale screen succeeds.
        r = await client.patch(url, json={"name": "Eva E.", "base": {"name": "Eva Engineer",
                                                                    "fte": 1.0}})
        assert r.status_code == 200, r.text
        assert (r.json()["name"], r.json()["fte"]) == ("Eva E.", 0.5)
        assert (await client.patch(url, json={"fte": 0.9})).status_code == 200


async def test_chamber_patch_and_settings_put_share_the_check(db_session, dispatch):
    chamber = await make_chamber(db_session, code="CH-P47")
    pair = await _pair(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.patch(f"/chambers/{chamber.id}",
                                json={"efficiency": 0.8, "base": {"efficiency": 1.0}})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        # Bob edits the same field from Workflow Settings, from a stale read.
        (c,) = _conflict(await client.put(f"/workflow-settings/chambers/{chamber.id}",
                                          json={"efficiency": 0.7, "base": {"efficiency": 1}}))
        assert (c["entity"], c["label"], c["field"], c["current_value"]) == (
            "chamber", "CH-P47", "efficiency", 0.8)
        assert c["changed_by"] == "Alice Writer"
        (c,) = _conflict(await client.patch(f"/chambers/{chamber.id}",
                                            json={"efficiency": 0.7, "base": {"efficiency": 1}}))
        assert await _state(db_session) == before
        ok = await client.put(f"/workflow-settings/chambers/{chamber.id}",
                              json={"breakdown_weeks": 1, "base": {"breakdown_weeks": 0}})
        assert ok.status_code == 200, ok.text
        assert (await client.patch(f"/chambers/{chamber.id}",
                                   json={"efficiency": 0.6})).status_code == 200


# --------------------------------------------------------------------------
# Workflow Settings PUTs (full replacement)
# --------------------------------------------------------------------------


async def test_hub_calendar_put(db_session, dispatch):
    hub = await make_hub(db_session)
    db_session.add(HubWorkCalendar(hub_id=hub.id, weekdays_per_week=5, national_holiday_days=10,
                                   medical_leave_days=5, casual_leave_days=5,
                                   annual_leave_days=20))
    await db_session.flush()
    read = {"weekdays_per_week": 5, "national_holiday_days": 10, "medical_leave_days": 5,
            "casual_leave_days": 5, "annual_leave_days": 20}
    url = f"/workflow-settings/hub-calendars/{hub.id}"
    pair = await _pair(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.put(url, json={**read, "national_holiday_days": 12, "base": read})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        # Bob's full PUT would put the holidays back to 10: a conflict on that
        # field only (his own change is on another field).
        (c,) = _conflict(await client.put(url, json={**read, "annual_leave_days": 22,
                                                     "base": read}))
        assert (c["entity"], c["field"], c["your_value"], c["current_value"]) == (
            "hub_calendar", "national_holiday_days", 10, 12)
        assert c["changed_by"] == "Alice Writer"
        assert await _state(db_session) == before
        r3 = await client.put(url, json={**read, "national_holiday_days": 12,
                                         "annual_leave_days": 22,
                                         "base": {**read, "national_holiday_days": 12}})
        assert r3.status_code == 200, r3.text
        assert (await client.put(url, json=read)).status_code == 200


def _steps_from(settings: dict[str, Any], workflow: str) -> list[dict[str, Any]]:
    wf = next(w for w in settings["workflows"] if w["id"] == workflow)
    return [{"step_id": s["step_id"], "kind": s["kind"],
             "predecessor_ids": list(s["predecessor_ids"])} for s in wf["steps"]]


async def test_steps_put_race(db_session, dispatch):
    pair = await _pair(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        read = _steps_from((await client.get("/workflow-settings")).json(), "PDD")
        by_id = {s["step_id"]: s for s in read}
        first = read[0]["step_id"]
        target = next(s for s in read if s["predecessor_ids"] and first not in s["predecessor_ids"])
        tid = target["step_id"]
        with_base = [{**s, "base": {"kind": s["kind"],
                                    "predecessor_ids": s["predecessor_ids"]}} for s in read]
        mine = [dict(s) for s in with_base]
        for s in mine:
            if s["step_id"] == tid:
                s["predecessor_ids"] = [*s["predecessor_ids"], first]
        r1 = await client.put("/workflow-settings/steps/PDD", json={"steps": mine})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        # Bob's screen still shows the old precedence for every step.
        (c,) = _conflict(await client.put("/workflow-settings/steps/PDD",
                                          json={"steps": with_base}))
        assert (c["entity"], c["id"], c["field"]) == ("workflow_step", tid, "predecessor_ids")
        assert sorted(c["current_value"]) == sorted([*by_id[tid]["predecessor_ids"], first])
        assert c["changed_by"] == "Alice Writer"
        assert await _state(db_session) == before
        # No base: the old full replacement.
        assert (await client.put("/workflow-settings/steps/PDD",
                                 json={"steps": read})).status_code == 200


# --------------------------------------------------------------------------
# Stage progress: Workspace stage PATCH and the weekly check-in (a batch)
# --------------------------------------------------------------------------


async def _due_world(db) -> SimpleNamespace:
    hub = await make_hub(db)
    run = await make_schedule_run(db, is_active=True)
    p = await stepped_project(db, hub, name="Stage One")
    q = await stepped_project(db, hub, name="Stage Two")
    for proj in (p, q):
        await plan_step(db, run, proj, "PDD-E", 28, 34)
    return SimpleNamespace(hub=hub, run=run, p=p, q=q, p_id=p.id, q_id=q.id)


async def test_stage_patch_race(db_session, dispatch):
    w = await _due_world(db_session)
    url = f"/projects/{w.p_id}/stages/PDD-E"
    base = {"status": "Not Started", "percent_complete": 0}
    pair = await _pair(db_session)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.patch(url, json={"status": "In Progress", "percent_complete": 30,
                                           "actual_start_week": 30, "base": base})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        (c,) = _conflict(await client.patch(url, json={"status": "In Progress",
                                                      "actual_start_week": 30,
                                                      "percent_complete": 50, "base": base}))
        assert (c["entity"], c["id"], c["field"]) == (
            "project_step", str(w.p_id), "PDD-E.percent_complete")
        assert (c["your_value"], c["current_value"], c["changed_by"]) == (50, 30, "Alice Writer")
        assert await _state(db_session) == before
        ok = await client.patch(url, json={"percent_complete": 50,
                                           "base": {"percent_complete": 30}})
        assert ok.status_code == 200, ok.text
        assert (await client.patch(url, json={"percent_complete": 60})).status_code == 200


async def test_checkin_race_is_atomic(db_session, dispatch):
    w = await _due_world(db_session)
    base = {"status": "Not Started", "percent_complete": 0, "blocked_reason": None}

    def entry(pid: uuid.UUID, pct: int) -> dict[str, Any]:
        return {"project_id": str(pid), "step_id": "PDD-E", "status": "In Progress",
                "percent_complete": pct, "base": base}

    pair = await _pair(db_session)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.post("/check-ins", json={"entries": [entry(w.p_id, 40)]})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        checkins = await _count(db_session, StageCheckin)
        dispatched = len(dispatch)
        q_stale = (await db_session.execute(
            select(Project.schedule_stale).where(Project.id == w.q_id))).scalar_one()
        pair.as_(pair.bob)
        (c,) = _conflict(await client.post("/check-ins", json={"entries": [
            entry(w.q_id, 10), entry(w.p_id, 60)]}))
        # Status agrees (In Progress); the percent differs. Named from the
        # project-level check-in audit row.
        assert (c["id"], c["field"], c["current_value"]) == (
            str(w.p_id), "PDD-E.percent_complete", 40)
        assert c["changed_by"] == "Alice Writer"
        assert await _state(db_session) == before
        assert await _count(db_session, StageCheckin) == checkins
        assert len(dispatch) == dispatched
        assert (await db_session.execute(
            select(Project.schedule_stale).where(Project.id == w.q_id))).scalar_one() == q_stale
        row_q = await live_step(db_session, w.q, "PDD-E")
        await db_session.refresh(row_q)
        assert row_q.percent_complete == 0
        # Matching base succeeds; no base works as before.
        ok = await client.post("/check-ins", json={"entries": [
            {**entry(w.p_id, 60), "base": {"percent_complete": 40}}]})
        assert ok.status_code == 200, ok.text
        checkins_router.CHECKIN_RATE_LIMIT.reset()
        r = await client.post("/check-ins", json={"entries": [
            {k: v for k, v in entry(w.q_id, 20).items() if k != "base"}]})
        assert r.status_code == 200, r.text


# --------------------------------------------------------------------------
# Priority scores: PUT /priorities/{id} and the Matrix scenario Apply (a batch)
# --------------------------------------------------------------------------


async def test_priority_scores_put_and_matrix_apply(db_session, dispatch):
    hub = await make_hub(db_session)
    p = await stepped_project(db_session, hub, name="Scored")
    q = await stepped_project(db_session, hub, name="Other scored")
    key = INITIAL_KEYS[0]
    pair = await _pair(db_session)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.put(f"/priorities/{p.id}",
                              json={"scores": {key: 3}, "base": {"scores": {key: None}}})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        # Bob's Matrix grid saves two rows; one is stale.
        resp = await client.post("/scenarios/apply", json={"priority_scores": [
            {"project_id": str(q.id), "scores": {key: 2}, "base": {"scores": {key: None}}},
            {"project_id": str(p.id), "scores": {key: 5}, "base": {"scores": {key: None}}},
        ]})
        (c,) = _conflict(resp)
        assert (c["entity"], c["id"], c["label"], c["field"]) == (
            "priority_score", str(p.id), "Scored", f"scores.{key}")
        assert (c["your_value"], c["current_value"], c["changed_by"]) == (5, 3, "Alice Writer")
        assert await _state(db_session) == before
        # The other way round: Alice's next change comes from the grid; Bob's
        # stale single PUT names her from the Apply's per-score history.
        pair.as_(pair.alice)
        r2 = await client.post("/scenarios/apply", json={"priority_scores": [
            {"project_id": str(p.id), "scores": {key: 4}, "base": {"scores": {key: 3}}}]})
        assert r2.status_code == 201, r2.text
        pair.as_(pair.bob)
        (c,) = _conflict(await client.put(f"/priorities/{p.id}", json={
            "scores": {key: 1}, "base": {"scores": {key: 3}}}))
        assert (c["current_value"], c["changed_by"]) == (4, "Alice Writer")
        # Another dimension of the same project succeeds.
        other = INITIAL_KEYS[1]
        ok = await client.put(f"/priorities/{p.id}", json={
            "scores": {other: 2}, "base": {"scores": {other: None, key: 3}}})
        assert ok.status_code == 200, ok.text
        assert (await client.put(f"/priorities/{p.id}",
                                 json={"scores": {key: 1}})).status_code == 200


# --------------------------------------------------------------------------
# VIP: the pin, the board items and their links
# --------------------------------------------------------------------------


async def test_vip_pin(db_session, dispatch):
    hub = await make_hub(db_session)
    p = await stepped_project(db_session, hub, name="Pinned")
    pair = await _pair(db_session)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.put(f"/projects/{p.id}/vip",
                              json={"is_vip": True, "base": {"is_vip": False}})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        dispatched = len(dispatch)
        pair.as_(pair.bob)
        (c,) = _conflict(await client.put(f"/projects/{p.id}/vip",
                                          json={"is_vip": False, "base": {"is_vip": False}}))
        assert (c["field"], c["current_value"], c["changed_by"]) == ("is_vip", True,
                                                                     "Alice Writer")
        assert await _state(db_session) == before and len(dispatch) == dispatched
        r = await client.put(f"/projects/{p.id}/vip", json={"is_vip": False})
        assert r.status_code == 200 and r.json()["is_vip"] is False


async def test_vip_items_and_links(db_session, dispatch):
    hub = await make_hub(db_session)
    p1 = await stepped_project(db_session, hub, name="Link one")
    p2 = await stepped_project(db_session, hub, name="Link two")
    pair = await _pair(db_session)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        created = await client.post("/vip-items", json={
            "area": "Greece", "pillar": "INNOVATION", "title": "Cooler X"})
        assert created.status_code == 201, created.text
        item = created.json()["item"] if "item" in created.json() else created.json()
        url = f"/vip-items/{item['id']}"
        r1 = await client.patch(url, json={"title": "Cooler X2", "base": {"title": "Cooler X"}})
        assert r1.status_code == 200, r1.text
        r2 = await client.put(f"{url}/projects", json={
            "project_ids": [str(p1.id)], "base": {"project_ids": []}})
        assert r2.status_code == 200, r2.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        (c,) = _conflict(await client.patch(url, json={"title": "Cooler Y",
                                                      "base": {"title": "Cooler X"}}))
        assert (c["entity"], c["label"], c["current_value"], c["changed_by"]) == (
            "vip_item", "Cooler X2", "Cooler X2", "Alice Writer")
        (c,) = _conflict(await client.put(f"{url}/projects", json={
            "project_ids": [str(p2.id)], "base": {"project_ids": []}}))
        assert (c["field"], c["current_value"], c["changed_by"]) == (
            "project_ids", [str(p1.id)], "Alice Writer")
        assert await _state(db_session) == before
        # Different field of the same item; no base.
        ok = await client.patch(url, json={"status_note": "on track",
                                           "base": {"status_note": None, "title": "Cooler X"}})
        assert ok.status_code == 200, ok.text
        assert (await client.put(f"{url}/projects",
                                 json={"project_ids": [str(p2.id)]})).status_code == 200


# --------------------------------------------------------------------------
# Users, what-if saved scenario, currency rate, Workspace file
# --------------------------------------------------------------------------


async def test_user_patch(db_session, dispatch):
    hub = await make_hub(db_session)
    target = await make_user(db_session, RoleName.HUB_PLANNER, full_name="Pat Planner",
                             hub_scope_all=False, hub_ids=[hub.id])
    url = f"/users/{target.id}"
    pair = await _pair(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.patch(url, json={"full_name": "Pat P.",
                                           "base": {"full_name": "Pat Planner"}})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        (c,) = _conflict(await client.patch(url, json={"full_name": "Patricia",
                                                      "base": {"full_name": "Pat Planner"}}))
        assert (c["entity"], c["current_value"], c["changed_by"]) == (
            "user", "Pat P.", "Alice Writer")
        assert await _state(db_session) == before
        other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
        ok = await client.patch(url, json={"hub_ids": [str(other.id), str(hub.id)],
                                           "base": {"hub_ids": [str(hub.id)]}})
        assert ok.status_code == 200, ok.text
        assert (await client.patch(url, json={"full_name": "Patricia"})).status_code == 200


async def test_whatif_scenario_patch(db_session, dispatch):
    pair = await _pair(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        saved = await client.post("/whatif/import/scenarios", json={
            "name": "Plan A", "source_file_name": "plan.xlsx", "source_file_sha256": "a" * 64,
            "imported_at": "2026-11-17T10:00:00Z", "request": {"rows": []}})
        assert saved.status_code == 201, saved.text
        url = f"/whatif/import/scenarios/{saved.json()['id']}"
        r1 = await client.patch(url, json={"name": "Plan B", "base": {"name": "Plan A"}})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        (c,) = _conflict(await client.patch(url, json={"name": "Plan C",
                                                      "base": {"name": "Plan A"}}))
        assert (c["entity"], c["current_value"], c["changed_by"]) == (
            "whatif_scenario", "Plan B", "Alice Writer")
        assert await _state(db_session) == before
        ok = await client.patch(url, json={"note": "n", "base": {"note": None, "name": "Plan A"}})
        assert ok.status_code == 200, ok.text
        assert (await client.patch(url, json={"name": "Plan C"})).status_code == 200


async def test_currency_rate_put(db_session, dispatch):
    db_session.add(CurrencyRate(currency_code=CurrencyCode.USD, rate_to_eur=Decimal("1.0800")))
    await db_session.flush()
    pair = await _pair(db_session)
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.put("/currency-rates/USD",
                              json={"rate_to_eur": 1.5, "base": {"rate_to_eur": 1.08}})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        (c,) = _conflict(await client.put("/currency-rates/USD",
                                          json={"rate_to_eur": 1.7,
                                                "base": {"rate_to_eur": 1.08}}))
        assert (c["entity"], c["id"], c["current_value"], c["changed_by"]) == (
            "currency_rate", "USD", 1.5, "Alice Writer")
        assert await _state(db_session) == before
        assert (await client.put("/currency-rates/USD",
                                 json={"rate_to_eur": 1.7})).status_code == 200


async def test_workspace_file_patch(db_session, dispatch):
    hub = await make_hub(db_session)
    p = await stepped_project(db_session, hub, name="Files")
    pair = await _pair(db_session)
    record = ProjectFile(project_id=p.id, display_name="spec.pdf",
                         category=ProjectFileCategory.DRAWING, description=None,
                         uploaded_by_user_id=pair.alice.id, size_bytes=10,
                         content_type="application/pdf", version=1,
                         minio_object_key=f"p47/{uuid.uuid4()}")
    db_session.add(record)
    await db_session.flush()
    url = f"/projects/{p.id}/files/{record.id}"
    async with client_for(db_session) as client:
        pair.as_(pair.alice)
        r1 = await client.patch(url, json={"display_name": "spec-v2.pdf",
                                           "base": {"display_name": "spec.pdf"}})
        assert r1.status_code == 200, r1.text
        before = await _state(db_session)
        pair.as_(pair.bob)
        (c,) = _conflict(await client.patch(url, json={"display_name": "bob.pdf",
                                                      "base": {"display_name": "spec.pdf"}}))
        assert (c["entity"], c["current_value"], c["changed_by"]) == (
            "project_file", "spec-v2.pdf", "Alice Writer")
        assert await _state(db_session) == before
        ok = await client.patch(url, json={"description": "d", "base": {"description": None}})
        assert ok.status_code == 200, ok.text


async def test_conflict_body_is_the_documented_shape(db_session, dispatch):
    """`changed_at` is ISO; `label` / `changed_by` may be null; nothing else."""

    hub = await make_hub(db_session)
    eng = await make_engineer(db_session, hub, name="Nobody Edited", fte=1.0)
    eng.fte = 0.7  # a change with no audit row (e.g. a data load)
    await db_session.flush()
    pair = await _pair(db_session)
    pair.as_(pair.alice)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/engineers/{eng.id}", json={"fte": 0.5, "base": {"fte": 1}})
    (c,) = _conflict(resp)
    assert set(c) == {"entity", "id", "label", "field", "your_value", "current_value",
                      "changed_by", "changed_at"}
    assert c["changed_by"] is None and c["changed_at"] is None
    assert set(resp.json()) == {"code", "detail", "conflicts"}
