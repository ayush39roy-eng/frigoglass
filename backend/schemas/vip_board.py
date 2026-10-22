"""VIP board (docs/API_CONTRACT_P14.md §2; ADR 0027)."""

from __future__ import annotations

import uuid
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from models.enums import HubName, ProjectPriority, ProjectStatus
from models.vip import VIP_NOTE_MAX, VIP_TITLE_MAX, VipArea, VipPillar, VipStatusTag
from services.project_cards import CardHealth

VipTitle = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=VIP_TITLE_MAX)
]
VipNote = Annotated[str, StringConstraints(strip_whitespace=True, max_length=VIP_NOTE_MAX)]
SORT_ORDER_MAX = 10_000
#: Upper bound on links per item ("BEE star labelling" alone is ~25).
VIP_LINKS_MAX = 500


class VipPillarRef(BaseModel):
    key: VipPillar
    number: str
    label: str
    headline: str
    impact: list[str]


class VipBoardProject(BaseModel):
    """Live facts from the active run (I9); no financial fields."""

    id: uuid.UUID
    name: str
    hub: HubName
    priority: ProjectPriority | None
    status: ProjectStatus
    projected_end_week: int | None
    within_year: bool | None
    health: CardHealth | None


class VipBoardItem(BaseModel):
    id: uuid.UUID
    pillar: VipPillar
    title: str
    status_tag: VipStatusTag | None
    status_note: str | None
    highlighted: bool
    sort_order: int
    #: One level only: a child's `children` is always empty.
    children: list[VipBoardItem]
    projects: list[VipBoardProject]
    #: Linked projects outside the caller's scope or the hub/region filter.
    hidden_project_count: int


class VipBoardVipItem(BaseModel):
    """A highlighted item (yellow highlight = VIP, ADR 0027 amendment)."""

    id: uuid.UUID
    title: str


class VipBoardArea(BaseModel):
    area: VipArea
    label: str
    #: Every hub of the area (hub names are not scoped data).
    hubs: list[HubName]
    #: Counts include sub-items.
    item_count: int
    highlighted_count: int
    high_risk_count: int
    #: Distinct linked projects visible to the caller in this area.
    linked_project_count: int
    #: ADR 0040: projects pinned VIP (`projects.is_vip`, manual only) in this
    #: area's hubs, visible to the caller. This is the "VIP" headline; the
    #: highlighted items are the client's slide bullets, not VIP projects.
    vip_project_count: int
    #: The area's VIP (highlighted) items, in board order (sub-items after
    #: their parent), for the tile.
    vip_items: list[VipBoardVipItem]
    items: list[VipBoardItem]


class VipBoardResponse(BaseModel):
    run_id: uuid.UUID | None
    pillars: list[VipPillarRef]
    areas: list[VipBoardArea]


# --- writes -----------------------------------------------------------------


class VipItemCreateRequest(BaseModel):
    """Strict, unknown keys rejected. Enum fields opt out of strict mode so
    their JSON strings validate (same pattern as `PriorityMoveRequest`); lax
    enum validation still accepts only the listed values.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    area: VipArea = Field(strict=False)
    pillar: VipPillar = Field(strict=False)
    title: VipTitle
    status_tag: VipStatusTag | None = Field(default=None, strict=False)
    status_note: VipNote | None = None
    highlighted: bool = False
    parent_id: uuid.UUID | None = Field(default=None, strict=False)
    sort_order: int | None = Field(default=None, ge=0, le=SORT_ORDER_MAX)


_NOT_NULLABLE = ("area", "pillar", "title", "highlighted", "sort_order")


class VipItemUpdateRequest(BaseModel):
    """Partial update: only keys present are applied. `status_tag`,
    `status_note` and `parent_id` may be set to null; the rest may not.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    area: VipArea | None = Field(default=None, strict=False)
    pillar: VipPillar | None = Field(default=None, strict=False)
    title: VipTitle | None = None
    status_tag: VipStatusTag | None = Field(default=None, strict=False)
    status_note: VipNote | None = None
    highlighted: bool | None = None
    parent_id: uuid.UUID | None = Field(default=None, strict=False)
    sort_order: int | None = Field(default=None, ge=0, le=SORT_ORDER_MAX)

    @model_validator(mode="after")
    def _reject_null_required(self) -> Self:
        for name in _NOT_NULLABLE:
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class VipItemResponse(BaseModel):
    id: uuid.UUID
    area: VipArea
    pillar: VipPillar
    title: str
    status_tag: VipStatusTag | None
    status_note: str | None
    highlighted: bool
    parent_id: uuid.UUID | None
    sort_order: int
    project_ids: list[uuid.UUID]


class VipItemLinksRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    project_ids: list[Annotated[uuid.UUID, Field(strict=False)]] = Field(
        max_length=VIP_LINKS_MAX
    )


class VipItemDeleteResponse(BaseModel):
    id: uuid.UUID
    deleted_item_count: int
    #: ADR 0040: always `[]`. A link no longer sets or clears `is_vip`; the
    #: field stays for wire compatibility (frontend mirror is exact).
    unpinned_project_ids: list[uuid.UUID]


class VipItemLinksResponse(BaseModel):
    item: VipItemResponse
    added_project_ids: list[uuid.UUID]
    removed_project_ids: list[uuid.UUID]
    #: ADR 0040: both always `[]` (a link never changes `is_vip`); kept for
    #: wire compatibility.
    pinned_project_ids: list[uuid.UUID]
    unpinned_project_ids: list[uuid.UUID]
