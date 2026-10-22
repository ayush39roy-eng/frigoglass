"""Prioritization Matrix surface — the scoring grid CRUD (rubric dimensions from
the `scoring_dimensions` table, ADR 0037) + read
models, currency-toggle-aware financial columns.
(`docs/DOMAIN_RULES.md` "Prioritization scoring"; `docs/PROJECT_AND_STACK.md` §2)

**Scope boundary — read before extending this file**: `PUT
/priorities/{project_id}` upserts `models.priority.PriorityScore` (the dimension
inputs + cached `weighted_score`/`normalized_pct`/`suggested_band`)
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
from collections.abc import Sequence
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import require_permission
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.enums import (
    CurrencyCode,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    ProjectType,
)
from models.priority import PriorityScore
from models.project import Project, canonical_tags
from schemas.priority import (
    BandShare,
    DimensionInfo,
    DimensionPoints,
    HubP1Fill,
    PriorityCapacityFill,
    PriorityCompareItem,
    PriorityCompareResponse,
    PriorityDimensionsResponse,
    PriorityDistribution,
    PriorityMatrixRow,
    PriorityPortfolioSummary,
    PriorityScoreRead,
    PriorityScoreUpdateRequest,
    ScoreHistogramBucket,
)
from services.audit_helpers import priority_score_audit_state
from services.capacity_hubs import capacity_rows_for_request
from services.currency import rate_to_eur as _currency_rate_to_eur
from services.hub_scope import global_hub_filter, hub_scope_filter, narrowed_hub_filter
from services.priority_capacity_fill import CapacityFill, RowFill, compute_capacity_fill
from services.priority_scoring import (
    Rubric,
    dimension_points,
    dimension_table,
)
from services.project_filters import (
    Q_MAX_LENGTH,
    leader_name_if_self,
    score_ranks,
    search_predicate,
)
from services.scoring_rubric import (
    UnknownDimensionKeyError,
    dimension_score_models,
    is_scored,
    load_rubric,
    lock_rubric,
    missing_keys,
    project_scores,
    served_rubric_version,
    write_project_scores,
)

router = APIRouter(prefix="/priorities", tags=["prioritization-matrix"])

_read = require_permission(Surface.MATRIX, Action.READ)
_write = require_permission(Surface.MATRIX, Action.WRITE)


async def _rate_to_eur(db: AsyncSession, currency: CurrencyCode) -> Decimal:
    """P21-T01: 422 `CURRENCY_NOT_CONFIGURED` when `currency` has no rate."""

    return await _currency_rate_to_eur(db, currency)


def _convert(amount: float | None, rate: Decimal) -> float | None:
    if amount is None:
        return None
    return float(Decimal(str(amount)) * rate)


def _dimension_points(
    rubric: Rubric, score: PriorityScore | None
) -> dict[str, DimensionPoints] | None:
    if not is_scored(score):
        return None
    pts = dimension_points(rubric, project_scores(rubric, score) or {})
    return {k: DimensionPoints(**v) for k, v in pts.items()}


def _build_row(
    project: Project,
    score: PriorityScore | None,
    currency: CurrencyCode,
    rate: Decimal,
    *,
    rubric: Rubric,
    current_user: Principal,
    rank: int | None,
    fill: RowFill,
) -> PriorityMatrixRow:
    return PriorityMatrixRow(
        project_id=project.id,
        project_name=project.name,
        hub=project.hub.name,
        category=project.category,
        type=project.type,
        set_priority=project.priority,
        status=project.status,
        leader_name=leader_name_if_self(project, current_user),
        leader_engineer_id=project.leader_engineer_id,
        rank=rank,
        has_score=is_scored(score),
        hard_gates=list(score.hard_gates) if score else [],
        weighted_score=(
            float(score.weighted_score) if score and score.weighted_score is not None else None
        ),
        normalized_pct=score.normalized_pct if score else None,
        suggested_band=fill.suggested_band,
        score_band=fill.score_band,
        capacity_fill=fill.capacity_fill,
        capacity_fill_reason=fill.capacity_fill_reason,
        dimension_points=_dimension_points(rubric, score),
        dimension_scores=dimension_score_models(rubric, score),
        missing_dimension_keys=missing_keys(rubric, score),
        rubric_version=served_rubric_version(rubric, score),
        scoring_tags=canonical_tags(project.scoring_tags),
        tag_dimension_keys=project.tag_dimension_keys,
        is_new_model=project.type == ProjectType.NM,
        is_rm_saving_project=project.rm_savings_keur is not None,
        is_vip=project.is_vip,
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
    region: LabRegion | None = None,
    category: ProjectCategory | None = None,
    type_: Annotated[ProjectType | None, Query(alias="type")] = None,
    status_: ProjectStatus | None = None,
    q: Annotated[str | None, Query(max_length=Q_MAX_LENGTH)] = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[PriorityMatrixRow]:
    """The scoring grid, one row per project (left-joined to `PriorityScore`
    so projects not yet scored still appear, with `has_score=False`).

    P13-T14 (docs/API_CONTRACT_P13.md §7): `type`, `status_` and `q` (name
    or external code, §3 semantics) are ANDed with the scope and the other
    filters. `rank` is computed within the final filtered set. Financial
    columns are unchanged and never logged.
    """

    # P21-T01: resolve the rate first, so an unconfigured currency is a 422
    # before any project row is read.
    rate = await _rate_to_eur(db, currency)
    projects = await _matrix_projects(
        db,
        current_user,
        hub_id=hub_id,
        region=region,
        category=category,
        type_=type_,
        status_=status_,
        q=q,
    )
    ranks = score_ranks(projects, _score_value)
    fill = await compute_capacity_fill(db, {p.hub_id for p in projects})
    rubric = await load_rubric(db)
    rows = [
        _build_row(
            p,
            p.priority_score,
            currency,
            rate,
            rubric=rubric,
            current_user=current_user,
            rank=ranks.get(p.id),
            fill=_row_fill(fill, p),
        )
        for p in projects
    ]
    rows.sort(
        key=lambda r: (
            0 if r.rank is not None else 1,
            r.rank if r.rank is not None else 0,
            r.project_name.lower(),
        )
    )
    return rows


async def _matrix_projects(
    db: AsyncSession,
    current_user: Principal,
    *,
    hub_id: uuid.UUID | None,
    region: LabRegion | None,
    category: ProjectCategory | None,
    type_: ProjectType | None,
    status_: ProjectStatus | None,
    q: str | None,
) -> Sequence[Project]:
    """The Matrix's row set: hub scope AND the global hub / country filter AND
    the toolbar filters. Shared by `GET /priorities` and
    `GET /priorities/distribution` so their counts always reconcile."""

    stmt = select(Project).options(
        selectinload(Project.hub),
        selectinload(Project.priority_score),
        selectinload(Project.leader_engineer),
    )
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    # ADR 0020 hub / ADR 0025 country, ANDed with the scope above.
    global_filter = global_hub_filter(Project.hub_id, hub_id, region)
    if global_filter is not None:
        stmt = stmt.where(global_filter)
    if category is not None:
        stmt = stmt.where(Project.category == category)
    if type_ is not None:
        stmt = stmt.where(Project.type == type_)
    if status_ is not None:
        stmt = stmt.where(Project.status == status_)
    search = search_predicate(q)
    if search is not None:
        stmt = stmt.where(search)
    stmt = stmt.order_by(Project.name)
    return (await db.execute(stmt)).scalars().all()


def _row_fill(fill: CapacityFill, project: Project) -> RowFill:
    """ADR 0036: the row's promoted / score band from the hub's capacity fill."""

    score = project.priority_score
    return fill.for_row(project.id, project.hub_id, score.suggested_band if score else None)


def _score_value(project: Project) -> float | None:
    score = project.priority_score
    if score is None or score.weighted_score is None:
        return None
    return float(score.weighted_score)


@router.get("/dimensions", response_model=PriorityDimensionsResponse)
async def priority_dimensions(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PriorityDimensionsResponse:
    """The ACTIVE dimensions of the current rubric (labels, pillars, weights,
    weights scaled to 100) and `total_weight`, served so the browser never
    computes them (ADR 0029, I9; ADR 0037: from the rubric tables)."""

    rubric = await load_rubric(db)
    return PriorityDimensionsResponse(
        dimensions=[DimensionInfo.model_validate(d) for d in dimension_table(rubric)],
        total_weight=rubric.total_weight,
        rubric_version=rubric.version,
    )


@router.get("/summary", response_model=PriorityPortfolioSummary)
async def priority_portfolio_summary(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PriorityPortfolioSummary:
    """Portfolio decision summary — band/priority counts across all projects
    in the caller's hub scope (P3-T03) — the summary label says "portfolio"
    but a Hub Planner must only see their own hub's counts here, same as
    every other read on this router."""

    stmt = select(Project).options(selectinload(Project.priority_score))
    # P12 (ADR 0020): optional `hub_id`, ANDed with the scope, never widening.
    hub_filter = narrowed_hub_filter(current_user, Project.hub_id, hub_id, region)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    projects = (await db.execute(stmt)).scalars().all()

    scored = [p for p in projects if is_scored(p.priority_score)]
    # ADR 0036: `suggested_band_counts` follow the promoted band, the score
    # band is counted separately.
    fill = await compute_capacity_fill(db, {p.hub_id for p in projects})
    row_fills = [_row_fill(fill, p) for p in scored]
    suggested_band_counts = Counter(
        f.suggested_band.value for f in row_fills if f.suggested_band is not None
    )
    score_band_counts = Counter(f.score_band.value for f in row_fills if f.score_band is not None)
    set_priority_counts = Counter(p.priority.value for p in projects if p.priority is not None)
    hard_gate_forced = sum(1 for p in scored if p.priority_score.hard_gates)

    return PriorityPortfolioSummary(
        total_projects=len(projects),
        scored_projects=len(scored),
        unscored_projects=len(projects) - len(scored),
        hard_gate_forced_count=hard_gate_forced,
        suggested_band_counts=dict(suggested_band_counts),
        score_band_counts=dict(score_band_counts),
        capacity_fill_count=sum(1 for f in row_fills if f.capacity_fill),
        set_priority_counts=dict(set_priority_counts),
    )


#: P21-T01: the fixed bucket order of `band_distribution`. "Q" is a committed
#: priority, never a score band, so its count is 0 under the current rules; it
#: is listed so the chart's legend is stable.
_DISTRIBUTION_BANDS: tuple[str, ...] = ("P1", "P2", "P3", "P4", "Q", "Unscored")
_HISTOGRAM_WIDTH = 10
COMPARE_MIN = 2
COMPARE_MAX = 5


def _share(count: int, total: int) -> float:
    return round(count * 100 / total, 2) if total else 0.0


def _histogram_bucket(pct: int) -> int:
    """Index of the 10-point bucket; 100 falls into the last bucket [90, 100]."""

    return min(max(pct, 0) // _HISTOGRAM_WIDTH, 100 // _HISTOGRAM_WIDTH - 1)


@router.get("/distribution", response_model=PriorityDistribution)
async def priority_distribution(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    category: ProjectCategory | None = None,
    type_: Annotated[ProjectType | None, Query(alias="type")] = None,
    status_: ProjectStatus | None = None,
    q: Annotated[str | None, Query(max_length=Q_MAX_LENGTH)] = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PriorityDistribution:
    """P21-T01 (docs/API_CONTRACT_P21.md §4): band distribution and a 10-point
    histogram of `normalized_pct` over exactly the rows `GET /priorities`
    returns for the same filters and scope. A band is the row's served
    `suggested_band`, i.e. after the P1 capacity fill (ADR 0036); promoted
    rows are also counted in `capacity_fill_count`. A project without a score
    is "Unscored". No financial field is read."""

    projects = await _matrix_projects(
        db,
        current_user,
        hub_id=hub_id,
        region=region,
        category=category,
        type_=type_,
        status_=status_,
        q=q,
    )
    total = len(projects)
    fill = await compute_capacity_fill(db, {p.hub_id for p in projects})
    counts: Counter[str] = Counter()
    histogram = [0] * (100 // _HISTOGRAM_WIDTH)
    scored = 0
    filled = 0
    for p in projects:
        score = p.priority_score
        row_fill = _row_fill(fill, p)
        if score is None or row_fill.suggested_band is None:
            counts["Unscored"] += 1
            continue
        scored += 1
        filled += row_fill.capacity_fill
        counts[row_fill.suggested_band.value] += 1
        if score.normalized_pct is not None:
            histogram[_histogram_bucket(score.normalized_pct)] += 1
    return PriorityDistribution(
        total_projects=total,
        scored_projects=scored,
        capacity_fill_count=filled,
        band_distribution=[
            BandShare(band=band, count=counts[band], share_pct=_share(counts[band], total))
            for band in _DISTRIBUTION_BANDS
        ],
        score_histogram=[
            ScoreHistogramBucket(
                bucket_from=i * _HISTOGRAM_WIDTH,
                bucket_to=(i + 1) * _HISTOGRAM_WIDTH,
                count=n,
            )
            for i, n in enumerate(histogram)
        ],
    )


@router.get("/capacity-fill", response_model=PriorityCapacityFill)
async def priority_capacity_fill(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PriorityCapacityFill:
    """P25-T01 (ADR 0036, docs/API_CONTRACT_P25.md §2): the P1 capacity fill of
    every hub in the caller's scope, narrowed by the global `hub_id` /
    `region` filter (never widened; out of scope → `hubs: []`). Read only:
    never writes a committed priority or a score.

    P29 (ADR 0042, docs/API_CONTRACT_P29.md §4): one entry per CAPACITY hub
    with a hub in scope AND the filter; R&D-Greece's walk covers OEM-HCK and
    OEM-Seitek (`members`), and `hub_id` = an OEM hub selects it."""

    cmap, row_scopes = await capacity_rows_for_request(db, current_user, hub_id, region)
    fill = await compute_capacity_fill(db, [r.capacity_hub_id for r in row_scopes])
    out: list[HubP1Fill] = []
    for scope in row_scopes:
        hub_fill = fill.hubs[scope.capacity_hub_id]
        out.append(
            HubP1Fill(
                hub=cmap.name(scope.capacity_hub_id),
                capacity_weeks=float(hub_fill.capacity_weeks),
                base_load_weeks=float(hub_fill.base_load_weeks),
                filled_load_weeks=float(hub_fill.filled_load_weeks),
                promoted_count=len(hub_fill.promoted_ids),
                members=[cmap.name(m) for m in scope.member_ids if m != scope.capacity_hub_id],
                selected_member=(
                    cmap.name(scope.selected_member) if scope.selected_member is not None else None
                ),
            )
        )
    return PriorityCapacityFill(
        has_active_schedule_run=fill.run is not None,
        schedule_run_version=fill.run.version if fill.run is not None else None,
        hubs=out,
    )


def _compare_error(code: str, detail: str) -> CodedHTTPException:
    return CodedHTTPException(status_code=HTTP_422, code=code, detail=detail)


@router.get("/compare", response_model=PriorityCompareResponse)
async def compare_priorities(
    project_id: Annotated[list[uuid.UUID], Query()],
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PriorityCompareResponse:
    """P21-T01 (docs/API_CONTRACT_P21.md §5): 2-5 distinct projects side by
    side, in the order given. Hub-scoped: an unknown id and an id outside the
    caller's scope give the same 422 `COMPARE_PROJECT_UNAVAILABLE`, which does
    not say which id failed, so existence is never revealed. No financial
    fields."""

    if not COMPARE_MIN <= len(project_id) <= COMPARE_MAX:
        raise _compare_error(
            "COMPARE_COUNT",
            f"Compare takes {COMPARE_MIN} to {COMPARE_MAX} project_id values.",
        )
    if len(set(project_id)) != len(project_id):
        raise _compare_error("COMPARE_DUPLICATE", "Each project_id may appear only once.")

    stmt = (
        select(Project)
        .options(selectinload(Project.hub), selectinload(Project.priority_score))
        .where(Project.id.in_(project_id))
    )
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    found = {p.id: p for p in (await db.execute(stmt)).scalars().all()}
    if len(found) != len(project_id):
        raise _compare_error(
            "COMPARE_PROJECT_UNAVAILABLE",
            "One or more projects cannot be compared.",
        )

    fill = await compute_capacity_fill(db, {p.hub_id for p in found.values()})
    rubric = await load_rubric(db)
    items: list[PriorityCompareItem] = []
    for pid in project_id:
        p = found[pid]
        score = p.priority_score
        row_fill = _row_fill(fill, p)
        items.append(
            PriorityCompareItem(
                project_id=p.id,
                project_name=p.name,
                hub=p.hub.name,
                set_priority=p.priority,
                has_score=is_scored(score),
                weighted_score=(
                    float(score.weighted_score)
                    if score is not None and score.weighted_score is not None
                    else None
                ),
                normalized_pct=score.normalized_pct if score is not None else None,
                suggested_band=row_fill.suggested_band,
                score_band=row_fill.score_band,
                capacity_fill=row_fill.capacity_fill,
                capacity_fill_reason=row_fill.capacity_fill_reason,
                dimension_scores=dimension_score_models(rubric, score),
                missing_dimension_keys=missing_keys(rubric, score),
                rubric_version=served_rubric_version(rubric, score),
            )
        )
    return PriorityCompareResponse(projects=items)


@router.get("/{project_id}", response_model=PriorityMatrixRow)
async def get_priority_row(
    project_id: uuid.UUID,
    currency: CurrencyCode = CurrencyCode.EUR,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PriorityMatrixRow:
    stmt = (
        select(Project)
        .options(
            selectinload(Project.hub),
            selectinload(Project.priority_score),
            selectinload(Project.leader_engineer),
        )
        .where(Project.id == project_id)
    )
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    project = (await db.execute(stmt)).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    rate = await _rate_to_eur(db, currency)
    fill = await compute_capacity_fill(db, {project.hub_id})
    rubric = await load_rubric(db)
    return _build_row(
        project,
        project.priority_score,
        currency,
        rate,
        rubric=rubric,
        current_user=current_user,
        rank=None,
        fill=_row_fill(fill, project),
    )


@router.put("/{project_id}", response_model=PriorityScoreRead)
async def upsert_priority_score(
    project_id: uuid.UUID,
    body: PriorityScoreUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> PriorityScoreRead:
    """Create or update one project's dimension scores (ADR 0037: keyed by
    ACTIVE rubric dimension key, 0..5 or null; 422 `UNKNOWN_DIMENSION_KEY`
    otherwise). Recomputes `weighted_score`/`normalized_pct`/`suggested_band`
    against the current rubric (under the shared rubric lock, so a concurrent
    rubric save cannot interleave) — never trusts a client-supplied value for
    those cached fields. Does NOT touch `Project.priority` — see module
    docstring.
    """

    stmt = select(Project).where(Project.id == project_id)
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    project = (await db.execute(stmt)).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    await lock_rubric(db, exclusive=False)
    rubric = await load_rubric(db)
    existing = (
        await db.execute(select(PriorityScore).where(PriorityScore.project_id == project_id))
    ).scalar_one_or_none()

    before_state = priority_score_audit_state(existing, rubric) if existing else None
    action = "priority_score.update" if existing else "priority_score.create"

    score = existing or PriorityScore(project_id=project_id, dimension_scores=[])
    try:
        write_project_scores(rubric, score, body.scores)
    except UnknownDimensionKeyError as exc:
        raise CodedHTTPException(
            status_code=HTTP_422,
            code="UNKNOWN_DIMENSION_KEY",
            detail=f"Not an active scoring dimension: {', '.join(exc.keys)}.",
        ) from exc
    score.hard_gates = body.hard_gates
    score.scored_at = func.now()
    score.scored_by_user_id = current_user.user_id
    if existing is None:
        db.add(score)
    await db.flush()
    after_state = priority_score_audit_state(score, rubric)

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
    return priority_score_read(rubric, score)


def priority_score_read(rubric: Rubric, score: PriorityScore) -> PriorityScoreRead:
    return PriorityScoreRead(
        id=score.id,
        project_id=score.project_id,
        hard_gates=list(score.hard_gates),
        weighted_score=float(score.weighted_score) if score.weighted_score is not None else None,
        normalized_pct=score.normalized_pct,
        suggested_band=score.suggested_band,
        dimension_scores=dimension_score_models(rubric, score),
        missing_dimension_keys=missing_keys(rubric, score),
        rubric_version=served_rubric_version(rubric, score),
    )
