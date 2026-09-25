"""`Principal` — the resolved, authenticated actor, built from a validated
OIDC token's claims plus the local `models.user.User`/`Role`/`UserHubScope`
rows (see `models/user.py`'s own docstrings: "Identity comes from OIDC
(P3-T02); this table holds the application-side profile, role assignment(s)
and hub scoping used for RBAC + row-level filtering"). Authorization
(roles, hub scope) is always read from these local DB tables, never trusted
directly off IdP token claims — the IdP only establishes *who* the caller is
(`sub`/`email`), not what they're allowed to do in this application.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from models.enums import RoleName


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    email: str
    full_name: str
    oidc_subject: str
    roles: frozenset[RoleName] = field(default_factory=frozenset)

    #: True for roles that see all hubs by RBAC definition
    #: (`models.user.User.hub_scope_all`). P3-T03 must check this flag before
    #: falling back to `hub_ids`, so "scoped to zero hubs" (misconfiguration)
    #: is never silently read as "scoped to all hubs".
    hub_scope_all: bool = False
    hub_ids: frozenset[uuid.UUID] = field(default_factory=frozenset)

    def has_role(self, role: RoleName) -> bool:
        return role in self.roles
