"""P5-T02 — Backend snapshot-on-Apply: `POST /scenarios/apply` +
`GET /scenarios/versions` / `GET /scenarios/versions/{version}`.

Covers, per this task's verification checklist:

1. Apply-then-verify-snapshot-exists (`test_apply_creates_snapshot_*`).
2. Apply-is-atomic — a failure mid-apply leaves no partial state
   (`test_apply_service_atomic_on_mid_batch_failure`, at the service layer,
   plus `test_apply_all_or_nothing_on_invalid_item` at the HTTP layer).
3. RBAC / hub-scope negative tests (`test_apply_forbidden_for_hub_planner*`,
   `test_apply_out_of_scope_project_404s`, `test_versions_list_hub_scoped`).
4. Audit-log row written (`test_apply_writes_audit_log_entry`).

Same conventions as `tests/test_rbac_enforcement.py` / `tests/
test_hub_scope.py`: a real DB-backed `User` (for `AuditLogEntry.
actor_user_id`'s FK) plus an overridden `Principal` via `tests.auth_helpers`.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

import services.scenario_apply as scenario_apply_module
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, RoleName
from models.priority import PriorityScore
from models.scenario import ScenarioApplyChange, ScenarioApplyRun
from services.scenario_apply import (
    ScenarioApplyNotFoundError,
    ScenarioApplyValidationError,
    apply_priority_score_changes,
)
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_priority_score, make_project, make_user

_DIMS = dict(
    strategic_project=4,
    new_customer=4,
    new_options=4,
    regulatory_compliance=4,
    quality_improvements=4,
    rm_savings=4,
    total_rm_savings=4,
    gross_margins=4,
    profitability=4,
    annual_volume=4,
    three_year_volume=4,
    new_models=4,
    capex_investment=4,
)


def _change_payload(project_id: uuid.UUID, **overrides) -> dict:
    payload = {"project_id": str(project_id), **_DIMS, "hard_gates": []}
    payload.update(overrides)
    return payload


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown():
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


async def _as(db_session, *roles: RoleName, hub_scope_all: bool = True, hub_ids=()):
    user = await make_user(
        db_session, *roles, hub_scope_all=hub_scope_all, hub_ids=list(hub_ids)
    )
    client = _client(db_session)
    override_current_principal(
        make_principal(
            *roles, user_id=user.id, hub_scope_all=hub_scope_all, hub_ids=hub_ids
        )
    )
    return client


# --------------------------------------------------------------------------
# Apply -> snapshot exists
# --------------------------------------------------------------------------


async def test_apply_creates_snapshot_for_new_priority_score(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)

    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post(
                "/scenarios/apply",
                json={"notes": "Q3 scenario", "priority_scores": [_change_payload(project.id)]},
            )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["run"]["version"] >= 1
        assert body["run"]["change_count"] == 1
        assert body["run"]["entity_types_touched"] == ["priority_score"]
        assert len(body["updated_priority_scores"]) == 1
        assert body["suggested_bands"][str(project.id)] in {"P1", "P2", "P3", "P4", "Q"}

        run = (
            await db_session.execute(
                select(ScenarioApplyRun).where(ScenarioApplyRun.version == body["run"]["version"])
            )
        ).scalar_one()
        changes = (
            (
                await db_session.execute(
                    select(ScenarioApplyChange).where(
                        ScenarioApplyChange.scenario_apply_run_id == run.id
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(changes) == 1
        change = changes[0]
        assert change.entity_type.value == "priority_score"
        assert change.before_state is None  # this PriorityScore did not exist before
        assert change.after_state["strategic_project"] == 4
        assert change.project_id == project.id
        assert change.hub_id == hub.id

        score = (
            await db_session.execute(
                select(PriorityScore).where(PriorityScore.project_id == project.id)
            )
        ).scalar_one()
        assert score.suggested_band is not None
    finally:
        _teardown()


async def test_apply_snapshots_before_state_on_update(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    old_dims = [2] * 13
    await make_priority_score(db_session, project, dims=old_dims)

    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post(
                "/scenarios/apply",
                json={"priority_scores": [_change_payload(project.id, strategic_project=5)]},
            )
        assert resp.status_code == 201, resp.text
        version = resp.json()["run"]["version"]

        change = (
            await db_session.execute(
                select(ScenarioApplyChange).where(
                    ScenarioApplyChange.scenario_apply_run_id.in_(
                        select(ScenarioApplyRun.id).where(ScenarioApplyRun.version == version)
                    )
                )
            )
        ).scalar_one()
        assert change.before_state is not None
        assert change.before_state["strategic_project"] == 2
        assert change.after_state["strategic_project"] == 5
    finally:
        _teardown()


async def test_apply_writes_audit_log_entry(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)

    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post(
                "/scenarios/apply",
                json={"priority_scores": [_change_payload(project.id)]},
            )
        assert resp.status_code == 201
        run_id = resp.json()["run"]["id"]

        entry = (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == "scenario_apply.apply",
                    AuditLogEntry.entity_id == run_id,
                )
            )
        ).scalar_one()
        assert entry.entity_type == "ScenarioApplyRun"
        assert entry.after_state["change_count"] == 1
    finally:
        _teardown()


async def test_apply_batches_multiple_projects_in_one_version(db_session):
    hub = await make_hub(db_session)
    p1 = await make_project(db_session, hub, name="P1")
    p2 = await make_project(db_session, hub, name="P2")

    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post(
                "/scenarios/apply",
                json={
                    "priority_scores": [
                        _change_payload(p1.id),
                        _change_payload(p2.id, strategic_project=1),
                    ]
                },
            )
        assert resp.status_code == 201
        assert resp.json()["run"]["change_count"] == 2
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Validation / atomicity
# --------------------------------------------------------------------------


async def test_apply_empty_diff_rejected(db_session):
    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post("/scenarios/apply", json={"priority_scores": []})
        assert resp.status_code == 400
    finally:
        _teardown()


async def test_apply_duplicate_project_id_rejected(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)

    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post(
                "/scenarios/apply",
                json={
                    "priority_scores": [
                        _change_payload(project.id),
                        _change_payload(project.id, strategic_project=1),
                    ]
                },
            )
        assert resp.status_code == 400
    finally:
        _teardown()


async def test_apply_all_or_nothing_on_invalid_item(db_session):
    """A batch with one valid project and one nonexistent project id must
    write NOTHING — not even the valid item — proving validate-before-write
    atomicity at the HTTP layer (see `services/scenario_apply.py`'s module
    docstring)."""

    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    bogus_id = uuid.uuid4()

    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post(
                "/scenarios/apply",
                json={
                    "priority_scores": [
                        _change_payload(project.id),
                        _change_payload(bogus_id),
                    ]
                },
            )
        assert resp.status_code == 404

        run_count = (
            await db_session.execute(select(ScenarioApplyRun))
        ).scalars().all()
        assert run_count == []
        score = (
            await db_session.execute(
                select(PriorityScore).where(PriorityScore.project_id == project.id)
            )
        ).scalar_one_or_none()
        assert score is None
    finally:
        _teardown()


async def test_apply_out_of_scope_project_404s(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project_b = await make_project(db_session, hub_b)

    try:
        async with await _as(
            db_session, RoleName.PORTFOLIO_MANAGER, hub_scope_all=False, hub_ids=[hub_a.id]
        ) as client:
            resp = await client.post(
                "/scenarios/apply",
                json={"priority_scores": [_change_payload(project_b.id)]},
            )
        assert resp.status_code == 404
    finally:
        _teardown()


async def test_apply_service_atomic_on_mid_batch_failure(db_session, monkeypatch):
    """Directly exercises `services.scenario_apply.apply_priority_score_
    changes`: force the SECOND item in a two-item batch to fail after the
    first item has already been flushed (staged, not committed). Confirms
    that rolling back the session (exactly what `api.db.get_db`'s
    `async with session_factory() as session:` does on an unhandled
    exception in production) discards BOTH items, not just the one that
    failed — real cross-item atomicity, not merely "the failing item didn't
    write."
    """

    hub = await make_hub(db_session)
    p1 = await make_project(db_session, hub, name="Atomic P1")
    p2 = await make_project(db_session, hub, name="Atomic P2")

    call_count = {"n": 0}
    original = scenario_apply_module.compute_priority_score

    def _boom(dims: list[int]) -> tuple[float, int, str]:
        call_count["n"] += 1
        if call_count["n"] == 2:
            raise RuntimeError("simulated mid-apply failure")
        return original(dims)

    # String-path form (not `setattr(scenario_apply_module, ...)`) so mypy
    # doesn't need `services.scenario_apply` to explicitly re-export
    # `compute_priority_score` under `--strict`'s `no_implicit_reexport`.
    monkeypatch.setattr("services.scenario_apply.compute_priority_score", _boom)

    # A real `User` row (not just a fake `Principal`) — `ScenarioApplyRun.
    # applied_by_user_id` is a real FK, and this test flushes far enough to
    # hit it (unlike the HTTP-layer tests above, which never commit a run
    # tied to a nonexistent user).
    user = await make_user(db_session, RoleName.PORTFOLIO_MANAGER)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user.id, hub_scope_all=True)
    from schemas.scenario import ScenarioPriorityScoreChange

    changes = [
        ScenarioPriorityScoreChange(project_id=p1.id, **_DIMS, hard_gates=[]),
        ScenarioPriorityScoreChange(project_id=p2.id, **_DIMS, hard_gates=[]),
    ]

    with pytest.raises(RuntimeError, match="simulated mid-apply failure"):
        await apply_priority_score_changes(
            db_session, principal=principal, notes=None, changes=changes
        )

    # Before rollback: item 1's PriorityScore/ScenarioApplyRun are flushed
    # (visible within this same still-open transaction) — proving the
    # failure really did happen mid-batch, after real partial work.
    flushed_score = (
        await db_session.execute(select(PriorityScore).where(PriorityScore.project_id == p1.id))
    ).scalar_one_or_none()
    assert flushed_score is not None

    # Rollback (what production's get_db does automatically on an
    # unhandled exception) must discard ALL of it, including item 1.
    await db_session.rollback()

    assert (
        await db_session.execute(select(ScenarioApplyRun))
    ).scalars().all() == []
    assert (
        await db_session.execute(select(PriorityScore).where(PriorityScore.project_id == p1.id))
    ).scalar_one_or_none() is None
    assert (
        await db_session.execute(select(PriorityScore).where(PriorityScore.project_id == p2.id))
    ).scalar_one_or_none() is None


async def test_apply_service_rejects_empty_and_duplicate_without_touching_db(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)

    with pytest.raises(ScenarioApplyValidationError):
        await apply_priority_score_changes(
            db_session, principal=principal, notes=None, changes=[]
        )

    from schemas.scenario import ScenarioPriorityScoreChange

    dup_changes = [
        ScenarioPriorityScoreChange(project_id=project.id, **_DIMS, hard_gates=[]),
        ScenarioPriorityScoreChange(project_id=project.id, **_DIMS, hard_gates=[]),
    ]
    with pytest.raises(ScenarioApplyValidationError):
        await apply_priority_score_changes(
            db_session, principal=principal, notes=None, changes=dup_changes
        )


async def test_apply_service_not_found_for_unknown_project(db_session):
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)
    from schemas.scenario import ScenarioPriorityScoreChange

    with pytest.raises(ScenarioApplyNotFoundError):
        await apply_priority_score_changes(
            db_session,
            principal=principal,
            notes=None,
            changes=[ScenarioPriorityScoreChange(project_id=uuid.uuid4(), **_DIMS, hard_gates=[])],
        )


# --------------------------------------------------------------------------
# RBAC
# --------------------------------------------------------------------------


async def test_apply_unauthenticated_401(db_session):
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/scenarios/apply",
                json={"priority_scores": [_change_payload(uuid.uuid4())]},
            )
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.pop(get_db, None)


async def test_apply_forbidden_for_hub_planner_read_only_role(db_session):
    """Hub Planner has READ, not WRITE, on Matrix — same restriction as
    `PUT /priorities/{project_id}`, which this endpoint generalises."""

    try:
        async with await _as(db_session, RoleName.HUB_PLANNER) as client:
            resp = await client.post(
                "/scenarios/apply",
                json={"priority_scores": [_change_payload(uuid.uuid4())]},
            )
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_apply_forbidden_for_engineer(db_session):
    try:
        async with await _as(
            db_session, RoleName.ENGINEER, hub_scope_all=False, hub_ids=[]
        ) as client:
            resp = await client.post(
                "/scenarios/apply",
                json={"priority_scores": [_change_payload(uuid.uuid4())]},
            )
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_versions_list_forbidden_for_engineer(db_session):
    try:
        async with await _as(
            db_session, RoleName.ENGINEER, hub_scope_all=False, hub_ids=[]
        ) as client:
            resp = await client.get("/scenarios/versions")
        assert resp.status_code == 403
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Versions & History read endpoints
# --------------------------------------------------------------------------


async def test_versions_list_and_detail_roundtrip(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)

    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            apply_resp = await client.post(
                "/scenarios/apply",
                json={"notes": "hist test", "priority_scores": [_change_payload(project.id)]},
            )
            assert apply_resp.status_code == 201
            version = apply_resp.json()["run"]["version"]

            list_resp = await client.get("/scenarios/versions")
            assert list_resp.status_code == 200
            versions = [r["version"] for r in list_resp.json()]
            assert version in versions

            detail_resp = await client.get(f"/scenarios/versions/{version}")
            assert detail_resp.status_code == 200
            detail = detail_resp.json()
            assert detail["version"] == version
            assert len(detail["changes"]) == 1
            assert detail["changes"][0]["after_state"]["strategic_project"] == 4
    finally:
        _teardown()


async def test_versions_detail_404_for_unknown_version(db_session):
    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.get("/scenarios/versions/999999")
        assert resp.status_code == 404
    finally:
        _teardown()


async def test_versions_list_hub_scoped(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project_a = await make_project(db_session, hub_a, name="Scoped A")
    project_b = await make_project(db_session, hub_b, name="Scoped B")

    async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as pm_client:
        resp_a = await pm_client.post(
            "/scenarios/apply", json={"priority_scores": [_change_payload(project_a.id)]}
        )
        version_a = resp_a.json()["run"]["version"]
    _teardown()

    async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as pm_client:
        resp_b = await pm_client.post(
            "/scenarios/apply", json={"priority_scores": [_change_payload(project_b.id)]}
        )
        version_b = resp_b.json()["run"]["version"]
    _teardown()

    try:
        async with await _as(
            db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub_a.id]
        ) as client:
            list_resp = await client.get("/scenarios/versions")
            versions = [r["version"] for r in list_resp.json()]
            assert version_a in versions
            assert version_b not in versions

            detail_resp = await client.get(f"/scenarios/versions/{version_b}")
            assert detail_resp.status_code == 404
    finally:
        _teardown()


async def test_versions_change_count_scoped_to_viewer_hub_set(db_session):
    """P5-T10 remediation (`docs/MEMORY.md` "[2026-09-05] P5 gate —
    workflow-auditor" finding #4): a single scenario Apply spanning two hubs
    must report a `change_count` that agrees with `len(changes)` for EVERY
    viewer, not just an unrestricted one — the list view's `change_count`
    must never be larger than what that same viewer sees when they open the
    version's detail.
    """
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project_a = await make_project(db_session, hub_a, name="Multi-hub A")
    project_b = await make_project(db_session, hub_b, name="Multi-hub B")

    async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as pm_client:
        apply_resp = await pm_client.post(
            "/scenarios/apply",
            json={
                "priority_scores": [
                    _change_payload(project_a.id),
                    _change_payload(project_b.id),
                ]
            },
        )
        assert apply_resp.status_code == 201
        version = apply_resp.json()["run"]["version"]
        # The applier (unrestricted Portfolio Manager) sees the full,
        # portfolio-wide count — unaffected by this fix.
        assert apply_resp.json()["run"]["change_count"] == 2
    _teardown()

    try:
        async with await _as(
            db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub_a.id]
        ) as client:
            list_resp = await client.get("/scenarios/versions")
            assert list_resp.status_code == 200
            [row] = [r for r in list_resp.json() if r["version"] == version]
            # Before the fix: this was 2 (the raw, portfolio-wide
            # ScenarioApplyRun.change_count) even though the viewer can only
            # ever see 1 change (project_b's hub is out of scope).
            assert row["change_count"] == 1

            detail_resp = await client.get(f"/scenarios/versions/{version}")
            assert detail_resp.status_code == 200
            detail = detail_resp.json()
            assert len(detail["changes"]) == 1
            assert detail["changes"][0]["project_id"] == str(project_a.id)
            # The list's change_count and the detail's own change_count and
            # its `changes` row count must now all agree.
            assert detail["change_count"] == 1
            assert detail["change_count"] == len(detail["changes"]) == row["change_count"]
    finally:
        _teardown()
