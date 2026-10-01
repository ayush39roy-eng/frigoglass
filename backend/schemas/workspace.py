"""Project Workspace (docs/API_CONTRACT_P9.md §7; docs/PROJECT_AND_STACK.md §2;
DOMAIN_RULES "Per-stage progress capture"; ADR 0006).

**OQ#8 withholding (docs/OPEN_QUESTIONS.md #8, P3-T09 pattern).** Every
person-name field below (`leader_engineer_name`, `assigned_engineer_name`,
`author_name`, `uploaded_by_name`, `actor_name`) is `null` unless the named
person *is the caller*. P3-T09 established that rule on the Gantt: an
engineer sees their own name, nobody sees anyone else's. The ids
(`author_user_id` etc.) are not names and stay populated. Reverse only after
DPO sign-off, in `services/workspace.py::_name_if_self`.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from models.enums import (
    HardGateReason,
    HubName,
    ProjectFileCategory,
    ProjectPriority,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from schemas.project import ProjectRead

HORIZON_MAX_WEEK = 78


class WorkspaceProject(ProjectRead):
    """`ProjectRead` + hub name + leader name. The four encrypted financial
    fields are `null` for a caller without Project Registration READ
    (Engineer, Executive Viewer). Those roles can read the workspace, but
    the §5 matrix gives them no access to the registration data the
    financials belong to.
    """

    hub: HubName
    #: OQ#8: null unless the leader is the caller.
    leader_engineer_name: str | None


#: `blocked` added in P9-R02 (DOMAIN_RULES "Gate remediation rulings" 5).
HealthBadge = Literal["on_track", "at_risk", "off_track", "left_out", "blocked", "unscheduled"]


class WorkspaceSchedule(BaseModel):
    has_active_run: bool
    run_version: int | None
    expected_end_week: int | None
    projected_end_week: int | None
    unconstrained_end_week: int | None
    slip_weeks: int | None
    within_year: bool | None
    left_out: bool
    schedule_stale: bool


class WorkspaceStage(BaseModel):
    step_id: str
    code: str
    name: str
    kind: WorkflowStepKind
    sequence_order: int
    predecessor_ids: list[str]
    duration_weeks: int
    skipped: bool
    #: From the active run's step row (I13), not recomputed.
    planned_start_week: int | None
    planned_end_week: int | None
    actual_start_week: int | None
    actual_end_week: int | None
    status: WorkflowStepStatus
    percent_complete: int
    #: DOMAIN_RULES "Derived remaining duration"; 0 for a skipped step.
    remaining_weeks: int
    remaining_weeks_override: int | None
    blocked_reason: str | None
    #: OQ#8: null unless the assigned engineer is the caller.
    assigned_engineer_name: str | None
    assigned_chamber_code: str | None
    #: Weeks the stage runs past its lead-time duration in the active run:
    #: `(actual_end_week or run end) − (run start + duration − 1)`, floored at
    #: 0. Null for a skipped step or when the run has no row for it.
    overrun_weeks: int | None


class WorkspacePriorityScore(BaseModel):
    strategic_project: int
    new_customer: int
    new_options: int
    regulatory_compliance: int
    quality_improvements: int
    rm_savings: int
    total_rm_savings: int
    gross_margins: int
    profitability: int
    annual_volume: int
    three_year_volume: int
    new_models: int
    capex_investment: int
    hard_gates: list[HardGateReason]
    weighted_score: float | None
    normalized_pct: int | None
    suggested_band: ProjectPriority | None


class FileRead(BaseModel):
    id: uuid.UUID
    display_name: str
    category: ProjectFileCategory
    description: str | None
    version: int
    size_bytes: int
    content_type: str
    #: OQ#8: null unless the uploader is the caller.
    uploaded_by_name: str | None
    created_at: datetime


class FileUpdateRequest(BaseModel):
    """`display_name` renames every version of the document. `category` and
    `description` apply to this version only.
    """

    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    category: ProjectFileCategory | None = None
    description: str | None = Field(default=None, max_length=2000)


class CommentRead(BaseModel):
    id: uuid.UUID
    #: The raw Markdown. The frontend renders it with its own safe renderer
    #: (React elements only). P9-R02 removed the server-rendered
    #: `body_html_sanitized` (security S-02: re-rendering on every read could
    #: stall the event loop, and no consumer used it).
    body_md: str
    #: OQ#8: null unless the author is the caller.
    author_name: str | None
    author_user_id: uuid.UUID
    created_at: datetime
    edited_at: datetime | None
    #: True only for the author, within 15 minutes of creation.
    can_edit: bool
    #: Always empty while OQ#8 is open (mentions are not resolved).
    mentioned_user_ids: list[uuid.UUID]


class CommentCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body_md: str = Field(min_length=1, max_length=10000)


class CommentUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body_md: str = Field(min_length=1, max_length=10000)


class ActivityComment(BaseModel):
    kind: Literal["comment"] = "comment"
    comment: CommentRead


class ActivityEvent(BaseModel):
    kind: Literal["event"] = "event"
    id: uuid.UUID
    occurred_at: datetime
    #: OQ#8: null unless the actor is the caller.
    actor_name: str | None
    summary: str
    audit_entry_id: uuid.UUID


ActivityItem = Annotated[ActivityComment | ActivityEvent, Field(discriminator="kind")]


class WorkspaceRead(BaseModel):
    project: WorkspaceProject
    health: HealthBadge
    schedule: WorkspaceSchedule
    #: Duration-weighted roll-up (I12).
    progress_pct: int | None
    stages: list[WorkspaceStage]
    priority_score: WorkspacePriorityScore | None
    files: list[FileRead]
    #: The latest 50 items, newest first. Page with `GET …/activity`.
    activity: list[ActivityItem]


class StageUpdateRequest(BaseModel):
    """Any subset. The merged row must satisfy DOMAIN_RULES "Per-stage
    progress fields". A violation is a 422 with field errors.
    """

    model_config = ConfigDict(extra="forbid")

    status: WorkflowStepStatus | None = None
    percent_complete: int | None = Field(default=None, ge=0, le=100)
    actual_start_week: int | None = Field(default=None, ge=1, le=HORIZON_MAX_WEEK)
    actual_end_week: int | None = Field(default=None, ge=1, le=HORIZON_MAX_WEEK)
    remaining_weeks_override: int | None = Field(default=None, ge=0, le=HORIZON_MAX_WEEK)
    blocked_reason: str | None = Field(default=None, max_length=2000)


class RecalculateResponse(BaseModel):
    schedule_run_id: uuid.UUID
    task_id: str
