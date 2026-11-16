"""Manual step pins (P40-T03b, ADR 0054 ruling R40-1 / R40-12)

Revision ID: p40a_step_pins
Revises: p41a_import_format_and_scenarios
Create Date: 2026-11-17

ADR 0054 "Ruling (P40-T02)", docs/DOMAIN_RULES.md "Manual step weeks".

Upgrade, additive only (no existing row changes meaning):

- `project_workflow_steps.manual_start_week` / `manual_end_week`: nullable
  ints, with CHECK `step_pin_range`: both null, or `1 <= ms <= me <= 52`
  (R40-1: the end is inclusive; the stored cap is WITHIN_YEAR_WEEK). Every
  existing row is null/null, so the CHECK holds at once.
- `schedule_run_project_steps.pinned` / `manual_overlap` and
  `schedule_run_project_outcomes.manual_overlap` / `pin_lapsed`: booleans,
  NOT NULL with a server default of false (R40-12), so every stored run reads
  exactly as before (I48 (a)).

Downgrade drops the CHECK and the six columns. Any stored pin, and the run
flags, are lost (the runs re-serialise as before P40).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p40a_step_pins"
down_revision: str | Sequence[str] | None = "p41a_import_format_and_scenarios"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STEPS = "project_workflow_steps"
_RUN_STEPS = "schedule_run_project_steps"
_OUTCOMES = "schedule_run_project_outcomes"
_CK_PIN = "ck_project_workflow_steps_step_pin_range"

#: Constant SQL, no interpolated values. 52 = WITHIN_YEAR_WEEK, frozen here so
#: the migration never changes meaning when the constant does.
_PIN_CHECK = (
    "(manual_start_week IS NULL AND manual_end_week IS NULL) OR ("
    "manual_start_week IS NOT NULL AND manual_end_week IS NOT NULL "
    "AND manual_start_week >= 1 AND manual_start_week <= manual_end_week "
    "AND manual_end_week <= 52)"
)


def _flag(name: str) -> sa.Column:
    return sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.false())


def upgrade() -> None:
    op.add_column(_STEPS, sa.Column("manual_start_week", sa.Integer(), nullable=True))
    op.add_column(_STEPS, sa.Column("manual_end_week", sa.Integer(), nullable=True))
    op.create_check_constraint(op.f(_CK_PIN), _STEPS, _PIN_CHECK)
    op.add_column(_RUN_STEPS, _flag("pinned"))
    op.add_column(_RUN_STEPS, _flag("manual_overlap"))
    op.add_column(_OUTCOMES, _flag("manual_overlap"))
    op.add_column(_OUTCOMES, _flag("pin_lapsed"))


def downgrade() -> None:
    op.drop_column(_OUTCOMES, "pin_lapsed")
    op.drop_column(_OUTCOMES, "manual_overlap")
    op.drop_column(_RUN_STEPS, "manual_overlap")
    op.drop_column(_RUN_STEPS, "pinned")
    op.drop_constraint(op.f(_CK_PIN), _STEPS, type_="check")
    op.drop_column(_STEPS, "manual_end_week")
    op.drop_column(_STEPS, "manual_start_week")
