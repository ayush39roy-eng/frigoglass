"""P27-T01 (ADR 0038, docs/API_CONTRACT_P27.md): Registration "project nature"
tags pre-fill rubric scores.

Covers: create with tags and no score row (5 on the mapped dimensions, the
others missing -> incomplete), the not-set -> set transition rule (set,
re-save keeps a manual edit, remove keeps the score, re-add writes 5 again),
multi-tag and canonical order, an inactive mapped dimension, strict 422s,
RBAC (who may edit Registration), the audit rows (source = registration
tag), no `schedule_stale` and no `priority` change, every read surface
(project, list, Workspace, Matrix row), the seed rule, and the p27a backfill
migration on its own container.
"""

from __future__ import annotations

import asyncio
import uuid

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from testcontainers.postgres import PostgresContainer

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    HubName,
    LabRegion,
    ProjectAccessRole,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    RoleName,
    ScoringTag,
)
from models.priority import PriorityScore
from models.project import Project
from models.project_access import ProjectAccessGrant
from models.scoring_rubric import PriorityDimensionScore, ScoringDimension
from seed.initial_scoring_rubric import initial_rubric, seed_priority_score
from services.priority_scoring import compute_score
from services.scoring_rubric import load_rubric
from services.scoring_tags import tags_for_type
from services.workspace import event_summary
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.conftest import run_alembic
from tests.factories import (
    make_engineer,
    make_hub,
    make_priority_score,
    make_project,
    make_user,
    registration_body,
)
from tests.rubric_helpers import INITIAL_KEYS, score_of

ALL_TAGS = [t.value for t in ScoringTag]


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


async def _act_as(db_session, *roles: RoleName, hub_ids: list[uuid.UUID] | None = None):
    scoped = hub_ids is not None
    user = await make_user(db_session, *roles, hub_scope_all=not scoped, hub_ids=hub_ids or [])
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=not scoped,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def _db_scores(db_session, project_id: uuid.UUID) -> dict[str, int | None] | None:
    """Every stored dimension score (active or not) by key; None = no score row."""

    score_id = (
        await db_session.execute(
            select(PriorityScore.id).where(PriorityScore.project_id == project_id)
        )
    ).scalar_one_or_none()
    if score_id is None:
        return None
    rows = (
        await db_session.execute(
            select(ScoringDimension.key, PriorityDimensionScore.score)
            .join(ScoringDimension, ScoringDimension.id == PriorityDimensionScore.dimension_id)
            .where(PriorityDimensionScore.priority_score_id == score_id)
        )
    ).all()
    return {k: s for k, s in rows}


async def _cached(db_session, project_id: uuid.UUID) -> tuple[float | None, int | None, str | None]:
    row = (
        await db_session.execute(
            select(
                PriorityScore.weighted_score,
                PriorityScore.normalized_pct,
                PriorityScore.suggested_band,
            )
            .where(PriorityScore.project_id == project_id)
            .execution_options(populate_existing=True)
        )
    ).one()
    ws = float(row[0]) if row[0] is not None else None
    return ws, row[1], row[2].value if row[2] is not None else None


async def _expected(db_session, scores: dict[str, int | None]):
    result = compute_score(await load_rubric(db_session), scores)
    ws = float(result.weighted_score) if result.weighted_score is not None else None
    return ws, result.normalized_pct, result.band


async def _project_state(db_session, project_id: uuid.UUID) -> tuple[bool, str | None]:
    row = (
        await db_session.execute(
            select(Project.schedule_stale, Project.priority).where(Project.id == project_id)
        )
    ).one()
    return row[0], row[1].value if row[1] is not None else None


async def _tag_audits(db_session, project_id: uuid.UUID) -> list[AuditLogEntry]:
    score_id = (
        await db_session.execute(
            select(PriorityScore.id).where(PriorityScore.project_id == project_id)
        )
    ).scalar_one_or_none()
    if score_id is None:
        return []
    rows = (
        (
            await db_session.execute(
                select(AuditLogEntry)
                .where(
                    AuditLogEntry.entity_type == "PriorityScore",
                    AuditLogEntry.entity_id == str(score_id),
                )
                .order_by(AuditLogEntry.occurred_at, AuditLogEntry.id)
            )
        )
        .scalars()
        .all()
    )
    return [r for r in rows if (r.after_state or {}).get("source") == "registration_tag"]


async def _scored_project(db_session, hub, name="Scored", dims=None, **overrides):
    """A project with a complete score under the initial rubric, not stale."""

    dims = dims or [1] * 13
    project = await make_project(db_session, hub, name=name, schedule_stale=False, **overrides)
    weighted, pct, band = score_of(dims)
    await make_priority_score(
        db_session,
        project,
        dims=dims,
        weighted_score=weighted,
        normalized_pct=pct,
        suggested_band=ProjectPriority(band),
    )
    return project


# --- create ------------------------------------------------------------------------


async def test_create_with_tags_and_no_score_row_prefills_and_is_incomplete(db_session):
    user = await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    body = registration_body(
        hub, leader, scoring_tags=["regulatory_compliance", "new_options"], type="CO"
    )
    async with _client(db_session) as client:
        resp = await client.post("/projects", json=body)
        assert resp.status_code == 201, resp.text
        created = resp.json()
        # Canonical order, and the mapped dimension keys.
        assert created["scoring_tags"] == ["new_options", "regulatory_compliance"]
        assert created["tag_dimension_keys"] == ["new_options", "regulatory_compliance"]
        pid = uuid.UUID(created["id"])
        row = (await client.get(f"/priorities/{pid}")).json()

    scores = await _db_scores(db_session, pid)
    assert scores == {"new_options": 5, "regulatory_compliance": 5}
    # 2 x 25 of 295 = 16.95 -> 17, P4; the 11 others are missing.
    assert await _cached(db_session, pid) == (50.0, 17, "P4")
    assert row["has_score"] is True
    assert row["normalized_pct"] == 17
    assert set(row["missing_dimension_keys"]) == set(INITIAL_KEYS) - {
        "new_options",
        "regulatory_compliance",
    }
    assert row["scoring_tags"] == ["new_options", "regulatory_compliance"]
    assert row["tag_dimension_keys"] == ["new_options", "regulatory_compliance"]
    by_key = {d["key"]: d["score"] for d in row["dimension_scores"]}
    assert by_key["new_options"] == 5 and by_key["new_customer"] is None

    audits = await _tag_audits(db_session, pid)
    assert len(audits) == 1
    audit = audits[0]
    assert audit.action == "priority_score.create"
    assert audit.actor_user_id == user.id
    assert audit.before_state is None
    assert audit.after_state["tags"] == ["new_options", "regulatory_compliance"]
    assert audit.after_state["scores"] == {"new_options": 5, "regulatory_compliance": 5}
    assert audit.after_state["normalized_pct"] == 17
    create_row = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "project.create", AuditLogEntry.entity_id == str(pid)
            )
        )
    ).scalar_one()
    assert create_row.after_state["scoring_tags"] == ["new_options", "regulatory_compliance"]
    # The committed priority is the one registered, never the score's band.
    assert (await _project_state(db_session, pid))[1] == "P3"


async def test_create_without_tags_writes_no_score(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    async with _client(db_session) as client:
        resp = await client.post("/projects", json=registration_body(hub, leader))
    assert resp.status_code == 201, resp.text
    assert resp.json()["scoring_tags"] == []
    assert resp.json()["tag_dimension_keys"] == []
    assert await _db_scores(db_session, uuid.UUID(resp.json()["id"])) is None


async def test_create_with_all_six_tags(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    async with _client(db_session) as client:
        resp = await client.post(
            "/projects", json=registration_body(hub, leader, scoring_tags=list(reversed(ALL_TAGS)))
        )
    assert resp.status_code == 201, resp.text
    assert resp.json()["scoring_tags"] == ALL_TAGS
    assert resp.json()["tag_dimension_keys"] == [
        "new_customer",
        "strategic_project",
        "new_options",
        "regulatory_compliance",
        "new_models",
        "quality_improvements",
    ]
    pid = uuid.UUID(resp.json()["id"])
    scores = await _db_scores(db_session, pid)
    assert scores == {k: 5 for k in dc.SCORING_TAG_DIMENSION_KEY.values()}
    # 5 x 25 + 15 = 140 of 295 = 47.46 -> 47, P3.
    assert await _cached(db_session, pid) == (140.0, 47, "P3")


# --- the transition rule -----------------------------------------------------------


async def test_transition_rule_set_resave_remove_readd(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    project = await _scored_project(db_session, hub, priority=ProjectPriority.P2)
    pid = project.id

    async with _client(db_session) as client:
        # 1. not set -> set: new_models 1 -> 5, recomputed.
        resp = await client.patch(f"/projects/{pid}", json={"scoring_tags": ["new_models"]})
        assert resp.status_code == 200, resp.text
        assert resp.json()["scoring_tags"] == ["new_models"]
        scores = await _db_scores(db_session, pid)
        assert scores["new_models"] == 5
        assert all(v == 1 for k, v in scores.items() if k != "new_models")
        assert await _cached(db_session, pid) == await _expected(db_session, scores)
        assert len(await _tag_audits(db_session, pid)) == 1

        # 2. a manual edit to 2 ...
        put = await client.put(
            f"/priorities/{pid}", json={"scores": {"new_models": 2}, "hard_gates": []}
        )
        assert put.status_code == 200, put.text
        # ... survives re-saving the same tag together with another field.
        resp = await client.patch(
            f"/projects/{pid}", json={"scoring_tags": ["new_models"], "name": "Renamed"}
        )
        assert resp.status_code == 200, resp.text
        assert (await _db_scores(db_session, pid))["new_models"] == 2
        assert len(await _tag_audits(db_session, pid)) == 1

        # 3. adding a second tag writes only the new one.
        resp = await client.patch(
            f"/projects/{pid}", json={"scoring_tags": ["improvement", "new_models"]}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["scoring_tags"] == ["new_models", "improvement"]
        assert resp.json()["tag_dimension_keys"] == ["new_models", "quality_improvements"]
        scores = await _db_scores(db_session, pid)
        assert (scores["new_models"], scores["quality_improvements"]) == (2, 5)
        audits = await _tag_audits(db_session, pid)
        assert len(audits) == 2
        # One transaction in tests: occurred_at ties, so find the row by its tags.
        added = [a for a in audits if a.after_state["tags"] == ["improvement"]]
        assert len(added) == 1
        assert added[0].before_state["scores"]["quality_improvements"] == 1
        assert added[0].after_state["scores"]["new_models"] == 2

        # 4. removing every tag leaves the scores.
        resp = await client.patch(f"/projects/{pid}", json={"scoring_tags": []})
        assert resp.status_code == 200, resp.text
        assert resp.json()["scoring_tags"] == []
        assert resp.json()["tag_dimension_keys"] == []
        after_remove = await _db_scores(db_session, pid)
        assert after_remove == scores
        assert len(await _tag_audits(db_session, pid)) == 2

        # 5. re-adding after the manual edit is a new transition: 5 again.
        resp = await client.patch(f"/projects/{pid}", json={"scoring_tags": ["new_models"]})
        assert resp.status_code == 200, resp.text
        final = await _db_scores(db_session, pid)
        assert final["new_models"] == 5
        assert await _cached(db_session, pid) == await _expected(db_session, final)
        assert len(await _tag_audits(db_session, pid)) == 3

    # ADR 0038 §7: never stale, priority untouched.
    assert await _project_state(db_session, pid) == (False, "P2")


async def test_patch_without_scoring_tags_writes_no_score(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    project = await _scored_project(db_session, hub, scoring_tags=[ScoringTag.NEW_MODELS])
    before = await _db_scores(db_session, project.id)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"comments": "x"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["scoring_tags"] == ["new_models"]
    assert await _db_scores(db_session, project.id) == before
    assert await _tag_audits(db_session, project.id) == []


async def test_patch_tags_on_unscored_project_creates_the_score_row(db_session):
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=None)
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, schedule_stale=False)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{project.id}", json={"scoring_tags": ["strategic_project"]}
        )
    assert resp.status_code == 200, resp.text
    assert await _db_scores(db_session, project.id) == {"strategic_project": 5}
    # 25 / 295 = 8.47 -> 8, P4.
    assert await _cached(db_session, project.id) == (25.0, 8, "P4")
    audits = await _tag_audits(db_session, project.id)
    assert [a.action for a in audits] == ["priority_score.create"]
    assert await _project_state(db_session, project.id) == (False, "P3")
    update_row = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "project.update",
                AuditLogEntry.entity_id == str(project.id),
            )
        )
    ).scalar_one()
    assert update_row.before_state["scoring_tags"] == []
    assert update_row.after_state["scoring_tags"] == ["strategic_project"]
    assert "Project nature set to Strategic Project" in event_summary(update_row)
    assert "pre-filled from project nature (Strategic Project)" in event_summary(audits[0])


async def test_inactive_mapped_dimension_is_still_written(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    project = await _scored_project(db_session, hub)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()

        def proposal(active: bool) -> list[dict]:
            out = []
            for d in rubric["dimensions"]:
                item = {k: d[k] for k in ("key", "label", "pillar", "weight", "inverted", "active")}
                if d["key"] == "new_customer":
                    item["active"] = active
                out.append(item)
            return out

        put = await client.put(
            "/scoring-rubric",
            json={"version": rubric["version"], "reason": "off", "dimensions": proposal(False)},
        )
        assert put.status_code == 200, put.text
        pct_inactive = (await _cached(db_session, project.id))[1]

        resp = await client.patch(
            f"/projects/{project.id}", json={"scoring_tags": ["new_customer"]}
        )
        assert resp.status_code == 200, resp.text
        assert (await _db_scores(db_session, project.id))["new_customer"] == 5
        # Inactive: not in the formula, not served on the row.
        assert (await _cached(db_session, project.id))[1] == pct_inactive
        row = (await client.get(f"/priorities/{project.id}")).json()
        assert "new_customer" not in {d["key"] for d in row["dimension_scores"]}
        assert row["tag_dimension_keys"] == ["new_customer"]

        # Reactivated: the 5 counts.
        rubric = (await client.get("/scoring-rubric")).json()
        put = await client.put(
            "/scoring-rubric",
            json={"version": rubric["version"], "reason": "on", "dimensions": proposal(True)},
        )
        assert put.status_code == 200, put.text
    scores = await _db_scores(db_session, project.id)
    assert await _cached(db_session, project.id) == await _expected(db_session, scores)
    # 12 x score 1 + new_customer 5: (295 - 25) / 5 + 25 = 79 of 295 = 26.78 -> 27.
    assert (await _cached(db_session, project.id))[1] == 27


# --- validation --------------------------------------------------------------------


@pytest.mark.parametrize(
    "tags",
    [
        ["new_customer", "bogus"],
        ["new_customer", "new_customer"],
        "new_customer",
        [None],
        ["New Customer"],
        ["quality_improvements"],
    ],
)
async def test_bad_tags_are_422_on_patch(db_session, tags):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"scoring_tags": tags})
    assert resp.status_code == 422, resp.text
    assert await _db_scores(db_session, project.id) is None


async def test_null_tags_on_patch_is_null_not_allowed(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"scoring_tags": None})
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "NULL_NOT_ALLOWED"


async def test_bad_tag_on_create_is_422_and_writes_nothing(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    leader = await make_engineer(db_session, hub)
    before = (await db_session.execute(select(func.count(Project.id)))).scalar_one()
    async with _client(db_session) as client:
        bad = await client.post(
            "/projects", json=registration_body(hub, leader, scoring_tags=["nope"])
        )
        null = await client.post(
            "/projects", json=registration_body(hub, leader, scoring_tags=None)
        )
    assert bad.status_code == 422 and null.status_code == 422
    assert (await db_session.execute(select(func.count(Project.id)))).scalar_one() == before


# --- RBAC --------------------------------------------------------------------------


@pytest.mark.parametrize("role", [RoleName.ENGINEER, RoleName.EXECUTIVE_VIEWER, RoleName.AUDITOR])
async def test_roles_without_registration_write_get_403(db_session, role):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    await _act_as(db_session, role)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"scoring_tags": ["new_models"]})
    assert resp.status_code == 403, resp.text
    assert await _db_scores(db_session, project.id) is None


async def test_hub_planner_scope(db_session):
    own = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    mine = await make_project(db_session, own, name="Mine")
    theirs = await make_project(db_session, other, name="Theirs")
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[own.id])
    async with _client(db_session) as client:
        ok = await client.patch(f"/projects/{mine.id}", json={"scoring_tags": ["new_options"]})
        hidden = await client.patch(
            f"/projects/{theirs.id}", json={"scoring_tags": ["new_options"]}
        )
    assert ok.status_code == 200, ok.text
    assert hidden.status_code == 404, hidden.text
    assert await _db_scores(db_session, mine.id) == {"new_options": 5}
    assert await _db_scores(db_session, theirs.id) is None


async def test_editor_grant_may_not_set_tags(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    granter = await make_user(db_session, RoleName.SUPER_ADMIN, email="granter@example.com")
    grantee = await _act_as(db_session, RoleName.ENGINEER)
    db_session.add(
        ProjectAccessGrant(
            project_id=project.id,
            user_id=grantee.id,
            project_role=ProjectAccessRole.EDITOR,
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"scoring_tags": ["new_models"]})
    assert resp.status_code == 403, resp.text
    assert await _db_scores(db_session, project.id) is None


# --- read surfaces -----------------------------------------------------------------


async def test_tags_served_on_project_list_workspace_and_matrix(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    hub = await make_hub(db_session)
    project = await _scored_project(
        db_session,
        hub,
        name="Tagged",
        scoring_tags=[ScoringTag.IMPROVEMENT, ScoringTag.NEW_CUSTOMER],
    )
    expected_tags = ["new_customer", "improvement"]
    expected_keys = ["new_customer", "quality_improvements"]
    async with _client(db_session) as client:
        one = (await client.get(f"/projects/{project.id}")).json()
        listed = {p["id"]: p for p in (await client.get("/projects")).json()}
        ws = (await client.get(f"/projects/{project.id}/workspace")).json()
        rows = {r["project_id"]: r for r in (await client.get("/priorities")).json()}
    for payload in (one, listed[str(project.id)], ws["project"], rows[str(project.id)]):
        assert payload["scoring_tags"] == expected_tags
        assert payload["tag_dimension_keys"] == expected_keys


# --- seed rule ---------------------------------------------------------------------


def test_tags_for_type_is_the_backfill_rule():
    assert tags_for_type("NM") == [ScoringTag.NEW_MODELS]
    assert tags_for_type("NO") == [ScoringTag.NEW_OPTIONS]
    assert tags_for_type("RC") == [ScoringTag.REGULATORY_COMPLIANCE]
    assert tags_for_type("IMP") == [ScoringTag.IMPROVEMENT]
    for other in ("CO", "BC", "AC", "SER", None):
        assert tags_for_type(other) == []
    assert {t.value for t in ProjectType} >= set(dc.PROJECT_TYPE_SCORING_TAG)


def test_seed_priority_score_applies_tags():
    rubric = initial_rubric()
    plain = seed_priority_score(rubric, uuid.uuid4(), [1] * 13)
    tagged = seed_priority_score(rubric, uuid.uuid4(), [1] * 13, tags=[ScoringTag.IMPROVEMENT])
    key_of = {d.id: d.key for d in rubric.dimensions}
    scores = {key_of[s.dimension_id]: s.score for s in tagged.dimension_scores}
    assert scores["quality_improvements"] == 5
    assert all(v == 1 for k, v in scores.items() if k != "quality_improvements")
    assert tagged.normalized_pct == compute_score(rubric, scores).normalized_pct
    assert tagged.normalized_pct > plain.normalized_pct


def test_scheduler_does_not_read_tags():
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent / "scheduling"
    for path in root.rglob("*.py"):
        assert "scoring_tags" not in path.read_text(), path


# --- the p27a backfill migration (own container) -----------------------------------


def _dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def _q(url, sql, *args):
    conn = await asyncpg.connect(_dsn(url))
    try:
        return await conn.fetch(sql, *args)
    finally:
        await conn.close()


#: (name, type, has a score row with every dimension = 1)
_BACKFILL_PROJECTS = (
    ("NM-scored", "NM", True),
    ("NO-scored", "NO", True),
    ("RC-scored", "RC", True),
    ("IMP-scored", "IMP", True),
    ("CO-scored", "CO", True),
    ("null-scored", None, True),
    ("NM-unscored", "NM", False),
    ("CO-unscored", "CO", False),
)


def test_migration_p27a_backfills_tags_and_scores():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "p26a_scoring_rubric_tables"], url)
        assert r.returncode == 0, r.stderr

        async def _load():
            conn = await asyncpg.connect(_dsn(url))
            try:
                hub_id = uuid.uuid4()
                await conn.execute(
                    "INSERT INTO hubs (id, name, lab_region, is_oem) "
                    "VALUES ($1, 'R&D-Greece', 'Greece', false)",
                    hub_id,
                )
                dims = await conn.fetch("SELECT id FROM scoring_dimensions")
                for name, type_, scored in _BACKFILL_PROJECTS:
                    pid = uuid.uuid4()
                    await conn.execute(
                        "INSERT INTO projects (id, name, hub_id, status, frozen, delay_weeks, "
                        "carry_over, type, priority, schedule_stale) VALUES ($1, $2, $3, "
                        "'In Queue', false, 0, false, $4::project_type, 'P4', false)",
                        pid,
                        name,
                        hub_id,
                        type_,
                    )
                    if not scored:
                        continue
                    sid = uuid.uuid4()
                    # 13 x 1 = 59 of 295 = 20, P4.
                    await conn.execute(
                        "INSERT INTO priority_scores (id, project_id, hard_gates, weighted_score, "
                        "normalized_pct, suggested_band, rubric_version) "
                        "VALUES ($1, $2, '{}', 59, 20, 'P4', 1)",
                        sid,
                        pid,
                    )
                    for d in dims:
                        await conn.execute(
                            "INSERT INTO priority_dimension_scores VALUES ($1, $2, 1)",
                            sid,
                            d["id"],
                        )
            finally:
                await conn.close()

        asyncio.run(_load())
        r = run_alembic(["upgrade", "p27a_project_scoring_tags"], url)
        assert r.returncode == 0, r.stderr
        assert "p27a: tagged 5 project(s) from type; created 1 score row(s)" in r.stderr

        tags = {
            row["name"]: list(row["tags"])
            for row in asyncio.run(
                _q(url, "SELECT name, scoring_tags::text[] AS tags FROM projects")
            )
        }
        assert tags == {
            "NM-scored": ["new_models"],
            "NO-scored": ["new_options"],
            "RC-scored": ["regulatory_compliance"],
            "IMP-scored": ["improvement"],
            "CO-scored": [],
            "null-scored": [],
            "NM-unscored": ["new_models"],
            "CO-unscored": [],
        }
        stored = asyncio.run(
            _q(
                url,
                "SELECT p.name, sd.key, pds.score FROM priority_dimension_scores pds "
                "JOIN scoring_dimensions sd ON sd.id = pds.dimension_id "
                "JOIN priority_scores ps ON ps.id = pds.priority_score_id "
                "JOIN projects p ON p.id = ps.project_id",
            )
        )
        by_name: dict[str, dict[str, int]] = {}
        for row in stored:
            by_name.setdefault(row["name"], {})[row["key"]] = row["score"]
        assert "CO-unscored" not in by_name
        assert by_name["NM-unscored"] == {"new_models": 5}
        for name, key in (
            ("NM-scored", "new_models"),
            ("NO-scored", "new_options"),
            ("RC-scored", "regulatory_compliance"),
            ("IMP-scored", "quality_improvements"),
        ):
            assert by_name[name][key] == 5
            assert all(v == 1 for k, v in by_name[name].items() if k != key)
        for name in ("CO-scored", "null-scored"):
            assert set(by_name[name].values()) == {1}

        rubric = initial_rubric()
        cached = {
            row["name"]: (float(row["ws"]), row["pct"], row["band"], row["rv"])
            for row in asyncio.run(
                _q(
                    url,
                    "SELECT p.name, ps.weighted_score AS ws, ps.normalized_pct AS pct, "
                    "ps.suggested_band::text AS band, ps.rubric_version AS rv "
                    "FROM priority_scores ps JOIN projects p ON p.id = ps.project_id",
                )
            )
        }
        for name, scores in by_name.items():
            result = compute_score(rubric, scores)
            assert cached[name] == (
                float(result.weighted_score),
                result.normalized_pct,
                result.band,
                1,
            ), name
        # 12 x 1 + one 25-weight dimension at 5: (295 - 25) / 5 + 25 = 79 -> 27.
        assert cached["NO-scored"][1] == 27
        assert cached["NM-unscored"] == (15.0, 5, "P4", 1)

        # Priority and schedule_stale untouched.
        state = asyncio.run(
            _q(url, "SELECT DISTINCT priority::text AS p, schedule_stale FROM projects")
        )
        assert [(s["p"], s["schedule_stale"]) for s in state] == [("P4", False)]

        audits = asyncio.run(
            _q(
                url,
                "SELECT action, actor_user_id, after_state->>'source' AS source, "
                "before_state IS NULL AS no_before FROM audit_log_entries "
                "WHERE entity_type = 'PriorityScore'",
            )
        )
        assert len(audits) == 5
        assert {a["source"] for a in audits} == {"registration_tag_backfill"}
        assert {a["actor_user_id"] for a in audits} == {None}
        assert (
            sorted(a["action"] for a in audits)
            == ["priority_score.create"] + ["priority_score.update"] * 4
        )

        # The CHECK: no duplicates, no null element.
        async def _bad(value_sql: str) -> None:
            conn = await asyncpg.connect(_dsn(url))
            try:
                with pytest.raises(asyncpg.CheckViolationError):
                    await conn.execute(f"UPDATE projects SET scoring_tags = {value_sql}")  # noqa: S608
            finally:
                await conn.close()

        asyncio.run(_bad("ARRAY['new_models','new_models']::project_scoring_tag[]"))
        asyncio.run(_bad("ARRAY[NULL]::project_scoring_tag[]"))

        # Downgrade: tags gone, scores kept; then back to head.
        r = run_alembic(["downgrade", "p26a_scoring_rubric_tables"], url)
        assert r.returncode == 0, r.stderr
        cols = asyncio.run(
            _q(
                url,
                "SELECT count(*) AS n FROM information_schema.columns "
                "WHERE table_name = 'projects' AND column_name = 'scoring_tags'",
            )
        )
        assert cols[0]["n"] == 0
        kept = asyncio.run(_q(url, "SELECT count(*) AS n FROM priority_dimension_scores"))
        assert kept[0]["n"] == 6 * 13 + 1
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr


# --- the model / CHECK through the ORM ---------------------------------------------


async def test_model_property_is_canonical(db_session):
    """`tag_dimension_keys` is canonical whatever order the row holds."""

    hub = await make_hub(db_session)
    project = await make_project(
        db_session, hub, scoring_tags=[ScoringTag.IMPROVEMENT, ScoringTag.NEW_CUSTOMER]
    )
    assert project.tag_dimension_keys == ["new_customer", "quality_improvements"]
    stored = (
        await db_session.execute(select(Project.scoring_tags).where(Project.id == project.id))
    ).scalar_one()
    assert set(stored) == {ScoringTag.IMPROVEMENT, ScoringTag.NEW_CUSTOMER}
    assert project.status == ProjectStatus.IN_QUEUE
