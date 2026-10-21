"""Read models for the Capacity Planning surface's capacity figures
(P19-T03, docs/API_CONTRACT_P19.md §4-§6).

Every number is server-computed (I9/I19) from the ADR 0008 supply formulas
(`services.capacity_supply`) and the active run's booked steps (I6/I7). No
financial field appears anywhere here.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel

from models.enums import HubName, LabRegion, ProjectCategory, ProjectStatus, ProjectType
from schemas.capacity import YearRemaining

#: `year` = full planning year, `remaining` = the rest of it from CURRENT_WEEK.
CapacityBasis = Literal["year", "remaining"]


# --- §4 GET /planning/capacity-summary ------------------------------------------------


class DesignHubSummary(BaseModel):
    """One hub's design supply. `capacity_weeks` equals `GET /capacity/hub-load`
    `design_capacity_year` / `design_capacity_remaining` of the same hub."""

    hub: HubName
    engineer_count: int
    #: Σ fte of the hub's engineers, 2 dp (= hub-load `engineer_fte_total`).
    fte_total: float
    weekdays_per_week: float
    capacity_weeks: YearRemaining
    capacity_days: YearRemaining
    #: This hub's capacity / the total over the caller's visible hubs × 100,
    #: 2 dp; 0.0 when the total is 0. On served (2 dp) figures.
    share_pct: YearRemaining


class DesignTotal(BaseModel):
    engineer_count: int
    fte_total: float
    capacity_weeks: YearRemaining
    capacity_days: YearRemaining


class DesignSummary(BaseModel):
    hubs: list[DesignHubSummary]
    total: DesignTotal


class LabRegionSummary(BaseModel):
    """One lab region's chamber supply. `capacity_weeks` equals hub-load
    `lab_capacity_year` / `lab_capacity_remaining` of any hub of the region."""

    lab_region: LabRegion
    chamber_count: int
    weekdays_per_week: float
    capacity_weeks: YearRemaining
    capacity_days: YearRemaining
    share_pct: YearRemaining


class LabTotal(BaseModel):
    chamber_count: int
    capacity_weeks: YearRemaining
    capacity_days: YearRemaining


class LabSummary(BaseModel):
    regions: list[LabRegionSummary]
    total: LabTotal


class CapacitySummaryResponse(BaseModel):
    current_week: int
    design: DesignSummary
    lab: LabSummary


# --- §5 GET /planning/resource-load ---------------------------------------------------


class EngineerResourceLoad(BaseModel):
    """One engineer's load vs. capacity on the chosen basis. Per-engineer
    load is GDPR personal data (OQ #8, ADR 0028): every read is audit-logged."""

    engineer_id: uuid.UUID
    name: str
    hub: HubName
    weekdays_per_week: float
    #: The engineer's `capacity_weeks.<basis>` (same as `GET /engineers`).
    capacity_weeks: float
    #: Σ duration of the active run's non-skipped design-kind steps booked on
    #: this engineer, over projects matching the project filters.
    load_weeks: float
    #: load / capacity × 100, 2 dp; null when capacity is 0.
    utilization_pct: float | None
    capacity_days: float
    load_days: float


class ChamberResourceLoad(BaseModel):
    chamber_id: uuid.UUID
    code: str
    lab_region: LabRegion
    weekdays_per_week: float
    #: The chamber's `capacity_weeks.<basis>` (same as `GET /chambers`).
    capacity_weeks: float
    #: Σ duration × 1.0 of the active run's non-skipped lab-kind steps booked
    #: on this chamber, over projects matching the project filters.
    load_weeks: float
    utilization_pct: float | None
    capacity_days: float
    load_days: float


class ResourceLoadTotal(BaseModel):
    """Σ of the served rows (2 dp); `utilization_pct` on those sums."""

    capacity_weeks: float
    load_weeks: float
    utilization_pct: float | None
    capacity_days: float
    load_days: float


class ResourceLoadTotals(BaseModel):
    engineers: ResourceLoadTotal
    chambers: ResourceLoadTotal


class ResourceLoadFilters(BaseModel):
    """The filters the server applied, echoed back (lists sorted, deduplicated)."""

    hub_id: uuid.UUID | None
    region: LabRegion | None
    project_type: list[ProjectType]
    project_status: list[ProjectStatus]
    requesting_department: list[str]
    category: list[ProjectCategory]
    engineer_id: list[uuid.UUID]
    basis: CapacityBasis


class ResourceLoadResponse(BaseModel):
    has_active_schedule_run: bool
    schedule_run_version: int | None
    current_week: int
    basis: CapacityBasis
    engineers: list[EngineerResourceLoad]
    chambers: list[ChamberResourceLoad]
    totals: ResourceLoadTotals
    filters_applied: ResourceLoadFilters


# --- §6 GET /planning/resource-load/options -------------------------------------------


class EngineerOption(BaseModel):
    engineer_id: uuid.UUID
    name: str
    hub: HubName


class ResourceLoadOptions(BaseModel):
    """Values for the filter bar, from the caller's visible data only."""

    hubs: list[HubName]
    lab_regions: list[LabRegion]
    #: Distinct values present on visible projects, in enum order.
    project_types: list[ProjectType]
    project_statuses: list[ProjectStatus]
    categories: list[ProjectCategory]
    #: ADR 0035: the distinct `Project.requesting_department` values of the
    #: visible projects, sorted (the client workbook's values as written).
    requesting_departments: list[str]
    #: True when at least one visible project has a requesting department.
    requesting_department_available: bool
    engineers: list[EngineerOption]
