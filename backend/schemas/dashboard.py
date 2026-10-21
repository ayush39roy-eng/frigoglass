"""Read models for the Global RPD Dashboard surface
(`docs/PROJECT_AND_STACK.md` §2). Every field that concerns a *scheduling
outcome* (within-year, spillover, left-out) is sourced from the active
`ScheduleRun`'s snapshot tables — never independently calculated — per
Invariant I9. See `api/routers/dashboard.py` for the query that enforces
this.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel

from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
)


class PipelineTotals(BaseModel):
    """`Spillover + Newly registered + Unregistered date = Total projects`
    (ADR 0030, `docs/API_CONTRACT_P17.md`).

    Portfolio *composition* by registration, not the schedule-outcome
    `SPILLOVER` flag (see `CompletingWithinYear`). Scope: EVERY project in the
    caller's scope and filter, Commercialized included (P17; before P17 it
    was excluded).

    * `spillover_count`   - `carry_over` is true.
    * `new_count`         - `carry_over` is false AND `reg_year` is not null.
    * `unregistered_count` - `carry_over` is false AND `reg_year` is null.

    The three are mutually exclusive and `total_count` is their sum. Each
    `*_share_pct` is count / `total_count` x 100, 2 dp, computed here (I19);
    0.0 when `total_count` is 0.
    """

    spillover_count: int
    new_count: int
    unregistered_count: int
    total_count: int
    spillover_share_pct: float
    new_share_pct: float
    unregistered_share_pct: float


class StatusOverview(BaseModel):
    """Counts for the four schedulable statuses named in
    `docs/PROJECT_AND_STACK.md` §2 ("In Buyoff / Under Industrialization / In
    Development / In Queue"). `Draft`/`Commercialized`/`On Hold` counts are
    included too (as `other_counts`) so the total is reconcilable, but are not
    part of the four named "status overview cards."
    """

    in_buyoff: int
    under_industrialization: int
    in_development: int
    in_queue: int
    other_counts: dict[str, int]
    # P17-T03 (ADR 0030, docs/API_CONTRACT_P17.md): five-card status overview.
    # Project STATUS `On Hold` (ADR 0017) is distinct from the stage-level
    # "On Hold" (stored `Blocked`) outcome; this field is the project status.
    commercialized_count: int
    on_hold_count: int
    total_count: int
    in_development_share_pct: float
    under_industrialization_share_pct: float
    in_queue_share_pct: float
    commercialized_share_pct: float
    on_hold_share_pct: float
    other_statuses_count: int
    other_statuses_counts: dict[str, int]
    other_statuses_share_pct: float


class HubTypePipelineRow(BaseModel):
    hub: HubName
    type: ProjectType | None
    count: int


class CompletingWithinYearRow(BaseModel):
    """One project's outcome from the active `ScheduleRun` snapshot
    (`models.schedule.ScheduleRunProjectOutcome` joined to `Project`).
    """

    project_id: uuid.UUID
    project_name: str
    hub: HubName
    category: ProjectCategory | None
    priority: ProjectPriority | None
    #: P13-T10 (docs/API_CONTRACT_P13.md §5): the project's type; null when
    #: unmapped.
    type: ProjectType | None
    within_year: bool
    spillover: bool
    left_out: bool
    #: P9-F02: `ScheduleRunProjectOutcome.blocked` — a Blocked stage held the
    #: project at its frontier (DOMAIN_RULES.md "Gate remediation rulings"
    #: 5). Surfaced here so a row's `blocked_count` membership is visible on
    #: the row itself, not just in the aggregate.
    blocked: bool
    cat_not_allowed: bool
    last_step_end_week: int | None
    #: P17-R03: the project's status (wire value; non-sensitive).
    status: ProjectStatus
    #: P17-R03: true when status is In Queue AND no stage has progress
    #: (every stage "Not Started"). Server-computed; see API_CONTRACT_P17.
    not_started: bool


class PriorityDeliveryBand(BaseModel):
    """P17-R03: one priority band's delivery figures, counted by the server
    over every project in scope/filter (not only those with an outcome row).
    `total == in_flight_total + not_started_total + delivered_total +
    other_total`; `within_year == in_flight_within_year +
    not_started_within_year + delivered_within_year`. Shares are 2 dp (I19),
    0.0 on a zero denominator.
    """

    priority: ProjectPriority
    total: int
    within_year: int
    in_flight_total: int
    in_flight_within_year: int
    not_started_total: int
    not_started_within_year: int
    delivered_total: int
    delivered_within_year: int
    other_total: int
    #: within_year / total
    within_year_share_pct: float
    #: in_flight_within_year / in_flight_total
    in_flight_within_year_share_pct: float
    #: not_started_within_year / not_started_total
    not_started_within_year_share_pct: float
    #: shares of `total`
    in_flight_share_pct: float
    not_started_share_pct: float
    delivered_share_pct: float
    other_share_pct: float


class CompletingWithinYear(BaseModel):
    """Response for `GET /dashboard/completing-within-year`.

    `has_active_schedule_run=False` (with empty `rows` and all counts 0) is a
    legitimate, non-error state — nothing has necessarily triggered a
    `ScheduleRun` yet (see `api/routers/schedule_runs.py`'s
    `POST /schedule-runs/greedy-recalc`). Callers must handle it, not assume a
    run always exists.
    """

    has_active_schedule_run: bool
    schedule_run_version: int | None
    within_year_count: int
    spillover_count: int
    left_out_count: int
    #: P9-F02 (DOMAIN_RULES "Health badge", ruling 5): a project whose
    #: outcome has `blocked=True` (a Blocked stage held it at its frontier)
    #: is counted here, exclusively — never also in `within_year_count`,
    #: `spillover_count` or `left_out_count`, even if one of those raw
    #: outcome flags happens to also be set on the same row. Same single
    #: source of truth as the other three counts (Invariant I9's spirit): no
    #: independent recomputation, just the mutually-exclusive bucket the
    #: Project Workspace health badge already gives Blocked priority over
    #: (ruling 5: "after Left Out, before the finish-week rules" for the
    #: badge; here Blocked wins outright so the four counts partition the
    #: schedulable, non-excluded portfolio without overlap).
    blocked_count: int
    rows: list[CompletingWithinYearRow]
    #: P17-R03: always the five bands P1, P2, P3, P4, Q in that order.
    priority_delivery: list[PriorityDeliveryBand]


#: The active run's per-project outcome bucket (P13 register column).
ScheduleOutcome = Literal["WITHIN_YEAR", "SPILLOVER", "LEFT_OUT", "BLOCKED"]


class ProjectFilterRow(BaseModel):
    """One row of the "analytics breakdown with filters" endpoint — a light
    projection, not the full `ProjectRead` (Project Registration's job).
    """

    project_id: uuid.UUID
    project_name: str
    hub: HubName
    category: ProjectCategory | None
    status: ProjectStatus
    priority: ProjectPriority | None
    #: P12 (docs/API_CONTRACT_P12.md §5/§6): pinned as VIP (ADR 0022).
    is_vip: bool
    #: P12 (ADR 0021 §4), from `services.tracking.tracking_status_for`.
    tracking_status: Literal["live", "due", "overdue", "idle"]
    # --- P13 (ADR 0025, docs/API_CONTRACT_P13.md §3): register columns. All
    # additive. No financial field (TCOGS, gross margin, selling price,
    # customer name) is ever part of this projection.
    external_code: str | None
    type: ProjectType | None
    #: The hub's served lab region ("country").
    region: LabRegion
    #: OQ#8 (P3-T09 pattern, as on the Workspace): null unless the leader is
    #: the caller. `leader_engineer_id` is an id, not a name, and is served.
    leader_name: str | None
    leader_engineer_id: uuid.UUID | None
    #: First workflow step that is neither Done nor skipped (the active run's
    #: skipped flag, else the ADR 0007 rule) — `services.project_cards`.
    current_step_code: str | None
    current_step_name: str | None
    #: The active run's projected finish week (`projected_end_week`); null
    #: with no active run or when the project is not scheduled in it.
    end_week: int | None
    #: The active run's exclusive outcome bucket, same precedence as
    #: `/dashboard/completing-within-year` (Blocked first); null if none.
    outcome: ScheduleOutcome | None
    reg_year: int | None
    carry_over: bool
    #: 1-based rank by weighted score (descending, then name) within the
    #: filtered set; null when the project has no score.
    priority_rank: int | None


class ProjectFilterResult(BaseModel):
    total_count: int
    rows: list[ProjectFilterRow]


class NamedId(BaseModel):
    """A leader option for the register's filter. `name` is null unless the
    engineer is the caller (OQ#8, P3-T09 pattern)."""

    id: uuid.UUID
    name: str | None


class StepFacet(BaseModel):
    code: str
    name: str


class ProjectFacets(BaseModel):
    """`GET /dashboard/projects/facets` (P13 §3): only values present in the
    caller's scoped, filtered set."""

    leaders: list[NamedId]
    steps: list[StepFacet]


class RegionSummaryRow(BaseModel):
    """One country of `GET /dashboard/region-summary` (ADR 0025 §4).

    `total_count`, `spillover_count`, `newly_registered_count` and
    `unregistered_count` use the `PipelineTotals` basis (every project,
    ADR 0030), so the chips under the pipeline cards reconcile with them. `status_counts` uses
    the `StatusOverview` basis (every status, Commercialized included), so
    the chips under each status card reconcile with it. Every share is
    computed here, 2 dp; a zero denominator gives 0.0.
    """

    region: LabRegion
    total_count: int
    #: `total_count` / the portfolio `total_count` × 100.
    share_pct: float
    spillover_count: int
    newly_registered_count: int
    #: P17: carry_over false AND reg_year null.
    unregistered_count: int
    #: P17: each count / the portfolio's matching `PipelineTotals` count x 100
    #: (so the regions' shares of one card sum to ~100); 0.0 on a zero
    #: denominator.
    spillover_share_pct: float
    newly_registered_share_pct: float
    unregistered_share_pct: float
    #: Every `ProjectStatus` wire value, 0 if none.
    status_counts: dict[str, int]
    #: Per status: this region's count / that status's count across the
    #: filtered portfolio × 100.
    status_share_pct: dict[str, float]


class RegionSummary(BaseModel):
    #: Equals `PipelineTotals.total_count` for the same filter.
    total_count: int
    #: Always Greece, India, Romania, in that order, zero rows included.
    regions: list[RegionSummaryRow]


# --- P13-T10: Dashboard analytics (docs/API_CONTRACT_P13.md §5) ---------------


class AnalyticsBucket(BaseModel):
    """One slice of a composition chart. `key` is the type / category / hub
    / registration-year value as a string, or the sentinel `"Unmapped"`
    (null type or category) / `"Unknown"` (null `reg_year`)."""

    key: str
    count: int
    #: `count` / the filtered pipeline total × 100, 2 dp; 0.0 when the total
    #: is 0. Computed here, never in the browser (I19).
    share_pct: float


class CompletingHubTypeRow(BaseModel):
    """ "Completing within year: Hub × Type" — one (hub, type) cell present in
    the filtered pipeline."""

    hub: HubName
    #: Null when the project's type is unmapped.
    type: ProjectType | None
    pipeline_count: int
    #: Projects of this cell whose active-run bucket is `WITHIN_YEAR` (the
    #: `/completing-within-year` exclusive bucket: Blocked wins).
    completing_count: int
    #: `completing_count` / `pipeline_count` × 100, 2 dp; 0.0 when 0.
    completing_pct: float


class CompletingByTypeRow(BaseModel):
    """Pipeline vs completing, per type (`key` as in `AnalyticsBucket`)."""

    key: str
    pipeline_count: int
    completing_count: int
    completing_pct: float


class CompletingByHubRow(BaseModel):
    """The cross-tab's per-hub Total column: the sum of that hub's
    `completing_hub_type` cells, same basis."""

    key: HubName
    pipeline_count: int
    completing_count: int
    #: `completing_count` / `pipeline_count` × 100, 2 dp.
    completing_pct: float


class DashboardAnalytics(BaseModel):
    """`GET /dashboard/analytics`.

    **Basis**: the `PipelineTotals` basis — every project (ADR 0030;
    Commercialized included since P17) — in the caller's scope, ANDed with `hub_id` / `region`.
    Each list's counts therefore sum to `PipelineTotals.total_count` for the
    same filter.

    **Completing** is the active run's exclusive `WITHIN_YEAR` bucket (as on
    `/completing-within-year`), counted inside the same basis. Without an
    active run both `completing_*` lists are empty and
    `has_active_schedule_run` is false.
    """

    #: Every `ProjectType` in enum order (zeros included), then `"Unmapped"`
    #: if any project has no type.
    by_type: list[AnalyticsBucket]
    #: Every `ProjectCategory` in enum order (zeros included), then
    #: `"Unmapped"` if any project has no category.
    by_category: list[AnalyticsBucket]
    #: Every hub in the caller's scope and filter, by name (zeros included).
    by_hub: list[AnalyticsBucket]
    #: Registration years ascending, then `"Unknown"` if any are null.
    by_reg_year: list[AnalyticsBucket]
    #: (hub, type) cells with `pipeline_count > 0`; hub name, then type enum
    #: order, unmapped last.
    completing_hub_type: list[CompletingHubTypeRow]
    #: Same keys and order as `by_type`.
    completing_by_type: list[CompletingByTypeRow]
    #: Hubs with `pipeline_count > 0`, in `by_hub` order; each row sums that
    #: hub's `completing_hub_type` cells. Empty without an active run.
    completing_by_hub: list[CompletingByHubRow]
    has_active_schedule_run: bool
