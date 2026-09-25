"""Scenario Apply + Versions & History (P5-T02) —
`docs/PROJECT_AND_STACK.md` §4's "on 'Apply', POSTed as a diff ... the
backend snapshots the pre-apply state to Postgres (versioned row set) before
writing the new state" and §2's "every ... priority application is
versioned; historical versions are browsable and comparable".

**Scope boundary — read before extending this file**: `POST /scenarios/apply`
only accepts `priority_scores` diffs today (generalising `PUT
/priorities/{project_id}` to a batched, versioned, snapshotted Apply). Diffs
for `Project`/`Engineer`/`Chamber` rows ("capacity, or project data" per §4's
full sentence) are explicitly deferred — see `models/scenario.py` and
`models/enums.py`'s `ScenarioEntityType` docstrings, and this task's
`docs/MEMORY.md` entry, for what's built vs. deferred and why. Nothing here
builds or stubs a revert endpoint either — P5-T03 (frontend Versions &
History UI) is a read/browse/compare surface; "apply the diff between two
historical versions" is out of scope for both that task and this one.

**RBAC**: gated identically to `api/routers/priorities.py`'s `PUT
/priorities/{project_id}` (the endpoint this generalises) — `POST
/scenarios/apply` requires `MATRIX`/`WRITE` (Portfolio Manager, Admin only;
Hub Planner is READ-only on Matrix, unlike most other surfaces). The two read
endpoints require `MATRIX`/`READ` (Portfolio Manager, Hub Planner, Executive
Viewer, Admin).

**Hub-scoped**: `POST /scenarios/apply` hub-scope-checks every named
`project_id` before writing anything (`services.scenario_apply
._resolve_projects_in_scope`) — a Hub Planner could never reach `WRITE` here
in practice (see above), but this stays defense-in-depth, matching
`api/routers/priorities.py`'s own stated rationale for doing the same. The
two read endpoints filter to runs/changes touching at least one project in
the caller's hub scope, via `services.hub_scope.hub_scope_filter` composed
into an `EXISTS(...)` correlated subquery against `ScenarioApplyChange.
hub_id` — reusing the existing helper's "hub_id_column.in_(hub_ids), or None
if unrestricted" shape rather than inventing a new one, since the predicate
shape needed for an EXISTS's inner WHERE is identical to a plain `.where(...)`
predicate.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.scenario import ScenarioApplyChange, ScenarioApplyRun
from schemas.scenario import (
    ScenarioApplyChangeDetail,
    ScenarioApplyRequest,
    ScenarioApplyResponse,
    ScenarioApplyRunDetail,
    ScenarioApplyRunSummary,
)
from services.hub_scope import hub_scope_filter
from services.scenario_apply import (
    ScenarioApplyNotFoundError,
    ScenarioApplyValidationError,
    apply_priority_score_changes,
)

router = APIRouter(prefix="/scenarios", tags=["scenarios", "versions-and-history"])

_read = require_permission(Surface.MATRIX, Action.READ)
_write = require_permission(Surface.MATRIX, Action.WRITE)


@router.post("/apply", response_model=ScenarioApplyResponse, status_code=status.HTTP_201_CREATED)
async def apply_scenario(
    body: ScenarioApplyRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> ScenarioApplyResponse:
    """Apply a scenario diff: snapshot the pre-apply state of every touched
    row into a new versioned `ScenarioApplyRun`/`ScenarioApplyChange` set,
    then write the new values — one DB transaction (a single `db.commit()`
    below; see `services.scenario_apply`'s module docstring for the
    validate-before-write / atomicity contract).
    """

    try:
        run, written_scores, suggested_bands = await apply_priority_score_changes(
            db,
            principal=current_user,
            notes=body.notes,
            changes=body.priority_scores,
        )
    except ScenarioApplyNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ScenarioApplyValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="scenario_apply.apply",
            entity_type="ScenarioApplyRun",
            entity_id=str(run.id),
            hub_id=None,  # a scenario apply may span multiple hubs' projects
            before_state=None,
            after_state={
                "version": run.version,
                "entity_types_touched": run.entity_types_touched,
                "change_count": run.change_count,
                "project_ids": [str(pid) for pid in suggested_bands],
            },
        )
    )
    await db.commit()
    await db.refresh(run)

    return ScenarioApplyResponse(
        run=ScenarioApplyRunSummary.model_validate(run),
        updated_priority_scores=[s.id for s in written_scores],
        suggested_bands={str(pid): band for pid, band in suggested_bands.items()},
    )


def _run_hub_scope_exists_clause(current_user: Principal) -> ColumnElement[bool] | None:
    """`EXISTS(...)`-style predicate restricting `ScenarioApplyRun` rows to
    those with at least one `ScenarioApplyChange` in the caller's hub scope,
    or `None` if the caller is unrestricted — mirrors `hub_scope_filter`'s
    own `None`-means-unrestricted contract so callers compose it the same
    way (`if clause is not None: stmt = stmt.where(clause)`).
    """

    change_hub_filter = hub_scope_filter(current_user, ScenarioApplyChange.hub_id)
    if change_hub_filter is None:
        return None
    return (
        select(ScenarioApplyChange.id)
        .where(
            ScenarioApplyChange.scenario_apply_run_id == ScenarioApplyRun.id,
            change_hub_filter,
        )
        .exists()
    )


async def _scoped_change_counts(
    db: AsyncSession,
    current_user: Principal,
    run_ids: Sequence[uuid.UUID],
) -> dict[uuid.UUID, int]:
    """Per-`ScenarioApplyRun` count of `ScenarioApplyChange` rows visible to
    `current_user`'s own hub scope (P5-T10 remediation — see module docstring
    addendum below and the `docs/MEMORY.md` "[2026-09-05] P5 gate —
    workflow-auditor" finding #4 this fixes).

    `ScenarioApplyRun.change_count` is a portfolio-wide cache computed once
    at Apply time (`services/scenario_apply.py`) — it deliberately never
    reflects any one viewer's hub scope, since a single Apply's write path
    has no "viewer" at all. Both `GET /scenarios/versions` (list) and
    `GET /scenarios/versions/{version}` (detail) must instead report a
    `change_count` scoped to the CALLER, matching the `changes` rows the
    detail endpoint actually returns to them — otherwise a Hub Planner sees
    two different, both "server-computed", counts for the identical version
    with no explanation (list says N, detail's own `changes` list has M<N
    rows) purely because a scenario Apply spanning multiple hubs is
    explicitly supported (see `apply_scenario`'s `AuditLogEntry.hub_id=None`
    comment above). For an unrestricted caller (`hub_scope_all=True`) this
    reduces to the same raw count as `ScenarioApplyRun.change_count`, since
    `hub_scope_filter` applies no predicate at all in that case.
    """

    if not run_ids:
        return {}
    stmt = select(
        ScenarioApplyChange.scenario_apply_run_id, func.count(ScenarioApplyChange.id)
    ).where(ScenarioApplyChange.scenario_apply_run_id.in_(run_ids))
    change_hub_filter = hub_scope_filter(current_user, ScenarioApplyChange.hub_id)
    if change_hub_filter is not None:
        stmt = stmt.where(change_hub_filter)
    stmt = stmt.group_by(ScenarioApplyChange.scenario_apply_run_id)
    rows = (await db.execute(stmt)).all()
    return {run_id: count for run_id, count in rows}


@router.get("/versions", response_model=list[ScenarioApplyRunSummary])
async def list_scenario_apply_versions(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[ScenarioApplyRunSummary]:
    """Versions & History list view: every `ScenarioApplyRun`, most recent
    first, hub-scope-filtered (a Hub Planner only sees runs that touched at
    least one project in their own hub(s)). `change_count` is overridden to
    the CALLER's own hub-scoped count (see `_scoped_change_counts`), not the
    raw portfolio-wide `ScenarioApplyRun.change_count` column, so it always
    agrees with `len(changes)` a caller would see on
    `GET /scenarios/versions/{version}` for the same run.
    """

    stmt = select(ScenarioApplyRun).order_by(ScenarioApplyRun.version.desc())
    exists_clause = _run_hub_scope_exists_clause(current_user)
    if exists_clause is not None:
        stmt = stmt.where(exists_clause)
    runs = list((await db.execute(stmt)).scalars().all())

    scoped_counts = await _scoped_change_counts(db, current_user, [run.id for run in runs])
    return [
        ScenarioApplyRunSummary(
            **{
                **ScenarioApplyRunSummary.model_validate(run).model_dump(),
                "change_count": scoped_counts.get(run.id, 0),
            }
        )
        for run in runs
    ]


@router.get("/versions/{version}", response_model=ScenarioApplyRunDetail)
async def get_scenario_apply_version(
    version: int,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> ScenarioApplyRunDetail:
    """One version's full detail: every `ScenarioApplyChange` row (before/
    after snapshots), hub-scope-filtered — a Hub Planner sees only the
    changes touching their own hub(s) within this version, and 404s
    entirely if the version touched no project in their scope at all
    (rather than a 200 with an empty `changes` list, which would leak that
    the version exists at all to a caller who cannot see any of its content).
    """

    stmt = select(ScenarioApplyRun).where(ScenarioApplyRun.version == version)
    exists_clause = _run_hub_scope_exists_clause(current_user)
    if exists_clause is not None:
        stmt = stmt.where(exists_clause)
    run = (await db.execute(stmt)).scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")

    changes_stmt = select(ScenarioApplyChange).where(
        ScenarioApplyChange.scenario_apply_run_id == run.id
    )
    change_hub_filter = hub_scope_filter(current_user, ScenarioApplyChange.hub_id)
    if change_hub_filter is not None:
        changes_stmt = changes_stmt.where(change_hub_filter)
    changes_stmt = changes_stmt.order_by(
        ScenarioApplyChange.entity_type, ScenarioApplyChange.entity_id
    )
    changes = (await db.execute(changes_stmt)).scalars().all()

    # `change_count` is overridden to `len(changes)` (this same, already
    # hub-scope-filtered list) rather than the raw portfolio-wide
    # `run.change_count` — see `_scoped_change_counts`'s docstring. Without
    # this, a Hub Planner viewing a multi-hub Apply would see a `change_count`
    # header disagreeing with the very `changes` rows on the same response.
    return ScenarioApplyRunDetail(
        **{
            **ScenarioApplyRunSummary.model_validate(run).model_dump(),
            "change_count": len(changes),
        },
        changes=[ScenarioApplyChangeDetail.model_validate(c) for c in changes],
    )
