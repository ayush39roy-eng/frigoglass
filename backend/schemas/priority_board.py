"""Priority board (docs/API_CONTRACT_P12.md §2; ADR 0018). Read model only:
a drop calls the existing `POST /projects/{id}/priority`.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel

from models.enums import HubName, ProjectCategory, ProjectPriority, ProjectStatus
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
    category: ProjectCategory | None
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
    projected_end_week: int | None
    within_year: bool | None
    health: CardHealth | None
    tracking_status: TrackingStatus


class PriorityBoardColumn(BaseModel):
    priority: ProjectPriority
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
