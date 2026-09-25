"""Hand-rolled factory functions producing valid domain objects with sensible
defaults, overridable per test — per the `qa-testing` skill's factory-pattern
convention. Kept as plain async functions (not factory-boy, not installed)
rather than adding a new dependency for a P1-scope test suite.

Every factory flushes (not commits) so the caller's `db_session` fixture
(SAVEPOINT-per-test) governs the actual commit/rollback lifecycle.
"""

from __future__ import annotations

import itertools
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    Chamber,
    Engineer,
    Hub,
    PriorityApplicationRun,
    PriorityScore,
    Project,
    Role,
    ScenarioApplyRun,
    ScheduleRun,
    User,
    UserHubScope,
    UserRole,
    WorkflowStepTemplate,
)
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    RoleName,
    ScheduleRunStatus,
    SolverType,
    WorkflowStepKind,
)

_version_counter = itertools.count(1)


def next_version() -> int:
    """`schedule_runs.version` / `priority_application_runs.version` /
    `scenario_apply_runs.version` all have a plain (non-partial)
    `unique=True` constraint, so every row in a test needs a distinct
    version number, whether active or not.
    """
    return next(_version_counter)


async def make_hub(
    session: AsyncSession,
    *,
    name: HubName = HubName.RD_GREECE,
    lab_region: LabRegion = LabRegion.GREECE,
    is_oem: bool = False,
) -> Hub:
    hub = Hub(name=name, lab_region=lab_region, is_oem=is_oem)
    session.add(hub)
    await session.flush()
    return hub


async def make_engineer(
    session: AsyncSession,
    hub: Hub,
    *,
    name: str = "Test Engineer",
    fte: float = 1.0,
    allowed_categories: list[EngineerAllowedCategory] | None = None,
) -> Engineer:
    eng = Engineer(
        name=name,
        hub_id=hub.id,
        fte=fte,
        allowed_categories=allowed_categories or [EngineerAllowedCategory.A],
    )
    session.add(eng)
    await session.flush()
    return eng


async def make_chamber(
    session: AsyncSession,
    *,
    code: str | None = None,
    lab_region: LabRegion = LabRegion.GREECE,
    max_concurrent: int = 2,
    allowed_stages: list[str] | None = None,
) -> Chamber:
    chamber = Chamber(
        code=code or f"CH-{uuid.uuid4().hex[:8]}",
        lab_region=lab_region,
        max_concurrent=max_concurrent,
        platforms=1,
        efficiency=1.0,
        weeks_per_chamber=0,
        allowed_stages=allowed_stages or ["PDD-F"],
    )
    session.add(chamber)
    await session.flush()
    return chamber


async def make_workflow_step_template(
    session: AsyncSession,
    *,
    step_id: str = "PDD-A",
    name: str = "Marketing Brief",
    kind: WorkflowStepKind = WorkflowStepKind.DESIGN,
    base_weeks: int = 2,
    sequence_order: int = 1,
) -> WorkflowStepTemplate:
    tmpl = WorkflowStepTemplate(
        id=step_id, name=name, kind=kind, base_weeks=base_weeks, sequence_order=sequence_order
    )
    session.add(tmpl)
    await session.flush()
    return tmpl


async def make_project(
    session: AsyncSession,
    hub: Hub,
    *,
    leader: Engineer | None = None,
    name: str = "Test Project",
    **overrides: Any,
) -> Project:
    defaults: dict[str, Any] = dict(
        name=name,
        hub_id=hub.id,
        leader_engineer_id=leader.id if leader else None,
        category=ProjectCategory.A,
        type=ProjectType.NM,
        status=ProjectStatus.IN_QUEUE,
        priority=ProjectPriority.P3,
        frozen=False,
        delay_weeks=0,
        carry_over=False,
    )
    defaults.update(overrides)
    project = Project(**defaults)
    session.add(project)
    await session.flush()
    return project


async def make_priority_score(
    session: AsyncSession,
    project: Project,
    *,
    dims: list[int],
    hard_gates: list | None = None,
    weighted_score: float | None = None,
    normalized_pct: int | None = None,
    suggested_band: ProjectPriority | None = None,
) -> PriorityScore:
    from models.priority import DIMENSION_FIELD_NAMES

    score = PriorityScore(
        project_id=project.id,
        **dict(zip(DIMENSION_FIELD_NAMES, dims, strict=True)),
        hard_gates=hard_gates or [],
        weighted_score=weighted_score,
        normalized_pct=normalized_pct,
        suggested_band=suggested_band,
    )
    session.add(score)
    await session.flush()
    return score


async def make_schedule_run(
    session: AsyncSession,
    *,
    is_active: bool = False,
    solver_type: SolverType = SolverType.GREEDY,
    status: ScheduleRunStatus = ScheduleRunStatus.COMPLETED,
    **overrides: Any,
) -> ScheduleRun:
    defaults: dict[str, Any] = dict(
        version=next_version(),
        solver_type=solver_type,
        status=status,
        is_active=is_active,
        horizon_weeks=78,
        current_week=31,
    )
    defaults.update(overrides)
    run = ScheduleRun(**defaults)
    session.add(run)
    await session.flush()
    return run


async def make_priority_application_run(
    session: AsyncSession,
    *,
    is_active: bool = False,
    **overrides: Any,
) -> PriorityApplicationRun:
    defaults: dict[str, Any] = dict(version=next_version(), is_active=is_active)
    defaults.update(overrides)
    run = PriorityApplicationRun(**defaults)
    session.add(run)
    await session.flush()
    return run


async def make_scenario_apply_run(
    session: AsyncSession,
    *,
    applied_by_user_id: uuid.UUID | None = None,
    **overrides: Any,
) -> ScenarioApplyRun:
    defaults: dict[str, Any] = dict(
        version=next_version(),
        applied_by_user_id=applied_by_user_id,
        entity_types_touched=[],
        change_count=0,
    )
    defaults.update(overrides)
    run = ScenarioApplyRun(**defaults)
    session.add(run)
    await session.flush()
    return run


async def make_role(session: AsyncSession, name: RoleName) -> Role:
    """`Role` rows are looked up-or-created rather than always inserted — the
    `roles.name` column is `unique=True` (P1-T02 migration), and more than one
    factory call in the same test-session savepoint may want the same role
    (e.g. two Admin users).
    """
    from sqlalchemy import select

    existing = (await session.execute(select(Role).where(Role.name == name))).scalar_one_or_none()
    if existing is not None:
        return existing
    role = Role(name=name)
    session.add(role)
    await session.flush()
    return role


async def make_user(
    session: AsyncSession,
    *roles: RoleName,
    email: str | None = None,
    full_name: str = "Test User",
    oidc_subject: str | None = None,
    is_active: bool = True,
    hub_scope_all: bool = True,
    hub_ids: list[uuid.UUID] | None = None,
) -> User:
    """A provisioned `User` row (per `api.deps._resolve_user`'s "no
    auto-provisioning" contract, tests must create this row explicitly, the
    same way an Admin would via the User/Role Admin surface) with the given
    role(s) attached. `core.rbac`/`core.principal` tests build a `Principal`
    directly (no DB row needed to test the pure permission table); tests that
    need a *real* `User.id` satisfying `audit_log_entries.actor_user_id`'s
    foreign key (i.e. any test that exercises a full authenticated mutation
    end-to-end through the API) should use this factory instead.
    """
    user = User(
        email=email or f"user-{uuid.uuid4().hex[:8]}@example.com",
        full_name=full_name,
        oidc_subject=oidc_subject,
        is_active=is_active,
        hub_scope_all=hub_scope_all,
    )
    session.add(user)
    await session.flush()

    for role_name in roles:
        role = await make_role(session, role_name)
        session.add(UserRole(user_id=user.id, role_id=role.id))

    for hub_id in hub_ids or []:
        session.add(UserHubScope(user_id=user.id, hub_id=hub_id))

    await session.flush()
    return user
