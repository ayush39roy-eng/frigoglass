"""P1-T03 (revised P9-T01) — seed the ~46-project synthetic demo dataset
extracted from `reference/rpd-platform-prototype.html` (see
`prototype_seed_data.json` / `extract_prototype_data.cjs` for provenance)
into the schema, plus the reference/lookup data sourced from
`backend/domain_constants.py`:

  - `workflows`, `workflow_step_templates` (28 rows: PDD-A..N, OEM-A..N) and
    `workflow_lead_times` (98 rows) — the 2026-09-27 contract (ADR 0007/0009).
    The P9-T01 migration already inserts these on `alembic upgrade head`; this
    script *upserts* them (so a fresh DB and an upgraded DB end up identical)
    and never deletes them on `--reset` — they are referenced by every
    project's step rows and by historical schedule runs.
  - `hubs` + one `hub_work_calendars` row per hub (ADR 0008,
    docs/CLIENT_FORMULAS.md §2.1).
  - `chambers` from the client workbook's ten chambers (ADR 0008,
    docs/CLIENT_FORMULAS.md §2.2; `domain_constants.CHAMBER_SEED`) — the
    prototype's eight chambers are mapped onto the workbook rows by region and
    number, and Romania CH-3/CH-4 are added (see docs/MEMORY.md P9-T01).
  - `engineers`, `projects` (+ 14 `project_workflow_steps` and 1
    `priority_scores` row each). OEM-hub projects are given the OEM workflow
    and an OEM category (A+/A → A-OEM, B → B-OEM, C → C-OEM); every step's
    `duration_weeks` comes from the lead-time table (no multipliers).

IMPORTANT — what this script does NOT seed:
  - `currency_rates` — `seed_currency_rates.py`.
  - `users`/`roles` — `seed_dev_users.py` (the Super Admin *role* row itself
    is inserted by the P9-T01 migration).
  - `planned_*_week` / `ScheduleRun*` rows — only the "live, unscheduled"
    state is seeded; run the scheduler to populate them.
  - Per-step `actual_*_week` / progress fields — the prototype only carries one
    project-level "actualStart" hint, not real per-step progress, so every step
    is seeded `Not Started` (see docs/MEMORY.md P1-T03 for the reasoning). Only
    `Project.actual_start_week` is populated, and only for `frozen` projects.
  - `project_files` / `project_comments` — nothing to seed; `--reset` clears
    them (comments via the `rpd.allow_comment_delete` escape hatch, see the
    P9-T01 migration) so the projects they reference can be deleted.

Usage (from `backend/`, with a `.venv` that has this project's deps installed):

    RPD_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/rpd \\
    RPD_FIELD_ENCRYPTION_KEY=<urlsafe-base64 32-byte Fernet key> \\
        python -m seed.seed_demo_data [--reset]

`--reset` deletes existing rows from every *demo-data* table this script
writes to (in FK-safe order) before reseeding — without it, the script
refuses to run if any of those tables already has rows, as a guard against
accidentally creating duplicate rows on a second run.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Mirrors backend/alembic/env.py's sys.path fallback so `import domain_constants`
# / `from models import ...` resolve regardless of the CWD this is invoked from.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import domain_constants as dc  # noqa: E402
from models import (  # noqa: E402
    Chamber,
    Engineer,
    Hub,
    HubWorkCalendar,
    PriorityScore,
    Project,
    ProjectComment,
    ProjectFile,
    ProjectWorkflowStep,
    UserHubScope,
    Workflow,
    WorkflowLeadTime,
    WorkflowStepTemplate,
)
from models.enums import (  # noqa: E402
    EngineerAllowedCategory,
    HardGateReason,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    WorkflowStepKind,
)
from models.priority import DIMENSION_FIELD_NAMES  # noqa: E402
from models.project import category_allowed_for_hub, workflow_id_for_hub  # noqa: E402
from services.workflow_durations import duration_for, lead_time_lookup  # noqa: E402

DATA_PATH = Path(__file__).resolve().parent / "prototype_seed_data.json"

# Children-first order, safe for both DELETE (this order) and the
# post-seed row-count report. Reference tables owned by the migration
# (`workflows`, `workflow_step_templates`, `workflow_lead_times`) are NOT here:
# they are upserted, never deleted.
_TABLES_CHILD_FIRST = (
    PriorityScore,
    ProjectWorkflowStep,
    ProjectFile,
    ProjectComment,
    Project,
    Chamber,
    Engineer,
    HubWorkCalendar,
    Hub,
)

_REFERENCE_TABLES = (Workflow, WorkflowStepTemplate, WorkflowLeadTime)

#: Prototype category → OEM category for projects on an OEM hub (ADR 0007;
#: the same mapping the P9-T01 migration applies to pre-existing rows).
_OEM_CATEGORY_MAP = {
    ProjectCategory.A_PLUS: ProjectCategory.A_OEM,
    ProjectCategory.A: ProjectCategory.A_OEM,
    ProjectCategory.B: ProjectCategory.B_OEM,
    ProjectCategory.C: ProjectCategory.C_OEM,
}


def _database_url() -> str:
    url = os.environ.get("RPD_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "RPD_DATABASE_URL is not set (async postgresql+asyncpg:// DSN). "
            "See backend/alembic/env.py for the same convention."
        )
    return url


def _load_prototype_data() -> dict:
    with open(DATA_PATH, encoding="utf-8") as f:
        return json.load(f)


async def _table_row_count(session: AsyncSession, model) -> int:
    return await session.scalar(select(func.count()).select_from(model)) or 0


async def _reset(session: AsyncSession) -> None:
    # `project_comments` rows are protected by a BEFORE DELETE trigger (never
    # hard-deleted in normal operation); a full demo reset is the one
    # sanctioned exception, opted into for this transaction only.
    await session.execute(text("SET LOCAL rpd.allow_comment_delete = 'on'"))
    # P9-F04: `seed_dev_users.py` (run AFTER this script, per
    # `frontend/e2e/README.md`'s documented order) may have linked
    # `bob.hub` to one of the `Hub` rows below via `UserHubScope` — a plain
    # FK with no ON DELETE action, so `DELETE FROM hubs` would otherwise
    # raise a `ForeignKeyViolationError` on any RE-reset performed after
    # `seed_dev_users` has already run once. `UserHubScope` is not itself
    # "demo data", but clearing it here (never `User`/`Role`/`UserRole`
    # themselves — those stay `seed_dev_users.py`'s own concern) is what
    # keeps this script's `--reset` safe to re-run at any point in that
    # documented ordering, in either direction.
    await session.execute(delete(UserHubScope))
    for model in _TABLES_CHILD_FIRST:
        await session.execute(delete(model))
    await session.flush()


async def _guard_against_duplicate_seed(session: AsyncSession) -> None:
    """Refuse to run if any demo-data table already has rows, unless --reset
    was passed (handled by the caller). Prevents silently creating duplicate
    rows on a second run. Reference tables are exempt (they are upserted).
    """
    for model in _TABLES_CHILD_FIRST:
        count = await _table_row_count(session, model)
        if count:
            raise RuntimeError(
                f"{model.__tablename__} already has {count} row(s) — re-run with "
                "--reset to truncate seed tables first, or this script would "
                "create duplicates."
            )


async def seed_workflows(session: AsyncSession) -> dict[str, int]:
    """Upsert `workflows` (2), `workflow_step_templates` (28) and
    `workflow_lead_times` (98) from `domain_constants` — the executable form
    of docs/DOMAIN_RULES.md "Workflow templates" / "Lead times". Idempotent:
    `session.merge` on the natural primary keys, so a DB the P9-T01 migration
    already seeded ends up byte-identical to a fresh one.
    """
    for workflow_id, name in dc.WORKFLOW_SEED:
        await session.merge(Workflow(id=workflow_id, name=name))
    await session.flush()
    for workflow_id, step_id, code, name, kind, seq, preds in dc.WORKFLOW_STEP_TEMPLATE_SEED:
        await session.merge(
            WorkflowStepTemplate(
                id=step_id,
                workflow_id=workflow_id,
                code=code,
                name=name,
                kind=WorkflowStepKind(kind),
                sequence_order=seq,
                predecessor_ids=list(preds),
            )
        )
    await session.flush()
    for workflow_id, category, step_id, weeks in dc.LEAD_TIME_SEED:
        await session.merge(
            WorkflowLeadTime(
                workflow_id=workflow_id,
                category=ProjectCategory(category),
                step_id=step_id,
                weeks=weeks,
            )
        )
    await session.flush()
    return {
        "workflows": len(dc.WORKFLOW_SEED),
        "workflow_step_templates": len(dc.WORKFLOW_STEP_TEMPLATE_SEED),
        "workflow_lead_times": len(dc.LEAD_TIME_SEED),
    }


async def seed_hubs(session: AsyncSession) -> dict[str, Hub]:
    """6 rows, from `domain_constants.HUB_LAB_REGION` / `OEM_HUBS`, each with
    its `HubWorkCalendar` from `HUB_WORK_CALENDAR_SEED` (ADR 0008).
    """
    hubs_by_name: dict[str, Hub] = {}
    for hub_name, lab_region in dc.HUB_LAB_REGION.items():
        hub = Hub(
            name=HubName(hub_name),
            lab_region=LabRegion(lab_region),
            is_oem=hub_name in dc.OEM_HUBS,
        )
        session.add(hub)
        hubs_by_name[hub_name] = hub
    await session.flush()
    for hub_name, weekdays, holidays, medical, casual, annual in dc.HUB_WORK_CALENDAR_SEED:
        session.add(
            HubWorkCalendar(
                hub_id=hubs_by_name[hub_name].id,
                weekdays_per_week=weekdays,
                national_holiday_days=holidays,
                medical_leave_days=medical,
                casual_leave_days=casual,
                annual_leave_days=annual,
                weeks_in_year=dc.WEEKS_IN_YEAR,
            )
        )
    await session.flush()
    return hubs_by_name


async def seed_engineers(
    session: AsyncSession, data: dict, hubs_by_name: dict[str, Hub]
) -> dict[str, Engineer]:
    """14 rows, from the prototype's synthetic dataset (`Hm` in the bundle)."""
    engineers_by_name: dict[str, Engineer] = {}
    for e in data["engineers"]:
        eng = Engineer(
            name=e["name"],
            hub_id=hubs_by_name[e["hub"]].id,
            fte=e["fte"],
            allowed_categories=[EngineerAllowedCategory(c) for c in e["cats"]],
        )
        session.add(eng)
        engineers_by_name[e["name"]] = eng
    await session.flush()
    return engineers_by_name


async def seed_chambers(session: AsyncSession) -> dict[str, Chamber]:
    """10 rows, from `domain_constants.CHAMBER_SEED` (the client workbook's
    chambers, docs/CLIENT_FORMULAS.md §2.2). `max_concurrent = platforms`
    (ADR 0007). The prototype's chamber list in `prototype_seed_data.json` is
    no longer the source — its `max`/`plat`/`wksCh` values predate the
    workbook.
    """
    chambers_by_code: dict[str, Chamber] = {}
    for code, region, platforms, eff, maint, breakdown, calib, stages in dc.CHAMBER_SEED:
        chamber = Chamber(
            code=code,
            lab_region=LabRegion(region),
            max_concurrent=platforms,
            platforms=platforms,
            efficiency=eff,
            maintenance_weeks=maint,
            breakdown_weeks=breakdown,
            calibration_weeks=calib,
            allowed_stages=list(stages),
        )
        session.add(chamber)
        chambers_by_code[code] = chamber
    await session.flush()
    return chambers_by_code


def _priority_score_fields(dims: list[int]) -> tuple[float, int, str]:
    """weighted_score / normalized_pct / suggested_band, per the formula in
    docs/DOMAIN_RULES.md "Prioritization scoring", using
    `domain_constants.PRIORITIZATION_DIMENSIONS`'s weights (same 13-dimension
    order the prototype's `dims` arrays are already in).
    """
    weighted_score = sum(
        score * weight
        for score, (*_rest, weight) in zip(dims, dc.PRIORITIZATION_DIMENSIONS, strict=True)
    )
    normalized_pct = round(weighted_score / (dc.TOTAL_WEIGHT * dc.DIMENSION_SCORE_MAX) * 100)
    suggested_band = next(
        label for threshold, label in dc.PRIORITY_BAND_THRESHOLDS if normalized_pct >= threshold
    )
    return weighted_score, normalized_pct, suggested_band


def project_category_for_hub(hub: Hub, prototype_category: ProjectCategory) -> ProjectCategory:
    """OEM-hub projects carry an OEM category (ADR 0007): A+/A → A-OEM,
    B → B-OEM, C → C-OEM. Non-OEM hubs keep the prototype's A+/A/B/C.
    """
    category = _OEM_CATEGORY_MAP[prototype_category] if hub.is_oem else prototype_category
    assert category_allowed_for_hub(hub.is_oem, category)
    return category


async def seed_projects(
    session: AsyncSession,
    data: dict,
    hubs_by_name: dict[str, Hub],
    engineers_by_name: dict[str, Engineer],
) -> int:
    """~46 rows (the prototype's actual embedded count — see docs/MEMORY.md
    P1-T03 entry re: the "~236" figure in docs/IMPLEMENTATION_PLAN.md not
    matching what's actually extractable), plus 14 `ProjectWorkflowStep` rows
    (of the project's workflow, durations from the lead-time table) and 1
    `PriorityScore` row per project.

    Financial fields (`tcogs_eur`, `selling_price_eur`, `gross_margin_pct`,
    `customer_name`) are assigned as plain values — `EncryptedString`/
    `EncryptedNumeric` (backend/models/types.py) handle encryption
    automatically via the ORM's `process_bind_param`, never hand-encrypted
    here.
    """
    templates_by_workflow: dict[str, list[tuple[str, int]]] = {}
    for workflow_id, step_id, _code, _name, _kind, seq, _preds in dc.WORKFLOW_STEP_TEMPLATE_SEED:
        templates_by_workflow.setdefault(workflow_id, []).append((step_id, seq))
    lead_times = lead_time_lookup(dc.LEAD_TIME_SEED)

    count = 0
    for p in data["projects"]:
        hub = hubs_by_name[p["hub"]]
        category = project_category_for_hub(hub, ProjectCategory(p["cat"]))
        workflow_id = workflow_id_for_hub(hub.is_oem)
        project = Project(
            name=p["name"],
            external_code=p["id"],
            hub_id=hub.id,
            leader_engineer_id=engineers_by_name[p["leader"]].id,
            category=category,
            type=ProjectType(p["type"]),
            status=ProjectStatus(p["status"]),
            priority=ProjectPriority(p["prio"]),
            frozen=p["frozen"],
            # Per DOMAIN_RULES.md booking rules, the prototype's `actualStart`
            # is only a real "actual" execution date when `frozen` — for
            # non-frozen projects it's merely an earliest-start scheduling
            # hint (see extract_prototype_data.cjs / MEMORY.md P1-T03).
            actual_start_week=p["actualStart"] if p["frozen"] else None,
            delay_weeks=p["delay"],
            reg_year=p["regYear"],
            carry_over=p["carryOver"],
            comments=p["comments"] or None,
            certification_testing_required=True,
            customer_name=p["customer"] or None,
            tcogs_eur=p["tcogs"],
            selling_price_eur=p["sp"],
            gross_margin_pct=p["gm"],
            capex_keur=p["capex"],
            rm_savings_keur=p["rm"],
        )
        session.add(project)
        await session.flush()  # need project.id for the children below

        for step_id, seq in templates_by_workflow[workflow_id]:
            session.add(
                ProjectWorkflowStep(
                    project_id=project.id,
                    step_template_id=step_id,
                    sequence_order=seq,
                    duration_weeks=duration_for(lead_times, workflow_id, category.value, step_id),
                )
            )

        weighted_score, normalized_pct, suggested_band = _priority_score_fields(p["dims"])
        session.add(
            PriorityScore(
                project_id=project.id,
                **dict(zip(DIMENSION_FIELD_NAMES, p["dims"], strict=True)),
                hard_gates=[HardGateReason(g) for g in p["gates"]],
                weighted_score=weighted_score,
                normalized_pct=normalized_pct,
                suggested_band=ProjectPriority(suggested_band),
            )
        )
        count += 1
    await session.flush()
    return count


async def run(reset_first: bool) -> dict[str, Any]:
    engine = create_async_engine(_database_url())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    counts: dict[str, Any] = {}
    try:
        async with session_factory() as session:
            if reset_first:
                await _reset(session)
            else:
                await _guard_against_duplicate_seed(session)

            data = _load_prototype_data()

            counts.update(await seed_workflows(session))
            hubs_by_name = await seed_hubs(session)
            counts["hubs"] = len(hubs_by_name)
            counts["hub_work_calendars"] = len(dc.HUB_WORK_CALENDAR_SEED)
            engineers_by_name = await seed_engineers(session, data, hubs_by_name)
            counts["engineers"] = len(engineers_by_name)
            chambers_by_code = await seed_chambers(session)
            counts["chambers"] = len(chambers_by_code)
            counts["projects"] = await seed_projects(session, data, hubs_by_name, engineers_by_name)
            counts["project_workflow_steps"] = counts["projects"] * dc.STEPS_PER_WORKFLOW
            counts["priority_scores"] = counts["projects"]

            await session.commit()

            # Post-commit verification: re-query actual row counts from the DB
            # rather than trusting the in-memory tallies above.
            verified: dict[str, int] = {}
            for model in _TABLES_CHILD_FIRST + _REFERENCE_TABLES:
                verified[model.__tablename__] = await _table_row_count(session, model)
            counts["_verified_from_db"] = verified
    finally:
        await engine.dispose()
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Delete existing rows from every seeded demo-data table before reseeding.",
    )
    args = parser.parse_args()
    counts = asyncio.run(run(reset_first=args.reset))
    print(json.dumps(counts, indent=2, default=str))


if __name__ == "__main__":
    main()
