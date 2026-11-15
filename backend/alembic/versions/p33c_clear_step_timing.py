"""retire per-project step timing: clear the hand-set values, CHECK them null
(P33-T13, ADR 0048 §3)

Revision ID: p33c_clear_step_timing
Revises: p33b_template_copy
Create Date: 2026-11-15

Per-project step timing editing is retired (ADR 0048; DOMAIN_RULES "Category
templates" §F; docs/API_CONTRACT_P33.md Part G / F4 "After p33c"). The
category template copy (`plan_weeks` / `plan_gap_weeks`, p33b) is the one
timing tool. This migration:

1. writes one `project.step_timing_cleared` audit row per affected project
   (actor NULL = system; `before_state.steps` = the three fields of every
   step that carried a value; `after_state` = the same steps with every field
   null, `schedule_stale: true` and `reason: "ADR 0048"`);
2. sets `duration_override_weeks`, `start_not_before_week` and
   `overlap_weeks` to NULL on every row (the owner asked to clear the
   overlaps, not to convert them into gaps);
3. sets `schedule_stale` on the affected projects;
4. adds `CHECK (duration_override_weeks IS NULL AND start_not_before_week IS
   NULL AND overlap_weeks IS NULL)` (`ck_project_workflow_steps_step_timing_
   retired`), so nothing can write them again.

The columns stay until P33-F01 drops them. A migration never dispatches a
run: `python -m scripts.p33_recalc_after_timing_clear`, run once after
`alembic upgrade`, dispatches the one greedy run (`timing_cleared`).

Revises `p33b_template_copy`, the head when this was written; the untracked
chain is `p32a → p35a → p33a → p36a → p33b → p33c`.

Downgrade drops the CHECK and restores the cleared values from the audit
rows this migration wrote (`notes` names it), so a round trip preserves
every value; `schedule_stale` stays set and the audit rows stay (append-only).
No financial field is read or written.
"""

from __future__ import annotations

import json
import uuid
from collections import defaultdict
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa

from alembic import op

revision: str = "p33c_clear_step_timing"
down_revision: str | Sequence[str] | None = "p33b_template_copy"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "project_workflow_steps"
_CHECK = "ck_project_workflow_steps_step_timing_retired"
_FIELDS = ("duration_override_weeks", "start_not_before_week", "overlap_weeks")
_ACTION = "project.step_timing_cleared"
_NOTES = "ADR 0048: per-project step timing retired (migration p33c_clear_step_timing)"

_SELECT_SET = sa.text(
    "SELECT s.project_id, s.step_template_id, s.duration_override_weeks, "
    "s.start_not_before_week, s.overlap_weeks, p.hub_id, p.schedule_stale "
    "FROM project_workflow_steps s JOIN projects p ON p.id = s.project_id "
    "WHERE s.duration_override_weeks IS NOT NULL OR s.start_not_before_week IS NOT NULL "
    "OR s.overlap_weeks IS NOT NULL "
    "ORDER BY s.project_id, s.step_template_id"
)

_INSERT_AUDIT = sa.text(
    "INSERT INTO audit_log_entries "
    "(id, actor_user_id, action, entity_type, entity_id, hub_id, before_state, "
    "after_state, notes) VALUES (:id, NULL, :action, 'Project', :entity_id, "
    ":hub_id, CAST(:before AS jsonb), CAST(:after AS jsonb), :notes)"
)

_CLEAR = sa.text(
    "UPDATE project_workflow_steps SET duration_override_weeks = NULL, "
    "start_not_before_week = NULL, overlap_weeks = NULL "
    "WHERE duration_override_weeks IS NOT NULL OR start_not_before_week IS NOT NULL "
    "OR overlap_weeks IS NOT NULL"
)

_MARK_STALE = sa.text("UPDATE projects SET schedule_stale = true WHERE id = :id")


def upgrade() -> None:
    bind = op.get_bind()
    by_project: dict[Any, dict[str, Any]] = defaultdict(
        lambda: {"hub_id": None, "stale": False, "steps": {}}
    )
    for row in bind.execute(_SELECT_SET).mappings():
        entry = by_project[row["project_id"]]
        entry["hub_id"] = row["hub_id"]
        entry["stale"] = bool(row["schedule_stale"])
        entry["steps"][row["step_template_id"]] = {f: row[f] for f in _FIELDS}

    for project_id, entry in sorted(by_project.items(), key=lambda kv: str(kv[0])):
        steps = dict(sorted(entry["steps"].items()))
        bind.execute(
            _INSERT_AUDIT,
            {
                "id": uuid.uuid4(),
                "action": _ACTION,
                "entity_id": str(project_id),
                "hub_id": entry["hub_id"],
                "before": json.dumps(
                    {"steps": steps, "schedule_stale": entry["stale"]}, sort_keys=True
                ),
                "after": json.dumps(
                    {
                        "steps": {sid: dict.fromkeys(_FIELDS) for sid in steps},
                        "schedule_stale": True,
                        "reason": "ADR 0048",
                    },
                    sort_keys=True,
                ),
                "notes": _NOTES,
            },
        )
    bind.execute(_CLEAR)
    for project_id in by_project:
        bind.execute(_MARK_STALE, {"id": project_id})

    op.create_check_constraint(
        op.f(_CHECK),
        _TABLE,
        "duration_override_weeks IS NULL AND start_not_before_week IS NULL "
        "AND overlap_weeks IS NULL",
    )


def downgrade() -> None:
    op.drop_constraint(op.f(_CHECK), _TABLE, type_="check")
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT entity_id, before_state FROM audit_log_entries "
            "WHERE action = :action AND notes = :notes ORDER BY occurred_at, id"
        ),
        {"action": _ACTION, "notes": _NOTES},
    ).all()
    restore = sa.text(
        "UPDATE project_workflow_steps SET duration_override_weeks = :d, "
        "start_not_before_week = :s, overlap_weeks = :o "
        "WHERE project_id = :pid AND step_template_id = :sid"
    )
    for entity_id, before in rows:
        state = before if isinstance(before, dict) else json.loads(before)
        for step_id, values in (state.get("steps") or {}).items():
            bind.execute(
                restore,
                {
                    "pid": uuid.UUID(entity_id),
                    "sid": step_id,
                    "d": values.get("duration_override_weeks"),
                    "s": values.get("start_not_before_week"),
                    "o": values.get("overlap_weeks"),
                },
            )
