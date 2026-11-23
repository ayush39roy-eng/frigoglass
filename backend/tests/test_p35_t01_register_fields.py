"""P35-T01 (D35-1, D35-3): `projects.actual_end_week` and the Projects
register's calculated design / lab time.

- `actual_end_week`: PATCH set / clear, served on detail, `GET /projects` and
  `GET /dashboard/projects` (the register grid's endpoint); end < start on the
  effective values after the patch is a 422 `ACTUAL_END_BEFORE_START`; a
  change writes a `project.update` audit row; it is not a scheduler input
  (no `schedule_stale`).
- `design_weeks_calculated` / `lab_weeks_calculated` on the register rows:
  Σ eff of the kind's steps as if the project had no effort figure.
  PDD / B (DOMAIN_RULES "Lead times"): design A1 D1 E4 J1 K2 M1 = 10, lab
  H6 = 6. A design figure of 4 (split A1 E2 K1) and a lab figure of 10 leave
  the calculated values at 10 / 6; certification testing off makes lab 0.
- No N+1: the register issues the same number of statements for 2 and 6
  projects.
- Migration `p35a_project_actual_end_week` up / down / up in its own
  container.
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace
from typing import Any

import asyncpg
import pytest
from sqlalchemy import event, select
from testcontainers.postgres import PostgresContainer

from api.db import get_db
from api.main import app
from api.routers import projects as projects_router
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, ProjectCategory, ProjectStatus, RoleName
from models.project import Project
from models.schedule import ScheduleRun
from services import priority_move
from tests.auth_helpers import clear_current_principal_override
from tests.conftest import run_alembic
from tests.factories import make_engineer, make_hub
from tests.p12_helpers import act_as, client_for, stepped_project
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
    """Records `run_greedy_schedule.delay` calls (RPD_GREEDY_INLINE=false in
    tests) and SSE publishes."""

    calls: list[tuple[tuple, dict]] = []
    published: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(
        priority_move, "publish_progress", lambda *a, **k: published.append((a, k))
    )
    return SimpleNamespace(calls=calls, published=published)


async def _b_project(db, name: str = "P35 B", **kw: Any) -> Project:
    hub = kw.pop("hub", None) or await make_hub(db)
    leader = await make_engineer(db, hub, name=f"Lead {name}")
    return await stepped_project(
        db, hub, name=name, leader=leader, category=ProjectCategory.B, **kw
    )


async def _update_audits(db, project: Project) -> list[AuditLogEntry]:
    return list(
        (
            await db.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.entity_id == str(project.id),
                    AuditLogEntry.action == "project.update",
                )
            )
        ).scalars()
    )


def _row(rows: list[dict[str, Any]], project: Project) -> dict[str, Any]:
    return next(r for r in rows if r["project_id"] == str(project.id))


# --------------------------------------------------------------------------
# actual_end_week
# --------------------------------------------------------------------------


async def test_patch_sets_and_clears_actual_end_week_with_audit(db_session):
    project = await _b_project(db_session, actual_start_week=20)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"actual_end_week": 30})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["actual_end_week"] == 30 and body["actual_start_week"] == 20
        # Not a scheduler input.
        assert body["schedule_stale"] is False

        detail = (await client.get(f"/projects/{project.id}")).json()
        assert detail["actual_end_week"] == 30
        listed = (await client.get("/projects")).json()
        assert next(p for p in listed if p["id"] == str(project.id))["actual_end_week"] == 30
        rows = (await client.get("/dashboard/projects")).json()["rows"]
        row = _row(rows, project)
        assert (row["actual_start_week"], row["actual_end_week"]) == (20, 30)

        (audit,) = await _update_audits(db_session, project)
        assert audit.before_state["actual_end_week"] is None
        assert audit.after_state["actual_end_week"] == 30
        assert audit.after_state["tcogs_eur"] == "<redacted>"

        # End equal to start is allowed.
        resp = await client.patch(f"/projects/{project.id}", json={"actual_end_week": 20})
        assert resp.status_code == 200, resp.text

        resp = await client.patch(f"/projects/{project.id}", json={"actual_end_week": None})
        assert resp.status_code == 200, resp.text
        assert resp.json()["actual_end_week"] is None
        audits = await _update_audits(db_session, project)
        assert len(audits) == 3
        assert any(
            a.before_state["actual_end_week"] == 20 and a.after_state["actual_end_week"] is None
            for a in audits
        )

        # An end without a start is allowed.
        resp = await client.patch(
            f"/projects/{project.id}", json={"actual_start_week": None, "actual_end_week": 5}
        )
        assert resp.status_code == 200, resp.text
        assert (resp.json()["actual_start_week"], resp.json()["actual_end_week"]) == (None, 5)


async def test_actual_end_before_start_is_422_on_effective_values(db_session):
    project = await _b_project(db_session, actual_start_week=20)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        # End before the stored start.
        resp = await client.patch(f"/projects/{project.id}", json={"actual_end_week": 19})
        assert resp.status_code == 422
        assert resp.json()["code"] == "ACTUAL_END_BEFORE_START"
        assert resp.json()["detail"][0]["loc"] == ["body", "actual_end_week"]

        # Both in one body: the new start is used.
        resp = await client.patch(
            f"/projects/{project.id}", json={"actual_start_week": 25, "actual_end_week": 24}
        )
        assert resp.status_code == 422 and resp.json()["code"] == "ACTUAL_END_BEFORE_START"
        resp = await client.patch(
            f"/projects/{project.id}", json={"actual_start_week": 10, "actual_end_week": 15}
        )
        assert resp.status_code == 200, resp.text

        # A start moved past the stored end.
        resp = await client.patch(f"/projects/{project.id}", json={"actual_start_week": 16})
        assert resp.status_code == 422 and resp.json()["code"] == "ACTUAL_END_BEFORE_START"
        assert resp.json()["detail"][0]["loc"] == ["body", "actual_start_week"]

        # Schema bound: >= 1.
        resp = await client.patch(f"/projects/{project.id}", json={"actual_end_week": 0})
        assert resp.status_code == 422

    await db_session.refresh(project)
    assert (project.actual_start_week, project.actual_end_week) == (10, 15)
    # Only the one accepted PATCH is audited.
    assert len(await _update_audits(db_session, project)) == 1


# --------------------------------------------------------------------------
# design_weeks_calculated / lab_weeks_calculated
# --------------------------------------------------------------------------


async def test_calculated_weeks_ignore_the_projects_own_figures(db_session):
    hub = await make_hub(db_session)
    plain = await _b_project(db_session, name="B plain", hub=hub)
    figured = await _b_project(db_session, name="B figured", hub=hub)
    no_cert = await _b_project(db_session, name="B no cert", hub=hub)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{figured.id}",
            json={"design_effort_weeks": 4, "lab_effort_weeks": 10},
        )
        assert resp.status_code == 200, resp.text
        resp = await client.patch(
            f"/projects/{no_cert.id}", json={"certification_testing_required": False}
        )
        assert resp.status_code == 200, resp.text

        rows = (await client.get("/dashboard/projects")).json()["rows"]

    p, f, n = _row(rows, plain), _row(rows, figured), _row(rows, no_cert)
    # PDD / B: design A1 D1 E4 J1 K2 M1 = 10, lab H6 = 6.
    assert (p["design_weeks_calculated"], p["lab_weeks_calculated"]) == (10, 6)
    assert (p["design_effort_weeks"], p["lab_effort_weeks"]) == (None, None)
    # A figure changes the effective durations (A1 E2 K1, H10), not the
    # calculated value.
    assert (f["design_weeks_calculated"], f["lab_weeks_calculated"]) == (10, 6)
    assert (f["design_effort_weeks"], f["lab_effort_weeks"]) == (4.0, 10.0)
    # Certification testing off: every lab step is skipped.
    assert (n["design_weeks_calculated"], n["lab_weeks_calculated"]) == (10, 0)


async def test_register_query_count_does_not_grow_with_rows(db_session):
    hub = await make_hub(db_session)
    await act_as(db_session, RoleName.ADMIN)

    async def _count() -> int:
        statements: list[str] = []

        def _record(orm_execute_state) -> None:
            statements.append(str(orm_execute_state.statement))

        target = db_session.sync_session
        async with client_for(db_session) as client:
            event.listen(target, "do_orm_execute", _record)
            try:
                resp = await client.get("/dashboard/projects")
            finally:
                event.remove(target, "do_orm_execute", _record)
        assert resp.status_code == 200, resp.text
        assert all(isinstance(r["design_weeks_calculated"], int) for r in resp.json()["rows"])
        return len(statements)

    for i in range(2):
        await _b_project(db_session, name=f"Few {i}", hub=hub)
    few = await _count()
    for i in range(4):
        await _b_project(db_session, name=f"More {i}", hub=hub)
    many = await _count()
    assert many == few, (few, many)


# --------------------------------------------------------------------------
# POST /projects/register-edits (OQ #83: recalculate on Save)
# --------------------------------------------------------------------------

_URL = "/projects/register-edits"


async def _audits(db, project: Project, action: str) -> list[AuditLogEntry]:
    return list(
        (
            await db.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.entity_id == str(project.id), AuditLogEntry.action == action
                )
            )
        ).scalars()
    )


async def _runs(db) -> list[ScheduleRun]:
    return list(
        (
            await db.execute(
                select(ScheduleRun).where(ScheduleRun.trigger_reason == "register_edit")
            )
        ).scalars()
    )


async def _fresh(db, project_id: uuid.UUID) -> Project:
    """Re-read after the handler (a rolled-back batch expires the instances)."""
    return (
        await db.execute(
            select(Project)
            .where(Project.id == project_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def test_batch_of_two_saves_both_and_queues_one_run(db_session, dispatch):
    hub = await make_hub(db_session)
    a = await _b_project(db_session, name="Batch A", hub=hub, actual_start_week=20)
    b = await _b_project(db_session, name="Batch B", hub=hub)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    a_id, b_id = a.id, b.id
    async with client_for(db_session) as client:
        resp = await client.post(
            _URL,
            json={
                "edits": [
                    {"project_id": str(b.id), "actual_start_week": 25},
                    {
                        "project_id": str(a.id),
                        "design_effort_weeks": 4,
                        "actual_end_week": 30,
                    },
                ]
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        rows = (await client.get("/dashboard/projects")).json()["rows"]

    assert body["recalc_status"] == "queued"
    assert body["schedule_run_id"] is not None and body["task_id"] == "celery-task-1"
    assert sorted(body["project_ids"]) == sorted([str(a.id), str(b.id)])
    assert sorted(body["projects_marked_stale"]) == sorted([str(a.id), str(b.id)])
    # Exactly one run for the batch; a multi-project batch names no project.
    assert len(dispatch.calls) == 1
    assert dispatch.calls[0][1]["recalc_project_id"] is None
    assert dispatch.calls[0][1]["activate"] is True
    (run,) = await _runs(db_session)
    assert str(run.id) == body["schedule_run_id"]

    a, b = await _fresh(db_session, a_id), await _fresh(db_session, b_id)
    assert (a.actual_end_week, float(a.design_effort_weeks or 0)) == (30, 4.0)
    assert b.actual_start_week == 25
    assert a.schedule_stale and b.schedule_stale
    for project in (a, b):
        (update,) = await _audits(db_session, project, "project.update")
        (requested,) = await _audits(db_session, project, "project.recalculate_requested")
        assert requested.after_state["trigger_reason"] == "register_edit"
        assert requested.after_state["schedule_run_id"] == body["schedule_run_id"]
    # ADR 0041 R6: the figure re-derived A's split (A1 E2 K1).
    assert len(await _audits(db_session, a, "project.effort_rederived")) == 1
    row_a = _row(rows, a)
    assert (row_a["design_effort_weeks"], row_a["design_weeks_calculated"]) == (4.0, 10)


async def test_one_invalid_row_saves_nothing(db_session, dispatch):
    hub = await make_hub(db_session)
    good = await _b_project(db_session, name="Good", hub=hub)
    bad = await _b_project(db_session, name="Bad", hub=hub, actual_start_week=20)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    good_id, bad_id = good.id, bad.id
    async with client_for(db_session) as client:
        resp = await client.post(
            _URL,
            json={
                "edits": [
                    {"project_id": str(good.id), "design_effort_weeks": 4},
                    {"project_id": str(bad.id), "actual_end_week": 10},
                ]
            },
        )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["code"] == "REGISTER_EDITS_INVALID"
    assert body["detail"]["errors"] == [
        {
            "project_id": str(bad_id),
            "code": "ACTUAL_END_BEFORE_START",
            "message": "Actual end week 10 is before actual start week 20.",
        }
    ]
    good, bad = await _fresh(db_session, good_id), await _fresh(db_session, bad_id)
    assert good.design_effort_weeks is None and good.schedule_stale is False
    assert bad.actual_end_week is None
    assert await _audits(db_session, good, "project.update") == []
    assert await _audits(db_session, good, "project.effort_rederived") == []
    assert dispatch.calls == [] and await _runs(db_session) == []


async def test_duplicate_and_unknown_fields_are_422(db_session, dispatch):
    project = await _b_project(db_session)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    async with client_for(db_session) as client:
        resp = await client.post(
            _URL,
            json={
                "edits": [
                    {"project_id": str(project.id), "actual_end_week": 30},
                    {"project_id": str(project.id), "actual_end_week": 31},
                ]
            },
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["errors"][0]["code"] == "DUPLICATE_PROJECT"
        # Read-only or financial (P59-B: `priority` is now a register field).
        for extra in ({"requesting_department": "X"}, {"tcogs_eur": 1}):
            resp = await client.post(
                _URL, json={"edits": [{"project_id": str(project.id), **extra}]}
            )
            assert resp.status_code == 422, extra
        resp = await client.post(_URL, json={"edits": []})
        assert resp.status_code == 422
    assert dispatch.calls == []


async def test_out_of_scope_project_is_403_and_nothing_written(db_session, dispatch):
    mine = await make_hub(db_session)
    other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    own = await _b_project(db_session, name="Own", hub=mine)
    foreign = await _b_project(db_session, name="Foreign", hub=other)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[mine.id])
    await db_session.commit()
    own_id, foreign_id = own.id, foreign.id
    async with client_for(db_session) as client:
        resp = await client.post(
            _URL,
            json={
                "edits": [
                    {"project_id": str(own.id), "actual_end_week": 40},
                    {"project_id": str(foreign.id), "actual_end_week": 40},
                ]
            },
        )
    assert resp.status_code == 403, resp.text
    body = resp.json()
    assert body["code"] == "REGISTER_EDITS_FORBIDDEN"
    assert body["detail"]["errors"] == [
        {
            "project_id": str(foreign_id),
            "code": "FORBIDDEN_PROJECT",
            "message": "You cannot edit this project.",
        }
    ]
    own, foreign = await _fresh(db_session, own_id), await _fresh(db_session, foreign_id)
    assert own.actual_end_week is None and foreign.actual_end_week is None
    assert await _audits(db_session, own, "project.update") == []
    assert dispatch.calls == []


async def test_non_schedulable_only_change_is_not_needed(db_session, dispatch):
    hub = await make_hub(db_session)
    on_hold = await _b_project(
        db_session, name="Parked", hub=hub, status=ProjectStatus.ON_HOLD
    )
    live = await _b_project(db_session, name="Live", hub=hub, actual_start_week=20)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    on_hold_id, live_id = on_hold.id, live.id
    async with client_for(db_session) as client:
        resp = await client.post(
            _URL,
            json={
                "edits": [
                    # A scheduler input, but on a project out of the plan.
                    {"project_id": str(on_hold.id), "design_effort_weeks": 4},
                    # Not a scheduler input at all.
                    {"project_id": str(live.id), "actual_end_week": 30},
                ]
            },
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "not_needed"
    assert body["schedule_run_id"] is None and body["task_id"] is None
    assert body["projects_marked_stale"] == [str(on_hold.id)]
    assert dispatch.calls == [] and await _runs(db_session) == []
    on_hold, live = await _fresh(db_session, on_hold_id), await _fresh(db_session, live_id)
    assert float(on_hold.design_effort_weeks or 0) == 4.0 and live.actual_end_week == 30
    assert len(await _audits(db_session, live, "project.update")) == 1


async def test_status_change_out_of_the_plan_still_recalculates(db_session, dispatch):
    project = await _b_project(db_session, name="Pause me")
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    async with client_for(db_session) as client:
        resp = await client.post(
            _URL, json={"edits": [{"project_id": str(project.id), "status": "On Hold"}]}
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "queued"
    assert dispatch.calls[0][1]["recalc_project_id"] == str(project.id)


# --------------------------------------------------------------------------
# Migration p35a
# --------------------------------------------------------------------------

_CHECK = "ck_projects_actual_end_week_positive"


def _fetch(url: str, sql: str, *args: Any) -> list[asyncpg.Record]:
    async def run() -> list[asyncpg.Record]:
        conn = await asyncpg.connect(url.replace("postgresql+asyncpg://", "postgresql://"))
        try:
            return await conn.fetch(sql, *args)
        finally:
            await conn.close()

    return asyncio.run(run())


def _column(url: str) -> list[asyncpg.Record]:
    return _fetch(
        url,
        "SELECT data_type, is_nullable FROM information_schema.columns "
        "WHERE table_name = 'projects' AND column_name = 'actual_end_week'",
    )


def _check_def(url: str) -> list[asyncpg.Record]:
    return _fetch(
        url, "SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1", _CHECK
    )


def _version(url: str) -> str:
    return str(_fetch(url, "SELECT version_num FROM alembic_version")[0]["version_num"])


def _assert_upgraded(url: str) -> None:
    assert _version(url) == "p35a_project_actual_end_week"
    (col,) = _column(url)
    assert (col["data_type"], col["is_nullable"]) == ("integer", "YES")
    (check,) = _check_def(url)
    assert "actual_end_week IS NULL" in check["d"] and ">= 1" in check["d"]


def test_p35a_up_down_up() -> None:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "p32a_step_overlap"], url)
        assert r.returncode == 0, r.stderr
        assert _column(url) == []

        r = run_alembic(["upgrade", "p35a_project_actual_end_week"], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url)

        r = run_alembic(["downgrade", "p32a_step_overlap"], url)
        assert r.returncode == 0, r.stderr
        assert _version(url) == "p32a_step_overlap"
        assert _column(url) == []
        assert _check_def(url) == []

        r = run_alembic(["upgrade", "p35a_project_actual_end_week"], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url)
