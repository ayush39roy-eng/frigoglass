"""One week line, open horizon, delivery by year (P53-T03, ADR 0063 R53-7)

Revision ID: p53a_week_line
Revises: p35b_step_excluded
Create Date: 2026-11-19

ADDITIVE ONLY. It issues no UPDATE and no DELETE on any existing row and
rewrites no stored week (I57, I62; `tests/test_p53_migration_checksum.py`
checksums every week column before and after upgrade and downgrade).

Upgrade:

- table `scheduling_settings` (one row, id = 1): `scheduling_horizon_years`
  N, CHECK 1..10; the row is inserted with the default 5 (R53-2);
- table `plan_week_rollovers` (P37-T05 on the absolute week, R53-1): one row
  per calendar week the rollover acted on;
- `schedule_runs.rules_epoch` VARCHAR(16) NULL (NULL = pre-P53);
- `schedule_run_project_outcomes.priority_at_run` VARCHAR(8) NULL and
  `left_out_reason` VARCHAR(32) NULL (NULL on every existing row);
- CHECK relaxations (constraint only, no row touched):
  - `ck_project_workflow_steps_step_pin_range`: `manual_end_week <= 52` →
    `manual_end_week >= 1` (the plan-year cap moved to the service, R53-8);
  - `ck_whatif_import_scenarios_plan_year_end_valid`: `IN (52, 104)` →
    `> 0 AND % 52 = 0` (R53-4).

Downgrade drops what upgrade added and restores the two old CHECKs as
NOT VALID, so a row written under the relaxed rule is never rejected,
rewritten or deleted (existing rows are kept as they are).

Constant SQL only; no interpolated values.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p53a_week_line"
down_revision: str | Sequence[str] | None = "p35b_step_excluded"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STEPS = "project_workflow_steps"
_SCENARIOS = "whatif_import_scenarios"
_RUNS = "schedule_runs"
_OUTCOMES = "schedule_run_project_outcomes"
_CK_PIN = "ck_project_workflow_steps_step_pin_range"
_CK_SCENARIO = "ck_whatif_import_scenarios_plan_year_end_valid"

_PIN_CHECK_P53 = (
    "(manual_start_week IS NULL AND manual_end_week IS NULL) OR ("
    "manual_start_week IS NOT NULL AND manual_end_week IS NOT NULL "
    "AND manual_start_week >= 1 AND manual_start_week <= manual_end_week "
    "AND manual_end_week >= 1)"
)
_SCENARIO_CHECK_P53 = "plan_year_end_week > 0 AND plan_year_end_week % 52 = 0"

#: The pre-P53 CHECKs, restored NOT VALID on downgrade (constant SQL).
_RESTORE_PIN_CHECK = sa.text(
    "ALTER TABLE project_workflow_steps ADD CONSTRAINT "
    "ck_project_workflow_steps_step_pin_range CHECK ("
    "(manual_start_week IS NULL AND manual_end_week IS NULL) OR ("
    "manual_start_week IS NOT NULL AND manual_end_week IS NOT NULL "
    "AND manual_start_week >= 1 AND manual_start_week <= manual_end_week "
    "AND manual_end_week <= 52)) NOT VALID"
)
_RESTORE_SCENARIO_CHECK = sa.text(
    "ALTER TABLE whatif_import_scenarios ADD CONSTRAINT "
    "ck_whatif_import_scenarios_plan_year_end_valid CHECK "
    "(plan_year_end_week IN (52, 104)) NOT VALID"
)

_INSERT_SETTINGS = sa.text(
    "INSERT INTO scheduling_settings (id, version, scheduling_horizon_years) VALUES (1, 1, 5)"
)


def upgrade() -> None:
    op.create_table(
        "scheduling_settings",
        sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("scheduling_horizon_years", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name=op.f("ck_scheduling_settings_single_row")),
        sa.CheckConstraint("version >= 1", name=op.f("ck_scheduling_settings_version_positive")),
        sa.CheckConstraint(
            "scheduling_horizon_years BETWEEN 1 AND 10",
            name=op.f("ck_scheduling_settings_horizon_years_range"),
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
            name=op.f("fk_scheduling_settings_updated_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_scheduling_settings")),
    )
    op.execute(_INSERT_SETTINGS)

    op.create_table(
        "plan_week_rollovers",
        sa.Column("week", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("plan_year", sa.Integer(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("week >= 1", name=op.f("ck_plan_week_rollovers_week_positive")),
        sa.CheckConstraint(
            "attempts >= 0", name=op.f("ck_plan_week_rollovers_attempts_non_negative")
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'deferred', 'not_needed', 'failed')",
            name=op.f("ck_plan_week_rollovers_status_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["last_run_id"],
            ["schedule_runs.id"],
            name=op.f("fk_plan_week_rollovers_last_run_id_schedule_runs"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("week", name=op.f("pk_plan_week_rollovers")),
    )

    op.add_column(_RUNS, sa.Column("rules_epoch", sa.String(length=16), nullable=True))
    op.add_column(_OUTCOMES, sa.Column("priority_at_run", sa.String(length=8), nullable=True))
    op.add_column(_OUTCOMES, sa.Column("left_out_reason", sa.String(length=32), nullable=True))

    op.drop_constraint(op.f(_CK_PIN), _STEPS, type_="check")
    op.create_check_constraint(op.f(_CK_PIN), _STEPS, _PIN_CHECK_P53)
    op.drop_constraint(op.f(_CK_SCENARIO), _SCENARIOS, type_="check")
    op.create_check_constraint(op.f(_CK_SCENARIO), _SCENARIOS, _SCENARIO_CHECK_P53)


def downgrade() -> None:
    op.drop_constraint(op.f(_CK_SCENARIO), _SCENARIOS, type_="check")
    op.execute(_RESTORE_SCENARIO_CHECK)
    op.drop_constraint(op.f(_CK_PIN), _STEPS, type_="check")
    op.execute(_RESTORE_PIN_CHECK)

    op.drop_column(_OUTCOMES, "left_out_reason")
    op.drop_column(_OUTCOMES, "priority_at_run")
    op.drop_column(_RUNS, "rules_epoch")
    op.drop_table("plan_week_rollovers")
    op.drop_table("scheduling_settings")
