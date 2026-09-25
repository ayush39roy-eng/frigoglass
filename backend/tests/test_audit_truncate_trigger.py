"""P1-T07 remediation — the audit-log append-only enforcement now also covers
`TRUNCATE`, closing the gap security-auditor found in P1-T06 (verified live:
`BEFORE UPDATE OR DELETE ... FOR EACH ROW`, from `419f196fd00b`, never fires
on `TRUNCATE`, since `TRUNCATE` is a distinct statement-level operation).

This module deliberately does not touch `tests/test_audit_trigger.py`
(P1-T05/qa-inspector's file, potentially in-flight concurrently) — it is a
new, additive file exercising the new trigger
(`trg_audit_log_entries_append_only_truncate`,
`ba3881d85b55_audit_log_truncate_protection.py`) plus an explicit
no-regression check that the original UPDATE/DELETE trigger from
`419f196fd00b` is untouched by the new migration.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select, text, update
from sqlalchemy.exc import DBAPIError

from models.audit import AuditLogEntry


async def _make_audit_entry(db_session) -> AuditLogEntry:
    entry = AuditLogEntry(
        actor_user_id=None,
        action="project.create",
        entity_type="Project",
        entity_id="00000000-0000-0000-0000-000000000099",
        before_state=None,
        after_state={"name": "Truncate Regression Test Project"},
    )
    db_session.add(entry)
    await db_session.commit()  # own savepoint, survives a later session.rollback()
    return entry


async def test_insert_still_works(db_session):
    """The only legal write path is unaffected by the new trigger."""
    entry = await _make_audit_entry(db_session)
    result = await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.id == entry.id))
    assert result.scalar_one().action == "project.create"


async def test_truncate_is_rejected_and_row_survives(db_session):
    """The gap security-auditor found: TRUNCATE must now be rejected by
    `trg_audit_log_entries_append_only_truncate`, as the same DB role the
    app/migrations use (no elevated role involved in this test session).
    """
    entry = await _make_audit_entry(db_session)
    entry_id = entry.id

    with pytest.raises(DBAPIError) as exc_info:
        await db_session.execute(text("TRUNCATE audit_log_entries"))
    assert "append-only" in str(exc_info.value)
    assert "TRUNCATE" in str(exc_info.value)
    await db_session.rollback()

    # Re-query post-rollback to confirm the row is genuinely still present,
    # not just that an exception happened to be raised.
    result = await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.id == entry_id))
    assert result.scalar_one().id == entry_id


async def test_update_still_rejected_no_regression(db_session):
    """No-regression check: the pre-existing row-level trigger from
    `419f196fd00b` must still fire after this migration adds the new
    statement-level trigger alongside it.
    """
    entry = await _make_audit_entry(db_session)
    entry_id = entry.id

    with pytest.raises(DBAPIError) as exc_info:
        await db_session.execute(
            update(AuditLogEntry).where(AuditLogEntry.id == entry_id).values(action="tampered")
        )
    assert "append-only" in str(exc_info.value)
    assert "UPDATE" in str(exc_info.value)
    await db_session.rollback()

    result = await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.id == entry_id))
    assert result.scalar_one().action == "project.create"


async def test_delete_still_rejected_no_regression(db_session):
    """No-regression check, DELETE side."""
    entry = await _make_audit_entry(db_session)
    entry_id = entry.id

    with pytest.raises(DBAPIError) as exc_info:
        await db_session.execute(delete(AuditLogEntry).where(AuditLogEntry.id == entry_id))
    assert "append-only" in str(exc_info.value)
    assert "DELETE" in str(exc_info.value)
    await db_session.rollback()

    result = await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.id == entry_id))
    assert result.scalar_one().id == entry_id
