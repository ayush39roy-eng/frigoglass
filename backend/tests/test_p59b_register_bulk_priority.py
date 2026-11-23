"""P59-B: bulk priority / category / type through `POST /projects/register-edits`.

Project Registration bulk edit and the Priority board bulk move send the
ticked projects as one register batch. A changed priority follows the single
priority move (ADR 0015 / ADR 0050 / ADR 0067): last in the new band (several
moved into one band keep their current rank, then name, order), one
`project.priority_move` audit row each, the batch's one recalculation;
`PRIORITY_NOT_APPLICABLE` per project for Commercialized / Cancelled, and the
whole batch is rolled back.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

import api.routers.projects as projects_router
import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    RoleName,
    SolverType,
)
from models.project import Project
from scheduling.greedy import run_greedy_sgs
from scheduling.invariants import check_i37b_band_ranks_dense
from services.band_rank import band_order
from services.project_steps import sync_project_steps
from services.schedule_apply import persist_solved_run
from services.schedule_persistence import build_schedule_input_from_db
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_project, make_user
from workers.schedule_tasks import run_greedy_schedule

_URL = "/projects/register-edits"
_MOVE = "project.priority_move"


@pytest.fixture(autouse=True)
def _cleanup():
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    yield
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    return calls


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as_admin(db_session) -> None:
    user = await make_user(db_session, RoleName.ADMIN, hub_ids=[], hub_scope_all=True)
    override_current_principal(
        make_principal(RoleName.ADMIN, user_id=user.id, email=user.email, hub_scope_all=True)
    )


async def _world(db_session, *, baseline: bool = True) -> SimpleNamespace:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(
        db_session, hub, name="Shared Leader", allowed_categories=[EngineerAllowedCategory.C]
    )

    async def project(name: str, prio: ProjectPriority, **kw: Any) -> Project:
        p = await make_project(
            db_session,
            hub,
            leader=leader,
            name=name,
            category=ProjectCategory.C,
            priority=prio,
            status=kw.pop("status", ProjectStatus.IN_QUEUE),
            schedule_stale=False,
            certification_testing_required=False,
            **kw,
        )
        await sync_project_steps(db_session, p, False)
        return p

    top = await project("Top", ProjectPriority.P1)
    p2 = [await project(f"Band {i + 1}", ProjectPriority.P2) for i in range(3)]
    zeta = await project("Zeta", ProjectPriority.P3)
    await db_session.flush()
    p2 = sorted(p2, key=lambda p: p.band_rank)
    if baseline:
        schedule_input = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
        await persist_solved_run(
            db_session,
            schedule_input,
            run_greedy_sgs(schedule_input),
            solver=SolverType.GREEDY,
            trigger_reason="manual",
            actor_user_id=None,
            activate=True,
        )
        await db_session.flush()
    return SimpleNamespace(hub=hub, top=top, p2=p2, zeta=zeta, project=project)


async def _fresh(db_session, project_id: uuid.UUID) -> Project:
    return (
        await db_session.execute(
            select(Project)
            .where(Project.id == project_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _moves(db_session, *ids: uuid.UUID) -> list[AuditLogEntry]:
    return list(
        (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == _MOVE,
                    AuditLogEntry.entity_id.in_([str(i) for i in ids]),
                )
            )
        ).scalars()
    )


async def _assert_i37b(db_session) -> None:
    schedule_input = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    assert check_i37b_band_ranks_dense(schedule_input.projects) == ()


async def test_bulk_priority_appends_in_rank_then_name_order_one_recalc(db_session, dispatch):
    w = await _world(db_session)
    await _act_as_admin(db_session)
    band1, band2, band3 = w.p2
    # Sent in an arbitrary order: the band order follows the current rank
    # (Band 1 and Zeta both rank 1 -> by name), not the request or the id.
    moved = [band3, w.zeta, band1]
    edits = [{"project_id": str(p.id), "priority": "P1"} for p in moved]
    async with _client(db_session) as client:
        resp = await client.post(_URL, json={"edits": edits})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "queued"
    assert len(dispatch) == 1
    assert set(body["projects_marked_stale"]) == {str(p.id) for p in moved}

    assert await band_order(db_session, "P1") == [
        str(w.top.id), str(band1.id), str(w.zeta.id), str(band3.id)
    ]
    assert await band_order(db_session, "P2") == [str(band2.id)]
    assert await band_order(db_session, "P3") == []
    for p in moved:
        assert (await _fresh(db_session, p.id)).priority == ProjectPriority.P1

    rows = {r.entity_id: r for r in await _moves(db_session, *(p.id for p in moved))}
    assert set(rows) == {str(p.id) for p in moved}
    row = rows[str(band3.id)]
    assert row.before_state == {"project_id": str(band3.id), "priority": "P2", "band_rank": 3}
    assert row.after_state["priority"] == "P1"
    assert row.after_state["band_rank"] == 4
    assert row.after_state["recalc_status"] == "queued"
    assert rows[str(w.zeta.id)].before_state["priority"] == "P3"
    # A priority-only edit is audited by the move row alone (as the PATCH).
    updates = await db_session.execute(
        select(func.count()).select_from(AuditLogEntry).where(
            AuditLogEntry.action == "project.update",
            AuditLogEntry.entity_id.in_([str(p.id) for p in moved]),
        )
    )
    assert updates.scalar_one() == 0
    await _assert_i37b(db_session)


async def test_cancelled_project_in_batch_is_priority_not_applicable(db_session, dispatch):
    w = await _world(db_session, baseline=False)
    gone = await w.project("Gone", ProjectPriority.P2, status=ProjectStatus.CANCELLED)
    await _act_as_admin(db_session)
    await db_session.commit()
    gone_id, other_id = gone.id, w.p2[0].id
    edits = [
        {"project_id": str(other_id), "priority": "P1"},
        {"project_id": str(gone_id), "priority": "P1"},
    ]
    async with _client(db_session) as client:
        resp = await client.post(_URL, json={"edits": edits})
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "REGISTER_EDITS_INVALID"
    assert [(e["project_id"], e["code"]) for e in detail["errors"]] == [
        (str(gone_id), "PRIORITY_NOT_APPLICABLE")
    ]
    # Nothing saved: the valid row is rolled back too.
    assert (await _fresh(db_session, other_id)).priority == ProjectPriority.P2
    assert (await _fresh(db_session, gone_id)).priority == ProjectPriority.P2
    assert await _moves(db_session, other_id, gone_id) == []
    assert dispatch == []


async def test_cancelled_project_sending_its_stored_priority_is_unchanged(db_session, dispatch):
    w = await _world(db_session, baseline=False)
    gone = await w.project("Gone", ProjectPriority.P2, status=ProjectStatus.CANCELLED)
    await _act_as_admin(db_session)
    async with _client(db_session) as client:
        resp = await client.post(
            _URL, json={"edits": [{"project_id": str(gone.id), "priority": "P2"}]}
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "not_needed"


async def test_same_priority_is_a_no_op(db_session, dispatch):
    w = await _world(db_session)
    await _act_as_admin(db_session)
    before = await band_order(db_session, "P2")
    edits = [{"project_id": str(p.id), "priority": "P2"} for p in w.p2]
    async with _client(db_session) as client:
        resp = await client.post(_URL, json={"edits": edits})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "not_needed"
    assert body["projects_marked_stale"] == []
    assert dispatch == []
    assert await band_order(db_session, "P2") == before
    assert await _moves(db_session, *(p.id for p in w.p2)) == []


async def test_on_hold_priority_saved_without_rank_or_recalc(db_session, dispatch):
    w = await _world(db_session)
    held = await w.project("Held", ProjectPriority.P2, status=ProjectStatus.ON_HOLD)
    await _act_as_admin(db_session)
    async with _client(db_session) as client:
        resp = await client.post(
            _URL, json={"edits": [{"project_id": str(held.id), "priority": "P1"}]}
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "not_needed"
    assert dispatch == []
    fresh = await _fresh(db_session, held.id)
    assert fresh.priority == ProjectPriority.P1
    assert fresh.band_rank is None
    assert len(await _moves(db_session, held.id)) == 1


async def test_unhold_and_priority_move_in_one_row_enters_the_new_band_last(
    db_session, dispatch
):
    w = await _world(db_session, baseline=False)
    held = await w.project("Held", ProjectPriority.P2, status=ProjectStatus.ON_HOLD)
    await _act_as_admin(db_session)
    async with _client(db_session) as client:
        resp = await client.post(
            _URL,
            json={"edits": [{"project_id": str(held.id), "status": "In Queue", "priority": "P1"}]},
        )
    assert resp.status_code == 200, resp.text
    assert await band_order(db_session, "P1") == [str(w.top.id), str(held.id)]
    await _assert_i37b(db_session)


async def test_bulk_category_and_type(db_session, dispatch):
    w = await _world(db_session)
    await _act_as_admin(db_session)
    ids = [p.id for p in w.p2[:2]]
    type_value = next(iter(ProjectType)).value
    edits = [
        {"project_id": str(pid), "category": "B", "project_type": type_value} for pid in ids
    ]
    async with _client(db_session) as client:
        resp = await client.post(_URL, json={"edits": edits})
        assert resp.status_code == 200, resp.text
        assert resp.json()["recalc_status"] == "queued"
        assert len(dispatch) == 1
        for pid in ids:
            fresh = await _fresh(db_session, pid)
            assert fresh.category == "B"
            assert fresh.type == ProjectType(type_value)

        unknown = await client.post(
            _URL, json={"edits": [{"project_id": str(ids[0]), "category": "ZZ"}]}
        )
        assert unknown.status_code == 422, unknown.text
        assert unknown.json()["detail"][0]["loc"] == ["body", "edits", 0, "category"]

        oem = await client.post(
            _URL, json={"edits": [{"project_id": str(ids[0]), "category": "A-OEM"}]}
        )
    assert oem.status_code == 422, oem.text
    assert [e["code"] for e in oem.json()["detail"]["errors"]] == ["CATEGORY_WORKFLOW_MISMATCH"]
    assert (await _fresh(db_session, ids[0])).category == "B"


async def test_stale_base_priority_or_type_is_edit_conflict(db_session, dispatch):
    w = await _world(db_session, baseline=False)
    await _act_as_admin(db_session)
    pid = w.p2[0].id
    other_type = [t for t in ProjectType if t != w.p2[0].type][0].value
    await db_session.commit()  # a 409 rolls the request's session back
    async with _client(db_session) as client:
        stale_priority = await client.post(
            _URL,
            json={
                "edits": [{"project_id": str(pid), "priority": "P1", "base": {"priority": "P3"}}]
            },
        )
        stale_type = await client.post(
            _URL,
            json={
                "edits": [
                    {
                        "project_id": str(pid),
                        "project_type": other_type,
                        "base": {"project_type": other_type},
                    }
                ]
            },
        )
    assert stale_priority.status_code == 409, stale_priority.text
    assert stale_priority.json()["code"] == "EDIT_CONFLICT"
    assert stale_type.status_code == 409, stale_type.text
    assert (await _fresh(db_session, pid)).priority == ProjectPriority.P2
