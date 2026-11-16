"""Run outcome band flags (P42-T03, ADR 0056 as ruled at P42-T01, R42-4 / R42-10)

Revision ID: p42a_outcome_band_flags
Revises: p38a_engineer_deactivation
Create Date: 2026-11-17

docs/DOMAIN_RULES.md "Priority band meaning", docs/API_CONTRACT_P42.md.

Upgrade:

- `schedule_run_project_outcomes.counts_toward_year` BOOLEAN NOT NULL DEFAULT
  true and `not_scheduled_priority` BOOLEAN NOT NULL DEFAULT false. The
  defaults are truthful for every historic run: no run before P42 excluded a
  band or discounted a queued project (I14: old runs are never rewritten).
- R42-10: every project whose classification changes under R42-3 / R42-4 is
  marked `schedule_stale`: status schedulable AND (priority P4 / Q, or P3 with
  status In Queue). One `project.schedule_stale` audit row is written per
  project that was not already stale (actor null, `reason: "ADR 0056"`).
  Nothing solves: the rollout dispatches one greedy run afterwards
  (`scripts/p42_band_rules_run.py`, trigger_reason `band_rules`).

Downgrade drops the two columns. `schedule_stale` stays set and the audit rows
stay (append-only).

Constant SQL only; the only bound values are uuids.
"""

import json
import uuid
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "p42a_outcome_band_flags"
down_revision: str | Sequence[str] | None = "p38a_engineer_deactivation"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "schedule_run_project_outcomes"
_ACTION = "project.schedule_stale"
_NOTES = "ADR 0056: priority band classification changed (migration p42a_outcome_band_flags)"

#: R42-4 frozen here (a migration must not change meaning when the constant
#: does): schedulable status AND (P4 / Q, or P3 In Queue).
_SELECT_CHANGED = sa.text(
    "SELECT id, hub_id, schedule_stale, priority::text AS priority, status::text AS status "
    "FROM projects "
    "WHERE status::text IN ('In Buyoff', 'Under Industrialization', 'In Development', "
    "'In Queue') "
    "AND (priority::text IN ('P4', 'Q') "
    "OR (priority::text = 'P3' AND status::text = 'In Queue')) "
    "ORDER BY id"
)

_INSERT_AUDIT = sa.text(
    "INSERT INTO audit_log_entries "
    "(id, actor_user_id, action, entity_type, entity_id, hub_id, before_state, "
    "after_state, notes) VALUES (:id, NULL, :action, 'Project', :entity_id, "
    ":hub_id, CAST(:before AS jsonb), CAST(:after AS jsonb), :notes)"
)

_MARK_STALE = sa.text("UPDATE projects SET schedule_stale = true WHERE id = :id")


def upgrade() -> None:
    op.add_column(
        _TABLE,
        sa.Column("counts_toward_year", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        _TABLE,
        sa.Column(
            "not_scheduled_priority", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )

    bind = op.get_bind()
    rows = list(bind.execute(_SELECT_CHANGED).mappings())
    for row in rows:
        if row["schedule_stale"]:
            continue
        bind.execute(
            _INSERT_AUDIT,
            {
                "id": uuid.uuid4(),
                "action": _ACTION,
                "entity_id": str(row["id"]),
                "hub_id": row["hub_id"],
                "before": json.dumps({"schedule_stale": False}, sort_keys=True),
                "after": json.dumps(
                    {
                        "schedule_stale": True,
                        "reason": "ADR 0056",
                        "priority": row["priority"],
                        "status": row["status"],
                    },
                    sort_keys=True,
                ),
                "notes": _NOTES,
            },
        )
        bind.execute(_MARK_STALE, {"id": row["id"]})


def downgrade() -> None:
    op.drop_column(_TABLE, "not_scheduled_priority")
    op.drop_column(_TABLE, "counts_toward_year")
