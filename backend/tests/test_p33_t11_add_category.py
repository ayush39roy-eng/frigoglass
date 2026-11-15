"""P33-T11: `POST /workflow-templates/categories` (contract B2; ADR 0047 §2
as amended; DOMAIN_RULES "Category templates" §E), and the What-if chat
prompt naming categories from the table (T07 note).

Acceptance: insert between B and C; first place; an OEM-workflow category
(blanket `OEM` engineers stay eligible); duplicate / `OEM` / bad source /
cross-workflow source rejected; nothing stale, no run; a new project
registered in it copies the source's template and splits its figure over the
copied weights.
"""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from api.routers import workflow_templates as wt_router
from models.audit import AuditLogEntry
from models.category import Category
from models.engineer import Engineer
from models.enums import HubName, LabRegion, ProjectStatus, RoleName
from models.project import Project
from models.schedule import ScheduleRun
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime
from scheduling import default_categories, run_greedy_sgs
from scheduling.types import CategoryInput
from services import whatif_chat
from services.rate_limit import TokenBucketLimiter
from services.schedule_persistence import build_schedule_input_from_db
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, registration_body
from tests.p12_helpers import act_as, client_for, stepped_project

ADD = "/workflow-templates/categories"
SEVEN = ["A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM"]


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    wt_router.ADD_CATEGORY_RATE_LIMIT.reset()
    yield
    wt_router.ADD_CATEGORY_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _body(**kw: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "code": "B2", "label": "B2 (light refresh)", "workflow_id": "PDD",
        "copy_from": "B", "insert_after": "B",
    }  # fmt: skip
    body.update(kw)
    return body


async def _add(db: AsyncSession, body: dict[str, Any], role: RoleName = RoleName.ADMIN) -> Any:
    await act_as(db, role)
    async with client_for(db) as client:
        return await client.post(ADD, json=body)


async def _template(db: AsyncSession, category: str) -> dict[str, tuple[int, int, int]]:
    rows = (
        await db.execute(
            select(WorkflowLeadTime)
            .execution_options(populate_existing=True)
            .where(WorkflowLeadTime.category == category)
        )
    ).scalars()
    return {r.step_id: (r.weeks, r.gap_weeks, r.effort_weight_weeks) for r in rows}


async def _ranks(db: AsyncSession) -> list[tuple[str, int]]:
    rows = await db.execute(
        select(Category.code, Category.rank)
        .order_by(Category.rank)
        .execution_options(populate_existing=True)
    )
    return [(c, r) for c, r in rows.all()]


async def _world(db: AsyncSession) -> SimpleNamespace:
    greece = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    b_eng = await make_engineer(db, greece, name="B engineer", allowed_categories=["A", "B"])
    a_eng = await make_engineer(db, greece, name="A engineer", allowed_categories=["A"])
    project = await stepped_project(db, greece, name="Existing B", leader=b_eng, category="B")
    return SimpleNamespace(greece=greece, b_eng=b_eng, a_eng=a_eng, project=project)


async def test_insert_between_b_and_c_copies_template_and_eligibility(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    # The source's template as it is now (a saved gap and a changed length;
    # the weights stay the seed's).
    await db_session.execute(
        update(WorkflowLeadTime)
        .where(WorkflowLeadTime.category == "B", WorkflowLeadTime.step_id == "PDD-E")
        .values(weeks=5, gap_weeks=1)
    )
    await db_session.flush()
    source = await _template(db_session, "B")
    stale_before = w.project.schedule_stale

    resp = await _add(db_session, _body())
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["category"] == {"code": "B2", "label": "B2 (light refresh)",
                                "workflow_id": "PDD", "rank": 4}  # fmt: skip
    assert [c["code"] for c in body["categories"]] == ["A+", "A", "B", "B2", "C", "A-OEM",
                                                      "B-OEM", "C-OEM"]  # fmt: skip
    assert [c["rank"] for c in body["categories"]] == list(range(1, 9))
    assert body["template_rows"] == 14 and body["engineers_extended"] == 1

    assert await _ranks(db_session) == [(c["code"], c["rank"]) for c in body["categories"]]
    assert await _template(db_session, "B2") == source
    assert source["PDD-E"] == (5, 1, 4)
    new = (await db_session.execute(select(Category).where(Category.code == "B2"))).scalar_one()
    assert (new.template_version, new.copied_from_code, new.active) == (1, "B", True)
    assert new.created_by is not None

    engineers = {
        e.name: e.allowed_categories
        for e in (
            await db_session.execute(select(Engineer).execution_options(populate_existing=True))
        ).scalars()
    }
    assert engineers == {"B engineer": ["A", "B", "B2"], "A engineer": ["A"]}

    # Nothing stale, no run.
    await db_session.refresh(w.project)
    assert w.project.schedule_stale == stale_before
    assert (await db_session.execute(select(ScheduleRun))).scalars().all() == []

    created = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "category.created")
        )
    ).scalar_one()
    assert created.entity_id == "B2" and created.after_state is not None
    assert created.after_state["category"]["copied_from_code"] == "B"
    assert created.after_state["ranks"][:5] == ["A+", "A", "B", "B2", "C"]
    assert len(created.after_state["template_rows"]) == 14
    (extended,) = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "engineer.allowed_categories_extended"
            )
        )
    ).scalars()
    assert extended.entity_id == str(w.b_eng.id)
    assert extended.before_state == {"allowed_categories": ["A", "B"]}
    assert extended.after_state == {"allowed_categories": ["A", "B", "B2"], "category": "B2"}
    # No engineer name in the audit rows (lists only).
    assert "B engineer" not in str(extended.after_state) + str(created.after_state)

    # The reference list (B1) and the timelines serve it in rank order.
    async with client_for(db_session) as client:
        ref = (await client.get("/reference/categories")).json()
        timelines = (await client.get("/workflow-settings/category-timelines")).json()
    assert [c["code"] for c in ref][:5] == ["A+", "A", "B", "B2", "C"]
    assert [c["category"] for c in timelines] == ["A+", "A", "B", "B2", "C"]


async def test_first_place(db_session: AsyncSession) -> None:
    resp = await _add(db_session, _body(code="Z0", label=None, insert_after=None))
    assert resp.status_code == 201, resp.text
    assert resp.json()["category"] == {"code": "Z0", "label": "Z0", "workflow_id": "PDD",
                                       "rank": 1}  # fmt: skip
    assert await _ranks(db_session) == [("Z0", 1)] + [(c, i) for i, c in enumerate(SEVEN, 2)]


async def test_trimmed_code_and_insert_after_another_workflow(db_session: AsyncSession) -> None:
    """`insert_after` may name any workflow's code (contract B2): a PDD
    category placed after C-OEM is last."""

    resp = await _add(db_session, _body(code="  D ", insert_after="C-OEM", label="  "))
    assert resp.status_code == 201, resp.text
    assert resp.json()["category"] == {"code": "D", "label": "D", "workflow_id": "PDD",
                                       "rank": 8}  # fmt: skip


async def test_oem_workflow_category_and_blanket_oem_engineers(db_session: AsyncSession) -> None:
    greece = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    oem_hub = await make_hub(
        db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True
    )
    blanket = await make_engineer(db_session, oem_hub, name="Blanket", allowed_categories=["OEM"])
    b_oem = await make_engineer(db_session, oem_hub, name="B-OEM only",
                                allowed_categories=["B-OEM"])  # fmt: skip
    assert greece.id
    resp = await _add(
        db_session,
        _body(code="D-OEM", label=None, workflow_id="OEM", copy_from="B-OEM",
              insert_after="C-OEM"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    assert resp.json()["engineers_extended"] == 1
    await db_session.refresh(blanket)
    await db_session.refresh(b_oem)
    assert blanket.allowed_categories == ["OEM"]  # the blanket already covers it
    assert b_oem.allowed_categories == ["B-OEM", "D-OEM"]
    assert await _template(db_session, "D-OEM") == await _template(db_session, "B-OEM")

    # A project of the new OEM category, led by the blanket engineer: the
    # scheduler (CAT_NOT_ALLOWED reads the category's workflow) accepts it.
    led_by_blanket = await stepped_project(
        db_session, oem_hub, name="New OEM", leader=blanket, category="D-OEM",
        status=ProjectStatus.IN_QUEUE,
    )  # fmt: skip
    led_by_other = await stepped_project(
        db_session, oem_hub, name="New OEM 2", leader=b_oem, category="D-OEM",
        status=ProjectStatus.IN_QUEUE,
    )  # fmt: skip
    # Control: a leader eligible for another category only is flagged.
    a_only = await make_engineer(db_session, oem_hub, name="A only", allowed_categories=["A"])
    led_by_a_only = await stepped_project(
        db_session, oem_hub, name="New OEM 3", leader=a_only, category="D-OEM",
        status=ProjectStatus.IN_QUEUE,
    )  # fmt: skip
    schedule_input = await build_schedule_input_from_db(db_session)
    assert CategoryInput(code="D-OEM", workflow_id="OEM", rank=8) in schedule_input.categories
    outcomes = {o.project_id: o for o in run_greedy_sgs(schedule_input).project_outcomes}
    assert outcomes[str(led_by_blanket.id)].cat_not_allowed is False
    assert outcomes[str(led_by_other.id)].cat_not_allowed is False
    assert outcomes[str(led_by_a_only.id)].cat_not_allowed is True


async def test_new_project_copies_source_template_and_splits_over_copied_weights(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    # Source B's lengths changed (E 4 -> 5, K 2 -> 6) before the copy; its
    # weights stay A1 D1 E4 J1 K2 M1.
    for step_id, weeks in (("PDD-E", 5), ("PDD-K", 6)):
        await db_session.execute(
            update(WorkflowLeadTime)
            .where(WorkflowLeadTime.category == "B", WorkflowLeadTime.step_id == step_id)
            .values(weeks=weeks)
        )
    await db_session.flush()
    assert (await _add(db_session, _body())).status_code == 201
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/projects",
            json=registration_body(w.greece, w.b_eng, name="In B2", category="B2",
                                   design_effort_weeks=4),
        )  # fmt: skip
    assert resp.status_code == 201, resp.text
    project_id = resp.json()["id"]
    rows = {
        r.step_template_id: r
        for r in (
            await db_session.execute(
                select(ProjectWorkflowStep)
                .execution_options(populate_existing=True)
                .where(ProjectWorkflowStep.project_id == project_id)
            )
        ).scalars()
    }
    copied = await _template(db_session, "B2")
    assert {s: (r.plan_weeks, r.plan_gap_weeks) for s, r in rows.items()} == {
        s: (weeks, gap) for s, (weeks, gap, _) in copied.items()
    }
    assert rows["PDD-E"].plan_weeks == 5 and rows["PDD-K"].plan_weeks == 6
    # Figure 4 over the copied weights (A1 D1 E4 J1 K2 M1): A1 E2 K1, not
    # over the edited lengths.
    effort = {s: r.effort_weeks for s, r in rows.items() if r.effort_weeks}
    assert effort == {"PDD-A": 1, "PDD-E": 2, "PDD-K": 1}
    project = await db_session.get(Project, project_id)
    assert project is not None and project.category == "B2"


@pytest.mark.parametrize(
    "overrides,status,code",
    [
        ({"code": "b"}, 409, "CATEGORY_EXISTS"),
        ({"code": " B "}, 409, "CATEGORY_EXISTS"),
        ({"code": "OEM"}, 422, "BAD_CATEGORY_CODE"),
        ({"code": "oem"}, 422, "BAD_CATEGORY_CODE"),
        ({"code": "B_2"}, 422, "BAD_CATEGORY_CODE"),
        ({"code": "B2/x"}, 422, "BAD_CATEGORY_CODE"),
        ({"code": "X" * 17}, 422, "BAD_CATEGORY_CODE"),
        ({"code": "   "}, 422, "BAD_CATEGORY_CODE"),
        ({"code": ""}, 422, "BAD_CATEGORY_CODE"),
        ({"copy_from": "ZZ"}, 422, "BAD_COPY_SOURCE"),
        ({"copy_from": "B-OEM"}, 422, "BAD_COPY_SOURCE"),  # cross-workflow source
        ({"workflow_id": "OEM"}, 422, "BAD_COPY_SOURCE"),  # B is not an OEM category
        ({"workflow_id": "XYZ"}, 422, "BAD_COPY_SOURCE"),
        ({"insert_after": "ZZ"}, 422, "BAD_POSITION"),
        ({"label": "L" * 61}, 422, None),
        ({"extra": 1}, 422, None),
        ({"code": 7}, 422, None),
    ],
)
async def test_rejections(
    db_session: AsyncSession, overrides: dict[str, Any], status: int, code: Any
) -> None:
    resp = await _add(db_session, _body(**overrides))
    assert resp.status_code == status, resp.text
    assert resp.json().get("code") == code
    assert [c for c, _ in await _ranks(db_session)] == SEVEN


async def test_insert_after_is_required(db_session: AsyncSession) -> None:
    body = _body()
    del body["insert_after"]
    assert (await _add(db_session, body)).status_code == 422


@pytest.mark.parametrize(
    "role,code",
    [
        (RoleName.ADMIN, 201),
        (RoleName.SUPER_ADMIN, 201),
        (RoleName.PORTFOLIO_MANAGER, 403),
        (RoleName.HUB_PLANNER, 403),
        (RoleName.ENGINEER, 403),
        (RoleName.EXECUTIVE_VIEWER, 403),
        (RoleName.AUDITOR, 403),
    ],
)
async def test_rbac(db_session: AsyncSession, role: RoleName, code: Any) -> None:
    resp = await _add(db_session, _body(), role)
    assert resp.status_code == code, resp.text


async def test_rate_limited(db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        wt_router, "ADD_CATEGORY_RATE_LIMIT", TokenBucketLimiter(capacity=1, refill_per_second=1e-6)
    )
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        first = await client.post(ADD, json=_body())
        second = await client.post(ADD, json=_body(code="B3"))
    assert first.status_code == 201
    assert second.status_code == 429 and second.json()["code"] == "RATE_LIMITED"


# --- What-if chat prompt reads the table (T07 note) ------------------------------------------


def _ctx(categories: tuple[CategoryInput, ...]) -> Any:
    return SimpleNamespace(
        baseline=SimpleNamespace(schedule=SimpleNamespace(categories=categories)),
        scope=SimpleNamespace(hubs=frozenset({"R&D-Greece"}), lab_regions=frozenset({"Greece"})),
    )


def test_whatif_prompt_names_the_default_categories_as_before() -> None:
    prompt = whatif_chat._system_prompt(_ctx(default_categories()))
    assert (
        "Categories: A+, A, B, C for every hub except OEM-HCK and OEM-Seitek, which use A-OEM, "
        "B-OEM, C-OEM." in prompt.replace("\n", " ").replace("  ", " ")
    )


def test_whatif_prompt_names_an_added_category_in_rank_order() -> None:
    cats = (
        *[c if c.rank <= 3 else CategoryInput(c.code, c.workflow_id, c.rank + 1)
          for c in default_categories()],
        CategoryInput(code="B2", workflow_id="PDD", rank=4),
    )  # fmt: skip
    prompt = whatif_chat._system_prompt(_ctx(cats)).replace("\n", " ")
    assert "Categories: A+, A, B, B2, C for every" in prompt
