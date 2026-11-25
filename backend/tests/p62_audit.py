"""P62-T04: migration `p71a_lab_hold_weeks` writes its own audit rows on any
database that has a category template (the shared test DB included): one
`workflow_template.applied` per category it changed (actor NULL, `notes` =
the migration's note). Tests that assert "nothing was audited" count every
other row."""

from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.audit import AuditLogEntry
from models.workflow import TemplateChange

#: The `template_version` of categories A+, A, B and C on the migrated test DB:
#: the seed's 1, plus migration p71a's own template change (room weeks for
#: PDD-J / PDD-L, C/PDD-J 1 -> 0). Every other category is still at 1.
P71A_TEMPLATE_VERSION = 2

#: `audit_log_entries.notes` of the rows migration p71a writes.
P71A_NOTES = "ADR 0071: lab hold weeks (migration p71a_lab_hold_weeks)"

#: A WHERE clause that leaves migration p71a's rows out.
NOT_MIGRATION_AUDIT = or_(AuditLogEntry.notes.is_(None), AuditLogEntry.notes != P71A_NOTES)

#: The `template_changes` row p71a writes (reason `p62_lab_hold_defaults`).
P71A_CHANGE_REASON = "p62_lab_hold_defaults"
NOT_MIGRATION_CHANGE = or_(
    TemplateChange.reason.is_(None), TemplateChange.reason != P71A_CHANGE_REASON
)


async def migration_audit_count(db: AsyncSession) -> int:
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(AuditLogEntry)
                .where(AuditLogEntry.notes == P71A_NOTES)
            )
        ).scalar_one()
    )
