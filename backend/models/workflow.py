from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, CheckConstraint, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin
from models.enums import WorkflowStepKind

if TYPE_CHECKING:
    from models.chamber import Chamber
    from models.engineer import Engineer
    from models.project import Project


class WorkflowStepTemplate(TimestampMixin, Base):
    """The 14-step PDD template, per docs/DOMAIN_RULES.md "Workflow template".
    A reference/lookup table, seeded once (P1-T03) from
    `domain_constants.WORKFLOW_STEP_TEMPLATE_SEED` and not expected to change.

    Primary key is the literal step ID (e.g. "PDD-A"), not a surrogate UUID —
    these IDs are part of the domain vocabulary itself and are referenced
    directly in the DOMAIN_RULES.md contract, so using them as the PK keeps
    every FK to this table self-documenting.
    """

    __tablename__ = "workflow_step_templates"

    id: Mapped[str] = mapped_column(String(10), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[WorkflowStepKind] = mapped_column(
        Enum(
            WorkflowStepKind,
            name="workflow_step_kind",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    base_weeks: Mapped[int] = mapped_column(Integer, nullable=False)
    #: 1-14, strictly sequential per Invariant I3.
    sequence_order: Mapped[int] = mapped_column(Integer, nullable=False, unique=True)

    project_steps: Mapped[list[ProjectWorkflowStep]] = relationship(back_populates="step_template")

    __table_args__ = (
        CheckConstraint("sequence_order BETWEEN 1 AND 14", name="sequence_order_range"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<WorkflowStepTemplate {self.id} {self.name!r}>"


class ProjectWorkflowStep(TimestampMixin, Base):
    """The live, current per-project instance of one of the 14 steps.

    Holds both the *planned* schedule (as computed by the most recent applied
    ScheduleRun — see backend/models/schedule.py for the versioned run
    snapshots this is sourced from) and the *actual* execution dates a Hub
    Planner records as the project progresses, per the Project Execution
    Timeline surface's "solid bars = planned; hatched bars = actual + delay"
    distinction (docs/PROJECT_AND_STACK.md §2). Per ADR 0004, `planned_*_week`
    is never retroactively shifted by delay — delay is a terminal adjustment
    surfaced separately (`Project.delay_weeks`, and the Gantt's red connector),
    not baked into these columns.

    `eng_conflict` / `chamber_overlap` mirror the ENG_CONFLICT / OVERLAP outcome
    flags (Invariants I1, I2) for this specific step of this specific project's
    live schedule.
    """

    __tablename__ = "project_workflow_steps"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)
    step_template_id: Mapped[str] = mapped_column(
        ForeignKey("workflow_step_templates.id"), nullable=False
    )
    #: Denormalised copy of WorkflowStepTemplate.sequence_order, for cheap
    #: ORDER BY / Invariant I3 checks without a join.
    sequence_order: Mapped[int] = mapped_column(Integer, nullable=False)

    #: max(1, round(base_weeks * category_multiplier)) at the time this
    #: instance was created/last recalculated — see
    #: `domain_constants.duration_weeks`.
    duration_weeks: Mapped[int] = mapped_column(Integer, nullable=False)

    planned_start_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    planned_end_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actual_start_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actual_end_week: Mapped[int | None] = mapped_column(Integer, nullable=True)

    #: Design steps only (docs/DOMAIN_RULES.md booking rules).
    assigned_engineer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("engineers.id"), nullable=True
    )
    #: Lab steps only.
    assigned_chamber_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("chambers.id"), nullable=True
    )

    eng_conflict: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    chamber_overlap: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    project: Mapped[Project] = relationship(back_populates="workflow_steps")
    step_template: Mapped[WorkflowStepTemplate] = relationship(back_populates="project_steps")
    assigned_engineer: Mapped[Engineer | None] = relationship(back_populates="led_project_steps")
    assigned_chamber: Mapped[Chamber | None] = relationship(back_populates="project_steps")

    __table_args__ = (
        UniqueConstraint("project_id", "step_template_id", name="uq_project_step_template"),
        UniqueConstraint("project_id", "sequence_order", name="uq_project_sequence_order"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<ProjectWorkflowStep project={self.project_id} step={self.step_template_id}>"
