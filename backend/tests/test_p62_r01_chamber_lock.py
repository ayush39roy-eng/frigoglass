"""P62-R01 (security S62-1, S62-8): chamber edits that mark the plan stale
take the band-rank lock FIRST, before the chamber row lock, the same order
as template apply since the run-307 deadlock.

Covered:

1. lock order: `PATCH /chambers/{id}` changing a plan input and
   `PUT /workflow-settings/chambers/{id}` issue `pg_advisory_xact_lock`
   before the chamber `FOR UPDATE` / `UPDATE chambers` and the bulk
   `UPDATE projects`; a label-only PATCH takes no band-rank lock;
2. with the lock held elsewhere both return 503 `BAND_RANK_BUSY` and write
   nothing, while a label-only PATCH still goes through;
3. a rejected chamber edit (403 / 404 / 409 / 422) leaves nothing stale;
4. a non-admin template apply carrying `lab_hold_weeks` is refused 403.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import event, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from api.routers import workflow_templates as wt_router
from models.chamber import Chamber
from models.enums import HubName, LabRegion, ProjectStatus, RoleName
from models.project import Project
from services import band_rank as band_rank_service
from tests.auth_helpers import clear_current_principal_override
from tests.p12_helpers import act_as, client_for
from tests.test_p36_band_rank_api import _band_lock_held_elsewhere
from tests.test_p62_lab_hold_backend import (
    APPLY,
    PREVIEW,
    _change,
    _project,
    _template,
    _world,
)

_LIMITERS = (wt_router.APPLY_RATE_LIMIT, wt_router.APPLY_PREVIEW_RATE_LIMIT)


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    for limiter in _LIMITERS:
        limiter.reset()
    yield
    for limiter in _LIMITERS:
        limiter.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _fresh(db: AsyncSession) -> None:
    await db.execute(update(Project).values(schedule_stale=False))
    await db.flush()


async def _stale_count(db: AsyncSession) -> int:
    return int(
        (
            await db.execute(
                select(func.count()).select_from(Project).where(Project.schedule_stale.is_(True))
            )
        ).scalar_one()
    )


async def _chamber(db: AsyncSession, chamber_id: uuid.UUID) -> Chamber:
    return (
        await db.execute(
            select(Chamber)
            .where(Chamber.id == chamber_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


class _Recorder:
    def __init__(self, db: AsyncSession) -> None:
        self.engine = db.bind.sync_engine  # type: ignore[union-attr]
        self.statements: list[str] = []

    def __call__(self, conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        self.statements.append(" ".join(statement.lower().split()))

    def __enter__(self) -> _Recorder:
        event.listen(self.engine, "before_cursor_execute", self)
        return self

    def __exit__(self, *exc: object) -> None:
        event.remove(self.engine, "before_cursor_execute", self)

    def first(self, *needles: str) -> int:
        for i, s in enumerate(self.statements):
            if all(n in s for n in needles):
                return i
        return -1


# --- 1. lock order -------------------------------------------------------------------------------
async def test_chamber_patch_takes_band_rank_lock_before_the_row_lock(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    await _project(db_session, w, "Order", status=ProjectStatus.IN_DEVELOPMENT)
    await _fresh(db_session)
    await act_as(db_session, RoleName.ADMIN)
    url = f"/chambers/{w.chamber.id}"

    # Label-only (with a base, so the row is locked): no band-rank lock.
    with _Recorder(db_session) as rec:
        async with client_for(db_session) as client:
            resp = await client.patch(url, json={"code": "GR-CH9b", "base": {"code": "GR-CH9"}})
    assert resp.status_code == 200, resp.text
    assert rec.first("pg_advisory_xact_lock") == -1
    assert rec.first("from chambers", "for update") >= 0
    assert await _stale_count(db_session) == 0

    # A plan-input change with a base: band lock -> chamber FOR UPDATE ->
    # UPDATE chambers -> UPDATE projects (stale).
    body = {
        "allowed_stages": ["PDD-F", "PDD-H"],
        "base": {"allowed_stages": w.chamber.allowed_stages},
    }
    with _Recorder(db_session) as rec:
        async with client_for(db_session) as client:
            resp = await client.patch(url, json=body)
    assert resp.status_code == 200, resp.text
    band = rec.first("pg_advisory_xact_lock")
    row = rec.first("from chambers", "for update")
    write = rec.first("update chambers")
    stale = rec.first("update projects", "schedule_stale")
    assert 0 <= band < row < write < stale, rec.statements
    assert await _stale_count(db_session) >= 1

    # Without a base the row lock is the flush's UPDATE: still after.
    await _fresh(db_session)
    with _Recorder(db_session) as rec:
        async with client_for(db_session) as client:
            resp = await client.patch(url, json={"max_concurrent": 2})
    assert resp.status_code == 200, resp.text
    assert 0 <= rec.first("pg_advisory_xact_lock") < rec.first("update chambers")
    assert rec.first("from chambers", "for update") == -1

    # Re-sending the current values changes no plan input: no lock, no stale.
    await _fresh(db_session)
    with _Recorder(db_session) as rec:
        async with client_for(db_session) as client:
            resp = await client.patch(url, json={"max_concurrent": 2, "efficiency": 0.9})
    assert resp.status_code == 200, resp.text
    assert rec.first("pg_advisory_xact_lock") == -1
    assert await _stale_count(db_session) == 0


async def test_settings_chamber_put_takes_band_rank_lock_before_the_row_lock(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    await _project(db_session, w, "Order", status=ProjectStatus.IN_DEVELOPMENT)
    await _fresh(db_session)
    await act_as(db_session, RoleName.SUPER_ADMIN)
    with _Recorder(db_session) as rec:
        async with client_for(db_session) as client:
            resp = await client.put(
                f"/workflow-settings/chambers/{w.chamber.id}",
                json={"efficiency": 0.8, "base": {"efficiency": float(w.chamber.efficiency)}},
            )
    assert resp.status_code == 200, resp.text
    band = rec.first("pg_advisory_xact_lock")
    row = rec.first("from chambers", "for update")
    write = rec.first("update chambers")
    stale = rec.first("update projects", "schedule_stale")
    assert 0 <= band < row < write < stale, rec.statements


# --- 2. busy -> 503, nothing written -------------------------------------------------------------
async def test_band_rank_busy_refuses_plan_edits_but_not_label_edits(
    db_session: AsyncSession, database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(band_rank_service, "BAND_RANK_LOCK_TIMEOUT", "200ms")
    w = await _world(db_session)
    await _project(db_session, w, "Busy", status=ProjectStatus.IN_DEVELOPMENT)
    await _fresh(db_session)
    await act_as(db_session, RoleName.SUPER_ADMIN)
    # The 503 path rolls the session back (expiring loaded objects): keep the
    # world and read what the asserts need first.
    await db_session.commit()
    chamber_id, stages = w.chamber.id, sorted(w.chamber.allowed_stages)
    url = f"/chambers/{chamber_id}"
    async with _band_lock_held_elsewhere(database_url):
        async with client_for(db_session) as client:
            patch = await client.patch(url, json={"allowed_stages": ["PDD-F"]})
            put = await client.put(f"/workflow-settings/chambers/{chamber_id}",
                                   json={"efficiency": 0.5})  # fmt: skip
            label = await client.patch(url, json={"code": "GR-CH9z"})
    for resp in (patch, put):
        assert resp.status_code == 503, resp.text
        assert resp.json()["code"] == "BAND_RANK_BUSY"
        assert resp.headers["Retry-After"] == str(band_rank_service.BAND_RANK_BUSY_RETRY_AFTER)
    assert label.status_code == 200, label.text
    chamber = await _chamber(db_session, chamber_id)
    assert chamber.code == "GR-CH9z"
    assert sorted(chamber.allowed_stages or []) == stages
    assert float(chamber.efficiency) != 0.5
    assert await _stale_count(db_session) == 0


# --- 3. rejected edits leave nothing stale -------------------------------------------------------
async def test_rejected_chamber_edits_leave_nothing_stale(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    await _project(db_session, w, "Untouched", status=ProjectStatus.IN_DEVELOPMENT)
    india = await _india_hub(db_session)
    await _fresh(db_session)
    url = f"/chambers/{w.chamber.id}"
    put_url = f"/workflow-settings/chambers/{w.chamber.id}"
    stages = list(w.chamber.allowed_stages)
    cases: list[tuple[str, tuple[RoleName, ...], dict[str, Any], str, str, dict[str, Any], int]] = [
        # 403: roles without capacity_planning write.
        *[
            ("Engineer etc. PATCH", (role,), {}, "patch", url, {"allowed_stages": ["PDD-F"]}, 403)
            for role in (
                RoleName.ENGINEER,
                RoleName.EXECUTIVE_VIEWER,
                RoleName.AUDITOR,
                RoleName.PORTFOLIO_MANAGER,
            )
        ],
        *[
            ("Engineer etc. PUT", (role,), {}, "put", put_url, {"efficiency": 0.5}, 403)
            for role in (RoleName.ENGINEER, RoleName.EXECUTIVE_VIEWER, RoleName.AUDITOR)
        ],
        # 403: a Hub Planner moving the chamber out of their region.
        ("move out of scope", (RoleName.HUB_PLANNER,), {"hub_ids": [w.hub.id]}, "patch", url,
         {"lab_region": "India", "max_concurrent": 1}, 403),
        # 404: out-of-region Hub Planner, and an unknown id.
        ("out of region PATCH", (RoleName.HUB_PLANNER,), {"hub_ids": [india.id]}, "patch", url,
         {"allowed_stages": ["PDD-F"]}, 404),
        ("out of region PUT", (RoleName.HUB_PLANNER,), {"hub_ids": [india.id]}, "put", put_url,
         {"efficiency": 0.5}, 404),
        ("unknown PATCH", (RoleName.ADMIN,), {}, "patch", f"/chambers/{uuid.uuid4()}",
         {"allowed_stages": ["PDD-F"]}, 404),
        ("unknown PUT", (RoleName.SUPER_ADMIN,), {}, "put",
         f"/workflow-settings/chambers/{uuid.uuid4()}", {"efficiency": 0.5}, 404),
        # 409: a stale base.
        ("stale base PATCH", (RoleName.ADMIN,), {}, "patch", url,
         {"allowed_stages": ["PDD-F"], "base": {"allowed_stages": ["PDD-L"]}}, 409),
        ("stale base PUT", (RoleName.SUPER_ADMIN,), {}, "put", put_url,
         {"efficiency": 0.5, "base": {"efficiency": 0.123}}, 409),
        # 422: unknown / design step ids, explicit null, out of range.
        ("unknown stage", (RoleName.ADMIN,), {}, "patch", url,
         {"allowed_stages": ["PDD-F'; DROP TABLE projects;--"]}, 422),
        ("design stage", (RoleName.ADMIN,), {}, "patch", url, {"allowed_stages": ["PDD-E"]}, 422),
        ("null PATCH", (RoleName.ADMIN,), {}, "patch", url, {"max_concurrent": None}, 422),
        ("null PUT", (RoleName.SUPER_ADMIN,), {}, "put", put_url, {"platforms": None}, 422),
        ("range PUT", (RoleName.SUPER_ADMIN,), {}, "put", put_url, {"efficiency": 2}, 422),
    ]  # fmt: skip
    for label, roles, kw, method, target, body, expected in cases:
        await act_as(db_session, *roles, **kw)
        async with client_for(db_session) as client:
            resp = await getattr(client, method)(target, json=body)
        assert resp.status_code == expected, (label, resp.status_code, resp.text)
        assert await _stale_count(db_session) == 0, label
    chamber = await _chamber(db_session, w.chamber.id)
    assert chamber.lab_region == LabRegion.GREECE
    assert list(chamber.allowed_stages or []) == stages


async def _india_hub(db: AsyncSession) -> Any:
    from tests.factories import make_hub

    return await make_hub(db, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)


# --- 4. S62-8: a non-admin apply carrying room weeks is refused ---------------------------------
async def test_non_admin_apply_with_lab_hold_weeks_is_refused(db_session: AsyncSession) -> None:
    await _world(db_session)
    before = (await _template(db_session, "B", "PDD-L")).lab_hold_weeks
    change = await _change(db_session, "B", [{"step_id": "PDD-L", "lab_hold_weeks": "full"}])
    for role in (
        RoleName.HUB_PLANNER,
        RoleName.ENGINEER,
        RoleName.PORTFOLIO_MANAGER,
        RoleName.EXECUTIVE_VIEWER,
        RoleName.AUDITOR,
    ):
        for limiter in _LIMITERS:
            limiter.reset()
        await act_as(db_session, role)
        async with client_for(db_session) as client:
            preview = await client.post(PREVIEW, json={"changes": [change]})
            apply = await client.post(
                APPLY,
                json={"changes": [change], "selection": {"mode": "none", "project_ids": []}},
            )
        assert preview.status_code == 403, (role, preview.text)
        assert apply.status_code == 403, (role, apply.text)
    assert (await _template(db_session, "B", "PDD-L")).lab_hold_weeks == before == 1
