"""per-project step exclusion (P35-T05, ADR 0049 as ruled at P35-T03)

Revision ID: p35b_step_excluded
Revises: p33c_clear_step_timing
Create Date: 2026-11-17

One column on `project_workflow_steps` (`models.workflow.ProjectWorkflowStep`):

- `excluded` BOOLEAN NOT NULL DEFAULT false: the step is switched off for this
  project (DOMAIN_RULES "Per-project step exclusion", R35-1: `eff = 0` before
  every other branch). Written only by the Projects register batch
  (`POST /projects/register-edits`, `step_exclusions`) and cleared by a
  workflow change (R35-11). The wire name is `step_excluded` (R35-12 naming
  note).
- CHECK `ck_project_workflow_steps_excluded_not_done`: `NOT (excluded AND
  status = 'Done')` (I34 (i): a Done step is never excluded, 409 `STEP_DONE`;
  the stage PATCH and the check-in refuse an excluded step with
  `STAGE_SKIPPED` / `NOT_DUE`, so no writer can reach the state).

Every existing row gets `false`: nothing is excluded, so every live input
hash, golden file, stored run and preview token is byte-identical (I36). The
builder maps an excluded step to `lead_weeks = 0`, so there is no new
scheduler field or snapshot key (R35-9).

Revises `p33c_clear_step_timing`, the head when this was written; the chain is
`p32a → p35a → p33a → p36a → p33b → p33c → p35b`.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p35b_step_excluded"
down_revision: str | Sequence[str] | None = "p33c_clear_step_timing"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "project_workflow_steps"
_CHECK = "ck_project_workflow_steps_excluded_not_done"


def upgrade() -> None:
    op.add_column(
        _TABLE,
        sa.Column("excluded", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_check_constraint(op.f(_CHECK), _TABLE, "NOT (excluded AND status = 'Done')")


def downgrade() -> None:
    op.drop_constraint(op.f(_CHECK), _TABLE, type_="check")
    op.drop_column(_TABLE, "excluded")
