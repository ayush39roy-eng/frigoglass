"""Seed the demo dataset plus the reference/lookup data sourced from
`backend/domain_constants.py`.

Two datasets (`--dataset`):

  - `client_2026` (**default**, ADR 0024): the client's real 2026 pipeline.
    These are the 253 projects of their workbook whose Project Request falls in
    2026, extracted by `extract_client_2026.py` into
    `client_2026_seed_data.json`. ADR 0035: the engineers are the client's
    real roster (formula workbook `RPD Capacity`, with its FTE) plus the
    workbook project leaders who are not on it, flagged provisional; a
    blank leader stays blank. Nothing is tuned: FTE and chamber efficiency
    are the workbook's values. `seed/client_2026.py` holds every rule. In
    short:
    - step progress comes from Project Status and Development Step;
    - the 13 rubric scores are synthetic (no client source holds them);
    - plant, requesting department, product type, `Spillover '25`
      (carry_over / reg_year) and the end date come from the project file.
    Row ids are deterministic (`uuid5`), so every reseed produces the same
    schedule run.
  - `prototype`: the ~46-project synthetic set extracted from
    `reference/rpd-platform-prototype.html` (`prototype_seed_data.json` /
    `extract_prototype_data.cjs`). It is kept for the tests and e2e that
    depend on it. Every step is seeded `Not Started` and ids are random.

Both datasets seed:

  - `workflows`, `workflow_step_templates` (28 rows: PDD-A..N, OEM-A..N) and
    `workflow_lead_times` (98 rows) — the 2026-09-27 contract (ADR 0007/0009).
    The P9-T01 migration already inserts these on `alembic upgrade head`; this
    script *upserts* them (so a fresh DB and an upgraded DB end up identical)
    and never deletes them on `--reset` — they are referenced by every
    project's step rows and by historical schedule runs.
  - `hubs` + one `hub_work_calendars` row per hub (ADR 0008,
    docs/CLIENT_FORMULAS.md §2.1).
  - `chambers` from the client workbook's ten chambers (ADR 0008,
    docs/CLIENT_FORMULAS.md §2.2; `domain_constants.CHAMBER_SEED`), with the
    workbook's efficiencies (ADR 0035 retired ADR 0024's tuning).
  - `engineers`, `projects` (+ 14 `project_workflow_steps` and 1
    `priority_scores` row each). OEM-hub projects follow the OEM workflow and
    carry an OEM category. Every step's `duration_weeks` comes from the
    lead-time table (no multipliers).

IMPORTANT — what this script does NOT seed:
  - `currency_rates` — `seed_currency_rates.py`.
  - `users`/`roles` — `seed_dev_users.py` (the Super Admin *role* row itself
    is inserted by the P9-T01 migration).
  - `planned_*_week` / `ScheduleRun*` rows — only the "live, unscheduled"
    state is seeded; run the scheduler to populate them.
  - For `prototype` only: per-step `actual_*_week` / progress fields. The
    prototype carries only one project-level "actualStart" hint, not real
    per-step progress, so every step is seeded `Not Started` (see
    docs/MEMORY.md P1-T03 for the reasoning). Only `Project.actual_start_week`
    is populated, and only for `frozen` projects.
  - `project_files` / `project_comments` — nothing to seed; `--reset` clears
    them (comments via the `rpd.allow_comment_delete` escape hatch, see the
    P9-T01 migration) so the projects they reference can be deleted.

Usage (from `backend/`, with a `.venv` that has this project's deps installed):

    RPD_DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/rpd \\
    RPD_FIELD_ENCRYPTION_KEY=<urlsafe-base64 32-byte Fernet key> \\
        python -m seed.seed_demo_data [--reset] [--schedule] [--dataset client_2026|prototype]

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
import time
import uuid
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import delete, func, insert, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Mirrors backend/alembic/env.py's sys.path fallback so `import domain_constants`
# / `from models import ...` resolve regardless of the CWD this is invoked from.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import domain_constants as dc  # noqa: E402
from models import (  # noqa: E402
    AuditLogEntry,
    Chamber,
    Engineer,
    Hub,
    HubWorkCalendar,
    Notification,
    PriorityApplicationResult,
    PriorityApplicationRun,
    PriorityScore,
    Project,
    ProjectAccessGrant,
    ProjectComment,
    ProjectFile,
    ProjectWorkflowStep,
    ScenarioApplyChange,
    ScenarioApplyRun,
    ScheduleRun,
    ScheduleRunFollowUp,
    ScheduleRunProjectOutcome,
    ScheduleRunProjectStep,
    StageCheckin,
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
    SolverType,  # noqa: E402
    WorkflowStepKind,
    WorkflowStepStatus,
)
from models.project import category_allowed_for_hub, workflow_id_for_hub  # noqa: E402
from models.vip import vip_item_projects  # noqa: E402
from scheduling.greedy import run_greedy_sgs  # noqa: E402
from seed import client_2026 as c26  # noqa: E402
from seed.initial_scoring_rubric import (  # noqa: E402
    ensure_scoring_rubric,
    seed_priority_score,
)
from seed.seed_vip_board import seed_vip_board  # noqa: E402
from services.audit_helpers import project_audit_state  # noqa: E402
from services.schedule_persistence import (  # noqa: E402
    build_schedule_input_from_db,
    persist_schedule_output,
)
from services.scoring_tags import tags_for_type  # noqa: E402
from services.workflow_durations import duration_for, lead_time_lookup  # noqa: E402

DATA_PATH = Path(__file__).resolve().parent / "prototype_seed_data.json"
CLIENT_2026_DATA_PATH = Path(__file__).resolve().parent / "client_2026_seed_data.json"

DATASET_CLIENT_2026 = "client_2026"
DATASET_PROTOTYPE = "prototype"
DATASETS = (DATASET_CLIENT_2026, DATASET_PROTOTYPE)
DEFAULT_DATASET = DATASET_CLIENT_2026

# Tables that reference projects / engineers / chambers / schedule runs and
# only make sense for the data a reseed replaces. `--reset` deletes them
# before the primary demo-data tables, in this order. A child always comes
# before its parent: `notifications` references both `schedule_runs` (two
# nullable FKs) and `projects` (NOT NULL), so it is deleted before either.
# The live dev DB of 2026-10-21 failed here when notifications came after
# schedule_runs.
#
# `project_access_grants` (deleted here) and `vip_item_projects` (cascades on
# project delete) are user configuration. `_reset` snapshots them first, and
# `_restore_user_config` re-inserts every row whose project id exists again
# after the reseed (client_2026 ids are deterministic uuid5).
#
# NOT here, on purpose:
#   - `vip_items`, `users`, `user_roles`, `export_jobs` and `currency_rates`
#     do not reference demo rows and are left alone.
#   - `audit_log_entries` (append-only, no escape hatch) only references
#     `hubs`, which are therefore kept whenever audit rows exist.
#   - `schedule_run_follow_ups` is the single row the migration inserts (ADR
#     0023). It references no run, so it is reset to the migration's state
#     rather than deleted.
_DEPENDENT_TABLES_CHILD_FIRST = (
    Notification,
    ScheduleRunProjectStep,
    ScheduleRunProjectOutcome,
    ScheduleRun,
    PriorityApplicationResult,
    PriorityApplicationRun,
    ScenarioApplyChange,
    ScenarioApplyRun,
    StageCheckin,
    ProjectAccessGrant,
)

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


def _load_client_2026_data() -> dict[str, Any]:
    with open(CLIENT_2026_DATA_PATH, encoding="utf-8") as f:
        loaded: dict[str, Any] = json.load(f)
    return loaded


async def _table_row_count(session: AsyncSession, model) -> int:
    return await session.scalar(select(func.count()).select_from(model)) or 0


@dataclass
class _UserConfig:
    """User configuration that references demo rows, kept across `--reset`.

    It is restored by id after the reseed (`_restore_user_config`). A row
    whose project or engineer no longer exists is dropped. With client_2026
    (deterministic ids) nothing is dropped; with prototype (random ids) all of
    it is.
    """

    access_grants: list[dict[str, Any]] = field(default_factory=list)
    vip_links: list[dict[str, Any]] = field(default_factory=list)
    vip_pinned_project_ids: set[uuid.UUID] = field(default_factory=set)
    engineer_user_links: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)


async def _snapshot_user_config(session: AsyncSession) -> _UserConfig:
    grants = ProjectAccessGrant.__table__
    return _UserConfig(
        access_grants=[dict(r) for r in (await session.execute(select(grants))).mappings()],
        vip_links=[
            dict(r) for r in (await session.execute(select(vip_item_projects))).mappings()
        ],
        vip_pinned_project_ids=set(
            (await session.execute(select(Project.id).where(Project.is_vip.is_(True)))).scalars()
        ),
        engineer_user_links={
            eng_id: user_id
            for eng_id, user_id in (
                await session.execute(
                    select(Engineer.id, Engineer.user_id).where(Engineer.user_id.is_not(None))
                )
            ).all()
            if user_id is not None
        },
    )


async def _reset(session: AsyncSession) -> _UserConfig:
    """Delete the demo data in FK-safe order and return the user config that
    referenced it, for `_restore_user_config`.

    Deleted (refers only to the data being replaced): schedule runs and their
    outcomes / steps, notifications, priority-move runs and results,
    scenario-apply runs and changes, stage check-ins, project files and
    comments, priority scores, workflow steps, projects, chambers and
    engineers. Hubs and hub calendars too, and then the user hub scopes, but
    only when no audit row exists (audit rows reference hubs and are
    append-only).
    """
    # `project_comments` and `stage_checkins` rows are protected by BEFORE
    # DELETE triggers (never hard-deleted in normal operation). A full demo
    # reset is the one sanctioned exception, opted into for this transaction
    # only (P9-T01 for comments, `p24b_checkin_reset_escape` for check-ins).
    # `audit_log_entries` has no escape hatch and is never touched.
    await session.execute(text("SET LOCAL rpd.allow_comment_delete = 'on'"))
    await session.execute(text("SET LOCAL rpd.allow_checkin_delete = 'on'"))

    preserved = await _snapshot_user_config(session)
    has_audit = bool(await session.scalar(select(func.count()).select_from(AuditLogEntry)))

    # P9-F04: `seed_dev_users.py` may have scoped `bob.hub` to a hub. That FK
    # has no ON DELETE action, so the scopes must go before `DELETE FROM hubs`.
    # When audit rows exist, the hubs are kept (same ids), so the scopes are
    # user config that stays valid and is kept too.
    if not has_audit:
        await session.execute(delete(UserHubScope))
    for dependent in _DEPENDENT_TABLES_CHILD_FIRST:
        await session.execute(delete(dependent))
    # ADR 0023's single follow-up row: back to the state the migration inserts.
    await session.execute(
        update(ScheduleRunFollowUp).values(
            pending=False, requested_at=None, last_trigger_reason=None, request_count=0
        )
    )
    for model in _TABLES_CHILD_FIRST:
        if has_audit and model in (Hub, HubWorkCalendar):
            continue
        await session.execute(delete(model))
    await session.flush()
    return preserved


async def _restore_user_config(session: AsyncSession, preserved: _UserConfig) -> dict[str, int]:
    """Re-insert the snapshot's rows whose project / engineer exists again.

    Runs before `seed_vip_board`, so the board seed sees the user's links and
    VIP pins exactly as an un-reset database would show them.
    """
    await session.flush()
    project_ids = set((await session.execute(select(Project.id))).scalars())
    engineer_ids = set((await session.execute(select(Engineer.id))).scalars())

    grants = [g for g in preserved.access_grants if g["project_id"] in project_ids]
    if grants:
        await session.execute(insert(ProjectAccessGrant), grants)
    links = [lk for lk in preserved.vip_links if lk["project_id"] in project_ids]
    if links:
        await session.execute(insert(vip_item_projects), links)
    pins = preserved.vip_pinned_project_ids & project_ids
    if pins:
        await session.execute(update(Project).where(Project.id.in_(pins)).values(is_vip=True))
    eng_links = {e: u for e, u in preserved.engineer_user_links.items() if e in engineer_ids}
    for eng_id, user_id in eng_links.items():
        await session.execute(update(Engineer).where(Engineer.id == eng_id).values(user_id=user_id))
    await session.flush()
    return {
        "access_grants_kept": len(grants),
        "access_grants_dropped": len(preserved.access_grants) - len(grants),
        "vip_links_kept": len(links),
        "vip_links_dropped": len(preserved.vip_links) - len(links),
        "vip_pins_kept": len(pins),
        "engineer_user_links_kept": len(eng_links),
        "engineer_user_links_dropped": len(preserved.engineer_user_links) - len(eng_links),
    }


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
    """6 rows, from `domain_constants.HUB_LAB_REGION` / `OEM_HUBS`. ADR 0042
    (P29): OEM-HCK and OEM-Seltek point at R&D-Greece (`capacity_hub_id`,
    `domain_constants.HUB_CAPACITY_HUB`). Each CAPACITY hub gets its
    `HubWorkCalendar` from `HUB_WORK_CALENDAR_SEED` (ADR 0008); a member hub
    has none (an existing one, from a pre-P29 seed, is deleted), the same
    facts as migration `p29a_capacity_hubs`.
    """
    hubs_by_name: dict[str, Hub] = {}
    existing_hubs = {
        h.name.value if hasattr(h.name, "value") else str(h.name): h
        for h in (await session.execute(select(Hub))).scalars().all()
    }
    for hub_name, lab_region in dc.HUB_LAB_REGION.items():
        if hub_name in existing_hubs:
            hub = existing_hubs[hub_name]
            hub.lab_region = LabRegion(lab_region)
            hub.is_oem = hub_name in dc.OEM_HUBS
        else:
            hub = Hub(
                name=HubName(hub_name),
                lab_region=LabRegion(lab_region),
                is_oem=hub_name in dc.OEM_HUBS,
            )
            session.add(hub)
        hubs_by_name[hub_name] = hub
    await session.flush()
    for hub_name, hub in hubs_by_name.items():
        parent = dc.HUB_CAPACITY_HUB.get(hub_name)
        hub.capacity_hub_id = hubs_by_name[parent].id if parent is not None else None
    await session.flush()
    member_ids = [hubs_by_name[name].id for name in dc.HUB_CAPACITY_HUB]
    await session.execute(delete(HubWorkCalendar).where(HubWorkCalendar.hub_id.in_(member_ids)))

    existing_calendars = {
        c.hub_id: c for c in (await session.execute(select(HubWorkCalendar))).scalars().all()
    }
    for hub_name, weekdays, holidays, medical, casual, annual in dc.HUB_WORK_CALENDAR_SEED:
        hub_id = hubs_by_name[hub_name].id
        if hub_id in existing_calendars:
            cal = existing_calendars[hub_id]
            cal.weekdays_per_week = weekdays
            cal.national_holiday_days = holidays
            cal.medical_leave_days = medical
            cal.casual_leave_days = casual
            cal.annual_leave_days = annual
            cal.weeks_in_year = dc.WEEKS_IN_YEAR
        else:
            session.add(
                HubWorkCalendar(
                    hub_id=hub_id,
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


async def seed_chambers(
    session: AsyncSession, *, deterministic_ids: bool = False
) -> dict[str, Chamber]:
    """10 rows, from `domain_constants.CHAMBER_SEED` (the client workbook's
    chambers, docs/CLIENT_FORMULAS.md §2.2). `max_concurrent = platforms`
    (ADR 0007). The prototype's chamber list in `prototype_seed_data.json` is
    no longer the source — its `max`/`plat`/`wksCh` values predate the
    workbook.
    """
    chambers_by_code: dict[str, Chamber] = {}
    for code, region, platforms, eff, maint, breakdown, calib, stages in dc.CHAMBER_SEED:
        ids = {"id": c26.chamber_uuid(code)} if deterministic_ids else {}
        chamber = Chamber(
            **ids,
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


def seed_project_status(raw: str) -> ProjectStatus:
    """A seeded project's status. ADR 0034 (P23-T02): Draft is retired from
    registration, so no seed may create a Draft project; a data file that
    carries one fails the seed loudly instead of loading it."""

    status = ProjectStatus(raw)
    if status is ProjectStatus.DRAFT:
        raise ValueError("seed data may not create Draft projects (ADR 0034)")
    return status


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
    # ADR 0037: scores are computed under the CURRENT rubric (version 1 = the
    # 13 dimensions unless an admin has changed it; the reseed keeps it).
    rubric = await ensure_scoring_rubric(session)

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
            status=seed_project_status(p["status"]),
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
            # ADR 0038: tags from `type`, the p27a backfill rule.
            scoring_tags=tags_for_type(p["type"]),
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

        session.add(
            seed_priority_score(
                rubric,
                project.id,
                p["dims"],
                [HardGateReason(g) for g in p["gates"]],
                tags=project.scoring_tags,
            )
        )
        count += 1
    await session.flush()
    return count


def client_2026_step_specs(
    project: dict[str, Any], workflow_id: str, lead_times: Mapping[tuple[str, str, str], int]
) -> list[c26.StepSpec]:
    """The project's 14 steps in sequence order, with the duration the
    scheduler uses (0 = skipped: a 0-week lead time, or a lab step when
    certification testing is off)."""

    specs: list[c26.StepSpec] = []
    for wf, step_id, _code, _name, kind, _seq, _preds in dc.WORKFLOW_STEP_TEMPLATE_SEED:
        if wf != workflow_id:
            continue
        weeks = duration_for(lead_times, workflow_id, project["category"], step_id)
        if kind == WorkflowStepKind.LAB.value and not project["certification_testing_required"]:
            weeks = 0
        specs.append(c26.StepSpec(step_id, kind, weeks))
    return specs


def _provisional_leaders(
    projects: list[dict[str, Any]],
    project_ids: list[uuid.UUID],
    order: list[int],
    specs: dict[int, list[c26.StepSpec]],
    roster: c26.RosterBuild,
    leaders: list[str | None],
) -> dict[int, str]:
    """ADR 0042 §7: project index → provisional leader name, for every project
    of a capacity member hub with a blank workbook leader
    (`client_2026.assign_provisional_leaders`; candidates are the counted
    engineers of the capacity hub, loads Σ design effort of the open projects
    they lead, walk in scheduling order)."""

    def effort(i: int) -> int:
        return sum(s.duration for s in specs[i] if s.kind == "design")

    out: dict[int, str] = {}
    for capacity_hub in sorted(set(dc.HUB_CAPACITY_HUB.values())):
        members = {h for h, parent in dc.HUB_CAPACITY_HUB.items() if parent == capacity_hub}
        candidates = [
            c26.LeaderCandidate(
                name=e.name,
                allowed_categories=e.allowed_categories,
                load_weeks=sum(
                    effort(i)
                    for i, p in enumerate(projects)
                    if leaders[i] == e.name and c26.is_open(p)
                ),
            )
            for e in roster.engineers
            if e.hub == capacity_hub and e.counts_in_capacity
        ]
        walk = [i for i in order if projects[i]["hub"] in members and leaders[i] is None]
        chosen = c26.assign_provisional_leaders(
            [
                c26.LeaderlessProject(
                    key=str(project_ids[i]),
                    category=str(projects[i]["category"]),
                    schedulable=c26.is_open(projects[i]),
                    design_effort_weeks=effort(i),
                )
                for i in walk
            ],
            candidates,
        )
        for i in walk:
            name = chosen.get(str(project_ids[i]))
            if name is not None:
                out[i] = name
    return out


async def seed_client_2026(
    session: AsyncSession,
    data: dict[str, Any],
    hubs_by_name: dict[str, Hub],
) -> dict[str, Any]:
    """The client's 2026 pipeline (ADR 0024) on the client's real roster
    (ADR 0035): engineers, projects, their 14 steps with derived progress
    and one `PriorityScore` each. Every derivation rule lives in
    `seed/client_2026.py`. Nothing is tuned: FTE and chamber efficiency are
    the formula workbook's values.

    A summary greedy run (in memory, nothing persisted) reports the
    verdict counts; `--schedule` persists and activates a real run.

    `customer_name` is an encrypted column. It is assigned as a plain value
    (the ORM type encrypts it) and is never logged or returned in the counts.
    """

    # Imported here: the scheduler is only needed for the summary run (it is
    # a pure function; nothing is persisted from it).
    from scheduling.greedy import run_greedy_sgs
    from services.schedule_persistence import build_schedule_input_from_db

    projects: list[dict[str, Any]] = data["projects"]
    lead_times = lead_time_lookup(dc.LEAD_TIME_SEED)
    current_week = dc.CURRENT_WEEK
    # ADR 0037: scores are computed under the CURRENT rubric.
    rubric = await ensure_scoring_rubric(session)

    project_ids = [c26.project_uuid(p["external_code"]) for p in projects]
    order = sorted(
        range(len(projects)),
        key=lambda i: c26.scheduling_order_key(projects[i], str(project_ids[i])),
    )
    roster = c26.build_roster(data)
    workbook_leaders = c26.project_leaders(projects, roster.engineers)

    engineers_by_name: dict[str, Engineer] = {}
    for e in roster.engineers:
        # ADR 0035: a provisional engineer (a workbook leader who is not on the
        # roster) is flagged in `seed/client_2026.py`; the table has no flag.
        # ADR 0042 §5: `counts_in_capacity` false for the leaders on no roster.
        eng = Engineer(
            id=c26.engineer_uuid(e.name),
            name=e.name,
            hub_id=hubs_by_name[e.hub].id,
            fte=e.fte,
            allowed_categories=[EngineerAllowedCategory(c) for c in e.allowed_categories],
            counts_in_capacity=e.counts_in_capacity,
        )
        session.add(eng)
        engineers_by_name[e.name] = eng
    await session.flush()

    specs: dict[int, list[c26.StepSpec]] = {}
    for i, p in enumerate(projects):
        hub = hubs_by_name[p["hub"]]
        specs[i] = client_2026_step_specs(p, workflow_id_for_hub(hub.is_oem), lead_times)

    # ADR 0042 §7: a provisional leader for each leaderless project of a
    # capacity member hub (the same rule as migration `p29a_capacity_hubs`).
    provisional = _provisional_leaders(
        projects, project_ids, order, specs, roster, workbook_leaders
    )
    leader_names = [provisional.get(i, workbook_leaders[i]) for i in range(len(projects))]

    # Progress, in scheduling order, so the higher-priority project gets the
    # free leader / chamber platform at CURRENT_WEEK (client_2026 docstring).
    # A project with no leader books nothing, so it uses a private ledger.
    progress: dict[int, list[c26.StepProgress]] = {}
    ledger = c26.ResourceLedger()
    for i in order:
        p = projects[i]
        hub = hubs_by_name[p["hub"]]
        shared = c26.is_open(p) and leader_names[i] is not None
        progress[i] = c26.derive_progress(
            p,
            specs[i],
            leader=leader_names[i],
            lab_region=hub.lab_region.value,
            current_week=current_week,
            ledger=ledger if shared else c26.ResourceLedger(),
        )

    templates = {
        step_id: seq for _wf, step_id, _c, _n, _k, seq, _p in dc.WORKFLOW_STEP_TEMPLATE_SEED
    }
    for i, p in enumerate(projects):
        hub = hubs_by_name[p["hub"]]
        category = ProjectCategory(p["category"])
        if not category_allowed_for_hub(hub.is_oem, category):
            raise ValueError(f"{p['external_code']}: category {category.value} vs hub {hub.name}")
        leader = leader_names[i]
        carry_over, reg_year = c26.carry_over_and_reg_year(p)
        project = Project(
            id=project_ids[i],
            name=p["name"],
            external_code=p["external_code"],
            hub_id=hub.id,
            leader_engineer_id=engineers_by_name[leader].id if leader is not None else None,
            leader_is_provisional=i in provisional,
            category=category,
            type=ProjectType(p["type"]) if p["type"] else None,
            status=seed_project_status(p["status"]),
            priority=ProjectPriority(p["priority"]),
            frozen=False,
            delay_weeks=0,
            reg_year=reg_year,
            carry_over=carry_over,
            target_end_week=p["target_end_week"],
            comments=p["comments"],
            certification_testing_required=p["certification_testing_required"],
            customer_name=p["customer"],
            plant=p["plant"],
            requesting_department=p["requesting_department"],
            product_type=p["product_type"],
            # ADR 0038: tags from `type`, the p27a backfill rule.
            scoring_tags=tags_for_type(p["type"]),
        )
        session.add(project)
        workflow_id = workflow_id_for_hub(hub.is_oem)
        for spec, prog in zip(specs[i], progress[i], strict=True):
            session.add(
                ProjectWorkflowStep(
                    project_id=project.id,
                    step_template_id=spec.step_id,
                    sequence_order=templates[spec.step_id],
                    duration_weeks=duration_for(
                        lead_times, workflow_id, category.value, spec.step_id
                    ),
                    status=WorkflowStepStatus(prog.status),
                    percent_complete=prog.percent_complete,
                    actual_start_week=prog.actual_start_week,
                    actual_end_week=prog.actual_end_week,
                )
            )
        # SYNTHETIC rubric scores (ADR 0035, c26.SYNTHETIC_DIMENSION_SCORES):
        # no client source holds them; kept so the Matrix is not empty.
        dims = c26.derive_dims(p["external_code"], p["priority"], p["marketing_priority"])
        session.add(seed_priority_score(rubric, project.id, dims, tags=project.scoring_tags))
        if i in provisional:
            # ADR 0042 §7: the assignment is recorded like the migration's.
            after = project_audit_state(project)
            session.add(
                AuditLogEntry(
                    actor_user_id=None,
                    action="project.update",
                    entity_type="Project",
                    entity_id=str(project.id),
                    hub_id=project.hub_id,
                    before_state={
                        **after,
                        "leader_engineer_id": None,
                        "leader_is_provisional": False,
                    },
                    after_state={**after, "source": c26.PROVISIONAL_LEADER_SOURCE},
                    notes="seed: provisional leader for a leaderless OEM project (ADR 0042 §7)",
                )
            )
    await session.flush()

    # --- Summary run: one in-memory greedy run (nothing persisted) ---------
    schedule_input = await build_schedule_input_from_db(session, current_week=current_week)
    output = run_greedy_sgs(schedule_input)

    # Dashboard classification (I9): excluded and data-error projects are not
    # counted; then left out, on hold (blocked), within year, else spillover.
    verdicts: Counter[str] = Counter()
    for o in output.project_outcomes:
        if o.excluded or o.data_error is not None:
            continue
        if o.left_out:
            verdicts["left_out"] += 1
            if o.no_leader:
                verdicts["no_leader"] += 1
        elif o.blocked:
            verdicts["blocked"] += 1
        elif o.within_year:
            verdicts["within_year"] += 1
        else:
            verdicts["spillover"] += 1
    return {
        "engineers": len(engineers_by_name),
        "provisional_engineers": sum(1 for e in roster.engineers if e.provisional),
        "skipped_zero_fte_placeholders": len(roster.placeholders),
        "projects": len(projects),
        "projects_without_leader": sum(1 for n in leader_names if n is None),
        "provisional_leaders": len(provisional),
        "carry_over_projects": sum(1 for p in projects if c26.carry_over_and_reg_year(p)[0]),
        "summary_run": {
            "current_week": current_week,
            **{
                k: verdicts[k]
                for k in ("within_year", "spillover", "left_out", "no_leader", "blocked")
            },
        },
    }


_T0 = time.monotonic()


def _step(message: str) -> None:
    """Progress line on stderr (stdout stays the final JSON), with elapsed seconds."""

    print(f"[{time.monotonic() - _T0:6.1f}s] {message}", file=sys.stderr, flush=True)


async def _check_connection(engine: Any) -> None:
    _step("connecting to database (30s timeout)...")
    try:
        async with asyncio.timeout(30):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
    except TimeoutError:
        raise SystemExit(
            "Could not connect within 30s. Check the host/URL, that the database allows "
            "your IP (Render > Database > Access Control), and ?ssl=require."
        ) from None
    _step("connected")


async def schedule_after_seed(session_factory: async_sessionmaker[AsyncSession]) -> dict[str, Any]:
    """Compute and activate the first greedy `ScheduleRun` over the seeded rows.

    Same path as `POST /schedule-runs/greedy-recalc` but without an API user or
    a Celery worker, so a freshly seeded hosted database shows the Dashboard
    straight away instead of "No schedule computed yet".
    """

    async with session_factory() as session:
        _step("scheduling: reading projects/engineers/chambers...")
        schedule_input = await build_schedule_input_from_db(session)
        _step("scheduling: running greedy scheduler...")
        schedule_output = run_greedy_sgs(schedule_input)
        _step("scheduling: saving the schedule run (slowest step on a remote DB)...")
        run = await persist_schedule_output(
            session,
            schedule_input,
            schedule_output,
            solver_type=SolverType.GREEDY,
            trigger_reason="seed",
            triggered_by_user_id=None,
            activate=True,
        )
        await session.commit()
        _step("scheduling: done")
        return {
            "version": run.version,
            "projects": len(schedule_output.project_outcomes),
            "within_year": sum(1 for o in schedule_output.project_outcomes if o.within_year),
        }


async def run(
    reset_first: bool, dataset: str = DEFAULT_DATASET, schedule: bool = False
) -> dict[str, Any]:
    engine = create_async_engine(_database_url())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    counts: dict[str, Any] = {}
    try:
        await _check_connection(engine)
        preserved: _UserConfig | None = None
        async with session_factory() as session:
            if reset_first:
                _step("reset: deleting existing demo rows...")
                preserved = await _reset(session)
                _step("reset: done")
            else:
                await _guard_against_duplicate_seed(session)

            if dataset not in DATASETS:
                raise ValueError(f"unknown dataset {dataset!r}; expected one of {DATASETS}")
            counts["dataset"] = dataset

            _step("seeding workflows, hubs, chambers...")
            counts.update(await seed_workflows(session))
            hubs_by_name = await seed_hubs(session)
            counts["hubs"] = len(hubs_by_name)
            counts["hub_work_calendars"] = len(dc.HUB_WORK_CALENDAR_SEED)
            if dataset == DATASET_CLIENT_2026:
                chambers_by_code = await seed_chambers(session, deterministic_ids=True)
                counts["chambers"] = len(chambers_by_code)
                _step("seeding 253 client projects, engineers, steps...")
                counts.update(
                    await seed_client_2026(session, _load_client_2026_data(), hubs_by_name)
                )
                if preserved is not None:
                    counts["reset_user_config"] = await _restore_user_config(session, preserved)
                # ADR 0027: the curated VIP board (idempotent; links by name).
                counts["vip_board"] = await seed_vip_board(session)
            else:
                data = _load_prototype_data()
                engineers_by_name = await seed_engineers(session, data, hubs_by_name)
                counts["engineers"] = len(engineers_by_name)
                chambers_by_code = await seed_chambers(session)
                counts["chambers"] = len(chambers_by_code)
                counts["projects"] = await seed_projects(
                    session, data, hubs_by_name, engineers_by_name
                )
                if preserved is not None:
                    counts["reset_user_config"] = await _restore_user_config(session, preserved)
            counts["project_workflow_steps"] = counts["projects"] * dc.STEPS_PER_WORKFLOW
            counts["priority_scores"] = counts["projects"]

            _step("committing seed data...")
            await session.commit()
            _step("seed committed")

            # Post-commit verification: re-query actual row counts from the DB
            # rather than trusting the in-memory tallies above.
            verified: dict[str, int] = {}
            for model in _TABLES_CHILD_FIRST + _REFERENCE_TABLES:
                verified[model.__tablename__] = await _table_row_count(session, model)
            counts["_verified_from_db"] = verified

        if schedule:
            counts["schedule_run"] = await schedule_after_seed(session_factory)
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
    parser.add_argument(
        "--dataset",
        choices=DATASETS,
        default=DEFAULT_DATASET,
        help="client_2026 (default: the client's real 2026 pipeline) or prototype.",
    )
    parser.add_argument(
        "--schedule",
        action="store_true",
        help="After seeding, compute and activate the first greedy schedule run "
        "(no worker needed), so the Dashboard has data.",
    )
    args = parser.parse_args()
    counts = asyncio.run(
        run(reset_first=args.reset, dataset=args.dataset, schedule=args.schedule)
    )
    print(json.dumps(counts, indent=2, default=str))


if __name__ == "__main__":
    main()
