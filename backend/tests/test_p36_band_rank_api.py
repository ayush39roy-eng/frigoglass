"""P36-T03: rank within a priority band, backend (ADR 0050, R36-1..R36-10,
docs/API_CONTRACT_P36.md).

Covered:
- the factory ranks bands by the backfill rule (R36-1(f)), so I37b holds on a
  fresh DB and the old in-band order is kept;
- `POST /projects/{id}/band-rank/preview`: preview with token, writes
  nothing; `unchanged`; the errors 409 NOT_RANKABLE, 422 BOTH_ANCHORS /
  NOT_SAME_BAND (other band, itself, unranked, out of the caller's hub
  scope), 403 / 404 as the priority move; a hard-gated P1 project is
  re-rankable inside P1;
- `POST /projects/{id}/band-rank`: applied in-process, I37c placement (before
  and after anchors, on a "filtered" anchor that hides cards in between),
  I37b dense, only the moved project audited (`project.band_rank_move`),
  `X-Schedule-*` headers; 409 PREVIEW_STALE on a stale token after a
  concurrent re-rank (nothing written); `deferred` with a run in flight;
- I37d: the preview's token equals the token rebuilt from the DB after the
  confirm, for a re-rank and for a priority move;
- the lifecycle (R36-8) on every write path keeps I37b: registration (last),
  Draft submit (last), PATCH status out of / back into a band, a
  schedulable -> schedulable status change keeps the rank (R36-3), PATCH
  priority, the priority confirm, the P35 register batch (enterers appended
  in ascending id, each band renumbered once);
- a frozen project re-ranked previews no date change for itself (R36-2);
- `GET /priority-board` sorts by band_rank (then status, category rank, id),
  serves `band_rank` and `frozen`, and a filter never renumbers.
"""

from __future__ import annotations

import time
import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import create_async_engine

import api.routers.projects as projects_router
import services.band_rank as band_rank_service
import services.priority_move as priority_move
import services.priority_preview as priority_preview
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    EngineerAllowedCategory,
    HardGateReason,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    ScheduleRunStatus,
    SolverType,
)
from models.project import Project
from models.schedule import ScheduleRun
from scheduling import band_rank as br
from scheduling.greedy import run_greedy_sgs
from scheduling.invariants import check_i37b_band_ranks_dense, check_i37c_placement
from services.band_rank import BAND_RANK_LOCK_KEY, band_order
from services.project_steps import sync_project_steps
from services.schedule_apply import persist_solved_run
from services.schedule_persistence import build_schedule_input_from_db
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_engineer,
    make_hub,
    make_priority_score,
    make_project,
    make_schedule_run,
    make_user,
    registration_body,
)
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup(monkeypatch):
    monkeypatch.setattr(priority_preview, "publish_progress", lambda *a, **k: None)
    projects_router.PRIORITY_PREVIEW_RATE_LIMIT.reset()
    projects_router.PRIORITY_CONFIRM_RATE_LIMIT.reset()
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    yield
    projects_router.PRIORITY_PREVIEW_RATE_LIMIT.reset()
    projects_router.PRIORITY_CONFIRM_RATE_LIMIT.reset()
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


async def _act_as(db_session, *roles: RoleName, hub_ids=None):
    scope_all = hub_ids is None
    user = await make_user(db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=scope_all)
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=scope_all,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def _activate_baseline(db_session) -> ScheduleRun:
    schedule_input = await build_schedule_input_from_db(db_session)
    run = await persist_solved_run(
        db_session,
        schedule_input,
        run_greedy_sgs(schedule_input),
        solver=SolverType.GREEDY,
        trigger_reason="manual",
        actor_user_id=None,
        activate=True,
    )
    await db_session.flush()
    return run


async def _world(db_session, *, n_p2: int = 5, other_hub: bool = False, baseline: bool = True):
    """`n_p2` category-C In Queue projects in P2 sharing one leader (so their
    order inside the band moves their dates), plus one P1 project. With
    `other_hub`, P2 project index 2 is in a second hub."""

    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = (
        await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
        if other_hub
        else hub
    )
    leader = await make_engineer(
        db_session, hub, name="Shared Leader", allowed_categories=[EngineerAllowedCategory.C]
    )

    async def project(name: str, prio: ProjectPriority, h=hub, **kw: Any) -> Project:
        p = await make_project(
            db_session,
            h,
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

    p1 = await project("Top", ProjectPriority.P1)
    p2 = [
        await project(f"Band {i + 1}", ProjectPriority.P2, hub_b if other_hub and i == 2 else hub)
        for i in range(n_p2)
    ]
    await db_session.flush()
    # In band order (the factory ranks equal projects by id): p2[i] has rank i + 1.
    p2 = sorted(p2, key=lambda p: p.band_rank)
    assert [p.band_rank for p in p2] == list(range(1, n_p2 + 1))
    run = await _activate_baseline(db_session) if baseline else None
    return SimpleNamespace(
        hub=hub, hub_b=hub_b, leader=leader, p1=p1, p2=p2, run=run, project=project
    )


async def _order(db_session, band: str) -> list[str]:
    return await band_order(db_session, band)


async def _assert_i37b(db_session) -> None:
    schedule_input = await build_schedule_input_from_db(db_session)
    assert check_i37b_band_ranks_dense(schedule_input.projects) == ()


async def _count(db_session, model, *where) -> int:
    return (
        await db_session.execute(select(func.count()).select_from(model).where(*where))
    ).scalar_one()


async def _fresh(db_session, project_id: uuid.UUID) -> Project:
    return (
        await db_session.execute(
            select(Project)
            .where(Project.id == project_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


def _body(before=None, after=None, **extra: Any) -> dict[str, Any]:
    return {
        "before_project_id": str(before) if before is not None else None,
        "after_project_id": str(after) if after is not None else None,
        **extra,
    }


async def _preview(client, project_id, **kw):
    return await client.post(f"/projects/{project_id}/band-rank/preview", json=_body(**kw))


async def _confirm(client, project_id, token, **kw):
    return await client.post(
        f"/projects/{project_id}/band-rank", json=_body(preview_token=token, **kw)
    )


# --- factory / backfill rule ------------------------------------------------------------


async def test_factory_ranks_by_backfill_rule_and_keeps_i37b(db_session):
    hub = await make_hub(db_session)
    a = await make_project(db_session, hub, name="a", category=ProjectCategory.C)
    b = await make_project(
        db_session, hub, name="b", category=ProjectCategory.A, status=ProjectStatus.IN_BUYOFF
    )
    c = await make_project(db_session, hub, name="c", category=ProjectCategory.A)
    held = await make_project(db_session, hub, name="held", status=ProjectStatus.ON_HOLD)
    unprio = await make_project(db_session, hub, name="none", priority=None)
    # (status, category rank, id): In Buyoff first, then In Queue A, then In Queue C.
    assert await _order(db_session, "P3") == [str(b.id), str(c.id), str(a.id)]
    assert held.band_rank is None and unprio.band_rank is None
    await _assert_i37b(db_session)


# --- preview ---------------------------------------------------------------------------


async def test_preview_rerank_lists_changes_and_writes_nothing(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    last, first = w.p2[-1], w.p2[0]
    order = await _order(db_session, "P2")
    runs, audits = await _count(db_session, ScheduleRun), await _count(db_session, AuditLogEntry)

    async with _client(db_session) as client:
        resp = await _preview(client, last.id, before=first.id)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["result"] == "preview"
    assert body["from_priority"] == body["to_priority"] == "P2"
    assert body["preview_token"]
    assert body["moved"]["end_week_after"] < body["moved"]["end_week_before"]
    assert body["summary"]["delayed"] >= 1
    assert await _order(db_session, "P2") == order
    assert await _count(db_session, ScheduleRun) == runs
    assert await _count(db_session, AuditLogEntry) == audits


async def test_preview_unchanged_when_placement_keeps_the_order(db_session):
    w = await _world(db_session, baseline=False)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        same_slot = await _preview(client, w.p2[1].id, before=w.p2[2].id)
        after_prev = await _preview(client, w.p2[1].id, after=w.p2[0].id)
        last_is_last = await _preview(client, w.p2[-1].id)
        confirm = await _confirm(client, w.p2[1].id, "x" * 64, before=w.p2[2].id)
    for resp in (same_slot, after_prev, last_is_last):
        assert resp.status_code == 200, resp.text
        assert resp.json()["result"] == "unchanged"
        assert resp.json()["preview_token"] is None
    assert confirm.status_code == 200
    assert confirm.json()["recalc_status"] == "unchanged"
    assert "X-Schedule-Recalc" not in confirm.headers
    assert (
        await _count(db_session, AuditLogEntry, AuditLogEntry.action == "project.band_rank_move")
        == 0
    )


async def test_rerank_errors(db_session):
    w = await _world(db_session, other_hub=True, baseline=False)
    held = await w.project("Held", ProjectPriority.P2, status=ProjectStatus.ON_HOLD)
    out_of_scope = next(p for p in w.p2 if p.hub_id == w.hub_b.id)
    a, b, c = [p for p in w.p2 if p.hub_id == w.hub.id][:3]
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        both = await _preview(client, a.id, before=b.id, after=c.id)
        other_band = await _preview(client, a.id, before=w.p1.id)
        itself = await _preview(client, a.id, before=a.id)
        unranked = await _preview(client, a.id, before=held.id)
        hidden = await _preview(client, a.id, before=out_of_scope.id)
        missing = await _preview(client, a.id, before=uuid.uuid4())
        projects_router.PRIORITY_PREVIEW_RATE_LIMIT.reset()
        not_rankable = await _preview(client, held.id, before=a.id)
        out_project = await _preview(client, out_of_scope.id, before=a.id)
        confirm_hidden = await _confirm(client, a.id, "x" * 64, before=out_of_scope.id)
    assert both.status_code == 422 and both.json()["code"] == "BOTH_ANCHORS"
    for resp in (other_band, itself, unranked, hidden, missing, confirm_hidden):
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "NOT_SAME_BAND"
    # Out of scope and nonexistent read the same (no existence leak).
    assert hidden.json() == missing.json()
    assert not_rankable.status_code == 409 and not_rankable.json()["code"] == "NOT_RANKABLE"
    assert out_project.status_code == 404


async def test_rerank_rbac(db_session):
    w = await _world(db_session, baseline=False)
    await _act_as(db_session, RoleName.ENGINEER)
    async with _client(db_session) as client:
        preview = await _preview(client, w.p2[2].id, before=w.p2[0].id)
        confirm = await _confirm(client, w.p2[2].id, "x" * 64, before=w.p2[0].id)
    assert preview.status_code == 403
    assert confirm.status_code == 403


async def test_body_is_strict(db_session):
    w = await _world(db_session, baseline=False)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        extra = await client.post(f"/projects/{w.p2[0].id}/band-rank/preview", json={"rank": 1})
        no_token = await client.post(f"/projects/{w.p2[0].id}/band-rank", json=_body())
    assert extra.status_code == 422
    assert no_token.status_code == 422


async def test_hard_gated_p1_project_is_rerankable_within_p1(db_session):
    w = await _world(db_session, baseline=False)
    second = await w.project("Second P1", ProjectPriority.P1)
    await make_priority_score(
        db_session, second, hard_gates=[HardGateReason.ACTIVE_SAFETY_NONCOMPLIANCE]
    )
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    # The factory ranks equal projects by id: move the gated one to the other end.
    first = (await _order(db_session, "P1"))[0] == str(second.id)
    place = {"after": w.p1.id} if first else {"before": w.p1.id}
    async with _client(db_session) as client:
        preview = await _preview(client, second.id, **place)
        confirm = await _confirm(client, second.id, preview.json()["preview_token"], **place)
    assert preview.status_code == 200, preview.text
    assert preview.json()["result"] == "preview"
    assert confirm.status_code == 200, confirm.text
    expected = [str(w.p1.id), str(second.id)] if first else [str(second.id), str(w.p1.id)]
    assert await _order(db_session, "P1") == expected


# --- confirm ---------------------------------------------------------------------------


async def test_confirm_applies_placement_audits_and_matches_preview(db_session):
    w = await _world(db_session)
    user = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    moved, anchor = w.p2[3], w.p2[1]
    order_before = await _order(db_session, "P2")
    from_rank = moved.band_rank
    stale_before = {p.id: p.schedule_stale for p in w.p2}

    async with _client(db_session) as client:
        preview = await _preview(client, moved.id, before=anchor.id)
        token = preview.json()["preview_token"]
        resp = await _confirm(client, moved.id, token, before=anchor.id)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "applied"
    assert body["priority_before"] == body["priority_after"] == "P2"
    assert body["schedule_run_id"]
    assert resp.headers["X-Schedule-Recalc"] == "applied"
    assert resp.headers["X-Schedule-Run-Id"] == body["schedule_run_id"]
    assert resp.headers["X-Schedule-Baseline-Run-Id"] == str(w.run.id)
    # The confirmed change list equals the preview's (same snapshot, greedy).
    assert body["changes"] == preview.json()["changes"]
    assert body["summary"] == preview.json()["summary"]
    assert body["moved"] == preview.json()["moved"]

    order_after = await _order(db_session, "P2")
    assert (
        check_i37c_placement(
            order_before, order_after, str(moved.id), before_project_id=str(anchor.id)
        )
        == ()
    )
    await _assert_i37b(db_session)
    run = await db_session.get(ScheduleRun, uuid.UUID(body["schedule_run_id"]))
    assert run.trigger_reason == "band_rank_move" and run.is_active

    audits = (
        (
            await db_session.execute(
                select(AuditLogEntry).where(AuditLogEntry.action == "project.band_rank_move")
            )
        )
        .scalars()
        .all()
    )
    assert len(audits) == 1
    audit = audits[0]
    assert audit.entity_id == str(moved.id) and audit.actor_user_id == user.id
    assert audit.before_state == {"project_id": str(moved.id), "band": "P2", "band_rank": from_rank}
    assert audit.after_state["band"] == "P2"
    assert audit.after_state["from_rank"] == from_rank
    assert audit.after_state["to_rank"] == 2
    assert audit.after_state["before_project_id"] == str(anchor.id)
    assert audit.after_state["after_project_id"] is None
    assert audit.after_state["recalc_status"] == "applied"
    # Neighbours were renumbered but are not audited or marked stale (R36-8).
    for p in w.p2:
        if p.id != moved.id:
            fresh = await _fresh(db_session, p.id)
            assert fresh.schedule_stale == stale_before[p.id]
            assert (
                await _count(
                    db_session,
                    AuditLogEntry,
                    AuditLogEntry.entity_id == str(p.id),
                    AuditLogEntry.action == "project.band_rank_move",
                )
                == 0
            )


async def test_i37d_rerank_preview_token_equals_rebuilt_input(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    moved, anchor = w.p2[0], w.p2[3]
    from_rank = moved.band_rank
    async with _client(db_session) as client:
        preview = await _preview(client, moved.id, after=anchor.id)
        token = preview.json()["preview_token"]
        resp = await _confirm(client, moved.id, token, after=anchor.id)
    assert resp.status_code == 200, resp.text
    rebuilt = await build_schedule_input_from_db(db_session)
    assert (
        priority_preview.rank_snapshot_token(
            rebuilt,
            project_id=moved.id,
            band="P2",
            from_rank=from_rank,
            before=None,
            after=anchor.id,
        )
        == token
    )
    order = await _order(db_session, "P2")
    assert order.index(str(moved.id)) == order.index(str(anchor.id)) + 1


async def test_i37d_priority_move_preview_token_equals_rebuilt_input(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    moved = w.p2[1]
    p2_before = await _order(db_session, "P2")
    async with _client(db_session) as client:
        preview = await client.post(
            f"/projects/{moved.id}/priority/preview", json={"priority": "P1"}
        )
        token = preview.json()["preview_token"]
        resp = await client.post(
            f"/projects/{moved.id}/priority", json={"priority": "P1", "preview_token": token}
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "applied"
    rebuilt = await build_schedule_input_from_db(db_session)
    assert (
        priority_preview.snapshot_token(
            rebuilt,
            project_id=moved.id,
            from_priority=ProjectPriority.P2,
            target=ProjectPriority.P1,
        )
        == token
    )
    # Last in P1, P2 renumbered without it (R36-6).
    assert await _order(db_session, "P1") == [str(w.p1.id), str(moved.id)]
    assert await _order(db_session, "P2") == br.remove(p2_before, str(moved.id))
    await _assert_i37b(db_session)
    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "project.priority_move")
        )
    ).scalar_one()
    assert audit.before_state["band_rank"] == 2
    assert audit.after_state["band_rank"] == 2


async def test_stale_token_after_concurrent_rerank_is_409_and_writes_nothing(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        preview = await _preview(client, w.p2[4].id, before=w.p2[0].id)
        token = preview.json()["preview_token"]
        # Someone else re-ranks the band in between.
        other = await _preview(client, w.p2[2].id, before=w.p2[1].id)
        applied = await _confirm(
            client, w.p2[2].id, other.json()["preview_token"], before=w.p2[1].id
        )
        assert applied.status_code == 200, applied.text
        order = await _order(db_session, "P2")
        runs = await _count(db_session, ScheduleRun)
        stale = await _confirm(client, w.p2[4].id, token, before=w.p2[0].id)
    assert stale.status_code == 409
    assert stale.json()["code"] == "PREVIEW_STALE"
    assert await _order(db_session, "P2") == order
    assert await _count(db_session, ScheduleRun) == runs


async def test_filtered_board_anchor_lands_next_to_visible_card(db_session):
    """A drop below the last visible card (`after`) lands right after it, and
    every hidden card keeps its relative order (I37c)."""

    w = await _world(db_session, n_p2=6, baseline=False)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    order_before = await _order(db_session, "P2")
    moved, visible_last = w.p2[5], w.p2[1]  # cards 3..5 hidden by a filter
    async with _client(db_session) as client:
        preview = await _preview(client, moved.id, after=visible_last.id)
        resp = await _confirm(
            client, moved.id, preview.json()["preview_token"], after=visible_last.id
        )
    assert resp.status_code == 200, resp.text
    order_after = await _order(db_session, "P2")
    assert (
        check_i37c_placement(
            order_before, order_after, str(moved.id), after_project_id=str(visible_last.id)
        )
        == ()
    )
    assert order_after[2] == str(moved.id)


async def test_confirm_deferred_when_a_run_is_in_flight(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        preview = await _preview(client, w.p2[3].id, before=w.p2[0].id)
        top = (await db_session.execute(select(func.max(ScheduleRun.version)))).scalar_one() or 0
        await make_schedule_run(db_session, status=ScheduleRunStatus.QUEUED, version=top + 1)
        resp = await _confirm(
            client, w.p2[3].id, preview.json()["preview_token"], before=w.p2[0].id
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "deferred"
    assert resp.headers["X-Schedule-Recalc"] == "deferred"
    assert (await _order(db_session, "P2"))[0] == str(w.p2[3].id)
    assert (await _fresh(db_session, w.p2[3].id)).schedule_stale is True


async def test_frozen_project_rerank_moves_no_date_of_its_own(db_session):
    w = await _world(db_session, baseline=False)
    frozen = await w.project("Frozen", ProjectPriority.P2, frozen=True, actual_start_week=30)
    await _activate_baseline(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    order = await _order(db_session, "P2")
    place = (
        {"after": uuid.UUID(order[-1])} if order[0] == str(frozen.id) else {"before": w.p2[0].id}
    )
    async with _client(db_session) as client:
        resp = await _preview(client, frozen.id, **place)
    assert resp.status_code == 200, resp.text
    assert resp.json()["result"] == "preview"
    moved = resp.json()["moved"]
    assert moved["end_week_before"] == moved["end_week_after"]


# --- lifecycle on every write path (R36-8) ------------------------------------------------


async def test_registration_enters_band_last(db_session):
    w = await _world(db_session, baseline=False)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    body = registration_body(w.hub, w.leader, priority="P2", category="C")
    async with _client(db_session) as client:
        resp = await client.post("/projects", json=body)
    assert resp.status_code == 201, resp.text
    order = await _order(db_session, "P2")
    assert order[-1] == resp.json()["id"] and len(order) == len(w.p2) + 1
    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "project.create")
        )
    ).scalar_one()
    assert audit.after_state["band_rank"] == len(w.p2) + 1
    await _assert_i37b(db_session)


async def test_draft_submit_enters_band_last(db_session):
    w = await _world(db_session, baseline=False)
    draft = await make_project(
        db_session,
        w.hub,
        leader=w.leader,
        name="Legacy draft",
        status=ProjectStatus.DRAFT,
        priority=ProjectPriority.P2,
        category=ProjectCategory.C,
        actual_start_week=31,
        tcogs_eur=1,
        selling_price_eur=2,
        gross_margin_pct=50,
    )
    assert draft.band_rank is None
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{draft.id}/submit", json={})
    assert resp.status_code == 200, resp.text
    assert (await _order(db_session, "P2"))[-1] == str(draft.id)
    await _assert_i37b(db_session)


async def test_patch_status_out_and_back_and_schedulable_change_keeps_rank(db_session, dispatch):
    w = await _world(db_session, baseline=False)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    second = w.p2[1]
    order = await _order(db_session, "P2")
    async with _client(db_session) as client:
        hold = await client.patch(f"/projects/{second.id}", json={"status": "On Hold"})
        assert hold.status_code == 200, hold.text
        assert await _order(db_session, "P2") == br.remove(order, str(second.id))
        assert (await _fresh(db_session, second.id)).band_rank is None
        await _assert_i37b(db_session)

        back = await client.patch(f"/projects/{second.id}", json={"status": "In Queue"})
        assert back.status_code == 200, back.text
        after_back = await _order(db_session, "P2")
        assert after_back == br.append_last(br.remove(order, str(second.id)), str(second.id))
        await _assert_i37b(db_session)

        # R36-3: a schedulable -> schedulable change keeps the rank.
        first = w.p2[0]
        dev = await client.patch(f"/projects/{first.id}", json={"status": "In Buyoff"})
        assert dev.status_code == 200, dev.text
        assert await _order(db_session, "P2") == after_back

        # A status + priority PATCH: out of P2 into P1 last.
        both = await client.patch(
            f"/projects/{first.id}", json={"status": "In Development", "priority": "P1"}
        )
        assert both.status_code == 200, both.text
    assert await _order(db_session, "P1") == [str(w.p1.id), str(first.id)]
    assert str(first.id) not in await _order(db_session, "P2")
    await _assert_i37b(db_session)


async def test_patch_priority_appends_last_and_renumbers(db_session, dispatch):
    w = await _world(db_session, baseline=False)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    p2 = await _order(db_session, "P2")
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{w.p1.id}", json={"priority": "P2"})
        plain = await client.post(f"/projects/{w.p2[0].id}/priority", json={"priority": "P1"})
    assert resp.status_code == 200, resp.text
    assert plain.status_code == 200, plain.text
    assert await _order(db_session, "P2") == br.remove(
        br.append_last(p2, str(w.p1.id)), str(w.p2[0].id)
    )
    assert await _order(db_session, "P1") == [str(w.p2[0].id)]
    await _assert_i37b(db_session)


async def test_register_batch_appends_enterers_by_id_and_renumbers_once(db_session, dispatch):
    w = await _world(db_session, n_p2=3, baseline=False)
    held = [
        await w.project(f"Held {i}", ProjectPriority.P2, status=ProjectStatus.ON_HOLD)
        for i in range(3)
    ]
    await _act_as(db_session, RoleName.ADMIN)
    order = await _order(db_session, "P2")
    leaver = w.p2[0]
    edits = [{"project_id": str(p.id), "status": "In Queue"} for p in reversed(held)]
    edits.append({"project_id": str(leaver.id), "status": "Cancelled"})
    edits.append({"project_id": str(w.p2[1].id), "status": "In Development"})  # keeps rank
    async with _client(db_session) as client:
        resp = await client.post("/projects/register-edits", json={"edits": edits})
    assert resp.status_code == 200, resp.text
    expected = br.append_all_last(br.remove(order, str(leaver.id)), [str(p.id) for p in held])
    assert await _order(db_session, "P2") == expected
    assert (await _fresh(db_session, leaver.id)).band_rank is None
    await _assert_i37b(db_session)


async def test_register_batch_failure_rolls_back_ranks(db_session, dispatch):
    w = await _world(db_session, n_p2=3, baseline=False)
    held = await w.project("Held", ProjectPriority.P2, status=ProjectStatus.ON_HOLD)
    await _act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    order = await _order(db_session, "P2")
    held_id = held.id
    edits = [
        {"project_id": str(held_id), "status": "In Queue"},
        {"project_id": str(w.p2[0].id), "status": "Draft"},  # rejected
    ]
    async with _client(db_session) as client:
        resp = await client.post("/projects/register-edits", json={"edits": edits})
    assert resp.status_code == 422, resp.text
    assert await _order(db_session, "P2") == order
    assert (await _fresh(db_session, held_id)).band_rank is None


# --- board -----------------------------------------------------------------------------


async def test_board_sorted_by_band_rank_serves_rank_and_frozen(db_session):
    w = await _world(db_session, baseline=False)
    buyoff = await w.project("Buyoff", ProjectPriority.P2, status=ProjectStatus.IN_BUYOFF)
    frozen = await w.project("Frozen", ProjectPriority.P2, frozen=True, actual_start_week=30)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        # Put the In Buyoff project last by rank: rank beats status (R36-3).
        preview = await _preview(client, buyoff.id)
        assert preview.status_code == 200, preview.text
        if preview.json()["result"] != "unchanged":
            moved = await _confirm(client, buyoff.id, preview.json()["preview_token"])
            assert moved.status_code == 200, moved.text
        board = await client.get("/priority-board")
        filtered = await client.get("/priority-board", params={"q": "Buyoff"})
    assert board.status_code == 200, board.text
    p2 = next(c for c in board.json()["columns"] if c["priority"] == "P2")
    ranks = [c["band_rank"] for c in p2["cards"]]
    assert ranks == list(range(1, len(ranks) + 1))
    assert [c["project_id"] for c in p2["cards"]] == await _order(db_session, "P2")
    assert p2["cards"][-1]["project_id"] == str(buyoff.id)
    by_id = {c["project_id"]: c for c in p2["cards"]}
    assert by_id[str(frozen.id)]["frozen"] is True
    assert by_id[str(w.p2[0].id)]["frozen"] is False
    fcol = next(c for c in filtered.json()["columns"] if c["priority"] == "P2")
    assert [c["band_rank"] for c in fcol["cards"]] == [len(ranks)]


# --- P36-R01: security remediation (M-1, L-2, I-8) -------------------------------------
#
# M-1: the band-rank advisory lock is taken only after lookup, authorisation
# and rate limit, and its wait is bounded by `lock_timeout` (503
# `BAND_RANK_BUSY`). L-2: the re-rank confirm re-checks scope after the
# re-read. I-8: 401 / Executive Viewer / Auditor / confirm out of hub.


async def _own_advisory_locks(db_session) -> int:
    """Advisory locks held by the test session's own backend. The test's outer
    transaction never ends inside a test, so a transaction-scoped advisory lock
    a request took is still held here afterwards."""

    return (
        await db_session.execute(
            text(
                "SELECT count(*) FROM pg_locks "
                "WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted"
            )
        )
    ).scalar_one()


@asynccontextmanager
async def _band_lock_held_elsewhere(database_url: str):
    """Hold the band-rank lock on a second connection for the block."""

    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as conn:
            trans = await conn.begin()
            await conn.execute(select(func.pg_advisory_xact_lock(BAND_RANK_LOCK_KEY)))
            try:
                yield
            finally:
                await trans.rollback()
    finally:
        await engine.dispose()


async def test_rerank_401_without_a_token(db_session):
    w = await _world(db_session, baseline=False)
    clear_current_principal_override()
    async with _client(db_session) as client:
        preview = await _preview(client, w.p2[2].id, before=w.p2[0].id)
        confirm = await _confirm(client, w.p2[2].id, "x" * 64, before=w.p2[0].id)
    assert preview.status_code == 401
    assert confirm.status_code == 401


@pytest.mark.parametrize("role", [RoleName.EXECUTIVE_VIEWER, RoleName.AUDITOR])
async def test_rerank_read_only_roles_are_403_and_write_nothing(db_session, role):
    w = await _world(db_session, baseline=False)
    await _act_as(db_session, role)
    order = await _order(db_session, "P2")
    audits = await _count(db_session, AuditLogEntry)
    async with _client(db_session) as client:
        preview = await _preview(client, w.p2[2].id, before=w.p2[0].id)
        confirm = await _confirm(client, w.p2[2].id, "x" * 64, before=w.p2[0].id)
    assert preview.status_code == 403, preview.text
    assert confirm.status_code == 403, confirm.text
    assert await _order(db_session, "P2") == order
    assert await _count(db_session, AuditLogEntry) == audits
    assert await _own_advisory_locks(db_session) == 0


async def test_rerank_confirm_out_of_hub_project_is_404_like_a_random_id(db_session):
    w = await _world(db_session, other_hub=True, baseline=False)
    out_of_scope = next(p for p in w.p2 if p.hub_id == w.hub_b.id)
    anchor = next(p for p in w.p2 if p.hub_id == w.hub.id)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    order = await _order(db_session, "P2")
    async with _client(db_session) as client:
        hidden = await _confirm(client, out_of_scope.id, "x" * 64, before=anchor.id)
        missing = await _confirm(client, uuid.uuid4(), "x" * 64, before=anchor.id)
    assert hidden.status_code == 404, hidden.text
    assert hidden.json() == missing.json()
    assert await _order(db_session, "P2") == order
    assert await _own_advisory_locks(db_session) == 0


async def test_rerank_confirm_rechecks_scope_after_the_lock(db_session, monkeypatch):
    """L-2: a project moved out of the caller's hub while the confirm waited
    for the lock is a 404 after the re-read, and nothing is written."""

    w = await _world(db_session, other_hub=True, baseline=False)
    in_hub = [p for p in w.p2 if p.hub_id == w.hub.id]
    moved, anchor = in_hub[2], in_hub[0]
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    order = await _order(db_session, "P2")
    real_lock = projects_router.lock_band_ranks

    async def lock_then_rehub(db):
        await real_lock(db)
        # What a concurrent writer committed before the lock was granted.
        await db.execute(
            update(Project).where(Project.id == moved.id).values(hub_id=w.hub_b.id)
        )

    monkeypatch.setattr(projects_router, "lock_band_ranks", lock_then_rehub)
    async with _client(db_session) as client:
        resp = await _confirm(client, moved.id, "x" * 64, before=anchor.id)
    assert resp.status_code == 404, resp.text
    assert await _order(db_session, "P2") == order
    assert (
        await _count(db_session, AuditLogEntry, AuditLogEntry.action == "project.band_rank_move")
        == 0
    )


async def test_unauthorised_writes_never_take_the_band_lock(db_session, database_url):
    """M-1: with the band-rank lock held by another transaction, every
    unauthorised status / priority write answers its 403 / 404 at once
    (never waits for the lock, never 503s) and leaves the lock untouched."""

    w = await _world(db_session, other_hub=True, baseline=False)
    # Plain ids: the register batch's 403 rolls the session back (expiring
    # the ORM objects), so the world is committed to the test's outer
    # transaction first.
    out_of_scope = SimpleNamespace(id=next(p.id for p in w.p2 if p.hub_id == w.hub_b.id))
    in_scope = SimpleNamespace(id=next(p.id for p in w.p2 if p.hub_id == w.hub.id))
    first_id, hub_id = w.p2[0].id, w.hub.id
    await db_session.commit()
    assert band_rank_service.BAND_RANK_LOCK_TIMEOUT == "5s"

    async with _band_lock_held_elsewhere(database_url):
        started = time.monotonic()
        async with _client(db_session) as client:
            await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub_id])
            patch_hidden = await client.patch(
                f"/projects/{out_of_scope.id}", json={"status": "On Hold"}
            )
            prio_hidden = await client.post(
                f"/projects/{out_of_scope.id}/priority", json={"priority": "P1"}
            )
            prio_confirm_hidden = await client.post(
                f"/projects/{out_of_scope.id}/priority",
                json={"priority": "P1", "preview_token": "x" * 64},
            )
            batch_hidden = await client.post(
                "/projects/register-edits",
                json={
                    "edits": [
                        {"project_id": str(in_scope.id), "status": "On Hold"},
                        {"project_id": str(out_of_scope.id), "status": "On Hold"},
                    ]
                },
            )
            submit_hidden = await client.post(f"/projects/{out_of_scope.id}/submit", json={})

            await _act_as(db_session, RoleName.ENGINEER)
            patch_engineer = await client.patch(
                f"/projects/{in_scope.id}", json={"priority": "P1"}
            )
            prio_engineer = await client.post(
                f"/projects/{in_scope.id}/priority", json={"priority": "P1"}
            )
            batch_engineer = await client.post(
                "/projects/register-edits",
                json={"edits": [{"project_id": str(in_scope.id), "status": "On Hold"}]},
            )

            await _act_as(db_session, RoleName.EXECUTIVE_VIEWER)
            rank_viewer = await _confirm(client, in_scope.id, "x" * 64, before=first_id)
        elapsed = time.monotonic() - started

    assert patch_hidden.status_code == 404, patch_hidden.text
    assert prio_hidden.status_code == 404, prio_hidden.text
    assert prio_confirm_hidden.status_code == 404, prio_confirm_hidden.text
    assert batch_hidden.status_code == 403, batch_hidden.text
    assert batch_hidden.json()["code"] == "REGISTER_EDITS_FORBIDDEN"
    assert [e["project_id"] for e in batch_hidden.json()["detail"]["errors"]] == [
        str(out_of_scope.id)
    ]
    assert submit_hidden.status_code in (403, 404), submit_hidden.text
    assert patch_engineer.status_code in (403, 404), patch_engineer.text
    assert prio_engineer.status_code in (403, 404), prio_engineer.text
    assert batch_engineer.status_code == 403, batch_engineer.text
    assert rank_viewer.status_code == 403, rank_viewer.text
    # Nine requests, none of which waited on the held lock (5 s each).
    assert elapsed < 5
    assert await _own_advisory_locks(db_session) == 0
    assert (await _fresh(db_session, in_scope.id)).status == ProjectStatus.IN_QUEUE
    assert (await _fresh(db_session, out_of_scope.id)).status == ProjectStatus.IN_QUEUE


async def test_authorised_write_takes_the_band_lock(db_session, dispatch):
    """Control for the test above: an authorised status write does take it."""

    w = await _world(db_session, baseline=False)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    assert await _own_advisory_locks(db_session) == 0
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{w.p2[1].id}", json={"status": "On Hold"})
    assert resp.status_code == 200, resp.text
    assert await _own_advisory_locks(db_session) >= 1


async def test_band_lock_timeout_is_503_band_rank_busy_and_writes_nothing(
    db_session, database_url, dispatch, monkeypatch
):
    w = await _world(db_session, other_hub=True, baseline=False)
    monkeypatch.setattr(band_rank_service, "BAND_RANK_LOCK_TIMEOUT", "200ms")
    # Plain ids: each 503 rolls the session back (expiring the ORM objects),
    # so the world and the user are committed to the outer transaction first.
    target = SimpleNamespace(id=w.p2[1].id)
    first_id = w.p2[0].id
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    await db_session.commit()
    order = await _order(db_session, "P2")
    audits = await _count(db_session, AuditLogEntry)
    async with _band_lock_held_elsewhere(database_url):
        async with _client(db_session) as client:
            patch = await client.patch(f"/projects/{target.id}", json={"status": "On Hold"})
            prio = await client.post(f"/projects/{target.id}/priority", json={"priority": "P1"})
            batch = await client.post(
                "/projects/register-edits",
                json={"edits": [{"project_id": str(target.id), "status": "On Hold"}]},
            )
            preview = await _preview(client, target.id, before=first_id)
            token = preview.json()["preview_token"]
            rank = await _confirm(client, target.id, token, before=first_id)
            # A PATCH that touches neither status nor priority never locks.
            rename = await client.patch(f"/projects/{target.id}", json={"name": "Renamed"})
    assert preview.status_code == 200, preview.text
    for resp in (patch, prio, batch, rank):
        assert resp.status_code == 503, resp.text
        assert resp.json()["code"] == "BAND_RANK_BUSY"
        assert resp.headers["Retry-After"] == str(band_rank_service.BAND_RANK_BUSY_RETRY_AFTER)
    assert rename.status_code == 200, rename.text
    fresh = await _fresh(db_session, target.id)
    assert fresh.status == ProjectStatus.IN_QUEUE
    assert fresh.priority == ProjectPriority.P2
    assert await _order(db_session, "P2") == order
    # Only the rename's audit row.
    assert await _count(db_session, AuditLogEntry) == audits + 1
    # The lock_timeout was restored after a granted lock (not left at 200ms).
    async with _client(db_session) as client:
        ok = await client.patch(f"/projects/{target.id}", json={"status": "On Hold"})
    assert ok.status_code == 200, ok.text
    timeout = (await db_session.execute(text("SHOW lock_timeout"))).scalar_one()
    assert timeout != "200ms"
