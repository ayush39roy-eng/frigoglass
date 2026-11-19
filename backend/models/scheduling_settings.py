"""The scheduling horizon setting (P53-T03, ADR 0063 R53-2).

One row (id = 1) holding `scheduling_horizon_years` N (1..10, default 5).
A run reads N once when its row is created and stores `horizon_weeks =
current_week + 52 × N` (I58). No row means the default (version 0).
Migration `p53a_week_line` creates the table and its one row.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class SchedulingSettings(Base):
    __tablename__ = "scheduling_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="single_row"),
        CheckConstraint("version >= 1", name="version_positive"),
        CheckConstraint("scheduling_horizon_years BETWEEN 1 AND 10", name="horizon_years_range"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    scheduling_horizon_years: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
