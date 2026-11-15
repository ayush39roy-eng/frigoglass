"""project actual end week (P35-T01, D35-3)

Revision ID: p35a_project_actual_end_week
Revises: p32a_step_overlap
Create Date: 2026-11-13

One nullable column on `projects` (`models.project.Project`), entered on the
Projects register beside `actual_start_week` (old-tool parity, P35):

- `actual_end_week` INTEGER NULL: the week the project actually finished, a
  week number like `actual_start_week`. CHECK
  `ck_projects_actual_end_week_positive` (>= 1).

Not a scheduler input. "End not before start" is checked by the PATCH
(422 `ACTUAL_END_BEFORE_START`), not by a CHECK, because other writers (the
Gantt freeze) move `actual_start_week` on their own.

Nullable with no default: no backfill, every stored run and input hash is
unchanged.
"""
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p35a_project_actual_end_week"
down_revision: str | Sequence[str] | None = "p32a_step_overlap"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "projects"
_CHECK = "ck_projects_actual_end_week_positive"


def upgrade() -> None:
    op.add_column(_TABLE, sa.Column("actual_end_week", sa.Integer(), nullable=True))
    op.create_check_constraint(
        op.f(_CHECK), _TABLE, "actual_end_week IS NULL OR actual_end_week >= 1"
    )


def downgrade() -> None:
    op.drop_constraint(op.f(_CHECK), _TABLE, type_="check")
    op.drop_column(_TABLE, "actual_end_week")
