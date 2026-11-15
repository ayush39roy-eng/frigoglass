"""P34-T01 (D34-4): `PriorityMatrixRow.last_score_version` on `GET /priorities`
and `GET /priorities/{id}`, and `ScenarioApplyRunSummary.project_count` on
`POST /scenarios/apply`, `GET /scenarios/versions` and the version detail.

Covers: null when never versioned; the latest of two versions wins (and its
applier's name is served); only `priority_score` changes count; the change
rows are hub-scoped like the versions endpoints; the list issues ONE
version query for any number of rows (no N+1); `project_count` counts
distinct non-null project ids in the caller's scope.
"""

from __future__ import annotations

import uuid

from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select

from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, RoleName, ScenarioEntityType
from models.scenario import ScenarioApplyChange, ScenarioApplyRun
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_project, make_scenario_apply_run, make_user

_DIMS = dict.fromkeys(
    (
        "strategic_project",
        "new_customer",
        "new_options",
        "regulatory_compliance",
        "quality_improvements",
        "rm_savings",
        "total_rm_savings",
        "gross_margins",
        "profitability",
        "annual_volume",
        "three_year_volume",
        "new_models",
        "capex_investment",
    ),
    4,
)


def _change(project_id: uuid.UUID, **overrides: int) -> dict:
    return {"project_id": str(project_id), "scores": {**_DIMS, **overrides}, "hard_gates": []}


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown() -> None:
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


async def _as(
    db_session,
    *roles: RoleName,
    full_name: str = "Test User",
    hub_scope_all: bool = True,
    hub_ids=(),
) -> AsyncClient:
    user = await make_user(
        db_session,
        *roles,
        full_name=full_name,
        hub_scope_all=hub_scope_all,
        hub_ids=list(hub_ids),
    )
    client = _client(db_session)
    override_current_principal(
        make_principal(*roles, user_id=user.id, hub_scope_all=hub_scope_all, hub_ids=hub_ids)
    )
    return client


async def _apply(db_session, full_name: str, *changes: dict) -> dict:
    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER, full_name=full_name) as c:
            resp = await c.post("/scenarios/apply", json={"priority_scores": list(changes)})
        assert resp.status_code == 201, resp.text
        return resp.json()
    finally:
        _teardown()


def _row(rows: list[dict], project_id: uuid.UUID) -> dict:
    [row] = [r for r in rows if r["project_id"] == str(project_id)]
    return row


async def _add_change(
    db_session,
    run_id: uuid.UUID,
    *,
    entity_type: ScenarioEntityType = ScenarioEntityType.PRIORITY_SCORE,
    project_id: uuid.UUID | None,
    hub_id: uuid.UUID | None,
) -> None:
    db_session.add(
        ScenarioApplyChange(
            scenario_apply_run_id=run_id,
            entity_type=entity_type,
            entity_id=str(uuid.uuid4()),
            project_id=project_id,
            hub_id=hub_id,
            before_state=None,
            after_state={},
        )
    )
    await db_session.flush()


# --------------------------------------------------------------------------
# last_score_version
# --------------------------------------------------------------------------


async def test_last_score_version_null_when_never_versioned(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, name="Never versioned")
    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            rows = (await client.get("/priorities")).json()
            detail = await client.get(f"/priorities/{project.id}")
        assert _row(rows, project.id)["last_score_version"] is None
        assert detail.status_code == 200
        assert detail.json()["last_score_version"] is None
    finally:
        _teardown()


async def test_last_score_version_latest_of_two_wins(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, name="Twice")
    other = await make_project(db_session, hub, name="Once")

    first = await _apply(db_session, "Alice Applier", _change(project.id), _change(other.id))
    second = await _apply(db_session, "Bob Builder", _change(project.id, strategic_project=1))
    v1, v2 = first["run"]["version"], second["run"]["version"]
    assert v2 > v1

    try:
        async with await _as(db_session, RoleName.EXECUTIVE_VIEWER) as client:
            rows = (await client.get("/priorities")).json()
            detail = (await client.get(f"/priorities/{project.id}")).json()

        marker = _row(rows, project.id)["last_score_version"]
        assert set(marker) == {"version", "created_at", "applied_by_name"}
        assert marker["version"] == v2
        assert marker["applied_by_name"] == "Bob Builder"
        assert marker["created_at"] == second["run"]["created_at"]
        assert detail["last_score_version"] == marker

        # The other project was only in the first version.
        other_marker = _row(rows, other.id)["last_score_version"]
        assert other_marker["version"] == v1
        assert other_marker["applied_by_name"] == "Alice Applier"
    finally:
        _teardown()


async def test_last_score_version_ignores_non_priority_changes_and_unknown_applier(
    db_session,
):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, name="Project change only")
    scored = await make_project(db_session, hub, name="No applier")

    run = await make_scenario_apply_run(db_session, applied_by_user_id=None)
    await _add_change(
        db_session,
        run.id,
        entity_type=ScenarioEntityType.PROJECT,
        project_id=project.id,
        hub_id=hub.id,
    )
    await _add_change(db_session, run.id, project_id=scored.id, hub_id=hub.id)

    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            rows = (await client.get("/priorities")).json()
        assert _row(rows, project.id)["last_score_version"] is None
        marker = _row(rows, scored.id)["last_score_version"]
        assert marker["version"] == run.version
        assert marker["applied_by_name"] is None
    finally:
        _teardown()


async def test_last_score_version_is_hub_scoped_like_versions(db_session):
    """A Hub Planner sees the marker only from change rows in their hub scope
    (the version they could open in Versions & History), and never a row for
    another hub's project."""

    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    in_scope = await make_project(db_session, hub_a, name="A project")
    moved = await make_project(db_session, hub_a, name="Moved from B")
    out_of_scope = await make_project(db_session, hub_b, name="B project")

    applied = await _apply(
        db_session, "Alice Applier", _change(in_scope.id), _change(out_of_scope.id)
    )
    # A version whose only change row was recorded under hub B (the project
    # has since moved to hub A): not visible to an A-only planner.
    old_run = await make_scenario_apply_run(db_session)
    await _add_change(db_session, old_run.id, project_id=moved.id, hub_id=hub_b.id)

    try:
        async with await _as(
            db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub_a.id]
        ) as client:
            rows = (await client.get("/priorities")).json()
            moved_detail = (await client.get(f"/priorities/{moved.id}")).json()
            forbidden = await client.get(f"/priorities/{out_of_scope.id}")

        assert {r["project_id"] for r in rows} == {str(in_scope.id), str(moved.id)}
        assert _row(rows, in_scope.id)["last_score_version"]["version"] == applied["run"]["version"]
        assert _row(rows, moved.id)["last_score_version"] is None
        assert moved_detail["last_score_version"] is None
        assert forbidden.status_code == 404
    finally:
        _teardown()


async def test_last_score_version_one_query_for_the_whole_list(db_session):
    hub = await make_hub(db_session)
    projects = [await make_project(db_session, hub, name=f"Bulk {i}") for i in range(5)]
    await _apply(db_session, "Alice Applier", *(_change(p.id) for p in projects))

    statements: list[str] = []

    def _record(orm_execute_state) -> None:
        statements.append(str(orm_execute_state.statement))

    target = db_session.sync_session
    async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
        event.listen(target, "do_orm_execute", _record)
        try:
            rows = (await client.get("/priorities")).json()
        finally:
            event.remove(target, "do_orm_execute", _record)
            _teardown()

    assert all(_row(rows, p.id)["last_score_version"] is not None for p in projects)
    version_queries = [s for s in statements if "scenario_apply_changes" in s]
    assert len(version_queries) == 1, version_queries


# --------------------------------------------------------------------------
# project_count
# --------------------------------------------------------------------------


async def test_project_count_on_apply_list_and_detail(db_session):
    hub = await make_hub(db_session)
    p1 = await make_project(db_session, hub, name="Count 1")
    p2 = await make_project(db_session, hub, name="Count 2")

    applied = await _apply(db_session, "Alice Applier", _change(p1.id), _change(p2.id))
    assert applied["run"]["project_count"] == 2
    version = applied["run"]["version"]

    # A non-project change row (null project_id) is not counted.
    run_id = (
        await db_session.execute(
            select(ScenarioApplyRun.id).where(ScenarioApplyRun.version == version)
        )
    ).scalar_one()
    await _add_change(
        db_session,
        run_id,
        entity_type=ScenarioEntityType.CHAMBER,
        project_id=None,
        hub_id=None,
    )

    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            listed = (await client.get("/scenarios/versions")).json()
            detail = (await client.get(f"/scenarios/versions/{version}")).json()
        [row] = [r for r in listed if r["version"] == version]
        assert row["project_count"] == 2
        assert row["change_count"] == 3
        assert detail["project_count"] == 2
        assert detail["change_count"] == 3
    finally:
        _teardown()


async def test_project_count_is_hub_scoped(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    a1 = await make_project(db_session, hub_a, name="A1")
    a2 = await make_project(db_session, hub_a, name="A2")
    b1 = await make_project(db_session, hub_b, name="B1")

    applied = await _apply(
        db_session, "Alice Applier", _change(a1.id), _change(a2.id), _change(b1.id)
    )
    assert applied["run"]["project_count"] == 3
    version = applied["run"]["version"]

    try:
        async with await _as(
            db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub_b.id]
        ) as client:
            listed = (await client.get("/scenarios/versions")).json()
            detail = (await client.get(f"/scenarios/versions/{version}")).json()
        [row] = [r for r in listed if r["version"] == version]
        assert row["project_count"] == 1
        assert detail["project_count"] == 1
    finally:
        _teardown()
