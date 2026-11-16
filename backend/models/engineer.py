from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Final

from sqlalchemy import (
    ARRAY,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.category import category_codes

if TYPE_CHECKING:
    from models.hub import Hub
    from models.project import ProjectWorkflowStep
    from models.schedule import ScheduleRunProjectStep
    from models.user import User


#: P38 (ADR 0053 §1, OQ #97): the fixed deactivation reason codes.
DEACTIVATION_REASONS: Final[tuple[str, ...]] = (
    "left_company",
    "changed_role",
    "long_absence",
    "other",
)


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

    # --- P38 (ADR 0053, migration p38a_engineer_deactivation) ------------------
    #: False once deactivated. Equals "has an open `engineer_inactive_periods`
    #: row" (I42; deferred constraint triggers check both at COMMIT). Engineers
    #: are never deleted (`DELETE /engineers/{id}` answers 410).
    active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: The calendar week (`plan_clock`, 1..52) of the deactivation; it counts
    #: as worked. 52 while `plan_year_closed` (R38-7).
    deactivated_week: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    #: The served `plan_year`, not the ISO year.
    deactivated_plan_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: The actor. Stored and audited, never served (contract §1).
    deactivated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    #: One of `DEACTIVATION_REASONS`; a code, never free text (OQ #97).
    deactivation_reason: Mapped[str | None] = mapped_column(String(20), nullable=True)

    hub: Mapped[Hub] = relationship(back_populates="engineers")
    user: Mapped[User | None] = relationship(back_populates="engineer", foreign_keys=[user_id])
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


class EngineerInactivePeriod(Base):
    """P38 (ADR 0053 §2): one row per deactivation, closed by a reactivation.

    The whole-week rule (DOMAIN_RULES "Engineer deactivation"): a period
    covers weeks `from_week + 1 .. to_week` of its plan year; an open one runs
    to 52 and covers every later plan year (`scheduling.covered_plan_weeks`).
    At most one open row per engineer (partial unique index). Supply reads
    this table (R38-1); `Engineer.active` is the fast filter.
    """

    __tablename__ = "engineer_inactive_periods"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    engineer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("engineers.id"), nullable=False)
    from_plan_year: Mapped[int] = mapped_column(Integer, nullable=False)
    from_week: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    to_plan_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    to_week: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ProjectLeaderHistory(Base):
    """P38 (ADR 0053 §6, R38-6): one append-only row per leader change, on
    every write path, from P38 on (no backfill).

    `engineer_id` is the leader before the change (null when the project had
    none): the "Former leader" of the Workspace, until `to_week`.
    `new_engineer_id` is the leader after it (null = cleared to "No leader").
    `from_week` is the calendar week that former leader's tenure began when a
    row recorded it, else null. Weeks are calendar weeks of `plan_year`.
    UPDATE is rejected by a trigger; DELETE only in the admin reseed.
    """

    __tablename__ = "project_leader_history"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)
    engineer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("engineers.id"), nullable=True)
    new_engineer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("engineers.id"), nullable=True
    )
    plan_year: Mapped[int] = mapped_column(Integer, nullable=False)
    from_week: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    to_week: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    #: `registration` | `project_update` | `register_edit` | `engineer_deactivated`.
    cause: Mapped[str] = mapped_column(String(40), nullable=False)
    changed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
