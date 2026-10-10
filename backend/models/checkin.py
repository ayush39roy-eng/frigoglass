"""Weekly stage check-ins (ADR 0021) and the coalesced follow-up run flag
(ADR 0023). Both tables are created by migration `p12b_vip_checkins`.

`StageCheckin` is history: one immutable row per reported stage per
submission. The migration gives the table the audit log's protection
(row triggers rejecting UPDATE and DELETE, a statement trigger rejecting
TRUNCATE), so application code may only INSERT. `user_id` is kept for audit
and is shown only on the stage's own history (GDPR, OQ #8): no endpoint
aggregates check-ins per engineer.

`ScheduleRunFollowUp` is a single-row flag (`id = 1`, seeded by the
migration). An auto-trigger that answers `deferred` sets `pending`; whoever
ends the in-flight run clears it and dispatches exactly one greedy run
(`services.run_dispatch`). Both happen under the dispatch advisory lock.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, UUIDPrimaryKeyMixin
from models.enums import WorkflowStepStatus

#: Maximum length of a check-in note (docs/API_CONTRACT_P12.md §0/§5).
CHECKIN_NOTE_MAX_LENGTH = 1000


class StageCheckin(UUIDPrimaryKeyMixin, Base):
    """One stage as reported in one weekly check-in (ADR 0021 §2). A stage
    confirmed unchanged still gets a row: "no change" is a report.
    """

    __tablename__ = "stage_checkins"

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id"), nullable=False, index=True
    )
    step_template_id: Mapped[str] = mapped_column(
        ForeignKey("workflow_step_templates.id"), nullable=False
    )
    #: `domain_constants.CURRENT_WEEK` at submit time.
    week: Mapped[int] = mapped_column(Integer, nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    status: Mapped[WorkflowStepStatus] = mapped_column(
        Enum(
            WorkflowStepStatus,
            name="workflow_step_status",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
            create_type=False,
        ),
        nullable=False,
    )
    percent_complete: Mapped[int] = mapped_column(Integer, nullable=False)
    blocked_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("percent_complete BETWEEN 0 AND 100", name="percent_complete_range"),
        CheckConstraint(
            f"note IS NULL OR char_length(note) <= {CHECKIN_NOTE_MAX_LENGTH}",
            name="note_length",
        ),
        Index("ix_stage_checkins_project_step_week", "project_id", "step_template_id", "week"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        # Never include the note or reason: free text, may hold personal data.
        return f"<StageCheckin {self.project_id}/{self.step_template_id} w{self.week}>"


class ScheduleRunFollowUp(Base):
    """The one durable "a follow-up run is wanted" flag (ADR 0023 §2). Exactly
    one row, `id = 1`, seeded by the migration (CHECK `id = 1`).
    """

    __tablename__ = "schedule_run_follow_ups"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    pending: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    #: When the flag was first set since it was last cleared.
    requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: The trigger that set it most recently (`priority_move`, `step_timing`,
    #: `check_in`). Diagnostics only.
    last_trigger_reason: Mapped[str | None] = mapped_column(String(100), nullable=True)
    #: How many `deferred` answers were coalesced since it was last cleared.
    request_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    __table_args__ = (CheckConstraint("id = 1", name="single_row"),)
