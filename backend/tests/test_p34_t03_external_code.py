"""P34-T03 (D34-3 follow-up): `PriorityMatrixRow.external_code` on
`GET /priorities` and `GET /priorities/{id}`.

Covers: a row carries `Project.external_code`; null when the project has none
(the key is always present); serving it adds no query per row (it is a column
of the already-loaded `Project`).
"""

from __future__ import annotations

from httpx import ASGITransport, AsyncClient
from sqlalchemy import event

from api.db import get_db
from api.main import app
from models.enums import RoleName
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_project, make_user


async def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    user = await make_user(db_session, RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)
    app.dependency_overrides[get_db] = _override_get_db
    override_current_principal(
        make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user.id, hub_scope_all=True)
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown() -> None:
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


def _row(rows: list[dict], project_id) -> dict:
    [row] = [r for r in rows if r["project_id"] == str(project_id)]
    return row


async def test_matrix_row_serves_external_code_and_null_when_none(db_session):
    hub = await make_hub(db_session)
    coded = await make_project(db_session, hub, name="Coded", external_code="FG-P34-T03")
    uncoded = await make_project(db_session, hub, name="Uncoded", external_code=None)
    try:
        async with await _client(db_session) as client:
            resp = await client.get("/priorities")
            coded_detail = await client.get(f"/priorities/{coded.id}")
            uncoded_detail = await client.get(f"/priorities/{uncoded.id}")
        assert resp.status_code == 200, resp.text
        rows = resp.json()
        assert _row(rows, coded.id)["external_code"] == "FG-P34-T03"
        uncoded_row = _row(rows, uncoded.id)
        assert "external_code" in uncoded_row
        assert uncoded_row["external_code"] is None

        assert coded_detail.status_code == 200, coded_detail.text
        assert coded_detail.json()["external_code"] == "FG-P34-T03"
        assert uncoded_detail.status_code == 200, uncoded_detail.text
        assert uncoded_detail.json()["external_code"] is None
    finally:
        _teardown()


async def test_external_code_adds_no_query_per_row(db_session):
    hub = await make_hub(db_session)
    await make_project(db_session, hub, name="Row 0", external_code="FG-N1-0")

    async def _count_statements() -> tuple[int, list[dict]]:
        statements: list[str] = []

        def _record(orm_execute_state) -> None:
            statements.append(str(orm_execute_state.statement))

        target = db_session.sync_session
        async with await _client(db_session) as client:
            event.listen(target, "do_orm_execute", _record)
            try:
                rows = (await client.get("/priorities")).json()
            finally:
                event.remove(target, "do_orm_execute", _record)
                _teardown()
        return len(statements), rows

    small, _ = await _count_statements()
    for i in range(1, 6):
        await make_project(db_session, hub, name=f"Row {i}", external_code=f"FG-N1-{i}")
    large, rows = await _count_statements()

    assert {r["external_code"] for r in rows} >= {f"FG-N1-{i}" for i in range(6)}
    assert large == small, (small, large)
