"""P3-T09 (security remediation, security-auditor P3-T08 finding #1, High) —
regression coverage for withholding named-engineer utilization at the API
layer pending `docs/OPEN_QUESTIONS.md` #8 (GDPR) sign-off.

Same live-verification method as `tests/test_api_deps.py` / P3-T08's own
adversarial suite: a REAL RS256 JWT (`tests.jwt_helpers.FakeIdPKeypair`, JWKS
monkeypatched) is verified end-to-end through the REAL `get_current_principal`
-> real DB-backed `User`/`UserRole`/`UserHubScope` -> real `core.rbac` ->
real `services.hub_scope`, driven through `api.main.app` over `ASGITransport`
against the shared testcontainer Postgres (`db_session` fixture). No
dependency override of `get_current_principal` is used anywhere in this file.

Covers:
- `GET /capacity/utilization-matrix`: `EngineerWeekLoad` rows never carry a
  `name` key, for any role; `engineer_id`/`hub`/`busy_weeks` still populate
  correctly; chamber-side rows are completely unaffected.
- `GET /gantt`: `assigned_engineer_name` is `None` for every non-self reader
  (Portfolio Manager/hub_scope_all, Hub Planner/hub-scoped) even though a
  real engineer is assigned to the step; the Engineer role viewing their own
  self-scoped Gantt still receives their own name.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

import core.oidc as oidc_module
from api.db import get_db
from api.main import app
from core.config import get_oidc_settings
from core.oidc import clear_jwks_cache
from models.enums import HubName, LabRegion, RoleName
from models.schedule import ScheduleRunProjectStep
from tests.factories import (
    make_chamber,
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_user,
    make_workflow_step_template,
)
from tests.jwt_helpers import FakeIdPKeypair

ISSUER = "https://issuer.test/realms/rpd"
AUDIENCE = "rpd-backend"


@pytest.fixture(autouse=True)
def _oidc_settings(monkeypatch):
    clear_jwks_cache()
    get_oidc_settings.cache_clear()
    monkeypatch.setenv("RPD_OIDC_ISSUER", ISSUER)
    monkeypatch.setenv("RPD_OIDC_AUDIENCE", AUDIENCE)
    yield
    get_oidc_settings.cache_clear()
    clear_jwks_cache()


@pytest.fixture
def idp(monkeypatch) -> FakeIdPKeypair:
    kp = FakeIdPKeypair()

    async def _fake_get_jwks(_settings):
        return kp.jwks

    monkeypatch.setattr(oidc_module, "get_jwks", _fake_get_jwks)
    return kp


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown():
    app.dependency_overrides.pop(get_db, None)


async def _scenario(db_session):
    """One hub, one engineer (with a real, distinctive name), one chamber,
    one project whose active-run schedule has a design step (assigned to the
    engineer) and a lab step (assigned to the chamber). Returns the pieces
    tests need to assert against.
    """
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    engineer = await make_engineer(db_session, hub, name="Secret Engineer Name")
    chamber = await make_chamber(db_session, lab_region=LabRegion.GREECE, code="CH-GDPR-1")
    design_template = await make_workflow_step_template(
        db_session, step_id="PDD-A", name="Marketing Brief", sequence_order=1
    )
    from models.enums import WorkflowStepKind

    lab_template = await make_workflow_step_template(
        db_session,
        step_id="PDD-F",
        name="Proof of Concept",
        kind=WorkflowStepKind.LAB,
        sequence_order=2,
    )
    project = await make_project(db_session, hub, name="GDPR Test Project", leader=engineer)
    run = await make_schedule_run(db_session, is_active=True)
    db_session.add(
        ScheduleRunProjectStep(
            schedule_run_id=run.id,
            project_id=project.id,
            step_template_id=design_template.id,
            sequence_order=1,
            duration_weeks=2,
            start_week=31,
            end_week=32,
            assigned_engineer_id=engineer.id,
        )
    )
    db_session.add(
        ScheduleRunProjectStep(
            schedule_run_id=run.id,
            project_id=project.id,
            step_template_id=lab_template.id,
            sequence_order=2,
            duration_weeks=3,
            start_week=33,
            end_week=35,
            assigned_chamber_id=chamber.id,
        )
    )
    await db_session.flush()
    return hub, engineer, chamber, project, run


async def test_utilization_matrix_never_returns_engineer_name_for_any_role(db_session, idp):
    hub, engineer, chamber, _project, _run = await _scenario(db_session)
    user = await make_user(
        db_session, RoleName.PORTFOLIO_MANAGER, oidc_subject="pm-sub", hub_scope_all=True
    )
    token = idp.sign(sub="pm-sub", iss=ISSUER, aud=AUDIENCE, email=user.email)

    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/capacity/utilization-matrix",
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 200
        body = resp.json()

        assert body["engineers"], "expected at least one engineer row to assert against"
        for row in body["engineers"]:
            assert "name" not in row, f"engineer row leaked a name key: {row}"
        eng_row = next(r for r in body["engineers"] if r["engineer_id"] == str(engineer.id))
        assert eng_row["hub"] == hub.name.value
        assert 31 in eng_row["busy_weeks"] and 32 in eng_row["busy_weeks"]

        # Chamber side (equipment, not personal data) must be completely
        # unaffected by this remediation.
        assert body["chambers"], "expected at least one chamber row to assert against"
        chamber_row = next(r for r in body["chambers"] if r["chamber_id"] == str(chamber.id))
        assert chamber_row["code"] == "CH-GDPR-1"
        assert chamber_row["lab_region"] == LabRegion.GREECE.value
        assert chamber_row["week_counts"].get("33") == 1 or chamber_row["week_counts"].get(33) == 1
    finally:
        _teardown()


async def test_gantt_withholds_engineer_name_for_portfolio_manager(db_session, idp):
    """A `hub_scope_all` reader (Portfolio Manager) — the exact reader called
    out in security-auditor's finding #1 evidence — must never see
    `assigned_engineer_name`, even though a real engineer is assigned.
    """
    _hub, _engineer, _chamber, project, _run = await _scenario(db_session)
    user = await make_user(
        db_session, RoleName.PORTFOLIO_MANAGER, oidc_subject="pm-sub-2", hub_scope_all=True
    )
    token = idp.sign(sub="pm-sub-2", iss=ISSUER, aud=AUDIENCE, email=user.email)

    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/gantt",
                params={"project_id": str(project.id)},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["rows"], "expected the seeded project's row"
        row = body["rows"][0]
        design_steps = [s for s in row["steps"] if s["step_id"] == "PDD-A"]
        assert design_steps, "expected the design step to be present"
        assert design_steps[0]["assigned_engineer_name"] is None
        # Chamber assignment on the lab step is unaffected.
        lab_steps = [s for s in row["steps"] if s["step_id"] == "PDD-F"]
        assert lab_steps[0]["assigned_chamber_code"] == "CH-GDPR-1"
    finally:
        _teardown()


async def test_gantt_withholds_engineer_name_for_hub_planner(db_session, idp):
    hub, _engineer, _chamber, project, _run = await _scenario(db_session)
    user = await make_user(
        db_session,
        RoleName.HUB_PLANNER,
        oidc_subject="hp-sub",
        hub_scope_all=False,
        hub_ids=[hub.id],
    )
    token = idp.sign(sub="hp-sub", iss=ISSUER, aud=AUDIENCE, email=user.email)

    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/gantt",
                params={"project_id": str(project.id)},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 200
        body = resp.json()
        row = body["rows"][0]
        design_steps = [s for s in row["steps"] if s["step_id"] == "PDD-A"]
        assert design_steps[0]["assigned_engineer_name"] is None
    finally:
        _teardown()


async def test_gantt_engineer_self_scoped_view_keeps_own_name(db_session, idp):
    """The one carve-out: an Engineer viewing their OWN self-scoped Gantt may
    still see their own name (it is, definitionally, not a disclosure to a
    third party).
    """
    _hub, engineer, _chamber, project, _run = await _scenario(db_session)
    user = await make_user(
        db_session, RoleName.ENGINEER, oidc_subject="eng-sub", hub_scope_all=False, hub_ids=[]
    )
    engineer.user_id = user.id
    await db_session.flush()
    token = idp.sign(sub="eng-sub", iss=ISSUER, aud=AUDIENCE, email=user.email)

    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/gantt",
                params={"project_id": str(project.id)},
                headers={"Authorization": f"Bearer {token}"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["rows"], "engineer should see their own assigned project"
        row = body["rows"][0]
        design_steps = [s for s in row["steps"] if s["step_id"] == "PDD-A"]
        assert design_steps[0]["assigned_engineer_name"] == "Secret Engineer Name"
    finally:
        _teardown()
