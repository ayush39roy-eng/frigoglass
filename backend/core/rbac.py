"""Action-level RBAC permission table — "for a given role, is this HTTP verb
on this surface allowed at all" — per `docs/PROJECT_AND_STACK.md` §5's
role/permission matrix, reproduced verbatim in the comment above `PERMISSIONS`
below so the two can be diffed by eye.

**Scope boundary (P3-T02 vs P3-T03)**: the matrix's "(own hub)" / "(all
hubs)" qualifiers describe row-level *data* scoping — that is P3-T03's job,
not this module's. This module only answers the coarser question: given a
role, can it perform this action on this surface *at all*, ignoring which
rows it would see. `api/deps.py`'s `Principal` (returned by every
`require_permission`/`require_roles` dependency) carries `hub_scope_all` +
`hub_ids` precisely so P3-T03 can compose hub-scoped `.where(...)` filtering
on top of this without re-deriving the role->permission mapping here.

**2026-09-27 (ADR 0010, P9-T01)**: `Super Admin` row and the `Project
Workspace` / `Workflow Settings` columns added. Super Admin has READ + WRITE
on every surface except the Audit Log, which is READ only for every role by
construction — it is an immutable append-only log that no principal writes
through the API (the DB trigger `trg_audit_log_entries_append_only` refuses
UPDATE/DELETE); the §5 matrix says `R` there for Super Admin and this table
follows the matrix.
"""

from __future__ import annotations

import enum

from models.enums import RoleName


class Surface(str, enum.Enum):
    """The ten columns of `docs/PROJECT_AND_STACK.md` §5's RBAC matrix."""

    DASHBOARD = "dashboard"
    CAPACITY = "capacity"
    MATRIX = "matrix"
    GANTT = "gantt"
    PROJECT_WORKSPACE = "project_workspace"
    PROJECT_REGISTRATION = "project_registration"
    CAPACITY_PLANNING = "capacity_planning"
    WORKFLOW_SETTINGS = "workflow_settings"
    AUDIT_LOG = "audit_log"
    USER_ROLE_ADMIN = "user_role_admin"


class Action(str, enum.Enum):
    READ = "read"
    WRITE = "write"


# docs/PROJECT_AND_STACK.md §5, verbatim (wrapped to two columns per line to
# stay under this project's 100-char line length):
#
# | Role                 | Dashboard    | Capacity        |
# |----------------------|--------------|-----------------|
# | Portfolio Manager    | R            | R               |
# | Hub Planner (scoped) | R (own hub)  | R/W (own hub)   |
# | Engineer             | -            | -               |
# | Executive Viewer     | R (all hubs) | R (all hubs)    |
# | Auditor              | -            | -               |
# | Admin                | R/W          | R/W             |
# | Super Admin          | R/W          | R/W             |
#
# | Role                 | Matrix       | Gantt           |
# |----------------------|--------------|-----------------|
# | Portfolio Manager    | R/W          | R               |
# | Hub Planner (scoped) | R (own hub)  | R/W (own hub)   |
# | Engineer             | -            | R (own asgmts)  |
# | Executive Viewer     | R (all hubs) | R (all hubs)    |
# | Auditor              | -            | -               |
# | Admin                | R/W          | R/W             |
# | Super Admin          | R/W          | R/W             |
#
# | Role                 | Project Workspace | Project Registration |
# |----------------------|-------------------|----------------------|
# | Portfolio Manager    | R/W               | R/W                  |
# | Hub Planner (scoped) | R/W (own hub)     | R/W (own hub)        |
# | Engineer             | R (own asgmts)    | -                    |
# | Executive Viewer     | R (all hubs)      | -                    |
# | Auditor              | -                 | -                    |
# | Admin                | R/W               | R/W                  |
# | Super Admin          | R/W               | R/W                  |
#
# | Role                 | Capacity Planning | Workflow Settings |
# |----------------------|-------------------|-------------------|
# | Portfolio Manager    | R                 | -                 |
# | Hub Planner (scoped) | R/W (own hub)     | -                 |
# | Engineer             | -                 | -                 |
# | Executive Viewer     | -                 | -                 |
# | Auditor              | -                 | -                 |
# | Admin                | R/W               | R                 |
# | Super Admin          | R/W               | R/W               |
#
# | Role                 | Audit Log | User/Role Admin      |
# |----------------------|-----------|----------------------|
# | Portfolio Manager    | -         | -                    |
# | Hub Planner (scoped) | -         | -                    |
# | Engineer             | -         | -                    |
# | Executive Viewer     | -         | -                    |
# | Auditor              | R (all)   | -                    |
# | Admin                | R         | R/W (non-admin roles)|
# | Super Admin          | R         | R/W (all roles)      |
#
# The "(own hub)"/"(all hubs)"/"(own assignments)"/"(non-admin roles)"
# qualifiers are row-level scoping (P3-T03; the admin-role restriction is
# P9-T03's user-admin endpoints) and are intentionally NOT encoded below —
# this table only encodes the R / R/W / "-" action-level permission.

_R = frozenset({Action.READ})
_RW = frozenset({Action.READ, Action.WRITE})
_NONE: frozenset[Action] = frozenset()

PERMISSIONS: dict[RoleName, dict[Surface, frozenset[Action]]] = {
    RoleName.PORTFOLIO_MANAGER: {
        Surface.DASHBOARD: _R,
        Surface.CAPACITY: _R,
        Surface.MATRIX: _RW,
        Surface.GANTT: _R,
        Surface.PROJECT_WORKSPACE: _RW,
        Surface.PROJECT_REGISTRATION: _RW,
        Surface.CAPACITY_PLANNING: _R,
        Surface.WORKFLOW_SETTINGS: _NONE,
        Surface.AUDIT_LOG: _NONE,
        Surface.USER_ROLE_ADMIN: _NONE,
    },
    RoleName.HUB_PLANNER: {
        Surface.DASHBOARD: _R,
        Surface.CAPACITY: _RW,
        Surface.MATRIX: _R,
        Surface.GANTT: _RW,
        Surface.PROJECT_WORKSPACE: _RW,
        Surface.PROJECT_REGISTRATION: _RW,
        Surface.CAPACITY_PLANNING: _RW,
        Surface.WORKFLOW_SETTINGS: _NONE,
        Surface.AUDIT_LOG: _NONE,
        Surface.USER_ROLE_ADMIN: _NONE,
    },
    RoleName.ENGINEER: {
        Surface.DASHBOARD: _NONE,
        Surface.CAPACITY: _NONE,
        Surface.MATRIX: _NONE,
        Surface.GANTT: _R,
        Surface.PROJECT_WORKSPACE: _R,
        Surface.PROJECT_REGISTRATION: _NONE,
        Surface.CAPACITY_PLANNING: _NONE,
        Surface.WORKFLOW_SETTINGS: _NONE,
        Surface.AUDIT_LOG: _NONE,
        Surface.USER_ROLE_ADMIN: _NONE,
    },
    RoleName.EXECUTIVE_VIEWER: {
        Surface.DASHBOARD: _R,
        Surface.CAPACITY: _R,
        Surface.MATRIX: _R,
        Surface.GANTT: _R,
        Surface.PROJECT_WORKSPACE: _R,
        Surface.PROJECT_REGISTRATION: _NONE,
        Surface.CAPACITY_PLANNING: _NONE,
        Surface.WORKFLOW_SETTINGS: _NONE,
        Surface.AUDIT_LOG: _NONE,
        Surface.USER_ROLE_ADMIN: _NONE,
    },
    RoleName.AUDITOR: {
        Surface.DASHBOARD: _NONE,
        Surface.CAPACITY: _NONE,
        Surface.MATRIX: _NONE,
        Surface.GANTT: _NONE,
        Surface.PROJECT_WORKSPACE: _NONE,
        Surface.PROJECT_REGISTRATION: _NONE,
        Surface.CAPACITY_PLANNING: _NONE,
        Surface.WORKFLOW_SETTINGS: _NONE,
        Surface.AUDIT_LOG: _R,
        Surface.USER_ROLE_ADMIN: _NONE,
    },
    RoleName.ADMIN: {
        Surface.DASHBOARD: _RW,
        Surface.CAPACITY: _RW,
        Surface.MATRIX: _RW,
        Surface.GANTT: _RW,
        Surface.PROJECT_WORKSPACE: _RW,
        Surface.PROJECT_REGISTRATION: _RW,
        Surface.CAPACITY_PLANNING: _RW,
        Surface.WORKFLOW_SETTINGS: _R,
        Surface.AUDIT_LOG: _R,
        Surface.USER_ROLE_ADMIN: _RW,
    },
    RoleName.SUPER_ADMIN: {
        Surface.DASHBOARD: _RW,
        Surface.CAPACITY: _RW,
        Surface.MATRIX: _RW,
        Surface.GANTT: _RW,
        Surface.PROJECT_WORKSPACE: _RW,
        Surface.PROJECT_REGISTRATION: _RW,
        Surface.CAPACITY_PLANNING: _RW,
        Surface.WORKFLOW_SETTINGS: _RW,
        Surface.AUDIT_LOG: _R,
        Surface.USER_ROLE_ADMIN: _RW,
    },
}


def role_allows(role: RoleName, surface: Surface, action: Action) -> bool:
    return action in PERMISSIONS.get(role, {}).get(surface, frozenset())
