from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Enum, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import ProjectCategory, ProjectPriority, ProjectStatus, ProjectType
from models.types import EncryptedNumeric, EncryptedString

if TYPE_CHECKING:
    from models.engineer import Engineer
    from models.hub import Hub
    from models.priority import PriorityScore
    from models.schedule import ScheduleRunProjectOutcome, ScheduleRunProjectStep
    from models.workflow import ProjectWorkflowStep


class Project(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A single R&D/PD project moving through the 14-step PDD workflow.

    Financial fields (`tcogs_eur`, `selling_price_eur`, `gross_margin_pct`,
    `customer_name`) use `EncryptedString`/`EncryptedNumeric` (backend/models/
    types.py) per CLAUDE.md's non-negotiable — these four, and only these four,
    are the fields CLAUDE.md and docs/DOMAIN_RULES.md name explicitly. `capex_keur`
    and `rm_savings_keur` are financial-*adjacent* scoring inputs but are not in
    that named list; they are left as plain (unencrypted) Numeric columns. This
    is a judgement call, not a DOMAIN_RULES.md instruction either way — flagged
    for security-auditor's P1-T06 review in case the encrypted set should be
    broadened.

    `roi` and `payback_yrs` (seen in the prototype's export column headers,
    derived as `(selling_price - tcogs) / capex` etc.) are intentionally NOT
    persisted columns — they are pure derivations of already-stored values and
    would otherwise be a second, driftable source of truth. Compute them at the
    API/read-model layer (P3) instead.
    """

    __tablename__ = "projects"

    name: Mapped[str] = mapped_column(String(300), nullable=False)
    #: Optional legacy/spreadsheet reference code, for P7 data migration
    #: traceability. Not the primary key.
    external_code: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)

    hub_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("hubs.id"), nullable=False)
    leader_engineer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("engineers.id"), nullable=True
    )

    #: Nullable to allow ProjectStatus.DRAFT rows before Project Registration's
    #: hard gates are satisfied (docs/PROJECT_AND_STACK.md §2). The API layer
    #: (P3) is responsible for enforcing "required before leaving draft", not a
    #: DB NOT NULL constraint, since that would make saving a draft impossible.
    category: Mapped[ProjectCategory | None] = mapped_column(
        Enum(
            ProjectCategory,
            name="project_category",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=True,
    )
    #: See models/enums.py ProjectType docstring: sourced from the prototype,
    #: not DOMAIN_RULES.md. Flagged for orchestrator review.
    type: Mapped[ProjectType | None] = mapped_column(
        Enum(
            ProjectType,
            name="project_type",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=True,
    )

    status: Mapped[ProjectStatus] = mapped_column(
        Enum(
            ProjectStatus,
            name="project_status",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
        default=ProjectStatus.DRAFT,
    )
    #: The committed/working priority used by the scheduler's sort order
    #: (docs/DOMAIN_RULES.md "Scheduling order"). This is the prototype's
    #: "set_priority" — may differ from PriorityScore.suggested_band if a
    #: Portfolio Manager manually overrides the computed band (Prioritization
    #: Matrix surface). Hard gates (PriorityScore.hard_gates) pin this to P1 at
    #: the API layer when set (docs/DOMAIN_RULES.md "Hard gates").
    priority: Mapped[ProjectPriority | None] = mapped_column(
        Enum(
            ProjectPriority,
            name="project_priority",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=True,
    )

    #: Locks `actual_start_week` and excludes the project from re-scheduling,
    #: per docs/DOMAIN_RULES.md booking rules and Invariant I10.
    frozen: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    #: Week number (against the 78-week horizon / CURRENT_WEEK=31 convention),
    #: not a calendar date — matches DOMAIN_RULES.md's week-integer model.
    actual_start_week: Mapped[int | None] = mapped_column(Integer, nullable=True)

    #: Terminal delay adjustment (weeks), per ADR 0004 — added only to the
    #: completing-within-year check (`last_step_end + delay <= WITHIN_YEAR_WEEK`),
    #: never propagated into individual step start/end times.
    delay_weeks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    reg_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    carry_over: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    comments: Mapped[str | None] = mapped_column(Text, nullable=True)

    # --- Encrypted financial fields (CLAUDE.md non-negotiable) ---
    customer_name: Mapped[str | None] = mapped_column(EncryptedString, nullable=True)
    tcogs_eur: Mapped[object | None] = mapped_column(EncryptedNumeric, nullable=True)
    selling_price_eur: Mapped[object | None] = mapped_column(EncryptedNumeric, nullable=True)
    gross_margin_pct: Mapped[object | None] = mapped_column(EncryptedNumeric, nullable=True)

    # --- Plain (unencrypted) financial-adjacent scoring inputs ---
    capex_keur: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    rm_savings_keur: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)

    hub: Mapped[Hub] = relationship(back_populates="projects")
    leader_engineer: Mapped[Engineer | None] = relationship()
    workflow_steps: Mapped[list[ProjectWorkflowStep]] = relationship(
        back_populates="project", order_by="ProjectWorkflowStep.sequence_order"
    )
    priority_score: Mapped[PriorityScore | None] = relationship(back_populates="project")
    schedule_run_steps: Mapped[list[ScheduleRunProjectStep]] = relationship(
        back_populates="project"
    )
    schedule_run_outcomes: Mapped[list[ScheduleRunProjectOutcome]] = relationship(
        back_populates="project"
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        # Never include financial fields here — __repr__ output can end up in
        # logs/tracebacks.
        return f"<Project {self.id} {self.name!r} status={self.status}>"
