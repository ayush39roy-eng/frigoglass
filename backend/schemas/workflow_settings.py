"""Workflow Settings (docs/API_CONTRACT_P9.md §3; ADRs 0007, 0008, 0009).

`GET /workflow-settings` returns `WorkflowSettings`, and so does every
successful `PUT`. The derived figures (`working_weeks_per_engineer`,
`working_weeks_per_chamber`, `efficient_lab_weeks`) are computed by
`services.capacity_supply`, the same code the Capacity surface uses (I17).
They are read-only here.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from models.enums import HubName, LabRegion, ProjectCategory, WorkflowStepKind


class WorkflowStepSetting(BaseModel):
    step_id: str
    code: str
    name: str
    kind: WorkflowStepKind
    sequence_order: int
    predecessor_ids: list[str]


class WorkflowSetting(BaseModel):
    id: str
    name: str
    steps: list[WorkflowStepSetting]


class LeadTimeSetting(BaseModel):
    """One lead-time row. Also the element type of the lead-times `PUT` body,
    so it forbids unknown keys.
    """

    model_config = ConfigDict(extra="forbid")

    workflow_id: str = Field(min_length=1, max_length=10)
    category: ProjectCategory
    step_id: str = Field(min_length=1, max_length=10)
    weeks: int = Field(ge=0, le=200)


class HubCalendarSetting(BaseModel):
    hub_id: uuid.UUID
    hub: HubName
    weekdays_per_week: int
    national_holiday_days: float
    medical_leave_days: float
    casual_leave_days: float
    annual_leave_days: float
    weeks_in_year: int
    #: Derived (ADR 0008), 2 dp.
    working_weeks_per_engineer: float


class ChamberSetting(BaseModel):
    chamber_id: uuid.UUID
    code: str
    lab_region: LabRegion
    platforms: int
    efficiency: float
    maintenance_weeks: float
    breakdown_weeks: float
    calibration_weeks: float
    #: Derived (ADR 0008), 2 dp.
    working_weeks_per_chamber: float
    efficient_lab_weeks: float


class WorkflowSettings(BaseModel):
    workflows: list[WorkflowSetting]
    lead_times: list[LeadTimeSetting]
    hub_calendars: list[HubCalendarSetting]
    chambers: list[ChamberSetting]
    current_week: int
    horizon_weeks: int
    within_year_week: int
    #: The time of the latest Workflow Settings audit row. Falls back to the
    #: newest template / calendar / chamber `updated_at` when there is none.
    updated_at: datetime
    #: Full name of the actor on that audit row. Account-admin data shown
    #: only to Admin / Super Admin (ADR 0010), not engineer data (OQ#8).
    updated_by: str | None


class StepPrecedenceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step_id: str = Field(min_length=1, max_length=10)
    kind: WorkflowStepKind
    predecessor_ids: list[str] = Field(max_length=14)


class StepsUpdateRequest(BaseModel):
    """All 14 steps of one workflow."""

    model_config = ConfigDict(extra="forbid")

    #: Bounded loosely; the exact "all 14, each once" rule is the router's
    #: `BAD_STEP_SET` check, so a wrong count gets that code.
    steps: list[StepPrecedenceUpdate] = Field(min_length=1, max_length=28)


class LeadTimesUpdateRequest(BaseModel):
    """Partial update: only the listed rows change."""

    model_config = ConfigDict(extra="forbid")

    lead_times: list[LeadTimeSetting] = Field(min_length=1, max_length=98)


class HubCalendarUpdateRequest(BaseModel):
    """The five editable calendar fields. `weeks_in_year` stays 52."""

    model_config = ConfigDict(extra="forbid")

    weekdays_per_week: int = Field(ge=1, le=7)
    national_holiday_days: float = Field(ge=0, le=366)
    medical_leave_days: float = Field(ge=0, le=366)
    casual_leave_days: float = Field(ge=0, le=366)
    annual_leave_days: float = Field(ge=0, le=366)


class ChamberSettingUpdateRequest(BaseModel):
    """Any subset. When `platforms` changes, `max_concurrent` is set to the
    same value, because DOMAIN_RULES "Booking rules" define
    `max_concurrent (= platform count)`.
    """

    model_config = ConfigDict(extra="forbid")

    platforms: int | None = Field(default=None, gt=0, le=100)
    efficiency: float | None = Field(default=None, gt=0, le=1)
    maintenance_weeks: float | None = Field(default=None, ge=0, le=52)
    breakdown_weeks: float | None = Field(default=None, ge=0, le=52)
    calibration_weeks: float | None = Field(default=None, ge=0, le=52)
