"""scenario apply versioning

Revision ID: 7b540c00cea8
Revises: ba3881d85b55
Create Date: 2026-09-01 22:35:50.538666

P5-T02 — adds the two tables backing `models.scenario.ScenarioApplyRun` /
`ScenarioApplyChange`: the generic "snapshot pre-apply state before writing
new state" mechanism for scenario edits (Priorities/Project/Engineer/Chamber
diffs), per `docs/PROJECT_AND_STACK.md` §4. See `models/scenario.py`'s module
docstring for the full contract and how this differs from the existing
`schedule_runs`/`priority_application_runs` versioned-snapshot tables.

**Hand-edited from the raw `alembic revision --autogenerate` output**: the
autogenerate diff also proposed dropping and recreating
`ux_schedule_runs_one_active` / `ux_priority_application_runs_one_active` —
both spurious false positives. Those are hand-written partial unique indexes
(`CREATE UNIQUE INDEX ... WHERE is_active`, added by `419f196fd00b`) that
have no SQLAlchemy `Index`/`UniqueConstraint` object representation in
`models/schedule.py` / `models/priority.py` (a partial index cannot be
expressed as a plain ORM-level column constraint — see that migration's own
comment #1), so Alembic's autogenerate diffing always sees them as "present
in the DB but absent from `Base.metadata`" and proposes dropping them on
every future `--autogenerate` run touching any other table, regardless of
what actually changed. Removed both `op.drop_index`/`op.create_index` pairs
below — this migration touches only the two new tables.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '7b540c00cea8'
down_revision: Union[str, Sequence[str], None] = 'ba3881d85b55'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'scenario_apply_runs',
        sa.Column('version', sa.Integer(), nullable=False),
        sa.Column('applied_by_user_id', sa.Uuid(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('entity_types_touched', sa.ARRAY(sa.String(length=50)), nullable=False),
        sa.Column('change_count', sa.Integer(), nullable=False),
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
            ['applied_by_user_id'],
            ['users.id'],
            name=op.f('fk_scenario_apply_runs_applied_by_user_id_users'),
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_scenario_apply_runs')),
        sa.UniqueConstraint('version', name=op.f('uq_scenario_apply_runs_version')),
    )
    op.create_table(
        'scenario_apply_changes',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('scenario_apply_run_id', sa.Uuid(), nullable=False),
        sa.Column(
            'entity_type',
            sa.Enum(
                'priority_score', 'project', 'engineer', 'chamber', name='scenario_entity_type'
            ),
            nullable=False,
        ),
        sa.Column('entity_id', sa.String(length=100), nullable=False),
        sa.Column('project_id', sa.Uuid(), nullable=True),
        sa.Column('hub_id', sa.Uuid(), nullable=True),
        sa.Column('before_state', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('after_state', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ['hub_id'], ['hubs.id'], name=op.f('fk_scenario_apply_changes_hub_id_hubs')
        ),
        sa.ForeignKeyConstraint(
            ['project_id'],
            ['projects.id'],
            name=op.f('fk_scenario_apply_changes_project_id_projects'),
        ),
        sa.ForeignKeyConstraint(
            ['scenario_apply_run_id'],
            ['scenario_apply_runs.id'],
            name=op.f(
                'fk_scenario_apply_changes_scenario_apply_run_id_scenario_apply_runs'
            ),
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_scenario_apply_changes')),
        sa.UniqueConstraint(
            'scenario_apply_run_id',
            'entity_type',
            'entity_id',
            name='uq_scenario_apply_change_run_entity',
        ),
    )


def downgrade() -> None:
    """Downgrade schema.

    Explicit `DROP TYPE` for `scenario_entity_type`, mirroring
    `419f196fd00b`'s own "Hand-written: drop the native Postgres ENUM types"
    section and its documented reasoning: `op.drop_table()` for a table with
    an inline `sa.Enum(...)` column does NOT emit `DROP TYPE` on downgrade
    (confirmed empirically here too — the same
    `DuplicateObjectError: type "scenario_entity_type" already exists` on
    the next `upgrade head` without this line). Must run after
    `scenario_apply_changes` (the only table referencing this type) is
    dropped.
    """
    op.drop_table('scenario_apply_changes')
    op.drop_table('scenario_apply_runs')
    op.execute("DROP TYPE IF EXISTS scenario_entity_type")
