"""Run step rows record the FTE that stretched them (ADR 0032, P20-T02).

`schedule_run_project_steps.span_fte` (nullable `Numeric(3, 2)`): the leader
FTE the run used to stretch a design step to `ceil(duration / fte)` elapsed
weeks, copied from the run's own input when the row is persisted. NULL when
the row was not stretched (lab, elapsed, skipped or Done steps, frozen
projects, no leader) and on every row written before this revision. Served as
`GanttStepRow.span_fte` to callers who may edit step timing (ADR 0019).

No data backfill: rows of earlier runs keep NULL. The next run fills it.

Revision ID: p20a_run_step_span_fte
Revises: p16a_rescore_adr0029
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p20a_run_step_span_fte"
down_revision: str | Sequence[str] | None = "p16a_rescore_adr0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "schedule_run_project_steps",
        sa.Column("span_fte", sa.Numeric(3, 2), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("schedule_run_project_steps", "span_fte")
