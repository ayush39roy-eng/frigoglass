"""`GET /me`, `GET /me/dev-users` (docs/API_CONTRACT_P9.md §1, ADR 0010 §2/§4) and
`POST /me/dev-login` (ADR 0058 L1)."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

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
    #: P33-T06 (ADR 0045 §7, docs/API_CONTRACT_P33.md Part A): category
    #: templates. Admin and Super Admin RW, every other role none.
    workflow_templates: SurfacePermission
    audit_log: SurfacePermission
    user_role_admin: SurfacePermission


class PlanWeek(BaseModel):
    """API_CONTRACT_P37 §1. `current` ⇔ `run_week == current_week` (R37-6).
    `recalculating`: a run is queued or running. `pending`: the weeks differ
    and nothing is in flight. `failed`: the week's rollover attempts are
    spent (P37-T05)."""

    run_week: int
    run_version: int
    status: Literal["current", "recalculating", "pending", "failed"]


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
    #: P13-T15, source changed at P37-T04 (ADR 0052, API_CONTRACT_P37 §1): the
    #: calendar week (`services.plan_clock`, Europe/Athens, or the
    #: `RPD_CURRENT_WEEK` pin) and `52 − current_week` (the current week not
    #: counted, OQ #91). For the header "Week N · M wks left".
    current_week: int = Field(ge=1, le=52)
    weeks_left_in_year: int = Field(ge=0, le=51)
    #: P37-T04: today's date in Europe/Athens (the header shows it, never the
    #: browser's date).
    as_of_date: date
    #: P37-T04: `RPD_PLAN_YEAR` (default 2026).
    plan_year: int
    #: P37-T04: the ISO week-year is later than `plan_year`; `current_week` is
    #: then 52 and `POST /check-ins` answers 409 `PLAN_YEAR_CLOSED` (R37-10).
    plan_year_closed: bool
    #: P37-T04: `"pinned"` when `RPD_CURRENT_WEEK` is set.
    week_source: Literal["calendar", "pinned"]
    #: P37-T04: the next Monday 00:00 Europe/Athens; the client refetches then.
    week_ends_at: datetime
    #: P37-T04: the active run's week against the calendar week; null when
    #: there is no active run (R37-7).
    plan_week: PlanWeek | None


class DevUser(BaseModel):
    email: str
    full_name: str
    roles: list[RoleName]


class DevLoginRequest(BaseModel):
    """`POST /me/dev-login` (ADR 0058 L1). `username` is `superadmin` /
    `admin` or the account's full email. No length or format constraint
    here on purpose: every wrong value is the router's one generic 401, so
    a validation error never echoes the password back."""

    model_config = ConfigDict(extra="forbid")

    username: str
    password: str
