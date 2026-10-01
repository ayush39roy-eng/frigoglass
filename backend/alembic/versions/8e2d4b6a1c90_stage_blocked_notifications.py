"""stage_blocked notifications

Revision ID: 8e2d4b6a1c90
Revises: 5c9e1f2a7b3d
Create Date: 2026-09-27

P9-T03 follow-up. The Project Workspace spec says a Blocked stage "surfaces
on Notifications" (docs/PROJECT_AND_STACK.md §2, P8-T03). This revision:

- adds the `stage_blocked` label to the `notification_reason` enum;
- makes `notifications.schedule_run_id` nullable. A stage-blocked
  notification comes from a progress edit, not from a schedule run, so it
  has no run to point at. The three schedule-change reasons still always set
  it; that is the service code's rule, not a DB constraint.

`ADD VALUE` is allowed inside the migration transaction on Postgres 12+
because the new label is not used in this same transaction.

Downgrade is lossy by nature: it deletes every `stage_blocked` notification
(no older enum can represent them), restores NOT NULL, and recreates the enum
without the label (Postgres cannot drop an enum value in place).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '8e2d4b6a1c90'
down_revision: Union[str, Sequence[str], None] = '5c9e1f2a7b3d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE notification_reason ADD VALUE IF NOT EXISTS 'stage_blocked'")
    op.alter_column('notifications', 'schedule_run_id', existing_type=sa.Uuid(), nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM notifications WHERE reason::text = 'stage_blocked'")
    op.alter_column('notifications', 'schedule_run_id', existing_type=sa.Uuid(), nullable=False)
    op.execute("ALTER TYPE notification_reason RENAME TO notification_reason_old")
    op.execute(
        "CREATE TYPE notification_reason AS ENUM "
        "('delay_introduced', 'project_left_out', 'conflict_raised')"
    )
    op.execute(
        "ALTER TABLE notifications ALTER COLUMN reason TYPE notification_reason "
        "USING reason::text::notification_reason"
    )
    op.execute("DROP TYPE notification_reason_old")
