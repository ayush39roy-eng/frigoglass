"""P13-T20 qa-inspector gate: regression tests for two "region never widens"
paths that the P13 builder suites did not exercise (ADR 0025 §2, I23).

1. The Gantt's Engineer own-assignment path does not go through
   `narrowed_hub_filter`; it ANDs `global_hub_filter` with its own
   assignment scope. `region` must only narrow the Engineer's own projects,
   never add another engineer's project in that region.
2. `/exports/gantt` and `/exports/matrix` accept `region`. An out-of-scope
   region for a Hub Planner must give a header-only CSV, and the in-scope
   region must equal the unfiltered export.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, RoleName
from models.schedule import ScheduleRunProjectStep
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_user,
    make_workflow_step_template,
)


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _step(run, project, template, engineer) -> ScheduleRunProjectStep:
    return ScheduleRunProjectStep(
        schedule_run_id=run.id,
        project_id=project.id,
        step_template_id=template.id,
        sequence_order=1,
        duration_weeks=2,
        start_week=43,
        end_week=44,
        assigned_engineer_id=engineer.id,
    )


async def test_gantt_engineer_region_narrows_own_assignments_only(db_session):
    greece = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    romania = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    template = await make_workflow_step_template(db_session)
    me = await make_engineer(db_session, greece, name="Own Engineer")
    other = await make_engineer(db_session, greece, name="Other Engineer")

    mine_gr = await make_project(db_session, greece, name="Mine GR", leader=me)
    mine_ro = await make_project(db_session, romania, name="Mine RO", leader=me)
    other_gr = await make_project(db_session, greece, name="Other GR", leader=other)
    other_ro = await make_project(db_session, romania, name="Other RO", leader=other)

    run = await make_schedule_run(db_session, is_active=True)
    db_session.add_all(
        [
            _step(run, mine_gr, template, me),
            _step(run, mine_ro, template, me),
            _step(run, other_gr, template, other),
            _step(run, other_ro, template, other),
        ]
    )
    user = await make_user(db_session, RoleName.ENGINEER, hub_scope_all=False, hub_ids=[])
    me.user_id = user.id
    await db_session.flush()
    override_current_principal(
        make_principal(RoleName.ENGINEER, user_id=user.id, hub_scope_all=False, hub_ids=[])
    )

    async def names(client: AsyncClient, **params: str) -> set[str]:
        resp = await client.get("/gantt", params=params)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total_count"] == len(body["rows"])
        return {row["project_name"] for row in body["rows"]}

    async with _client(db_session) as client:
        assert await names(client) == {"Mine GR", "Mine RO"}
        assert await names(client, region="Greece") == {"Mine GR"}
        assert await names(client, region="Romania") == {"Mine RO"}
        assert await names(client, region="India") == set()
        assert await names(client, hub_id=str(romania.id), region="Greece") == set()
        assert await names(client, hub_id=str(greece.id), region="Greece") == {"Mine GR"}


async def test_gantt_and_matrix_exports_never_widen_a_hub_planner_by_region(db_session):
    greece = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    await make_project(db_session, greece, name="Greek project")
    await make_project(db_session, india, name="Indian project")
    await make_schedule_run(db_session, is_active=True)
    user = await make_user(
        db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[greece.id]
    )
    override_current_principal(
        make_principal(
            RoleName.HUB_PLANNER, user_id=user.id, hub_scope_all=False, hub_ids=[greece.id]
        )
    )

    def lines(text: str) -> list[str]:
        return [line for line in text.splitlines() if line.strip()]

    async with _client(db_session) as client:
        for path in ("/exports/gantt", "/exports/matrix"):
            unfiltered = await client.get(path)
            out_of_scope = await client.get(path, params={"region": "India"})
            own = await client.get(path, params={"region": "Greece"})
            assert {r.status_code for r in (unfiltered, out_of_scope, own)} == {200}, path
            assert "Greek project" in unfiltered.text, (path, unfiltered.text)
            assert "Indian project" not in unfiltered.text, path
            assert len(lines(out_of_scope.text)) == 1, (path, out_of_scope.text)
            assert "Indian project" not in out_of_scope.text, path
            assert lines(own.text) == lines(unfiltered.text), path
            assert (await client.get(path, params={"region": "Atlantis"})).status_code == 422
