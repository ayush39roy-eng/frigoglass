from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ARRAY, Enum, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import EngineerAllowedCategory

if TYPE_CHECKING:
    from models.hub import Hub
    from models.project import ProjectWorkflowStep
    from models.schedule import ScheduleRunProjectStep
    from models.user import User


class Engineer(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A design-step scheduling resource, per docs/DOMAIN_RULES.md's booking
    rules ("Design step: the project's assigned leader must be free..."). Also
    doubles as the pool of eligible project leaders (Project.leader_engineer_id).

    `fte` and its effect (or lack thereof) on scheduling: per ADR 0002, FTE is
    a stored, reportable field used by the Capacity Planning surface's display,
    but does NOT gate the greedy/CP-SAT scheduler's booking rules in v1 — an
    engineer is treated as fully available for every week they aren't already
    booked, regardless of `fte`. This is a provisional decision; see
    docs/OPEN_QUESTIONS.md #2 and docs/MEMORY.md 2026-08-29 22:15 entry.
    """

    __tablename__ = "engineers"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    hub_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("hubs.id"), nullable=False)

    #: 0 < fte <= 1 in the reference data (e.g. 0.5, 0.8, 1.0), but not DB-
    #: constrained to that range in case a future client answer allows >1.0
    #: (multi-role) — left to app-layer validation.
    fte: Mapped[float] = mapped_column(Numeric(3, 2), nullable=False, default=1.0)

    #: Categories (plus optionally "OEM") this engineer may lead, per
    #: DOMAIN_RULES.md's CAT_NOT_ALLOWED rule. Postgres ARRAY of the
    #: EngineerAllowedCategory enum.
    allowed_categories: Mapped[list[EngineerAllowedCategory]] = mapped_column(
        ARRAY(
            Enum(
                EngineerAllowedCategory,
                name="engineer_allowed_category",
                values_callable=lambda enum_cls: [e.value for e in enum_cls],
            )
        ),
        nullable=False,
        default=list,
    )

    #: Optional link to a User account, so an "Engineer" role user (per
    #: docs/PROJECT_AND_STACK.md §5 RBAC matrix, "Engineer -> R (own
    #: assignments)") can see their own assignments. Nullable: not every
    #: Engineer row necessarily has application login access.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True, unique=True
    )

    hub: Mapped[Hub] = relationship(back_populates="engineers")
    user: Mapped[User | None] = relationship(back_populates="engineer")
    led_project_steps: Mapped[list[ProjectWorkflowStep]] = relationship(
        back_populates="assigned_engineer"
    )
    scheduled_run_steps: Mapped[list[ScheduleRunProjectStep]] = relationship(
        back_populates="assigned_engineer"
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<Engineer {self.name!r}>"
