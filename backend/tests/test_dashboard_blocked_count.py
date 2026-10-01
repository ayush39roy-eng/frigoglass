"""P9-F02 — the Dashboard's `blocked_count` bucket
(`GET /dashboard/completing-within-year`).

A project whose active `ScheduleRun`'s `ScheduleRunProjectOutcome.blocked`
is `True` must be counted in `blocked_count`, and NEVER also in
`within_year_count`/`spillover_count`/`left_out_count` — even on a row where
one of those raw flags happens to also be set (the one row this test builds
that is both `left_out=True` and `blocked=True`), per
`docs/IMPLEMENTATION_PLAN.md`'s P9-F02 follow-up and
`docs/DOMAIN_RULES.md`'s "Gate remediation rulings" 5.
"""

from __future__ import annotations

import uuid

from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, RoleName
from models.schedule import ScheduleRunProjectOutcome
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_project, make_schedule_run, make_user


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown():
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


async def _as_unrestricted(db_session, *roles: RoleName) -> AsyncClient:
    user = await make_user(db_session, *roles, hub_scope_all=True)
    client = _client(db_session)
    override_current_principal(make_principal(*roles, user_id=user.id, hub_scope_all=True))
    return client


async def _make_outcome(db_session, run, project, **overrides) -> ScheduleRunProjectOutcome:
    defaults: dict = dict(
        id=uuid.uuid4(),
        schedule_run_id=run.id,
        project_id=project.id,
        left_out=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=False,
        blocked=False,
    )
    defaults.update(overrides)
    outcome = ScheduleRunProjectOutcome(**defaults)
    db_session.add(outcome)
    await db_session.flush()
    return outcome


async def test_blocked_project_counted_only_in_blocked_bucket(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)

    p_within_year = await make_project(db_session, hub, name="Within Year")
    p_spillover = await make_project(db_session, hub, name="Spillover")
    p_left_out = await make_project(db_session, hub, name="Left Out")
    p_blocked = await make_project(db_session, hub, name="Blocked")
    # A pathological row: `left_out=True` AND `blocked=True` at once — must
    # land in `blocked_count` only, never double-counted into
    # `left_out_count` too.
    p_blocked_and_left_out = await make_project(db_session, hub, name="Blocked And Left Out")

    await _make_outcome(db_session, run, p_within_year, within_year=True, last_step_end_week=10)
    await _make_outcome(db_session, run, p_spillover, spillover=True, last_step_end_week=60)
    await _make_outcome(db_session, run, p_left_out, left_out=True)
    await _make_outcome(db_session, run, p_blocked, blocked=True)
    await _make_outcome(
        db_session, run, p_blocked_and_left_out, left_out=True, blocked=True
    )
    await db_session.commit()

    try:
        async with await _as_unrestricted(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.get("/dashboard/completing-within-year")
        assert resp.status_code == 200
        body = resp.json()
        assert body["has_active_schedule_run"] is True
        assert body["within_year_count"] == 1
        assert body["spillover_count"] == 1
        assert body["left_out_count"] == 1
        assert body["blocked_count"] == 2

        rows_by_name = {row["project_name"]: row for row in body["rows"]}
        assert rows_by_name["Blocked"]["blocked"] is True
        assert rows_by_name["Blocked And Left Out"]["blocked"] is True
        assert rows_by_name["Blocked And Left Out"]["left_out"] is True
        assert rows_by_name["Within Year"]["blocked"] is False
    finally:
        _teardown()


async def test_no_active_schedule_run_zeroes_blocked_count(db_session):
    try:
        async with await _as_unrestricted(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.get("/dashboard/completing-within-year")
        assert resp.status_code == 200
        body = resp.json()
        assert body["has_active_schedule_run"] is False
        assert body["blocked_count"] == 0
    finally:
        _teardown()
