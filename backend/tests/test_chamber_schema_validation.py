"""P9-F01 (R04-L2) — `schemas.chamber.ChamberCreateRequest`/`ChamberUpdateRequest`
must 422 on non-finite floats and out-of-range magnitudes, not fall through
to a 500 (an asyncpg `NumericValueOutOfRangeError` on `inf`/huge values, or an
unrenderable `NaN` in the 422 body itself) — the security-auditor's P9-R04
live finding. Same `POST /chambers` RBAC/helper pattern as
`tests/test_rbac_enforcement.py`'s chamber coverage.
"""

from __future__ import annotations

import json

import pytest
from httpx import ASGITransport, AsyncClient, Response

from api.db import get_db
from api.main import app
from models.enums import LabRegion, RoleName
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_user


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown():
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


async def _as(db_session, *roles: RoleName) -> AsyncClient:
    user = await make_user(db_session, *roles)
    client = _client(db_session)
    override_current_principal(make_principal(*roles, user_id=user.id))
    return client


def _base_payload(**overrides) -> dict:
    payload = {
        "code": "CH-VALIDATION",
        "lab_region": LabRegion.GREECE.value,
        "max_concurrent": 2,
    }
    payload.update(overrides)
    return payload


async def _post_raw_json(client: AsyncClient, url: str, payload: dict) -> Response:
    """`httpx`'s own `json=` kwarg calls `json.dumps(..., allow_nan=False)`
    internally and raises client-side on `inf`/`nan` before a request is even
    sent — exactly the strictness this task wants the SERVER to enforce, but
    it means `client.post(url, json=...)` can never reach the server with
    those values at all. Bypasses that by encoding the body ourselves with
    Python's own default `allow_nan=True` (the literal `Infinity`/`NaN`
    tokens the real P9-R04 pentest sent over the wire with `curl`), same as
    `security-auditor`'s live reproduction.
    """

    return await client.post(
        url,
        content=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )


async def _patch_raw_json(client: AsyncClient, url: str, payload: dict) -> Response:
    return await client.patch(
        url,
        content=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("efficiency", float("inf")),
        ("efficiency", float("-inf")),
        ("maintenance_weeks", float("inf")),
        ("breakdown_weeks", float("inf")),
        ("calibration_weeks", float("inf")),
    ],
)
async def test_chamber_create_rejects_non_finite_floats(db_session, field, value):
    try:
        async with await _as(db_session, RoleName.ADMIN) as client:
            resp = await _post_raw_json(client, "/chambers", _base_payload(**{field: value}))
        assert resp.status_code == 422
    finally:
        _teardown()


@pytest.mark.parametrize(
    "field,value",
    [
        ("efficiency", 1.5),  # > 1.0 (a fraction of capacity, per DOMAIN_RULES ADR 0008)
        ("maintenance_weeks", 1e308),
        ("breakdown_weeks", 200),  # > the 104-week (2x a year) ceiling
        ("calibration_weeks", -1),
    ],
)
async def test_chamber_create_rejects_out_of_range_floats(db_session, field, value):
    try:
        async with await _as(db_session, RoleName.ADMIN) as client:
            resp = await client.post("/chambers", json=_base_payload(**{field: value}))
        assert resp.status_code == 422
    finally:
        _teardown()


async def test_chamber_create_still_accepts_seed_range_values(db_session):
    # Regression guard: the new `le=` ceilings must not reject the real
    # seeded values (`domain_constants.CHAMBER_SEED`'s max is
    # breakdown_weeks=11, efficiency<=0.7).
    try:
        async with await _as(db_session, RoleName.ADMIN) as client:
            resp = await client.post(
                "/chambers",
                json=_base_payload(
                    efficiency=0.7, maintenance_weeks=2, breakdown_weeks=11, calibration_weeks=1
                ),
            )
        assert resp.status_code == 201
    finally:
        _teardown()


async def test_chamber_update_rejects_nan(db_session):
    # The exact P9-R04 finding: NaN's 422 body previously could not be
    # JSON-rendered at all, surfacing as a 500.
    try:
        async with await _as(db_session, RoleName.ADMIN) as client:
            create_resp = await client.post("/chambers", json=_base_payload())
            assert create_resp.status_code == 201
            chamber_id = create_resp.json()["id"]
            resp = await _patch_raw_json(
                client, f"/chambers/{chamber_id}", {"efficiency": float("nan")}
            )
        assert resp.status_code == 422
    finally:
        _teardown()
