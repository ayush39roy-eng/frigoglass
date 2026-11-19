"""`plan_week_rollovers` (P37-T05, built at P53-T03 on the absolute week;
DOMAIN_RULES "Weekly rollover run", R37-8, R53-1).

One row per absolute calendar week the rollover acted on. `attempts` counts
only queued attempts (R37-8): `not_needed` / `deferred` ticks do not consume
the budget. `plan_year = year_of(week)`.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base

ROLLOVER_STATUSES = ("queued", "deferred", "not_needed", "failed")


class PlanWeekRollover(Base):
    __tablename__ = "plan_week_rollovers"
    __table_args__ = (
        CheckConstraint("week >= 1", name="week_positive"),
        CheckConstraint("attempts >= 0", name="attempts_non_negative"),
        CheckConstraint(
            "status IN ('queued', 'deferred', 'not_needed', 'failed')", name="status_valid"
        ),
    )

    week: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    plan_year: Mapped[int] = mapped_column(Integer, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("schedule_runs.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
