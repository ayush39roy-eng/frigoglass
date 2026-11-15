"""per-project copy of the category template (P33-T08, ADR 0046)

Revision ID: p33b_template_copy
Revises: p36a_project_band_rank
Create Date: 2026-11-15

ADR 0046 as ruled (precedence: owner ruling OR-1..OR-6 > R33 > text),
DOMAIN_RULES "Category templates" §A/§B, contract P33 Part F4.

**Chain note.** `p33b` revises `p36a_project_band_rank` (P36-T03), the head of
the working tree when this was written (`p35a` -> `p33a` -> `p36a`), so the
chain stays linear. If P36-T03 is reordered or dropped, `down_revision`
must follow it.

Upgrade:

- `template_changes` (`models.workflow.TemplateChange`): one row per template
  apply (P33-T10 writes it; nothing writes it here): `id`, `at`,
  `actor_user_id` FK `users`, `reason` (<= 500), `changes` and `selection`
  (JSONB).
- `workflow_lead_times` (the category template, §A):
  - `gap_weeks` INTEGER NOT NULL DEFAULT 0, CHECK -104..104 (the signed gap;
    negative = overlap, positive = wait);
  - `effort_weight_weeks` INTEGER NOT NULL, CHECK 0..104, backfilled = `weeks`
    (R33-2: the R2 split weights). **Immutable**: trigger
    `trg_workflow_lead_times_effort_weight` rejects an UPDATE that changes it
    (SQLSTATE 23514, constraint name
    `ck_workflow_lead_times_effort_weight_immutable`) and fills it from
    `weeks` on an INSERT that leaves it NULL.
- `project_workflow_steps` (the per-project copy, §B):
  - `plan_weeks` INTEGER NOT NULL, CHECK 0..104, backfilled from the table
    in force for the project's workflow and category (0 when the project has
    no category, as `duration_weeks` does);
  - `plan_gap_weeks` INTEGER NOT NULL DEFAULT 0, CHECK -104..104;
  - `template_change_id` UUID NULL, FK `template_changes.id` (provenance).
- No `length_pinned` / `length_set` (OR-6).

After the backfill every copy equals the table and every gap is 0, so the
live input builder (contract F4 with the T05-A1 transitional rule) emits no
`lead_weeks`, no `wait_weeks` and the same overlaps as before: the live
input hash, a fresh run and every stored run are byte-identical (verified on
a copy of the dev DB, P33-T08).

Downgrade drops the trigger, the columns and the table. Nothing else read
them before this revision.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "p33b_template_copy"
down_revision: str | Sequence[str] | None = "p36a_project_band_rank"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STEPS = "project_workflow_steps"
_LEAD = "workflow_lead_times"

_WEIGHT_FN = "workflow_lead_times_effort_weight"
_WEIGHT_TRIGGER = "trg_workflow_lead_times_effort_weight"

# Immutable weights (DOMAIN_RULES §A: edited "never"; copied by "+ Add
# category", which INSERTs). An INSERT that omits the weight takes `weeks`,
# the backfill rule.
_WEIGHT_FN_SQL = f"""
CREATE FUNCTION {_WEIGHT_FN}() RETURNS trigger
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

# Backfill: the table in force for the project's workflow (hub.is_oem ->
# OEM, else PDD) and category, exactly as
# `services.workflow_durations.recompute_step_durations_statement` and the
# live builder's table lookup.
_BACKFILL_PLAN_SQL = f"""
UPDATE {_STEPS} AS s
SET plan_weeks = lt.weeks
FROM projects AS p
JOIN hubs AS h ON h.id = p.hub_id
JOIN {_LEAD} AS lt
  ON lt.category = p.category
 AND lt.workflow_id = CASE WHEN h.is_oem THEN 'OEM' ELSE 'PDD' END
WHERE s.project_id = p.id
  AND lt.step_id = s.step_template_id
"""


def upgrade() -> None:
    op.create_table(
        "template_changes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("actor_user_id", sa.Uuid(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("changes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("selection", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.CheckConstraint(
            "reason IS NULL OR char_length(reason) <= 500",
            name=op.f("ck_template_changes_reason_length"),
        ),
        sa.ForeignKeyConstraint(
            ["actor_user_id"],
            ["users.id"],
            name=op.f("fk_template_changes_actor_user_id_users"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_template_changes")),
    )

    # --- the category template --------------------------------------------------
    op.add_column(_LEAD, sa.Column("gap_weeks", sa.Integer(), server_default="0", nullable=False))
    op.create_check_constraint(
        op.f("ck_workflow_lead_times_gap_weeks_range"),
        _LEAD,
        "gap_weeks BETWEEN -104 AND 104",
    )
    op.add_column(_LEAD, sa.Column("effort_weight_weeks", sa.Integer(), nullable=True))
    op.execute(f"UPDATE {_LEAD} SET effort_weight_weeks = weeks")
    op.alter_column(_LEAD, "effort_weight_weeks", nullable=False)
    op.create_check_constraint(
        op.f("ck_workflow_lead_times_effort_weight_weeks_range"),
        _LEAD,
        "effort_weight_weeks BETWEEN 0 AND 104",
    )
    op.execute(_WEIGHT_FN_SQL)
    op.execute(
        f"CREATE TRIGGER {_WEIGHT_TRIGGER} BEFORE INSERT OR UPDATE ON {_LEAD} "
        f"FOR EACH ROW EXECUTE FUNCTION {_WEIGHT_FN}()"
    )

    # --- the per-project copy -----------------------------------------------------
    op.add_column(_STEPS, sa.Column("plan_weeks", sa.Integer(), nullable=True))
    op.execute(_BACKFILL_PLAN_SQL)
    # No category (or no template row): 0, as `duration_weeks` has it.
    op.execute(f"UPDATE {_STEPS} SET plan_weeks = 0 WHERE plan_weeks IS NULL")
    op.alter_column(_STEPS, "plan_weeks", nullable=False)
    op.create_check_constraint(
        op.f("ck_project_workflow_steps_plan_weeks_range"),
        _STEPS,
        "plan_weeks BETWEEN 0 AND 104",
    )
    op.add_column(
        _STEPS, sa.Column("plan_gap_weeks", sa.Integer(), server_default="0", nullable=False)
    )
    op.create_check_constraint(
        op.f("ck_project_workflow_steps_plan_gap_weeks_range"),
        _STEPS,
        "plan_gap_weeks BETWEEN -104 AND 104",
    )
    op.add_column(_STEPS, sa.Column("template_change_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_project_workflow_steps_template_change_id_template_changes"),
        _STEPS,
        "template_changes",
        ["template_change_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_project_workflow_steps_template_change_id_template_changes"),
        _STEPS,
        type_="foreignkey",
    )
    op.drop_column(_STEPS, "template_change_id")
    op.drop_constraint(
        op.f("ck_project_workflow_steps_plan_gap_weeks_range"), _STEPS, type_="check"
    )
    op.drop_column(_STEPS, "plan_gap_weeks")
    op.drop_constraint(op.f("ck_project_workflow_steps_plan_weeks_range"), _STEPS, type_="check")
    op.drop_column(_STEPS, "plan_weeks")

    op.execute(f"DROP TRIGGER {_WEIGHT_TRIGGER} ON {_LEAD}")
    op.execute(f"DROP FUNCTION {_WEIGHT_FN}()")
    op.drop_constraint(
        op.f("ck_workflow_lead_times_effort_weight_weeks_range"), _LEAD, type_="check"
    )
    op.drop_column(_LEAD, "effort_weight_weeks")
    op.drop_constraint(op.f("ck_workflow_lead_times_gap_weeks_range"), _LEAD, type_="check")
    op.drop_column(_LEAD, "gap_weeks")

    op.drop_table("template_changes")
