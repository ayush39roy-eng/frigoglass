"""per-project step overlap: parallel steps (P32-T03, ADR 0043)

Revision ID: p32a_step_overlap
Revises: p30a_effort_types_hub_rename
Create Date: 2026-11-04

One nullable planner input on `project_workflow_steps`
(`models.workflow.ProjectWorkflowStep`), never overwritten by a schedule run
(like the ADR 0019 timing fields):

- `overlap_weeks` SMALLINT NULL: how many weeks this step may overlap the
  work it waits for (DOMAIN_RULES "Parallel steps"), 1..104. Null means 0
  (no overlap); 0 is never stored. CHECK
  `ck_project_workflow_steps_overlap_weeks_range`.

Nullable with no default, so every existing row keeps today's precedence and
no backfill is needed; every stored run and input hash is unchanged (the
scheduler omits a 0 overlap from its canonical input).
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p32a_step_overlap"
down_revision: str | Sequence[str] | None = "p30a_effort_types_hub_rename"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "project_workflow_steps"
_CHECK = "ck_project_workflow_steps_overlap_weeks_range"


def upgrade() -> None:
    op.add_column(_TABLE, sa.Column("overlap_weeks", sa.SmallInteger(), nullable=True))
    op.create_check_constraint(
        op.f(_CHECK),
        _TABLE,
        "overlap_weeks IS NULL OR overlap_weeks BETWEEN 1 AND 104",
    )


def downgrade() -> None:
    op.drop_constraint(op.f(_CHECK), _TABLE, type_="check")
    op.drop_column(_TABLE, "overlap_weeks")
