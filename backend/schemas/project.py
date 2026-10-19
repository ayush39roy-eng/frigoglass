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
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from models.enums import HubName, ProjectCategory, ProjectPriority, ProjectStatus, ProjectType


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
    # --- P9 (docs/API_CONTRACT_P9.md §6) ---------------------------------
    #: Charter "Project End Date - LATEST" as a week number (DOMAIN_RULES
    #: "Expected vs projected completion").
    target_end_week: int | None = Field(default=None, ge=1, le=520)
    #: When false, every lab-kind step is skipped (ADR 0007).
    certification_testing_required: bool = True
    #: Capacity "Estimated" column only; never a schedule input (OQ #12).
    estimated_design_weeks: float | None = Field(default=None, ge=0, le=9999.99)
    estimated_lab_weeks: float | None = Field(default=None, ge=0, le=9999.99)


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
    target_end_week: int | None = Field(default=None, ge=1, le=520)
    certification_testing_required: bool | None = None
    estimated_design_weeks: float | None = Field(default=None, ge=0, le=9999.99)
    estimated_lab_weeks: float | None = Field(default=None, ge=0, le=9999.99)


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
    target_end_week: int | None
    certification_testing_required: bool
    estimated_design_weeks: float | None
    estimated_lab_weeks: float | None
    #: Progress or settings changed since the active run (ADR 0006).
    schedule_stale: bool
    #: "PDD" | "OEM", a function of the hub (ADR 0007).
    workflow_id: Literal["PDD", "OEM"]
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
    jumping straight to a terminal status. `Cancelled` (P9) is rejected the
    same way.
    """

    model_config = ConfigDict(extra="forbid")

    target_status: ProjectStatus = ProjectStatus.IN_QUEUE


#: ADR 0015: what a priority move did to the schedule.
#: - `queued`: a greedy run was dispatched (follow it on the SSE stream);
#: - `deferred`: another run was queued or running; the project stays stale;
#: - `not_needed`: the project's status is not schedulable;
#: - `unchanged`: the requested priority equals the current one; nothing written.
#: P14 (ADR 0026): `applied` = a confirm with a current `preview_token`; the
#: greedy run was computed in-process and is already active.
#: P14-T01 (M3): `dispatch_failed` = the change is saved and the project stays
#: stale, but the broker refused the run (row FAILED, `DISPATCH_FAILED`).
RecalcStatus = Literal[
    "queued", "deferred", "not_needed", "unchanged", "applied", "dispatch_failed"
]


class PriorityMoveRequest(BaseModel):
    """Body for `POST /projects/{id}/priority` (docs/API_CONTRACT_P11.md §1).

    Strict, unknown keys rejected. `priority` alone opts out of strict mode
    because a strict enum field only accepts an enum *instance*, never its
    JSON string. Lax enum validation still accepts only the five values
    (P1–P4, Q); `null`, numbers and other strings are a 422.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    priority: ProjectPriority = Field(strict=False)
    #: P14 (ADR 0026 §2): from `POST /projects/{id}/priority/preview`. With
    #: a current token the move is applied in-process (`applied`); a stale
    #: one is 409 `PREVIEW_STALE`. Absent: ADR 0015 behaviour, unchanged.
    preview_token: str | None = Field(default=None, min_length=16, max_length=128)


class PriorityPreviewRequest(BaseModel):
    """Body for `POST /projects/{id}/priority/preview` (P14 contract §1)."""

    model_config = ConfigDict(extra="forbid", strict=True)

    priority: ProjectPriority = Field(strict=False)


PriorityPreviewResult = Literal["preview", "unchanged", "not_needed"]


class PriorityPreviewMoved(BaseModel):
    """The moved project's own outcome: `before` from the active run (null
    when there is none, or the project has no outcome row in it), `after`
    from the preview (or the applied run)."""

    end_week_before: int | None
    end_week_after: int | None
    within_year_before: bool | None
    within_year_after: bool | None
    left_out_before: bool | None
    left_out_after: bool | None


class PriorityPreviewSummary(BaseModel):
    """Counts over the listed (in-scope) `changes` rows. Out-of-scope rows
    are only in `hidden_count`."""

    affected: int
    #: `end_week_after > end_week_before` (both set).
    delayed: int
    #: `end_week_after < end_week_before` (both set).
    earlier: int
    #: within year before, not after.
    pushed_out_of_year: int
    #: not within year before, within after.
    pulled_into_year: int


class PriorityPreviewChange(BaseModel):
    """One *other* project whose `projected_end_week`, `within_year`,
    `left_out` or `blocked` differs (the ADR 0015 §4 comparison,
    `services.run_changes`). A side with no outcome row reads null/false."""

    project_id: uuid.UUID
    name: str
    hub: HubName
    priority: ProjectPriority | None
    end_week_before: int | None
    end_week_after: int | None
    within_year_before: bool
    within_year_after: bool
    left_out_before: bool
    left_out_after: bool
    blocked_before: bool
    blocked_after: bool


class PriorityPreviewResponse(BaseModel):
    """P14 contract §1. Writes nothing. `changes` ordered: pushed out of the
    year first, then the largest delay, then name.

    - `unchanged`: same priority; `preview_token`, `moved` null.
    - `not_needed`: non-schedulable status; no greedy pass, `changes` empty,
      `moved` null, but `preview_token` is set (the confirm checks it).
    - no active run: `baseline_run_id` null, `changes` empty, `note` set.
    """

    result: PriorityPreviewResult
    project_id: uuid.UUID
    from_priority: ProjectPriority | None
    to_priority: ProjectPriority
    baseline_run_id: uuid.UUID | None
    preview_token: str | None
    moved: PriorityPreviewMoved | None
    summary: PriorityPreviewSummary
    changes: list[PriorityPreviewChange]
    hidden_count: int
    #: Wall time of the snapshot build plus the greedy pass; null when no
    #: pass ran.
    elapsed_ms: int | None
    note: str | None = None


class PriorityMoveResponse(BaseModel):
    """Always 200; `recalc_status` says what happened (ADR 0015).

    `schedule_run_id` and `task_id` are set only when `queued`.
    `baseline_run_id` is the run that was active before the move, set only
    when `queued` and a run was active; pass it as `against` to
    `GET /schedule-runs/{schedule_run_id}/changes` once the run completes.
    """

    project_id: uuid.UUID
    priority_before: ProjectPriority | None
    priority_after: ProjectPriority
    recalc_status: RecalcStatus
    schedule_run_id: uuid.UUID | None
    baseline_run_id: uuid.UUID | None
    task_id: str | None
    #: P14 (ADR 0026): set on `applied` only, computed from the two persisted
    #: runs through `services.run_changes`; the same shapes as the preview.
    moved: PriorityPreviewMoved | None = None
    summary: PriorityPreviewSummary | None = None
    changes: list[PriorityPreviewChange] = Field(default_factory=list)
    hidden_count: int = 0
