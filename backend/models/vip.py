"""Curated VIP board (ADR 0027; docs/API_CONTRACT_P14.md §2).

`vip_items` holds the client's slide content: one row per bullet, grouped by
`area` (Greece / India / Romania) and `pillar`, with one level of sub-items
(`parent_id`). `vip_item_projects` links an item to zero or more projects.
A link is a plain reference: it never sets or clears `projects.is_vip`
(ADR 0040, 2026-10-22, superseding the ADR 0027 amendment); only
`PUT /projects/{id}/vip` does.

The three enums are stored as VARCHAR with CHECK constraints (not native PG
enum types), so adding a status tag later is a constraint swap, not an
`ALTER TYPE`.
"""

from __future__ import annotations

import enum
import uuid

from sqlalchemy import Boolean, CheckConstraint, Column, Enum, ForeignKey, Integer, String, Table
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class VipArea(enum.StrEnum):
    """ADR 0027 amendment (OQ #39): the area is the hub's lab region, the
    ADR 0025 country; OEM hubs count as Greece.
    """

    GREECE = "Greece"
    INDIA = "India"
    ROMANIA = "Romania"


class VipPillar(enum.StrEnum):
    INNOVATION = "INNOVATION"
    MARKET_EXPANSION = "MARKET_EXPANSION"
    PERFORMANCE = "PERFORMANCE"


class VipStatusTag(enum.StrEnum):
    ON_TRACK = "ON_TRACK"
    DELAYED = "DELAYED"
    HIGH_RISK = "HIGH_RISK"
    COMMERCIALIZED = "COMMERCIALIZED"
    IMPLEMENTED = "IMPLEMENTED"
    TBD = "TBD"
    UNDER_INVESTIGATION = "UNDER_INVESTIGATION"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"


VIP_TITLE_MAX = 200
VIP_NOTE_MAX = 200


def _in_check(column: str, enum_cls: type[enum.Enum]) -> str:
    values = ", ".join(f"'{member.value}'" for member in enum_cls)
    return f"{column} IN ({values})"


#: CHECK expressions shared with the migration (built from the enums above,
#: constant text; no user input ever reaches them).
AREA_CHECK = _in_check("area", VipArea)
PILLAR_CHECK = _in_check("pillar", VipPillar)
STATUS_TAG_CHECK = f"status_tag IS NULL OR {_in_check('status_tag', VipStatusTag)}"


def _varchar_enum(enum_cls: type[enum.Enum], length: int) -> Enum:
    return Enum(
        enum_cls,
        native_enum=False,
        create_constraint=False,
        length=length,
        values_callable=lambda cls: [m.value for m in cls],
        validate_strings=True,
    )


vip_item_projects = Table(
    "vip_item_projects",
    Base.metadata,
    Column(
        "item_id",
        ForeignKey("vip_items.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "project_id",
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    ),
)


class VipItem(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "vip_items"

    area: Mapped[VipArea] = mapped_column(_varchar_enum(VipArea, 20), nullable=False)
    pillar: Mapped[VipPillar] = mapped_column(_varchar_enum(VipPillar, 30), nullable=False)
    title: Mapped[str] = mapped_column(String(VIP_TITLE_MAX), nullable=False)
    status_tag: Mapped[VipStatusTag | None] = mapped_column(
        _varchar_enum(VipStatusTag, 30), nullable=True
    )
    status_note: Mapped[str | None] = mapped_column(String(VIP_NOTE_MAX), nullable=True)
    highlighted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("vip_items.id", ondelete="CASCADE"), nullable=True, index=True
    )
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    children: Mapped[list[VipItem]] = relationship(
        back_populates="parent",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="VipItem.sort_order",
    )
    parent: Mapped[VipItem | None] = relationship(
        back_populates="children", remote_side="VipItem.id"
    )

    __table_args__ = (
        CheckConstraint(AREA_CHECK, name="area_valid"),
        CheckConstraint(PILLAR_CHECK, name="pillar_valid"),
        CheckConstraint(STATUS_TAG_CHECK, name="status_tag_valid"),
        CheckConstraint("parent_id IS NULL OR parent_id <> id", name="parent_not_self"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<VipItem {self.area} {self.pillar} {self.title!r}>"
