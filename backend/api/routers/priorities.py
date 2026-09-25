"""Prioritization Matrix surface — the 13-dimension scoring grid CRUD + read
models, currency-toggle-aware financial columns.
(`docs/DOMAIN_RULES.md` "Prioritization scoring"; `docs/PROJECT_AND_STACK.md` §2)

**Scope boundary — read before extending this file**: `PUT
/priorities/{project_id}` upserts `models.priority.PriorityScore` (the 13
dimension inputs + cached `weighted_score`/`normalized_pct`/`suggested_band`)
ONLY. It deliberately never writes `Project.priority` ("set_priority") —
per `models/priority.py`'s own docstring, `suggested_band` "may differ from
`Project.priority` if a Portfolio Manager manually overrides it," which only
makes sense if editing the score doesn't also silently overwrite the
committed priority. Committing a new portfolio-wide priority assignment
(writing `Project.priority`, creating a versioned `PriorityApplicationRun` +
`PriorityApplicationResult` rows, and re-triggering scheduling) is the "Apply
Priorities" action — `docs/PROJECT_AND_STACK.md` §2 — explicitly deferred to
P3-T06 per this task's scope note. Nothing here builds or stubs it.

**RBAC (P3-T02)**: every endpoint requires a validated OIDC token (401 if
missing/invalid). Reads need `MATRIX`/`READ` (Portfolio Manager, Hub Planner,
Executive Viewer, Admin). The `PUT` upsert needs `MATRIX`/`WRITE` — per
`docs/PROJECT_AND_STACK.md` §5, only Portfolio Manager and Admin hold write
access to the Matrix; Hub Planner is read-only here (unlike most other
surfaces, where Hub Planner gets R/W).

**Hub-scoped (P3-T03)**: every read below is filtered to the caller's own
hub(s) via `services.hub_scope` unless `current_user.hub_scope_all` — a Hub
Planner's grid/summary is silently filtered, and a direct `GET
/priorities/{project_id}` on an out-of-scope project 404s. The `PUT` upsert
applies the same filter to its own project lookup for defense-in-depth, even
though in practice only Portfolio Manager/Admin (both `hub_scope_all=True`)
ever reach `MATRIX`/`WRITE` — Hub Planner is READ-only here.
"""

from __future__ import annotations

import uuid
from collections import Counter
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.currency import CurrencyRate
from models.enums import CurrencyCode, ProjectCategory, ProjectPriority, ProjectType
from models.priority import DIMENSION_FIELD_NAMES, PriorityScore
from models.project import Project
from schemas.priority import (
    PriorityMatrixRow,
    PriorityPortfolioSummary,
    PriorityScoreRead,
    PriorityScoreUpdateRequest,
)
from services.audit_helpers import priority_score_audit_state
from services.hub_scope import hub_scope_filter
from services.priority_scoring import compute_priority_score

router = APIRouter(prefix="/priorities", tags=["prioritization-matrix"])

_read = require_permission(Surface.MATRIX, Action.READ)
_write = require_permission(Surface.MATRIX, Action.WRITE)


async def _rate_to_eur(db: AsyncSession, currency: CurrencyCode) -> Decimal:
    if currency == CurrencyCode.EUR:
        return Decimal("1.0")
    result = await db.execute(select(CurrencyRate).where(CurrencyRate.currency_code == currency))
    rate = result.scalar_one_or_none()
    if rate is None:  # pragma: no cover - defensive; CurrencyRate is seeded for all 3 codes
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"No currency_rates row for {currency.value!r}",
        )
    return Decimal(str(rate.rate_to_eur))


def _convert(amount: float | None, rate: Decimal) -> float | None:
    if amount is None:
        return None
    return float(Decimal(str(amount)) * rate)


def _build_row(
    project: Project,
    score: PriorityScore | None,
    currency: CurrencyCode,
    rate: Decimal,
) -> PriorityMatrixRow:
    return PriorityMatrixRow(
        project_id=project.id,
        project_name=project.name,
        hub=project.hub.name,
        category=project.category,
        type=project.type,
        set_priority=project.priority,
        has_score=score is not None,
        strategic_project=getattr(score, "strategic_project", None),
        new_customer=getattr(score, "new_customer", None),
        new_options=getattr(score, "new_options", None),
        regulatory_compliance=getattr(score, "regulatory_compliance", None),
        quality_improvements=getattr(score, "quality_improvements", None),
        rm_savings=getattr(score, "rm_savings", None),
        total_rm_savings=getattr(score, "total_rm_savings", None),
        gross_margins=getattr(score, "gross_margins", None),
        profitability=getattr(score, "profitability", None),
        annual_volume=getattr(score, "annual_volume", None),
        three_year_volume=getattr(score, "three_year_volume", None),
        new_models=getattr(score, "new_models", None),
        capex_investment=getattr(score, "capex_investment", None),
        hard_gates=list(score.hard_gates) if score else [],
        weighted_score=(
            float(score.weighted_score) if score and score.weighted_score is not None else None
        ),
        normalized_pct=score.normalized_pct if score else None,
        suggested_band=score.suggested_band if score else None,
        is_new_model=project.type == ProjectType.NM,
        is_rm_saving_project=project.rm_savings_keur is not None,
        currency=currency,
        capex_keur=_convert(
            float(project.capex_keur) if project.capex_keur is not None else None, rate
        ),
        rm_savings_keur=_convert(
            float(project.rm_savings_keur) if project.rm_savings_keur is not None else None, rate
        ),
        tcogs_eur=_convert(
            float(project.tcogs_eur) if project.tcogs_eur is not None else None, rate
        ),
        selling_price_eur=_convert(
            float(project.selling_price_eur) if project.selling_price_eur is not None else None,
            rate,
        ),
        gross_margin_pct=(
            float(project.gross_margin_pct) if project.gross_margin_pct is not None else None
        ),
    )


@router.get("", response_model=list[PriorityMatrixRow])
async def list_priority_matrix(
    currency: CurrencyCode = CurrencyCode.EUR,
    hub_id: uuid.UUID | None = None,
    category: ProjectCategory | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[PriorityMatrixRow]:
    """The scoring grid, one row per project (left-joined to `PriorityScore`
    so projects not yet scored still appear, with `has_score=False`).
    """

    stmt = select(Project).options(selectinload(Project.hub), selectinload(Project.priority_score))
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    if hub_id is not None:
        stmt = stmt.where(Project.hub_id == hub_id)
    if category is not None:
        stmt = stmt.where(Project.category == category)
    stmt = stmt.order_by(Project.name)

    projects = (await db.execute(stmt)).scalars().all()
    rate = await _rate_to_eur(db, currency)
    return [_build_row(p, p.priority_score, currency, rate) for p in projects]


@router.get("/summary", response_model=PriorityPortfolioSummary)
async def priority_portfolio_summary(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PriorityPortfolioSummary:
    """Portfolio decision summary — band/priority counts across all projects
    in the caller's hub scope (P3-T03) — the summary label says "portfolio"
    but a Hub Planner must only see their own hub's counts here, same as
    every other read on this router."""

    stmt = select(Project).options(selectinload(Project.priority_score))
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    projects = (await db.execute(stmt)).scalars().all()

    scored = [p for p in projects if p.priority_score is not None]
    suggested_band_counts = Counter(
        p.priority_score.suggested_band.value
        for p in scored
        if p.priority_score.suggested_band is not None
    )
    set_priority_counts = Counter(p.priority.value for p in projects if p.priority is not None)
    hard_gate_forced = sum(1 for p in scored if p.priority_score.hard_gates)

    return PriorityPortfolioSummary(
        total_projects=len(projects),
        scored_projects=len(scored),
        unscored_projects=len(projects) - len(scored),
        hard_gate_forced_count=hard_gate_forced,
        suggested_band_counts=dict(suggested_band_counts),
        set_priority_counts=dict(set_priority_counts),
    )


@router.get("/{project_id}", response_model=PriorityMatrixRow)
async def get_priority_row(
    project_id: uuid.UUID,
    currency: CurrencyCode = CurrencyCode.EUR,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PriorityMatrixRow:
    stmt = (
        select(Project)
        .options(selectinload(Project.hub), selectinload(Project.priority_score))
        .where(Project.id == project_id)
    )
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    project = (await db.execute(stmt)).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    rate = await _rate_to_eur(db, currency)
    return _build_row(project, project.priority_score, currency, rate)


@router.put("/{project_id}", response_model=PriorityScoreRead)
async def upsert_priority_score(
    project_id: uuid.UUID,
    body: PriorityScoreUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> PriorityScore:
    """Create or update the 13-dimension score for one project. Recomputes
    `weighted_score`/`normalized_pct`/`suggested_band` via
    `services.priority_scoring.compute_priority_score` — never trusts a
    client-supplied value for those three cached fields (they are not even
    accepted in the request body). Does NOT touch `Project.priority` — see
    module docstring.
    """

    stmt = select(Project).where(Project.id == project_id)
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    project = (await db.execute(stmt)).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    dims = [getattr(body, name) for name in DIMENSION_FIELD_NAMES]
    weighted_score, normalized_pct, suggested_band_str = compute_priority_score(dims)
    suggested_band = ProjectPriority(suggested_band_str)

    existing = (
        await db.execute(select(PriorityScore).where(PriorityScore.project_id == project_id))
    ).scalar_one_or_none()

    before_state = priority_score_audit_state(existing) if existing else None
    action = "priority_score.update" if existing else "priority_score.create"

    score = existing or PriorityScore(project_id=project_id)
    for name in DIMENSION_FIELD_NAMES:
        setattr(score, name, getattr(body, name))
    score.hard_gates = body.hard_gates
    score.weighted_score = weighted_score
    score.normalized_pct = normalized_pct
    score.suggested_band = suggested_band
    if existing is None:
        db.add(score)
    await db.flush()
    after_state = priority_score_audit_state(score)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action=action,
            entity_type="PriorityScore",
            entity_id=str(score.id),
            hub_id=project.hub_id,
            before_state=before_state,
            after_state=after_state,
        )
    )
    await db.commit()
    await db.refresh(score)
    return score
