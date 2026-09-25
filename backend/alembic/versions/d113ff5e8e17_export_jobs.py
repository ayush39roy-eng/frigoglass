"""export jobs

Revision ID: d113ff5e8e17
Revises: 7b540c00cea8
Create Date: 2026-09-02 12:58:27.723355

P5-T04 — adds the `export_jobs` table backing `models.export.ExportJob`: the
async ("large export, via MinIO") half of the CSV/XLSX export feature, per
`docs/PROJECT_AND_STACK.md` §2/§6. See `models/export.py`'s module docstring
for the full contract.

**Hand-edited from the raw `alembic revision --autogenerate` output**, same
false-positive as `7b540c00cea8`'s own documented edit: the autogenerate diff
also proposed dropping `ux_schedule_runs_one_active` /
`ux_priority_application_runs_one_active` — both hand-written partial unique
indexes (`CREATE UNIQUE INDEX ... WHERE is_active`, added by `419f196fd00b`)
with no SQLAlchemy `Index`/`UniqueConstraint` object representation in
`models/schedule.py` / `models/priority.py`, so autogenerate always sees them
as "present in the DB but absent from `Base.metadata`" regardless of what
actually changed. Removed both `op.drop_index`/`op.create_index` pairs below
— this migration touches only the new `export_jobs` table.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'd113ff5e8e17'
down_revision: Union[str, Sequence[str], None] = '7b540c00cea8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'export_jobs',
        sa.Column(
            'surface',
            sa.Enum(
                'dashboard',
                'capacity',
                'matrix',
                'gantt',
                'project_registration',
                'capacity_planning',
                name='export_surface',
            ),
            nullable=False,
        ),
        sa.Column('format', sa.Enum('csv', 'xlsx', name='export_format'), nullable=False),
        sa.Column(
            'status',
            sa.Enum('queued', 'running', 'completed', 'failed', name='export_job_status'),
            nullable=False,
        ),
        sa.Column('requested_by_user_id', sa.Uuid(), nullable=False),
        sa.Column('filters', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('celery_task_id', sa.String(length=255), nullable=True),
        sa.Column('object_key', sa.String(length=500), nullable=True),
        sa.Column('row_count', sa.Integer(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
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
            ['requested_by_user_id'],
            ['users.id'],
            name=op.f('fk_export_jobs_requested_by_user_id_users'),
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_export_jobs')),
    )


def downgrade() -> None:
    """Downgrade schema.

    Explicit `DROP TYPE` for the three new enum types, mirroring
    `419f196fd00b`'s / `7b540c00cea8`'s own documented "Hand-written: drop
    the native Postgres ENUM types" section: `op.drop_table()` for a table
    with inline `sa.Enum(...)` columns does NOT emit `DROP TYPE` on
    downgrade (confirmed empirically by both of those prior migrations) —
    without this, the next `upgrade head` after a `downgrade` would hit
    `DuplicateObjectError: type "export_surface" already exists`.
    """
    op.drop_table('export_jobs')
    op.execute("DROP TYPE IF EXISTS export_surface")
    op.execute("DROP TYPE IF EXISTS export_format")
    op.execute("DROP TYPE IF EXISTS export_job_status")
