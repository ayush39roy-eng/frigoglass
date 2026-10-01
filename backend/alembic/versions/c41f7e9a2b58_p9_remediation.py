"""p9 remediation: schedule_runs.solver_status, project_comments truncate guard

Revision ID: c41f7e9a2b58
Revises: 8e2d4b6a1c90
Create Date: 2026-09-27

P9-R02 (P9 gate remediation):

- `schedule_runs.solver_status` (nullable text). DOMAIN_RULES "Gate
  remediation rulings" 6: whether a CP-SAT result is OPTIMAL or FEASIBLE is
  recorded on the run. Existing rows stay NULL (unknown).
- Security S-04: a statement-level BEFORE TRUNCATE trigger on
  `project_comments`. The row-level `trg_project_comments_no_delete` trigger
  (5c9e1f2a7b3d) does not fire for TRUNCATE, so a raw TRUNCATE could wipe
  every comment. Same design as `audit_log_entries`' truncate guard
  (ba3881d85b55): unconditional, any role. The seed's `--reset` clears
  comments with DELETE under the `rpd.allow_comment_delete` escape hatch,
  never TRUNCATE, so it is unaffected.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c41f7e9a2b58'
down_revision: Union[str, Sequence[str], None] = '8e2d4b6a1c90'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_FN = "project_comments_reject_truncate"
_TRIGGER = "trg_project_comments_no_truncate"


def upgrade() -> None:
    op.add_column('schedule_runs', sa.Column('solver_status', sa.String(length=50), nullable=True))
    op.execute(
        f"""
        CREATE FUNCTION {_FN}() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION
                'project_comments are never hard-deleted: TRUNCATE is not permitted'
                USING ERRCODE = '23001';
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER {_TRIGGER}
        BEFORE TRUNCATE ON project_comments
        FOR EACH STATEMENT EXECUTE FUNCTION {_FN}()
        """
    )


def downgrade() -> None:
    op.execute(f"DROP TRIGGER IF EXISTS {_TRIGGER} ON project_comments")
    op.execute(f"DROP FUNCTION IF EXISTS {_FN}()")
    op.drop_column('schedule_runs', 'solver_status')
