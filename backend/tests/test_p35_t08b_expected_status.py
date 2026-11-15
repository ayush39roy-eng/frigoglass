"""P35-T08b (OQ #84 assumption, adopted 2026-11-15): `expected_status` /
`status_mismatch` on the `GET /dashboard/projects` rows.

Mapping by step letter, PDD and OEM alike: A → In Queue; B–H → In
Development; I–M → Under Industrialization; N → Commercialized; no current
step (all Done) → Commercialized. On Hold / Cancelled / In Buyoff / Draft:
no expectation, never a mismatch. Display warning only, computed from the
same current stage the row serves as `current_step_code`, with no extra
statement.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    RoleName,
    WorkflowStepStatus,
)
from models.project import Project
from services.expected_status import (
    EXPECTED_STATUS_BY_STEP_LETTER,
    expected_status_for,
    status_mismatch,
)
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_hub
from tests.p12_helpers import act_as, client_for, set_progress, stepped_project

_LETTERS = "ABCDEFGHIJKLMN"
_BANDS: dict[str, ProjectStatus] = {
    "A": ProjectStatus.IN_QUEUE,
    **{c: ProjectStatus.IN_DEVELOPMENT for c in "BCDEFGH"},
    **{c: ProjectStatus.UNDER_INDUSTRIALIZATION for c in "IJKLM"},
    "N": ProjectStatus.COMMERCIALIZED,
}
_EXEMPT = (
    ProjectStatus.ON_HOLD,
    ProjectStatus.CANCELLED,
    ProjectStatus.IN_BUYOFF,
    ProjectStatus.DRAFT,
)


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


# --------------------------------------------------------------------------
# The mapping (pure)
# --------------------------------------------------------------------------


def test_mapping_covers_exactly_the_fourteen_letters() -> None:
    assert dict(EXPECTED_STATUS_BY_STEP_LETTER) == _BANDS
    assert "".join(sorted(EXPECTED_STATUS_BY_STEP_LETTER)) == _LETTERS


@pytest.mark.parametrize("workflow", ["PDD", "OEM"])
@pytest.mark.parametrize("letter", list(_LETTERS))
def test_each_letter_band(workflow: str, letter: str) -> None:
    expected = _BANDS[letter]
    step = f"{workflow}-{letter}"
    assert expected_status_for(ProjectStatus.IN_DEVELOPMENT, step) is expected
    assert expected_status_for(ProjectStatus.IN_QUEUE, step) is expected
    assert status_mismatch(expected, expected_status_for(expected, step)) is False
    other = (
        ProjectStatus.IN_QUEUE
        if expected is not ProjectStatus.IN_QUEUE
        else ProjectStatus.IN_DEVELOPMENT
    )
    assert status_mismatch(other, expected_status_for(other, step)) is True


def test_no_current_step_is_commercialized() -> None:
    assert expected_status_for(ProjectStatus.IN_DEVELOPMENT, None) is ProjectStatus.COMMERCIALIZED
    assert expected_status_for(ProjectStatus.COMMERCIALIZED, None) is ProjectStatus.COMMERCIALIZED


@pytest.mark.parametrize("status", _EXEMPT)
@pytest.mark.parametrize("step", ["PDD-A", "OEM-E", "PDD-K", "OEM-N", None])
def test_exempt_statuses_have_no_expectation(status: ProjectStatus, step: str | None) -> None:
    expected = expected_status_for(status, step)
    assert expected is None
    assert status_mismatch(status, expected) is False


def test_unknown_letter_makes_no_guess() -> None:
    assert expected_status_for(ProjectStatus.IN_DEVELOPMENT, "PDD-Z") is None
    assert status_mismatch(ProjectStatus.IN_DEVELOPMENT, None) is False


# --------------------------------------------------------------------------
# Served on GET /dashboard/projects
# --------------------------------------------------------------------------


async def _done_before(
    db: AsyncSession, project: Project, workflow: str, letter: str | None
) -> None:
    """Marks every step before `letter` Done (`letter=None`: all 14)."""

    stop = _LETTERS.index(letter) if letter is not None else len(_LETTERS)
    for i, c in enumerate(_LETTERS[:stop], start=1):
        await set_progress(
            db, project, f"{workflow}-{c}", WorkflowStepStatus.DONE, percent=100, start=i, end=i
        )


def _row(rows: list[dict[str, Any]], project: Project) -> dict[str, Any]:
    return next(r for r in rows if r["project_id"] == str(project.id))


async def _rows(db: AsyncSession) -> list[dict[str, Any]]:
    async with client_for(db) as client:
        resp = await client.get("/dashboard/projects")
    assert resp.status_code == 200, resp.text
    rows: list[dict[str, Any]] = resp.json()["rows"]
    return rows


@pytest.mark.parametrize("oem", [False, True], ids=["PDD", "OEM"])
async def test_served_bands_and_all_done(db_session: AsyncSession, oem: bool) -> None:
    hub = (
        await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.GREECE, is_oem=True)
        if oem
        else await make_hub(db_session)
    )
    workflow = "OEM" if oem else "PDD"
    # A+ / A-OEM: no zero-lead-time (skipped) step at the letters used; A-OEM
    # skips I, K, L, M, so OEM tests the I–M band at J.
    category = ProjectCategory.A_OEM if oem else ProjectCategory.A_PLUS
    first_i, last_i = ("J", "J") if oem else ("I", "M")
    # (current letter or None = all done, project status, expected, mismatch)
    cases: list[tuple[str | None, ProjectStatus, ProjectStatus, bool]] = [
        ("A", ProjectStatus.IN_QUEUE, ProjectStatus.IN_QUEUE, False),
        ("A", ProjectStatus.IN_DEVELOPMENT, ProjectStatus.IN_QUEUE, True),
        ("E", ProjectStatus.IN_DEVELOPMENT, ProjectStatus.IN_DEVELOPMENT, False),
        ("H", ProjectStatus.IN_QUEUE, ProjectStatus.IN_DEVELOPMENT, True),
        (
            first_i,
            ProjectStatus.UNDER_INDUSTRIALIZATION,
            ProjectStatus.UNDER_INDUSTRIALIZATION,
            False,
        ),
        (last_i, ProjectStatus.IN_DEVELOPMENT, ProjectStatus.UNDER_INDUSTRIALIZATION, True),
        ("N", ProjectStatus.COMMERCIALIZED, ProjectStatus.COMMERCIALIZED, False),
        ("N", ProjectStatus.UNDER_INDUSTRIALIZATION, ProjectStatus.COMMERCIALIZED, True),
        (None, ProjectStatus.COMMERCIALIZED, ProjectStatus.COMMERCIALIZED, False),
        (None, ProjectStatus.IN_DEVELOPMENT, ProjectStatus.COMMERCIALIZED, True),
    ]
    projects: list[Project] = []
    for i, (letter, status, _, _) in enumerate(cases):
        p = await stepped_project(
            db_session, hub, name=f"{workflow} {i}", status=status, category=category
        )
        await _done_before(db_session, p, workflow, letter)
        projects.append(p)
    await act_as(db_session, RoleName.ADMIN)
    rows = await _rows(db_session)

    for p, (letter, _, expected, mismatch) in zip(projects, cases, strict=True):
        r = _row(rows, p)
        assert r["current_step_code"] == (f"{workflow}-{letter}" if letter else None), r
        assert r["expected_status"] == expected.value, (letter, r)
        assert r["status_mismatch"] is mismatch, (letter, r)


@pytest.mark.parametrize("status", _EXEMPT)
async def test_served_exempt_statuses(db_session: AsyncSession, status: ProjectStatus) -> None:
    hub = await make_hub(db_session)
    at_k = await stepped_project(db_session, hub, name="Exempt K", status=status)
    await _done_before(db_session, at_k, "PDD", "K")
    all_done = await stepped_project(db_session, hub, name="Exempt done", status=status)
    await _done_before(db_session, all_done, "PDD", None)
    await act_as(db_session, RoleName.ADMIN)
    rows = await _rows(db_session)

    for p in (at_k, all_done):
        r = _row(rows, p)
        assert r["status"] == status.value
        assert r["expected_status"] is None
        assert r["status_mismatch"] is False


async def test_no_extra_statements(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The fields add no statement: the count with them equals the count
    with the computation stubbed out, and does not grow with rows."""

    from api.routers import dashboard as dashboard_router

    hub = await make_hub(db_session)
    await act_as(db_session, RoleName.ADMIN)

    async def _count() -> int:
        statements: list[str] = []

        def _record(orm_execute_state: Any) -> None:
            statements.append(str(orm_execute_state.statement))

        target = db_session.sync_session
        async with client_for(db_session) as client:
            event.listen(target, "do_orm_execute", _record)
            try:
                resp = await client.get("/dashboard/projects")
            finally:
                event.remove(target, "do_orm_execute", _record)
        assert resp.status_code == 200, resp.text
        assert all("status_mismatch" in r for r in resp.json()["rows"])
        return len(statements)

    for i in range(2):
        p = await stepped_project(db_session, hub, name=f"Few {i}")
        await _done_before(db_session, p, "PDD", "C")
    few = await _count()
    with monkeypatch.context() as m:
        m.setattr(dashboard_router, "expected_status_for", lambda status, step: None)
        stubbed = await _count()
    for i in range(4):
        await stepped_project(db_session, hub, name=f"More {i}")
    many = await _count()
    assert few == stubbed == many, (few, stubbed, many)
