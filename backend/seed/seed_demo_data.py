"""P1-T03 — seed the ~46-project synthetic demo dataset extracted from
`reference/rpd-platform-prototype.html` (see `prototype_seed_data.json` /
`extract_prototype_data.cjs` for provenance) into the schema built in
P1-T01/P1-T02, plus the two pieces of reference/lookup data
(`workflow_step_templates`, `hubs`) sourced from `backend/domain_constants.py`.

IMPORTANT — what this script does NOT seed:
  - `currency_rates` — that is P1-T04's job, not this script's.
  - `planned_*_week` / `ScheduleRun` / `ScheduleRunProjectStep` /
    `ScheduleRunProjectOutcome` — there is no scheduler yet (P2). Only the
    "live, unscheduled" state is seeded: projects, their 14 per-project
    workflow step instances (duration_weeks computed, planned_*/most
    actual_*_week left null), engineers, chambers.
  - Per-step `actual_start_week`/`actual_end_week` on `ProjectWorkflowStep` —
    the prototype only carries one project-level "actualStart" hint, not a
    real per-step actual execution record, so those columns are always left
    null here (see docs/MEMORY.md P1-T03 entry for the reasoning). Only
    `Project.actual_start_week` is populated, and only for `frozen` projects
    (see the module docstring in `extract_prototype_data.cjs` for why
    non-frozen `actualStart` is a scheduling hint, not a real "actual" date).

Usage (from `backend/`, with a `.venv` that has this project's deps installed):

    RPD_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/rpd \\
    RPD_FIELD_ENCRYPTION_KEY=<urlsafe-base64 32-byte Fernet key> \\
        python -m seed.seed_demo_data [--reset]

`--reset` deletes existing rows from every table this script writes to (in
FK-safe order) before reseeding — without it, the script refuses to run if
any target table already has rows, as a guard against accidentally creating
duplicate rows on a second run.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Mirrors backend/alembic/env.py's sys.path fallback so `import domain_constants`
# / `from models import ...` resolve regardless of the CWD this is invoked from.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import domain_constants as dc  # noqa: E402
from models import (  # noqa: E402
    Chamber,
    Engineer,
    Hub,
    PriorityScore,
    Project,
    ProjectWorkflowStep,
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

DATA_PATH = Path(__file__).resolve().parent / "prototype_seed_data.json"

# Children-first order, safe for both DELETE (this order) and the
# post-seed row-count report (either order is fine for counting).
_TABLES_CHILD_FIRST = (
    PriorityScore,
    ProjectWorkflowStep,
    Project,
    Chamber,
    Engineer,
    WorkflowStepTemplate,
    Hub,
)


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
    for model in _TABLES_CHILD_FIRST:
        await session.execute(delete(model))
    await session.flush()


async def _guard_against_duplicate_seed(session: AsyncSession) -> None:
    """Refuse to run if any target table already has rows, unless --reset was
    passed (handled by the caller). Prevents silently creating duplicate rows
    on a second run.
    """
    for model in _TABLES_CHILD_FIRST:
        count = await _table_row_count(session, model)
        if count:
            raise RuntimeError(
                f"{model.__tablename__} already has {count} row(s) — re-run with "
                "--reset to truncate seed tables first, or this script would "
                "create duplicates."
            )


async def seed_workflow_step_templates(session: AsyncSession) -> int:
    """14 rows, from `domain_constants.WORKFLOW_STEP_TEMPLATE_SEED` — the one
    piece of reference data that's already a first-class constant, used
    directly per the task's explicit instruction.
    """
    rows = [
        WorkflowStepTemplate(
            id=step_id,
            name=name,
            kind=WorkflowStepKind(kind),
            base_weeks=base_weeks,
            sequence_order=seq,
        )
        for step_id, name, kind, base_weeks, seq in dc.WORKFLOW_STEP_TEMPLATE_SEED
    ]
    session.add_all(rows)
    await session.flush()
    return len(rows)


async def seed_hubs(session: AsyncSession) -> dict[str, Hub]:
    """6 rows, from `domain_constants.HUB_LAB_REGION` / `OEM_HUBS`."""
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


async def seed_chambers(session: AsyncSession, data: dict) -> dict[str, Chamber]:
    """8 rows, from the prototype's synthetic dataset (`$m` in the bundle).

    `allowed_stages` is mapped from the prototype's bare-letter shorthand
    (e.g. "F") to the canonical "PDD-<letter>" IDs
    (backend/models/chamber.py's docstring flagged this exact mapping need).
    """
    chambers_by_code: dict[str, Chamber] = {}
    for c in data["chambers"]:
        chamber = Chamber(
            code=c["id"],
            lab_region=LabRegion(c["labHub"]),
            max_concurrent=c["max"],
            platforms=c["plat"],
            efficiency=c["eff"],
            weeks_per_chamber=c["wksCh"],
            allowed_stages=[f"PDD-{letter}" for letter in c["stages"]],
        )
        session.add(chamber)
        chambers_by_code[c["id"]] = chamber
    await session.flush()
    return chambers_by_code


def _priority_score_fields(dims: list[int]) -> tuple[float, int, str]:
    """weighted_score / normalized_pct / suggested_band, per the formula in
    docs/DOMAIN_RULES.md "Prioritization scoring", using
    `domain_constants.PRIORITIZATION_DIMENSIONS`'s weights (same 13-dimension
    order the prototype's `dims` arrays are already in — verified by
    cross-referencing the prototype's `es` dimension-definition array against
    `PRIORITIZATION_DIMENSIONS`, both in "Strategic Project, New Customer, ...,
    CAPEX Investment" order).
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


async def seed_projects(
    session: AsyncSession,
    data: dict,
    hubs_by_name: dict[str, Hub],
    engineers_by_name: dict[str, Engineer],
) -> int:
    """~46 rows (the prototype's actual embedded count — see
    docs/MEMORY.md P1-T03 entry re: the "~236" figure in
    docs/IMPLEMENTATION_PLAN.md not matching what's actually extractable),
    plus 14 `ProjectWorkflowStep` rows and 1 `PriorityScore` row per project.

    Financial fields (`tcogs_eur`, `selling_price_eur`, `gross_margin_pct`,
    `customer_name`) are assigned as plain values — `EncryptedString`/
    `EncryptedNumeric` (backend/models/types.py) handle encryption
    automatically via the ORM's `process_bind_param`, never hand-encrypted
    here.
    """
    templates = list(dc.WORKFLOW_STEP_TEMPLATE_SEED)
    count = 0
    for p in data["projects"]:
        category = ProjectCategory(p["cat"])
        project = Project(
            name=p["name"],
            external_code=p["id"],
            hub_id=hubs_by_name[p["hub"]].id,
            leader_engineer_id=engineers_by_name[p["leader"]].id,
            category=category,
            type=ProjectType(p["type"]),
            status=ProjectStatus(p["status"]),
            priority=ProjectPriority(p["prio"]),
            frozen=p["frozen"],
            # Per DOMAIN_RULES.md booking rules, the prototype's `actualStart`
            # is only a real "actual" execution date when `frozen` — for
            # non-frozen projects it's merely an earliest-start scheduling
            # hint the greedy scheduler clamps to `CURRENT_WEEK-6` (see
            # extract_prototype_data.cjs's docstring / MEMORY.md P1-T03 entry
            # for the exact prototype expression this was verified against:
            # `Math.max(s.actualStart, s.frozen ? s.actualStart : Ie-6)`).
            # There is no scheduler yet (P2), so only the genuinely "actual"
            # value is persisted here.
            actual_start_week=p["actualStart"] if p["frozen"] else None,
            delay_weeks=p["delay"],
            reg_year=p["regYear"],
            carry_over=p["carryOver"],
            comments=p["comments"] or None,
            customer_name=p["customer"] or None,
            tcogs_eur=p["tcogs"],
            selling_price_eur=p["sp"],
            gross_margin_pct=p["gm"],
            capex_keur=p["capex"],
            rm_savings_keur=p["rm"],
        )
        session.add(project)
        await session.flush()  # need project.id for the children below

        for step_id, _name, _kind, base_weeks, seq in templates:
            session.add(
                ProjectWorkflowStep(
                    project_id=project.id,
                    step_template_id=step_id,
                    sequence_order=seq,
                    duration_weeks=dc.duration_weeks(base_weeks, category.value),
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


async def run(reset_first: bool) -> dict[str, int]:
    engine = create_async_engine(_database_url())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    counts: dict[str, int] = {}
    try:
        async with session_factory() as session:
            if reset_first:
                await _reset(session)
            else:
                await _guard_against_duplicate_seed(session)

            data = _load_prototype_data()

            counts["workflow_step_templates"] = await seed_workflow_step_templates(session)
            hubs_by_name = await seed_hubs(session)
            counts["hubs"] = len(hubs_by_name)
            engineers_by_name = await seed_engineers(session, data, hubs_by_name)
            counts["engineers"] = len(engineers_by_name)
            chambers_by_code = await seed_chambers(session, data)
            counts["chambers"] = len(chambers_by_code)
            counts["projects"] = await seed_projects(session, data, hubs_by_name, engineers_by_name)
            counts["project_workflow_steps"] = counts["projects"] * len(
                dc.WORKFLOW_STEP_TEMPLATE_SEED
            )
            counts["priority_scores"] = counts["projects"]

            await session.commit()

            # Post-commit verification: re-query actual row counts from the DB
            # rather than trusting the in-memory tallies above.
            verified: dict[str, int] = {}
            for model in _TABLES_CHILD_FIRST:
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
        help="Delete existing rows from every seeded table before reseeding.",
    )
    args = parser.parse_args()
    counts = asyncio.run(run(reset_first=args.reset))
    print(json.dumps(counts, indent=2, default=str))


if __name__ == "__main__":
    main()
