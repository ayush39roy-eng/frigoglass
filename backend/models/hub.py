from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, CheckConstraint, Enum, ForeignKey, Integer, Numeric
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import HubName, LabRegion

if TYPE_CHECKING:
    from models.engineer import Engineer
    from models.project import Project
    from models.user import UserHubScope


class Hub(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One of the six hubs, per docs/DOMAIN_RULES.md "Hubs and lab-region
    mapping". Seeded once (P1-T03); not expected to change often, but modelled
    as a real table (not a bare enum) since Engineer/Project/User-scoping all
    need a stable FK target and Admin may need to manage hub metadata later.
    """

    __tablename__ = "hubs"

    name: Mapped[HubName] = mapped_column(
        Enum(
            HubName,
            name="hub_name",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        unique=True,
        nullable=False,
    )
    lab_region: Mapped[LabRegion] = mapped_column(
        Enum(
            LabRegion,
            name="lab_region",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    #: True for OEM-HCK / OEM-Seitek, per DOMAIN_RULES.md's CAT_NOT_ALLOWED rule
    #: ("... or OEM for OEM-hub projects"). Stored rather than derived by string-
    #: matching `name` in application code, to keep that rule's implementation
    #: (P2/P3) a single column read instead of scattered enum comparisons.
    is_oem: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    #: ADR 0042 (P29): the hub whose engineers, work calendar and design supply
    #: serve this hub's projects. `None` = this hub is its own capacity hub.
    #: OEM-HCK and OEM-Seitek point at R&D-Greece (seed and migration
    #: `p29a_capacity_hubs`). A capacity hub has no capacity hub of its own:
    #: the CHECK below refuses a self-reference and the trigger
    #: `trg_hubs_capacity_hub_flat` refuses a chain (member of a member) and a
    #: capacity hub becoming a member. Capacity surfaces group by this
    #: (`services.capacity_hubs`); every other surface keeps the six hubs.
    capacity_hub_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("hubs.id"), nullable=True
    )

    engineers: Mapped[list[Engineer]] = relationship(back_populates="hub")
    projects: Mapped[list[Project]] = relationship(back_populates="hub")
    user_scopes: Mapped[list[UserHubScope]] = relationship(back_populates="hub")
    work_calendar: Mapped[HubWorkCalendar | None] = relationship(
        back_populates="hub", uselist=False
    )
    capacity_hub: Mapped[Hub | None] = relationship(
        "Hub", remote_side="Hub.id", foreign_keys=[capacity_hub_id], back_populates="member_hubs"
    )
    member_hubs: Mapped[list[Hub]] = relationship(
        "Hub", foreign_keys=[capacity_hub_id], back_populates="capacity_hub"
    )

    __table_args__ = (
        CheckConstraint(
            "capacity_hub_id IS NULL OR capacity_hub_id <> id",
            name="capacity_hub_not_self",
        ),
    )

    @property
    def effective_capacity_hub_id(self) -> uuid.UUID:
        """`capacity_hub_id`, or this hub's own id (ADR 0042)."""

        return self.capacity_hub_id or self.id

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<Hub {self.name.value if self.name else None}>"


class HubWorkCalendar(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Per-hub working calendar feeding the Capacity surface's *supply* figures
    (docs/DOMAIN_RULES.md "Capacity supply", 2026-09-27, ADR 0008):

        deduction_weeks            = Σ(days / weekdays_per_week)
        working_weeks_per_engineer = weeks_in_year − deduction_weeks
        yearly_design_capacity     = working_weeks_per_engineer × Σ engineer.fte

    Exactly one row per hub (`hub_id` unique). Seeded from
    `domain_constants.HUB_WORK_CALENDAR_SEED` (docs/CLIENT_FORMULAS.md §2.1).
    Editable on Capacity Planning (Hub Planner, own hub) and Workflow Settings
    (Super Admin); audit-logged (P9-T03). The calendar (working weeks,
    downtime) is supply reporting only and never gates week-level booking.
    Engineer FTE does gate design speed (ADR 0032, superseding ADR 0002).
    """

    __tablename__ = "hub_work_calendars"

    hub_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("hubs.id"), nullable=False, unique=True
    )
    weekdays_per_week: Mapped[int] = mapped_column(Integer, nullable=False)
    national_holiday_days: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    medical_leave_days: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    casual_leave_days: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    annual_leave_days: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    weeks_in_year: Mapped[int] = mapped_column(
        Integer, nullable=False, default=52, server_default="52"
    )

    hub: Mapped[Hub] = relationship(back_populates="work_calendar")

    __table_args__ = (
        CheckConstraint("weekdays_per_week BETWEEN 1 AND 7", name="weekdays_per_week_range"),
        CheckConstraint("national_holiday_days >= 0", name="national_holiday_days_non_negative"),
        CheckConstraint("medical_leave_days >= 0", name="medical_leave_days_non_negative"),
        CheckConstraint("casual_leave_days >= 0", name="casual_leave_days_non_negative"),
        CheckConstraint("annual_leave_days >= 0", name="annual_leave_days_non_negative"),
        CheckConstraint("weeks_in_year > 0", name="weeks_in_year_positive"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<HubWorkCalendar hub={self.hub_id}>"
