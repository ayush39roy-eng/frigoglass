"""Read models for the RPD Capacity surface (`docs/PROJECT_AND_STACK.md` §2).

Load figures are sourced from the active `ScheduleRun`'s snapshot
(`ScheduleRunProjectStep`), per Invariants I6/I7 ("must reconcile with the
Capacity surface"). Since P9-T03 the *supply* figures are the client's
formulas (docs/DOMAIN_RULES.md "Capacity supply", ADR 0008), computed by
`services.capacity_supply` (I17). They are reporting figures; downtime does
not gate week-level booking. FTE gates design speed (ADR 0032, superseding
ADR 0002), but load stays in effort weeks (`duration_weeks`), so supply and
load remain comparable.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field

from models.enums import HubName, LabRegion, ProjectCategory

#: ADR 0016 §2. Server-derived; the browser renders it and never re-derives it.
BookingStatus = Literal["available", "near_full", "full"]
#: ADR 0016 §3. A function of the lab region: Greece and Romania → Europe,
#: India → India (OEM hubs included, docs/OPEN_QUESTIONS.md #26).
CapacityAreaName = Literal["Europe", "India"]


class YearRemaining(BaseModel):
    """P19-T03 (docs/API_CONTRACT_P19.md): one figure on both bases, 2 dp.
    `year` = the full planning year, `remaining` = the rest of it from
    `CURRENT_WEEK` (ADR 0008 remaining formulas). A load has no basis of its
    own, so a load pair carries the same value twice."""

    year: float
    remaining: float


class PriorityLoadSplit(BaseModel):
    """P13 (docs/API_CONTRACT_P13.md §6): a load split by priority bucket, in
    weeks, 2 dp. `P1`..`P4` are the project's priority band; `Queue` is band
    `Q` or a null priority (`services.capacity_priority.priority_bucket`).
    The five values sum to the load they split (to 2 dp)."""

    P1: float
    P2: float
    P3: float
    P4: float
    Queue: float


class PriorityCountSplit(BaseModel):
    """P13 (§6): a project count split by the same priority buckets as
    `PriorityLoadSplit`. The five values sum to the count they split."""

    P1: int
    P2: int
    P3: int
    P4: int
    Queue: int


class CapacityChamberRow(BaseModel):
    """One chamber's supply inputs and derived figures (ADR 0008), 2 dp."""

    chamber_id: uuid.UUID
    code: str
    platforms: int
    efficiency: float
    working_weeks_per_chamber: float
    efficient_lab_weeks: float


class HubCapacityRow(BaseModel):
    """One hub's load vs. supply (docs/API_CONTRACT_P9.md §4, ADR 0008).

    Load (Invariants I6/I7), from the active `ScheduleRun`:
    - `design_load_weeks`: Σ design-kind step durations of this hub's projects.
    - `lab_load_weeks`: Σ lab-kind step durations × 1.0 over every project of
      this hub's *lab region*. Region-level, repeated on each hub of the region.
    - `*_estimated_weeks`: Σ the projects' hand-entered estimates
      (`Project.estimated_*_weeks`, docs/OPEN_QUESTIONS.md #12). Taken over
      schedulable projects; lab estimates only count projects with
      `certification_testing_required`, like the process-derived lab load.

    Supply (DOMAIN_RULES "Capacity supply", `services.capacity_supply`): the
    `design_*` figures are per hub and the `lab_*` figures are per region.
    `gap = load − capacity` and `completion_pct = capacity / load`, `None`
    when load is 0. Year and remaining-year variants both use the
    process-derived load. Floats are rounded to 2 dp, `remaining_fraction`
    to 4 dp.
    """

    hub: HubName
    lab_region: LabRegion
    design_load_weeks: int
    design_load_estimated_weeks: float
    lab_load_weeks: float
    lab_load_estimated_weeks: float
    engineer_fte_total: float
    working_weeks_per_engineer: float
    design_capacity_year: float
    design_capacity_remaining: float
    lab_capacity_year: float
    lab_capacity_remaining: float
    design_gap_year: float
    design_completion_pct_year: float | None
    design_gap_remaining: float
    design_completion_pct_remaining: float | None
    lab_gap_year: float
    lab_completion_pct_year: float | None
    lab_gap_remaining: float
    lab_completion_pct_remaining: float | None
    remaining_fraction: float
    chambers: list[CapacityChamberRow]
    #: Deprecated alias of `design_capacity_remaining`, kept for one release.
    design_capacity_weeks: float | None = Field(default=None, deprecated=True)
    #: Deprecated alias of `lab_capacity_remaining`, kept for one release.
    lab_capacity_units: float | None = Field(default=None, deprecated=True)
    #: Deprecated. This hub's *own* lab load (× 1.0, ADR 0007). The
    #: region-level `lab_load_weeks` supersedes it. Kept for one release.
    lab_load_units: float | None = Field(default=None, deprecated=True)
    # --- P11 (docs/API_CONTRACT_P11.md §4, ADR 0016) ----------------------
    #: `load / capacity × 100` on this row's served figures, 2 dp; `None`
    #: when that capacity is 0 (I19).
    design_booked_pct_year: float | None
    design_booked_pct_remaining: float | None
    lab_booked_pct_year: float | None
    lab_booked_pct_remaining: float | None
    design_booking_status_year: BookingStatus
    design_booking_status_remaining: BookingStatus
    lab_booking_status_year: BookingStatus
    lab_booking_status_remaining: BookingStatus
    area: CapacityAreaName
    # --- P13 (docs/API_CONTRACT_P13.md §6) --------------------------------
    #: `design_load_weeks` split by the priority bucket of the hub's projects.
    #: Same basis (active run, non-skipped design-kind steps); sums to it.
    design_load_by_priority: PriorityLoadSplit
    #: `lab_load_weeks` split by priority bucket. Same region-level basis
    #: (every project of the row's lab region, repeated on each hub of the
    #: region); sums to it.
    lab_load_by_priority: PriorityLoadSplit
    # --- P19-T03 (docs/API_CONTRACT_P19.md §1): Weeks / Days toggle -------
    #: The hub's `HubWorkCalendar.weekdays_per_week` (ADR 0008).
    weekdays_per_week: float
    #: Design capacity in days: served `design_capacity_year` / `_remaining`
    #: × `weekdays_per_week`, 2 dp.
    capacity_days: YearRemaining
    #: Design load in days: `design_load_weeks × weekdays_per_week` (same on
    #: both bases), 2 dp.
    load_days: YearRemaining
    #: `weekdays_per_week` of the calendar the row's lab region takes its
    #: chambers' holiday weeks from (`services.capacity_supply.region_calendar`).
    lab_weekdays_per_week: float
    #: Served `lab_capacity_year` / `_remaining` × `lab_weekdays_per_week`, 2 dp.
    lab_capacity_days: YearRemaining
    #: Served `lab_load_weeks` × `lab_weekdays_per_week` (both bases), 2 dp.
    lab_load_days: YearRemaining


class LabRegionCapacityRow(BaseModel):
    """P19-T03 (§1): one lab region's lab figures, served once per region
    (the hub rows repeat them on every hub of the region). Built from the
    same served values as the hub rows, so `capacity_weeks.year` equals every
    hub row's `lab_capacity_year` of the region."""

    lab_region: LabRegion
    #: The region calendar's `weekdays_per_week` (= the hub rows'
    #: `lab_weekdays_per_week`).
    weekdays_per_week: float
    chamber_count: int
    capacity_weeks: YearRemaining
    load_weeks: float
    capacity_days: YearRemaining
    load_days: YearRemaining


class CapacityArea(BaseModel):
    """One area's roll-up (ADR 0016 §3), built only from the caller's
    in-scope hubs. `hubs` and `lab_regions` say exactly what it covers, so a
    partial area is never presented as the whole of Europe.

    Design figures are Σ over `hubs`. Lab figures are Σ over `lab_regions`,
    each region counted once (the hub rows repeat the region figure on every
    hub of the region, so they are never summed). Every figure is the sum of
    the served 2 dp row figures, rounded to 2 dp; `booked_pct` and status
    follow the same rule as the hub rows (I19).
    """

    area: CapacityAreaName
    hubs: list[HubName]
    lab_regions: list[LabRegion]
    design_load_weeks: int
    design_capacity_year: float
    design_capacity_remaining: float
    lab_load_weeks: float
    lab_capacity_year: float
    lab_capacity_remaining: float
    design_booked_pct_year: float | None
    design_booked_pct_remaining: float | None
    lab_booked_pct_year: float | None
    lab_booked_pct_remaining: float | None
    design_booking_status_year: BookingStatus
    design_booking_status_remaining: BookingStatus
    lab_booking_status_year: BookingStatus
    lab_booking_status_remaining: BookingStatus


class CapacityTotals(BaseModel):
    """P13-T11 addendum: the portfolio total over the served (filtered,
    scoped) hub rows, so the browser never sums rows (I9/I19).

    Same rule as `CapacityArea`: design figures are Σ over `hubs` (one per
    hub row); lab figures are Σ over `lab_regions`, each region counted ONCE
    (the hub rows repeat the region figure on every hub of the region).
    Every input is the row's served 2 dp figure, rounded to 2 dp.
    `*_load_by_priority` is the same Σ of the rows' splits and sums to the
    load. `booked_pct = load / capacity × 100` (2 dp, null when capacity is
    0) and the status follow ADR 0016. With no row everything is 0 / null /
    `available`.
    """

    hubs: list[HubName]
    lab_regions: list[LabRegion]
    design_load_weeks: int
    design_capacity_year: float
    design_capacity_remaining: float
    design_booked_pct_year: float | None
    design_booked_pct_remaining: float | None
    design_booking_status_year: BookingStatus
    design_booking_status_remaining: BookingStatus
    design_load_by_priority: PriorityLoadSplit
    lab_load_weeks: float
    lab_capacity_year: float
    lab_capacity_remaining: float
    lab_booked_pct_year: float | None
    lab_booked_pct_remaining: float | None
    lab_booking_status_year: BookingStatus
    lab_booking_status_remaining: BookingStatus
    lab_load_by_priority: PriorityLoadSplit
    # --- P19-T03 (§1): Σ of the rows' served day figures (design per hub,
    # lab per region once), 2 dp. Hubs may have different weekdays, so a
    # total in days is never "total weeks × one constant".
    design_capacity_days: YearRemaining
    design_load_days: YearRemaining
    lab_capacity_days: YearRemaining
    lab_load_days: YearRemaining


class HubCapacitySummary(BaseModel):
    has_active_schedule_run: bool
    schedule_run_version: int | None
    remaining_weeks: int
    rows: list[HubCapacityRow]
    #: ADR 0016 thresholds (`domain_constants.BOOKING_*_PCT`), served so the
    #: UI can explain the chips without hard-coding them.
    near_full_threshold_pct: int
    full_threshold_pct: int
    #: Europe first, then India. An area with no in-scope hub is omitted.
    areas: list[CapacityArea]
    #: P13-T11 addendum: the total over `rows` (design per hub, lab per region once).
    totals: CapacityTotals
    #: P19-T03 (§1): one row per lab region of `rows`, Greece, India, Romania.
    lab_regions: list[LabRegionCapacityRow]


class ClassBreakdownHubRow(BaseModel):
    """P13 (§6): one hub's share of a category row. Only hubs with at least
    one project of the category in the active run are listed, by hub name."""

    hub: HubName
    deliverable: int
    left_out: int


class ClassBreakdownRow(BaseModel):
    """One category of the Capacity class breakdown (active run).

    P13-F06 (2026-10-19): **Deliverable** = a project in the active run whose
    live status is schedulable (`In Buyoff`, `Under Industrialization`,
    `In Development`, `In Queue`) and that is not `left_out`. **Left out** =
    a schedulable project the run marked `left_out`. Commercialized, On Hold,
    Cancelled and Draft projects are not planned by the scheduler and are
    counted in neither column, nor in the priority splits, `by_hub` or
    `total_count`.
    """

    category: ProjectCategory
    deliverable_count: int
    left_out_count: int
    # --- P13 (docs/API_CONTRACT_P13.md §6) --------------------------------
    #: `deliverable_count + left_out_count`, served (P13-T11 addendum).
    total_count: int
    #: `deliverable_count` split by priority bucket; sums to it.
    deliverable_by_priority: PriorityCountSplit
    #: `left_out_count` split by priority bucket; sums to it.
    left_out_by_priority: PriorityCountSplit
    #: Per hub; Σ deliverable = `deliverable_count`, Σ left_out = `left_out_count`.
    by_hub: list[ClassBreakdownHubRow]


class ClassBreakdown(BaseModel):
    has_active_schedule_run: bool
    schedule_run_version: int | None
    rows: list[ClassBreakdownRow]


class EngineerWeekLoad(BaseModel):
    """Per-engineer weekly load row for `GET /capacity/utilization-matrix`.

    P3-T09 (security remediation, finding #1 / OQ#8 dependency — GDPR):
    deliberately has NO `name` field. `docs/OPEN_QUESTIONS.md` #8 (whether
    per-engineer utilization is personal data requiring a GDPR lawful basis)
    is unresolved and explicitly hard-blocking (`docs/IMPLEMENTATION_PLAN.md`
    P0-T02: "provisional-proceed does not apply to it"). Named per-engineer
    utilization was served here until security-auditor's P3-T08 finding #1
    (High) — this schema now withholds the name at the API layer rather than
    relying on the frontend not rendering it (mirrors the P4-T03 UI decision,
    but enforced server-side). `engineer_id`/`hub`/`busy_weeks` are not
    personal data on their own (a UUID and an aggregate hub/week count
    reveal no identity) and remain reportable.

    This is consciously reversible: once the DPO signs off on OQ#8, re-add
    `name: str` here and in `api/routers/capacity.py`'s
    `EngineerWeekLoad(...)` construction — do not restore it before then.
    """

    engineer_id: uuid.UUID
    hub: HubName
    #: Week numbers (against the active run's horizon) this engineer is
    #: booked to a design step. Sparse list, not a full 78-length array, to
    #: keep the payload proportional to actual bookings.
    busy_weeks: list[int]


class ChamberWeekLoad(BaseModel):
    chamber_id: uuid.UUID
    code: str
    lab_region: str
    max_concurrent: int
    #: One entry per week that has >=1 project booked, `count` = number of
    #: concurrently-booked projects that week (compare against
    #: `max_concurrent` to see over/under-utilization).
    week_counts: dict[int, int]


class UtilizationMatrix(BaseModel):
    has_active_schedule_run: bool
    schedule_run_version: int | None
    engineers: list[EngineerWeekLoad]
    chambers: list[ChamberWeekLoad]


class EngineerWeekUtilization(BaseModel):
    """One week of one engineer (ADR 0028). `capacity` is the engineer's
    FTE-weighted working weeks spread evenly over the year (ADR 0008)."""

    week: int
    #: Effort weeks booked in this week (2 dp). ADR 0032: a design row's
    #: `duration_weeks` (effort) is spread over its elapsed span, so a 0.5 FTE
    #: leader reads about 0.5 per busy week; In Progress / Blocked rows put the
    #: remaining effort on the booked tail (`services.run_step_effort`).
    booked: float
    capacity: float
    #: `booked / capacity * 100` (2 dp). With zero capacity: 100.0 when
    #: anything is booked (the ADR 0016 "full" rule), else 0.0. Never null.
    utilization_pct: float


class EngineerUtilizationRow(BaseModel):
    """One engineer's Engineers x Weeks row (ADR 0028). No financial fields."""

    id: uuid.UUID
    name: str
    hub: HubName
    #: The categories the engineer may lead, comma-joined (e.g. "A, B, OEM").
    role: str
    #: Design-step effort weeks (Σ `duration_weeks`, never the FTE-stretched
    #: span) booked over the whole run horizon (incl. weeks > 52).
    #: Summed over a hub's engineers this equals the hub design load (I6).
    total_booked: float
    #: FTE-weighted working weeks in the 52-week year (the sum of `weeks[].capacity`).
    total_capacity: float
    #: `total_booked / total_capacity * 100` (same zero-capacity rule as a week).
    utilization_pct: float
    #: Exactly W1..W52, in order.
    weeks: list[EngineerWeekUtilization]


class EngineerUtilizationResponse(BaseModel):
    week_range: tuple[int, int]
    current_week: int
    engineers: list[EngineerUtilizationRow]
