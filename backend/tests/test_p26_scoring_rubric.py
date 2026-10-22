"""P26-T01 (ADR 0037, docs/API_CONTRACT_P26.md): the editable scoring rubric.

Covers: the migrated rubric (version 1, the 13 dimensions, total 295), weight
edits against hand-calculated scores, adding a dimension (incomplete, points
unchanged), deactivate / reactivate (historic scores kept), version history
and the 409 on a stale version, preview == the saved result (incl. the P1
capacity fill), validation, RBAC + the audit row, every reader consistent
after a change, the Matrix export columns, the score PUT on the new shape,
and "a rubric change never touches the schedule". The migration losslessness
test (own container, the client_2026 seed's scores) is at the bottom.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import uuid
from pathlib import Path

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from testcontainers.postgres import PostgresContainer

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import ProjectPriority, RoleName
from models.priority import PriorityScore
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectStep
from models.scoring_rubric import PriorityDimensionScore, RubricVersion, ScoringDimension
from models.workflow import ProjectWorkflowStep
from services.scoring_rubric import slugify
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.conftest import run_alembic
from tests.factories import make_hub, make_priority_score, make_project, make_user
from tests.rubric_helpers import INITIAL_KEYS, INITIAL_WEIGHTS, score_body, score_of
from tests.test_p25_capacity_fill import _hub10

_ADMINS = (RoleName.ADMIN, RoleName.SUPER_ADMIN)
_NON_ADMIN_READERS = (
    RoleName.PORTFOLIO_MANAGER,
    RoleName.HUB_PLANNER,
    RoleName.EXECUTIVE_VIEWER,
)
_NO_MATRIX = (RoleName.ENGINEER, RoleName.AUDITOR)


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
    user = await make_user(db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=hub_ids is None)
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=hub_ids is None,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def _scored(db_session, hub, name, dims, **overrides):
    """A project scored with real cached values under the initial rubric."""

    project = await make_project(db_session, hub, name=name, **overrides)
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


def _proposal(rubric: dict, **edits) -> list[dict]:
    """The current rubric as a PUT `dimensions` list, with per-key edits
    (`key={"weight": 100}`)."""

    out = []
    for d in rubric["dimensions"]:
        item = {k: d[k] for k in ("key", "label", "pillar", "weight", "inverted", "active")}
        item.update(edits.get(d["key"], {}))
        out.append(item)
    return out


async def _put(client, rubric: dict, dimensions: list[dict], reason="test change"):
    return await client.put(
        "/scoring-rubric",
        json={"version": rubric["version"], "reason": reason, "dimensions": dimensions},
    )


async def _rows(client) -> dict[str, dict]:
    resp = await client.get("/priorities")
    assert resp.status_code == 200, resp.text
    return {r["project_name"]: r for r in resp.json()}


# --- the migrated rubric -----------------------------------------------------------


async def test_get_rubric_is_the_migrated_13(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.get("/scoring-rubric")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version"] == 1
    assert body["total_weight"] == 295
    assert body["can_edit"] is False
    assert [d["key"] for d in body["dimensions"]] == list(INITIAL_KEYS)
    assert [d["weight"] for d in body["dimensions"]] == INITIAL_WEIGHTS
    assert [d["display_order"] for d in body["dimensions"]] == list(range(1, 14))
    assert all(d["active"] for d in body["dimensions"])
    by_key = {d["key"]: d for d in body["dimensions"]}
    assert by_key["capex_investment"]["inverted"] is True
    assert sum(d["inverted"] for d in body["dimensions"]) == 1
    assert by_key["profitability"]["label"] == "ROI"
    assert by_key["profitability"]["pillar"] == "Investment & Feasibility"
    assert by_key["strategic_project"]["scaled_weight"] == 8.47
    assert body["pillars"] == [
        "Strategic Alignment",
        "Regulatory & Quality",
        "Financial Return",
        "Investment & Feasibility",
        "Market & Volume",
    ]
    assert body["changed_by_user_id"] is None


# --- weight edit, hand-calculated --------------------------------------------------


async def test_weight_edit_changes_normalized_scores_as_hand_calculated(db_session):
    hub = await make_hub(db_session)
    await _scored(db_session, hub, "OnlyStrategic", [5] + [0] * 12)
    await _scored(db_session, hub, "AllThree", [3] * 13)
    await _scored(db_session, hub, "StrategicFive", [5] + [3] * 12)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        before = await _rows(client)
        assert [
            before[n]["normalized_pct"] for n in ("OnlyStrategic", "AllThree", "StrategicFive")
        ] == [
            8,  # 25 / 295 = 8.47
            60,  # 177 / 295
            63,  # (25 + 162) / 295 = 63.39
        ]
        rubric = (await client.get("/scoring-rubric")).json()
        resp = await _put(client, rubric, _proposal(rubric, strategic_project={"weight": 100}))
        assert resp.status_code == 200, resp.text
        saved = resp.json()
        assert saved["version"] == 2
        assert saved["total_weight"] == 370  # 295 - 25 + 100
        after = await _rows(client)
    # OnlyStrategic: 100 / 370 = 27.03 -> 27, P4.
    assert (after["OnlyStrategic"]["weighted_score"], after["OnlyStrategic"]["normalized_pct"]) == (
        100.0,
        27,
    )
    # AllThree: 3/5 x 370 = 222 / 370 = 60 (unchanged), P2.
    assert (after["AllThree"]["weighted_score"], after["AllThree"]["normalized_pct"]) == (222.0, 60)
    # StrategicFive: 100 + 162 = 262 / 370 = 70.81 -> 71, P2 -> P1.
    sf = after["StrategicFive"]
    assert (sf["weighted_score"], sf["normalized_pct"], sf["score_band"]) == (262.0, 71, "P1")
    assert before["StrategicFive"]["score_band"] == "P2"
    for row in after.values():
        assert row["rubric_version"] == 2
        assert sum(d["points"] or 0 for d in row["dimension_scores"]) == pytest.approx(
            row["weighted_score"]
        )
    strategic = next(d for d in sf["dimension_scores"] if d["key"] == "strategic_project")
    assert (strategic["weight"], strategic["points"], strategic["max_points"]) == (
        100,
        100.0,
        100.0,
    )
    # The stored cache was recomputed in the same transaction.
    stored = (
        await db_session.execute(
            select(PriorityScore.normalized_pct, PriorityScore.rubric_version)
            .join(Project, Project.id == PriorityScore.project_id)
            .where(Project.name == "StrategicFive")
        )
    ).one()
    assert tuple(stored) == (71, 2)


# --- adding a dimension -------------------------------------------------------------


async def test_adding_a_dimension_makes_projects_incomplete_with_unchanged_points(db_session):
    hub = await make_hub(db_session)
    project = await _scored(db_session, hub, "AllThree", [3] * 13)
    await make_project(db_session, hub, name="Unscored")
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
        dims = _proposal(rubric) + [
            {"label": "Sustainability & ESG", "pillar": "Sustainability", "weight": 30}
        ]
        resp = await _put(client, rubric, dims, reason="add ESG")
        assert resp.status_code == 200, resp.text
        saved = resp.json()
        new = saved["dimensions"][-1]
        assert (new["key"], new["pillar"], new["display_order"], new["active"]) == (
            "sustainability_esg",
            "Sustainability",
            14,
            True,
        )
        assert saved["pillars"][-1] == "Sustainability"
        assert saved["total_weight"] == 325
        rows = await _rows(client)
        row = rows["AllThree"]
        # Points unchanged (177); 177 / 325 = 54.46 -> 54, P3.
        assert (row["weighted_score"], row["normalized_pct"], row["score_band"]) == (
            177.0,
            54,
            "P3",
        )
        assert row["has_score"] is True
        assert row["missing_dimension_keys"] == ["sustainability_esg"]
        assert len(row["dimension_scores"]) == 14
        esg = row["dimension_scores"][-1]
        assert (esg["key"], esg["score"], esg["points"], esg["weight"]) == (
            "sustainability_esg",
            None,
            None,
            30,
        )
        assert row["dimension_points"]["sustainability_esg"] == {
            "points": 0.0,
            "scaled_points": 0.0,
        }
        # Fully unscored stays unscored, never "incomplete".
        assert rows["Unscored"]["has_score"] is False
        assert rows["Unscored"]["missing_dimension_keys"] == []
        assert rows["Unscored"]["suggested_band"] is None
        # Scoring the new dimension completes the project.
        put = await client.put(
            f"/priorities/{project.id}", json={"scores": {"sustainability_esg": 5}}
        )
        assert put.status_code == 200, put.text
        assert put.json()["missing_dimension_keys"] == []
        assert put.json()["weighted_score"] == 207.0  # 177 + 30
        assert put.json()["normalized_pct"] == 64  # 207 / 325 = 63.69
        # The 13 original scores were kept (omitted keys are not touched).
        assert [d["score"] for d in put.json()["dimension_scores"]] == [3] * 13 + [5]


# --- deactivate / reactivate --------------------------------------------------------


async def test_deactivate_and_reactivate_keeps_historic_scores(db_session):
    hub = await make_hub(db_session)
    project = await _scored(db_session, hub, "CapexZero", [5] * 12 + [0])
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        assert (await _rows(client))["CapexZero"]["normalized_pct"] == 95  # 280 / 295
        rubric = (await client.get("/scoring-rubric")).json()
        resp = await _put(client, rubric, _proposal(rubric, capex_investment={"active": False}))
        assert resp.status_code == 200, resp.text
        assert resp.json()["total_weight"] == 280
        capex = next(d for d in resp.json()["dimensions"] if d["key"] == "capex_investment")
        assert (capex["active"], capex["scaled_weight"]) == (False, None)
        row = (await _rows(client))["CapexZero"]
        assert row["normalized_pct"] == 100  # 280 / 280
        assert "capex_investment" not in [d["key"] for d in row["dimension_scores"]]
        assert "capex_investment" not in row["dimension_points"]
        dims_table = (await client.get("/priorities/dimensions")).json()
        assert len(dims_table["dimensions"]) == 12 and dims_table["total_weight"] == 280
        # An inactive dimension cannot be scored.
        bad = await client.put(
            f"/priorities/{project.id}", json={"scores": {"capex_investment": 2}}
        )
        assert bad.status_code == 422
        assert bad.json()["code"] == "UNKNOWN_DIMENSION_KEY"
        # The historic score is still stored.
        kept = (
            await db_session.execute(
                select(PriorityDimensionScore.score)
                .join(ScoringDimension, ScoringDimension.id == PriorityDimensionScore.dimension_id)
                .join(PriorityScore, PriorityScore.id == PriorityDimensionScore.priority_score_id)
                .where(ScoringDimension.key == "capex_investment")
                .where(PriorityScore.project_id == project.id)
            )
        ).scalar_one()
        assert kept == 0

        rubric = (await client.get("/scoring-rubric")).json()
        resp = await _put(client, rubric, _proposal(rubric, capex_investment={"active": True}))
        assert resp.status_code == 200, resp.text
        assert resp.json()["version"] == 3
        row = (await _rows(client))["CapexZero"]
    assert row["normalized_pct"] == 95
    restored = next(d for d in row["dimension_scores"] if d["key"] == "capex_investment")
    assert restored["score"] == 0 and restored["points"] == 0.0
    assert row["missing_dimension_keys"] == []


# --- versions, 409, no-op ---------------------------------------------------------


async def test_version_history_and_conflict(db_session):
    user = await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        v1 = (await client.get("/scoring-rubric")).json()
        resp = await _put(client, v1, _proposal(v1, new_models={"weight": 20}), reason="  NM up  ")
        assert resp.status_code == 200, resp.text
        v2 = resp.json()
        assert (v2["version"], v2["reason"], v2["changed_by_user_id"]) == (2, "NM up", str(user.id))
        assert v2["changed_by_name"] == user.full_name

        # A second admin still holding version 1 is refused.
        stale = await _put(client, v1, _proposal(v1, new_models={"weight": 5}))
        assert stale.status_code == 409
        assert stale.json()["code"] == "RUBRIC_VERSION_CONFLICT"
        assert "version 2" in stale.json()["detail"]

        # Unchanged proposal: 200, no new version, no audit row.
        audits_before = await _audit_count(db_session)
        same = await _put(client, v2, _proposal(v2))
        assert same.status_code == 200 and same.json()["version"] == 2
        assert await _audit_count(db_session) == audits_before

        versions = (await client.get("/scoring-rubric/versions")).json()["versions"]
    assert [v["version"] for v in versions] == [2, 1]
    assert {d["key"]: d["weight"] for d in versions[0]["dimensions"]}["new_models"] == 20
    assert {d["key"]: d["weight"] for d in versions[1]["dimensions"]}["new_models"] == 15
    assert (versions[0]["total_weight"], versions[1]["total_weight"]) == (300, 295)
    assert versions[1]["changed_by_user_id"] is None
    assert versions[1]["reason"].startswith("Initial rubric")
    stored = (await db_session.execute(select(func.max(RubricVersion.version)))).scalar_one()
    assert stored == 2


async def _audit_count(db_session) -> int:
    return (
        await db_session.execute(
            select(func.count())
            .select_from(AuditLogEntry)
            .where(AuditLogEntry.action == "scoring_rubric.update")
        )
    ).scalar_one()


# --- preview == saved -------------------------------------------------------------


async def test_preview_equals_the_saved_result_including_capacity_fill(db_session):
    from tests.factories import make_schedule_run

    hub = await _hub10(db_session)
    run = await make_schedule_run(db_session, is_active=True)
    specs = {
        "Base": ([4] * 13, 6),  # 80
        "Mid": ([5] + [3] * 12, 3),  # 63 -> 71 after the edit
        "Next": ([3] * 13, 2),  # 60
        "Low": ([2] * 13, 1),  # 40
    }
    for name, (dims, weeks) in specs.items():
        project = await _scored(db_session, hub, name, dims)
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id,
                project_id=project.id,
                step_template_id="PDD-A",
                sequence_order=1,
                duration_weeks=weeks,
                start_week=dc.CURRENT_WEEK,
                end_week=dc.CURRENT_WEEK + weeks - 1,
            )
        )
        # ADR 0041 R12: the fill reads remaining demand from the live rows.
        db_session.add(
            ProjectWorkflowStep(
                project_id=project.id, step_template_id="PDD-A", sequence_order=1,
                duration_weeks=1, duration_override_weeks=weeks,
            )
        )
    await make_project(db_session, hub, name="Unscored")
    await db_session.flush()

    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        before = await _rows(client)
        rubric = (await client.get("/scoring-rubric")).json()
        proposal = _proposal(rubric, strategic_project={"weight": 100}) + [
            {"label": "Rank", "pillar": "Other", "weight": 10}
        ]
        prev = await client.post("/scoring-rubric/preview", json={"dimensions": proposal})
        assert prev.status_code == 200, prev.text
        preview = prev.json()
        # Nothing was saved by the preview.
        assert (await client.get("/scoring-rubric")).json()["version"] == 1
        assert await _rows(client) == before
        saved = await _put(client, rubric, proposal)
        assert saved.status_code == 200, saved.text
        after = await _rows(client)

    assert preview["current_version"] == 1
    assert preview["current_total_weight"] == 295
    assert preview["proposed_total_weight"] == 380 == saved.json()["total_weight"]
    # "rank" is a row field, so the new key is suffixed.
    assert preview["dimensions"][-1]["key"] == "rank_2" == saved.json()["dimensions"][-1]["key"]
    assert preview["dimensions"][-1]["id"] is None
    assert preview["dimensions"][0]["id"] == rubric["dimensions"][0]["id"]
    by_name = {p["project_name"]: p for p in preview["projects"]}
    assert set(by_name) == {"Base", "Mid", "Next", "Low"}  # unscored is not listed
    for name, p in by_name.items():
        row, old = after[name], before[name]
        assert p["old_normalized_pct"] == old["normalized_pct"]
        assert p["old_score_band"] == old["score_band"]
        assert p["old_suggested_band"] == old["suggested_band"]
        assert p["new_normalized_pct"] == row["normalized_pct"], name
        assert p["new_score_band"] == row["score_band"], name
        assert p["new_suggested_band"] == row["suggested_band"], name
        assert p["new_capacity_fill"] == row["capacity_fill"], name
        assert p["missing_dimension_keys"] == row["missing_dimension_keys"] == ["rank_2"]
        assert p["score_band_changed"] == (old["score_band"] != row["score_band"])
    assert preview["scored_projects"] == 4
    assert preview["score_band_change_count"] == sum(
        p["score_band_changed"] for p in by_name.values()
    )
    assert preview["suggested_band_change_count"] == sum(
        p["suggested_band_changed"] for p in by_name.values()
    )
    # Mid: (100 + 162) / 380 = 68.95 -> 69 (P2); it was 63 (P2).
    assert by_name["Mid"]["new_normalized_pct"] == 69
    # Base: 0.8 x 370 = 296 / 380 = 77.89 -> 78 (P1); Low: 148 / 380 = 38.95 -> 39 (P3 -> P4).
    assert (by_name["Base"]["new_normalized_pct"], by_name["Low"]["new_normalized_pct"]) == (78, 39)
    assert {"from_band": "P3", "to_band": "P4", "count": 1} in preview["band_changes"]
    # Capacity fill (C = 10): Base 6 wk, then Mid 3 wk promoted (9), Next 2 wk stops (11).
    assert (by_name["Mid"]["new_suggested_band"], by_name["Mid"]["new_capacity_fill"]) == (
        "P1",
        True,
    )
    assert by_name["Next"]["new_capacity_fill"] is False


async def test_preview_validates_like_put(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
        all_off = [{**d, "active": False} for d in _proposal(rubric)]
        resp = await client.post("/scoring-rubric/preview", json={"dimensions": all_off})
    assert resp.status_code == 422
    assert resp.json()["code"] == "RUBRIC_NO_ACTIVE_DIMENSION"


# --- validation -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda d: [{**x, "active": False} for x in d], "RUBRIC_NO_ACTIVE_DIMENSION"),
        (lambda d: d[1:], "RUBRIC_DIMENSION_MISSING"),
        (lambda d: d + [{**d[0]}], "RUBRIC_DUPLICATE_KEY"),
        (lambda d: d + [{**d[0], "key": "made_up"}], "RUBRIC_UNKNOWN_KEY"),
        (
            lambda d: d + [{"label": "strategic project", "pillar": "X", "weight": 5}],
            "RUBRIC_DUPLICATE_LABEL",
        ),
    ],
)
async def test_put_rejects_invalid_rubrics_with_codes(db_session, mutate, code):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
        resp = await _put(client, rubric, mutate(_proposal(rubric)))
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == code
        assert (await client.get("/scoring-rubric")).json()["version"] == 1


@pytest.mark.parametrize(
    "bad_item",
    [
        {"label": "X", "pillar": "P", "weight": 0},
        {"label": "X", "pillar": "P", "weight": 101},
        {"label": "", "pillar": "P", "weight": 5},
        {"label": "   ", "pillar": "P", "weight": 5},
        {"label": "X", "pillar": "", "weight": 5},
        {"label": "X", "pillar": "P", "weight": "5"},  # strict: no coercion
        {"label": "X", "pillar": "P", "weight": 5.0},
        {"label": "X", "pillar": "P", "weight": True},
        {"label": "X", "pillar": "P", "weight": 5, "extra": 1},
        {"label": "X", "pillar": "P", "weight": 5, "key": "Bad Key"},
        {"label": "X" * 81, "pillar": "P", "weight": 5},
        {"pillar": "P", "weight": 5},
    ],
)
async def test_put_rejects_bad_fields(db_session, bad_item):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
        resp = await _put(client, rubric, _proposal(rubric) + [bad_item])
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize(
    "body_patch",
    [{"version": "1"}, {"reason": ""}, {"reason": "x" * 501}, {"extra": True}, {"dimensions": []}],
)
async def test_put_rejects_bad_envelope(db_session, body_patch):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
        body = {"version": 1, "reason": "r", "dimensions": _proposal(rubric), **body_patch}
        resp = await client.put("/scoring-rubric", json=body)
    assert resp.status_code == 422, resp.text


def test_slugify():
    assert slugify("Sustainability & ESG") == "sustainability_esg"
    assert slugify("  CO2 / kWh  ") == "co2_kwh"
    assert slugify("123 Go") == "d_123_go"
    assert slugify("%%%") == "dimension"
    assert len(slugify("x" * 200)) <= 60


async def test_new_dimension_keys_never_collide(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
        dims = _proposal(rubric) + [
            {"label": "New Models!", "pillar": "Other", "weight": 5},  # -> new_models taken
            {"label": "Status", "pillar": "Other", "weight": 5},  # row field
            {"label": "Strategic-Project", "pillar": "Other", "weight": 5},
        ]
        resp = await _put(client, rubric, dims)
    assert resp.status_code == 200, resp.text
    keys = [d["key"] for d in resp.json()["dimensions"][13:]]
    assert keys == ["new_models_2", "status_2", "strategic_project_2"]


# --- RBAC + audit -----------------------------------------------------------------


@pytest.mark.parametrize("role", _ADMINS + _NON_ADMIN_READERS)
async def test_every_matrix_reader_reads_the_rubric(db_session, role):
    hub = await make_hub(db_session)
    await _act_as(db_session, role, hub_ids=[hub.id] if role == RoleName.HUB_PLANNER else None)
    async with _client(db_session) as client:
        current = await client.get("/scoring-rubric")
        versions = await client.get("/scoring-rubric/versions")
    assert current.status_code == 200 and versions.status_code == 200
    assert current.json()["can_edit"] is (role in _ADMINS)


@pytest.mark.parametrize("role", _NO_MATRIX)
async def test_roles_without_matrix_read_cannot_read_the_rubric(db_session, role):
    await _act_as(db_session, role)
    async with _client(db_session) as client:
        assert (await client.get("/scoring-rubric")).status_code == 403
        assert (await client.get("/scoring-rubric/versions")).status_code == 403


@pytest.mark.parametrize("role", _NON_ADMIN_READERS + _NO_MATRIX)
async def test_only_admins_write_or_preview(db_session, role):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
    clear_current_principal_override()
    await _act_as(db_session, role)
    dims = _proposal(rubric, new_models={"weight": 20})
    async with _client(db_session) as client:
        put = await _put(client, rubric, dims)
        prev = await client.post("/scoring-rubric/preview", json={"dimensions": dims})
    assert put.status_code == 403
    assert prev.status_code == 403
    assert await _audit_count(db_session) == 0
    assert (await db_session.execute(select(func.max(RubricVersion.version)))).scalar_one() == 1


async def test_unauthenticated_is_401(db_session):
    async with _client(db_session) as client:
        assert (await client.get("/scoring-rubric")).status_code == 401
        assert (await client.put("/scoring-rubric", json={})).status_code == 401


@pytest.mark.parametrize("role", _ADMINS)
async def test_admin_write_is_audited_with_before_and_after(db_session, role):
    hub = await make_hub(db_session)
    await _scored(db_session, hub, "P", [5] + [3] * 12)
    user = await _act_as(db_session, role)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
        resp = await _put(
            client, rubric, _proposal(rubric, strategic_project={"weight": 100}), "why"
        )
    assert resp.status_code == 200, resp.text
    entry = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "scoring_rubric.update")
        )
    ).scalar_one()
    assert entry.actor_user_id == user.id
    assert (entry.entity_type, entry.entity_id, entry.hub_id) == ("ScoringRubric", "2", None)
    assert entry.before_state["version"] == 1 and entry.before_state["total_weight"] == 295
    assert entry.after_state["version"] == 2 and entry.after_state["total_weight"] == 370
    before_w = {d["key"]: d["weight"] for d in entry.before_state["dimensions"]}
    after_w = {d["key"]: d["weight"] for d in entry.after_state["dimensions"]}
    assert (before_w["strategic_project"], after_w["strategic_project"]) == (25, 100)
    assert entry.after_state["reason"] == "why"
    assert entry.after_state["recomputed_scores"] >= 1
    assert entry.after_state["score_band_changes"] >= 1  # P2 -> P1


# --- the score PUT on the new shape ---------------------------------------------------


async def test_score_put_shape_unknown_keys_null_and_partial(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        unknown = await client.put(f"/priorities/{project.id}", json={"scores": {"nope": 3}})
        assert unknown.status_code == 422 and unknown.json()["code"] == "UNKNOWN_DIMENSION_KEY"
        flat = await client.put(f"/priorities/{project.id}", json={"strategic_project": 3})
        assert flat.status_code == 422  # the pre-P26 flat body is gone (extra keys forbidden)
        for bad in (6, -1, "3", 2.5, True):
            r = await client.put(
                f"/priorities/{project.id}", json={"scores": {"strategic_project": bad}}
            )
            assert r.status_code == 422, bad
        # Partial: one key -> scored but incomplete (12 missing).
        part = await client.put(
            f"/priorities/{project.id}", json={"scores": {"strategic_project": 5}}
        )
        assert part.status_code == 200, part.text
        body = part.json()
        assert (body["weighted_score"], body["normalized_pct"], body["suggested_band"]) == (
            25.0,
            8,
            "P4",
        )
        assert body["missing_dimension_keys"] == list(INITIAL_KEYS[1:])
        assert body["rubric_version"] == 1
        full = await client.put(f"/priorities/{project.id}", json=score_body([3] * 13))
        assert full.json()["missing_dimension_keys"] == []
        assert full.json()["normalized_pct"] == 60
        # null clears one score; the rest stay.
        cleared = await client.put(
            f"/priorities/{project.id}", json={"scores": {"capex_investment": None}}
        )
        assert cleared.json()["missing_dimension_keys"] == ["capex_investment"]
        assert cleared.json()["weighted_score"] == 168.0  # 177 - 9
        # All null -> unscored again.
        none = await client.put(
            f"/priorities/{project.id}", json={"scores": dict.fromkeys(INITIAL_KEYS)}
        )
        assert none.json()["normalized_pct"] is None and none.json()["suggested_band"] is None
        row = (await client.get(f"/priorities/{project.id}")).json()
    assert row["has_score"] is False and row["missing_dimension_keys"] == []
    audit = (
        (
            await db_session.execute(
                select(AuditLogEntry)
                .where(AuditLogEntry.action.like("priority_score.%"))
                .order_by(AuditLogEntry.occurred_at)
            )
        )
        .scalars()
        .all()
    )
    assert audit[-1].after_state["scores"]["strategic_project"] is None
    assert audit[-1].after_state["rubric_version"] == 1


# --- every reader agrees after a rubric change -----------------------------------------


def _export_rows(content: bytes) -> tuple[list[str], dict[str, dict[str, str]]]:
    reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
    rows = list(reader)
    return list(reader.fieldnames or []), {r["project_name"]: r for r in rows}


async def test_all_readers_consistent_after_a_rubric_change(db_session):
    from tests.factories import make_schedule_run

    hub = await make_hub(db_session)
    await make_schedule_run(db_session, is_active=True)
    a = await _scored(db_session, hub, "Alpha", [5] + [3] * 12)
    b = await _scored(db_session, hub, "Beta", [2] * 13)
    await make_project(db_session, hub, name="Gamma")
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
        dims = _proposal(
            rubric, strategic_project={"weight": 100}, annual_volume={"active": False}
        ) + [{"label": "Carbon", "pillar": "Sustainability", "weight": 20}]
        assert (await _put(client, rubric, dims)).status_code == 200
        rows = await _rows(client)
        compare = (
            await client.get(
                "/priorities/compare", params=[("project_id", str(a.id)), ("project_id", str(b.id))]
            )
        ).json()["projects"]
        board = (await client.get("/priority-board")).json()
        ws = {
            name: (await client.get(f"/projects/{p.id}/workspace")).json()["priority_score"]
            for name, p in (("Alpha", a), ("Beta", b))
        }
        dist = (await client.get("/priorities/distribution")).json()
        summary = (await client.get("/priorities/summary")).json()
        export = await client.get("/exports/matrix", params={"format": "csv"})
        dims_table = (await client.get("/priorities/dimensions")).json()

    active_keys = [d["key"] for d in dims_table["dimensions"]]
    assert "annual_volume" not in active_keys and active_keys[-1] == "carbon"
    assert dims_table["total_weight"] == 295 - 25 + 100 - 15 + 20 == 375
    assert dims_table["rubric_version"] == 2
    cards = {c["name"]: c for col in board["columns"] for c in col["cards"]}
    for item in compare:
        name = item["project_name"]
        row = rows[name]
        for f in ("weighted_score", "normalized_pct", "suggested_band", "score_band"):
            assert item[f] == row[f], (name, f)
            assert ws[name][f] == row[f], (name, f)
        assert item["dimension_scores"] == row["dimension_scores"] == ws[name]["dimension_scores"]
        assert (
            item["missing_dimension_keys"]
            == row["missing_dimension_keys"]
            == ws[name]["missing_dimension_keys"]
            == ["carbon"]
        )
        assert item["rubric_version"] == row["rubric_version"] == ws[name]["rubric_version"] == 2
        assert [d["key"] for d in row["dimension_scores"]] == active_keys
        assert cards[name]["score"] == row["weighted_score"]
        assert cards[name]["score_band"] == row["score_band"]
    # Alpha: 100 + 3/5 x (370 - 100 - 15) = 100 + 153 = 253 / 375 = 67.47 -> 67.
    assert (rows["Alpha"]["weighted_score"], rows["Alpha"]["normalized_pct"]) == (253.0, 67)
    # Beta: 2/5 x (375 - 20) = 142 / 375 = 37.87 -> 38, P4.
    assert (rows["Beta"]["normalized_pct"], rows["Beta"]["score_band"]) == (38, "P4")
    # Distribution and summary count the same bands as the rows.
    bands = {b["band"]: b["count"] for b in dist["band_distribution"]}
    for band in ("P1", "P2", "P3", "P4"):
        n = sum(1 for r in rows.values() if r["suggested_band"] == band)
        assert bands[band] == n == summary["suggested_band_counts"].get(band, 0)
    assert bands["Unscored"] == 1 and summary["unscored_projects"] == 1
    # Export: one column per ACTIVE dimension, after has_score, display order.
    assert export.status_code == 200
    headers, exported = _export_rows(export.content)
    at = headers.index("has_score") + 1
    assert headers[at : at + len(active_keys)] == active_keys
    assert "annual_volume" not in headers
    assert exported["Alpha"]["strategic_project"] == "5"
    assert exported["Alpha"]["carbon"] == ""
    assert exported["Gamma"]["strategic_project"] == ""
    assert exported["Alpha"]["normalized_pct"] == "67"


async def test_scenario_apply_uses_the_rubric(db_session):
    hub = await make_hub(db_session)
    project = await _scored(db_session, hub, "S", [3] * 13)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
        dims = _proposal(rubric) + [{"label": "Carbon", "pillar": "Sustainability", "weight": 25}]
        assert (await _put(client, rubric, dims)).status_code == 200
        bad = await client.post(
            "/scenarios/apply",
            json={"priority_scores": [{"project_id": str(project.id), "scores": {"zzz": 1}}]},
        )
        assert bad.status_code in (400, 422), bad.text
        ok = await client.post(
            "/scenarios/apply",
            json={"priority_scores": [{"project_id": str(project.id), "scores": {"carbon": 5}}]},
        )
        assert ok.status_code == 201, ok.text
        row = (await client.get(f"/priorities/{project.id}")).json()
    # 177 + 25 = 202 / 320 = 63.13 -> 63.
    assert (row["weighted_score"], row["normalized_pct"], row["missing_dimension_keys"]) == (
        202.0,
        63,
        [],
    )


# --- the schedule is never touched ---------------------------------------------------


async def test_rubric_change_never_marks_stale_or_schedules(db_session):
    hub = await make_hub(db_session)
    project = await _scored(db_session, hub, "P", [5] + [3] * 12, priority=ProjectPriority.P2)
    await _act_as(db_session, RoleName.ADMIN)
    runs_before = (await db_session.execute(select(func.count(ScheduleRun.id)))).scalar_one()
    async with _client(db_session) as client:
        rubric = (await client.get("/scoring-rubric")).json()
        resp = await _put(client, rubric, _proposal(rubric, strategic_project={"weight": 100}))
        assert resp.status_code == 200
    await db_session.refresh(project)
    assert project.schedule_stale is False
    assert project.priority == ProjectPriority.P2  # committed priority untouched
    assert (
        await db_session.execute(select(func.count(ScheduleRun.id)))
    ).scalar_one() == runs_before


def test_scheduler_does_not_read_scores():
    """ADR 0037 §7: nothing under `backend/scheduling/` reads a score."""

    root = Path(__file__).resolve().parent.parent / "scheduling"
    for path in root.rglob("*.py"):
        text = path.read_text()
        for needle in (
            "priority_score",
            "PriorityScore",
            "weighted_score",
            "normalized_pct",
            "scoring_dimension",
            "rubric",
        ):
            assert needle not in text, f"{path.name} reads {needle}"


# --- migration losslessness (own container) ------------------------------------------

_OLD_WEIGHTS = (25, 25, 25, 25, 25, 25, 25, 25, 25, 15, 25, 15, 15)


def _old_formula(dims):
    """The pre-P26 formula exactly as the API computed it (float, round())."""

    weighted = sum(s * w / 5 for s, w in zip(dims, _OLD_WEIGHTS, strict=True))
    pct = round(weighted / 295 * 100)
    band = next(lbl for t, lbl in dc.PRIORITY_BAND_THRESHOLDS if pct >= t)
    return weighted, pct, band


def _seed_dims() -> list[list[int]]:
    """Every dimension set the client_2026 seed stores (synthetic, ADR 0035),
    plus all-0 / all-5 and a zero mix."""

    from seed import client_2026 as c26

    data = json.loads(
        (Path(__file__).resolve().parent.parent / "seed" / "client_2026_seed_data.json").read_text()
    )
    out = [
        c26.derive_dims(p["external_code"], p["priority"], p["marketing_priority"])
        for p in data["projects"]
    ]
    return out + [[0] * 13, [5] * 13, [5, 0, 3, 0, 1, 5, 0, 2, 4, 0, 5, 0, 3]]


def _dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def _q(url, sql, *args):
    conn = await asyncpg.connect(_dsn(url))
    try:
        return await conn.fetch(sql, *args)
    finally:
        await conn.close()


def test_migration_p26a_is_lossless_on_the_seeded_scores():
    dims_list = _seed_dims()
    assert len(dims_list) > 200
    cols = ", ".join(INITIAL_KEYS)
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "p24b_checkin_reset_escape"], url)
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
                for i, dims in enumerate(dims_list):
                    pid = uuid.uuid4()
                    await conn.execute(
                        "INSERT INTO projects (id, name, hub_id, status, frozen, delay_weeks, "
                        "carry_over) VALUES ($1, $2, $3, 'In Queue', false, 0, false)",
                        pid,
                        f"P{i:03d}",
                        hub_id,
                    )
                    ws, pct, band = _old_formula(dims)
                    placeholders = ", ".join(f"${n}" for n in range(3, 16))
                    await conn.execute(
                        f"INSERT INTO priority_scores (id, project_id, {cols}, hard_gates, "  # noqa: S608
                        f"weighted_score, normalized_pct, suggested_band) VALUES ($1, $2, "
                        f"{placeholders}, '{{}}', $16, $17, $18::project_priority)",
                        uuid.uuid4(),
                        pid,
                        *dims,
                        ws,
                        pct,
                        band,
                    )
            finally:
                await conn.close()

        asyncio.run(_load())
        before = {
            r["name"]: (float(r["weighted_score"]), r["normalized_pct"], r["band"])
            for r in asyncio.run(
                _q(
                    url,
                    "SELECT p.name, ps.weighted_score, ps.normalized_pct, "
                    "ps.suggested_band::text AS band FROM priority_scores ps "
                    "JOIN projects p ON p.id = ps.project_id",
                )
            )
        }
        band_counts_before = sorted(v[2] for v in before.values())

        r = run_alembic(["upgrade", "p26a_scoring_rubric_tables"], url)
        assert r.returncode == 0, r.stderr

        after = {
            r["name"]: (float(r["weighted_score"]), r["normalized_pct"], r["band"], r["rv"])
            for r in asyncio.run(
                _q(
                    url,
                    "SELECT p.name, ps.weighted_score, ps.normalized_pct, "
                    "ps.suggested_band::text AS band, ps.rubric_version AS rv "
                    "FROM priority_scores ps JOIN projects p ON p.id = ps.project_id",
                )
            )
        }
        assert {k: v[:3] for k, v in after.items()} == before
        assert {v[3] for v in after.values()} == {1}
        assert sorted(v[2] for v in after.values()) == band_counts_before

        # Every score copied; Σ points from the tables == the stored sum.
        sums = asyncio.run(
            _q(
                url,
                "SELECT p.name, sum(pds.score * sd.weight / 5.0) AS pts, count(*) AS n, "
                "count(pds.score) AS scored FROM priority_dimension_scores pds "
                "JOIN scoring_dimensions sd ON sd.id = pds.dimension_id "
                "JOIN priority_scores ps ON ps.id = pds.priority_score_id "
                "JOIN projects p ON p.id = ps.project_id GROUP BY p.name",
            )
        )
        assert len(sums) == len(dims_list)
        for row in sums:
            assert (row["n"], row["scored"]) == (13, 13)
            assert float(row["pts"]) == pytest.approx(before[row["name"]][0])
        pivot = asyncio.run(
            _q(
                url,
                "SELECT p.name, sd.key, pds.score FROM priority_dimension_scores pds "
                "JOIN scoring_dimensions sd ON sd.id = pds.dimension_id "
                "JOIN priority_scores ps ON ps.id = pds.priority_score_id "
                "JOIN projects p ON p.id = ps.project_id",
            )
        )
        by_name: dict[str, dict[str, int]] = {}
        for row in pivot:
            by_name.setdefault(row["name"], {})[row["key"]] = row["score"]
        for i, dims in enumerate(dims_list):
            assert [by_name[f"P{i:03d}"][k] for k in INITIAL_KEYS] == dims

        rubric = asyncio.run(
            _q(url, "SELECT key, weight, inverted, active, display_order FROM scoring_dimensions")
        )
        assert sorted((r["display_order"], r["key"], r["weight"]) for r in rubric) == [
            (i + 1, k, w)
            for i, (k, w) in enumerate(zip(INITIAL_KEYS, INITIAL_WEIGHTS, strict=True))
        ]
        version = asyncio.run(
            _q(url, "SELECT version, total_weight, dimensions FROM rubric_versions")
        )
        assert [(v["version"], v["total_weight"]) for v in version] == [(1, 295)]
        assert len(json.loads(version[0]["dimensions"])) == 13
        old_cols = asyncio.run(
            _q(
                url,
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'priority_scores' AND column_name = ANY($1::text[])",
                list(INITIAL_KEYS),
            )
        )
        assert old_cols == []  # dropped, not kept deprecated

        # Downgrade restores the 13 columns losslessly, then upgrade again.
        r = run_alembic(["downgrade", "p24b_checkin_reset_escape"], url)
        assert r.returncode == 0, r.stderr
        restored = asyncio.run(
            _q(
                url,
                f"SELECT p.name, {cols}, ps.weighted_score, ps.normalized_pct, "  # noqa: S608
                "ps.suggested_band::text AS band FROM priority_scores ps "
                "JOIN projects p ON p.id = ps.project_id",
            )
        )
        for row in restored:
            i = int(row["name"][1:])
            assert [row[k] for k in INITIAL_KEYS] == dims_list[i]
            assert (float(row["weighted_score"]), row["normalized_pct"], row["band"]) == before[
                row["name"]
            ]
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
