"""Weekly check-in rules (ADR 0021 §2–§3, ADR 0023 §1; DOMAIN_RULES "Weekly
check-in and tracking status"; docs/API_CONTRACT_P12.md §5).

**Who may check in a stage** (`CheckInAccess.can_write_stage`), a MAX:
1. a role with Project Workspace WRITE that is not Engineer-self-scoped
   (Hub Planner, Portfolio Manager, Admin, Super Admin), for projects in its
   hub scope (all hubs when `hub_scope_all`);
2. an active Editor or Admin `ProjectAccessGrant` on the project (ADR 0012);
3. an Engineer (the caller's linked `Engineer.user_id`) for every stage of a
   project they lead (`Project.leader_engineer_id`) and for stages assigned
   to them (the live `ProjectWorkflowStep.assigned_engineer_id`, or the
   active run's assignment for that stage, which is what the Gantt and the
   Workspace already call "own assignments").
Rule 3 is the narrow new write right of ADR 0021: it applies to check-ins
only and grants no general `project_workspace` write. A Viewer grant, the
Executive Viewer and the Auditor never write here.

**Who sees what on the due list** (`visible_stages`): role readers (rule 1
plus Executive Viewer) see every due stage in their hub scope; Editor/Admin
grantees and project leaders see that project's due stages; an Engineer
otherwise sees only the stages assigned to them. `can_check_in` says which
of those the caller may submit. A Viewer grant adds nothing to the due list
(it is a to-do list, and a Viewer has nothing to do).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy import ColumnElement, false, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import principal_can
from core.principal import Principal
from core.rbac import Action, Surface
from models.engineer import Engineer
from models.enums import ProjectAccessRole, RoleName
from models.project import Project
from models.project_access import ProjectAccessGrant
from models.schedule import ScheduleRun, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from services.hub_scope import is_engineer_self_scoped
from services.tracking import DueStage

_WRITE_GRANTS = frozenset({ProjectAccessRole.EDITOR, ProjectAccessRole.ADMIN})


@dataclass(frozen=True)
class CheckInAccess:
    #: Rule 1 (write) / role read: `None` = no role route, `"all"` = every
    #: hub, else the hub ids in scope.
    role_write_hubs: frozenset[uuid.UUID] | str | None
    role_read_hubs: frozenset[uuid.UUID] | str | None
    engineer_id: uuid.UUID | None
    #: Projects with an active Editor/Admin grant (rule 2).
    write_grant_projects: frozenset[uuid.UUID] = field(default_factory=frozenset)
    #: The role matrix gives Project Workspace READ (the check-in page's nav
    #: surface), even if the caller has nothing due (e.g. an unlinked Engineer).
    workspace_read: bool = False

    @property
    def has_any_route(self) -> bool:
        """May open the due list at all (otherwise 403, e.g. a bare Auditor)."""

        return self.workspace_read or bool(self.write_grant_projects)

    @staticmethod
    def _hub_in(hubs: frozenset[uuid.UUID] | str | None, hub_id: uuid.UUID) -> bool:
        if hubs is None:
            return False
        if hubs == "all":
            return True
        assert isinstance(hubs, frozenset)
        return hub_id in hubs

    def role_writes(self, project: Project) -> bool:
        return self._hub_in(self.role_write_hubs, project.hub_id)

    def role_reads(self, project: Project) -> bool:
        return self._hub_in(self.role_read_hubs, project.hub_id)

    def project_wide_write(self, project: Project) -> bool:
        """Rules 1, 2 and the leader half of rule 3: every stage of the project."""

        return (
            self.role_writes(project)
            or project.id in self.write_grant_projects
            or (self.engineer_id is not None and project.leader_engineer_id == self.engineer_id)
        )

    def can_write_stage(self, project: Project, assignees: Iterable[uuid.UUID | None]) -> bool:
        if self.project_wide_write(project):
            return True
        return self.engineer_id is not None and self.engineer_id in set(assignees)


def _hub_scope(principal: Principal) -> frozenset[uuid.UUID] | str:
    return "all" if principal.hub_scope_all else frozenset(principal.hub_ids)


async def resolve_access(db: AsyncSession, principal: Principal) -> CheckInAccess:
    self_scoped = is_engineer_self_scoped(principal)
    role_write = (
        _hub_scope(principal)
        if not self_scoped and principal_can(principal, Surface.PROJECT_WORKSPACE, Action.WRITE)
        else None
    )
    role_read = (
        _hub_scope(principal)
        if not self_scoped and principal_can(principal, Surface.PROJECT_WORKSPACE, Action.READ)
        else None
    )
    engineer_id: uuid.UUID | None = None
    if RoleName.ENGINEER in principal.roles:
        engineer_id = (
            await db.execute(select(Engineer.id).where(Engineer.user_id == principal.user_id))
        ).scalar_one_or_none()
    grants = frozenset(
        pid
        for pid, role in (
            await db.execute(
                select(ProjectAccessGrant.project_id, ProjectAccessGrant.project_role).where(
                    ProjectAccessGrant.user_id == principal.user_id,
                    ProjectAccessGrant.revoked_at.is_(None),
                )
            )
        ).all()
        if role in _WRITE_GRANTS
    )
    return CheckInAccess(
        role_write_hubs=role_write,
        role_read_hubs=role_read,
        engineer_id=engineer_id,
        write_grant_projects=grants,
        workspace_read=principal_can(principal, Surface.PROJECT_WORKSPACE, Action.READ),
    )


def candidate_filter(
    access: CheckInAccess, active_run: ScheduleRun | None
) -> ColumnElement[bool]:
    """A `Project` predicate for every project the caller may see on the due
    list (before stage-level filtering). Always-false when there is no route.
    """

    clauses: list[ColumnElement[bool]] = []
    if access.role_read_hubs == "all":
        return Project.id.is_not(None)
    if isinstance(access.role_read_hubs, frozenset) and access.role_read_hubs:
        clauses.append(Project.hub_id.in_(access.role_read_hubs))
    if access.write_grant_projects:
        clauses.append(Project.id.in_(access.write_grant_projects))
    if access.engineer_id is not None:
        eid = access.engineer_id
        clauses.append(Project.leader_engineer_id == eid)
        clauses.append(
            Project.id.in_(
                select(ProjectWorkflowStep.project_id).where(
                    ProjectWorkflowStep.assigned_engineer_id == eid
                )
            )
        )
        if active_run is not None:
            clauses.append(
                Project.id.in_(
                    select(ScheduleRunProjectStep.project_id).where(
                        ScheduleRunProjectStep.schedule_run_id == active_run.id,
                        ScheduleRunProjectStep.assigned_engineer_id == eid,
                    )
                )
            )
    if not clauses:
        return false()
    return or_(*clauses)


def visible_stages(
    access: CheckInAccess, project: Project, stages: list[DueStage]
) -> list[tuple[DueStage, bool]]:
    """`[(stage, can_check_in)]` the caller sees for one project."""

    if access.project_wide_write(project):
        return [(s, True) for s in stages]
    if access.role_reads(project):
        return [
            (s, access.can_write_stage(project, s.assigned_engineer_ids)) for s in stages
        ]
    if access.engineer_id is None:
        return []
    return [(s, True) for s in stages if access.engineer_id in s.assigned_engineer_ids]
