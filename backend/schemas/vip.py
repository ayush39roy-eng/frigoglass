"""VIP projects (docs/API_CONTRACT_P12.md §6; ADR 0022)."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict

from models.enums import HubName, ProjectPriority, WorkflowStepStatus
from schemas.category import CategoryCodeOut
from services.project_cards import CardHealth
from services.tracking import TrackingStatus

VipYear = Literal["plan", "next"]


class VipCurrentStage(BaseModel):
    step_id: str
    step_name: str
    status: WorkflowStepStatus


class VipProject(BaseModel):
    rank: int
    selection: Literal["pinned", "auto"]
    project_id: uuid.UUID
    name: str
    category: CategoryCodeOut | None
    priority: ProjectPriority | None
    score: float | None
    expected_end_week: int | None
    projected_end_week: int | None
    within_year: bool | None
    health: CardHealth | None
    progress_pct: int | None
    current_stage: VipCurrentStage | None
    tracking_status: TrackingStatus
    # --- P42 (ADR 0056, docs/API_CONTRACT_P42.md §6) ---
    #: R42-1 band label; null with no band.
    priority_label: str | None = None
    #: The active run's stored flags; null when not in the run.
    counts_toward_year: bool | None = None
    not_scheduled_priority: bool | None = None
    #: "Not scheduled (P4)" (a pinned P4/Q) or the queued text; null otherwise.
    outcome_label: str | None = None


class VipHub(BaseModel):
    hub_id: uuid.UUID
    hub: HubName
    pinned_count: int
    #: More pinned in-year projects than `limit`: all are shown, none dropped.
    over_limit: bool
    projects: list[VipProject]


class VipProjectsResponse(BaseModel):
    run_id: uuid.UUID | None
    year: VipYear
    #: Inclusive `[first_week, last_week]` of the year on the horizon.
    week_range: list[int]
    limit: int
    hubs: list[VipHub]


class VipPinRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    is_vip: bool


class VipPinResponse(BaseModel):
    project_id: uuid.UUID
    is_vip: bool
