"""P55-T02 (ADR 0065): `actual_start_week` is optional at registration.

Covered:
- `POST /projects` without `actual_start_week` is 201 In Queue (ranked in its
  band), and the project is schedulable: the greedy run schedules it from the
  current week (`max(CURRENT_WEEK, actual_start_week or CURRENT_WEEK)`);
- `GET /projects/{id}/hard-gate-status` and the legacy `POST /projects/{id}/
  submit` no longer require it;
- the started-stage rule is unchanged: a stage set In Progress without its
  `actual_start_week` is still 422 `STAGE_INCONSISTENT`.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.enums import (
    EngineerAllowedCategory,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
)
from models.project import Project
from scheduling.greedy import run_greedy_sgs
from services.project_hard_gates import HARD_GATE_FIELDS
from services.schedule_persistence import build_schedule_input_from_db
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_engineer,
    make_hub,
    make_project,
    make_user,
    registration_body,
)


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


async def _act_as(db_session, *roles: RoleName) -> None:
    user = await make_user(db_session, *roles, hub_ids=[], hub_scope_all=True)
    override_current_principal(
        make_principal(*roles, user_id=user.id, email=user.email, hub_scope_all=True)
    )


def test_actual_start_week_is_not_a_gate_field():
    names = [name for name, _label in HARD_GATE_FIELDS]
    assert "actual_start_week" not in names
    # P56 (2026-11-19): the list is empty; only name and hub are required.
    assert names == []


@pytest.mark.parametrize("omit", ["absent", "null"])
async def test_create_without_start_week_is_201_in_queue_and_schedulable(db_session, omit):
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub, allowed_categories=[EngineerAllowedCategory.C])
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    # No chamber in this world: lab steps off, so only the start week matters.
    body = registration_body(
        hub,
        leader,
        category="C",
        priority="P1",
        actual_start_week=None,
        certification_testing_required=False,
    )
    if omit == "absent":
        body.pop("actual_start_week")
    async with _client(db_session) as client:
        resp = await client.post("/projects", json=body)
    assert resp.status_code == 201, resp.text
    served = resp.json()
    assert served["status"] == ProjectStatus.IN_QUEUE.value
    assert served["actual_start_week"] is None
    assert served["band_rank"] == 1

    project_id = uuid.UUID(served["id"])
    schedule_input = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    assert str(project_id) in {p.project_id for p in schedule_input.projects}
    outcome = next(
        o
        for o in run_greedy_sgs(schedule_input).project_outcomes
        if o.project_id == str(project_id)
    )
    assert outcome.data_error is None and not outcome.excluded and not outcome.left_out
    # max(CURRENT_WEEK, actual_start_week or CURRENT_WEEK) with a free leader.
    assert outcome.start_week == TEST_WEEK


async def test_hard_gate_status_and_submit_no_longer_require_start_week(db_session):
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    legacy = await make_project(
        db_session,
        hub,
        leader=leader,
        status=ProjectStatus.DRAFT,
        category=ProjectCategory.C,
        priority=ProjectPriority.P2,
        actual_start_week=None,
        tcogs_eur=1,
        selling_price_eur=2,
        gross_margin_pct=50,
    )
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        gate = await client.get(f"/projects/{legacy.id}/hard-gate-status")
        submit = await client.post(f"/projects/{legacy.id}/submit", json={})
    assert gate.status_code == 200, gate.text
    assert "actual start date" not in gate.json()["missing_fields"]
    assert gate.json()["can_leave_draft"] is True
    assert submit.status_code == 200, submit.text
    assert submit.json()["status"] == ProjectStatus.IN_QUEUE.value
    assert submit.json()["actual_start_week"] is None


async def test_stage_in_progress_without_start_week_is_still_422(db_session):
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub, allowed_categories=[EngineerAllowedCategory.C])
    await _act_as(db_session, RoleName.ADMIN)
    body = registration_body(hub, leader, category="C", priority="P2", actual_start_week=None)
    async with _client(db_session) as client:
        created = await client.post("/projects", json=body)
        assert created.status_code == 201, created.text
        project_id = created.json()["id"]
        resp = await client.patch(
            f"/projects/{project_id}/stages/PDD-E", json={"status": "In Progress"}
        )
    assert resp.status_code == 422, resp.text
    payload = resp.json()
    assert payload["code"] == "STAGE_INCONSISTENT"
    assert {e["loc"][1] for e in payload["detail"]} == {"actual_start_week"}
    stored = (
        await db_session.execute(
            select(Project)
            .where(Project.id == uuid.UUID(project_id))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert stored.actual_start_week is None
