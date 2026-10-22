"""The editable prioritization scoring rubric (ADR 0037, P26-T01).

Before P26 the 13 dimensions, their pillars and weights were constants in
code (`domain_constants.PRIORITIZATION_DIMENSIONS`) and every project's scores
were 13 fixed columns on `priority_scores`. They now live in three tables:

- `scoring_dimensions`: the rubric. One row per dimension, never deleted.
  `key` is the stable wire / export key (the 13 migrated keys are unchanged).
  `active = false` takes a dimension out of the formula and off every reader
  while keeping its historic scores; reactivating it restores them.
- `rubric_versions`: one row per rubric change, with a JSON snapshot of all
  dimensions, who changed it, when and why. Version 1 is the migrated rubric.
- `priority_dimension_scores`: one project's score on one dimension (0..5, or
  null = not scored). Absent and null mean the same: the dimension counts 0
  points and the project's score is "incomplete" (`missing_dimension_keys`).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, TimestampMixin

#: Bounds of a dimension weight (owner default, 2026-10-22).
WEIGHT_MIN = 1
WEIGHT_MAX = 100
#: Bounds of one dimension score (ADR 0033).
SCORE_MIN = 0
SCORE_MAX = 5
KEY_MAX_LENGTH = 64
LABEL_MAX_LENGTH = 80
PILLAR_MAX_LENGTH = 60
REASON_MAX_LENGTH = 500


class ScoringDimension(TimestampMixin, Base):
    __tablename__ = "scoring_dimensions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    key: Mapped[str] = mapped_column(String(KEY_MAX_LENGTH), unique=True, nullable=False)
    label: Mapped[str] = mapped_column(String(LABEL_MAX_LENGTH), nullable=False)
    pillar: Mapped[str] = mapped_column(String(PILLAR_MAX_LENGTH), nullable=False)
    weight: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Meaning only (e.g. CAPEX: a higher score means a LOWER investment). The
    #: formula is the same for every dimension; the scorer enters the score.
    inverted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )

    __table_args__ = (
        CheckConstraint(f"weight BETWEEN {WEIGHT_MIN} AND {WEIGHT_MAX}", name="weight_range"),
        CheckConstraint("display_order >= 1", name="display_order_positive"),
    )


class RubricVersion(Base):
    __tablename__ = "rubric_versions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    version: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)
    changed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    #: Σ weights of the active dimensions of this version.
    total_weight: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Every dimension (active and inactive) as served by `GET /scoring-rubric`:
    #: `[{id, key, label, pillar, weight, inverted, active, display_order}]`.
    dimensions: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False)

    __table_args__ = (
        CheckConstraint("version >= 1", name="version_positive"),
        CheckConstraint("total_weight >= 1", name="total_weight_positive"),
    )


class PriorityDimensionScore(Base):
    __tablename__ = "priority_dimension_scores"

    priority_score_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("priority_scores.id", ondelete="CASCADE"), primary_key=True
    )
    dimension_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scoring_dimensions.id"), primary_key=True, index=True
    )
    score: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        CheckConstraint(f"score BETWEEN {SCORE_MIN} AND {SCORE_MAX}", name="score_range"),
    )
