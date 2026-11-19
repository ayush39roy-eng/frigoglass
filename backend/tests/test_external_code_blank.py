"""Hotfix: `projects.external_code` is UNIQUE; a blank code must be stored as
NULL (never ''), and a genuine duplicate is a clean 409
`DUPLICATE_EXTERNAL_CODE`, not a 500."""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from models.enums import RoleName
from models.project import Project
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_hub, make_project
from tests.p12_helpers import act_as, client_for


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _stored_code(db: AsyncSession, project_id: str) -> str | None:
    project = await db.get(Project, uuid.UUID(project_id))
    assert project is not None
    await db.refresh(project)
    return project.external_code


async def test_two_blank_codes_are_both_201_and_null(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        ids = []
        for name in ("First", "Second"):
            resp = await client.post(
                "/projects", json={"name": name, "hub_id": str(hub.id), "external_code": ""}
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["external_code"] is None
            ids.append(resp.json()["id"])
    for pid in ids:
        assert await _stored_code(db_session, pid) is None


async def test_blank_code_with_existing_empty_string_row(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    await make_project(db_session, hub, name="Legacy blank", external_code="")
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/projects", json={"name": "New", "hub_id": str(hub.id), "external_code": ""}
        )
    assert resp.status_code == 201, resp.text
    assert await _stored_code(db_session, resp.json()["id"]) is None


async def test_whitespace_code_is_null_and_code_is_trimmed(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        blank = await client.post(
            "/projects", json={"name": "WS", "hub_id": str(hub.id), "external_code": "  "}
        )
        padded = await client.post(
            "/projects", json={"name": "Pad", "hub_id": str(hub.id), "external_code": " X-1 "}
        )
    assert blank.status_code == 201, blank.text
    assert await _stored_code(db_session, blank.json()["id"]) is None
    assert padded.status_code == 201, padded.text
    assert await _stored_code(db_session, padded.json()["id"]) == "X-1"


async def test_duplicate_code_is_409_on_create_and_patch(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    await make_project(db_session, hub, name="Holder", external_code="FG-100")
    other = await make_project(db_session, hub, name="Other", external_code="FG-200")
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        created = await client.post(
            "/projects", json={"name": "Dup", "hub_id": str(hub.id), "external_code": "FG-100"}
        )
        patched = await client.patch(f"/projects/{other.id}", json={"external_code": "FG-100"})
        same = await client.patch(f"/projects/{other.id}", json={"external_code": "FG-200"})
    for resp in (created, patched):
        assert resp.status_code == 409, resp.text
        body = resp.json()
        assert body["code"] == "DUPLICATE_EXTERNAL_CODE"
        assert body["detail"] == "Another project already uses this project code."
    assert same.status_code == 200, same.text


async def test_patch_blank_code_on_empty_string_row_becomes_null(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    legacy = await make_project(db_session, hub, name="Legacy", external_code="")
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{legacy.id}", json={"external_code": ""})
    assert resp.status_code == 200, resp.text
    assert await _stored_code(db_session, str(legacy.id)) is None
