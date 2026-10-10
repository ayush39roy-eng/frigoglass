"""VIP flag, weekly stage check-ins, coalesced follow-up run flag (P12-T03)

Revision ID: p12b_vip_checkins
Revises: p12a_step_timing
Create Date: 2026-10-10

docs/API_CONTRACT_P12.md §0 and §8; ADR 0021, ADR 0022, ADR 0023.

- `projects.is_vip BOOLEAN NOT NULL DEFAULT false` (ADR 0022). Every existing
  project starts unpinned; no backfill.
- `stage_checkins` (`models.checkin.StageCheckin`): append-only history of
  weekly check-ins. Index `(project_id, step_template_id, week)`; CHECKs on
  `percent_complete` (0..100) and `note` (at most 1000 characters). Protected
  exactly like `audit_log_entries` (419f196fd00b, ba3881d85b55): a row-level
  `BEFORE UPDATE OR DELETE` trigger and a statement-level `BEFORE TRUNCATE`
  trigger, both raising unconditionally for any DB role. There is no escape
  hatch: check-ins are history.
- `schedule_run_follow_ups` (`models.checkin.ScheduleRunFollowUp`): the one
  durable follow-up flag of ADR 0023, a single row (`CHECK id = 1`) inserted
  here with `pending = false`. Set and cleared only under the dispatch
  advisory lock (`services.run_dispatch`).

No raw SQL string interpolation of data: the trigger DDL below uses fixed
identifiers only, and the seed row is a literal.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "p12b_vip_checkins"
down_revision: Union[str, Sequence[str], None] = "p12a_step_timing"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_CHECKINS = "stage_checkins"
_FOLLOW_UPS = "schedule_run_follow_ups"
_MUTATION_FN = "stage_checkins_reject_mutation"
_MUTATION_TRIGGER = "trg_stage_checkins_append_only"
_TRUNCATE_FN = "stage_checkins_reject_truncate"
_TRUNCATE_TRIGGER = "trg_stage_checkins_append_only_truncate"


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("is_vip", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )

    op.create_table(
        _CHECKINS,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("step_template_id", sa.String(length=10), nullable=False),
        sa.Column("week", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(name="workflow_step_status", create_type=False),
            nullable=False,
        ),
        sa.Column("percent_complete", sa.Integer(), nullable=False),
        sa.Column("blocked_reason", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "percent_complete BETWEEN 0 AND 100",
            name=op.f("ck_stage_checkins_percent_complete_range"),
        ),
        sa.CheckConstraint(
            "note IS NULL OR char_length(note) <= 1000",
            name=op.f("ck_stage_checkins_note_length"),
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], name=op.f("fk_stage_checkins_project_id_projects")
        ),
        sa.ForeignKeyConstraint(
            ["step_template_id"],
            ["workflow_step_templates.id"],
            name=op.f("fk_stage_checkins_step_template_id_workflow_step_templates"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_stage_checkins_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stage_checkins")),
    )
    op.create_index(op.f("ix_stage_checkins_project_id"), _CHECKINS, ["project_id"])
    op.create_index(
        "ix_stage_checkins_project_step_week",
        _CHECKINS,
        ["project_id", "step_template_id", "week"],
    )

    # Same design as audit_log_entries (419f196fd00b): UPDATE/DELETE rejected
    # for any role, before the operation applies.
    op.execute(
        f"""
        CREATE FUNCTION {_MUTATION_FN}() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION
                'stage_checkins is append-only: % is not permitted (row id=%)',
                TG_OP, COALESCE(OLD.id, NULL)
                USING ERRCODE = '23001';
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER {_MUTATION_TRIGGER}
        BEFORE UPDATE OR DELETE ON {_CHECKINS}
        FOR EACH ROW EXECUTE FUNCTION {_MUTATION_FN}()
        """
    )
    # Row triggers do not fire on TRUNCATE (ba3881d85b55): a sibling
    # statement-level trigger closes that gap.
    op.execute(
        f"""
        CREATE FUNCTION {_TRUNCATE_FN}() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION
                'stage_checkins is append-only: TRUNCATE is not permitted'
                USING ERRCODE = '23001';
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER {_TRUNCATE_TRIGGER}
        BEFORE TRUNCATE ON {_CHECKINS}
        FOR EACH STATEMENT EXECUTE FUNCTION {_TRUNCATE_FN}()
        """
    )

    op.create_table(
        _FOLLOW_UPS,
        sa.Column("id", sa.SmallInteger(), nullable=False),
        sa.Column("pending", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_trigger_reason", sa.String(length=100), nullable=True),
        sa.Column("request_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.CheckConstraint("id = 1", name=op.f("ck_schedule_run_follow_ups_single_row")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_schedule_run_follow_ups")),
    )
    op.execute(f"INSERT INTO {_FOLLOW_UPS} (id, pending, request_count) VALUES (1, false, 0)")


def downgrade() -> None:
    op.drop_table(_FOLLOW_UPS)

    op.execute(f"DROP TRIGGER IF EXISTS {_TRUNCATE_TRIGGER} ON {_CHECKINS}")
    op.execute(f"DROP FUNCTION IF EXISTS {_TRUNCATE_FN}()")
    op.execute(f"DROP TRIGGER IF EXISTS {_MUTATION_TRIGGER} ON {_CHECKINS}")
    op.execute(f"DROP FUNCTION IF EXISTS {_MUTATION_FN}()")
    op.drop_index("ix_stage_checkins_project_step_week", table_name=_CHECKINS)
    op.drop_index(op.f("ix_stage_checkins_project_id"), table_name=_CHECKINS)
    op.drop_table(_CHECKINS)

    op.drop_column("projects", "is_vip")
