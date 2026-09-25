from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Enum
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
    #: True for OEM-HCK / OEM-Seltek, per DOMAIN_RULES.md's CAT_NOT_ALLOWED rule
    #: ("... or OEM for OEM-hub projects"). Stored rather than derived by string-
    #: matching `name` in application code, to keep that rule's implementation
    #: (P2/P3) a single column read instead of scattered enum comparisons.
    is_oem: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    engineers: Mapped[list[Engineer]] = relationship(back_populates="hub")
    projects: Mapped[list[Project]] = relationship(back_populates="hub")
    user_scopes: Mapped[list[UserHubScope]] = relationship(back_populates="hub")

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<Hub {self.name.value if self.name else None}>"
