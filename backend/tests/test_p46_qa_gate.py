"""P46-T04 qa-inspector: thin-coverage additions for ADR 0058 (L1 / D1).

Fills the gaps found when reviewing `test_p46_dev_logins.py` and
`test_p46_super_admin_only.py` against the ADR:

- D1.1 on the register batch (`POST /projects/register-edits`) for Hub
  Planner and Portfolio Manager, not only Admin, and that a refused cancel
  writes no audit row on either path.
- The other two project write paths cannot set Cancelled for anyone:
  `POST /projects` refuses a `status` field, `/submit` refuses a Cancelled
  target.
- L1: the username is case-insensitive (not only the email), the password is
  the username and never the email, and provisioning leaves every other user
  untouched.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

import api.routers.me as me_router
import api.routers.projects as projects_router
import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, ProjectStatus, RoleName
from models.project import Project
from models.user import User, UserRole
from services.dev_accounts import provision_dev_accounts
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_project, make_user
from workers.schedule_tasks import run_greedy_schedule

SUPER_ADMIN_ONLY = "SUPER_ADMIN_ONLY"


@pytest.fixture(autouse=True)
def _cleanup(monkeypatch):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    monkeypatch.setattr(run_greedy_schedule, "delay", lambda *a, **k: None)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    me_router.DEV_LOGIN_RATE_LIMIT.reset()
    yield
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    me_router.DEV_LOGIN_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, role: RoleName, hub_id: uuid.UUID) -> None:
    scoped = role is RoleName.HUB_PLANNER
    hub_ids = [hub_id] if scoped else []
    user = await make_user(db_session, role, hub_ids=hub_ids, hub_scope_all=not scoped)
    override_current_principal(
        make_principal(
            role, user_id=user.id, email=user.email, hub_scope_all=not scoped, hub_ids=hub_ids
        )
    )


async def _status(db_session, project_id: uuid.UUID) -> ProjectStatus:
    return (
        await db_session.execute(
            select(Project.status)
            .where(Project.id == project_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _project_audits(db_session, project_id: uuid.UUID) -> int:
    return (
        await db_session.execute(
            select(func.count())
            .select_from(AuditLogEntry)
            .where(AuditLogEntry.entity_id == str(project_id))
        )
    ).scalar_one()


NON_SUPER = [RoleName.ADMIN, RoleName.PORTFOLIO_MANAGER, RoleName.HUB_PLANNER]


# --- D1.1: register batch, every non-Super-Admin writer -------------------------------


@pytest.mark.parametrize("role", NON_SUPER)
async def test_register_batch_cancel_is_403_for_every_non_super_admin(db_session, role):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await make_project(db_session, hub, status=ProjectStatus.IN_QUEUE)
    await _act_as(db_session, role, hub.id)
    audits_before = await _project_audits(db_session, project.id)
    async with _client(db_session) as client:
        resp = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(project.id), "status": "Cancelled"}]},
        )
    assert resp.status_code == 403, resp.text
    assert resp.json()["code"] == SUPER_ADMIN_ONLY
    assert await _status(db_session, project.id) == ProjectStatus.IN_QUEUE
    assert await _project_audits(db_session, project.id) == audits_before


@pytest.mark.parametrize("role", NON_SUPER)
async def test_patch_cancel_403_writes_no_audit(db_session, role):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await make_project(db_session, hub, status=ProjectStatus.IN_DEVELOPMENT)
    await _act_as(db_session, role, hub.id)
    audits_before = await _project_audits(db_session, project.id)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"status": "Cancelled"})
    assert resp.status_code == 403 and resp.json()["code"] == SUPER_ADMIN_ONLY
    assert await _project_audits(db_session, project.id) == audits_before


@pytest.mark.parametrize("role", NON_SUPER)
async def test_register_batch_leaving_cancelled_stays_allowed(db_session, role):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await make_project(db_session, hub, status=ProjectStatus.CANCELLED, priority=None)
    await _act_as(db_session, role, hub.id)
    async with _client(db_session) as client:
        resp = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(project.id), "status": "On Hold"}]},
        )
    assert resp.status_code == 200, resp.text
    assert await _status(db_session, project.id) == ProjectStatus.ON_HOLD


# --- D1.1: the other project write paths cannot set Cancelled at all -----------------


@pytest.mark.parametrize("role", NON_SUPER)
async def test_create_refuses_a_status_field(db_session, role):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await _act_as(db_session, role, hub.id)
    async with _client(db_session) as client:
        resp = await client.post(
            "/projects",
            json={"name": "QA P46 create", "hub_id": str(hub.id), "status": "Cancelled"},
        )
    assert resp.status_code == 422, resp.text
    assert {"type": "extra_forbidden", "loc": ["body", "status"]}.items() <= resp.json()["detail"][
        0
    ].items()
    count = (
        await db_session.execute(
            select(func.count()).select_from(Project).where(Project.name == "QA P46 create")
        )
    ).scalar_one()
    assert count == 0


@pytest.mark.parametrize("role", [*NON_SUPER, RoleName.SUPER_ADMIN])
async def test_submit_never_targets_cancelled(db_session, role):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await make_project(db_session, hub, status=ProjectStatus.DRAFT, priority=None)
    await _act_as(db_session, role, hub.id)
    async with _client(db_session) as client:
        resp = await client.post(
            f"/projects/{project.id}/submit", json={"target_status": "Cancelled"}
        )
    assert resp.status_code == 400, resp.text
    assert await _status(db_session, project.id) == ProjectStatus.DRAFT


# --- L1: dev-login identifier rules -----------------------------------------------------


@pytest.mark.parametrize(
    ("username", "password", "email"),
    [
        ("ADMIN", "admin", "admin@example.com"),
        ("SuperAdmin", "superadmin", "superadmin@example.com"),
        ("  superadmin  ", "superadmin", "superadmin@example.com"),
    ],
)
async def test_dev_login_username_is_case_insensitive(db_session, username, password, email):
    await provision_dev_accounts(db_session)
    async with _client(db_session) as client:
        resp = await client.post("/me/dev-login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    assert resp.json()["email"] == email


@pytest.mark.parametrize(
    ("username", "password"),
    [
        ("admin@example.com", "admin@example.com"),  # password is the username, not the email
        ("superadmin", "superadmin@example.com"),
        ("admin", "ADMIN"),  # the password is case-sensitive
        ("admin", " admin"),  # the password is not trimmed
    ],
)
async def test_dev_login_password_is_exactly_the_username(db_session, username, password):
    await provision_dev_accounts(db_session)
    async with _client(db_session) as client:
        resp = await client.post("/me/dev-login", json={"username": username, "password": password})
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Invalid username or password."}


async def test_dev_login_does_not_accept_other_seeded_users(db_session):
    """Only the two accounts sign in, even with a seeded user's own address."""

    await make_user(db_session, RoleName.SUPER_ADMIN, email="sara.super@example.com")
    await provision_dev_accounts(db_session)
    async with _client(db_session) as client:
        resp = await client.post(
            "/me/dev-login", json={"username": "sara.super", "password": "sara.super"}
        )
        users = await client.get("/me/dev-users")
    assert resp.status_code == 401
    assert [u["email"] for u in users.json()] == ["superadmin@example.com", "admin@example.com"]


# --- L1: provisioning leaves every other user alone -------------------------------------


async def test_provisioning_leaves_other_users_untouched(db_session):
    other = await make_user(
        db_session, RoleName.ADMIN, email="frank.admin@example.com", full_name="Frank",
        is_active=False,
    )  # fmt: skip
    await provision_dev_accounts(db_session)
    await provision_dev_accounts(db_session)
    after = (
        await db_session.execute(
            select(User)
            .options(selectinload(User.roles).selectinload(UserRole.role))
            .where(User.id == other.id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert after.is_active is False
    assert after.full_name == "Frank"
    assert {str(ur.role.name) for ur in after.roles} == {"Admin"}
    total = (
        await db_session.execute(
            select(func.count())
            .select_from(AuditLogEntry)
            .where(AuditLogEntry.entity_id == str(other.id))
        )
    ).scalar_one()
    assert total == 0


async def test_provisioning_repairs_a_missing_role_on_an_active_account(db_session):
    """Active but without its role: only the role is added (no reactivation
    needed); a second run is unchanged."""

    await make_user(db_session, RoleName.AUDITOR, email="superadmin@example.com")
    first = await provision_dev_accounts(db_session)
    second = await provision_dev_accounts(db_session)
    assert first["superadmin"] == "repaired" and first["admin"] == "created"
    assert second == {"superadmin": "unchanged", "admin": "unchanged"}
    user = (
        await db_session.execute(
            select(User)
            .options(selectinload(User.roles).selectinload(UserRole.role))
            .where(User.email == "superadmin@example.com")
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert {str(ur.role.name) for ur in user.roles} == {"Auditor", "Super Admin"}


# --- L1: the by-hand provisioning script ------------------------------------------------


def test_provision_script_refuses_outside_dev_mode(monkeypatch, capsys):
    from scripts import provision_dev_accounts as script

    monkeypatch.delenv("RPD_DEV_MODE", raising=False)
    assert script.main() == 2
    assert "refused: RPD_DEV_MODE" in capsys.readouterr().out


def test_provision_script_refuses_without_database_url(monkeypatch, capsys):
    from scripts import provision_dev_accounts as script

    monkeypatch.setenv("RPD_DEV_MODE", "true")
    monkeypatch.delenv("RPD_DATABASE_URL", raising=False)
    assert script.main() == 2
    assert "RPD_DATABASE_URL is not set" in capsys.readouterr().out


def test_provision_script_runs_idempotently_on_its_own_database():
    """End to end on a dedicated container (the shared test database is never
    committed to): first run creates both accounts, second run changes
    nothing."""

    import os
    import subprocess
    import sys

    from testcontainers.postgres import PostgresContainer

    from tests.conftest import BACKEND_DIR, run_alembic

    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        assert run_alembic(["upgrade", "head"], url).returncode == 0
        env = {**os.environ, "RPD_DATABASE_URL": url, "RPD_DEV_MODE": "true"}

        def _run() -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [sys.executable, "-m", "scripts.provision_dev_accounts"],
                cwd=str(BACKEND_DIR),
                env=env,
                capture_output=True,
                text=True,
            )

        first, second = _run(), _run()
    assert first.returncode == 0, first.stderr
    assert first.stdout.splitlines() == ["superadmin: created", "admin: created"]
    assert second.returncode == 0, second.stderr
    assert second.stdout.splitlines() == ["superadmin: unchanged", "admin: unchanged"]
