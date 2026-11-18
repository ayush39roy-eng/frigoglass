"""P38-T04: engineer deactivation, backend (ADR 0053 as ruled at P38-T01,
R38-1..R38-9; docs/API_CONTRACT_P38.md; DOMAIN_RULES "Engineer deactivation").

In-session tests (the shared container, one rolled-back transaction per test):
reads and `?status=`, the preview (RBAC, facts, candidates by the scheduler's
category predicate, supply effect by R38-1), deactivate (exact set → 409,
per-row 422s, one transaction, audit, leader history, schedule_stale, band
rank kept, exactly one run iff R38-5 (a) or (b), else `not_needed`),
reactivate, DELETE 410, PATCH on an inactive engineer, `LEADER_INACTIVE` on
every leader write path incl. reopen (R38-4), the user-engineer link, the
closed plan year (R38-7), and the DB-side I42 / append-only guards.

The concurrency tests (locks across two connections) are in
`tests/test_p38_engineer_race.py`, on their own container.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

import api.routers.engineers as engineers_router
import api.routers.projects as projects_router
import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.engineer import Engineer, EngineerInactivePeriod, ProjectLeaderHistory
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    ScheduleRunStatus,
    SolverType,
    WorkflowStepStatus,
)
from models.project import Project
from models.schedule import ScheduleRun
from models.workflow import ProjectWorkflowStep
from scheduling.greedy import run_greedy_sgs
from schemas.engineer import (
    DeactivateRequest,
    DeactivateResponse,
    DeactivationPreview,
    DeactivationSupplyEffect,
    EngineerRead,
)
from services import plan_clock
from services.project_steps import sync_project_steps
from services.schedule_apply import persist_solved_run
from services.schedule_persistence import build_schedule_input_from_db
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_project, make_user, registration_body
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    for limiter in (
        engineers_router.ENGINEER_STATUS_RATE_LIMIT,
        engineers_router.DEACTIVATION_PREVIEW_RATE_LIMIT,
        projects_router.REGISTER_EDITS_RATE_LIMIT,
    ):
        limiter.reset()
    yield
    for limiter in (
        engineers_router.ENGINEER_STATUS_RATE_LIMIT,
        engineers_router.DEACTIVATION_PREVIEW_RATE_LIMIT,
        projects_router.REGISTER_EDITS_RATE_LIMIT,
    ):
        limiter.reset()
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
    # Survives a request's rollback (see `_world`).
    await db_session.commit()
    return user


async def _count(db_session, model, *where) -> int:
    return (
        await db_session.execute(select(func.count()).select_from(model).where(*where))
    ).scalar_one()


async def _fresh(db_session, model, row_id):
    return (
        await db_session.execute(
            select(model).where(model.id == row_id).execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _i42_violations(db_session) -> list[str]:
    """I42 as a query: open projects led by inactive engineers, and engineers
    whose `active` disagrees with their open-period count."""

    leaders = (
        (
            await db_session.execute(
                select(Project.id)
                .join(Engineer, Engineer.id == Project.leader_engineer_id)
                .where(
                    Engineer.active.is_(False),
                    Project.status.not_in([ProjectStatus.COMMERCIALIZED, ProjectStatus.CANCELLED]),
                )
            )
        )
        .scalars()
        .all()
    )
    open_count = (
        select(func.count())
        .select_from(EngineerInactivePeriod)
        .where(
            EngineerInactivePeriod.engineer_id == Engineer.id,
            EngineerInactivePeriod.to_week.is_(None),
        )
        .scalar_subquery()
    )
    engineers = (
        await db_session.execute(select(Engineer.id, Engineer.active, open_count.label("n")))
    ).all()
    bad = [f"project {p}" for p in leaders]
    bad += [
        f"engineer {e.id}"
        for e in engineers
        if (e.active and e.n != 0) or (not e.active and e.n != 1)
    ]
    return bad


async def _world(db_session):
    """R&D-Greece with Elena (to deactivate; leads A/C), Nikos (allows C,
    eligible), Maria (allows A only), Kostas (other hub, allows C); projects
    led by Elena: an In Development C (progress-tracked, 2 Done, lab in
    flight), an In Queue C, an On Hold C, a frozen In Queue C, plus a
    Commercialized and a Cancelled one (not open)."""

    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    c = [EngineerAllowedCategory.C, EngineerAllowedCategory.A]
    elena = await make_engineer(db_session, hub, name="Elena", allowed_categories=c)
    nikos = await make_engineer(
        db_session, hub, name="Nikos", allowed_categories=[EngineerAllowedCategory.C]
    )
    maria = await make_engineer(
        db_session, hub, name="Maria", allowed_categories=[EngineerAllowedCategory.A]
    )
    kostas = await make_engineer(
        db_session, other, name="Kostas", allowed_categories=[EngineerAllowedCategory.C]
    )

    async def project(name: str, **kw: Any) -> Project:
        p = await make_project(
            db_session,
            hub,
            leader=kw.pop("leader", elena),
            name=name,
            category=ProjectCategory.C,
            priority=kw.pop("priority", ProjectPriority.P2),
            schedule_stale=False,
            certification_testing_required=kw.pop("cert", False),
            **kw,
        )
        await sync_project_steps(db_session, p, False)
        return p

    dev = await project("Dev", status=ProjectStatus.IN_DEVELOPMENT, cert=True)
    queued = await project("Queued")
    held = await project("Held", status=ProjectStatus.ON_HOLD, priority=None)
    frozen = await project("Frozen", frozen=True, actual_start_week=20)
    done = await project("Done", status=ProjectStatus.COMMERCIALIZED)
    cancelled = await project("Cancelled", status=ProjectStatus.CANCELLED, priority=None)
    await db_session.flush()

    # Progress on "Dev": the first two stages Done, a lab stage In Progress.
    steps = (
        (
            await db_session.execute(
                select(ProjectWorkflowStep)
                .where(ProjectWorkflowStep.project_id == dev.id)
                .order_by(ProjectWorkflowStep.step_template_id)
            )
        )
        .scalars()
        .all()
    )
    from models.enums import WorkflowStepKind
    from models.workflow import WorkflowStepTemplate

    kinds = {
        t.id: t.kind
        for t in (await db_session.execute(select(WorkflowStepTemplate))).scalars().all()
    }
    design_steps = [s for s in steps if kinds[s.step_template_id] == WorkflowStepKind.DESIGN]
    lab_steps = [s for s in steps if kinds[s.step_template_id] == WorkflowStepKind.LAB]
    await db_session.execute(
        text(
            "UPDATE project_workflow_steps SET status = 'Done', percent_complete = 100, "
            "actual_start_week = 1, "
            "actual_end_week = 2 WHERE id = ANY(:ids)"
        ),
        {"ids": [design_steps[0].id, design_steps[1].id]},
    )
    if lab_steps:
        await db_session.execute(
            text(
                "UPDATE project_workflow_steps SET status = 'In Progress', "
                "actual_start_week = 30 WHERE id = :id"
            ),
            {"id": lab_steps[0].id},
        )
    await db_session.flush()
    # Committed to the test's outer transaction, so a request that rolls back
    # (409 / 422 / 503 paths) does not take the world with it. Such a
    # rollback expires the ORM objects: tests read `ids` afterwards.
    await db_session.commit()
    objs = dict(
        hub=hub,
        other=other,
        elena=elena,
        nikos=nikos,
        maria=maria,
        kostas=kostas,
        dev=dev,
        queued=queued,
        held=held,
        frozen=frozen,
        done=done,
        cancelled=cancelled,
    )
    return SimpleNamespace(
        ids=SimpleNamespace(**{k: v.id for k, v in objs.items()}),
        hub=hub,
        other=other,
        elena=elena,
        nikos=nikos,
        maria=maria,
        kostas=kostas,
        dev=dev,
        queued=queued,
        held=held,
        frozen=frozen,
        done=done,
        cancelled=cancelled,
        project=project,
    )


async def _activate_baseline(db_session) -> ScheduleRun:
    schedule_input = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
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


async def _preview(client, engineer_id):
    return await client.get(f"/engineers/{engineer_id}/deactivation-preview")


def _rows(pairs) -> list[dict[str, Any]]:
    return [
        {"project_id": str(p), "leader_engineer_id": str(e) if e is not None else None}
        for p, e in pairs
    ]


async def _deactivate(client, engineer_id, token, pairs, reason="left_company"):
    return await client.post(
        f"/engineers/{engineer_id}/deactivate",
        json={"reason": reason, "led_projects_token": token, "reassignments": _rows(pairs)},
    )


# --- reads ----------------------------------------------------------------------------


async def test_engineer_read_and_status_filter(db_session):
    w = await _world(db_session)
    w.maria.active = False
    w.maria.deactivated_at = datetime.now(UTC)
    w.maria.deactivated_week = 20
    w.maria.deactivated_plan_year = 2026
    w.maria.deactivation_reason = "changed_role"
    db_session.add(
        EngineerInactivePeriod(engineer_id=w.maria.id, from_plan_year=2026, from_week=20)
    )
    await db_session.flush()
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        default = await client.get("/engineers")
        inactive = await client.get("/engineers", params={"status": "inactive"})
        every = await client.get("/engineers", params={"status": "all"})
        bad = await client.get("/engineers", params={"status": "gone"})
        one = await client.get(f"/engineers/{w.maria.id}")
    assert default.status_code == 200, default.text
    assert [e["name"] for e in default.json()] == ["Elena", "Nikos"]
    assert all(e["active"] for e in default.json())
    assert [e["name"] for e in inactive.json()] == ["Maria"]
    maria = inactive.json()[0]
    assert maria["active"] is False
    assert maria["deactivated_week"] == 20
    assert maria["deactivated_plan_year"] == 2026
    assert maria["deactivation_reason"] == "changed_role"
    assert "deactivated_by_user_id" not in maria
    # Hub scope unchanged: Kostas (PD-India) is never listed.
    assert [e["name"] for e in every.json()] == ["Elena", "Maria", "Nikos"]
    assert bad.status_code == 422
    assert one.status_code == 200 and one.json()["active"] is False
    elena = default.json()[0]
    assert elena["deactivated_at"] is None and elena["deactivation_reason"] is None


# --- preview --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "role", [RoleName.HUB_PLANNER, RoleName.PORTFOLIO_MANAGER, RoleName.EXECUTIVE_VIEWER]
)
async def test_status_endpoints_are_admin_only(db_session, role):
    w = await _world(db_session)
    await _act_as(db_session, role)
    audits = await _count(db_session, AuditLogEntry)
    async with _client(db_session) as client:
        preview = await _preview(client, w.elena.id)
        deactivate = await _deactivate(client, w.elena.id, "x", [])
        reactivate = await client.post(f"/engineers/{w.elena.id}/reactivate")
    for resp in (preview, deactivate, reactivate):
        assert resp.status_code == 403, resp.text
        if role != RoleName.EXECUTIVE_VIEWER:
            assert resp.json()["code"] == "ENGINEER_STATUS_ADMIN_ONLY"
    assert (await _fresh(db_session, Engineer, w.elena.id)).active is True
    assert await _count(db_session, AuditLogEntry) == audits


@pytest.mark.parametrize("role", [RoleName.ADMIN, RoleName.SUPER_ADMIN])
async def test_preview_serves_open_projects_facts_candidates_and_supply(db_session, role):
    w = await _world(db_session)
    run = await _activate_baseline(db_session)
    assert run.is_active
    await _act_as(db_session, role)
    async with _client(db_session) as client:
        resp = await _preview(client, w.elena.id)
        unknown = await _preview(client, uuid.uuid4())
    assert unknown.status_code == 404
    assert resp.status_code == 200, resp.text
    body = DeactivationPreview.model_validate(resp.json())
    assert body.engineer.name == "Elena" and body.engineer.hub == "R&D-Greece"
    assert body.engineer.active is True
    assert body.deactivation_week == TEST_WEEK
    assert body.has_linked_login is False
    # Open = not Commercialized / Cancelled, by id.
    open_ids = sorted([w.dev.id, w.queued.id, w.held.id, w.frozen.id])
    assert [r.project_id for r in body.open_projects] == open_ids
    rows = {r.project_id: r for r in body.open_projects}
    dev = rows[w.dev.id]
    assert (dev.status, dev.schedulable, dev.frozen) == ("In Development", True, False)
    assert dev.progress_tracked is True and dev.done_stages == 2
    assert dev.in_flight_lab is True
    queued = rows[w.queued.id]
    assert (queued.progress_tracked, queued.done_stages, queued.in_flight_lab) == (False, 0, False)
    assert rows[w.held.id].schedulable is False
    assert rows[w.frozen.id].frozen is True
    # Candidates: same capacity hub, active, eligible for C, never Elena.
    for r in body.open_projects:
        assert [c.name for c in r.candidates] == ["Nikos"]
        assert r.candidates[0].fte == 1.0
        assert r.candidates[0].load_weeks == 0.0
    # Token = the sorted id set.
    assert body.led_projects_token == engineers_router.led_projects_token(open_ids)
    # Supply (R38-1), no calendar → 52 working weeks; three counted engineers at W31.
    assert body.supply_effect == DeactivationSupplyEffect.model_validate(
        {
            "capacity_hub": "R&D-Greece",
            "yearly_design_capacity": {"before": 156.0, "after": 52.0 * (2 + 31 / 52)},
            "remaining_design_capacity": {"before": 63.0, "after": 42.0},
        }
    )


async def test_preview_candidates_sorted_by_load_per_fte_then_name(db_session):
    w = await _world(db_session)
    half = await make_engineer(
        db_session, w.hub, name="Anna", fte=0.5, allowed_categories=[EngineerAllowedCategory.C]
    )
    # Nikos leads a C project of his own, so the active run books him.
    await w.project("Nikos own", leader=w.nikos)
    await _activate_baseline(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        body = (await _preview(client, w.elena.id)).json()
    names = [c["name"] for c in body["open_projects"][0]["candidates"]]
    assert names == ["Anna", "Nikos"]
    loads = {c["name"]: c["load_weeks"] for c in body["open_projects"][0]["candidates"]}
    assert loads["Anna"] == 0.0 and loads["Nikos"] > 0
    assert half.active


async def test_preview_no_supply_effect_when_not_counted_and_409_when_inactive(db_session):
    w = await _world(db_session)
    w.elena.counts_in_capacity = False
    w.maria.active = False
    w.maria.deactivated_at = datetime.now(UTC)
    w.maria.deactivated_week = 3
    w.maria.deactivated_plan_year = 2026
    w.maria.deactivation_reason = "other"
    db_session.add(EngineerInactivePeriod(engineer_id=w.maria.id, from_plan_year=2026, from_week=3))
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        elena = await _preview(client, w.elena.id)
        maria = await _preview(client, w.maria.id)
    assert elena.json()["supply_effect"] is None
    # Maria is inactive: never a candidate.
    assert all(
        [c["name"] for c in r["candidates"]] == ["Nikos"] for r in elena.json()["open_projects"]
    )
    assert maria.status_code == 409 and maria.json()["code"] == "ENGINEER_ALREADY_INACTIVE"


# --- deactivate -------------------------------------------------------------------------


async def test_deactivate_mixed_rows_one_transaction_one_run(db_session, dispatch):
    w = await _world(db_session)
    await _activate_baseline(db_session)
    user = await _act_as(db_session, RoleName.SUPER_ADMIN)
    ranks = {p.id: p.band_rank for p in (w.dev, w.queued, w.frozen)}
    async with _client(db_session) as client:
        token = (await _preview(client, w.elena.id)).json()["led_projects_token"]
        resp = await _deactivate(
            client,
            w.elena.id,
            token,
            [
                (w.dev.id, w.nikos.id),
                (w.queued.id, None),
                (w.held.id, None),
                (w.frozen.id, w.maria.id),
            ],
        )
    assert resp.status_code == 200, resp.text
    body = DeactivateResponse.model_validate(resp.json())
    assert body.engineer.active is False
    assert body.engineer.deactivated_week == TEST_WEEK
    assert body.engineer.deactivated_plan_year == 2026
    assert body.engineer.deactivation_reason == "left_company"
    assert (body.reassigned, body.left_without_leader) == (2, 2)
    assert body.left_without_leader_project_ids == sorted([w.queued.id, w.held.id])
    # Maria does not allow C: accepted, warned.
    assert [(x.project_id, x.code) for x in body.warnings] == [(w.frozen.id, "CAT_NOT_ALLOWED")]
    # Exactly one run.
    assert body.run.status == "queued" and body.run.run_id is not None
    assert len(dispatch) == 1
    runs = (
        (
            await db_session.execute(
                select(ScheduleRun).where(ScheduleRun.trigger_reason == "engineer_deactivated")
            )
        )
        .scalars()
        .all()
    )
    assert [r.id for r in runs] == [body.run.run_id]
    assert runs[0].status == ScheduleRunStatus.QUEUED

    # Projects: leaders, provisional flag, stale for schedulable ones, ranks kept.
    dev = await _fresh(db_session, Project, w.dev.id)
    queued = await _fresh(db_session, Project, w.queued.id)
    held = await _fresh(db_session, Project, w.held.id)
    frozen = await _fresh(db_session, Project, w.frozen.id)
    done = await _fresh(db_session, Project, w.done.id)
    assert (dev.leader_engineer_id, queued.leader_engineer_id, held.leader_engineer_id) == (
        w.nikos.id,
        None,
        None,
    )
    assert frozen.leader_engineer_id == w.maria.id
    assert done.leader_engineer_id == w.elena.id  # closed: keeps the inactive leader
    assert all(not p.leader_is_provisional for p in (dev, queued, held, frozen))
    assert dev.schedule_stale and queued.schedule_stale and frozen.schedule_stale
    assert held.schedule_stale is False
    assert {p.id: p.band_rank for p in (dev, queued, frozen)} == ranks

    # Period, history and audit.
    periods = (
        (
            await db_session.execute(
                select(EngineerInactivePeriod).where(
                    EngineerInactivePeriod.engineer_id == w.elena.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert [(p.from_plan_year, p.from_week, p.to_week) for p in periods] == [(2026, 31, None)]
    history = (
        (
            await db_session.execute(
                select(ProjectLeaderHistory).where(ProjectLeaderHistory.engineer_id == w.elena.id)
            )
        )
        .scalars()
        .all()
    )
    assert sorted((h.project_id, h.new_engineer_id) for h in history) == sorted(
        [(w.dev.id, w.nikos.id), (w.queued.id, None), (w.held.id, None), (w.frozen.id, w.maria.id)]
    )
    assert {(h.cause, h.to_week, h.plan_year, h.changed_by_user_id) for h in history} == {
        ("engineer_deactivated", 31, 2026, user.id)
    }
    updates = (
        (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == "project.update",
                    AuditLogEntry.actor_user_id == user.id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(updates) == 4
    for row in updates:
        assert row.after_state["cause"] == "engineer_deactivated"
        assert row.before_state["leader_engineer_id"] == str(w.elena.id)
        for key in ("customer_name", "tcogs_eur", "selling_price_eur", "gross_margin_pct"):
            assert row.before_state[key] == "<redacted>"
            assert row.after_state[key] == "<redacted>"
    deact = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "engineer.deactivate")
        )
    ).scalar_one()
    assert deact.before_state["active"] is True
    assert deact.after_state["active"] is False
    assert deact.after_state["deactivated_week"] == 31
    assert deact.after_state["deactivation_reason"] == "left_company"
    assert deact.after_state["deactivated_by_user_id"] == str(user.id)
    # Only codes and counts: no free-text field anywhere in the row.
    assert set(deact.after_state) - set(deact.before_state) == {
        "deactivated_by_user_id",
        "reassigned",
        "left_without_leader",
    }
    requested = await _count(
        db_session, AuditLogEntry, AuditLogEntry.action == "project.recalculate_requested"
    )
    assert requested == 3  # the three schedulable projects
    assert await _i42_violations(db_session) == []


async def test_only_on_hold_changed_and_no_booking_is_not_needed(db_session, dispatch):
    hub = await make_hub(db_session)
    lone = await make_engineer(
        db_session, hub, name="Lone", allowed_categories=[EngineerAllowedCategory.C]
    )
    other = await make_engineer(
        db_session, hub, name="Other", allowed_categories=[EngineerAllowedCategory.C]
    )
    held = await make_project(
        db_session,
        hub,
        leader=lone,
        category=ProjectCategory.C,
        status=ProjectStatus.ON_HOLD,
        priority=None,
    )
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        token = (await _preview(client, lone.id)).json()["led_projects_token"]
        resp = await _deactivate(client, lone.id, token, [(held.id, other.id)])
    assert resp.status_code == 200, resp.text
    assert resp.json()["run"] == {"status": "not_needed", "run_id": None}
    assert dispatch == []
    assert (
        await _count(db_session, ScheduleRun, ScheduleRun.trigger_reason == "engineer_deactivated")
        == 0
    )
    assert await _i42_violations(db_session) == []


async def test_no_open_project_but_active_run_books_after_d_dispatches(db_session, dispatch):
    """R38-5 (b): the plan is stale (an earlier leader change, no run yet);
    the active run still books the engineer after d → one run."""

    w = await _world(db_session)
    await _activate_baseline(db_session)
    # Leader changes without a run: Elena now leads nothing open.
    for p in (w.dev, w.queued, w.held, w.frozen):
        p.leader_engineer_id = w.nikos.id
    await db_session.flush()
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        preview = (await _preview(client, w.elena.id)).json()
        assert preview["open_projects"] == []
        resp = await _deactivate(client, w.elena.id, preview["led_projects_token"], [])
    assert resp.status_code == 200, resp.text
    assert resp.json()["run"]["status"] == "queued"
    assert len(dispatch) == 1
    assert (resp.json()["reassigned"], resp.json()["left_without_leader"]) == (0, 0)


async def test_no_open_project_and_no_booking_is_not_needed(db_session, dispatch):
    hub = await make_hub(db_session)
    idle = await make_engineer(db_session, hub, name="Idle")
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        token = (await _preview(client, idle.id)).json()["led_projects_token"]
        resp = await _deactivate(client, idle.id, token, [], reason="long_absence")
    assert resp.status_code == 200, resp.text
    assert resp.json()["run"]["status"] == "not_needed"
    assert dispatch == []


async def test_deferred_when_a_run_is_in_flight(db_session, dispatch):
    w = await _world(db_session)
    db_session.add(
        ScheduleRun(
            version=9001,
            solver_type=SolverType.GREEDY,
            status=ScheduleRunStatus.RUNNING,
            is_active=False,
            horizon_weeks=78,
            current_week=TEST_WEEK,
            trigger_reason="manual",
        )
    )
    await db_session.flush()
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        token = (await _preview(client, w.elena.id)).json()["led_projects_token"]
        resp = await _deactivate(
            client,
            w.elena.id,
            token,
            [
                (w.dev.id, w.nikos.id),
                (w.queued.id, w.nikos.id),
                (w.held.id, None),
                (w.frozen.id, w.nikos.id),
            ],
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["run"] == {"status": "deferred", "run_id": None}
    assert dispatch == []


async def test_project_assigned_between_preview_and_confirm_is_409(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    audits = await _count(db_session, AuditLogEntry)
    i = w.ids
    async with _client(db_session) as client:
        token = (await _preview(client, i.elena)).json()["led_projects_token"]
        pairs = [(p, i.nikos) for p in (i.dev, i.queued, i.held, i.frozen)]
        late_id = (await w.project("Late arrival")).id
        await db_session.commit()
        stale = await _deactivate(client, i.elena, token, pairs)
        # Same token, but the id set does not match either.
        short = await _deactivate(client, i.elena, token, pairs[:2])
    assert stale.status_code == 409, stale.text
    assert stale.json()["code"] == "LED_PROJECTS_CHANGED"
    fresh_ids = [r["project_id"] for r in stale.json()["detail"]["open_projects"]]
    assert str(late_id) in fresh_ids and len(fresh_ids) == 5
    assert stale.json()["detail"]["led_projects_token"] != token
    assert short.status_code == 409
    assert (await _fresh(db_session, Engineer, i.elena)).active is True
    assert await _count(db_session, AuditLogEntry) == audits
    assert await _count(db_session, ProjectLeaderHistory) == 0
    assert dispatch == []


async def _mark_inactive(db_session, engineer: Engineer, week: int = 3) -> None:
    """An engineer made inactive directly (with its open period), committed."""

    engineer.active = False
    engineer.deactivated_at = datetime.now(UTC)
    engineer.deactivated_week = week
    engineer.deactivated_plan_year = 2026
    engineer.deactivation_reason = "other"
    db_session.add(
        EngineerInactivePeriod(engineer_id=engineer.id, from_plan_year=2026, from_week=week)
    )
    await db_session.flush()
    await db_session.commit()


async def _deactivate_row_error(db_session, i, project_id, leader):
    async with _client(db_session) as client:
        token = (await _preview(client, i.elena)).json()["led_projects_token"]
        rows = {i.dev: i.nikos, i.queued: i.nikos, i.held: None, i.frozen: i.nikos}
        rows[project_id] = leader
        ordered = sorted(rows.items())
        resp = await _deactivate(client, i.elena, token, ordered)
    return resp, [p for p, _ in ordered].index(project_id)


@pytest.mark.parametrize(
    ("case", "code"),
    [
        ("frozen_null", "FROZEN_NEEDS_LEADER"),
        ("inactive", "LEADER_INACTIVE"),
        ("unknown", "UNKNOWN_LEADER"),
        ("itself", "LEADER_INACTIVE"),
        ("out_of_scope", "UNKNOWN_LEADER"),
    ],
)
async def test_row_error_codes(db_session, dispatch, case, code):
    w = await _world(db_session)
    i = w.ids
    await _mark_inactive(db_session, w.maria)
    if case == "out_of_scope":
        # A hub-scoped Admin cannot name an engineer of another hub. (P46, ADR
        # 0058 D1.3: deactivation is Super Admin only, so the probe is one.)
        await _act_as(db_session, RoleName.SUPER_ADMIN, hub_ids=[w.hub.id])
    else:
        await _act_as(db_session, RoleName.SUPER_ADMIN)
    project, leader = {
        "frozen_null": (i.frozen, None),
        "inactive": (i.dev, i.maria),
        "unknown": (i.dev, uuid.uuid4()),
        "itself": (i.dev, i.elena),
        "out_of_scope": (i.dev, i.kostas),
    }[case]
    audits = await _count(db_session, AuditLogEntry)
    resp, index = await _deactivate_row_error(db_session, i, project, leader)
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == code
    detail = resp.json()["detail"]
    assert detail[0]["row_index"] == index
    assert detail[0]["loc"] == ["body", "reassignments", index, "leader_engineer_id"]
    assert (await _fresh(db_session, Engineer, i.elena)).active is True
    assert await _count(db_session, AuditLogEntry) == audits
    assert dispatch == []


async def test_target_outside_capacity_hub_is_accepted_with_a_warning(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        token = (await _preview(client, w.elena.id)).json()["led_projects_token"]
        resp = await _deactivate(
            client,
            w.elena.id,
            token,
            [
                (w.dev.id, w.kostas.id),
                (w.queued.id, w.nikos.id),
                (w.held.id, None),
                (w.frozen.id, w.nikos.id),
            ],
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["warnings"] == [{"project_id": str(w.dev.id), "code": "NOT_IN_CAPACITY_HUB"}]


async def test_request_body_is_strict(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        free_text = await client.post(
            f"/engineers/{w.elena.id}/deactivate",
            json={"reason": "she moved to Paris", "led_projects_token": "x", "reassignments": []},
        )
        extra = await client.post(
            f"/engineers/{w.elena.id}/deactivate",
            json={"reason": "other", "led_projects_token": "x", "reassignments": [], "note": "x"},
        )
        dup = await client.post(
            f"/engineers/{w.elena.id}/deactivate",
            json={
                "reason": "other",
                "led_projects_token": "x",
                "reassignments": _rows([(w.dev.id, None), (w.dev.id, None)]),
            },
        )
    assert free_text.status_code == 422
    assert extra.status_code == 422
    assert dup.status_code == 422


async def test_hub_scoped_admin_with_out_of_scope_open_project_is_403(db_session):
    w = await _world(db_session)
    member = await make_hub(
        db_session,
        name=HubName.OEM_HCK,
        lab_region=LabRegion.GREECE,
        is_oem=True,
        capacity_hub=w.hub,
    )
    await make_project(
        db_session, member, leader=w.elena, name="OEM one", category=ProjectCategory.A_OEM
    )
    await _act_as(db_session, RoleName.ADMIN, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        resp = await _preview(client, w.elena.id)
    assert resp.status_code == 403
    assert resp.json()["code"] == "ENGINEER_STATUS_OUT_OF_SCOPE"
    assert "OEM one" not in resp.text


# --- reactivate -------------------------------------------------------------------------


async def test_reactivate_restores_no_project_and_dispatches_nothing(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        token = (await _preview(client, w.elena.id)).json()["led_projects_token"]
        pairs = [(p.id, w.nikos.id) for p in (w.dev, w.queued, w.held, w.frozen)]
        assert (await _deactivate(client, w.elena.id, token, pairs)).status_code == 200
        dispatched = len(dispatch)
        again = await _deactivate(client, w.elena.id, token, pairs)
        back = await client.post(f"/engineers/{w.elena.id}/reactivate")
        twice = await client.post(f"/engineers/{w.elena.id}/reactivate")
    assert again.status_code == 409 and again.json()["code"] == "ENGINEER_ALREADY_INACTIVE"
    assert back.status_code == 200, back.text
    read = EngineerRead.model_validate(back.json())
    assert read.active is True and read.deactivated_week is None
    assert read.deactivation_reason is None and read.deactivated_plan_year is None
    assert twice.status_code == 409 and twice.json()["code"] == "ENGINEER_ALREADY_ACTIVE"
    assert len(dispatch) == dispatched
    for p in (w.dev, w.queued, w.held, w.frozen):
        assert (await _fresh(db_session, Project, p.id)).leader_engineer_id == w.nikos.id
    period = (
        await db_session.execute(
            select(EngineerInactivePeriod).where(EngineerInactivePeriod.engineer_id == w.elena.id)
        )
    ).scalar_one()
    # Same-week deactivate + reactivate: the period covers nothing.
    assert (period.from_week, period.to_plan_year, period.to_week) == (31, 2026, 31)
    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "engineer.reactivate")
        )
    ).scalar_one()
    assert audit.before_state["active"] is False and audit.after_state["active"] is True
    history_after = await _count(db_session, ProjectLeaderHistory)
    assert history_after == 4  # only the deactivation's rows
    assert await _i42_violations(db_session) == []


# --- DELETE, PATCH -----------------------------------------------------------------------


@pytest.mark.parametrize("role", [RoleName.ADMIN, RoleName.SUPER_ADMIN, RoleName.HUB_PLANNER])
async def test_delete_is_410_and_writes_nothing(db_session, role):
    w = await _world(db_session)
    await _act_as(db_session, role, hub_ids=[w.hub.id] if role == RoleName.HUB_PLANNER else None)
    audits = await _count(db_session, AuditLogEntry)
    async with _client(db_session) as client:
        resp = await client.delete(f"/engineers/{w.maria.id}")
        unknown = await client.delete(f"/engineers/{uuid.uuid4()}")
    assert resp.status_code == 410, resp.text
    assert resp.json()["code"] == "ENGINEER_DELETE_RETIRED"
    assert unknown.status_code == 410
    assert await _count(db_session, Engineer, Engineer.id == w.maria.id) == 1
    assert await _count(db_session, AuditLogEntry) == audits


@pytest.mark.parametrize("role", [RoleName.PORTFOLIO_MANAGER, RoleName.ENGINEER])
async def test_delete_without_write_keeps_403(db_session, role):
    w = await _world(db_session)
    await _act_as(db_session, role)
    async with _client(db_session) as client:
        resp = await client.delete(f"/engineers/{w.maria.id}")
    assert resp.status_code == 403


async def test_patch_inactive_engineer_accepts_name_only(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        token = (await _preview(client, w.maria.id)).json()["led_projects_token"]
        assert (await _deactivate(client, w.maria.id, token, [])).status_code == 200
        renamed = await client.patch(f"/engineers/{w.maria.id}", json={"name": "Maria P."})
        fte = await client.patch(f"/engineers/{w.maria.id}", json={"fte": 0.5})
        both = await client.patch(
            f"/engineers/{w.maria.id}", json={"name": "M", "allowed_categories": ["C"]}
        )
    assert renamed.status_code == 200 and renamed.json()["name"] == "Maria P."
    assert renamed.json()["active"] is False
    for resp in (fte, both):
        assert resp.status_code == 409 and resp.json()["code"] == "ENGINEER_INACTIVE"


# --- leader writes (I42, R38-4, R38-6) ---------------------------------------------------


async def _deactivate_maria(db_session, w, client) -> None:
    token = (await _preview(client, w.ids.maria)).json()["led_projects_token"]
    resp = await _deactivate(client, w.ids.maria, token, [])
    assert resp.status_code == 200, resp.text


async def test_every_leader_write_rejects_an_inactive_leader(db_session, dispatch):
    w = await _world(db_session)
    i = w.ids
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        await _deactivate_maria(db_session, w, client)
        patch = await client.patch(
            f"/projects/{i.queued}", json={"leader_engineer_id": str(i.maria)}
        )
        batch = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(i.queued), "leader_engineer_id": str(i.maria)}]},
        )
        register = await client.post(
            "/projects",
            json=registration_body(
                SimpleNamespace(id=i.hub), SimpleNamespace(id=i.maria), name="New one"
            ),
        )
        unknown = await client.patch(
            f"/projects/{i.queued}", json={"leader_engineer_id": str(uuid.uuid4())}
        )
    assert patch.status_code == 422 and patch.json()["code"] == "LEADER_INACTIVE"
    assert batch.status_code == 422, batch.text
    assert batch.json()["detail"]["errors"][0]["code"] == "LEADER_INACTIVE"
    assert register.status_code == 422 and register.json()["code"] == "LEADER_INACTIVE"
    assert unknown.status_code == 422 and unknown.json()["code"] == "UNKNOWN_LEADER"
    assert (await _fresh(db_session, Project, i.queued)).leader_engineer_id == i.elena
    assert await _i42_violations(db_session) == []


async def test_reopen_with_inactive_stored_leader_needs_a_leader(db_session, dispatch):
    w = await _world(db_session)
    i = w.ids
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    w.cancelled.leader_engineer_id = i.maria
    w.done.leader_engineer_id = i.maria
    await db_session.flush()
    await db_session.commit()
    async with _client(db_session) as client:
        await _deactivate_maria(db_session, w, client)
        # A closed project keeps its inactive leader; editing it otherwise is fine.
        rename = await client.patch(f"/projects/{i.cancelled}", json={"name": "Renamed"})
        reopen = await client.patch(f"/projects/{i.cancelled}", json={"status": "In Queue"})
        batch = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(i.done), "status": "In Development"}]},
        )
        same = await client.patch(
            f"/projects/{i.cancelled}",
            json={"status": "In Queue", "leader_engineer_id": str(i.maria)},
        )
        to_null = await client.patch(
            f"/projects/{i.cancelled}",
            json={"status": "In Queue", "priority": "P3", "leader_engineer_id": None},
        )
        to_nikos = await client.post(
            "/projects/register-edits",
            json={
                "edits": [
                    {
                        "project_id": str(i.done),
                        "status": "In Development",
                        "leader_engineer_id": str(i.nikos),
                    }
                ]
            },
        )
    assert rename.status_code == 200, rename.text
    assert reopen.status_code == 422 and reopen.json()["code"] == "LEADER_INACTIVE"
    assert reopen.json()["detail"][0]["loc"] == ["body", "leader_engineer_id"]
    assert batch.status_code == 422
    assert batch.json()["detail"]["errors"][0]["code"] == "LEADER_INACTIVE"
    assert same.status_code == 422 and same.json()["code"] == "LEADER_INACTIVE"
    assert to_null.status_code == 200, to_null.text
    assert to_null.json()["leader_engineer_id"] is None
    assert to_nikos.status_code == 200, to_nikos.text
    assert await _i42_violations(db_session) == []
    causes = (
        await db_session.execute(
            select(ProjectLeaderHistory.project_id, ProjectLeaderHistory.cause).where(
                ProjectLeaderHistory.engineer_id == i.maria
            )
        )
    ).all()
    assert sorted(causes) == sorted([(i.cancelled, "project_update"), (i.done, "register_edit")])


async def test_leader_history_on_every_path(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        created = await client.post(
            "/projects", json=registration_body(w.hub, w.maria, name="Registered")
        )
        assert created.status_code == 201, created.text
        pid = uuid.UUID(created.json()["id"])
        changed = await client.patch(
            f"/projects/{pid}", json={"leader_engineer_id": str(w.elena.id)}
        )
        unchanged = await client.patch(
            f"/projects/{pid}", json={"leader_engineer_id": str(w.elena.id)}
        )
        batch = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(pid), "leader_engineer_id": None}]},
        )
    assert changed.status_code == 200 and unchanged.status_code == 200
    assert batch.status_code == 200, batch.text
    rows = (
        (
            await db_session.execute(
                select(ProjectLeaderHistory)
                .where(ProjectLeaderHistory.project_id == pid)
                .order_by(ProjectLeaderHistory.created_at, ProjectLeaderHistory.cause.desc())
            )
        )
        .scalars()
        .all()
    )
    trail = sorted(
        (r.cause, r.engineer_id, r.new_engineer_id, r.from_week, r.to_week) for r in rows
    )
    assert trail == sorted(
        [
            ("registration", None, w.maria.id, None, 31),
            ("project_update", w.maria.id, w.elena.id, 31, 31),
            ("register_edit", w.elena.id, None, 31, 31),
        ]
    )


async def test_user_link_to_inactive_engineer_is_422(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        await _deactivate_maria(db_session, w, client)
        resp = await client.post(
            "/users",
            json={
                "email": "new.engineer@example.com",
                "full_name": "New",
                "roles": ["Engineer"],
                "engineer_id": str(w.maria.id),
            },
        )
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "ENGINEER_INACTIVE"


# --- plan clock (R38-7) ---------------------------------------------------------------------


async def test_closed_plan_year_records_week_52(db_session, dispatch, monkeypatch):
    w = await _world(db_session)
    monkeypatch.delenv("RPD_CURRENT_WEEK", raising=False)
    monkeypatch.setenv("RPD_PLAN_YEAR", "2026")
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    with plan_clock.override_now(datetime(2027, 1, 20, 12, 0, tzinfo=UTC)):
        async with _client(db_session) as client:
            preview = (await _preview(client, w.maria.id)).json()
            resp = await _deactivate(client, w.maria.id, preview["led_projects_token"], [])
    assert preview["deactivation_week"] == 52
    assert resp.status_code == 200, resp.text
    assert resp.json()["engineer"]["deactivated_week"] == 52
    assert resp.json()["engineer"]["deactivated_plan_year"] == 2026
    # A deactivation at (Y, 52) covers no week of Y: the supply is unchanged.
    assert (
        preview["supply_effect"]["yearly_design_capacity"]["before"]
        == (preview["supply_effect"]["yearly_design_capacity"]["after"])
    )


async def test_preview_supply_follows_the_calendar_week(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        body = (await _preview(client, w.maria.id)).json()
    effect = body["supply_effect"]
    # Three counted engineers; Maria at W31: year 52 × (2 + 31/52), remaining 21 × 2.
    assert effect["yearly_design_capacity"] == {"before": 156.0, "after": 135.0}
    assert effect["remaining_design_capacity"] == {"before": 63.0, "after": 42.0}


# --- DB guards ------------------------------------------------------------------------------


async def test_i42_constraint_triggers(db_session):
    w = await _world(db_session)
    await db_session.execute(text("SAVEPOINT i42"))
    # Inactive without a period → rejected at the (forced) constraint check.
    await db_session.execute(
        text(
            "UPDATE engineers SET active = false, deactivated_at = now(), "
            "deactivated_week = 5, deactivated_plan_year = 2026, "
            "deactivation_reason = 'other' WHERE id = :id"
        ),
        {"id": w.nikos.id},
    )
    with pytest.raises(DBAPIError, match="I42"):
        await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.execute(text("ROLLBACK TO SAVEPOINT i42"))
    await db_session.execute(text("SET CONSTRAINTS ALL DEFERRED"))

    # Inactive with a period but still leading an open project → rejected.
    await db_session.execute(text("SAVEPOINT i42b"))
    await db_session.execute(
        text(
            "INSERT INTO engineer_inactive_periods (id, engineer_id, from_plan_year, from_week) "
            "VALUES (:pid, :eid, 2026, 5)"
        ),
        {"pid": uuid.uuid4(), "eid": w.elena.id},
    )
    await db_session.execute(
        text(
            "UPDATE engineers SET active = false, deactivated_at = now(), "
            "deactivated_week = 5, deactivated_plan_year = 2026, "
            "deactivation_reason = 'other' WHERE id = :id"
        ),
        {"id": w.elena.id},
    )
    with pytest.raises(DBAPIError, match="I42"):
        await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    await db_session.execute(text("ROLLBACK TO SAVEPOINT i42b"))
    await db_session.execute(text("SET CONSTRAINTS ALL DEFERRED"))

    # A second open period for one engineer → the partial unique index.
    await db_session.execute(text("SAVEPOINT i42c"))
    for _ in range(2):
        try:
            await db_session.execute(
                text(
                    "INSERT INTO engineer_inactive_periods "
                    "(id, engineer_id, from_plan_year, from_week) VALUES (:pid, :eid, 2026, 7)"
                ),
                {"pid": uuid.uuid4(), "eid": w.maria.id},
            )
        except DBAPIError as exc:
            assert "uq_engineer_inactive_periods_one_open" in str(exc)
            break
    else:
        pytest.fail("two open periods were accepted")
    await db_session.execute(text("ROLLBACK TO SAVEPOINT i42c"))


async def test_check_constraint_requires_all_deactivation_fields(db_session):
    w = await _world(db_session)
    await db_session.execute(text("SAVEPOINT ck"))
    with pytest.raises(DBAPIError, match="deactivation_fields"):
        await db_session.execute(
            text("UPDATE engineers SET active = false WHERE id = :id"), {"id": w.maria.id}
        )
    await db_session.execute(text("ROLLBACK TO SAVEPOINT ck"))
    await db_session.execute(text("SAVEPOINT ck2"))
    with pytest.raises(DBAPIError, match="deactivation_reason"):
        await db_session.execute(
            text(
                "UPDATE engineers SET active = false, deactivated_at = now(), "
                "deactivated_week = 5, deactivated_plan_year = 2026, "
                "deactivation_reason = 'burnout' WHERE id = :id"
            ),
            {"id": w.maria.id},
        )
    await db_session.execute(text("ROLLBACK TO SAVEPOINT ck2"))


async def test_leader_history_is_append_only(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.queued.id}", json={"leader_engineer_id": str(w.nikos.id)}
        )
    assert resp.status_code == 200
    for stmt in (
        "UPDATE project_leader_history SET to_week = 1",
        "DELETE FROM project_leader_history",
    ):
        await db_session.execute(text("SAVEPOINT ao"))
        with pytest.raises(DBAPIError, match="append-only"):
            await db_session.execute(text(stmt))
        await db_session.execute(text("ROLLBACK TO SAVEPOINT ao"))


# --- contract shapes -------------------------------------------------------------------------


def test_contract_shapes():
    """docs/API_CONTRACT_P38.md §1–§2 field sets (the frontend mirror in
    `surfaces/planning/api/types.ts` declares these with inline types the
    OpenAPI contract test cannot parse)."""

    assert set(DeactivationPreview.model_fields) == {
        "engineer",
        "deactivation_week",
        "has_linked_login",
        "open_projects",
        "supply_effect",
        "led_projects_token",
    }
    assert set(DeactivationSupplyEffect.model_fields) == {
        "capacity_hub",
        "yearly_design_capacity",
        "remaining_design_capacity",
    }
    assert set(DeactivateRequest.model_fields) == {
        "reason",
        "led_projects_token",
        "reassignments",
    }
    assert set(DeactivateResponse.model_fields) == {
        "engineer",
        "reassigned",
        "left_without_leader",
        "left_without_leader_project_ids",
        "warnings",
        "run",
    }
    assert {
        "active",
        "deactivated_at",
        "deactivated_week",
        "deactivated_plan_year",
        "deactivation_reason",
    } <= set(EngineerRead.model_fields)
    assert "deactivated_by_user_id" not in EngineerRead.model_fields


async def test_closed_project_steps_status_untouched(db_session, dispatch):
    """I44: deactivation changes no stage row and no closed project's leader."""

    w = await _world(db_session)
    before = (
        await db_session.execute(
            select(ProjectWorkflowStep.id, ProjectWorkflowStep.status).order_by(
                ProjectWorkflowStep.id
            )
        )
    ).all()
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        token = (await _preview(client, w.elena.id)).json()["led_projects_token"]
        pairs = [(p.id, w.nikos.id) for p in (w.dev, w.queued, w.held, w.frozen)]
        assert (await _deactivate(client, w.elena.id, token, pairs)).status_code == 200
    after = (
        await db_session.execute(
            select(ProjectWorkflowStep.id, ProjectWorkflowStep.status).order_by(
                ProjectWorkflowStep.id
            )
        )
    ).all()
    assert before == after
    assert (await _fresh(db_session, Project, w.cancelled.id)).leader_engineer_id == w.elena.id
    assert any(s == WorkflowStepStatus.DONE for _, s in after)
