"""Scenario #2 — the partial unique indexes (`ux_schedule_runs_one_active`,
`ux_priority_application_runs_one_active`) actually enforce "at most one
active row", and multiple inactive rows coexist freely.
"""

from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError

from tests.factories import make_priority_application_run, make_schedule_run


async def test_schedule_runs_second_active_row_raises_unique_violation(db_session):
    await make_schedule_run(db_session, is_active=True)

    with pytest.raises(IntegrityError) as exc_info:
        await make_schedule_run(db_session, is_active=True)
    assert "ux_schedule_runs_one_active" in str(exc_info.value)
    await db_session.rollback()


async def test_schedule_runs_multiple_inactive_rows_coexist(db_session):
    await make_schedule_run(db_session, is_active=False)
    await make_schedule_run(db_session, is_active=False)
    r3 = await make_schedule_run(db_session, is_active=False)
    # No exception raised for any of the three — this line is only reached
    # if all three inserts above succeeded.
    assert r3.is_active is False


async def test_schedule_runs_one_active_plus_many_inactive_coexist(db_session):
    await make_schedule_run(db_session, is_active=True)
    await make_schedule_run(db_session, is_active=False)
    await make_schedule_run(db_session, is_active=False)
    # Still only one active row permitted alongside the inactive ones.
    with pytest.raises(IntegrityError):
        await make_schedule_run(db_session, is_active=True)
    await db_session.rollback()


async def test_priority_application_runs_second_active_row_raises_unique_violation(db_session):
    await make_priority_application_run(db_session, is_active=True)

    with pytest.raises(IntegrityError) as exc_info:
        await make_priority_application_run(db_session, is_active=True)
    assert "ux_priority_application_runs_one_active" in str(exc_info.value)
    await db_session.rollback()


async def test_priority_application_runs_multiple_inactive_rows_coexist(db_session):
    await make_priority_application_run(db_session, is_active=False)
    await make_priority_application_run(db_session, is_active=False)
    r3 = await make_priority_application_run(db_session, is_active=False)
    assert r3.is_active is False
