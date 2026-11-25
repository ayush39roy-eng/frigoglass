"""P33-T09: the category template timeline — `GET /workflow-settings`
(contract C1), `GET /workflow-settings/category-timelines` (C2) and `POST
/workflow-templates/timeline-preview` (D), through `scheduling.template_timeline`.

Acceptance: contract tests; with no overrides the preview equals C2; 403 for
non-editors; validation errors per contract. Every expected figure is
computed by `scheduling.template_timeline` (called, never re-derived here)
or written out by hand from DOMAIN_RULES §D.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from api.routers import workflow_templates as wt_router
from models.audit import AuditLogEntry
from models.enums import RoleName
from models.workflow import WorkflowLeadTime
from scheduling.template_timeline import TemplateTimeline, template_timeline
from services.rate_limit import TokenBucketLimiter
from services.workflow_previews import load_workflow_in_force
from tests.auth_helpers import clear_current_principal_override
from tests.p12_helpers import act_as, client_for
from tests.p62_audit import NOT_MIGRATION_AUDIT
from tests.p62_audit import P71A_TEMPLATE_VERSION as V0  # noqa: N814

PREVIEW = "/workflow-templates/timeline-preview"
TIMELINES = "/workflow-settings/category-timelines"


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    wt_router.TIMELINE_PREVIEW_RATE_LIMIT.reset()
    yield
    wt_router.TIMELINE_PREVIEW_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _preview(client: Any, body: dict[str, Any]) -> Any:
    return await client.post(PREVIEW, json=body)


async def _expected(
    db: Any, workflow_id: str, category: str, overrides: dict[str, tuple[int, int]]
) -> TemplateTimeline:
    """`scheduling.template_timeline` on the seeded template with overrides
    `{step: (weeks, gap)}`."""

    wf = await load_workflow_in_force(db, workflow_id)
    assert wf is not None
    rows = (
        await db.execute(
            select(WorkflowLeadTime).where(
                WorkflowLeadTime.workflow_id == workflow_id, WorkflowLeadTime.category == category
            )
        )
    ).scalars()
    lengths = {r.step_id: r.weeks for r in rows}
    gaps = {sid: 0 for sid in lengths}
    for sid, (w, g) in overrides.items():
        lengths[sid], gaps[sid] = w, g
    return template_timeline(workflow=wf.workflow, lengths=lengths, gaps=gaps)


# --- C1 / C2 ---------------------------------------------------------------------------------


async def test_category_timelines_carry_the_c2_fields_and_the_note(
    db_session: AsyncSession,
) -> None:
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        pdd = (await client.get(TIMELINES, params={"workflow": "PDD"})).json()
        oem = (await client.get(TIMELINES, params={"workflow": "OEM"})).json()
    assert [(c["category"], c["workflow_id"], c["rank"], c["template_version"], c["label"])
            for c in pdd + oem] == [
        # P62: migration p71a's template change put A+ / A / B / C at V0.
        ("A+", "PDD", 1, V0, "A+"), ("A", "PDD", 2, V0, "A"), ("B", "PDD", 3, V0, "B"),
        ("C", "PDD", 4, V0, "C"), ("A-OEM", "OEM", 5, 1, "A-OEM"), ("B-OEM", "OEM", 6, 1, "B-OEM"),
        ("C-OEM", "OEM", 7, 1, "C-OEM"),
    ]  # fmt: skip
    for c in pdd + oem:
        assert "Real projects also wait for engineers and chambers" in c["note"]
        expected = await _expected(db_session, c["workflow_id"], c["category"], {})
        assert c["total_weeks"] == expected.total_weeks
        for s, e in zip(c["steps"], expected.steps, strict=True):
            assert (s["code"], s["start_week"], s["duration_weeks"]) == (
                e.step_id,
                e.start_week,
                e.duration_weeks,
            )
            assert (s["gap_weeks"], s["effective_gap_weeks"], s["flags"]) == (0, 0, [])
    a_steps = {s["code"]: s for s in pdd[1]["steps"]}
    assert a_steps["PDD-A"]["predecessor_ids"] == []
    assert a_steps["PDD-E"]["predecessor_ids"] == ["PDD-D"]


async def test_timelines_follow_a_saved_gap(db_session: AsyncSession) -> None:
    """A saved wait on B/H (3 weeks) shows in C2 (requested 3, effective 3)
    and every later step moves by 3 (DOMAIN_RULES §D: a wait counts from the
    release and books nothing)."""

    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        before = (await client.get(TIMELINES)).json()
        await db_session.execute(
            update(WorkflowLeadTime)
            .where(
                WorkflowLeadTime.workflow_id == "PDD",
                WorkflowLeadTime.category == "B",
                WorkflowLeadTime.step_id == "PDD-H",
            )
            .values(gap_weeks=3)
        )
        await db_session.flush()
        after = (await client.get(TIMELINES)).json()
    b0 = {s["code"]: s for s in before[2]["steps"]}
    b1 = {s["code"]: s for s in after[2]["steps"]}
    assert (b1["PDD-H"]["gap_weeks"], b1["PDD-H"]["effective_gap_weeks"]) == (3, 3)
    assert b1["PDD-H"]["start_week"] == b0["PDD-H"]["start_week"] + 3
    assert b1["PDD-N"]["start_week"] == b0["PDD-N"]["start_week"] + 3
    assert after[2]["total_weeks"] == before[2]["total_weeks"] + 3
    assert b1["PDD-H"]["duration_weeks"] == b0["PDD-H"]["duration_weeks"]


# --- D: timeline preview ---------------------------------------------------------------------


async def test_preview_without_overrides_equals_c2_for_every_category(
    db_session: AsyncSession,
) -> None:
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        for workflow in ("PDD", "OEM"):
            served = (await client.get(TIMELINES, params={"workflow": workflow})).json()
            for c in served:
                resp = await _preview(
                    client, {"workflow_id": workflow, "category": c["category"], "steps": []}
                )
                assert resp.status_code == 200, resp.text
                body = resp.json()
                assert body.pop("changed_step_ids") == []
                assert body == c


async def test_preview_with_overrides_is_template_timeline(db_session: AsyncSession) -> None:
    """Contract D's example (A, PDD-E 7 weeks, gap −2): the response is
    `scheduling.template_timeline` with the override laid over the saved
    template; only E changed; nothing is written."""

    await act_as(db_session, RoleName.ADMIN)
    body = {
        "workflow_id": "PDD",
        "category": "A",
        "steps": [{"step_id": "PDD-E", "weeks": 7, "gap_weeks": -2}],
    }
    async with client_for(db_session) as client:
        resp = await _preview(client, body)
        after = (await client.get(TIMELINES)).json()
    assert resp.status_code == 200, resp.text
    out = resp.json()
    expected = await _expected(db_session, "PDD", "A", {"PDD-E": (7, -2)})
    assert out["changed_step_ids"] == ["PDD-E"]
    assert out["total_weeks"] == expected.total_weeks
    for s, e in zip(out["steps"], expected.steps, strict=True):
        assert (s["start_week"], s["duration_weeks"], s["gap_weeks"], s["effective_gap_weeks"]) == (
            e.start_week,
            e.duration_weeks,
            e.requested_gap_weeks,
            e.effective_gap_weeks,
        )
        assert set(s["flags"]) == set(e.flags)
    e_step = next(s for s in out["steps"] if s["code"] == "PDD-E")
    # D (design, 1 week) precedes E (design): the overlap is serialised by the
    # one-leader rule and clamped at D's start.
    assert "same_leader_serialised" in e_step["flags"]
    # Stateless: the saved template is unchanged, no audit row.
    a_saved = {s["code"]: s for s in after[1]["steps"]}
    assert (a_saved["PDD-E"]["duration_weeks"], a_saved["PDD-E"]["gap_weeks"]) == (6, 0)
    assert (
        await db_session.execute(select(AuditLogEntry).where(NOT_MIGRATION_AUDIT))
    ).scalars().all() == []


async def test_preview_flags_a_gap_on_a_zero_length_step_and_lab_overlap(
    db_session: AsyncSession,
) -> None:
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        zero = (
            await _preview(
                client,
                {
                    "workflow_id": "PDD",
                    "category": "B",
                    "steps": [{"step_id": "PDD-B", "gap_weeks": 2}],
                },
            )
        ).json()
        lab = (
            await _preview(
                client,
                {
                    "workflow_id": "PDD",
                    "category": "A",
                    "steps": [{"step_id": "PDD-F", "gap_weeks": -2}],
                },
            )
        ).json()
    b_step = next(s for s in zero["steps"] if s["code"] == "PDD-B")
    assert b_step["flags"] == ["gap_ignored_zero_length"]
    assert (b_step["gap_weeks"], b_step["effective_gap_weeks"], b_step["duration_weeks"]) == (
        2,
        0,
        0,
    )
    f_step = next(s for s in lab["steps"] if s["code"] == "PDD-F")
    e_step = next(s for s in lab["steps"] if s["code"] == "PDD-E")
    # A lab step overlapping a design step runs in parallel (no leader rule).
    assert f_step["effective_gap_weeks"] == -2
    assert f_step["start_week"] == e_step["start_week"] + e_step["duration_weeks"] - 2
    assert f_step["flags"] == []
    assert zero["changed_step_ids"] == ["PDD-B"] and lab["changed_step_ids"] == ["PDD-F"]


async def test_preview_override_equal_to_saved_is_not_changed(db_session: AsyncSession) -> None:
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await _preview(
            client,
            {"workflow_id": "PDD", "category": "A", "steps": [{"step_id": "PDD-E", "weeks": 6}]},
        )
    assert resp.status_code == 200 and resp.json()["changed_step_ids"] == []


@pytest.mark.parametrize(
    "role,code",
    [
        (RoleName.ADMIN, 200),
        (RoleName.SUPER_ADMIN, 200),
        (RoleName.PORTFOLIO_MANAGER, 403),
        (RoleName.HUB_PLANNER, 403),
        (RoleName.ENGINEER, 403),
        (RoleName.EXECUTIVE_VIEWER, 403),
        (RoleName.AUDITOR, 403),
    ],
)
async def test_preview_and_timelines_rbac(
    db_session: AsyncSession, role: RoleName, code: Any
) -> None:
    await act_as(db_session, role)
    async with client_for(db_session) as client:
        preview = await _preview(client, {"workflow_id": "PDD", "category": "A", "steps": []})
        timelines = await client.get(TIMELINES)
        settings = await client.get("/workflow-settings")
    assert preview.status_code == code, preview.text
    assert timelines.status_code == code
    assert settings.status_code == code


async def test_preview_requires_a_session(db_session: AsyncSession) -> None:
    clear_current_principal_override()
    async with client_for(db_session) as client:
        resp = await _preview(client, {"workflow_id": "PDD", "category": "A", "steps": []})
    assert resp.status_code == 401


@pytest.mark.parametrize(
    "body,status,code",
    [
        # Ranges and strictness (schema 422).
        ({"steps": [{"step_id": "PDD-E", "weeks": 105}]}, 422, None),
        ({"steps": [{"step_id": "PDD-E", "weeks": -1}]}, 422, None),
        ({"steps": [{"step_id": "PDD-E", "gap_weeks": 105}]}, 422, None),
        ({"steps": [{"step_id": "PDD-E", "gap_weeks": -105}]}, 422, None),
        ({"steps": [{"step_id": "PDD-E", "weeks": "7"}]}, 422, None),
        ({"steps": [{"step_id": "PDD-E", "weeks": True}]}, 422, None),
        ({"steps": [{"step_id": "PDD-E"}]}, 422, None),
        ({"steps": [], "extra": 1}, 422, None),
        # Contract codes.
        ({"steps": [{"step_id": "PDD-A", "gap_weeks": 1}]}, 422, "FIRST_STEP_GAP"),
        ({"steps": [{"step_id": "PDD-Z", "weeks": 1}]}, 422, "BAD_STEP"),
        ({"steps": [{"step_id": "OEM-E", "weeks": 1}]}, 422, "BAD_STEP"),
        (
            {"steps": [{"step_id": "PDD-E", "weeks": 1}, {"step_id": "PDD-E", "weeks": 2}]},
            422,
            "BAD_STEP",
        ),
    ],
)
async def test_preview_validation(
    db_session: AsyncSession, body: dict[str, Any], status: int, code: Any
) -> None:
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await _preview(client, {"workflow_id": "PDD", "category": "A", **body})
    assert resp.status_code == status, resp.text
    assert resp.json().get("code") == code


async def test_preview_first_step_gap_zero_is_fine(db_session: AsyncSession) -> None:
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await _preview(
            client,
            {
                "workflow_id": "PDD",
                "category": "A",
                "steps": [{"step_id": "PDD-A", "weeks": 3, "gap_weeks": 0}],
            },
        )
    assert resp.status_code == 200, resp.text


@pytest.mark.parametrize(
    "workflow,category,loc",
    [
        ("PDD", "Z", "category"),  # unknown category
        ("PDD", "A-OEM", "category"),  # a category of the other workflow
        ("OEM", "A", "category"),
        ("XYZ", "A", "workflow_id"),  # unknown workflow
    ],
)
async def test_preview_rejects_unknown_or_cross_workflow_category(
    db_session: AsyncSession, workflow: str, category: str, loc: str
) -> None:
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await _preview(client, {"workflow_id": workflow, "category": category, "steps": []})
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail[0]["type"] == "enum" and detail[0]["loc"] == ["body", loc]


async def test_preview_is_rate_limited(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        wt_router,
        "TIMELINE_PREVIEW_RATE_LIMIT",
        TokenBucketLimiter(capacity=2, refill_per_second=1e-6),
    )
    await act_as(db_session, RoleName.ADMIN)
    body = {"workflow_id": "PDD", "category": "A", "steps": []}
    async with client_for(db_session) as client:
        codes = [(await _preview(client, body)).status_code for _ in range(3)]
        last = await _preview(client, body)
    assert codes == [200, 200, 429]
    assert last.json()["code"] == "RATE_LIMITED" and "Retry-After" in last.headers
