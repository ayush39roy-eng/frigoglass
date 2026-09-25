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
"""

from __future__ import annotations

import enum

from models.enums import RoleName


class Surface(str, enum.Enum):
    """The eight columns of `docs/PROJECT_AND_STACK.md` §5's RBAC matrix."""

    DASHBOARD = "dashboard"
    CAPACITY = "capacity"
    MATRIX = "matrix"
    GANTT = "gantt"
    PROJECT_REGISTRATION = "project_registration"
    CAPACITY_PLANNING = "capacity_planning"
    AUDIT_LOG = "audit_log"
    USER_ROLE_ADMIN = "user_role_admin"


class Action(str, enum.Enum):
    READ = "read"
    WRITE = "write"


# docs/PROJECT_AND_STACK.md §5, verbatim (wrapped to two columns per line to
# stay under this project's 100-char line length, per-file-ignores for a
# single wide Markdown-table transcription would be overkill):
#
# | Role                 | Dashboard    | Capacity        |
# |----------------------|--------------|-----------------|
# | Portfolio Manager    | R            | R               |
# | Hub Planner (scoped) | R (own hub)  | R/W (own hub)   |
# | Engineer             | -            | -               |
# | Executive Viewer     | R (all hubs) | R (all hubs)    |
# | Auditor              | -            | -               |
# | Admin                | R/W          | R/W             |
#
# | Role                 | Matrix       | Gantt           |
# |----------------------|--------------|-----------------|
# | Portfolio Manager    | R/W          | R               |
# | Hub Planner (scoped) | R (own hub)  | R/W (own hub)   |
# | Engineer             | -            | R (own asgmts)  |
# | Executive Viewer     | R (all hubs) | R (all hubs)    |
# | Auditor              | -            | -               |
# | Admin                | R/W          | R/W             |
#
# | Role                 | Project Registration | Capacity Planning |
# |----------------------|-----------------------|--------------------|
# | Portfolio Manager    | R/W                   | R                  |
# | Hub Planner (scoped) | R/W (own hub)         | R/W (own hub)      |
# | Engineer             | -                     | -                  |
# | Executive Viewer     | -                     | -                  |
# | Auditor              | -                     | -                  |
# | Admin                | R/W                   | R/W                |
#
# | Role                 | Audit Log | User/Role Admin |
# |----------------------|-----------|-----------------|
# | Portfolio Manager    | -         | -               |
# | Hub Planner (scoped) | -         | -               |
# | Engineer             | -         | -               |
# | Executive Viewer     | -         | -               |
# | Auditor              | R (all)   | -               |
# | Admin                | R         | R/W             |
#
# The "(own hub)"/"(all hubs)"/"(own assignments)" qualifiers are row-level
# scoping (P3-T03) and are intentionally NOT encoded below — this table only
# encodes the R / R/W / "-" action-level permission.
PERMISSIONS: dict[RoleName, dict[Surface, frozenset[Action]]] = {
    RoleName.PORTFOLIO_MANAGER: {
        Surface.DASHBOARD: frozenset({Action.READ}),
        Surface.CAPACITY: frozenset({Action.READ}),
        Surface.MATRIX: frozenset({Action.READ, Action.WRITE}),
        Surface.GANTT: frozenset({Action.READ}),
        Surface.PROJECT_REGISTRATION: frozenset({Action.READ, Action.WRITE}),
        Surface.CAPACITY_PLANNING: frozenset({Action.READ}),
        Surface.AUDIT_LOG: frozenset(),
        Surface.USER_ROLE_ADMIN: frozenset(),
    },
    RoleName.HUB_PLANNER: {
        Surface.DASHBOARD: frozenset({Action.READ}),
        Surface.CAPACITY: frozenset({Action.READ, Action.WRITE}),
        Surface.MATRIX: frozenset({Action.READ}),
        Surface.GANTT: frozenset({Action.READ, Action.WRITE}),
        Surface.PROJECT_REGISTRATION: frozenset({Action.READ, Action.WRITE}),
        Surface.CAPACITY_PLANNING: frozenset({Action.READ, Action.WRITE}),
        Surface.AUDIT_LOG: frozenset(),
        Surface.USER_ROLE_ADMIN: frozenset(),
    },
    RoleName.ENGINEER: {
        Surface.DASHBOARD: frozenset(),
        Surface.CAPACITY: frozenset(),
        Surface.MATRIX: frozenset(),
        Surface.GANTT: frozenset({Action.READ}),
        Surface.PROJECT_REGISTRATION: frozenset(),
        Surface.CAPACITY_PLANNING: frozenset(),
        Surface.AUDIT_LOG: frozenset(),
        Surface.USER_ROLE_ADMIN: frozenset(),
    },
    RoleName.EXECUTIVE_VIEWER: {
        Surface.DASHBOARD: frozenset({Action.READ}),
        Surface.CAPACITY: frozenset({Action.READ}),
        Surface.MATRIX: frozenset({Action.READ}),
        Surface.GANTT: frozenset({Action.READ}),
        Surface.PROJECT_REGISTRATION: frozenset(),
        Surface.CAPACITY_PLANNING: frozenset(),
        Surface.AUDIT_LOG: frozenset(),
        Surface.USER_ROLE_ADMIN: frozenset(),
    },
    RoleName.AUDITOR: {
        Surface.DASHBOARD: frozenset(),
        Surface.CAPACITY: frozenset(),
        Surface.MATRIX: frozenset(),
        Surface.GANTT: frozenset(),
        Surface.PROJECT_REGISTRATION: frozenset(),
        Surface.CAPACITY_PLANNING: frozenset(),
        Surface.AUDIT_LOG: frozenset({Action.READ}),
        Surface.USER_ROLE_ADMIN: frozenset(),
    },
    RoleName.ADMIN: {
        Surface.DASHBOARD: frozenset({Action.READ, Action.WRITE}),
        Surface.CAPACITY: frozenset({Action.READ, Action.WRITE}),
        Surface.MATRIX: frozenset({Action.READ, Action.WRITE}),
        Surface.GANTT: frozenset({Action.READ, Action.WRITE}),
        Surface.PROJECT_REGISTRATION: frozenset({Action.READ, Action.WRITE}),
        Surface.CAPACITY_PLANNING: frozenset({Action.READ, Action.WRITE}),
        Surface.AUDIT_LOG: frozenset({Action.READ}),
        Surface.USER_ROLE_ADMIN: frozenset({Action.READ, Action.WRITE}),
    },
}


def role_allows(role: RoleName, surface: Surface, action: Action) -> bool:
    return action in PERMISSIONS.get(role, {}).get(surface, frozenset())
