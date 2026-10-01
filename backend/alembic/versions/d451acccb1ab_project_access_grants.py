"""project access grants + manager delegation (P10-T01, ADR 0012)

Revision ID: d451acccb1ab
Revises: c41f7e9a2b58
Create Date: 2026-09-30

- `project_access_grants` (`models.project_access.ProjectAccessGrant`):
  per-`(project, user)` Viewer/Editor/Admin grant, additive to the ADR 0010
  role/hub-scope matrix (`services.project_access.effective_project_access`
  composes both via MAX). The partial UNIQUE index
  `ux_project_access_grants_one_active` on `(project_id, user_id) WHERE
  revoked_at IS NULL` is BOTH the hot-path "does this user have an active
  grant on this project" lookup AND the "at most one active grant per
  (project, user)" enforcement — a single DB constraint doing both jobs.
  **Documented choice**: a DB-level partial unique index, not an
  application-level check-then-insert, because the latter races under
  concurrent grant attempts (two simultaneous `POST .../access` calls could
  both pass a SELECT-based check before either commits); Postgres's own
  index uniqueness check is race-proof. Hand-written (not a SQLAlchemy
  `Index(..., postgresql_where=...)` on the model) to match this repo's
  existing convention for every other partial unique index
  (`ux_schedule_runs_one_active` / `ux_priority_application_runs_one_active`,
  `419f196fd00b`) — see `models.project_access.ProjectAccessGrant`'s own
  docstring for why.
- `users.manager_id`: nullable self-FK for manager delegation, with a CHECK
  against the trivial 1-hop self-cycle (`manager_id != id`). A longer cycle
  (A manages B, B manages A, or a 3+-hop loop) is NOT expressible as a
  single-row CHECK across the whole table and is instead rejected at the API
  layer (P10-T02, `api/routers/users.py::update_user`) by walking the chain
  before a write.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'd451acccb1ab'
down_revision: Union[str, Sequence[str], None] = 'c41f7e9a2b58'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ACTIVE_GRANT_IDX = "ux_project_access_grants_one_active"


def upgrade() -> None:
    op.create_table(
        'project_access_grants',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('project_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column(
            'project_role',
            sa.Enum('viewer', 'editor', 'admin', name='project_access_role'),
            nullable=False,
        ),
        sa.Column('granted_by_user_id', sa.Uuid(), nullable=False),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            'created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ['project_id'], ['projects.id'],
            name=op.f('fk_project_access_grants_project_id_projects'),
        ),
        sa.ForeignKeyConstraint(
            ['user_id'], ['users.id'],
            name=op.f('fk_project_access_grants_user_id_users'),
        ),
        sa.ForeignKeyConstraint(
            ['granted_by_user_id'], ['users.id'],
            name=op.f('fk_project_access_grants_granted_by_user_id_users'),
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_project_access_grants')),
    )
    op.create_index(
        _ACTIVE_GRANT_IDX,
        'project_access_grants',
        ['project_id', 'user_id'],
        unique=True,
        postgresql_where=sa.text('revoked_at IS NULL'),
    )

    op.add_column('users', sa.Column('manager_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_users_manager_id'), 'users', ['manager_id'])
    op.create_foreign_key(
        op.f('fk_users_manager_id_users'), 'users', 'users', ['manager_id'], ['id']
    )
    op.create_check_constraint(
        'ck_users_manager_id_not_self', 'users', 'manager_id IS NULL OR manager_id != id'
    )


def downgrade() -> None:
    op.drop_constraint('ck_users_manager_id_not_self', 'users', type_='check')
    op.drop_constraint(op.f('fk_users_manager_id_users'), 'users', type_='foreignkey')
    op.drop_index(op.f('ix_users_manager_id'), table_name='users')
    op.drop_column('users', 'manager_id')

    op.execute(f"DROP INDEX IF EXISTS {_ACTIVE_GRANT_IDX}")
    op.drop_table('project_access_grants')
    op.execute("DROP TYPE IF EXISTS project_access_role")
