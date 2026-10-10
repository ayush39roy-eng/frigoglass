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
    hub_id: uuid.UUID
    hub: HubName
    category: ProjectCategory | None
    status: ProjectStatus
    #: `PriorityScore.weighted_score`, as the Matrix serves it.
    score: float | None
    #: `PriorityScore.suggested_band`, as the Matrix serves it.
    band: ProjectPriority | None
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


class PriorityBoardResponse(BaseModel):
    #: The active run used for finish/health; null when there is none yet.
    run_id: uuid.UUID | None
    #: Always five, in order P1, P2, P3, P4, Q.
    columns: list[PriorityBoardColumn]
