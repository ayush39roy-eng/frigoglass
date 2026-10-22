"""Per-project effort, client vocabulary, OEM-Seitek (ADR 0041, P30-T02)

Revision ID: p30a_effort_types_hub_rename
Revises: p29b_bc_type_regulatory
Create Date: 2026-10-23

ADR 0041 as amended by the workflow-auditor's R1-R14 (binding):

1. **`project_workflow_steps.effort_weeks`** (INTEGER, NULL, CHECK 0..104).
   The per-project effort split (R2/R3, `scheduling.effort_split`) of the
   project's typed figure, kept apart from the user's
   `duration_override_weeks` (R4 provenance). Effective duration =
   `user ?? effort ?? lead`. `duration_override_weeks` keeps its ADR 0019
   CHECK 1..104 (unchanged).
2. **`projects`** gains the client's per-project figures (ADR 0041 §3,
   `docs/DATA_RECONCILIATION_2026.md` §7.3): `design_effort_weeks` (col 16),
   `lab_effort_weeks` (col 21), `safety_lab_weeks` (col 22),
   `actual_design_weeks` (col 17), `actual_testing_weeks` (col 23), all
   NUMERIC(6,2) NULL CHECK >= 0; `safety_certification_required` (col 24)
   and `capacity_flag` (col 3, decision (a)), BOOLEAN NOT NULL DEFAULT false.
   None of them is a financial field.
3. **`project_type`** gains `AC` (Alternative Component) and `SER` (Service)
   (ADR 0041 §4). `ADD VALUE` runs in an autocommit block; nothing in this
   revision uses the new labels.
4. **`hub_name`**: `OEM-Seltek` is renamed `OEM-Seitek` (ADR 0041 §4, R14;
   `ALTER TYPE ... RENAME VALUE`, transactional on PG 17). Stored schedule
   runs keep their stored strings (I14): run snapshots and outcome rows
   hold JSON / text, not this enum, and the scheduler accepts both
   spellings (`scheduling.hubs`).
5. **Chamber `allowed_stages`** follow the client's test-type mapping (ADR
   0041 §4, decision (e)): IN-CH1 {F}, IN-CH2 {F, H}, IN-CH4 {F}, GR-CH2
   {F, H, OEM-E, OEM-H}, RO-CH2 {F, H}. A chamber is changed only while it
   still carries the pre-ADR stages (an admin's later edit is left alone);
   one `chamber.update` audit row each (actor null, `after_state.source =
   "chamber_stages_adr_0041"`), and every schedulable project is marked
   `schedule_stale` when any chamber changed (a chamber edit is a scheduler
   input, ADR 0006). Never solves.

No effort split is written here: existing projects carry no figure (the
columns are new), so every `effort_weeks` stays NULL and every schedule is
unchanged until a figure is entered or the seed runs.

Downgrade reverses 1, 2, 4 and 5 (chambers only while they still carry the
ADR 0041 stages; audited). Postgres cannot drop an enum value, so `AC` /
`SER` stay in `project_type`; a project typed `AC` / `SER` is set back to
NULL (audited) so the pre-ADR application never reads an unknown value.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa

from alembic import op

revision: str = "p30a_effort_types_hub_rename"
down_revision: str | Sequence[str] | None = "p29b_bc_type_regulatory"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_log = logging.getLogger("alembic.runtime.migration")

_OLD_HUB = "OEM-Seltek"
_NEW_HUB = "OEM-Seitek"
_NEW_TYPES: tuple[str, ...] = ("AC", "SER")
_CHAMBER_SOURCE = "chamber_stages_adr_0041"
_TYPE_SOURCE = "type_downgrade_adr_0041"

#: (code, pre-ADR stages, ADR 0041 stages), frozen copies.
_CHAMBER_STAGES: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("IN-CH1", ("PDD-F", "PDD-H"), ("PDD-F",)),
    ("IN-CH2", ("PDD-F",), ("PDD-F", "PDD-H")),
    ("IN-CH4", (), ("PDD-F",)),
    ("GR-CH2", ("PDD-F", "OEM-E"), ("PDD-F", "PDD-H", "OEM-E", "OEM-H")),
    ("RO-CH2", ("PDD-F",), ("PDD-F", "PDD-H")),
)

_DECIMAL_COLUMNS: tuple[str, ...] = (
    "design_effort_weeks",
    "lab_effort_weeks",
    "safety_lab_weeks",
    "actual_design_weeks",
    "actual_testing_weeks",
)
_BOOL_COLUMNS: tuple[str, ...] = ("safety_certification_required", "capacity_flag")

_SCHEDULABLE = ("In Buyoff", "Under Industrialization", "In Development", "In Queue")

_INSERT_AUDIT = sa.text(
    "INSERT INTO audit_log_entries "
    "(id, actor_user_id, action, entity_type, entity_id, hub_id, before_state, "
    "after_state, notes) VALUES (:id, NULL, :action, :entity_type, :entity_id, "
    ":hub_id, CAST(:before AS jsonb), CAST(:after AS jsonb), :notes)"
)


def _audit(
    bind: sa.Connection,
    *,
    action: str,
    entity_type: str,
    entity_id: str,
    hub_id: uuid.UUID | None,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    notes: str,
) -> None:
    bind.execute(
        _INSERT_AUDIT,
        {
            "id": uuid.uuid4(),
            "action": action,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "hub_id": hub_id,
            "before": json.dumps(before) if before is not None else None,
            "after": json.dumps(after) if after is not None else None,
            "notes": notes,
        },
    )


def _hub_value_exists(bind: sa.Connection, value: str) -> bool:
    return bool(
        bind.execute(
            sa.text(
                "SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid "
                "WHERE t.typname = 'hub_name' AND e.enumlabel = :v"
            ),
            {"v": value},
        ).first()
    )


def _set_chamber_stages(bind: sa.Connection, *, forward: bool) -> int:
    changed = 0
    for code, before_stages, after_stages in _CHAMBER_STAGES:
        old, new = (before_stages, after_stages) if forward else (after_stages, before_stages)
        row = bind.execute(
            sa.text(
                "SELECT id, CAST(allowed_stages AS text[]) AS stages FROM chambers "
                "WHERE code = :code"
            ),
            {"code": code},
        ).first()
        if row is None or tuple(row.stages or ()) != old:
            continue
        bind.execute(
            sa.text(
                "UPDATE chambers SET allowed_stages = CAST(:stages AS varchar(10)[]) "
                "WHERE id = :id"
            ),
            {"stages": list(new), "id": row.id},
        )
        _audit(
            bind,
            action="chamber.update",
            entity_type="Chamber",
            entity_id=str(row.id),
            hub_id=None,
            before={"code": code, "allowed_stages": list(old)},
            after={"code": code, "allowed_stages": list(new), "source": _CHAMBER_SOURCE},
            notes=(
                "migration p30a: chamber stages per the client's test-type mapping (ADR 0041 §4)"
                if forward
                else "migration p30a downgrade: pre-ADR 0041 chamber stages restored"
            ),
        )
        changed += 1
    if changed:
        bind.execute(
            sa.text(
                "UPDATE projects SET schedule_stale = true "
                "WHERE CAST(status AS text) = ANY(:statuses)"
            ),
            {"statuses": list(_SCHEDULABLE)},
        )
    return changed


def upgrade() -> None:
    bind = op.get_bind()

    # 1. Per-step derived effort (R4: its own column).
    op.add_column(
        "project_workflow_steps", sa.Column("effort_weeks", sa.Integer(), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_project_workflow_steps_effort_weeks_range"),
        "project_workflow_steps",
        "effort_weeks IS NULL OR effort_weeks BETWEEN 0 AND 104",
    )

    # 2. Per-project client figures.
    for name in _DECIMAL_COLUMNS:
        op.add_column("projects", sa.Column(name, sa.Numeric(6, 2), nullable=True))
        op.create_check_constraint(
            op.f(f"ck_projects_{name}_non_negative"), "projects", f"{name} IS NULL OR {name} >= 0"
        )
    for name in _BOOL_COLUMNS:
        op.add_column(
            "projects",
            sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.false()),
        )

    # 4. Hub spelling (transactional).
    if _hub_value_exists(bind, _OLD_HUB) and not _hub_value_exists(bind, _NEW_HUB):
        op.execute(f"ALTER TYPE hub_name RENAME VALUE '{_OLD_HUB}' TO '{_NEW_HUB}'")

    # 5. Chamber stages (client mapping).
    changed = _set_chamber_stages(bind, forward=True)
    _log.info("p30a: %d chamber(s) moved to the ADR 0041 test-type mapping", changed)

    # 3. New project types. ADD VALUE must be committed before use; nothing
    # here uses them, but run it last in its own autocommit block.
    with op.get_context().autocommit_block():
        for value in _NEW_TYPES:
            op.execute(f"ALTER TYPE project_type ADD VALUE IF NOT EXISTS '{value}'")


def downgrade() -> None:
    bind = op.get_bind()

    # 3. Enum values cannot be dropped; un-type the projects that use them.
    rows = bind.execute(
        sa.text(
            "SELECT id, hub_id, CAST(type AS text) AS type FROM projects "
            "WHERE CAST(type AS text) = ANY(:types) ORDER BY id"
        ),
        {"types": list(_NEW_TYPES)},
    ).all()
    for row in rows:
        bind.execute(sa.text("UPDATE projects SET type = NULL WHERE id = :id"), {"id": row.id})
        _audit(
            bind,
            action="project.update",
            entity_type="Project",
            entity_id=str(row.id),
            hub_id=row.hub_id,
            before={"type": row.type},
            after={"type": None, "source": _TYPE_SOURCE},
            notes="migration p30a downgrade: type unknown to the pre-ADR 0041 schema",
        )

    # 5. Chamber stages back (only where still the ADR 0041 mapping).
    _set_chamber_stages(bind, forward=False)

    # 4. Hub spelling back.
    if _hub_value_exists(bind, _NEW_HUB) and not _hub_value_exists(bind, _OLD_HUB):
        op.execute(f"ALTER TYPE hub_name RENAME VALUE '{_NEW_HUB}' TO '{_OLD_HUB}'")

    # 2. Per-project figures.
    for name in reversed(_BOOL_COLUMNS):
        op.drop_column("projects", name)
    for name in reversed(_DECIMAL_COLUMNS):
        op.drop_constraint(op.f(f"ck_projects_{name}_non_negative"), "projects", type_="check")
        op.drop_column("projects", name)

    # 1. Derived effort.
    op.drop_constraint(
        op.f("ck_project_workflow_steps_effort_weeks_range"), "project_workflow_steps", type_="check"
    )
    op.drop_column("project_workflow_steps", "effort_weeks")
