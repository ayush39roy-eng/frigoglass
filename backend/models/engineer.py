from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ARRAY, Boolean, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.category import category_codes

if TYPE_CHECKING:
    from models.hub import Hub
    from models.project import ProjectWorkflowStep
    from models.schedule import ScheduleRunProjectStep
    from models.user import User


class Engineer(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A design-step scheduling resource, per docs/DOMAIN_RULES.md's booking
    rules ("Design step: the project's assigned leader must be free..."). Also
    doubles as the pool of eligible project leaders (Project.leader_engineer_id).

    `fte` gates scheduling speed (ADR 0032, superseding ADR 0002; answers
    docs/OPEN_QUESTIONS.md #2): a design step of a non-frozen project led by
    this engineer books `ceil(duration_weeks / fte)` consecutive elapsed weeks
    (`scheduling.fte_span`), while `duration_weeks` stays the effort figure
    that load and booked % sum. It is also the supply multiplier on Capacity
    (`working_weeks × Σ fte`, ADR 0008). An FTE <= 0 with design work left is
    a `data_error` in the scheduler; the API refuses it (`gt=0`).
    """

    __tablename__ = "engineers"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    #: ADR 0042: an engineer's hub is always a *capacity* hub (a hub with no
    #: `capacity_hub_id`); the API refuses a member hub (`HUB_NOT_CAPACITY_HUB`).
    hub_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("hubs.id"), nullable=False)
    #: ADR 0042 §5: whether this engineer's FTE is part of the hub's design
    #: supply (`yearly_design_capacity = working_weeks × Σ fte`, ADR 0008).
    #: False for a project leader who is on no client roster (Theoni, Dipak,
    #: Antonis, Sailesh; docs/OPEN_QUESTIONS.md #52): the scheduler still books
    #: them because they lead projects, but they are never counted as supply.
    #: Editable by Admin / Super Admin only (`PATCH /engineers/{id}`), audited.
    counts_in_capacity: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    #: 0 < fte <= 1 in the reference data (e.g. 0.5, 0.8, 1.0), but not DB-
    #: constrained to that range in case a future client answer allows >1.0
    #: (multi-role) — left to app-layer validation.
    fte: Mapped[float] = mapped_column(Numeric(3, 2), nullable=False, default=1.0)

    #: Categories (plus optionally "OEM") this engineer may lead, per
    #: DOMAIN_RULES.md's CAT_NOT_ALLOWED rule. ADR 0047 (P33-T07): a `text[]`
    #: of `categories.code` values or the reserved blanket `OEM` ("any
    #: OEM-workflow category"); an array cannot carry an FK, so the trigger
    #: `trg_engineers_allowed_categories_known` (migration `p33a_categories`)
    #: rejects any other element. Element order is preserved (it reaches the
    #: hashed scheduler input as-is).
    allowed_categories: Mapped[list[str]] = mapped_column(
        ARRAY(Text),
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

    @validates("allowed_categories")
    def _allowed_as_codes(self, _key: str, value: object) -> list[str | None] | None:
        """P33-T07: always plain code strings (enum members are accepted from
        seed / test code and stored as their values; order kept)."""
        return category_codes(value)  # type: ignore[arg-type]

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<Engineer {self.name!r}>"
