"""Pure unit tests for `core.rbac.role_allows` against
`docs/PROJECT_AND_STACK.md` §5's role/permission matrix, transcribed verbatim
in the test data below so a reviewer can diff this against the doc table by
eye, independent of `core/rbac.py`'s own internal representation.
"""

from __future__ import annotations

import pytest

from core.rbac import Action, Surface, role_allows
from models.enums import RoleName

R = Action.READ
W = Action.WRITE

# role -> surface -> set of allowed actions (empty set == "-" in the matrix).
_MATRIX: dict[RoleName, dict[Surface, set[Action]]] = {
    RoleName.PORTFOLIO_MANAGER: {
        Surface.DASHBOARD: {R},
        Surface.CAPACITY: {R},
        Surface.MATRIX: {R, W},
        Surface.GANTT: {R},
        Surface.PROJECT_REGISTRATION: {R, W},
        Surface.CAPACITY_PLANNING: {R},
        Surface.AUDIT_LOG: set(),
        Surface.USER_ROLE_ADMIN: set(),
    },
    RoleName.HUB_PLANNER: {
        Surface.DASHBOARD: {R},
        Surface.CAPACITY: {R, W},
        Surface.MATRIX: {R},
        Surface.GANTT: {R, W},
        Surface.PROJECT_REGISTRATION: {R, W},
        Surface.CAPACITY_PLANNING: {R, W},
        Surface.AUDIT_LOG: set(),
        Surface.USER_ROLE_ADMIN: set(),
    },
    RoleName.ENGINEER: {
        Surface.DASHBOARD: set(),
        Surface.CAPACITY: set(),
        Surface.MATRIX: set(),
        Surface.GANTT: {R},
        Surface.PROJECT_REGISTRATION: set(),
        Surface.CAPACITY_PLANNING: set(),
        Surface.AUDIT_LOG: set(),
        Surface.USER_ROLE_ADMIN: set(),
    },
    RoleName.EXECUTIVE_VIEWER: {
        Surface.DASHBOARD: {R},
        Surface.CAPACITY: {R},
        Surface.MATRIX: {R},
        Surface.GANTT: {R},
        Surface.PROJECT_REGISTRATION: set(),
        Surface.CAPACITY_PLANNING: set(),
        Surface.AUDIT_LOG: set(),
        Surface.USER_ROLE_ADMIN: set(),
    },
    RoleName.AUDITOR: {
        Surface.DASHBOARD: set(),
        Surface.CAPACITY: set(),
        Surface.MATRIX: set(),
        Surface.GANTT: set(),
        Surface.PROJECT_REGISTRATION: set(),
        Surface.CAPACITY_PLANNING: set(),
        Surface.AUDIT_LOG: {R},
        Surface.USER_ROLE_ADMIN: set(),
    },
    RoleName.ADMIN: {
        Surface.DASHBOARD: {R, W},
        Surface.CAPACITY: {R, W},
        Surface.MATRIX: {R, W},
        Surface.GANTT: {R, W},
        Surface.PROJECT_REGISTRATION: {R, W},
        Surface.CAPACITY_PLANNING: {R, W},
        Surface.AUDIT_LOG: {R},
        Surface.USER_ROLE_ADMIN: {R, W},
    },
}


@pytest.mark.parametrize("role", list(RoleName))
def test_role_allows_matches_matrix_exactly(role: RoleName) -> None:
    for surface in Surface:
        expected = _MATRIX[role][surface]
        for action in Action:
            assert role_allows(role, surface, action) == (action in expected), (
                f"{role}/{surface}/{action} mismatch"
            )


def test_every_role_and_surface_is_covered_by_the_permissions_table() -> None:
    """Guards against a future `RoleName`/`Surface` enum addition silently
    having no entry in `core.rbac.PERMISSIONS` (which would make
    `role_allows` default to `frozenset()` — deny-by-default, safe, but
    silent) — this test would fail loudly instead, forcing whoever adds the
    new role/surface to also update the matrix.
    """
    from core.rbac import PERMISSIONS

    assert set(PERMISSIONS.keys()) == set(RoleName)
    for role, surfaces in PERMISSIONS.items():
        assert set(surfaces.keys()) == set(Surface), f"{role} missing a surface entry"
