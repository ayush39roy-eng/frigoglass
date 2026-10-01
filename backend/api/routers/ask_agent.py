"""ADR 0014: "Ask the agent" on the Project Workspace, via Groq.

`POST /projects/{id}/ask-agent {question}` answers a free-text question
about one project from data the asker can already see. Requires at least
Viewer-level `effective_project_access` (ADR 0012's resolver) — 403
otherwise. No-ops with `503 {"error": "AGENT_UNAVAILABLE"}` when
`RPD_GROQ_API_KEY` is unset (checked before any outbound call). Rate-limited
per user (mirrors `api/routers/workspace.py`'s `COMMENT_RATE_LIMIT`
in-process token-bucket pattern). Audit-logs actor, project and the
question text — safe to log per ADR 0014 §4: the asker is the one who typed
it, so it can never itself have been populated from the excluded
financial/PII fields (those were never in the context the asker is
answering from).
"""

from __future__ import annotations

import math
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import get_current_principal
from core.principal import Principal
from models.audit import AuditLogEntry
from models.project import Project
from schemas.ask_agent import AskAgentRequest, AskAgentResponse
from services.ask_agent import AgentUnavailable, ask_about_project, build_agent_context
from services.project_access import effective_project_access
from services.rate_limit import TokenBucketLimiter

router = APIRouter(prefix="/projects", tags=["ask-agent"])

#: A Groq call costs real money and has real latency (ADR 0014 §4) — a
#: tighter burst than the comment rate limiter (10/6s): 5 tokens, refilled
#: one every 12 seconds (5 per minute sustained).
ASK_AGENT_RATE_LIMIT = TokenBucketLimiter(capacity=5, refill_per_second=1 / 12)


async def _project_or_404(db: AsyncSession, project_id: uuid.UUID) -> Project:
    # A plain `select(...)` execute, not `db.get(...)`: `Project.workflow_id`
    # is a read-only correlated-subquery `column_property` (see
    # `models/project.py`), populated as part of a normal SELECT's column
    # list but NOT necessarily present on an identity-map hit from
    # `db.get()` for an instance that was only ever `flush()`-ed (never
    # re-selected) earlier in the same session — touching it there would
    # trigger an async-unsafe lazy-load. A `select(Project)` always
    # (re)populates it.
    project = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


@router.post("/{project_id}/ask-agent", response_model=AskAgentResponse)
async def ask_agent(
    project_id: uuid.UUID,
    body: AskAgentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> AskAgentResponse | JSONResponse:
    project = await _project_or_404(db, project_id)
    role = await effective_project_access(db, current_user, project)
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to ask the agent about this project.",
        )

    allowed, retry_after = ASK_AGENT_RATE_LIMIT.allow(str(current_user.user_id))
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many questions. Please wait a moment before asking again.",
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )

    context = await build_agent_context(db, project)
    try:
        answer = await ask_about_project(context, body.question)
    except AgentUnavailable:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"error": "AGENT_UNAVAILABLE"},
        )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The agent's upstream provider failed to answer.",
        ) from exc

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project.ask_agent",
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state=None,
            # Safe to log verbatim (ADR 0014 §4) — see module docstring.
            after_state={"question": body.question},
        )
    )
    await db.commit()
    return AskAgentResponse(answer=answer)
