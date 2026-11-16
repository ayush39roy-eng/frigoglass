"""P40-R01 (P40-T03d FAIL): the register "current step" writer clears pins.

ADR 0054 R40-4 / I46 (c)(e): a write that moves a stage out of Not Started
clears that step's pin in the same transaction, under the project row lock,
with one `project.step_pin_cleared` audit row (`cause = "stage_started"`).
`services.register_steps.apply_current_step` (P35-T06,
`POST /projects/register-edits` `current_step_code`) is such a writer.

PDD / B (DOMAIN_RULES "Lead times"): A1 B0 C0 D1 E4 F0 G0 H6 I0 J1 K2 L1 M1
N1. Picking PDD-K makes A D E H J Done and K In Progress; L M N stay Not
Started. Tests pin the plan week at 31.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

from api.db import get_db
from api.main import app
from api.routers import projects as projects_router
from models.audit import AuditLogEntry
from models.enums import ProjectCategory, RoleName, WorkflowStepStatus
from models.project import Project
from models.workflow import ProjectWorkflowStep
from services import priority_move
from services.step_pin_clear import AUDIT_PIN_CLEARED, AUDIT_PINNED
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub
from tests.p12_helpers import act_as, client_for, stepped_project
from workers.schedule_tasks import run_greedy_schedule

_URL = "/projects/register-edits"


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


async def _b_project(db, name: str = "P40-R01 B") -> Project:
    hub = await make_hub(db)
    leader = await make_engineer(db, hub, name=f"Lead {name}")
    return await stepped_project(db, hub, name=name, leader=leader, category=ProjectCategory.B)


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


async def _pin(db, project: Project, code: str, start: int, end: int) -> None:
    row = (await _rows(db, project.id))[code]
    row.manual_start_week = start
    row.manual_end_week = end
    await db.flush()


async def _pin_audits(db, action: str) -> list[AuditLogEntry]:
    return list(
        (
            await db.execute(
                select(AuditLogEntry)
                .where(AuditLogEntry.action == action)
                .order_by(AuditLogEntry.id)
            )
        ).scalars()
    )


def _pin_of(row: ProjectWorkflowStep) -> tuple[int | None, int | None]:
    return (row.manual_start_week, row.manual_end_week)


async def _i46e_violations(db) -> list[tuple[uuid.UUID, str]]:
    """I46 (e): no live step whose stage is not Not Started carries a pin."""

    rows = (
        await db.execute(
            select(ProjectWorkflowStep)
            .where(
                ProjectWorkflowStep.status != WorkflowStepStatus.NOT_STARTED,
                (ProjectWorkflowStep.manual_start_week.is_not(None))
                | (ProjectWorkflowStep.manual_end_week.is_not(None)),
            )
            .execution_options(populate_existing=True)
        )
    ).scalars()
    return [(r.project_id, r.step_template_id) for r in rows]


async def _save(client, edit: dict[str, Any]):
    return await client.post(_URL, json={"edits": [edit]})


async def test_current_step_past_a_pinned_step_clears_the_pin(db_session, dispatch):
    project = await _b_project(db_session)
    # E is passed by the move (Not Started -> Done); M stays Not Started.
    await _pin(db_session, project, "PDD-E", 45, 46)
    await _pin(db_session, project, "PDD-M", 50, 51)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    pid = project.id

    async with client_for(db_session) as client:
        resp = await _save(client, {"project_id": str(pid), "current_step_code": "PDD-K"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "queued" and len(dispatch.calls) == 1

    live = await _rows(db_session, pid)
    assert live["PDD-E"].status == WorkflowStepStatus.DONE
    assert _pin_of(live["PDD-E"]) == (None, None)
    # The pin on a step that stays Not Started survives.
    assert live["PDD-M"].status == WorkflowStepStatus.NOT_STARTED
    assert _pin_of(live["PDD-M"]) == (50, 51)

    (audit,) = await _pin_audits(db_session, AUDIT_PIN_CLEARED)
    assert audit.entity_type == "ProjectWorkflowStep"
    assert audit.entity_id == str(live["PDD-E"].id)
    assert audit.hub_id == project.hub_id
    assert audit.before_state == {
        "project_id": str(pid),
        "step_id": "PDD-E",
        "stage": WorkflowStepStatus.NOT_STARTED.value,
        "manual_start_week": 45,
        "manual_end_week": 46,
    }
    assert audit.after_state == {
        "project_id": str(pid),
        "step_id": "PDD-E",
        "stage": WorkflowStepStatus.DONE.value,
        "manual_start_week": None,
        "manual_end_week": None,
        "cause": "stage_started",
    }
    assert await _pin_audits(db_session, AUDIT_PINNED) == []
    assert await _i46e_violations(db_session) == []

    # Moving back: E returns to Not Started. Its pin is gone, so nothing
    # revives, and no further pin audit row is written; M's pin is untouched.
    async with client_for(db_session) as client:
        resp = await _save(client, {"project_id": str(pid), "current_step_code": "PDD-D"})
    assert resp.status_code == 200, resp.text
    live = await _rows(db_session, pid)
    assert live["PDD-E"].status == WorkflowStepStatus.NOT_STARTED
    assert _pin_of(live["PDD-E"]) == (None, None)
    assert _pin_of(live["PDD-M"]) == (50, 51)
    assert len(await _pin_audits(db_session, AUDIT_PIN_CLEARED)) == 1
    assert await _pin_audits(db_session, AUDIT_PINNED) == []
    assert await _i46e_violations(db_session) == []


async def test_pin_on_the_picked_step_is_cleared_and_later_pins_survive(db_session, dispatch):
    project = await _b_project(db_session, name="P40-R01 at")
    # The picked step itself leaves Not Started (-> In Progress).
    await _pin(db_session, project, "PDD-E", 40, 43)
    await _pin(db_session, project, "PDD-J", 47, 47)
    await _pin(db_session, project, "PDD-N", 52, 52)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    pid = project.id

    async with client_for(db_session) as client:
        resp = await _save(client, {"project_id": str(pid), "current_step_code": "PDD-E"})
    assert resp.status_code == 200, resp.text

    live = await _rows(db_session, pid)
    assert live["PDD-E"].status == WorkflowStepStatus.IN_PROGRESS
    assert _pin_of(live["PDD-E"]) == (None, None)
    for code, pin in (("PDD-J", (47, 47)), ("PDD-N", (52, 52))):
        assert live[code].status == WorkflowStepStatus.NOT_STARTED, code
        assert _pin_of(live[code]) == pin, code
    (audit,) = await _pin_audits(db_session, AUDIT_PIN_CLEARED)
    assert audit.after_state["step_id"] == "PDD-E"
    assert audit.after_state["stage"] == WorkflowStepStatus.IN_PROGRESS.value
    assert audit.after_state["cause"] == "stage_started"
    assert await _i46e_violations(db_session) == []


async def test_refused_current_step_keeps_every_pin(db_session, dispatch):
    """A refused patch rolls back: the pin and the audit log are untouched."""

    project = await _b_project(db_session, name="P40-R01 refused")
    await _pin(db_session, project, "PDD-E", 45, 46)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()
    pid = project.id

    async with client_for(db_session) as client:
        # PDD-B is 0 weeks for a B project: skipped, so 422 STEP_NOT_APPLICABLE.
        resp = await _save(client, {"project_id": str(pid), "current_step_code": "PDD-B"})
    assert resp.status_code == 422, resp.text
    live = await _rows(db_session, pid)
    assert _pin_of(live["PDD-E"]) == (45, 46)
    assert await _pin_audits(db_session, AUDIT_PIN_CLEARED) == []
    assert dispatch.calls == []
