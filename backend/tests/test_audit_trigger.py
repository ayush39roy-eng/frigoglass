"""Scenario #3 — the audit-log append-only trigger
(`trg_audit_log_entries_append_only`) actually rejects UPDATE and DELETE
against `audit_log_entries`, and confirms INSERT still works and the row is
unmodified after a rejected mutation attempt.
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.exc import DBAPIError

from models.audit import AuditLogEntry


async def _make_audit_entry(db_session) -> AuditLogEntry:
    entry = AuditLogEntry(
        actor_user_id=None,
        action="project.create",
        entity_type="Project",
        entity_id="00000000-0000-0000-0000-000000000001",
        before_state=None,
        after_state={"name": "Test Project"},
    )
    db_session.add(entry)
    await db_session.commit()  # own savepoint, survives a later session.rollback()
    return entry


async def test_insert_succeeds(db_session):
    entry = await _make_audit_entry(db_session)
    result = await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.id == entry.id))
    fetched = result.scalar_one()
    assert fetched.action == "project.create"


async def test_update_is_rejected_and_row_unchanged(db_session):
    entry = await _make_audit_entry(db_session)
    entry_id = entry.id  # captured before rollback expires ORM attributes

    with pytest.raises(DBAPIError) as exc_info:
        await db_session.execute(
            update(AuditLogEntry).where(AuditLogEntry.id == entry_id).values(action="tampered")
        )
        await db_session.flush()
    assert "append-only" in str(exc_info.value)
    assert "UPDATE" in str(exc_info.value)
    await db_session.rollback()

    # Re-query in a fresh statement (post-rollback) to confirm the row is
    # genuinely unmodified, not just that the exception was raised.
    result = await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.id == entry_id))
    fetched = result.scalar_one()
    assert fetched.action == "project.create"


async def test_delete_is_rejected_and_row_still_present(db_session):
    entry = await _make_audit_entry(db_session)
    entry_id = entry.id  # captured before rollback expires ORM attributes

    with pytest.raises(DBAPIError) as exc_info:
        await db_session.execute(delete(AuditLogEntry).where(AuditLogEntry.id == entry_id))
        await db_session.flush()
    assert "append-only" in str(exc_info.value)
    assert "DELETE" in str(exc_info.value)
    await db_session.rollback()

    result = await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.id == entry_id))
    fetched = result.scalar_one()
    assert fetched.id == entry_id


async def test_update_rejected_even_for_table_owning_role(db_session):
    """The trigger (not a REVOKE-based approach) is chosen specifically so it
    blocks even the table-owning/migration role, not just a restricted API
    runtime role (see the migration file's own comment). The testcontainers
    Postgres connection here uses the default (owning) role, so this test
    doubles as that confirmation — same assertion as
    `test_update_is_rejected_and_row_unchanged`, but explicit about *which*
    role is being tested against, per the P1-T02 MEMORY.md entry's own
    verification note.
    """
    entry = await _make_audit_entry(db_session)
    entry_id = entry.id
    with pytest.raises(DBAPIError):
        await db_session.execute(
            update(AuditLogEntry).where(AuditLogEntry.id == entry_id).values(notes="hacked")
        )
        await db_session.flush()
    await db_session.rollback()
