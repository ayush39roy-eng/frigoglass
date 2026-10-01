from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin
from models.enums import ProjectCategory, WorkflowStepKind, WorkflowStepStatus

if TYPE_CHECKING:
    from models.chamber import Chamber
    from models.engineer import Engineer
    from models.project import Project


class Workflow(TimestampMixin, Base):
    """One of the two workflows, per docs/DOMAIN_RULES.md "Workflow templates —
    two workflows, 14 steps each" (2026-09-27, ADR 0007): `PDD` for every
    non-OEM hub, `OEM` for `OEM-HCK`/`OEM-Seltek`. A project's workflow is a
    function of its hub (`Hub.is_oem`) — see `models.project.workflow_id_for_hub`.

    Primary key is the literal workflow ID ("PDD"/"OEM"), for the same reason
    `WorkflowStepTemplate.id` is the literal step ID: these are domain
    vocabulary, referenced by name in the contract.
    """

    __tablename__ = "workflows"

    id: Mapped[str] = mapped_column(String(10), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)

    step_templates: Mapped[list[WorkflowStepTemplate]] = relationship(
        back_populates="workflow", order_by="WorkflowStepTemplate.sequence_order"
    )
    lead_times: Mapped[list[WorkflowLeadTime]] = relationship(back_populates="workflow")

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<Workflow {self.id}>"


class WorkflowStepTemplate(TimestampMixin, Base):
    """One of the 14 steps of a workflow, per docs/DOMAIN_RULES.md "Workflow
    templates" (2026-09-27). Seeded from
    `domain_constants.WORKFLOW_STEP_TEMPLATE_SEED` (28 rows: PDD-A..N, OEM-A..N)
    by the P9-T01 migration and by `seed/seed_demo_data.py`.

    Primary key is the literal step ID (e.g. "PDD-A", "OEM-H"), not a surrogate
    UUID — these IDs are part of the domain vocabulary itself and are referenced
    directly in the DOMAIN_RULES.md contract, so using them as the PK keeps
    every FK to this table self-documenting. Step IDs are unchanged from the
    prototype era, so no historical `ScheduleRun` row is invalidated by the
    2026-09-27 rename of names/codes/kinds (ADR 0007).

    `predecessor_ids` (ADR 0009) is the configurable precedence DAG: a JSON list
    of step IDs *in the same workflow* that must end before this step starts.
    Seeded as the strict chain; Super Admin edits it on Workflow Settings. The
    server (P9-T03) rejects cycles, self-references, cross-workflow references
    and an empty set on any step but the first — a JSONB column cannot express
    those rules as a CHECK, so they are application-layer validation, not DB.
    `sequence_order` is display order and the deterministic walk/tie-break
    order only; it is not a dependency (DOMAIN_RULES.md "Precedence").

    There is deliberately no `base_weeks` column any more: durations come from
    `WorkflowLeadTime` (ADR 0007), never from a per-step base × multiplier.
    """

    __tablename__ = "workflow_step_templates"

    id: Mapped[str] = mapped_column(String(10), primary_key=True)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflows.id"), nullable=False)
    #: Client short code, e.g. "MKTG_BRF" (docs/CLIENT_FORMULAS.md §1). Not
    #: unique across workflows (both have "TECH_BRIEF", "CERT", ...).
    code: Mapped[str] = mapped_column(String(30), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[WorkflowStepKind] = mapped_column(
        Enum(
            WorkflowStepKind,
            name="workflow_step_kind",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    #: 1-14 within a workflow. Unique per `(workflow_id, sequence_order)`.
    sequence_order: Mapped[int] = mapped_column(Integer, nullable=False)
    predecessor_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)

    workflow: Mapped[Workflow] = relationship(back_populates="step_templates")
    project_steps: Mapped[list[ProjectWorkflowStep]] = relationship(back_populates="step_template")
    lead_times: Mapped[list[WorkflowLeadTime]] = relationship(back_populates="step_template")

    __table_args__ = (
        CheckConstraint("sequence_order BETWEEN 1 AND 14", name="sequence_order_range"),
        UniqueConstraint(
            "workflow_id", "sequence_order", name="uq_workflow_step_templates_workflow_sequence"
        ),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<WorkflowStepTemplate {self.id} {self.name!r}>"


class WorkflowLeadTime(Base):
    """The configurable lead-time table, per docs/DOMAIN_RULES.md "Lead times"
    (2026-09-27, ADR 0007): `duration_weeks = lead_time[workflow][category][step]`.
    Seeded verbatim from `domain_constants.LEAD_TIME_SEED` (98 rows = 7 category
    rows × 14 steps, transcribed from the client workbook — docs/CLIENT_FORMULAS.md
    §1). `weeks == 0` means the step is skipped for that category. There is no
    multiplier and no `max(1, …)` floor.

    Edited only on Workflow Settings (Super Admin, P9-T03); every edit is
    audit-logged and sets `Project.schedule_stale` on every schedulable project.
    """

    __tablename__ = "workflow_lead_times"

    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflows.id"), primary_key=True)
    category: Mapped[ProjectCategory] = mapped_column(
        Enum(
            ProjectCategory,
            name="project_category",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        primary_key=True,
    )
    step_id: Mapped[str] = mapped_column(
        ForeignKey("workflow_step_templates.id"), primary_key=True
    )
    weeks: Mapped[int] = mapped_column(Integer, nullable=False)

    workflow: Mapped[Workflow] = relationship(back_populates="lead_times")
    step_template: Mapped[WorkflowStepTemplate] = relationship(back_populates="lead_times")

    __table_args__ = (CheckConstraint("weeks >= 0", name="weeks_non_negative"),)

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<WorkflowLeadTime {self.workflow_id}/{self.category}/{self.step_id}={self.weeks}>"


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

    **Per-stage progress (ADR 0006, P8-T01 absorbed into P9-T01):** `status`,
    `percent_complete`, `remaining_weeks_override` and `blocked_reason` are the
    Project Workspace's advisory inputs to the scheduler; a schedule run never
    overwrites them. The consistency rules of DOMAIN_RULES.md's "Per-stage
    progress fields" table are enforced as CHECK constraints below (and
    re-checked by the solver, which rejects an inconsistent project as a data
    error rather than scheduling it from scratch).
    """

    __tablename__ = "project_workflow_steps"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)
    step_template_id: Mapped[str] = mapped_column(
        ForeignKey("workflow_step_templates.id"), nullable=False
    )
    #: Denormalised copy of WorkflowStepTemplate.sequence_order, for cheap
    #: ORDER BY without a join.
    sequence_order: Mapped[int] = mapped_column(Integer, nullable=False)

    #: `lead_time[workflow][category][step]` (ADR 0007) at the time this
    #: instance was created / last recomputed — see
    #: `services.workflow_durations`. `0` means the step is skipped for this
    #: project's category.
    duration_weeks: Mapped[int] = mapped_column(Integer, nullable=False)

    planned_start_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    planned_end_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actual_start_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actual_end_week: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # --- Per-stage progress capture (docs/DOMAIN_RULES.md, ADR 0006) ---------
    status: Mapped[WorkflowStepStatus] = mapped_column(
        Enum(
            WorkflowStepStatus,
            name="workflow_step_status",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
        default=WorkflowStepStatus.NOT_STARTED,
        server_default=WorkflowStepStatus.NOT_STARTED.value,
    )
    percent_complete: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    remaining_weeks_override: Mapped[int | None] = mapped_column(Integer, nullable=True)
    blocked_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

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
        CheckConstraint("duration_weeks >= 0", name="duration_non_negative"),
        CheckConstraint(
            "percent_complete BETWEEN 0 AND 100", name="percent_complete_range"
        ),
        CheckConstraint(
            "remaining_weeks_override IS NULL OR remaining_weeks_override >= 0",
            name="remaining_override_non_negative",
        ),
        # Done ⇒ percent 100, both actuals non-null, end >= start.
        CheckConstraint(
            "status <> 'Done' OR ("
            "percent_complete = 100 AND actual_start_week IS NOT NULL "
            "AND actual_end_week IS NOT NULL AND actual_end_week >= actual_start_week)",
            name="status_done_consistency",
        ),
        # Not Started ⇒ percent 0, both actuals null.
        CheckConstraint(
            "status <> 'Not Started' OR ("
            "percent_complete = 0 AND actual_start_week IS NULL AND actual_end_week IS NULL)",
            name="status_not_started_consistency",
        ),
        # In Progress / Blocked ⇒ actual_start non-null, actual_end null.
        CheckConstraint(
            "status NOT IN ('In Progress', 'Blocked') OR ("
            "actual_start_week IS NOT NULL AND actual_end_week IS NULL)",
            name="status_active_consistency",
        ),
        # Blocked ⇒ blocked_reason non-empty; otherwise blocked_reason null.
        CheckConstraint(
            "(status = 'Blocked' AND blocked_reason IS NOT NULL "
            "AND length(btrim(blocked_reason)) > 0) "
            "OR (status <> 'Blocked' AND blocked_reason IS NULL)",
            name="status_blocked_reason_consistency",
        ),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<ProjectWorkflowStep project={self.project_id} step={self.step_template_id}>"
