"""The editable prioritization scoring rubric (ADR 0037, P26-T01,
docs/API_CONTRACT_P26.md).

- `GET /scoring-rubric`, `GET /scoring-rubric/versions`: every role with
  Matrix read (the rubric holds no project data).
- `PUT /scoring-rubric`, `POST /scoring-rubric/preview`: Admin and Super
  Admin only. The PUT is audited (`scoring_rubric.update`, before / after)
  and recomputes every stored score in the same transaction; it never marks
  a schedule stale (the scheduler does not read scores).
"""

from __future__ import annotations

import uuid
from collections import Counter

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_permission, require_roles
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from core.rbac import Action, Surface
from models.enums import RoleName
from models.scoring_rubric import RubricVersion
from schemas.scoring_rubric import (
    RubricBandChange,
    RubricPreviewProject,
    ScoringRubricDimension,
    ScoringRubricPreview,
    ScoringRubricPreviewRequest,
    ScoringRubricRead,
    ScoringRubricUpdateRequest,
    ScoringRubricVersionsResponse,
)
from services.priority_scoring import Rubric, RubricDimension, scaled_weight
from services.scoring_rubric import (
    ProposedDimension,
    RubricValidationError,
    RubricVersionConflictError,
    load_rubric,
    preview_rubric,
    resolve_proposal,
    save_rubric,
    user_names,
)

router = APIRouter(prefix="/scoring-rubric", tags=["scoring-rubric"])

_read = require_permission(Surface.MATRIX, Action.READ)
#: ADR 0037: only Admin and Super Admin change the rubric (ADR 0010: Super
#: Admin holds every Admin right).
_admin = require_roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)
_EDITORS = frozenset({RoleName.ADMIN, RoleName.SUPER_ADMIN})


def _dimensions(
    rubric: Rubric, *, existing: frozenset[uuid.UUID] | None = None
) -> list[ScoringRubricDimension]:
    return [
        ScoringRubricDimension(
            id=d.id if existing is None or d.id in existing else None,
            key=d.key,
            label=d.label,
            pillar=d.pillar,
            weight=d.weight,
            scaled_weight=scaled_weight(rubric, d.weight) if d.active else None,
            inverted=d.inverted,
            active=d.active,
            display_order=d.display_order,
        )
        for d in rubric.dimensions
    ]


def _pillars(rubric: Rubric) -> list[str]:
    return list(dict.fromkeys(d.pillar for d in rubric.dimensions))


def _rubric_from_snapshot(row: RubricVersion) -> Rubric:
    return Rubric(
        version=row.version,
        dimensions=tuple(
            RubricDimension(
                id=uuid.UUID(d["id"]),
                key=d["key"],
                label=d["label"],
                pillar=d["pillar"],
                weight=d["weight"],
                inverted=d["inverted"],
                active=d["active"],
                display_order=d["display_order"],
            )
            for d in sorted(row.dimensions, key=lambda d: (d["display_order"], d["key"]))
        ),
    )


def _read_model(
    rubric: Rubric, row: RubricVersion, names: dict[uuid.UUID, str], principal: Principal
) -> ScoringRubricRead:
    return ScoringRubricRead(
        version=rubric.version,
        total_weight=rubric.total_weight,
        changed_at=row.changed_at,
        changed_by_user_id=row.changed_by_user_id,
        changed_by_name=(
            names.get(row.changed_by_user_id) if row.changed_by_user_id is not None else None
        ),
        reason=row.reason,
        dimensions=_dimensions(rubric),
        pillars=_pillars(rubric),
        can_edit=bool(principal.roles & _EDITORS),
    )


async def _current_read(db: AsyncSession, principal: Principal) -> ScoringRubricRead:
    rubric = await load_rubric(db)
    row = (
        await db.execute(select(RubricVersion).where(RubricVersion.version == rubric.version))
    ).scalar_one()
    names = await user_names(db, [row.changed_by_user_id])
    return _read_model(rubric, row, names, principal)


def _proposed(body: ScoringRubricPreviewRequest) -> list[ProposedDimension]:
    return [
        ProposedDimension(
            key=d.key,
            label=d.label,
            pillar=d.pillar,
            weight=d.weight,
            inverted=d.inverted,
            active=d.active,
        )
        for d in body.dimensions
    ]


def _validation_error(exc: RubricValidationError) -> CodedHTTPException:
    return CodedHTTPException(status_code=HTTP_422, code=exc.code, detail=exc.detail)


@router.get("", response_model=ScoringRubricRead)
async def get_scoring_rubric(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> ScoringRubricRead:
    """The current rubric: every dimension (active and inactive), the current
    version and `total_weight` (Σ active weights)."""

    return await _current_read(db, current_user)


@router.get("/versions", response_model=ScoringRubricVersionsResponse)
async def list_scoring_rubric_versions(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> ScoringRubricVersionsResponse:
    """Every rubric version, newest first, each with its snapshot."""

    rows = (
        (await db.execute(select(RubricVersion).order_by(RubricVersion.version.desc())))
        .scalars()
        .all()
    )
    names = await user_names(db, [r.changed_by_user_id for r in rows])
    return ScoringRubricVersionsResponse(
        versions=[_read_model(_rubric_from_snapshot(r), r, names, current_user) for r in rows]
    )


@router.put("", response_model=ScoringRubricRead)
async def update_scoring_rubric(
    body: ScoringRubricUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_admin),
) -> ScoringRubricRead:
    """Full replacement (weights, labels, pillars, order, `inverted`, new
    dimensions, deactivate / reactivate; never a delete). `version` must be
    the current version, else 409 `RUBRIC_VERSION_CONFLICT`. Creates version
    N+1, recomputes every stored score and writes one audit row, in one
    transaction. An unchanged rubric is a 200 with no new version."""

    try:
        result = await save_rubric(
            db,
            current_user,
            expected_version=body.version,
            reason=body.reason,
            proposed=_proposed(body),
        )
    except RubricVersionConflictError as exc:
        await db.rollback()
        raise CodedHTTPException(
            status_code=409,
            code="RUBRIC_VERSION_CONFLICT",
            detail=(
                f"The rubric was changed by someone else (now version {exc.current_version}, "
                f"you edited version {body.version}). Reload it and apply your change again."
            ),
        ) from exc
    except RubricValidationError as exc:
        await db.rollback()
        raise _validation_error(exc) from exc
    if result.changed:
        await db.commit()
    return await _current_read(db, current_user)


@router.post("/preview", response_model=ScoringRubricPreview)
async def preview_scoring_rubric(
    body: ScoringRubricPreviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_admin),
) -> ScoringRubricPreview:
    """The impact of a proposed rubric, without saving: new total weight,
    per project (in the caller's scope) old vs new normalized score, score
    band and suggested band (after the P1 capacity fill), and the counts of
    band changes. Validated exactly like the PUT (same 422 codes)."""

    current = await load_rubric(db)
    try:
        proposed = resolve_proposal(current, _proposed(body))
    except RubricValidationError as exc:
        raise _validation_error(exc) from exc
    rows = await preview_rubric(db, current_user, current, proposed)

    def label(band: object) -> str:
        return band.value if band is not None else "Unscored"  # type: ignore[attr-defined]

    transitions: Counter[tuple[str, str]] = Counter(
        (label(r.old_score_band), label(r.new_score_band))
        for r in rows
        if r.old_score_band != r.new_score_band
    )
    projects = [
        RubricPreviewProject(
            project_id=r.project_id,
            project_name=r.project_name,
            hub=r.hub,
            old_normalized_pct=r.old_pct,
            new_normalized_pct=r.new_pct,
            old_score_band=r.old_score_band,
            new_score_band=r.new_score_band,
            old_suggested_band=r.old_suggested_band,
            new_suggested_band=r.new_suggested_band,
            new_capacity_fill=r.new_capacity_fill,
            score_band_changed=r.old_score_band != r.new_score_band,
            suggested_band_changed=r.old_suggested_band != r.new_suggested_band,
            missing_dimension_keys=list(r.missing_keys),
        )
        for r in rows
    ]
    order = {b: i for i, b in enumerate(("P1", "P2", "P3", "P4", "Unscored"))}
    return ScoringRubricPreview(
        current_version=current.version,
        current_total_weight=current.total_weight,
        proposed_total_weight=proposed.total_weight,
        dimensions=_dimensions(proposed, existing=frozenset(d.id for d in current.dimensions)),
        scored_projects=sum(1 for p in projects if p.new_normalized_pct is not None),
        score_band_change_count=sum(1 for p in projects if p.score_band_changed),
        suggested_band_change_count=sum(1 for p in projects if p.suggested_band_changed),
        band_changes=[
            RubricBandChange(from_band=a, to_band=b, count=n)
            for (a, b), n in sorted(
                transitions.items(), key=lambda t: (order[t[0][0]], order[t[0][1]])
            )
        ],
        projects=projects,
    )
