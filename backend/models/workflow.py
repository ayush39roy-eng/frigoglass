from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine.default import DefaultExecutionContext
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from models.base import Base, TimestampMixin
from models.category import category_code
from models.enums import WorkflowStepKind, WorkflowStepStatus

if TYPE_CHECKING:
    from models.chamber import Chamber
    from models.engineer import Engineer
    from models.project import Project


def _default_from(column: str) -> Callable[[DefaultExecutionContext], Any]:
    """A Python-side INSERT default equal to another column of the same row
    (P33, migration `p33b`): `effort_weight_weeks` defaults to `weeks`,
    `plan_weeks` to `duration_weeks` (the table value the row is created
    with), so every existing construction site keeps working."""

    def default(context: DefaultExecutionContext) -> Any:
        return context.get_current_parameters()[column]  # type: ignore[no-untyped-call]

    return default


class Workflow(TimestampMixin, Base):
    """One of the two workflows, per docs/DOMAIN_RULES.md "Workflow templates —
    two workflows, 14 steps each" (2026-09-27, ADR 0007): `PDD` for every
    non-OEM hub, `OEM` for `OEM-HCK`/`OEM-Seitek`. A project's workflow is a
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
    #: ADR 0047 (P33-T07): a `categories.code` (text + FK, RESTRICT).
    category: Mapped[str] = mapped_column(
        Text,
        ForeignKey("categories.code", onupdate="RESTRICT", ondelete="RESTRICT"),
        primary_key=True,
    )
    step_id: Mapped[str] = mapped_column(ForeignKey("workflow_step_templates.id"), primary_key=True)
    #: The category length (DOMAIN_RULES "Category templates" §A). Copied
    #: onto a project's `ProjectWorkflowStep.plan_weeks` at registration, a
    #: category change, a figure cleared and an apply (P33); it never reaches
    #: an existing project by itself.
    weeks: Mapped[int] = mapped_column(Integer, nullable=False)
    #: P33 (ADR 0046 §A, migration `p33b`): the signed gap, −104..104
    #: (negative = overlap, positive = wait; 0 on a workflow's first step,
    #: checked by the apply). Copied onto `plan_gap_weeks`.
    gap_weeks: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    #: P33 (R33-2, migration `p33b`): the R2 effort-split weights, 0..104,
    #: backfilled = `weeks`. **Immutable** (DB trigger
    #: `trg_workflow_lead_times_effort_weight`); a new row defaults to its
    #: `weeks`. `services.project_effort` splits a figure over these, never
    #: over `weeks`, so a template edit never reshapes a project's split.
    effort_weight_weeks: Mapped[int] = mapped_column(
        Integer, nullable=False, default=_default_from("weeks")
    )

    workflow: Mapped[Workflow] = relationship(back_populates="lead_times")
    step_template: Mapped[WorkflowStepTemplate] = relationship(back_populates="lead_times")

    __table_args__ = (
        CheckConstraint("weeks >= 0", name="weeks_non_negative"),
        CheckConstraint("gap_weeks BETWEEN -104 AND 104", name="gap_weeks_range"),
        CheckConstraint("effort_weight_weeks BETWEEN 0 AND 104", name="effort_weight_weeks_range"),
    )

    @validates("category")
    def _category_as_code(self, _key: str, value: object) -> str | None:
        """P33-T07: always a plain code string."""
        return category_code(value)

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

    # --- Step timing from the Gantt (docs/DOMAIN_RULES.md, ADR 0019) ---------
    # RETIRED (ADR 0048, migration `p33c_clear_step_timing`): the three
    # hand-set fields below (`duration_override_weeks`,
    # `start_not_before_week`, `overlap_weeks`) are always NULL (CHECK
    # `step_timing_retired`); no service reads or writes them. The columns
    # are dropped in P33-F01. Their history:
    #: The USER's duration for this step (1..104; ADR 0019, unchanged by ADR
    #: 0041 R4). Null = the derived effort (`effort_weeks`) or the lead-time
    #: table (`duration_weeks`) applies. Never revives a skipped step (table
    #: duration 0). A planner input: a schedule run never overwrites it.
    duration_override_weeks: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: ADR 0041 R4 (migration `p30a`): this step's share of the project's
    #: typed effort figure (`Project.design_effort_weeks` / `lab_effort_weeks`),
    #: 0..104, written only by `services.project_effort` (the exact split of
    #: `scheduling.effort_split`). 0 skips the step. Null = no derived effort.
    #: Effective duration = `duration_override_weeks ?? effort_weeks ??
    #: duration_weeks` (lead), never reviving a lead-0 step or a lab step
    #: without certification testing (`scheduling.step_effective_weeks`).
    #: Separate from the user's override so a re-derivation never clears it
    #: and "Reset timing" restores this value.
    effort_weeks: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: A `Not Started` step may not start before this week (1..HORIZON_WEEKS).
    #: Null = no floor. A planner input: a schedule run never overwrites it.
    start_not_before_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: ADR 0043 (migration `p32a_step_overlap`): weeks this step may overlap
    #: the work it waits for (1..104). Null = 0 = no overlap (0 is stored as
    #: null). Never on a workflow's first step. A planner input: a schedule
    #: run never overwrites it. Frozen projects ignore it.
    overlap_weeks: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)

    # --- The project's copy of its category template (P33, ADR 0046 §B) -------
    #: The project's own length for this step, 0..104 (migration `p33b`,
    #: backfilled from the table in force). Copied from the template's
    #: `weeks` at registration, on a category / workflow change and when an
    #: effort figure is cleared (not-reached steps only, R33-10 / OR-5), and
    #: by an apply (P33-T10) where the kind has no own effort figure (OR-4).
    #: `eff = plan_weeks` for a step whose kind has no own effort figure
    #: (`services.workflow_durations.live_step_effective_weeks`); unused
    #: (kept) while the kind follows the project's figure. Defaults to the
    #: row's `duration_weeks` on INSERT.
    plan_weeks: Mapped[int] = mapped_column(
        Integer, nullable=False, default=_default_from("duration_weeks")
    )
    #: The project's own signed gap, −104..104 (negative = overlap, positive
    #: = wait; DOMAIN_RULES §D). Reaches the run input as `overlap_weeks` /
    #: `wait_weeks` (contract F4).
    plan_gap_weeks: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # --- Manual step pins (P40, ADR 0054 ruling R40-1..R40-15) ----------------
    #: A person's fixed placement of this step: weeks `manual_start_week ..
    #: manual_end_week`, end inclusive (length `me − ms + 1`). Both set or both
    #: null; stored `1 <= ms <= me <= 52` (CHECK `step_pin_range`). Written only
    #: by `PUT /gantt/step-pins` (Admin / Super Admin) and cleared by it, by the
    #: stage leaving Not Started (`cause = "stage_started"`) or by a workflow
    #: re-point (`cause = "workflow_change"`), each with an audit row (I46). A
    #: schedule run never writes them. A placement, not effort: `eff` is
    #: unchanged by a pin (R40-3).
    manual_start_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    manual_end_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: The template apply that last wrote this row's copy (P33-T10).
    template_change_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("template_changes.id"), nullable=True
    )

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
        CheckConstraint("percent_complete BETWEEN 0 AND 100", name="percent_complete_range"),
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
        # ADR 0019 (migration p12a_step_timing).
        CheckConstraint(
            "duration_override_weeks IS NULL OR duration_override_weeks BETWEEN 1 AND 104",
            name="duration_override_range",
        ),
        CheckConstraint(
            "start_not_before_week IS NULL OR start_not_before_week BETWEEN 1 AND 78",
            name="start_not_before_range",
        ),
        # ADR 0041 R4 (migration p30a_effort_types_hub_rename).
        CheckConstraint(
            "effort_weeks IS NULL OR effort_weeks BETWEEN 0 AND 104",
            name="effort_weeks_range",
        ),
        # ADR 0043 (migration p32a_step_overlap).
        CheckConstraint(
            "overlap_weeks IS NULL OR overlap_weeks BETWEEN 1 AND 104",
            name="overlap_weeks_range",
        ),
        # ADR 0048 (migration p33c_clear_step_timing): per-project step
        # timing is retired; the three hand-set fields stay null until
        # P33-F01 drops them.
        CheckConstraint(
            "duration_override_weeks IS NULL AND start_not_before_week IS NULL "
            "AND overlap_weeks IS NULL",
            name="step_timing_retired",
        ),
        # P33 (migration p33b_template_copy).
        CheckConstraint("plan_weeks BETWEEN 0 AND 104", name="plan_weeks_range"),
        CheckConstraint("plan_gap_weeks BETWEEN -104 AND 104", name="plan_gap_weeks_range"),
        # P40 (migration p40a_step_pins, ADR 0054 R40-1).
        CheckConstraint(
            "(manual_start_week IS NULL AND manual_end_week IS NULL) OR ("
            "manual_start_week IS NOT NULL AND manual_end_week IS NOT NULL "
            "AND manual_start_week >= 1 AND manual_start_week <= manual_end_week "
            "AND manual_end_week <= 52)",
            name="step_pin_range",
        ),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<ProjectWorkflowStep project={self.project_id} step={self.step_template_id}>"


class TemplateChange(Base):
    """One category-template apply (P33, ADR 0045 §4 / contract P33 E3 step
    5; migration `p33b_template_copy`): who applied which template changes
    (before / after per (workflow, category, step)) with which selection.
    Written once by `POST /workflow-templates/apply` (P33-T10) in the apply's
    transaction; `ProjectWorkflowStep.template_change_id` points here for
    every copy it wrote. The audit log carries the same facts
    (`workflow_template.applied`); this row is the copies' provenance."""

    __tablename__ = "template_changes"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    #: Optional free text, ≤ 500 characters (contract E3).
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: `[{"workflow_id", "category", "base_version", "steps": [{"step_id",
    #: "weeks_before", "weeks_after", "gap_before", "gap_after"}]}]`.
    changes: Mapped[Any] = mapped_column(JSONB, nullable=False)
    #: `{"mode", "project_ids"}` as requested (contract E3).
    selection: Mapped[Any] = mapped_column(JSONB, nullable=False)

    __table_args__ = (
        CheckConstraint("reason IS NULL OR char_length(reason) <= 500", name="reason_length"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<TemplateChange {self.id}>"
