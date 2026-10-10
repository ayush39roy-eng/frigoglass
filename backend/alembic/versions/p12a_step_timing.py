"""per-project step timing from the Gantt (P12-T02, ADR 0019)

Revision ID: p12a_step_timing
Revises: d451acccb1ab
Create Date: 2026-10-10

Two nullable planner inputs on `project_workflow_steps`
(`models.workflow.ProjectWorkflowStep`), never overwritten by a schedule run
(like the ADR 0006 progress fields):

- `duration_override_weeks`: this project's duration for this step, 1..104.
  Null means the lead-time table applies (ADR 0007). CHECK
  `ck_project_workflow_steps_duration_override_range`.
- `start_not_before_week`: the step may not start before this week,
  1..HORIZON_WEEKS (78). Null means no floor. CHECK
  `ck_project_workflow_steps_start_not_before_range`.

Both columns are nullable with no default, so every existing row keeps the
lead-time behaviour and no backfill is needed. Backend B's
`p12b_vip_checkins` chains onto this revision (docs/API_CONTRACT_P12.md §0).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "p12a_step_timing"
down_revision: Union[str, Sequence[str], None] = "d451acccb1ab"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "project_workflow_steps"


def upgrade() -> None:
    op.add_column(_TABLE, sa.Column("duration_override_weeks", sa.Integer(), nullable=True))
    op.add_column(_TABLE, sa.Column("start_not_before_week", sa.Integer(), nullable=True))
    op.create_check_constraint(
        op.f("ck_project_workflow_steps_duration_override_range"),
        _TABLE,
        "duration_override_weeks IS NULL OR duration_override_weeks BETWEEN 1 AND 104",
    )
    op.create_check_constraint(
        op.f("ck_project_workflow_steps_start_not_before_range"),
        _TABLE,
        "start_not_before_week IS NULL OR start_not_before_week BETWEEN 1 AND 78",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("ck_project_workflow_steps_start_not_before_range"), _TABLE, type_="check"
    )
    op.drop_constraint(
        op.f("ck_project_workflow_steps_duration_override_range"), _TABLE, type_="check"
    )
    op.drop_column(_TABLE, "start_not_before_week")
    op.drop_column(_TABLE, "duration_override_weeks")
