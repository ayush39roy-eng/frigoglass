"""P19-R01: security remediation from the P19 + P20 gate (security-auditor).

- S19-M1: `GET /planning/resource-load` intersects `engineer_id` with the
  caller's hub scope before any predicate is built; out-of-scope and unknown
  ids behave identically and are never echoed.
- S19-L1: `PATCH /engineers/{id}` rejects explicit `null` for NOT NULL fields
  (422, was a 500 whose DB message carried the engineer's name into the log);
  integrity errors are mapped without logging row values.
- S19-L2: `PATCH /chambers/{id}` rejects explicit `null` (422, was a misleading
  409); only a unique violation is the 409 "code already exists".
- S19-L3: engineer and chamber request models are strict.

World: `tests.test_p19_planning_capacity._world` (hand-worked figures there).
GR-1 load: 13.0 unfiltered, 10.0 with Alpha's id, 9.0 with Beta's.
"""

from __future__ import annotations

import logging
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from api.db import get_db
from api.main import app
from api.routers import chambers as chambers_router
from api.routers import engineers as engineers_router
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.engineer import Engineer
from models.enums import RoleName
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_user
from tests.p12_helpers import act_as, client_for
from tests.test_p19_planning_capacity import _world

LOAD = "/planning/resource-load"
ACTION = "planning.resource_load.read"


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _load(client, **params):
    resp = await client.get(LOAD, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _chamber_loads(body):
    return {r["code"]: r["load_weeks"] for r in body["chambers"]}


def _zero_total(total):
    return all(total[k] in (0.0, None) for k in total)


# --- S19-M1 ----------------------------------------------------------------------------


async def test_auditor_probe_out_of_scope_engineer_ids_reveal_nothing(db_session):
    """An OEM-HCK Hub Planner (Greece lab region, R&D-Greece engineers out of
    scope) used to get GR-1 = 10.0 / 9.0 with Alpha's / Beta's id."""

    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w["oem"].id])
    alpha, beta = str(w["alpha"].id), str(w["beta"].id)
    async with client_for(db_session) as client:
        unfiltered = await _load(client)
        with_alpha = await _load(client, engineer_id=alpha)
        with_beta = await _load(client, engineer_id=beta)
        with_both = await _load(client, engineer_id=[alpha, beta])
        unknown = await _load(client, engineer_id=str(uuid.uuid4()))
        out_of_scope_hub = await _load(client, hub_id=str(w["greece"].id))

    # The unfiltered view is the region-wide chamber load (contract §5).
    assert _chamber_loads(unfiltered)["GR-1"] == 13.0
    assert unfiltered["engineers"] == []  # OEM-HCK has no engineers
    for body in (with_alpha, with_beta, with_both):
        # Never the per-engineer slice (10.0 / 9.0).
        assert "GR-1" not in _chamber_loads(body)
        assert body["engineers"] == [] and body["chambers"] == []
        assert _zero_total(body["totals"]["engineers"])
        assert _zero_total(body["totals"]["chambers"])
        # The out-of-scope ids are not echoed.
        assert body["filters_applied"]["engineer_id"] == []
        assert alpha not in str(body) and beta not in str(body)
        # Same shape and figures as an out-of-scope hub, and as an unknown id.
        assert body["engineers"] == out_of_scope_hub["engineers"]
        assert body["chambers"] == out_of_scope_hub["chambers"]
        assert body["totals"] == out_of_scope_hub["totals"]
        assert body == unknown


async def test_mixed_ids_keep_only_the_in_scope_ones(db_session):
    """A Romania Hub Planner sending Gamma (own) + Beta (R&D-Greece): Beta is
    dropped before the predicate, so the answer equals Gamma alone."""

    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w["romania"].id])
    gamma, beta = str(w["gamma"].id), str(w["beta"].id)
    async with client_for(db_session) as client:
        gamma_only = await _load(client, engineer_id=gamma)
        mixed = await _load(client, engineer_id=[gamma, beta])
        mixed_unknown = await _load(client, engineer_id=[gamma, str(uuid.uuid4())])
    assert [r["name"] for r in gamma_only["engineers"]] == ["Gamma"]
    assert _chamber_loads(gamma_only) == {"RO-1": 2.0}
    assert gamma_only["filters_applied"]["engineer_id"] == [gamma]
    assert mixed == gamma_only == mixed_unknown
    assert beta not in str(mixed)


async def test_audit_filter_key_holds_only_in_scope_ids(db_session):
    w = await _world(db_session)
    user = await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w["oem"].id])
    alpha = str(w["alpha"].id)
    async with client_for(db_session) as client:
        await _load(client, engineer_id=alpha)
    rows = (
        (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == ACTION, AuditLogEntry.actor_user_id == user.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert alpha not in rows[0].after_state["filter_key"]
    assert rows[0].after_state["engineer_rows"] == 0
    assert rows[0].after_state["chamber_rows"] == 0


async def test_unrestricted_caller_engineer_filter_unchanged(db_session):
    """A Portfolio Manager (all hubs) still slices by any engineer, also one
    outside the `hub_id` filter (the hub filter narrows rows, not who the
    caller may filter by)."""

    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    beta = str(w["beta"].id)
    async with client_for(db_session) as client:
        body = await _load(client, engineer_id=beta)
        other_hub = await _load(client, engineer_id=beta, hub_id=str(w["romania"].id))
        unknown = await _load(client, engineer_id=str(uuid.uuid4()))
    assert _chamber_loads(body)["GR-1"] == 9.0
    assert body["filters_applied"]["engineer_id"] == [beta]
    assert other_hub["engineers"] == []
    assert _chamber_loads(other_hub) == {"RO-1": 0.0}
    assert unknown["engineers"] == [] and unknown["chambers"] == []
    assert unknown["filters_applied"]["engineer_id"] == []


async def test_hub_planner_in_scope_engineer_filter_still_works(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w["greece"].id])
    alpha = str(w["alpha"].id)
    async with client_for(db_session) as client:
        body = await _load(client, engineer_id=alpha)
    assert [r["name"] for r in body["engineers"]] == ["Alpha"]
    assert _chamber_loads(body)["GR-1"] == 10.0
    assert body["filters_applied"]["engineer_id"] == [alpha]


# --- S19-L1 / S19-L3: engineers --------------------------------------------------------


@pytest.mark.parametrize("field", ["name", "hub_id", "fte", "allowed_categories"])
async def test_engineer_patch_explicit_null_is_422(db_session, field):
    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/engineers/{w['alpha'].id}", json={field: None})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"][0]["type"] == "null_not_allowed"
    assert resp.json()["detail"][0]["loc"][-1] == field
    await db_session.refresh(w["alpha"])
    assert w["alpha"].name == "Alpha" and float(w["alpha"].fte) == 0.8


async def test_engineer_patch_null_user_id_unlinks(db_session):
    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/engineers/{w['alpha'].id}", json={"user_id": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["user_id"] is None


@pytest.mark.parametrize(
    "payload",
    [{"fte": True}, {"fte": "0.5"}, {"fte": "1"}, {"name": 5}, {"allowed_categories": "A"}],
)
async def test_engineer_patch_is_strict(db_session, payload):
    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/engineers/{w['alpha'].id}", json=payload)
    assert resp.status_code == 422, resp.text


async def test_engineer_create_is_strict(db_session):
    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.ADMIN)
    base = {"name": "Delta", "hub_id": str(w["greece"].id), "allowed_categories": ["A"]}
    async with client_for(db_session) as client:
        assert (await client.post("/engineers", json={**base, "fte": True})).status_code == 422
        assert (await client.post("/engineers", json={**base, "fte": "0.5"})).status_code == 422
        ok = await client.post("/engineers", json={**base, "fte": 0.5})
    assert ok.status_code == 201, ok.text
    assert ok.json()["fte"] == 0.5


async def test_engineer_frontend_payloads_pass(db_session):
    """The payloads `surfaces/planning` sends (P19-T04): JSON numbers for
    `fte` (an integer is still a JSON number), string UUIDs and enum values."""

    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.ADMIN)
    eid = w["alpha"].id
    async with client_for(db_session) as client:
        inline_fte = await client.patch(f"/engineers/{eid}", json={"fte": 1})
        inline_cats = await client.patch(
            f"/engineers/{eid}", json={"allowed_categories": ["A", "B", "OEM"]}
        )
        form = await client.patch(
            f"/engineers/{eid}",
            json={
                "name": "Alpha",
                "hub_id": str(w["greece"].id),
                "fte": 0.75,
                "allowed_categories": ["A"],
            },
        )
    assert inline_fte.status_code == 200, inline_fte.text
    assert inline_fte.json()["fte"] == 1.0
    assert inline_cats.status_code == 200, inline_cats.text
    assert form.status_code == 200, form.text
    assert form.json()["fte"] == 0.75


async def test_engineer_user_id_integrity_errors_mapped_without_row_values(db_session, caplog):
    w = await _world(db_session, with_run=False)
    linked = await make_user(db_session, RoleName.ENGINEER, email="linked@example.com")
    w["beta"].user_id = linked.id
    await db_session.flush()
    await act_as(db_session, RoleName.ADMIN)
    # The handler rolls back on an IntegrityError; commit the setup (a
    # SAVEPOINT release under the conftest's outer transaction) so the
    # rollback only undoes the failed request.
    await db_session.commit()
    # The handler's rollback expires ORM objects: keep plain ids.
    eid, linked_id = w["alpha"].id, linked.id
    caplog.set_level(logging.DEBUG)
    async with client_for(db_session) as client:
        unknown = await client.patch(f"/engineers/{eid}", json={"user_id": str(uuid.uuid4())})
        taken = await client.patch(f"/engineers/{eid}", json={"user_id": str(linked_id)})
    assert unknown.status_code == 422, unknown.text
    assert unknown.json()["detail"] == "Unknown user_id"
    assert taken.status_code == 409, taken.text
    assert "Alpha" not in unknown.text and "Alpha" not in taken.text
    assert "Alpha" not in caplog.text and "Failing row" not in caplog.text
    assert "sqlstate=23503" in caplog.text and "sqlstate=23505" in caplog.text


# --- S19-L2 / S19-L3: chambers ---------------------------------------------------------


@pytest.mark.parametrize(
    "field",
    [
        "code",
        "lab_region",
        "max_concurrent",
        "platforms",
        "efficiency",
        "maintenance_weeks",
        "breakdown_weeks",
        "calibration_weeks",
        "allowed_stages",
    ],
)
async def test_chamber_patch_explicit_null_is_422(db_session, field):
    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/chambers/{w['gr1'].id}", json={field: None})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"][0]["type"] == "null_not_allowed"
    await db_session.refresh(w["gr1"])
    assert w["gr1"].code == "GR-1" and w["gr1"].platforms == 2


async def test_chamber_duplicate_code_is_still_409(db_session):
    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.ADMIN)
    await db_session.commit()  # see the engineer integrity test
    cid = w["gr1"].id  # the handler's rollback expires ORM objects
    async with client_for(db_session) as client:
        resp = await client.patch(f"/chambers/{cid}", json={"code": "RO-1"})
        after = await client.get(f"/chambers/{cid}")
    assert after.status_code == 200 and after.json()["code"] == "GR-1"
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == "Chamber code already exists"


@pytest.mark.parametrize(
    "payload",
    [
        {"platforms": "2"},
        {"platforms": True},
        {"platforms": 2.5},
        {"max_concurrent": "3"},
        {"efficiency": True},
        {"efficiency": "0.5"},
        {"maintenance_weeks": "1"},
        {"code": 7},
    ],
)
async def test_chamber_patch_is_strict(db_session, payload):
    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/chambers/{w['gr1'].id}", json=payload)
    assert resp.status_code == 422, resp.text


async def test_chamber_frontend_payloads_pass(db_session):
    """Inline edits (P19-T04) send JSON numbers; the full form sends every
    field with numbers, the region string and stage ids."""

    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.ADMIN)
    cid = w["gr1"].id
    async with client_for(db_session) as client:
        platforms = await client.patch(f"/chambers/{cid}", json={"platforms": 3})
        efficiency = await client.patch(f"/chambers/{cid}", json={"efficiency": 1})
        efficiency_f = await client.patch(f"/chambers/{cid}", json={"efficiency": 0.75})
        form = await client.patch(
            f"/chambers/{cid}",
            json={
                "code": "GR-1",
                "lab_region": "Greece",
                "max_concurrent": 3,
                "platforms": 3,
                "efficiency": 0.75,
                "maintenance_weeks": 2,
                "breakdown_weeks": 0.5,
                "calibration_weeks": 1,
                "allowed_stages": [],
            },
        )
        created = await client.post(
            "/chambers",
            json={
                "code": "GR-NEW",
                "lab_region": "Greece",
                "max_concurrent": 1,
                "platforms": 1,
                "efficiency": 1.0,
                "maintenance_weeks": 2,
                "breakdown_weeks": 0,
                "calibration_weeks": 1,
                "allowed_stages": [],
                "weeks_per_chamber": 40,  # retired key, still ignored
            },
        )
        strict_create = await client.post(
            "/chambers",
            json={"code": "GR-BAD", "lab_region": "Greece", "max_concurrent": "1"},
        )
    for resp in (platforms, efficiency, efficiency_f, form):
        assert resp.status_code == 200, resp.text
    assert efficiency.json()["efficiency"] == 1.0
    assert form.json()["breakdown_weeks"] == 0.5
    assert created.status_code == 201, created.text
    assert strict_create.status_code == 422


# --- integrity-error mapping units -----------------------------------------------------


class _AsyncpgLike(Exception):
    def __init__(self, sqlstate: str):
        super().__init__("Failing row contains (Secret Name, ...)")
        self.sqlstate = sqlstate


def _integrity(sqlstate: str) -> IntegrityError:
    return IntegrityError("UPDATE ...", {"name": "Secret Name"}, _AsyncpgLike(sqlstate))


@pytest.mark.parametrize(
    ("mapper", "sqlstate", "expected"),
    [
        (chambers_router._integrity_http_error, "23505", 409),
        (chambers_router._integrity_http_error, "23502", 422),
        (chambers_router._integrity_http_error, "23514", 422),
        (chambers_router._integrity_http_error, "23503", 500),
        (engineers_router._integrity_http_error, "23505", 409),
        (engineers_router._integrity_http_error, "23503", 422),
        (engineers_router._integrity_http_error, "23502", 500),
    ],
)
def test_integrity_mapping_never_logs_row_values(caplog, mapper, sqlstate, expected):
    caplog.set_level(logging.DEBUG)
    err = mapper(_integrity(sqlstate), "update")
    assert err.status_code == expected
    assert "Secret Name" not in str(err.detail)
    assert "Secret Name" not in caplog.text and "Failing row" not in caplog.text
    assert f"sqlstate={sqlstate}" in caplog.text


async def test_chamber_rows_untouched_by_rejected_nulls(db_session):
    """A rejected PATCH leaves no audit row and no change."""

    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        await client.patch(f"/chambers/{w['gr1'].id}", json={"efficiency": None})
        await client.patch(f"/engineers/{w['alpha'].id}", json={"fte": None})
    audits = (
        (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action.in_(["chamber.update", "engineer.update"])
                )
            )
        )
        .scalars()
        .all()
    )
    assert audits == []
    assert (await db_session.get(Chamber, w["gr1"].id)).efficiency == pytest.approx(0.5)
    assert float((await db_session.get(Engineer, w["alpha"].id)).fte) == 0.8
