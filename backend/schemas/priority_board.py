"""Priority board (docs/API_CONTRACT_P12.md §2; ADR 0018). Read model only:
a drop calls the existing `POST /projects/{id}/priority`.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel

from models.enums import HubName, ProjectPriority, ProjectStatus
from schemas.category import CategoryCodeOut
from services.project_cards import CardHealth
from services.tracking import TrackingStatus


class PriorityBoardCard(BaseModel):
    project_id: uuid.UUID
    name: str
    #: P25-T03: the project's external code (e.g. "S-4012"), null if none, so
    #: the List layout can tell apart projects with similar names.
    external_code: str | None
    hub_id: uuid.UUID
    hub: HubName
    category: CategoryCodeOut | None
    status: ProjectStatus
    #: `PriorityScore.weighted_score`, as the Matrix serves it.
    score: float | None
    #: The stored score band (`PriorityScore.suggested_band`), unchanged since
    #: P12. Equal to `score_band`; kept so existing clients do not break.
    band: ProjectPriority | None
    #: P25-T03 (ADR 0036): the suggested band AFTER the P1 capacity fill, the
    #: same value as the Matrix row's `suggested_band`: "P1" when
    #: `capacity_fill` is true, else `score_band`. Null when unscored.
    suggested_band: ProjectPriority | None
    #: ADR 0036: the pure score band (>= 70 P1, >= 55 P2, >= 40 P3, else P4).
    score_band: ProjectPriority | None
    #: ADR 0036: promoted to P1 by the hub's capacity fill ("P1 (capacity fill)").
    capacity_fill: bool
    #: ADR 0036: the walk's reason for a promoted, stopped or zero-load-skipped
    #: candidate, served for display as is; null otherwise.
    capacity_fill_reason: str | None
    #: True ⇒ pinned to P1 (hard gates), not draggable out of it.
    hard_gated: bool
    is_vip: bool
    #: P36 (ADR 0050, API_CONTRACT_P36 §1): the position in the FULL band
    #: (dense 1..n), never renumbered by a board filter. Null only for a
    #: project that is not a band member.
    band_rank: int | None
    #: P36 (R36-2): frozen projects schedule first whatever their position
    #: (dates locked), badged like VIP.
    frozen: bool
    projected_end_week: int | None
    within_year: bool | None
    health: CardHealth | None
    tracking_status: TrackingStatus
    # --- P42 (ADR 0056 R42-4/R42-7, docs/API_CONTRACT_P42.md §2) -------------
    #: The active run's stored flags; null when the project is not in the run.
    counts_toward_year: bool | None = None
    not_scheduled_priority: bool | None = None
    #: R42-7 "Queued" badge: the stored outcome is QUEUED (counts_toward_year
    #: false, not P4-excluded). False when not in the run.
    queued: bool = False
    #: "Not scheduled (P4)" / "Queued — fits by W{n}" / "Queued — after W52" /
    #: "Queued — no slot"; null for a counting card or one not in the run.
    outcome_label: str | None = None


class PriorityBoardColumn(BaseModel):
    priority: ProjectPriority
    #: P42 (R42-1): the band's label ("Must do this year", ...).
    label: str
    #: P42 (R42-3): the band is never scheduled (P4, Q) for a non-frozen
    #: project. Its cards keep their ranks (R42-7).
    not_scheduled: bool
    #: P42: cards of this column with `queued` true.
    queued_count: int
    count: int
    cards: list[PriorityBoardCard]
    #: P13 (docs/API_CONTRACT_P13.md §6): the column's remaining design load
    #: in weeks, 2 dp, over its (filtered) cards, from the active run's stored
    #: step windows at or after the run's current week
    #: (`services.capacity_priority.remaining_run_load_by_project`). 0 with no
    #: active run; a card not in the run adds 0.
    design_weeks: float
    #: As `design_weeks`, for lab-kind steps (× the lab consumption factor).
    lab_weeks: float


class PriorityBoardResponse(BaseModel):
    #: The active run used for finish/health; null when there is none yet.
    run_id: uuid.UUID | None
    #: Always five, in order P1, P2, P3, P4, Q.
    columns: list[PriorityBoardColumn]
