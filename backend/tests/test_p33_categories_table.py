"""P33-T07 (ADR 0047, DOMAIN_RULES "Category templates" §E, contract P33 B1/B3/F1/F4):
the `categories` table and everything that now reads it.

- The table is seeded with the seven codes at ranks 1..7; the FK, the rewritten
  `trg_projects_category_matches_hub` (workflow comparison) and the new
  `trg_engineers_allowed_categories_known` trigger hold.
- `GET /reference/categories` serves objects in rank order (B1).
- Every category input validates against the table (B3): unknown codes are
  the enum-shaped 422, the hub rule reads `categories.workflow_id`.
- The input builder passes `categories` from the table; the snapshot and the
  priority-preview token omit the default list and the P33 timing defaults
  (R33-7, P33-T05 A3); a non-default list reaches both.

A category added here (`B2`, PDD, between B and C) mimics what P33-T11 will
write; every test runs in the shared container's rolled-back savepoint.
"""

from __future__ import annotations

import dataclasses
import uuid
from collections.abc import AsyncIterator, Iterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from models.category import Category
from models.enums import HubName, LabRegion, RoleName
from models.user import User
from models.workflow import WorkflowLeadTime
from scheduling import (
    CategoryInput,
    ProjectInput,
    ScheduleInput,
    StepTimingInput,
    canonical_categories,
    canonical_schedule_input_asdict,
    default_categories,
)
from services import priority_preview
from services.categories import default_catalog, load_catalog
from services.schedule_persistence import (
    build_schedule_input_from_db,
    build_workflow_snapshot_from_input,
)
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_project, make_user, registration_body

SEED = ("A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM")


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session: AsyncSession) -> AsyncClient:
    async def _override_get_db() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session: AsyncSession, *roles: RoleName) -> User:
    user = await make_user(db_session, *roles, hub_scope_all=True)
    override_current_principal(make_principal(*roles, user_id=user.id, hub_scope_all=True))
    return user


async def _add_category(
    db_session: AsyncSession, code: str, workflow_id: str, *, after_rank: int, copy_from: str
) -> None:
    """What P33-T11 will do: make room after `after_rank`, insert, copy the
    source's template rows."""

    await db_session.execute(
        update(Category).where(Category.rank > after_rank).values(rank=Category.rank + 1)
    )
    db_session.add(Category(code=code, label=code, workflow_id=workflow_id, rank=after_rank + 1))
    await db_session.flush()
    rows = (
        await db_session.execute(
            select(WorkflowLeadTime).where(WorkflowLeadTime.category == copy_from)
        )
    ).scalars()
    for r in list(rows):
        db_session.add(
            WorkflowLeadTime(
                workflow_id=r.workflow_id, category=code, step_id=r.step_id, weeks=r.weeks
            )
        )
    await db_session.flush()


def _constraint(exc: IntegrityError) -> str | None:
    """The constraint name Postgres reported (the triggers set it)."""
    name = getattr(getattr(exc.orig, "__cause__", None), "constraint_name", None)
    return str(name) if name is not None else None


# --- table, FK and triggers -----------------------------------------------------------------


async def test_seeded_table_matches_the_seed_default(db_session: AsyncSession) -> None:
    rows = (await db_session.execute(select(Category).order_by(Category.rank))).scalars().all()
    assert [(r.code, r.workflow_id, r.rank, r.label) for r in rows] == [
        (c, "OEM" if c.endswith("-OEM") else "PDD", i, c) for i, c in enumerate(SEED, start=1)
    ]
    assert all(r.template_version == 1 and r.active for r in rows)
    catalog = await load_catalog(db_session)
    assert catalog == default_catalog()
    assert catalog.schedule_categories() == default_categories()


async def test_category_columns_are_text(db_session: AsyncSession) -> None:
    types: dict[str, str] = dict(
        (
            await db_session.execute(
                text(
                    "SELECT table_name || '.' || column_name, data_type FROM "
                    "information_schema.columns WHERE (table_name, column_name) IN "
                    "(('projects', 'category'), ('workflow_lead_times', 'category'), "
                    "('engineers', 'allowed_categories'))"
                )
            )
        ).all()
    )
    assert types == {
        "projects.category": "text",
        "workflow_lead_times.category": "text",
        "engineers.allowed_categories": "ARRAY",
    }
    enums: int = (
        await db_session.execute(
            text(
                "SELECT count(*) FROM pg_type WHERE typname IN "
                "('project_category', 'engineer_allowed_category')"
            )
        )
    ).scalar_one()
    assert enums == 0


async def test_unknown_project_category_violates_the_fk(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    with pytest.raises(IntegrityError, match="fk_projects_category_categories"):
        async with db_session.begin_nested():
            await make_project(db_session, hub, category="ZZ")


async def test_hub_trigger_compares_workflows(db_session: AsyncSession) -> None:
    pdd = await make_hub(db_session)
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    await _add_category(db_session, "B2", "PDD", after_rank=3, copy_from="B")
    await _add_category(db_session, "X-OEM", "OEM", after_rank=8, copy_from="B-OEM")
    # Seeded behaviour is unchanged.
    await make_project(db_session, pdd, category="C")
    await make_project(db_session, oem, category="C-OEM")
    # A new category follows its workflow, not its spelling.
    await make_project(db_session, pdd, category="B2")
    await make_project(db_session, oem, category="X-OEM")
    for hub, code in ((oem, "B2"), (pdd, "X-OEM"), (oem, "A"), (pdd, "A-OEM")):
        with pytest.raises(IntegrityError) as info:
            async with db_session.begin_nested():
                await make_project(db_session, hub, category=code)
        assert _constraint(info.value) == "ck_projects_category_matches_hub", code


async def test_engineer_trigger_accepts_codes_and_oem_only(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    await _add_category(db_session, "B2", "PDD", after_rank=3, copy_from="B")
    eng = await make_engineer(db_session, hub, allowed_categories=["B2", "OEM", "A-OEM"])
    assert eng.allowed_categories == ["B2", "OEM", "A-OEM"]
    for bad in (["ZZ"], ["A", "oem"], ["A", None]):
        with pytest.raises(IntegrityError) as info:
            async with db_session.begin_nested():
                await make_engineer(db_session, hub, allowed_categories=bad)
        assert _constraint(info.value) == "ck_engineers_allowed_categories_known", bad


async def test_code_format_and_case_insensitive_uniqueness(db_session: AsyncSession) -> None:
    for code, rank in (("b", 8), ("OEM", 8), ("oem", 8), ("bad/code", 8), ("x" * 17, 8)):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                db_session.add(Category(code=code, label="x", workflow_id="PDD", rank=rank))
                await db_session.flush()
    with pytest.raises(IntegrityError, match="uq_categories_rank"):
        async with db_session.begin_nested():
            db_session.add(Category(code="Z", label="Z", workflow_id="PDD", rank=3))
            await db_session.flush()


# --- B1: GET /reference/categories ------------------------------------------------------------


async def test_reference_categories_serve_a_new_category_at_its_rank(
    db_session: AsyncSession,
) -> None:
    pdd = await make_hub(db_session)
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    await _add_category(db_session, "B2", "PDD", after_rank=3, copy_from="B")
    await _act_as(db_session, RoleName.AUDITOR)
    async with _client(db_session) as client:
        everything = await client.get("/reference/categories")
        for_pdd = await client.get("/reference/categories", params={"hub_id": str(pdd.id)})
        for_oem = await client.get("/reference/categories", params={"hub_id": str(oem.id)})
    assert everything.status_code == 200
    assert [(c["code"], c["rank"]) for c in everything.json()] == [
        ("A+", 1),
        ("A", 2),
        ("B", 3),
        ("B2", 4),
        ("C", 5),
        ("A-OEM", 6),
        ("B-OEM", 7),
        ("C-OEM", 8),
    ]
    assert [c["code"] for c in for_pdd.json()] == ["A+", "A", "B", "B2", "C"]
    assert [c["code"] for c in for_oem.json()] == ["A-OEM", "B-OEM", "C-OEM"]


# --- B3: validation against the table ----------------------------------------------------------


async def test_registration_validates_against_the_table(db_session: AsyncSession) -> None:
    pdd = await make_hub(db_session)
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    await _add_category(db_session, "B2", "PDD", after_rank=3, copy_from="B")
    leader = await make_engineer(db_session, pdd, allowed_categories=["B2"])
    oem_leader = await make_engineer(db_session, oem, name="O", allowed_categories=["OEM"])
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        ok = await client.post("/projects", json=registration_body(pdd, leader, category="B2"))
        unknown = await client.post(
            "/projects", json=registration_body(pdd, leader, name="U", category="ZZ")
        )
        malformed = await client.post(
            "/projects", json=registration_body(pdd, leader, name="M", category="no/slash")
        )
        wrong_hub = await client.post(
            "/projects", json=registration_body(oem, oem_leader, name="W", category="B2")
        )
        pid = ok.json()["id"]
        patch_unknown = await client.patch(f"/projects/{pid}", json={"category": "ZZ"})
        patch_ok = await client.patch(f"/projects/{pid}", json={"category": "C"})
    assert ok.status_code == 201, ok.text
    assert ok.json()["category"] == "B2"
    assert unknown.status_code == 422
    (err,) = unknown.json()["detail"]
    assert err["type"] == "enum" and err["loc"] == ["body", "category"]
    assert err["input"] == "ZZ" and "'B2'" in err["msg"]
    assert malformed.status_code == 422
    assert wrong_hub.status_code == 422
    assert wrong_hub.json()["code"] == "CATEGORY_WORKFLOW_MISMATCH"
    assert patch_unknown.status_code == 422 and patch_unknown.json()["detail"][0]["type"] == "enum"
    assert patch_ok.status_code == 200 and patch_ok.json()["category"] == "C"


async def test_category_filters_accept_table_codes_and_reject_unknown(
    db_session: AsyncSession,
) -> None:
    hub = await make_hub(db_session)
    await _add_category(db_session, "B2", "PDD", after_rank=3, copy_from="B")
    p = await make_project(db_session, hub, category="B2")
    await make_project(db_session, hub, name="other", category="B")
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        ok = await client.get("/projects", params={"category": "B2"})
        unknown = await client.get("/projects", params={"category": ["B", "ZZ"]})
        dash_unmapped = await client.get(
            "/dashboard/projects", params={"category": ["B2", "Unmapped"]}
        )
        dash_unknown = await client.get("/dashboard/projects", params={"category": "ZZ"})
    assert ok.status_code == 200, ok.text
    assert [r["id"] for r in ok.json()] == [str(p.id)]
    assert unknown.status_code == 422
    (err,) = unknown.json()["detail"]
    assert err["loc"] == ["query", "category"] and err["input"] == "ZZ"
    assert dash_unmapped.status_code == 200, dash_unmapped.text
    assert dash_unknown.status_code == 422


async def test_engineer_eligibility_validates_against_the_table(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    await _add_category(db_session, "B2", "PDD", after_rank=3, copy_from="B")
    eng = await make_engineer(db_session, hub)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        ok = await client.patch(f"/engineers/{eng.id}", json={"allowed_categories": ["B2", "OEM"]})
        bad = await client.patch(f"/engineers/{eng.id}", json={"allowed_categories": ["B", "ZZ"]})
    assert ok.status_code == 200, ok.text
    assert ok.json()["allowed_categories"] == ["B2", "OEM"]
    assert bad.status_code == 422
    (err,) = bad.json()["detail"]
    assert err["type"] == "enum" and err["loc"] == ["body", "allowed_categories"]


async def test_breakdowns_list_every_table_category_in_rank_order(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    await _add_category(db_session, "B2", "PDD", after_rank=3, copy_from="B")
    await make_project(db_session, hub, category="B2")
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        analytics = await client.get("/dashboard/analytics")
        klass = await client.get("/capacity/class-breakdown")
    assert analytics.status_code == 200, analytics.text
    keys = [b["key"] for b in analytics.json()["by_category"]]
    assert keys[:8] == ["A+", "A", "B", "B2", "C", "A-OEM", "B-OEM", "C-OEM"]
    assert dict((b["key"], b["count"]) for b in analytics.json()["by_category"])["B2"] == 1
    assert klass.status_code == 200, klass.text
    assert [r["category"] for r in klass.json()["rows"]] == [
        "A+",
        "A",
        "B",
        "B2",
        "C",
        "A-OEM",
        "B-OEM",
        "C-OEM",
    ]


# --- builder, snapshot and token (R33-7, I30, T05-A3) ------------------------------------------


async def test_builder_passes_the_table_and_default_inputs_stay_byte_identical(
    db_session: AsyncSession,
) -> None:
    hub = await make_hub(db_session)
    await make_project(db_session, hub, category="B")
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    assert si.categories == default_categories()
    snapshot = build_workflow_snapshot_from_input(si)
    assert "categories" not in snapshot
    canonical = canonical_schedule_input_asdict(si)
    assert "categories" not in canonical
    # The token's form is `asdict` minus the P33 defaults: the pre-P33 form.
    pre_p33 = dataclasses.asdict(si)
    del pre_p33["categories"]
    for project in pre_p33["projects"]:
        # P40 (R40-12): `step_pins` is omitted from the canonical form when empty.
        project.pop("step_pins", None)
        # P53 (R53-2b): `actual_end_week` is omitted from the canonical form at None.
        if project.get("actual_end_week") is None:
            project.pop("actual_end_week", None)
        for row in project["step_timing"]:
            del row["wait_weeks"], row["lead_weeks"]
    assert priority_preview._canonical(si) == {
        **pre_p33,
        "projects": sorted(pre_p33["projects"], key=lambda p: p["project_id"]),
        "engineers": sorted(pre_p33["engineers"], key=lambda e: e["engineer_id"]),
        "chambers": sorted(pre_p33["chambers"], key=lambda c: c["chamber_id"]),
    }


async def test_a_new_category_reaches_the_input_snapshot_and_token(
    db_session: AsyncSession,
) -> None:
    hub = await make_hub(db_session)
    await _add_category(db_session, "B2", "PDD", after_rank=3, copy_from="B")
    await make_project(db_session, hub, category="B2")
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    assert CategoryInput(code="B2", workflow_id="PDD", rank=4) in si.categories
    expected = canonical_categories(si.categories)
    assert expected is not None and [c["code"] for c in expected][:5] == [
        "A+",
        "A",
        "B",
        "B2",
        "C",
    ]
    assert build_workflow_snapshot_from_input(si)["categories"] == expected
    assert "categories" in priority_preview._canonical(si)


def test_snapshot_adds_wait_and_lead_only_when_non_default() -> None:
    si = default_input_with_timing(
        StepTimingInput(
            step_id="S2", duration_override_weeks=None, start_not_before_week=None, wait_weeks=2
        ),
        StepTimingInput(
            step_id="S3", duration_override_weeks=4, start_not_before_week=None, lead_weeks=0
        ),
        StepTimingInput(step_id="S4", duration_override_weeks=3, start_not_before_week=None),
    )
    rows = build_workflow_snapshot_from_input(si)["step_timing"]
    assert rows == [
        {
            "project_id": "p",
            "step_id": "S2",
            "duration_override_weeks": None,
            "start_not_before_week": None,
            "wait_weeks": 2,
        },
        {
            "project_id": "p",
            "step_id": "S3",
            "duration_override_weeks": 4,
            "start_not_before_week": None,
            "lead_weeks": 0,
        },
        {
            "project_id": "p",
            "step_id": "S4",
            "duration_override_weeks": 3,
            "start_not_before_week": None,
        },
    ]


def default_input_with_timing(*rows: StepTimingInput) -> ScheduleInput:
    return ScheduleInput(
        current_week=TEST_WEEK,
        projects=(
            ProjectInput(
                project_id="p",
                name="p",
                hub="R&D-Greece",
                status="In Queue",
                category="B",
                priority="P2",
                frozen=False,
                leader_engineer_id=None,
                actual_start_week=None,
                delay_weeks=0,
                step_timing=rows,
            ),
        ),
        engineers=(),
        chambers=(),
        workflow_steps=(),
        lead_times=(),
    )


async def test_unused_uuid_is_not_a_category(db_session: AsyncSession) -> None:
    """Guard: the catalog does not treat arbitrary strings as codes."""
    catalog = await load_catalog(db_session)
    assert not catalog.is_known(str(uuid.uuid4()))
    assert not catalog.is_known("OEM")
    assert "OEM" in catalog.eligibility_values
