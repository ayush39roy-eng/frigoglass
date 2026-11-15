"""P34-T01 (D34-4): which Scenario Apply version last changed a project's
priority score — the Matrix "changed" marker.

One grouped query for any number of projects (no N+1): Postgres
`DISTINCT ON (project_id)` ordered by `version DESC` picks the latest run per
project. The change rows are filtered by the caller's hub scope on
`ScenarioApplyChange.hub_id`, the same predicate `GET /scenarios/versions`
composes, so the version served is always one the caller can open in
Versions & History. Callers pass only project ids already in their scope;
nothing about any other project is read or returned.

Nothing sensitive is read: version number, run timestamp and the applier's
`User.full_name`. No financial field is touched and nothing is logged.
"""

from __future__ import annotations

import uuid
from collections.abc import Collection

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession

from core.principal import Principal
from models.enums import ScenarioEntityType
from models.scenario import ScenarioApplyChange, ScenarioApplyRun
from models.user import User
from schemas.priority import LastScoreVersion
from services.hub_scope import hub_scope_filter


async def latest_score_versions(
    db: AsyncSession,
    principal: Principal,
    project_ids: Collection[uuid.UUID],
) -> dict[uuid.UUID, LastScoreVersion]:
    """`project_id -> LastScoreVersion` for every project in `project_ids`
    with at least one `priority_score` change visible in the caller's hub
    scope. Projects never versioned are absent (the caller serves null)."""

    if not project_ids:
        return {}
    stmt = (
        select(
            ScenarioApplyChange.project_id,
            ScenarioApplyRun.version,
            ScenarioApplyRun.created_at,
            User.full_name,
        )
        .join(ScenarioApplyRun, ScenarioApplyRun.id == ScenarioApplyChange.scenario_apply_run_id)
        .outerjoin(User, User.id == ScenarioApplyRun.applied_by_user_id)
        .where(
            ScenarioApplyChange.entity_type == ScenarioEntityType.PRIORITY_SCORE,
            ScenarioApplyChange.project_id.in_(list(project_ids)),
        )
    )
    change_hub_filter = hub_scope_filter(principal, ScenarioApplyChange.hub_id)
    if change_hub_filter is not None:
        stmt = stmt.where(change_hub_filter)
    stmt = stmt.ext(distinct_on(ScenarioApplyChange.project_id)).order_by(
        ScenarioApplyChange.project_id, ScenarioApplyRun.version.desc()
    )
    rows = (await db.execute(stmt)).all()
    return {
        project_id: LastScoreVersion(
            version=version, created_at=created_at, applied_by_name=full_name
        )
        for project_id, version, created_at, full_name in rows
        if project_id is not None
    }
