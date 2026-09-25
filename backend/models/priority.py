from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    ARRAY,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    Numeric,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import HardGateReason, ProjectPriority

if TYPE_CHECKING:
    from models.project import Project


#: The 13 dimension field names, in docs/DOMAIN_RULES.md's table order. Kept in
#: sync manually with the columns below and with
#: `domain_constants.PRIORITIZATION_DIMENSIONS` — see that module for the
#: (pillar, display_name, field_name, weight) tuples this list's names must
#: match.
DIMENSION_FIELD_NAMES: tuple[str, ...] = (
    "strategic_project",
    "new_customer",
    "new_options",
    "regulatory_compliance",
    "quality_improvements",
    "rm_savings",
    "total_rm_savings",
    "gross_margins",
    "profitability",
    "annual_volume",
    "three_year_volume",
    "new_models",
    "capex_investment",
)


def _dimension_check_constraints() -> tuple[CheckConstraint, ...]:
    return tuple(
        CheckConstraint(f"{name} BETWEEN 1 AND 5", name=f"{name}_score_range")
        for name in DIMENSION_FIELD_NAMES
    )


class PriorityScore(TimestampMixin, Base):
    """The 13-dimension prioritization scoring grid for one project, per
    docs/DOMAIN_RULES.md "Prioritization scoring — 13 dimensions". One row per
    project (current/latest scoring inputs) — historical snapshots of what was
    computed *from* these inputs on each "Apply Priorities" action live in
    `PriorityApplicationResult` below, not here.

    `weighted_score` / `normalized_pct` / `suggested_band` are cached results of
    the deterministic formula in DOMAIN_RULES.md
    (`weighted_score = sum(dimension_score * weight)`,
    `normalised_pct = round(weighted_score / (280*5) * 100)`, banded per the
    thresholds table) — recomputed by the service layer (P3) whenever a
    dimension score changes, not an independent calculation. `suggested_band`
    may differ from `Project.priority` ("set_priority") if a Portfolio Manager
    manually overrides it on the Prioritization Matrix surface.
    """

    __tablename__ = "priority_scores"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id"), unique=True, nullable=False
    )

    strategic_project: Mapped[int] = mapped_column(Integer, nullable=False)
    new_customer: Mapped[int] = mapped_column(Integer, nullable=False)
    new_options: Mapped[int] = mapped_column(Integer, nullable=False)
    regulatory_compliance: Mapped[int] = mapped_column(Integer, nullable=False)
    quality_improvements: Mapped[int] = mapped_column(Integer, nullable=False)
    rm_savings: Mapped[int] = mapped_column(Integer, nullable=False)
    total_rm_savings: Mapped[int] = mapped_column(Integer, nullable=False)
    gross_margins: Mapped[int] = mapped_column(Integer, nullable=False)
    profitability: Mapped[int] = mapped_column(Integer, nullable=False)
    annual_volume: Mapped[int] = mapped_column(Integer, nullable=False)
    three_year_volume: Mapped[int] = mapped_column(Integer, nullable=False)
    new_models: Mapped[int] = mapped_column(Integer, nullable=False)
    capex_investment: Mapped[int] = mapped_column(Integer, nullable=False)

    #: Active hard gates, per DOMAIN_RULES.md "Hard gates (override band, force
    #: P1)". Non-empty => Project.priority must be pinned to P1 at the API layer.
    hard_gates: Mapped[list[HardGateReason]] = mapped_column(
        ARRAY(
            Enum(
                HardGateReason,
                name="hard_gate_reason",
                values_callable=lambda enum_cls: [e.value for e in enum_cls],
            )
        ),
        nullable=False,
        default=list,
    )

    weighted_score: Mapped[float | None] = mapped_column(Numeric(8, 2), nullable=True)
    normalized_pct: Mapped[int | None] = mapped_column(Integer, nullable=True)
    suggested_band: Mapped[ProjectPriority | None] = mapped_column(
        Enum(
            ProjectPriority,
            name="project_priority",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=True,
    )

    scored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    scored_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )

    project: Mapped[Project] = relationship(back_populates="priority_score")

    __table_args__ = _dimension_check_constraints()

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<PriorityScore project={self.project_id} band={self.suggested_band}>"


class PriorityApplicationRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One "Apply Priorities" action (Prioritization Matrix surface,
    docs/PROJECT_AND_STACK.md §2), versioned per the cross-cutting "Versions &
    History" requirement ("every schedule run and every priority application is
    versioned"). Mirrors the ScheduleRun / ScheduleRunProjectStep pattern in
    backend/models/schedule.py.
    """

    __tablename__ = "priority_application_runs"

    version: Mapped[int] = mapped_column(Integer, nullable=False, unique=True)
    #: Only one PriorityApplicationRun is "active" (the currently committed
    #: state) at a time — enforced by a partial unique index in the P1-T02
    #: migration (`WHERE is_active`), not expressible as a plain column
    #: constraint in the ORM layer alone.
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    applied_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    notes: Mapped[str | None] = mapped_column(nullable=True)

    results: Mapped[list[PriorityApplicationResult]] = relationship(back_populates="run")


class PriorityApplicationResult(Base):
    """Per-project snapshot of the 13 dimension scores and computed band as of
    one PriorityApplicationRun — the historical record "Versions & History"
    browses/compares. Immutable once written (append-only in spirit, like
    AuditLogEntry, though not the audit log itself).
    """

    __tablename__ = "priority_application_results"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    priority_application_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("priority_application_runs.id"), nullable=False
    )
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)

    weighted_score: Mapped[float] = mapped_column(Numeric(8, 2), nullable=False)
    normalized_pct: Mapped[int] = mapped_column(Integer, nullable=False)
    suggested_band: Mapped[ProjectPriority] = mapped_column(
        Enum(
            ProjectPriority,
            name="project_priority",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    #: The priority actually committed for this project as of this run (may
    #: differ from suggested_band on manual override, or be pinned to P1 by a
    #: hard gate).
    set_priority: Mapped[ProjectPriority] = mapped_column(
        Enum(
            ProjectPriority,
            name="project_priority",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    hard_gates: Mapped[list[HardGateReason]] = mapped_column(
        ARRAY(
            Enum(
                HardGateReason,
                name="hard_gate_reason",
                values_callable=lambda enum_cls: [e.value for e in enum_cls],
            )
        ),
        nullable=False,
        default=list,
    )

    run: Mapped[PriorityApplicationRun] = relationship(back_populates="results")
    project: Mapped[Project] = relationship()

    __table_args__ = (
        CheckConstraint("normalized_pct BETWEEN 0 AND 100", name="normalized_pct_range"),
        UniqueConstraint(
            "priority_application_run_id", "project_id", name="uq_priority_result_run_project"
        ),
    )
