"""`GET /me` and `GET /me/dev-users` (docs/API_CONTRACT_P9.md §1, ADR 0010 §2/§4)."""

from __future__ import annotations

import uuid

from pydantic import BaseModel

from models.enums import RoleName


class SurfacePermission(BaseModel):
    read: bool
    write: bool


class SurfacePermissions(BaseModel):
    """One key per `core.rbac.Surface` value, spelled out as fields (not a
    free-form dict) so the OpenAPI schema lists every surface. The frontend
    types this as `Record<SurfaceKey, SurfacePermission>`.
    """

    dashboard: SurfacePermission
    capacity: SurfacePermission
    matrix: SurfacePermission
    gantt: SurfacePermission
    project_workspace: SurfacePermission
    project_registration: SurfacePermission
    capacity_planning: SurfacePermission
    workflow_settings: SurfacePermission
    audit_log: SurfacePermission
    user_role_admin: SurfacePermission


class MeResponse(BaseModel):
    user_id: uuid.UUID
    email: str
    full_name: str
    roles: list[RoleName]
    hub_scope_all: bool
    hub_ids: list[uuid.UUID]
    engineer_id: uuid.UUID | None
    permissions: SurfacePermissions
    #: True only when the backend runs with `RPD_DEV_MODE` on.
    dev_mode: bool
    #: 2026-09-30 (P10-F03): true iff the caller has at least one direct
    #: report (`User.manager_id == caller.id`) AND at least one project
    #: where their own `effective_project_access` resolves to `"admin"` —
    #: i.e. they could actually exercise delegation
    #: (`services.project_access.can_manage_grant`) on at least something.
    #: A manager with reports but zero admin-level project access anywhere
    #: gets `False`: the Project Access tab would show them nothing useful.
    #: The frontend ORs this with the existing `user_role_admin` permission
    #: check to gate the `/admin/users` route for a non-Admin delegate
    #: manager without re-opening it for every role (P10-F03's frontend
    #: half, queued after this).
    is_delegate_manager: bool


class DevUser(BaseModel):
    email: str
    full_name: str
    roles: list[RoleName]
