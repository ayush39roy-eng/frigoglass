"""P47-R02: a scores-only save keeps the stored hard gates.

`PUT /priorities/{id}` and `POST /scenarios/apply` write `hard_gates` only
when the request sends the field. Omitted, the stored list stays, as do the
audit after-state and the HARD_GATE_FORCES_P1 rule that read it. An explicit
`[]` still clears it, and a new score row starts with none. User A's gate
change survives user B's concurrent scores-only save.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import ProjectPriority, RoleName
from models.priority import PriorityScore
from models.project import Project
from seed.initial_scoring_rubric import INITIAL_KEYS
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_user
from tests.p12_helpers import client_for, stepped_project

GATE = "Active safety non-compliance"
KEY = INITIAL_KEYS[0]


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _admin(db, name: str) -> Any:
    user = await make_user(db, RoleName.ADMIN, full_name=name)
    return user


def _as(user: Any) -> None:
    override_current_principal(make_principal(RoleName.ADMIN, user_id=user.id, email=user.email))


async def _gates(db, project_id: Any) -> list[str]:
    score = (
        await db.execute(
            select(PriorityScore)
            .where(PriorityScore.project_id == project_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return [g.value for g in score.hard_gates]


async def test_scores_only_put_and_apply_keep_gates_and_empty_list_clears(db_session):
    hub = await make_hub(db_session)
    p = await stepped_project(db_session, hub, name="Gated", priority=ProjectPriority.P1)
    pid = p.id
    alice = await _admin(db_session, "Alice Writer")
    _as(alice)
    async with client_for(db_session) as client:
        # A new score row with no gates sent starts with none.
        r = await client.put(f"/priorities/{pid}", json={"scores": {KEY: 2}})
        assert r.status_code == 200, r.text
        assert r.json()["hard_gates"] == []
        r = await client.put(f"/priorities/{pid}",
                             json={"scores": {KEY: 2}, "hard_gates": [GATE]})
        assert r.json()["hard_gates"] == [GATE]

        r = await client.put(f"/priorities/{pid}", json={"scores": {KEY: 3}})
        assert r.status_code == 200, r.text
        assert r.json()["hard_gates"] == [GATE]
        assert await _gates(db_session, pid) == [GATE]
        audit = (
            await db_session.execute(
                select(AuditLogEntry)
                .where(AuditLogEntry.action == "priority_score.update")
                .order_by(AuditLogEntry.occurred_at.desc())
            )
        ).scalars().all()
        assert all(a.after_state["hard_gates"] == [GATE] for a in audit)
        # The stored gate still pins P1.
        move = await client.post(f"/projects/{pid}/priority", json={"priority": "P3"})
        assert move.status_code == 409 and move.json()["code"] == "HARD_GATE_FORCES_P1"

        r = await client.post("/scenarios/apply", json={"priority_scores": [
            {"project_id": str(pid), "scores": {KEY: 4}}]})
        assert r.status_code == 201, r.text
        assert await _gates(db_session, pid) == [GATE]

        r = await client.post("/scenarios/apply", json={"priority_scores": [
            {"project_id": str(pid), "scores": {KEY: 4}, "hard_gates": []}]})
        assert r.status_code == 201, r.text
        assert await _gates(db_session, pid) == []
        r = await client.put(f"/priorities/{pid}",
                             json={"scores": {KEY: 4}, "hard_gates": [GATE]})
        r = await client.put(f"/priorities/{pid}", json={"scores": {KEY: 4}, "hard_gates": []})
        assert r.json()["hard_gates"] == []


@pytest.mark.parametrize("via", ["put", "apply"])
async def test_gate_change_survives_concurrent_scores_only_save(db_session, via):
    hub = await make_hub(db_session)
    p = await stepped_project(db_session, hub, name="Race", priority=ProjectPriority.P1)
    pid = p.id
    alice = await _admin(db_session, "Alice Writer")
    bob = await _admin(db_session, "Bob Writer")
    async with client_for(db_session) as client:
        _as(alice)
        assert (await client.put(f"/priorities/{pid}", json={"scores": {KEY: 2}})).status_code \
            == 200
        # Both read: score 2, no gates. Alice sets a gate.
        r = await client.put(f"/priorities/{pid}", json={
            "scores": {}, "hard_gates": [GATE], "base": {"hard_gates": []}})
        assert r.status_code == 200, r.text
        # Bob saves a score only, from the same read.
        _as(bob)
        body = {"scores": {KEY: 5}, "base": {"scores": {KEY: 2}}}
        if via == "put":
            r = await client.put(f"/priorities/{pid}", json=body)
            assert r.status_code == 200, r.text
        else:
            r = await client.post("/scenarios/apply", json={"priority_scores": [
                {"project_id": str(pid), **body}]})
            assert r.status_code == 201, r.text
    assert await _gates(db_session, pid) == [GATE]
    stored = (await db_session.execute(select(Project.priority).where(Project.id == pid)))
    assert stored.scalar_one() == ProjectPriority.P1
