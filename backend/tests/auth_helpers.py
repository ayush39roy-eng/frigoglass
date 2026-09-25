"""Shared test helper for overriding `api.deps.get_current_principal`.

Overriding this single inner dependency (rather than each router's own
`require_permission(...)`/`require_roles(...)` instance) lets a test supply a
fake, already-"authenticated" `Principal` with whatever roles/hub-scope it
wants, while still exercising the REAL `core.rbac` permission-check logic in
`require_permission`/`require_any_permission`/`require_roles` (those
dependencies call `Depends(get_current_principal)` internally; FastAPI's
`dependency_overrides` matches by the callable object, so overriding
`get_current_principal` here transparently overrides it everywhere it's used,
across every router).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable

from api.deps import get_current_principal
from api.main import app
from core.principal import Principal
from models.enums import RoleName


def make_principal(
    *roles: RoleName,
    user_id: uuid.UUID | None = None,
    email: str = "test.user@example.com",
    hub_scope_all: bool = True,
    hub_ids: Iterable[uuid.UUID] = (),
) -> Principal:
    return Principal(
        user_id=user_id or uuid.uuid4(),
        email=email,
        full_name="Test User",
        oidc_subject="test-subject",
        roles=frozenset(roles),
        hub_scope_all=hub_scope_all,
        hub_ids=frozenset(hub_ids),
    )


def override_current_principal(principal: Principal) -> None:
    async def _override() -> Principal:
        return principal

    app.dependency_overrides[get_current_principal] = _override


def clear_current_principal_override() -> None:
    app.dependency_overrides.pop(get_current_principal, None)
