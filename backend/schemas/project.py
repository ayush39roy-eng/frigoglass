"""Pydantic request/response models for the Project Registration surface
(`docs/PROJECT_AND_STACK.md` §2) — full CRUD on `Project`.

Financial fields (`tcogs_eur`, `selling_price_eur`, `gross_margin_pct`,
`customer_name`) are exactly CLAUDE.md's four named encrypted fields
(`models.types.FINANCIAL_FIELD_NAMES`). They round-trip through this schema
like any other field in a normal, authenticated read/write of a project a
caller is entitled to see — "never logged" (CLAUDE.md) is about audit rows
and application logs (see `services/audit_helpers.py`), not about hiding them
from an authorized API response entirely. No RBAC exists yet to decide who is
"authorized" (P3-T02/T03) — see the router module docstring for that gap.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from models.enums import ProjectCategory, ProjectPriority, ProjectStatus, ProjectType


class ProjectCreateRequest(BaseModel):
    """Only `name` and `hub_id` are required — every other field may be filled
    in later while the project sits in `Draft` (per
    `docs/PROJECT_AND_STACK.md` §2's "Hard gates enforce required fields
    before a project can leave draft status" — a Draft row must be creatable
    before those gates are satisfied, per the P1-T01 `ProjectStatus.DRAFT`
    decision). `status` is intentionally not accepted here — every new
    project starts in `Draft`; see `POST /projects/{id}/submit` to leave it.
    """

    #: `extra="forbid"` per `docs/PROJECT_AND_STACK.md` §3's "Pydantic v2
    #: (strict mode)" — an unknown field (e.g. a typo, or an attempt to set
    #: `frozen`/`status` directly) is a 422, not a silently-ignored no-op.
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=300)
    external_code: str | None = Field(default=None, max_length=100)
    hub_id: uuid.UUID
    leader_engineer_id: uuid.UUID | None = None
    category: ProjectCategory | None = None
    type: ProjectType | None = None
    priority: ProjectPriority | None = None
    actual_start_week: int | None = Field(default=None, ge=1)
    delay_weeks: int = Field(default=0, ge=0)
    reg_year: int | None = None
    carry_over: bool = False
    comments: str | None = None
    customer_name: str | None = None
    tcogs_eur: float | None = Field(default=None, ge=0)
    selling_price_eur: float | None = Field(default=None, ge=0)
    gross_margin_pct: float | None = None
    capex_keur: float | None = Field(default=None, ge=0)
    rm_savings_keur: float | None = Field(default=None, ge=0)


class ProjectUpdateRequest(BaseModel):
    """Partial update (PATCH semantics) — every field optional.

    Deliberately excludes `frozen` — the freeze toggle is a dedicated action
    on the Gantt surface (`POST /gantt/projects/{id}/freeze`,
    `api/routers/gantt.py`) with its own audit action name, per
    `docs/PROJECT_AND_STACK.md` §2's "A freeze toggle per project."

    `status` may be changed here EXCEPT to leave `Draft` — that transition
    must go through `POST /projects/{id}/submit`, which runs the hard-gate
    check. Attempting to set `status` away from `Draft` via this endpoint
    raises 400.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=300)
    external_code: str | None = None
    hub_id: uuid.UUID | None = None
    leader_engineer_id: uuid.UUID | None = None
    category: ProjectCategory | None = None
    type: ProjectType | None = None
    priority: ProjectPriority | None = None
    status: ProjectStatus | None = None
    actual_start_week: int | None = Field(default=None, ge=1)
    delay_weeks: int | None = Field(default=None, ge=0)
    reg_year: int | None = None
    carry_over: bool | None = None
    comments: str | None = None
    customer_name: str | None = None
    tcogs_eur: float | None = Field(default=None, ge=0)
    selling_price_eur: float | None = Field(default=None, ge=0)
    gross_margin_pct: float | None = None
    capex_keur: float | None = Field(default=None, ge=0)
    rm_savings_keur: float | None = Field(default=None, ge=0)


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    external_code: str | None
    hub_id: uuid.UUID
    leader_engineer_id: uuid.UUID | None
    category: ProjectCategory | None
    type: ProjectType | None
    priority: ProjectPriority | None
    status: ProjectStatus
    frozen: bool
    actual_start_week: int | None
    delay_weeks: int
    reg_year: int | None
    carry_over: bool
    comments: str | None
    customer_name: str | None
    tcogs_eur: float | None
    selling_price_eur: float | None
    gross_margin_pct: float | None
    capex_keur: float | None
    rm_savings_keur: float | None
    created_at: datetime
    updated_at: datetime


class ProjectListItem(ProjectRead):
    """Same shape as `ProjectRead` for now — kept as a distinct name so a
    future lighter-weight list projection (e.g. dropping financial fields for
    a non-financially-scoped role, per P3-T03) can diverge from the detail
    view without a breaking rename.
    """


class HardGateStatus(BaseModel):
    """Response for `GET /projects/{id}/hard-gate-status` — lets the frontend
    show which fields are still missing before a Draft project can be
    submitted, without guessing at the submit endpoint's validation rules.
    """

    can_leave_draft: bool
    missing_fields: list[str]


class ProjectSubmitRequest(BaseModel):
    """Body for `POST /projects/{id}/submit`. `target_status` defaults to
    `In Queue` — the natural first non-Draft state for a newly registered
    project (lowest scheduling-order ordinal, per `docs/DOMAIN_RULES.md`
    "Scheduling order") — but may be set explicitly to any of the four
    schedulable statuses if the caller already knows the project belongs
    further along (e.g. data migration from the spreadsheet process, P7).
    Setting it to `Draft`/`Commercialized`/`On Hold` is rejected (400) — this
    endpoint's entire purpose is leaving Draft, not re-entering it or
    jumping straight to a terminal status.
    """

    model_config = ConfigDict(extra="forbid")

    target_status: ProjectStatus = ProjectStatus.IN_QUEUE
