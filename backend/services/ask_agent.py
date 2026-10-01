"""ADR 0014: "Ask the agent" on the Project Workspace, via Groq.

Two responsibilities, deliberately kept apart:

1. `build_agent_context` — an explicit ALLOWLIST of already-visible,
   non-sensitive fields for one project. Every key returned is named
   individually below and traced to a specific column; the four financial
   columns (`Project.customer_name`/`tcogs_eur`/`selling_price_eur`/
   `gross_margin_pct`) and every real person's name (`Engineer.name`,
   `User.full_name`) are simply never read by this function — not filtered
   out afterwards, never queried at all — so there is no value here to leak
   regardless of the asker's own role or project-access level (ADR 0014
   §2). An assigned engineer is described only as "assigned"/"unassigned"
   per step; a chamber code is not personal data and is included as-is.
2. `ask_about_project` — the one narrow interface to Groq's OpenAI-compatible
   chat-completions endpoint. Stateless: one question in, one answer out, no
   conversation history stored (ADR 0014 §4).
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from core.config import get_groq_settings
from models.enums import WorkflowStepKind
from models.project import Project
from models.schedule import ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from models.workspace import ProjectComment, ProjectFile
from scheduling.workflow import derive_remaining
from services.active_run import get_active_run
from services.progress import project_progress_pct
from services.workspace import health_badge, is_step_skipped

_GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions"
_HTTP_TIMEOUT_SECONDS = 30.0

SYSTEM_PROMPT = (
    "You are answering questions about ONE Frigoglass R&D/Product Development "
    "project, from a JSON context provided in the user message. That context "
    "has ALREADY had every financial figure (cost, margin, selling price) and "
    "customer name removed before it reached you, and it never names a real "
    "person — engineers are described only by role and workflow step (e.g. "
    "'design engineer assigned: true'), never by name. Never invent, guess, or "
    "reconstruct a financial figure, a customer name, or a person's name: if "
    "asked for one, say plainly that this assistant does not have access to "
    "it. Answer only from the given context; do not use outside knowledge "
    "about Frigoglass or any other company."
)


class AgentUnavailable(Exception):
    """Raised by `ask_about_project` when `RPD_GROQ_API_KEY` is unset. The
    router maps this to `503 {"error": "AGENT_UNAVAILABLE"}` (ADR 0014 §3).
    """


async def build_agent_context(db: AsyncSession, project: Project) -> dict[str, Any]:
    run = await get_active_run(db)

    templates = (
        (
            await db.execute(
                select(WorkflowStepTemplate)
                .where(WorkflowStepTemplate.workflow_id == project.workflow_id)
                .order_by(WorkflowStepTemplate.sequence_order)
            )
        )
        .scalars()
        .all()
    )
    live_rows = (
        (
            await db.execute(
                select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id == project.id)
            )
        )
        .scalars()
        .all()
    )
    live_by_step = {r.step_template_id: r for r in live_rows}

    outcome: ScheduleRunProjectOutcome | None = None
    run_steps: list[ScheduleRunProjectStep] = []
    if run is not None:
        outcome = (
            await db.execute(
                select(ScheduleRunProjectOutcome).where(
                    ScheduleRunProjectOutcome.schedule_run_id == run.id,
                    ScheduleRunProjectOutcome.project_id == project.id,
                )
            )
        ).scalar_one_or_none()
        run_steps = list(
            (
                await db.execute(
                    select(ScheduleRunProjectStep).where(
                        ScheduleRunProjectStep.schedule_run_id == run.id,
                        ScheduleRunProjectStep.project_id == project.id,
                    )
                )
            )
            .scalars()
            .all()
        )
    run_by_step = {s.step_template_id: s for s in run_steps}

    stages: list[dict[str, Any]] = []
    for t in templates:
        live = live_by_step.get(t.id)
        run_step = run_by_step.get(t.id)
        duration = live.duration_weeks if live is not None else 0
        percent = live.percent_complete if live is not None else 0
        status_ = live.status.value if live is not None else "Not Started"
        skipped = (
            run_step.skipped
            if run_step is not None
            else is_step_skipped(duration, t.kind, project.certification_testing_required)
        )
        stages.append(
            {
                "code": t.code,
                "name": t.name,
                "kind": t.kind.value,
                "sequence_order": t.sequence_order,
                "duration_weeks": duration,
                "skipped": skipped,
                "planned_start_week": run_step.start_week if run_step is not None else None,
                "planned_end_week": run_step.end_week if run_step is not None else None,
                "actual_start_week": live.actual_start_week if live is not None else None,
                "actual_end_week": live.actual_end_week if live is not None else None,
                "status": status_,
                "percent_complete": percent,
                "remaining_weeks": (
                    0
                    if skipped
                    else derive_remaining(
                        duration, percent, live.remaining_weeks_override if live else None
                    )
                ),
                "blocked_reason": live.blocked_reason if live is not None else None,
                # Never a name (ADR 0014 §2) — role/step only, and only a
                # boolean "is someone assigned", never who.
                "design_engineer_assigned": (
                    run_step is not None and run_step.assigned_engineer_id is not None
                )
                if t.kind == WorkflowStepKind.DESIGN
                else None,
                "lab_chamber_assigned": (
                    run_step is not None and run_step.assigned_chamber_id is not None
                )
                if t.kind == WorkflowStepKind.LAB
                else None,
            }
        )

    kind_by_step = {t.id: t.kind for t in templates}
    progress = project_progress_pct(
        (
            r.percent_complete,
            0
            if is_step_skipped(
                r.duration_weeks,
                kind_by_step.get(r.step_template_id, WorkflowStepKind.DESIGN),
                project.certification_testing_required,
            )
            else r.duration_weeks,
        )
        for r in live_rows
    )
    health = health_badge(
        outcome, run_steps, live_by_step, run.current_week if run is not None else dc.CURRENT_WEEK
    )

    files = (
        (await db.execute(select(ProjectFile).where(ProjectFile.project_id == project.id)))
        .scalars()
        .all()
    )
    comments = (
        (
            await db.execute(
                select(ProjectComment).where(
                    ProjectComment.project_id == project.id,
                    ProjectComment.soft_deleted_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )

    return {
        "project": {
            "name": project.name,
            "external_code": project.external_code,
            "category": project.category.value if project.category else None,
            "type": project.type.value if project.type else None,
            "status": project.status.value,
            "priority": project.priority.value if project.priority else None,
            "frozen": project.frozen,
            "actual_start_week": project.actual_start_week,
            "target_end_week": project.target_end_week,
            "reg_year": project.reg_year,
            "carry_over": project.carry_over,
            "certification_testing_required": project.certification_testing_required,
            "estimated_design_weeks": (
                float(project.estimated_design_weeks)
                if project.estimated_design_weeks is not None
                else None
            ),
            "estimated_lab_weeks": (
                float(project.estimated_lab_weeks)
                if project.estimated_lab_weeks is not None
                else None
            ),
            "notes": project.comments,
        },
        "health": health,
        "schedule": {
            "expected_end_week": outcome.expected_end_week if outcome is not None else None,
            "projected_end_week": outcome.projected_end_week if outcome is not None else None,
            "unconstrained_end_week": (
                outcome.unconstrained_end_week if outcome is not None else None
            ),
            "within_year": outcome.within_year if outcome is not None else None,
            "left_out": outcome.left_out if outcome is not None else False,
            "schedule_stale": project.schedule_stale,
        },
        "progress_pct": progress,
        "stages": stages,
        "files": [
            {
                "display_name": f.display_name,
                "category": f.category.value,
                "version": f.version,
                "description": f.description,
            }
            for f in files
        ],
        "comments": [{"body_md": c.body_md} for c in comments],
    }


async def ask_about_project(context: dict[str, Any], question: str) -> str:
    """Calls Groq's OpenAI-compatible chat-completions endpoint with
    `SYSTEM_PROMPT` plus the given (already-redacted) `context` and
    `question`. Raises `AgentUnavailable` if no API key is configured —
    checked BEFORE making any network call, so an unconfigured deployment
    never dials out at all.
    """

    settings = get_groq_settings()
    if not settings.api_key:
        raise AgentUnavailable()

    user_content = (
        "Project context (JSON):\n"
        f"{json.dumps(context)}\n\n"
        f"Question: {question}"
    )
    payload = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
    }
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
        response = await client.post(
            _GROQ_CHAT_COMPLETIONS_URL,
            headers={"Authorization": f"Bearer {settings.api_key}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
    return str(data["choices"][0]["message"]["content"])
