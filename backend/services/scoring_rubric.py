"""The editable scoring rubric, DB side (ADR 0037, P26-T01).

- `load_rubric`: the current rubric (every dimension + the current version).
- `project_scores`: one `PriorityScore`'s scores keyed by dimension key.
- `write_project_scores`: the one writer of per-dimension scores (the Matrix
  edit PUT and scenario apply), which recomputes the cached fields.
- `resolve_proposal` / `save_rubric` / `preview_rubric`: a proposed rubric
  (full replacement), validated once, then saved (new version, audit row,
  every stored score recomputed in the same transaction) or previewed
  (nothing written).

Concurrency: a rubric save takes a transaction-scoped EXCLUSIVE advisory lock;
every score write takes the same lock SHARED before reading the rubric. So a
score is never computed against a rubric that is being replaced, and two
admins saving at once are serialised; the loser gets 409 on the version check
(the unique `rubric_versions.version` is the backstop).

A rubric change never touches the schedule: the scheduler does not read
scores (verified for ADR 0029 §5 and again for ADR 0037), so nothing is marked
`schedule_stale` and no run is started.
"""

from __future__ import annotations

import re
import uuid
from collections import Counter
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.principal import Principal
from models.audit import AuditLogEntry
from models.enums import ProjectPriority
from models.priority import PriorityScore
from models.project import Project
from models.scoring_rubric import (
    KEY_MAX_LENGTH,
    PriorityDimensionScore,
    RubricVersion,
    ScoringDimension,
)
from models.user import User
from schemas.priority import DimensionScore
from services.hub_scope import hub_scope_filter
from services.priority_capacity_fill import compute_capacity_fill
from services.priority_scoring import (
    Rubric,
    RubricDimension,
    ScoreResult,
    compute_score,
    dimension_score_rows,
)

#: Arbitrary constant key of the transaction-scoped advisory lock that
#: serialises rubric saves against score writes ("RPD rubric").
RUBRIC_LOCK_KEY = 0x52504452


class RubricNotInitialisedError(RuntimeError):
    """`rubric_versions` is empty: run `alembic upgrade head` (p26a) or the seed."""


class RubricValidationError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class RubricVersionConflictError(Exception):
    def __init__(self, current_version: int) -> None:
        super().__init__(f"current rubric version is {current_version}")
        self.current_version = current_version


# --- loading -----------------------------------------------------------------------


def _to_dimension(row: ScoringDimension) -> RubricDimension:
    return RubricDimension(
        id=row.id,
        key=row.key,
        label=row.label,
        pillar=row.pillar,
        weight=row.weight,
        inverted=row.inverted,
        active=row.active,
        display_order=row.display_order,
    )


async def current_version(db: AsyncSession) -> int:
    version = (await db.execute(select(func.max(RubricVersion.version)))).scalar_one_or_none()
    if version is None:
        raise RubricNotInitialisedError("No scoring rubric version exists.")
    return int(version)


async def load_rubric(db: AsyncSession) -> Rubric:
    """The current rubric: every dimension, ordered by `display_order`."""

    rows = (
        (
            await db.execute(
                select(ScoringDimension).order_by(
                    ScoringDimension.display_order, ScoringDimension.key
                )
            )
        )
        .scalars()
        .all()
    )
    return Rubric(version=await current_version(db), dimensions=tuple(map(_to_dimension, rows)))


async def lock_rubric(db: AsyncSession, *, exclusive: bool) -> None:
    fn = func.pg_advisory_xact_lock if exclusive else func.pg_advisory_xact_lock_shared
    await db.execute(select(fn(RUBRIC_LOCK_KEY)))


# --- per-project scores ------------------------------------------------------------


def project_scores(rubric: Rubric, score: PriorityScore | None) -> dict[str, int | None] | None:
    """`{key: score}` for every dimension of `rubric` the row holds a value
    for (active or not); None when there is no `PriorityScore` row."""

    if score is None:
        return None
    key_of = {d.id: d.key for d in rubric.dimensions}
    return {
        key_of[s.dimension_id]: s.score for s in score.dimension_scores if s.dimension_id in key_of
    }


def is_scored(score: PriorityScore | None) -> bool:
    """A project is scored when it has a score on at least one ACTIVE
    dimension, i.e. its cached `normalized_pct` is not null."""

    return score is not None and score.normalized_pct is not None


def missing_keys(rubric: Rubric, score: PriorityScore | None) -> list[str]:
    """`missing_dimension_keys`: the active dimensions a SCORED project has no
    score on (incomplete). Empty for an unscored project."""

    if not is_scored(score):
        return []
    return list(compute_score(rubric, project_scores(rubric, score) or {}).missing_keys)


def dimension_score_models(rubric: Rubric, score: PriorityScore | None) -> list[DimensionScore]:
    """ADR 0037: one served `DimensionScore` per ACTIVE dimension, in display
    order (Matrix rows, compare, the score PUT response, the Workspace)."""

    scores = project_scores(rubric, score) if is_scored(score) else None
    return [DimensionScore.model_validate(d) for d in dimension_score_rows(rubric, scores)]


def served_rubric_version(rubric: Rubric, score: PriorityScore | None) -> int:
    """The version a score was computed with (stored); the current one for
    an unscored project."""

    if score is not None and score.rubric_version is not None:
        return score.rubric_version
    return rubric.version


def apply_result(score: PriorityScore, result: ScoreResult, version: int) -> None:
    score.weighted_score = (
        float(result.weighted_score) if result.weighted_score is not None else None
    )
    score.normalized_pct = result.normalized_pct
    score.suggested_band = ProjectPriority(result.band) if result.band is not None else None
    score.rubric_version = version


class UnknownDimensionKeyError(Exception):
    def __init__(self, keys: Sequence[str]) -> None:
        super().__init__(", ".join(keys))
        self.keys = list(keys)


def write_project_scores(
    rubric: Rubric, score: PriorityScore, updates: Mapping[str, int | None]
) -> ScoreResult:
    """Set the given ACTIVE dimension scores on `score` (others are left as
    they are, including inactive dimensions' historic scores) and recompute
    the cached fields. Raises `UnknownDimensionKeyError` (nothing changed) if
    any key is not an active dimension. The caller holds the shared rubric
    lock (`lock_rubric(exclusive=False)`) and flushes."""

    active = {d.key: d for d in rubric.active}
    unknown = sorted(k for k in updates if k not in active)
    if unknown:
        raise UnknownDimensionKeyError(unknown)
    by_dim = {s.dimension_id: s for s in score.dimension_scores}
    for key, value in updates.items():
        dim_id = active[key].id
        existing = by_dim.get(dim_id)
        if existing is None:
            score.dimension_scores.append(PriorityDimensionScore(dimension_id=dim_id, score=value))
        else:
            existing.score = value
    result = compute_score(rubric, {**(project_scores(rubric, score) or {}), **updates})
    apply_result(score, result, rubric.version)
    return result


# --- proposals ---------------------------------------------------------------------


@dataclass(frozen=True)
class ProposedDimension:
    """One validated dimension of a proposal. `key` is None for a new one."""

    key: str | None
    label: str
    pillar: str
    weight: int
    inverted: bool
    active: bool


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(label: str) -> str:
    slug = _SLUG_RE.sub("_", label.lower()).strip("_")
    if not slug:
        slug = "dimension"
    if not slug[0].isalpha():
        slug = f"d_{slug}"
    return slug[: KEY_MAX_LENGTH - 4].rstrip("_")


def _unique_key(base: str, taken: set[str]) -> str:
    key, n = base, 2
    while key in taken:
        key = f"{base}_{n}"
        n += 1
    return key


def reserved_keys() -> frozenset[str]:
    """Keys a NEW dimension may not take, so an export column (one per active
    dimension, headed by its key) never collides with a row column."""

    from schemas.priority import PriorityMatrixRow
    from services.export_builder import MATRIX_PROMOTED_BAND_HEADER

    return frozenset(PriorityMatrixRow.model_fields) | {MATRIX_PROMOTED_BAND_HEADER}


def resolve_proposal(current: Rubric, proposed: Sequence[ProposedDimension]) -> Rubric:
    """Validate a full-replacement proposal against `current` and return the
    resulting rubric (version unchanged; new dimensions get fresh ids and keys
    slugified from their labels). Raises `RubricValidationError`."""

    existing = {d.key: d for d in current.dimensions}
    given = [p.key for p in proposed if p.key is not None]
    dupes = sorted(k for k, n in Counter(given).items() if n > 1)
    if dupes:
        raise RubricValidationError(
            "RUBRIC_DUPLICATE_KEY", f"Each dimension key may appear once: {', '.join(dupes)}."
        )
    unknown = sorted(k for k in given if k not in existing)
    if unknown:
        raise RubricValidationError(
            "RUBRIC_UNKNOWN_KEY",
            f"Unknown dimension key(s): {', '.join(unknown)}. Omit `key` to add a dimension.",
        )
    missing = sorted(k for k in existing if k not in given)
    if missing:
        raise RubricValidationError(
            "RUBRIC_DIMENSION_MISSING",
            "A dimension is never deleted; send it with active=false to deactivate it. "
            f"Missing: {', '.join(missing)}.",
        )
    labels = Counter(p.label.casefold() for p in proposed)
    dup_labels = sorted({p.label for p in proposed if labels[p.label.casefold()] > 1})
    if dup_labels:
        raise RubricValidationError(
            "RUBRIC_DUPLICATE_LABEL", f"Dimension labels must be unique: {', '.join(dup_labels)}."
        )
    if not any(p.active for p in proposed):
        raise RubricValidationError(
            "RUBRIC_NO_ACTIVE_DIMENSION", "At least one dimension must be active."
        )

    taken = set(existing) | set(reserved_keys())
    dims: list[RubricDimension] = []
    for order, p in enumerate(proposed, start=1):
        if p.key is not None:
            dims.append(
                replace(
                    existing[p.key],
                    label=p.label,
                    pillar=p.pillar,
                    weight=p.weight,
                    inverted=p.inverted,
                    active=p.active,
                    display_order=order,
                )
            )
            continue
        key = _unique_key(slugify(p.label), taken)
        taken.add(key)
        dims.append(
            RubricDimension(
                id=uuid.uuid4(),
                key=key,
                label=p.label,
                pillar=p.pillar,
                weight=p.weight,
                inverted=p.inverted,
                active=p.active,
                display_order=order,
            )
        )
    return Rubric(version=current.version, dimensions=tuple(dims))


def snapshot(rubric: Rubric) -> list[dict[str, Any]]:
    return [
        {
            "id": str(d.id),
            "key": d.key,
            "label": d.label,
            "pillar": d.pillar,
            "weight": d.weight,
            "inverted": d.inverted,
            "active": d.active,
            "display_order": d.display_order,
        }
        for d in rubric.dimensions
    ]


def _same(a: Rubric, b: Rubric) -> bool:
    def norm(r: Rubric) -> list[tuple[Any, ...]]:
        return [
            (d.id, d.key, d.label, d.pillar, d.weight, d.inverted, d.active, d.display_order)
            for d in r.dimensions
        ]

    return norm(a) == norm(b)


# --- save --------------------------------------------------------------------------


@dataclass(frozen=True)
class RecomputeStats:
    rows: int
    normalized_changed: int
    band_changed: int


async def recompute_all(db: AsyncSession, rubric: Rubric) -> RecomputeStats:
    """Recompute the cached fields of EVERY `PriorityScore` under `rubric`
    (all hubs: the rubric is portfolio-wide). The caller holds the exclusive
    lock and commits."""

    rows = (await db.execute(select(PriorityScore))).scalars().all()
    pct_changed = band_changed = 0
    for row in rows:
        before = (row.normalized_pct, row.suggested_band)
        apply_result(row, compute_score(rubric, project_scores(rubric, row) or {}), rubric.version)
        pct_changed += before[0] != row.normalized_pct
        band_changed += before[1] != row.suggested_band
    return RecomputeStats(len(rows), pct_changed, band_changed)


@dataclass(frozen=True)
class SaveResult:
    rubric: Rubric
    changed: bool
    stats: RecomputeStats | None


async def save_rubric(
    db: AsyncSession,
    principal: Principal,
    *,
    expected_version: int,
    reason: str,
    proposed: Sequence[ProposedDimension],
) -> SaveResult:
    """Full replacement. Takes the exclusive lock, checks the version (409),
    validates, writes the dimensions, a new `rubric_versions` row, recomputes
    every stored score and writes one `scoring_rubric.update` audit row, all
    staged on `db` (the router commits once). An unchanged proposal writes
    nothing (no version, no audit row)."""

    await lock_rubric(db, exclusive=True)
    current = await load_rubric(db)
    if expected_version != current.version:
        raise RubricVersionConflictError(current.version)
    new = resolve_proposal(current, proposed)
    if _same(current, new):
        return SaveResult(current, False, None)

    rows = {r.id: r for r in (await db.execute(select(ScoringDimension))).scalars().all()}
    for d in new.dimensions:
        row = rows.get(d.id)
        if row is None:
            db.add(
                ScoringDimension(
                    id=d.id,
                    key=d.key,
                    label=d.label,
                    pillar=d.pillar,
                    weight=d.weight,
                    inverted=d.inverted,
                    active=d.active,
                    display_order=d.display_order,
                    created_by_user_id=principal.user_id,
                )
            )
            continue
        row.label, row.pillar, row.weight = d.label, d.pillar, d.weight
        row.inverted, row.active, row.display_order = d.inverted, d.active, d.display_order

    new = replace(new, version=current.version + 1)
    db.add(
        RubricVersion(
            version=new.version,
            changed_by_user_id=principal.user_id,
            reason=reason,
            total_weight=new.total_weight,
            dimensions=snapshot(new),
        )
    )
    await db.flush()
    stats = await recompute_all(db, new)
    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action="scoring_rubric.update",
            entity_type="ScoringRubric",
            entity_id=str(new.version),
            hub_id=None,
            before_state={
                "version": current.version,
                "total_weight": current.total_weight,
                "dimensions": snapshot(current),
            },
            after_state={
                "version": new.version,
                "total_weight": new.total_weight,
                "dimensions": snapshot(new),
                "reason": reason,
                "recomputed_scores": stats.rows,
                "normalized_pct_changes": stats.normalized_changed,
                "score_band_changes": stats.band_changed,
            },
        )
    )
    await db.flush()
    return SaveResult(new, True, stats)


# --- preview -----------------------------------------------------------------------


@dataclass(frozen=True)
class PreviewRow:
    project_id: uuid.UUID
    project_name: str
    hub: Any
    old_pct: int | None
    new_pct: int | None
    old_score_band: ProjectPriority | None
    new_score_band: ProjectPriority | None
    old_suggested_band: ProjectPriority | None
    new_suggested_band: ProjectPriority | None
    new_capacity_fill: bool
    missing_keys: tuple[str, ...]


async def preview_rubric(
    db: AsyncSession, principal: Principal, current: Rubric, proposed: Rubric
) -> list[PreviewRow]:
    """Old (stored, = current rubric) vs new (proposed) normalized score,
    score band and suggested band (after the P1 capacity fill, ADR 0036) of
    every project in the caller's scope that is scored under either rubric.
    Writes nothing."""

    from sqlalchemy.orm import selectinload

    stmt = select(Project).options(selectinload(Project.hub), selectinload(Project.priority_score))
    hub_filter = hub_scope_filter(principal, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    projects = [p for p in (await db.execute(stmt)).scalars().all() if p.priority_score is not None]
    new_results = {
        p.id: compute_score(proposed, project_scores(current, p.priority_score) or {})
        for p in projects
    }
    hubs: Collection[uuid.UUID] = {p.hub_id for p in projects}
    old_fill = await compute_capacity_fill(db, hubs)
    new_fill = await compute_capacity_fill(
        db, hubs, normalized_override={pid: r.normalized_pct for pid, r in new_results.items()}
    )
    out: list[PreviewRow] = []
    for p in sorted(projects, key=lambda x: (x.name.lower(), str(x.id))):
        score = p.priority_score
        assert score is not None
        new = new_results[p.id]
        if score.normalized_pct is None and new.normalized_pct is None:
            continue
        new_band = ProjectPriority(new.band) if new.band is not None else None
        old_row = old_fill.for_row(p.id, p.hub_id, score.suggested_band)
        new_row = new_fill.for_row(p.id, p.hub_id, new_band)
        out.append(
            PreviewRow(
                project_id=p.id,
                project_name=p.name,
                hub=p.hub.name,
                old_pct=score.normalized_pct,
                new_pct=new.normalized_pct,
                old_score_band=score.suggested_band,
                new_score_band=new_band,
                old_suggested_band=old_row.suggested_band,
                new_suggested_band=new_row.suggested_band,
                new_capacity_fill=new_row.capacity_fill,
                missing_keys=new.missing_keys,
            )
        )
    return out


async def user_names(db: AsyncSession, ids: Collection[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = (await db.execute(select(User.id, User.full_name).where(User.id.in_(wanted)))).all()
    return {uid: name for uid, name in rows}
