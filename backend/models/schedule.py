from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import ScheduleRunStatus, SolverType

if TYPE_CHECKING:
    from models.chamber import Chamber
    from models.engineer import Engineer
    from models.project import Project


class ScheduleRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One full run of the scheduler (greedy SGS or CP-SAT) over the whole
    portfolio, per docs/PROJECT_AND_STACK.md §2's "every schedule run ... is
    versioned; historical versions are browsable and comparable" and
    Invariant I8 (determinism).

    Dispatch: CP-SAT runs always go through a Celery task in `solver-worker`
    (CLAUDE.md non-negotiable) — `celery_task_id` links this row to that job for
    SSE progress relay (docs/PROJECT_AND_STACK.md §4). This model has no
    scheduling logic of its own; it is a record of inputs/status/results around
    a call into `scheduling/` (algorithm-engineer's package), never a
    reimplementation of it.

    Only one ScheduleRun is `is_active` (the currently committed/live schedule)
    at a time — the source every Dashboard/Capacity/Matrix/Gantt figure must
    read from, per Invariant I9 ("within_year count ... no independent
    calculation anywhere"). Enforced by a partial unique index in the P1-T02
    migration (`WHERE is_active`).
    """

    __tablename__ = "schedule_runs"

    version: Mapped[int] = mapped_column(Integer, nullable=False, unique=True)
    solver_type: Mapped[SolverType] = mapped_column(
        Enum(
            SolverType,
            name="solver_type",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    status: Mapped[ScheduleRunStatus] = mapped_column(
        Enum(
            ScheduleRunStatus,
            name="schedule_run_status",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
        default=ScheduleRunStatus.QUEUED,
    )
    celery_task_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    #: Snapshotted per run rather than read live from domain_constants, so a
    #: historical run remains reproducible/interpretable even if these
    #: constants are ever revised (docs/DOMAIN_RULES.md "Horizon constants").
    horizon_weeks: Mapped[int] = mapped_column(Integer, nullable=False, default=78)
    current_week: Mapped[int] = mapped_column(Integer, nullable=False, default=31)

    #: CP-SAT's objective value. Null for greedy runs (no objective function).
    objective_value: Mapped[float | None] = mapped_column(Numeric(14, 4), nullable=True)

    triggered_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    #: e.g. "apply_priorities", "manual_recalc", "capacity_change" — free text,
    #: not an enum, since the set of trigger reasons is expected to grow in P3/P5.
    trigger_reason: Mapped[str | None] = mapped_column(String(100), nullable=True)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: The workflow settings in force when this run was created (ADR 0009,
    #: Invariant I15), so a historical run stays explainable after a
    #: Workflow Settings edit:
    #:   {"workflows": [{"id", "steps": [{"step_id", "code", "name", "kind",
    #:                                    "sequence_order", "predecessor_ids"}]}],
    #:    "lead_times": [{"workflow_id", "category", "step_id", "weeks"}]}
    #: Nullable only for runs that pre-date P9-T01.
    workflow_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    #: DOMAIN_RULES "Gate remediation rulings" 6 (P9-R02): the solver's own
    #: verdict for this run, e.g. "OPTIMAL" / "FEASIBLE" for CP-SAT. NULL when
    #: unknown (runs before migration c41f7e9a2b58, or a solver that reports
    #: none).
    solver_status: Mapped[str | None] = mapped_column(String(50), nullable=True)

    project_steps: Mapped[list[ScheduleRunProjectStep]] = relationship(
        back_populates="schedule_run"
    )
    project_outcomes: Mapped[list[ScheduleRunProjectOutcome]] = relationship(
        back_populates="schedule_run"
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<ScheduleRun v{self.version} {self.solver_type} {self.status}>"


class ScheduleRunProjectStep(Base):
    """Immutable per-run snapshot of one project-step's computed schedule
    (planned, undelayed per ADR 0004). Same shape as
    `ProjectWorkflowStep` (backend/models/workflow.py) but tied to a specific
    ScheduleRun instead of being the mutable "live" record — this is what
    Versions & History (P5) diffs across runs.

    `eng_conflict` / `chamber_overlap` correspond to Invariants I1/I2's
    ENG_CONFLICT / OVERLAP outcomes, raised only when the responsible project is
    frozen (docs/DOMAIN_RULES.md booking rules).
    """

    __tablename__ = "schedule_run_project_steps"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    schedule_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("schedule_runs.id"), nullable=False
    )
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)
    step_template_id: Mapped[str] = mapped_column(
        ForeignKey("workflow_step_templates.id"), nullable=False
    )
    sequence_order: Mapped[int] = mapped_column(Integer, nullable=False)
    duration_weeks: Mapped[int] = mapped_column(Integer, nullable=False)

    start_week: Mapped[int] = mapped_column(Integer, nullable=False)
    end_week: Mapped[int] = mapped_column(Integer, nullable=False)

    assigned_engineer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("engineers.id"), nullable=True
    )
    assigned_chamber_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("chambers.id"), nullable=True
    )

    eng_conflict: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    chamber_overlap: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    #: ADR 0007: `duration_weeks == 0` for this category, or a lab step when the
    #: project's `certification_testing_required` is false. Occupies nothing;
    #: `start_week == end_week == max(predecessor end)` (Invariant I5).
    skipped: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    schedule_run: Mapped[ScheduleRun] = relationship(back_populates="project_steps")
    project: Mapped[Project] = relationship(back_populates="schedule_run_steps")
    assigned_engineer: Mapped[Engineer | None] = relationship(back_populates="scheduled_run_steps")
    assigned_chamber: Mapped[Chamber | None] = relationship(back_populates="scheduled_run_steps")

    __table_args__ = (
        UniqueConstraint(
            "schedule_run_id", "project_id", "step_template_id", name="uq_run_project_step"
        ),
    )


class ScheduleRunProjectOutcome(Base):
    """Immutable per-run, per-project outcome record: LEFT_OUT, CAT_NOT_ALLOWED,
    SPILLOVER and the within-year determination, per docs/DOMAIN_RULES.md
    booking rules and Invariants I5/I9. `delay_weeks_applied` is a copy of
    `Project.delay_weeks` taken at run time (per ADR 0004's terminal-adjustment
    model) so this snapshot stays reproducible even if the live project's
    `delay_weeks` value is edited later.
    """

    __tablename__ = "schedule_run_project_outcomes"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    schedule_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("schedule_runs.id"), nullable=False
    )
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)

    left_out: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    cat_not_allowed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    spillover: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    #: `!left_out AND (last_step_end + delay <= WITHIN_YEAR_WEEK)`, per
    #: DOMAIN_RULES.md "Completing within year" — this is the single value
    #: Invariant I9 says the Dashboard's within_year count must be derived from.
    within_year: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    last_step_end_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    delay_weeks_applied: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # --- docs/DOMAIN_RULES.md "Expected vs projected completion" (I16) ------
    #: Earliest finish assuming unlimited engineers and chambers (pure
    #: by-product of the scheduler).
    unconstrained_end_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: `project.target_end_week` if set, else `unconstrained_end_week`.
    expected_end_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: `end_week + delay_weeks_applied`; null when left out / excluded.
    projected_end_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: A Blocked stage held the project at its frontier (DOMAIN_RULES.md
    #: "How progress feeds a schedule run").
    blocked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    #: Duration-weighted roll-up (Invariant I12), as computed by the run.
    progress_pct: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Non-null when the run rejected the project as a data error (e.g. an
    #: In-Progress stage missing `actual_start_week`) instead of scheduling it.
    data_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    schedule_run: Mapped[ScheduleRun] = relationship(back_populates="project_outcomes")
    project: Mapped[Project] = relationship(back_populates="schedule_run_outcomes")

    __table_args__ = (
        UniqueConstraint("schedule_run_id", "project_id", name="uq_run_project_outcome"),
    )
