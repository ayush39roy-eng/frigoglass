"""P33-T06: RBAC surface `workflow_templates` (ADR 0045 §7, amended ADR 0010,
docs/API_CONTRACT_P33.md Part A).

- Role matrix for all 7 roles on `workflow_templates` and `workflow_settings`,
  through the named dependency helpers in `api.deps`.
- `GET /me` contract: `permissions.workflow_templates = {read, write}` is
  present, and every other surface cell is exactly what it was before P33
  (frozen below, independent of `core.rbac`).
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.deps import (
    require_workflow_templates_or_settings_read,
    require_workflow_templates_write,
)
from api.main import app
from core.config import get_oidc_settings
from core.principal import Principal
from core.rbac import Surface
from models.enums import RoleName
from schemas.session import SurfacePermissions
from tests.factories import make_hub, make_user

# (read, write) per role for the two workflow surfaces. Contract Part A.
_WORKFLOW_CELLS: dict[RoleName, dict[str, tuple[bool, bool]]] = {
    RoleName.PORTFOLIO_MANAGER: {
        "workflow_templates": (False, False),
        "workflow_settings": (False, False),
    },
    RoleName.HUB_PLANNER: {
        "workflow_templates": (False, False),
        "workflow_settings": (False, False),
    },
    RoleName.ENGINEER: {
        "workflow_templates": (False, False),
        "workflow_settings": (False, False),
    },
    RoleName.EXECUTIVE_VIEWER: {
        "workflow_templates": (False, False),
        "workflow_settings": (False, False),
    },
    RoleName.AUDITOR: {
        "workflow_templates": (False, False),
        "workflow_settings": (False, False),
    },
    RoleName.ADMIN: {
        "workflow_templates": (True, True),
        "workflow_settings": (True, False),
    },
    RoleName.SUPER_ADMIN: {
        "workflow_templates": (True, True),
        "workflow_settings": (True, True),
    },
}

# The pre-P33 `/me` table for the other nine surfaces, frozen as literals so a
# P33 change that leaks into another surface fails here. "r" read, "rw" both,
# "" none.
_PRE_P33: dict[RoleName, dict[str, str]] = {
    RoleName.PORTFOLIO_MANAGER: {
        "dashboard": "r", "capacity": "r", "matrix": "rw", "gantt": "r",
        "project_workspace": "rw", "project_registration": "rw",
        "capacity_planning": "r", "audit_log": "", "user_role_admin": "",
    },
    RoleName.HUB_PLANNER: {
        "dashboard": "r", "capacity": "rw", "matrix": "r", "gantt": "rw",
        "project_workspace": "rw", "project_registration": "rw",
        "capacity_planning": "rw", "audit_log": "", "user_role_admin": "",
    },
    RoleName.ENGINEER: {
        "dashboard": "", "capacity": "", "matrix": "", "gantt": "r",
        "project_workspace": "r", "project_registration": "",
        "capacity_planning": "", "audit_log": "", "user_role_admin": "",
    },
    RoleName.EXECUTIVE_VIEWER: {
        "dashboard": "r", "capacity": "r", "matrix": "r", "gantt": "r",
        "project_workspace": "r", "project_registration": "",
        "capacity_planning": "", "audit_log": "", "user_role_admin": "",
    },
    RoleName.AUDITOR: {
        "dashboard": "", "capacity": "", "matrix": "", "gantt": "",
        "project_workspace": "", "project_registration": "",
        "capacity_planning": "", "audit_log": "r", "user_role_admin": "",
    },
    RoleName.ADMIN: {
        "dashboard": "rw", "capacity": "rw", "matrix": "rw", "gantt": "rw",
        "project_workspace": "rw", "project_registration": "rw",
        "capacity_planning": "rw", "audit_log": "r", "user_role_admin": "rw",
    },
    RoleName.SUPER_ADMIN: {
        "dashboard": "rw", "capacity": "rw", "matrix": "rw", "gantt": "rw",
        "project_workspace": "rw", "project_registration": "rw",
        "capacity_planning": "rw", "audit_log": "r", "user_role_admin": "rw",
    },
}  # fmt: skip


class _FakeRequest:
    def __init__(self) -> None:
        self.state = type("State", (), {})()


def _principal(*roles: RoleName) -> Principal:
    return Principal(
        user_id=uuid.uuid4(),
        email="p33@example.com",
        full_name="P33",
        oidc_subject="p33-sub",
        roles=frozenset(roles),
    )


async def _allowed(dep, *roles: RoleName) -> bool:
    try:
        await dep(_FakeRequest(), _principal(*roles))
    except HTTPException as exc:
        assert exc.status_code == 403
        return False
    return True


def test_seven_roles_covered() -> None:
    assert set(_WORKFLOW_CELLS) == set(RoleName)
    assert len(RoleName) == 7


def test_surface_enum_and_me_schema_carry_workflow_templates() -> None:
    assert Surface("workflow_templates") is Surface.WORKFLOW_TEMPLATES
    assert set(SurfacePermissions.model_fields) == {s.value for s in Surface}


@pytest.mark.parametrize("role", list(RoleName))
async def test_workflow_templates_write_helper_per_role(role: RoleName) -> None:
    expected = _WORKFLOW_CELLS[role]["workflow_templates"][1]
    assert await _allowed(require_workflow_templates_write, role) is expected


@pytest.mark.parametrize("role", list(RoleName))
async def test_templates_or_settings_read_helper_per_role(role: RoleName) -> None:
    cells = _WORKFLOW_CELLS[role]
    expected = cells["workflow_templates"][0] or cells["workflow_settings"][0]
    assert await _allowed(require_workflow_templates_or_settings_read, role) is expected


async def test_write_helper_unions_multiple_roles() -> None:
    assert await _allowed(require_workflow_templates_write, RoleName.AUDITOR, RoleName.ADMIN)
    assert not await _allowed(
        require_workflow_templates_write, RoleName.PORTFOLIO_MANAGER, RoleName.HUB_PLANNER
    )


async def test_write_helper_stashes_principal() -> None:
    request = _FakeRequest()
    principal = _principal(RoleName.ADMIN)
    assert await require_workflow_templates_write(request, principal) is principal
    assert request.state.principal is principal


# --- GET /me contract -------------------------------------------------------


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    get_oidc_settings.cache_clear()
    monkeypatch.setenv("RPD_OIDC_ISSUER", "https://issuer.test/realms/rpd")
    monkeypatch.setenv("RPD_OIDC_AUDIENCE", "rpd-backend")
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    yield
    get_oidc_settings.cache_clear()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.parametrize("role", list(RoleName))
async def test_me_permissions_contract_per_role(db_session, role: RoleName) -> None:
    hub = await make_hub(db_session)
    email = f"p33-{role.name.lower()}@example.com"
    if role is RoleName.HUB_PLANNER or role is RoleName.ENGINEER:
        await make_user(db_session, role, email=email, hub_scope_all=False, hub_ids=[hub.id])
    else:
        await make_user(db_session, role, email=email)

    async with _client(db_session) as client:
        resp = await client.get("/me", headers={"X-Dev-User-Email": email})
    assert resp.status_code == 200, resp.text
    perms = resp.json()["permissions"]

    assert set(perms) == {s.value for s in Surface}
    for key in ("workflow_templates", "workflow_settings"):
        read, write = _WORKFLOW_CELLS[role][key]
        assert perms[key] == {"read": read, "write": write}, (role, key)
    for key, cell in _PRE_P33[role].items():
        assert perms[key] == {"read": "r" in cell, "write": "w" in cell}, (role, key)
