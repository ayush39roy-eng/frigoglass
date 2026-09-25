"""Scenario #4 — enum values round-trip as their DOMAIN_RULES.md string
*values*, not Python member names. This is a regression test for the real
bug P1-T02 found and fixed (`values_callable` missing on every
`Enum(...)` column constructor) — before the fix, Postgres ENUM labels were
e.g. `RD_GREECE` instead of `R&D-Greece`, `A_PLUS` instead of `A+`,
`IN_BUYOFF` instead of `In Buyoff`.

Queries go through `text()` (raw SQL), deliberately bypassing the ORM's
`Enum` type so nothing decodes/relabels the value on the way back — this
proves what is *actually stored* in Postgres, not just what the ORM
round-trips it as (which would pass even if `values_callable` silently
mapped names back to values on read, masking the bug at the storage layer).
"""

from __future__ import annotations

from sqlalchemy import text

from models.enums import (
    CurrencyCode,
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    SolverType,
    WorkflowStepKind,
)
from tests.factories import (
    make_chamber,
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_workflow_step_template,
)


async def test_hub_name_and_lab_region_raw_values(db_session):
    hub = await make_hub(
        db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE, is_oem=False
    )
    row = (
        await db_session.execute(
            text("SELECT name, lab_region FROM hubs WHERE id = :id"), {"id": hub.id}
        )
    ).one()
    assert row.name == "R&D-Greece"  # not "RD_GREECE"
    assert row.lab_region == "Greece"


async def test_project_category_type_status_priority_raw_values(db_session):
    hub = await make_hub(db_session)
    project = await make_project(
        db_session,
        hub,
        category=ProjectCategory.A_PLUS,
        type=ProjectType.RC,
        status=ProjectStatus.IN_BUYOFF,
        priority=ProjectPriority.P1,
    )
    row = (
        await db_session.execute(
            text(
                "SELECT category, type, status, priority FROM projects WHERE id = :id"
            ),
            {"id": project.id},
        )
    ).one()
    assert row.category == "A+"  # not "A_PLUS"
    assert row.type == "RC"
    assert row.status == "In Buyoff"  # not "IN_BUYOFF"
    assert row.priority == "P1"


async def test_engineer_allowed_categories_array_raw_values(db_session):
    hub = await make_hub(db_session)
    eng = await make_engineer(
        db_session,
        hub,
        allowed_categories=[EngineerAllowedCategory.A_PLUS, EngineerAllowedCategory.OEM],
    )
    row = (
        await db_session.execute(
            text("SELECT allowed_categories FROM engineers WHERE id = :id"), {"id": eng.id}
        )
    ).one()
    assert row.allowed_categories == ["A+", "OEM"]  # not ["A_PLUS", "OEM"]


async def test_chamber_lab_region_raw_value(db_session):
    chamber = await make_chamber(db_session, lab_region=LabRegion.ROMANIA)
    row = (
        await db_session.execute(
            text("SELECT lab_region FROM chambers WHERE id = :id"), {"id": chamber.id}
        )
    ).one()
    assert row.lab_region == "Romania"


async def test_workflow_step_template_kind_raw_value(db_session):
    tmpl = await make_workflow_step_template(
        db_session, step_id="PDD-F", kind=WorkflowStepKind.LAB, sequence_order=6
    )
    row = (
        await db_session.execute(
            text("SELECT kind FROM workflow_step_templates WHERE id = :id"), {"id": tmpl.id}
        )
    ).one()
    assert row.kind == "lab"


async def test_schedule_run_solver_type_and_status_raw_values(db_session):
    run = await make_schedule_run(db_session, solver_type=SolverType.CP_SAT)
    row = (
        await db_session.execute(
            text("SELECT solver_type, status FROM schedule_runs WHERE id = :id"), {"id": run.id}
        )
    ).one()
    assert row.solver_type == "cp_sat"  # not "CP_SAT"
    assert row.status == "completed"


async def test_currency_code_raw_value(db_session):
    from models.currency import CurrencyRate

    rate = CurrencyRate(currency_code=CurrencyCode.INR, rate_to_eur=97.0)
    db_session.add(rate)
    await db_session.flush()
    row = (
        await db_session.execute(
            text("SELECT currency_code FROM currency_rates WHERE id = :id"), {"id": rate.id}
        )
    ).one()
    assert row.currency_code == "INR"
