"""P35-T05 + the register Edit popup (2026-11-17,
docs/API_CONTRACT_REGISTER_POPUP.md).

- Per-step exclusion (ADR 0049 as ruled, R35-1..R35-12, I33–I36) through
  `POST /projects/register-edits` `step_exclusions`: the flag, R35-2
  applicability, R35-4 (no progress write), R35-5 guards, R35-6 audit and
  re-derivation, R35-7 (one run, served `eff` changes), R35-9 builder,
  R35-11 workflow change, R35-12 calculated weeks.
- `current_step_code`: earlier applicable steps Done, the picked step In
  Progress, later ones Not Started, as a check-in at CURRENT_WEEK (31 in
  tests); one `project.current_step_set` audit row.
- `hub_id` / `certification_testing_required` in the batch, with the hub
  move's two-hub scope rule.
- `GET /projects/{id}/register-steps`.

PDD / B (DOMAIN_RULES "Lead times"): A1 B0 C0 D1 E4 F0 G0 H6 I0 J1 K2 L1 M1
N1. Kinds: design A B D E I J K M, lab F H, elapsed C G L N. A design
figure of 4 splits A1 D0 E2 J0 K1 M0.
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
from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    RoleName,
    WorkflowStepStatus,
)
from models.project import Project
from models.schedule import ScheduleRun
from models.types import FINANCIAL_FIELD_NAMES
from models.workflow import ProjectWorkflowStep
from scheduling import canonical_schedule_input_asdict
from scheduling.demand import (
    check_i26_effort_split,
    check_i33_step_exclusion,
    check_i34_excluded_not_done,
)
from services import priority_move
from services.demand_load import load_live_project_rows
from services.schedule_persistence import build_schedule_input_from_db
from services.template_apply import FLAG_EXCLUDED_NO_EFFECT, _step_outcome
from services.template_editor import StepDelta
from tests.auth_helpers import clear_current_principal_override
from tests.conftest import run_alembic
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import act_as, add_outcome, client_for, set_progress, stepped_project
from workers.schedule_tasks import run_greedy_schedule

_URL = "/projects/register-edits"
_PDD = [f"PDD-{c}" for c in "ABCDEFGHIJKLMN"]
_PROGRESS_FIELDS = (
    "status",
    "percent_complete",
    "actual_start_week",
    "actual_end_week",
    "remaining_weeks_override",
    "blocked_reason",
)
_NEW_ACTIONS = ("project.step_excluded", "project.step_included", "project.current_step_set")


@pytest.fixture(autouse=True)
def _cleanup():
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    return SimpleNamespace(calls=calls)


async def _b_project(db, name: str = "P35 B", **kw: Any) -> Project:
    hub = kw.pop("hub", None) or await make_hub(db)
    leader = await make_engineer(db, hub, name=f"Lead {name}")
    return await stepped_project(
        db, hub, name=name, leader=leader, category=ProjectCategory.B, **kw
    )


async def _rows(db, project_id: uuid.UUID) -> dict[str, ProjectWorkflowStep]:
    return {
        r.step_template_id: r
        for r in (
            await db.execute(
                select(ProjectWorkflowStep)
                .where(ProjectWorkflowStep.project_id == project_id)
                .execution_options(populate_existing=True)
            )
        ).scalars()
    }


async def _fresh(db, project_id: uuid.UUID) -> Project:
    return (
        await db.execute(
            select(Project)
            .where(Project.id == project_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _audits(db, project_id: uuid.UUID, action: str) -> list[AuditLogEntry]:
    return list(
        (
            await db.execute(
                select(AuditLogEntry)
                .where(
                    AuditLogEntry.entity_id == str(project_id), AuditLogEntry.action == action
                )
                .order_by(AuditLogEntry.id)
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


def _excl(*pairs: tuple[str, bool]) -> list[dict[str, Any]]:
    return [{"step_code": c, "step_excluded": v} for c, v in pairs]


async def _save(client, *edits: dict[str, Any]):
    return await client.post(_URL, json={"edits": list(edits)})


def _row_errors(resp) -> list[dict[str, Any]]:
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["code"] == "REGISTER_EDITS_INVALID"
    return body["detail"]["errors"]


def _progress(row: ProjectWorkflowStep) -> tuple[Any, ...]:
    return tuple(getattr(row, f) for f in _PROGRESS_FIELDS)


def _assert_no_financial(entries: list[AuditLogEntry]) -> None:
    for entry in entries:
        for state in (entry.before_state or {}, entry.after_state or {}):
            for name in FINANCIAL_FIELD_NAMES:
                assert name not in state, (entry.action, name)


# --------------------------------------------------------------------------
# Exclusion: write, audit, eff, builder, round trip
# --------------------------------------------------------------------------


async def test_exclude_and_reinclude_round_trip(db_session, dispatch):
    project = await _b_project(db_session)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    pid = project.id
    input_before = canonical_schedule_input_asdict(await build_schedule_input_from_db(db_session))
    progress_before = {k: _progress(r) for k, r in (await _rows(db_session, pid)).items()}

    async with client_for(db_session) as client:
        resp = await _save(
            client, {"project_id": str(pid), "step_exclusions": _excl(("PDD-E", True))}
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        steps = (await client.get(f"/projects/{pid}/register-steps")).json()
        rows = (await client.get("/dashboard/projects")).json()["rows"]

    assert body["recalc_status"] == "queued" and len(dispatch.calls) == 1
    assert body["projects_marked_stale"] == [str(pid)]
    assert body["eff_changes"] == [
        {
            "project_id": str(pid),
            "step_code": "PDD-E",
            "eff_before": 4,
            "eff_after": 0,
            "revived": False,
            "skipped_now": True,
        }
    ]
    live = await _rows(db_session, pid)
    assert live["PDD-E"].excluded is True
    e = next(s for s in steps["steps"] if s["step_code"] == "PDD-E")
    assert (e["status"], e["step_excluded"], e["applicable"], e["excludable"]) == (
        "Skipped", True, True, True
    )
    # R35-12: the calculated design time drops by E's 4 weeks, on the list
    # row and on the popup read alike.
    row = next(r for r in rows if r["project_id"] == str(pid))
    assert row["design_weeks_calculated"] == 6 == steps["design_weeks_calculated"]

    (audit,) = await _audits(db_session, pid, "project.step_excluded")
    assert audit.after_state["step_id"] == "PDD-E"
    assert audit.after_state["stage_status"] == "Not Started"
    assert audit.before_state["eff"] == {"PDD-E": 4}
    assert audit.after_state["eff"] == {"PDD-E": 0}
    assert audit.after_state["step_row_id"] == str(live["PDD-E"].id)

    # R35-9 / I33 on the built input: E's lead is 0, no override.
    schedule_input = await build_schedule_input_from_db(db_session)
    live_rows, _ = await load_live_project_rows(db_session, [pid])
    assert check_i33_step_exclusion(live_rows, schedule_input) == ()
    assert check_i34_excluded_not_done(live_rows) == ()
    (p_in,) = [p for p in schedule_input.projects if p.project_id == str(pid)]
    timing = {t.step_id: t for t in p_in.step_timing}
    assert timing["PDD-E"].lead_weeks == 0 and timing["PDD-E"].duration_override_weeks is None

    async with client_for(db_session) as client:
        resp = await _save(
            client, {"project_id": str(pid), "step_exclusions": _excl(("PDD-E", False))}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["eff_changes"][0]["revived"] is True
    (included,) = await _audits(db_session, pid, "project.step_included")
    assert included.after_state["step_excluded"] is False
    # I34 difference test: progress and the run input are restored exactly.
    progress_after = {k: _progress(r) for k, r in (await _rows(db_session, pid)).items()}
    assert progress_after == progress_before
    input_after = canonical_schedule_input_asdict(await build_schedule_input_from_db(db_session))
    assert input_after == input_before
    _assert_no_financial(
        await _audits(db_session, pid, "project.step_excluded")
        + await _audits(db_session, pid, "project.step_included")
    )


async def test_exclusion_with_figure_resplits_and_revives(db_session, dispatch):
    project = await _b_project(db_session)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    pid = project.id
    async with client_for(db_session) as client:
        resp = await _save(client, {"project_id": str(pid), "design_effort_weeks": 4})
        assert resp.status_code == 200, resp.text
        steps = (await client.get(f"/projects/{pid}/register-steps")).json()["steps"]
        by = {s["step_code"]: s for s in steps}
        # R35-2: D is split to 0 but applicable (and excludable).
        assert by["PDD-D"]["status"] == "Skipped" and by["PDD-D"]["applicable"] is True
        assert by["PDD-D"]["excludable"] is True
        # B has a 0-week copy and no weight: N/A.
        assert by["PDD-B"]["applicable"] is False and by["PDD-B"]["excludable"] is False

        resp = await _save(
            client, {"project_id": str(pid), "step_exclusions": _excl(("PDD-A", True))}
        )
        assert resp.status_code == 200, resp.text
        changes = {c["step_code"]: c for c in resp.json()["eff_changes"]}

    # Probe row 2: A excluded → D1 E2 K1 (D revived).
    assert changes["PDD-A"]["skipped_now"] is True
    assert changes["PDD-D"] == {
        "project_id": str(pid), "step_code": "PDD-D", "eff_before": 0, "eff_after": 1,
        "revived": True, "skipped_now": False,
    }
    live = await _rows(db_session, pid)
    assert {k: live[k].effort_weeks for k in ("PDD-A", "PDD-D", "PDD-E", "PDD-K")} == {
        "PDD-A": None, "PDD-D": 1, "PDD-E": 2, "PDD-K": 1,
    }
    rows, _ = await load_live_project_rows(db_session, [pid])
    assert check_i26_effort_split(rows) == ()
    (audit,) = await _audits(db_session, pid, "project.step_excluded")
    assert audit.after_state["eff"] == {"PDD-A": 0, "PDD-D": 1}
    assert len(await _audits(db_session, pid, "project.effort_rederived")) == 2


async def test_excluding_in_progress_step_writes_no_progress(db_session, dispatch):
    project = await _b_project(db_session)
    await set_progress(db_session, project, "PDD-A", WorkflowStepStatus.DONE, percent=100,
                       start=20, end=22)
    await set_progress(db_session, project, "PDD-D", WorkflowStepStatus.DONE, percent=100,
                       start=23, end=24)
    await set_progress(db_session, project, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=40,
                       start=25)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    pid = project.id
    before = _progress((await _rows(db_session, pid))["PDD-E"])
    async with client_for(db_session) as client:
        resp = await _save(
            client, {"project_id": str(pid), "step_exclusions": _excl(("PDD-E", True))}
        )
        assert resp.status_code == 200, resp.text
        read = (await client.get(f"/projects/{pid}/register-steps")).json()
    # R35-4: E keeps its stored progress; it is skipped, so the next step is current.
    assert _progress((await _rows(db_session, pid))["PDD-E"]) == before
    (audit,) = await _audits(db_session, pid, "project.step_excluded")
    assert audit.after_state["stage_status"] == "In Progress"
    assert read["current_step_code"] == "PDD-H"
    assert [s["step_code"] for s in read["steps"] if s["is_current"]] == ["PDD-H"]


# --------------------------------------------------------------------------
# Refusals
# --------------------------------------------------------------------------


async def test_exclusion_refusals_write_nothing(db_session, dispatch):
    hub = await make_hub(db_session)
    plain = await _b_project(db_session, name="Plain", hub=hub)
    frozen = await _b_project(db_session, name="Frozen", hub=hub, frozen=True,
                              actual_start_week=10)
    cancelled = await _b_project(db_session, name="Cancelled", hub=hub,
                                 status=ProjectStatus.CANCELLED, priority=None)
    await set_progress(db_session, plain, "PDD-A", WorkflowStepStatus.DONE, percent=100,
                       start=20, end=22)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    plain_id, frozen_id, cancelled_id = plain.id, frozen.id, cancelled.id

    cases = [
        (plain_id, {"step_exclusions": _excl(("PDD-A", True))}, "STEP_DONE"),
        (plain_id, {"step_exclusions": _excl(("PDD-B", True))}, "STEP_NOT_APPLICABLE"),
        (plain_id, {"step_exclusions": _excl(("OEM-B", True))}, "UNKNOWN_STEP"),
        (frozen_id, {"step_exclusions": _excl(("PDD-E", True))}, "PROJECT_FROZEN"),
        (cancelled_id, {"step_exclusions": _excl(("PDD-E", True))}, "PROJECT_CLOSED"),
        (plain_id, {"current_step_code": "PDD-B"}, "STEP_NOT_APPLICABLE"),
        (plain_id, {"current_step_code": "PDD-Z"}, "UNKNOWN_STEP"),
        (
            plain_id,
            {"step_exclusions": _excl(("PDD-H", True)), "current_step_code": "PDD-H"},
            "STEP_NOT_APPLICABLE",
        ),
        (frozen_id, {"current_step_code": "PDD-K"}, "PROJECT_FROZEN"),
    ]
    async with client_for(db_session) as client:
        for pid, patch, code in cases:
            resp = await _save(client, {"project_id": str(pid), **patch})
            errors = _row_errors(resp)
            assert [(e["project_id"], e["code"]) for e in errors] == [(str(pid), code)], patch
        # Including a step that is not excluded is a no-op (no run, no audit).
        resp = await _save(
            client, {"project_id": str(plain_id), "step_exclusions": _excl(("PDD-E", False))}
        )
        assert resp.status_code == 200 and resp.json()["recalc_status"] == "not_needed"
        # Schema: duplicate codes and more than 14 entries.
        resp = await _save(
            client,
            {"project_id": str(plain_id),
             "step_exclusions": _excl(("PDD-E", True), ("PDD-E", False))},
        )
        assert resp.status_code == 422 and "detail" in resp.json()
        resp = await _save(
            client,
            {"project_id": str(plain_id),
             "step_exclusions": _excl(*[(f"PDD-{i}", True) for i in range(15)])},
        )
        assert resp.status_code == 422
        resp = await _save(
            client,
            {"project_id": str(plain_id),
             "step_exclusions": [{"step_code": "PDD-E", "excluded": True}]},
        )
        assert resp.status_code == 422  # the wire field is `step_excluded`

    for p_id in (plain_id, frozen_id, cancelled_id):
        assert not any(r.excluded for r in (await _rows(db_session, p_id)).values())
        for action in _NEW_ACTIONS:
            assert await _audits(db_session, p_id, action) == []
    assert dispatch.calls == [] and await _runs(db_session) == []


async def test_guards_effort_needs_a_step_and_no_steps_left(db_session, dispatch):
    hub = await make_hub(db_session)
    figured = await _b_project(db_session, name="Figured", hub=hub)
    plain = await _b_project(db_session, name="Plain", hub=hub)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    figured_id, plain_id = figured.id, plain.id
    design = ["PDD-A", "PDD-D", "PDD-E", "PDD-J", "PDD-K", "PDD-M"]
    async with client_for(db_session) as client:
        resp = await _save(client, {"project_id": str(figured_id), "design_effort_weeks": 4})
        assert resp.status_code == 200, resp.text
        # R35-5 (a): every weighted design step excluded under a figure.
        resp = await _save(
            client,
            {"project_id": str(figured_id),
             "step_exclusions": _excl(*[(c, True) for c in design])},
        )
        assert [e["code"] for e in _row_errors(resp)] == ["EFFORT_NEEDS_A_STEP"]
        # Allowed in the same Save when the figure is cleared too.
        resp = await _save(
            client,
            {"project_id": str(figured_id), "design_effort_weeks": None,
             "step_exclusions": _excl(*[(c, True) for c in design])},
        )
        assert resp.status_code == 200, resp.text
        # The other writer: a figure entered while every design step is out.
        resp = await _save(client, {"project_id": str(figured_id), "design_effort_weeks": 3})
        assert [e["code"] for e in _row_errors(resp)] == ["EFFORT_NEEDS_A_STEP"]
        resp = await client.patch(f"/projects/{figured_id}", json={"design_effort_weeks": 3})
        assert resp.status_code == 409 and resp.json()["code"] == "EFFORT_NEEDS_A_STEP"

        # R35-5 (b): excluding every step that takes time.
        applicable = ["PDD-A", "PDD-D", "PDD-E", "PDD-H", "PDD-J", "PDD-K", "PDD-L",
                      "PDD-M", "PDD-N"]
        resp = await _save(
            client,
            {"project_id": str(plain_id),
             "step_exclusions": _excl(*[(c, True) for c in applicable])},
        )
        assert [e["code"] for e in _row_errors(resp)] == ["NO_STEPS_LEFT"]
    assert not any(r.excluded for r in (await _rows(db_session, plain_id)).values())
    fig = await _fresh(db_session, figured_id)
    assert fig.design_effort_weeks is None


# --------------------------------------------------------------------------
# current_step_code
# --------------------------------------------------------------------------


async def test_current_step_sets_progress_like_a_checkin(db_session, dispatch):
    project = await _b_project(db_session)
    await set_progress(db_session, project, "PDD-L", WorkflowStepStatus.DONE, percent=100,
                       start=5, end=6)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    pid = project.id
    before = {k: _progress(r) for k, r in (await _rows(db_session, pid)).items()}
    async with client_for(db_session) as client:
        resp = await _save(
            client,
            {"project_id": str(pid), "step_exclusions": _excl(("PDD-H", True)),
             "current_step_code": "PDD-K"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["recalc_status"] == "queued" and len(dispatch.calls) == 1
        read = (await client.get(f"/projects/{pid}/register-steps")).json()
        rows = (await client.get("/dashboard/projects")).json()["rows"]

    live = await _rows(db_session, pid)
    for code in ("PDD-A", "PDD-D", "PDD-E", "PDD-J"):
        assert _progress(live[code]) == (WorkflowStepStatus.DONE, 100, 31, 31, None, None), code
    assert _progress(live["PDD-K"]) == (WorkflowStepStatus.IN_PROGRESS, 0, 31, None, None, None)
    # After the picked step: reset to Not Started (L was Done).
    assert _progress(live["PDD-L"]) == (WorkflowStepStatus.NOT_STARTED, 0, None, None, None, None)
    # Skipped steps (0-week B C F G I, excluded H) are never written.
    for code in ("PDD-B", "PDD-C", "PDD-F", "PDD-G", "PDD-H", "PDD-I"):
        assert _progress(live[code]) == before[code], code
    assert read["current_step_code"] == "PDD-K"
    assert next(r for r in rows if r["project_id"] == str(pid))["current_step_code"] == "PDD-K"
    by = {s["step_code"]: s for s in read["steps"]}
    assert by["PDD-A"]["status"] == "Done" and by["PDD-A"]["excludable"] is False
    assert by["PDD-K"]["status"] == "In Progress" and by["PDD-K"]["is_current"] is True

    (audit,) = await _audits(db_session, pid, "project.current_step_set")
    assert audit.before_state["current_step_code"] == "PDD-A"
    assert audit.after_state["current_step_code"] == "PDD-K"
    assert audit.after_state["week"] == 31
    assert {s["step_id"] for s in audit.after_state["stages"]} == {
        "PDD-A", "PDD-D", "PDD-E", "PDD-J", "PDD-K", "PDD-L"
    }
    _assert_no_financial([audit])
    rows_in, _ = await load_live_project_rows(db_session, [pid])
    assert check_i34_excluded_not_done(rows_in) == ()

    # Moving back: E reopened (start kept, end cleared), J and K reset.
    async with client_for(db_session) as client:
        resp = await _save(client, {"project_id": str(pid), "current_step_code": "PDD-E"})
        assert resp.status_code == 200, resp.text
        # Picking the step that is already current changes nothing.
        resp = await _save(client, {"project_id": str(pid), "current_step_code": "PDD-E"})
        assert resp.status_code == 200 and resp.json()["recalc_status"] == "not_needed"
    live = await _rows(db_session, pid)
    assert _progress(live["PDD-E"]) == (WorkflowStepStatus.IN_PROGRESS, 0, 31, None, None, None)
    for code in ("PDD-J", "PDD-K"):
        assert live[code].status == WorkflowStepStatus.NOT_STARTED
    assert len(await _audits(db_session, pid, "project.current_step_set")) == 2


async def test_current_step_keeps_an_on_hold_stage(db_session, dispatch):
    project = await _b_project(db_session)
    await set_progress(db_session, project, "PDD-A", WorkflowStepStatus.DONE, percent=100,
                       start=20, end=22)
    await set_progress(db_session, project, "PDD-D", WorkflowStepStatus.BLOCKED, percent=50,
                       start=23, reason="waiting for parts")
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    async with client_for(db_session) as client:
        resp = await _save(client, {"project_id": str(project.id), "current_step_code": "PDD-D"})
    assert resp.status_code == 200 and resp.json()["recalc_status"] == "not_needed"
    assert (await _rows(db_session, project.id))["PDD-D"].status == WorkflowStepStatus.BLOCKED
    assert await _audits(db_session, project.id, "project.current_step_set") == []


# --------------------------------------------------------------------------
# hub_id / certification_testing_required, RBAC, one run per Save
# --------------------------------------------------------------------------


async def test_hub_move_needs_both_hubs_in_scope(db_session, dispatch):
    mine = await make_hub(db_session)
    other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    own = await _b_project(db_session, name="Own", hub=mine)
    foreign = await _b_project(db_session, name="Foreign", hub=other)
    mine_id, other_id = mine.id, other.id
    own_id, foreign_id = own.id, foreign.id
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[mine_id])
    await db_session.commit()
    async with client_for(db_session) as client:
        for edit in (
            {"project_id": str(own_id), "hub_id": str(other_id)},
            {"project_id": str(own_id), "hub_id": str(uuid.uuid4())},
            {"project_id": str(foreign_id), "step_exclusions": _excl(("PDD-E", True))},
            {"project_id": str(foreign_id), "current_step_code": "PDD-E"},
            {"project_id": str(foreign_id), "certification_testing_required": False},
        ):
            resp = await _save(client, edit)
            assert resp.status_code == 403, (edit, resp.text)
            body = resp.json()
            assert body["code"] == "REGISTER_EDITS_FORBIDDEN"
            assert [e["code"] for e in body["detail"]["errors"]] == ["FORBIDDEN_PROJECT"]
        resp = await client.get(f"/projects/{foreign_id}/register-steps")
        assert resp.status_code == 404
    assert (await _fresh(db_session, own_id)).hub_id == mine_id
    assert dispatch.calls == []

    # Both hubs in scope: allowed and audited.
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[mine_id, other_id])
    async with client_for(db_session) as client:
        resp = await _save(client, {"project_id": str(own_id), "hub_id": str(other_id)})
        assert resp.status_code == 200, resp.text
    assert (await _fresh(db_session, own_id)).hub_id == other_id
    audits = await _audits(db_session, own_id, "project.update")
    assert audits[-1].before_state["hub_id"] == str(mine_id)
    assert audits[-1].after_state["hub_id"] == str(other_id)


async def test_admin_unknown_hub_is_422(db_session, dispatch):
    project = await _b_project(db_session)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    pid = project.id
    async with client_for(db_session) as client:
        resp = await _save(client, {"project_id": str(pid), "hub_id": str(uuid.uuid4())})
        assert [e["code"] for e in _row_errors(resp)] == ["UNKNOWN_HUB"]
        resp = await _save(client, {"project_id": str(pid), "hub_id": None})
        assert [e["code"] for e in _row_errors(resp)] == ["NULL_NOT_ALLOWED"]
        resp = await _save(
            client, {"project_id": str(pid), "certification_testing_required": "no"}
        )
        assert resp.status_code == 422


async def test_workflow_change_clears_exclusions(db_session, dispatch):
    pdd = await make_hub(db_session)
    oem = await make_hub(
        db_session, name=HubName.OEM_HCK, lab_region=LabRegion.GREECE, is_oem=True,
        capacity_hub=pdd,
    )
    project = await _b_project(db_session, hub=pdd)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    pid = project.id
    oem_id = oem.id
    async with client_for(db_session) as client:
        resp = await _save(
            client, {"project_id": str(pid), "step_exclusions": _excl(("PDD-E", True))}
        )
        assert resp.status_code == 200, resp.text
        resp = await _save(
            client, {"project_id": str(pid), "hub_id": str(oem_id), "category": "B-OEM"}
        )
        assert resp.status_code == 422  # category is not a register field
        resp = await client.patch(f"/projects/{pid}", json={"hub_id": str(oem_id),
                                                           "category": "B-OEM"})
        assert resp.status_code == 200, resp.text
    live = await _rows(db_session, pid)
    assert set(live) == {f"OEM-{c}" for c in "ABCDEFGHIJKLMN"}
    assert not any(r.excluded for r in live.values())
    included = await _audits(db_session, pid, "project.step_included")
    assert included[-1].after_state["reason"] == "workflow_change"
    assert included[-1].before_state["step_id"] == "PDD-E"
    assert included[-1].after_state["step_id"] == "OEM-E"


async def test_full_popup_save_is_one_run_and_one_transaction(db_session, dispatch):
    mine = await make_hub(db_session)
    other = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project = await _b_project(db_session, hub=mine)
    second = await _b_project(db_session, name="Second", hub=mine)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    pid = project.id
    async with client_for(db_session) as client:
        resp = await _save(
            client,
            {
                "project_id": str(pid),
                "status": "In Buyoff",
                "actual_start_week": 20,
                "actual_end_week": 40,
                "design_effort_weeks": 4,
                "hub_id": str(other.id),
                "certification_testing_required": False,
                "step_exclusions": _excl(("PDD-A", True)),
                "current_step_code": "PDD-E",
            },
            {"project_id": str(second.id), "current_step_code": "PDD-D"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        read = (await client.get(f"/projects/{pid}/register-steps")).json()
    assert body["recalc_status"] == "queued" and len(dispatch.calls) == 1
    assert len(await _runs(db_session)) == 1
    assert sorted(body["projects_marked_stale"]) == sorted([str(pid), str(second.id)])
    p = await _fresh(db_session, pid)
    assert (p.hub_id, p.certification_testing_required, p.status) == (
        other.id, False, ProjectStatus.IN_BUYOFF
    )
    by = {s["step_code"]: s for s in read["steps"]}
    # Certification testing off: every lab step skipped and not applicable.
    assert by["PDD-H"]["status"] == "Skipped" and by["PDD-H"]["applicable"] is False
    assert read["current_step_code"] == "PDD-E"
    live = await _rows(db_session, pid)
    assert live["PDD-A"].excluded and live["PDD-A"].status == WorkflowStepStatus.NOT_STARTED
    assert live["PDD-D"].status == WorkflowStepStatus.DONE  # revived by the split, then Done
    rows_in, _ = await load_live_project_rows(db_session, [pid])
    assert check_i26_effort_split(rows_in) == ()
    entries = list(
        (
            await db_session.execute(
                select(AuditLogEntry).where(AuditLogEntry.entity_id == str(pid))
            )
        ).scalars()
    )
    assert {e.action for e in entries} >= {
        "project.update", "project.step_excluded", "project.current_step_set",
        "project.effort_rederived", "project.recalculate_requested",
    }
    for e in entries:
        if e.action == "project.update":
            for name in FINANCIAL_FIELD_NAMES:
                for state in (e.before_state, e.after_state):
                    assert state.get(name) in (None, "<redacted>")
        else:
            _assert_no_financial([e])


async def test_one_failing_project_rolls_back_the_popup_fields(db_session, dispatch):
    hub = await make_hub(db_session)
    good = await _b_project(db_session, name="Good", hub=hub)
    bad = await _b_project(db_session, name="Bad", hub=hub)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    good_id, bad_id = good.id, bad.id
    async with client_for(db_session) as client:
        resp = await _save(
            client,
            {"project_id": str(good_id), "step_exclusions": _excl(("PDD-E", True)),
             "current_step_code": "PDD-K"},
            {"project_id": str(bad_id), "step_exclusions": _excl(("PDD-B", True))},
        )
    assert [e["code"] for e in _row_errors(resp)] == ["STEP_NOT_APPLICABLE"]
    live = await _rows(db_session, good_id)
    assert not live["PDD-E"].excluded
    assert all(r.status == WorkflowStepStatus.NOT_STARTED for r in live.values())
    for action in _NEW_ACTIONS:
        assert await _audits(db_session, good_id, action) == []
    assert dispatch.calls == []


# --------------------------------------------------------------------------
# GET /projects/{id}/register-steps
# --------------------------------------------------------------------------


async def test_register_steps_read_shape_and_end_week(db_session, dispatch):
    project = await _b_project(db_session)
    run = await make_schedule_run(db_session, is_active=True)
    await add_outcome(db_session, run, project, projected=47)
    await act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with client_for(db_session) as client:
        resp = await client.get(f"/projects/{project.id}/register-steps")
        assert resp.status_code in (200, 403)
        await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
        resp = await client.get(f"/projects/{project.id}/register-steps")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        listed = (await client.get("/dashboard/projects")).json()["rows"]
        missing = await client.get(f"/projects/{uuid.uuid4()}/register-steps")
    assert missing.status_code == 404
    row = next(r for r in listed if r["project_id"] == str(project.id))
    assert set(body) == {
        "project_id", "current_step_code", "end_week", "design_weeks_calculated",
        "lab_weeks_calculated", "steps",
    }
    assert body["end_week"] == 47
    assert (body["design_weeks_calculated"], body["lab_weeks_calculated"]) == (
        row["design_weeks_calculated"], row["lab_weeks_calculated"]
    ) == (10, 6)
    assert (body["end_week"], body["current_step_code"]) == (
        row["end_week"], row["current_step_code"]
    )
    assert [s["step_code"] for s in body["steps"]] == _PDD
    assert set(body["steps"][0]) == {
        "step_code", "step_name", "kind", "status", "step_excluded", "applicable",
        "excludable", "is_current",
    }
    by = {s["step_code"]: s for s in body["steps"]}
    assert by["PDD-A"] == {
        "step_code": "PDD-A", "step_name": "Marketing Brief", "kind": "design",
        "status": "Not Started", "step_excluded": False, "applicable": True,
        "excludable": True, "is_current": True,
    }
    assert by["PDD-C"]["kind"] == "elapsed" and by["PDD-H"]["kind"] == "lab"
    assert by["PDD-B"]["status"] == "Skipped" and by["PDD-B"]["applicable"] is False


async def test_register_steps_statement_count_is_constant(db_session):
    hub = await make_hub(db_session)
    small = await _b_project(db_session, name="Small", hub=hub)
    busy = await _b_project(db_session, name="Busy", hub=hub)
    for code, start, end in (("PDD-A", 1, 2), ("PDD-D", 3, 4), ("PDD-E", 5, 9)):
        await set_progress(db_session, busy, code, WorkflowStepStatus.DONE, percent=100,
                           start=start, end=end)
    await act_as(db_session, RoleName.ADMIN)

    async def _count(project: Project) -> int:
        statements: list[str] = []

        def _record(orm_execute_state) -> None:
            statements.append(str(orm_execute_state.statement))

        target = db_session.sync_session
        async with client_for(db_session) as client:
            event.listen(target, "do_orm_execute", _record)
            try:
                resp = await client.get(f"/projects/{project.id}/register-steps")
            finally:
                event.remove(target, "do_orm_execute", _record)
        assert resp.status_code == 200, resp.text
        return len(statements)

    assert await _count(small) == await _count(busy)


# --------------------------------------------------------------------------
# R35-8: an apply flags an excluded pair
# --------------------------------------------------------------------------


def test_apply_flags_excluded_pair_and_still_writes_the_copy() -> None:
    row = SimpleNamespace(
        step_template_id="PDD-E", plan_weeks=4, plan_gap_weeks=0, effort_weeks=None,
        excluded=True,
    )
    delta = StepDelta(
        step_id="PDD-E", kind="design", weeks_before=4, weeks_after=5, gap_before=0,
        gap_after=0,
    )
    out = _step_outcome(delta, row, own_effort=False, certification_testing_required=True)
    assert out is not None
    assert out.flags == [FLAG_EXCLUDED_NO_EFFECT]
    assert (out.eff_before, out.eff_after, out.write_plan_weeks) == (0, 0, 5)


# --------------------------------------------------------------------------
# Migration p35b
# --------------------------------------------------------------------------

_CHECK = "ck_project_workflow_steps_excluded_not_done"


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
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name = 'project_workflow_steps' AND column_name = 'excluded'",
    )


def _check_def(url: str) -> list[asyncpg.Record]:
    return _fetch(
        url, "SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1", _CHECK
    )


def test_p35b_up_down_up() -> None:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "p33c_clear_step_timing"], url)
        assert r.returncode == 0, r.stderr
        assert _column(url) == []

        r = run_alembic(["upgrade", "p35b_step_excluded"], url)
        assert r.returncode == 0, r.stderr
        (col,) = _column(url)
        assert (col["data_type"], col["is_nullable"], col["column_default"]) == (
            "boolean", "NO", "false"
        )
        (check,) = _check_def(url)
        assert "excluded" in check["d"] and "Done" in check["d"]

        r = run_alembic(["downgrade", "p33c_clear_step_timing"], url)
        assert r.returncode == 0, r.stderr
        assert _column(url) == [] and _check_def(url) == []

        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        assert len(_column(url)) == 1
