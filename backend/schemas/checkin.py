"""Weekly check-in (docs/API_CONTRACT_P12.md §5; ADR 0021, ADR 0023).

Requests are strict with unknown keys rejected. `project_id` and `status`
opt out of strict mode only because a strict UUID / enum accepts an instance,
never its JSON string; lax validation still rejects anything that is not a
UUID or one of the four stage statuses.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from models.checkin import CHECKIN_NOTE_MAX_LENGTH
from models.enums import HubName, WorkflowStepKind, WorkflowStepStatus
from services.tracking import TrackingStatus

#: At most this many stages in one submission (contract §5).
CHECKIN_MAX_ENTRIES = 100
#: Same ceiling as a Workspace hold reason is stored in (`Text`), bounded
#: here so one request cannot carry megabytes of free text.
BLOCKED_REASON_MAX_LENGTH = 2000

CheckInRecalcStatus = Literal["queued", "deferred", "not_needed"]
CheckInErrorCode = Literal[
    "NOT_DUE",
    "FORBIDDEN_STAGE",
    "STEP_DONE_IMMUTABLE",
    "INCONSISTENT_PROGRESS",
    "PROJECT_FROZEN",
    "DUPLICATE_STAGE",
]


class CheckInEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    project_id: uuid.UUID = Field(strict=False)
    step_id: str = Field(min_length=1, max_length=10)
    status: WorkflowStepStatus = Field(strict=False)
    percent_complete: int = Field(ge=0, le=100)
    blocked_reason: str | None = Field(default=None, max_length=BLOCKED_REASON_MAX_LENGTH)
    note: str | None = Field(default=None, max_length=CHECKIN_NOTE_MAX_LENGTH)


class CheckInRequest(BaseModel):
    """One week's batch (1..100 entries). Atomic: one bad entry fails all."""

    model_config = ConfigDict(extra="forbid", strict=True)

    entries: list[CheckInEntry] = Field(min_length=1, max_length=CHECKIN_MAX_ENTRIES)


class CheckInResponse(BaseModel):
    """`recalc_status` follows the priority-move lifecycle (ADR 0023 §1);
    `schedule_run_id` / `task_id` only when `queued`, `baseline_run_id` only
    when `queued` and a run was active.
    """

    week: int
    accepted: int
    projects_marked_stale: list[uuid.UUID]
    recalc_status: CheckInRecalcStatus
    schedule_run_id: uuid.UUID | None
    baseline_run_id: uuid.UUID | None
    task_id: str | None


class CheckInEntryError(BaseModel):
    """One element of `detail.errors` on a 422 `CHECKIN_INVALID`."""

    index: int
    code: CheckInErrorCode
    message: str


class CheckInDueStage(BaseModel):
    step_id: str
    step_name: str
    kind: WorkflowStepKind
    status: WorkflowStepStatus
    percent_complete: int
    blocked_reason: str | None
    planned_start_week: int | None
    planned_end_week: int | None
    #: Share of the planned window elapsed at CURRENT_WEEK, 0..100 (ADR 0021
    #: §5). Null when the stage has no planned window in the active run.
    plan_percent: int | None
    checked_in_this_week: bool
    last_checkin_week: int | None
    can_check_in: bool


class CheckInDueProject(BaseModel):
    project_id: uuid.UUID
    name: str
    hub: HubName
    hub_id: uuid.UUID
    tracking_status: TrackingStatus
    schedule_stale: bool
    stages: list[CheckInDueStage]


class CheckInDueSummary(BaseModel):
    due_stages: int
    checked_in_stages: int
    projects_live: int
    projects_due: int
    projects_overdue: int
    stale_projects: int


class CheckInDueResponse(BaseModel):
    week: int
    summary: CheckInDueSummary
    projects: list[CheckInDueProject]


class CheckInHistoryRow(BaseModel):
    week: int
    status: WorkflowStepStatus
    percent_complete: int
    blocked_reason: str | None
    note: str | None
    #: The submitter's full name, shown only on the stage's own history
    #: (ADR 0021 §7). Never aggregated per engineer.
    by: str
    created_at: datetime
