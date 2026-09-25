"""notifications

Revision ID: 2418c6385a72
Revises: d113ff5e8e17
Create Date: 2026-09-02 13:39:08.703328

P5-T06 — adds the `notifications` table backing `models.notification
.Notification`: in-app notifications on schedule changes affecting a user's
hub or assigned projects (delay introduced, project left out, conflict
raised), per `docs/PROJECT_AND_STACK.md` §2. See that model's module
docstring for the fanout-per-recipient design and
`services/notifications.py` for the generation/diff logic.

**Hand-edited from the raw `alembic revision --autogenerate` output**: the
autogenerate diff also proposed dropping and recreating
`ux_priority_application_runs_one_active` / `ux_schedule_runs_one_active` —
both spurious false positives, the exact same ones `7b540c00cea8` and
`d113ff5e8e17` already documented and stripped from their own diffs (hand-
written partial unique indexes with no SQLAlchemy `Index`/`UniqueConstraint`
ORM-level representation — see `419f196fd00b`'s own comment #1). Removed
both `op.drop_index`/`op.create_index` pairs below — this migration touches
only the new `notifications` table (+ its `notification_reason` enum).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '2418c6385a72'
down_revision: Union[str, Sequence[str], None] = 'd113ff5e8e17'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'notifications',
        sa.Column('recipient_user_id', sa.Uuid(), nullable=False),
        sa.Column(
            'reason',
            sa.Enum(
                'delay_introduced',
                'project_left_out',
                'conflict_raised',
                name='notification_reason',
            ),
            nullable=False,
        ),
        sa.Column('project_id', sa.Uuid(), nullable=False),
        sa.Column('hub_id', sa.Uuid(), nullable=False),
        sa.Column('message', sa.String(length=500), nullable=False),
        sa.Column('schedule_run_id', sa.Uuid(), nullable=False),
        sa.Column('previous_schedule_run_id', sa.Uuid(), nullable=True),
        sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ['hub_id'], ['hubs.id'], name=op.f('fk_notifications_hub_id_hubs')
        ),
        sa.ForeignKeyConstraint(
            ['previous_schedule_run_id'],
            ['schedule_runs.id'],
            name=op.f('fk_notifications_previous_schedule_run_id_schedule_runs'),
        ),
        sa.ForeignKeyConstraint(
            ['project_id'],
            ['projects.id'],
            name=op.f('fk_notifications_project_id_projects'),
        ),
        sa.ForeignKeyConstraint(
            ['recipient_user_id'],
            ['users.id'],
            name=op.f('fk_notifications_recipient_user_id_users'),
        ),
        sa.ForeignKeyConstraint(
            ['schedule_run_id'],
            ['schedule_runs.id'],
            name=op.f('fk_notifications_schedule_run_id_schedule_runs'),
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_notifications')),
    )


def downgrade() -> None:
    """Downgrade schema.

    Explicit `DROP TYPE` for `notification_reason`, mirroring
    `419f196fd00b`'s/`7b540c00cea8`'s own "Hand-written: drop the native
    Postgres ENUM types" sections — `op.drop_table()` for a table with an
    inline `sa.Enum(...)` column does not itself emit `DROP TYPE` on
    downgrade.
    """
    op.drop_table('notifications')
    op.execute("DROP TYPE IF EXISTS notification_reason")
