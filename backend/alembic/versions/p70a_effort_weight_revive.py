"""effort weight revive: allow 0 -> weeks on a revived template step (ADR 0070)

Revision ID: p70a_effort_weight_revive
Revises: p53a_week_line
Create Date: 2026-11-24

Owner decision 2026-11-24 ("Split the figure"), ADR 0070, amending R33-2
(ADR 0046): a template step whose length is set from 0 to N > 0 takes part
in the own-effort split with weight N when its stored
`effort_weight_weeks` is 0. Every other change of a weight stays forbidden.

FUNCTION ONLY. This replaces the body of the p33b trigger function
`workflow_lead_times_effort_weight()`; the trigger itself, every table and
every row are untouched (no UPDATE, no DELETE). Writing the weights is the
application's job (the template apply, and the Super-Admin
`POST /workflow-templates/sync-effort-weights` the owner triggers by hand).

The new rule, on UPDATE, when the weight changes:

    allowed  ⟺  OLD.effort_weight_weeks = 0
                ∧ NEW.weeks > 0
                ∧ NEW.effort_weight_weeks = NEW.weeks

anything else still raises SQLSTATE 23514 with constraint name
`ck_workflow_lead_times_effort_weight_immutable`. INSERT is unchanged (a
NULL weight takes `weeks`).

Downgrade restores the p33b body (strictly immutable). Rows revived while
this revision was in force keep their weights.

Constant SQL only; no interpolated values.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "p70a_effort_weight_revive"
down_revision: str | Sequence[str] | None = "p53a_week_line"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_REVIVE_FN_SQL = """
CREATE OR REPLACE FUNCTION workflow_lead_times_effort_weight() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.effort_weight_weeks IS NULL THEN
            NEW.effort_weight_weeks := NEW.weeks;
        END IF;
    ELSIF NEW.effort_weight_weeks IS DISTINCT FROM OLD.effort_weight_weeks THEN
        IF NOT (
            OLD.effort_weight_weeks = 0
            AND NEW.weeks > 0
            AND NEW.effort_weight_weeks = NEW.weeks
        ) THEN
            RAISE EXCEPTION
                'workflow_lead_times.effort_weight_weeks is immutable (%/%/%: % -> %)',
                OLD.workflow_id, OLD.category, OLD.step_id,
                OLD.effort_weight_weeks, NEW.effort_weight_weeks
                USING ERRCODE = '23514',
                      CONSTRAINT = 'ck_workflow_lead_times_effort_weight_immutable';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
"""

_P33B_FN_SQL = """
CREATE OR REPLACE FUNCTION workflow_lead_times_effort_weight() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.effort_weight_weeks IS NULL THEN
            NEW.effort_weight_weeks := NEW.weeks;
        END IF;
    ELSIF NEW.effort_weight_weeks IS DISTINCT FROM OLD.effort_weight_weeks THEN
        RAISE EXCEPTION
            'workflow_lead_times.effort_weight_weeks is immutable (%/%/%: % -> %)',
            OLD.workflow_id, OLD.category, OLD.step_id,
            OLD.effort_weight_weeks, NEW.effort_weight_weeks
            USING ERRCODE = '23514',
                  CONSTRAINT = 'ck_workflow_lead_times_effort_weight_immutable';
    END IF;
    RETURN NEW;
END;
$$;
"""


def upgrade() -> None:
    op.execute(_REVIVE_FN_SQL)


def downgrade() -> None:
    op.execute(_P33B_FN_SQL)
