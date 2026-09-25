"""Scenario Apply — the transactional "snapshot pre-apply state, then write
new state" mechanism required by `docs/PROJECT_AND_STACK.md` §4 (see
`models/scenario.py`'s module docstring for the full contract and its
relationship to `ScheduleRun`/`PriorityApplicationRun`'s existing, different
versioning patterns).

**Atomicity**: every function in this module only `flush()`es — it never
calls `db.commit()`. The caller (`api/routers/scenarios.py`) commits exactly
once, after every snapshot row and every live-table write has been staged
successfully. If validation fails partway (e.g. the second of three
`priority_scores` items names an out-of-scope or nonexistent project), this
module raises before writing anything for that item, and the router raises
before calling `db.commit()` at all — so a failed Apply leaves the session
with pending-but-never-committed changes, which `api/db.get_db`'s
`async with session_factory() as session:` discards on request teardown
(SQLAlchemy's `AsyncSession.close()` rolls back any not-yet-committed
transaction). This mirrors every other multi-step mutation in this codebase
(e.g. `api/routers/priorities.py`'s upsert, `services/schedule_persistence.
persist_schedule_output`) rather than inventing a new transaction pattern.

**Validate-before-write**: `apply_priority_score_changes` resolves and
hub-scope-checks EVERY item in the request before writing or snapshotting
ANY of them, specifically so a single invalid item in a batch cannot leave
some of the batch applied and some not (all the more important here than in
a single-row PUT, since this endpoint is explicitly a batch operation).
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.principal import Principal
from models.enums import ProjectPriority, ScenarioEntityType
from models.priority import DIMENSION_FIELD_NAMES, PriorityScore
from models.project import Project
from models.scenario import ScenarioApplyChange, ScenarioApplyRun
from schemas.scenario import ScenarioPriorityScoreChange
from services.audit_helpers import priority_score_audit_state
from services.hub_scope import hub_scope_filter
from services.priority_scoring import compute_priority_score


class ScenarioApplyValidationError(Exception):
    """Raised for a request-shape/data problem the router should surface as
    a 4xx (never a bare 500) — e.g. an empty diff, or a `project_id` that
    doesn't exist / isn't in the caller's hub scope. Distinguished from a
    plain `HTTPException` so this module stays free of any FastAPI import
    (pure service layer, matching `services/schedule_persistence.py`'s own
    "raises `ValueError`, the router translates it" convention) — the router
    catches this and a `NotFoundError`/`ForbiddenError` pair below
    separately, so each maps to the right status code.
    """


class ScenarioApplyNotFoundError(ScenarioApplyValidationError):
    """A named `project_id` does not exist, or exists but is outside the
    caller's hub scope — collapsed into a single 404-mapped error type,
    matching this codebase's existing hub-scoping posture elsewhere (see
    `_resolve_projects_in_scope`'s docstring below)."""


async def _next_version(db: AsyncSession) -> int:
    stmt = select(ScenarioApplyRun.version).order_by(ScenarioApplyRun.version.desc()).limit(1)
    latest = (await db.execute(stmt)).scalar_one_or_none()
    return (latest or 0) + 1


async def _resolve_projects_in_scope(
    db: AsyncSession,
    principal: Principal,
    project_ids: list[uuid.UUID],
) -> dict[uuid.UUID, Project]:
    """Load every named project, hub-scope-filtered, and fail loudly (before
    any write) if any is missing or out of scope — see module docstring's
    "validate before write" note. Distinguishes "doesn't exist at all" from
    "exists but out of scope" the same way `hub_scope_filter`'s callers
    elsewhere in this codebase collapse both into a single 404 at the
    router layer (see e.g. `api/routers/priorities.py`'s
    `upsert_priority_score`) — this module raises a single `ScenarioApply
    NotFoundError` for either case, and the router maps that to 404,
    matching that existing "don't leak which out-of-scope rows exist"
    posture rather than introducing a new 403-vs-404 distinction this
    codebase doesn't otherwise use for row-level hub scoping.
    """

    if not project_ids:  # pragma: no cover - unreachable: callers already guard on empty `changes`
        return {}

    stmt = select(Project).where(Project.id.in_(project_ids))
    hub_filter = hub_scope_filter(principal, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    rows = (await db.execute(stmt)).scalars().all()
    found = {p.id: p for p in rows}

    missing = [pid for pid in project_ids if pid not in found]
    if missing:
        raise ScenarioApplyNotFoundError(
            f"Project(s) not found or outside your hub scope: {sorted(str(m) for m in missing)}"
        )
    return found


async def apply_priority_score_changes(
    db: AsyncSession,
    *,
    principal: Principal,
    notes: str | None,
    changes: list[ScenarioPriorityScoreChange],
) -> tuple[ScenarioApplyRun, list[PriorityScore], dict[uuid.UUID, ProjectPriority]]:
    """Snapshot the pre-apply `PriorityScore` state for every named project,
    then write the new scores — all staged on `db` without committing (see
    module docstring). Returns the new `ScenarioApplyRun` (flushed, `id`
    populated), the list of written/created `PriorityScore` rows (same order
    as `changes`), and a `project_id -> suggested_band` map for the
    response.

    Raises `ScenarioApplyValidationError` (a `ScenarioApplyNotFoundError`
    subclass, specifically) if `changes` is empty or names any project that
    doesn't exist / is outside `principal`'s hub scope — always BEFORE any
    `ScenarioApplyRun`/`ScenarioApplyChange`/`PriorityScore` row is added to
    the session, so the caller can safely treat any exception from this
    function as "nothing was written".
    """

    if not changes:
        raise ScenarioApplyValidationError("Scenario apply request has no changes to apply.")

    project_ids = [c.project_id for c in changes]
    duplicate_ids = {pid for pid in project_ids if project_ids.count(pid) > 1}
    if duplicate_ids:
        raise ScenarioApplyValidationError(
            f"Duplicate project_id(s) in one apply request: "
            f"{sorted(str(d) for d in duplicate_ids)}"
        )

    projects_by_id = await _resolve_projects_in_scope(db, principal, project_ids)

    existing_scores_stmt = (
        select(PriorityScore)
        .options(selectinload(PriorityScore.project))
        .where(PriorityScore.project_id.in_(project_ids))
    )
    existing_by_project = {
        s.project_id: s for s in (await db.execute(existing_scores_stmt)).scalars().all()
    }

    # --- Everything validated; now stage the run + every change. ---------
    run = ScenarioApplyRun(
        version=await _next_version(db),
        applied_by_user_id=principal.user_id,
        notes=notes,
        entity_types_touched=[ScenarioEntityType.PRIORITY_SCORE.value],
        change_count=len(changes),
    )
    db.add(run)
    await db.flush()  # populate run.id

    written_scores: list[PriorityScore] = []
    suggested_bands: dict[uuid.UUID, ProjectPriority] = {}

    for change in changes:
        project = projects_by_id[change.project_id]
        existing = existing_by_project.get(change.project_id)
        before_state = priority_score_audit_state(existing) if existing is not None else None

        dims = [getattr(change, name) for name in DIMENSION_FIELD_NAMES]
        weighted_score, normalized_pct, suggested_band_str = compute_priority_score(dims)
        suggested_band = ProjectPriority(suggested_band_str)

        score = existing or PriorityScore(project_id=change.project_id)
        for name in DIMENSION_FIELD_NAMES:
            setattr(score, name, getattr(change, name))
        score.hard_gates = change.hard_gates
        score.weighted_score = weighted_score
        score.normalized_pct = normalized_pct
        score.suggested_band = suggested_band
        if existing is None:
            db.add(score)
        await db.flush()  # populate score.id for a create; persist edits for an update

        after_state = priority_score_audit_state(score)

        db.add(
            ScenarioApplyChange(
                scenario_apply_run_id=run.id,
                entity_type=ScenarioEntityType.PRIORITY_SCORE,
                entity_id=str(score.id),
                project_id=project.id,
                hub_id=project.hub_id,
                before_state=before_state,
                after_state=after_state,
            )
        )

        written_scores.append(score)
        suggested_bands[change.project_id] = suggested_band

    await db.flush()
    return run, written_scores, suggested_bands
