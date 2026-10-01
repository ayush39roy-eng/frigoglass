"""P10-T02: `services.project_access.effective_project_access` — the 6-rule
MAX resolver of ADR 0012 / `docs/DOMAIN_RULES.md` "Project access grants and
delegation". Each rule tested individually, plus the "grant never reduces
1-4/6" and "no rule applies -> None" cases.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from models.enums import HubName, LabRegion, RoleName
from models.project_access import ProjectAccessGrant
from models.schedule import ScheduleRunProjectStep
from services.project_access import effective_project_access
from tests.auth_helpers import make_principal
from tests.factories import (
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_user,
    make_workflow_step_template,
)


async def test_rule1_super_admin_is_admin_unconditionally(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    principal = make_principal(RoleName.SUPER_ADMIN, hub_scope_all=False, hub_ids=())

    role = await effective_project_access(db_session, principal, project)

    assert role == "admin"


async def test_rule2_global_admin_is_admin_unconditionally(db_session):
    other_hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project = await make_project(db_session, other_hub)
    principal = make_principal(RoleName.ADMIN, hub_scope_all=False, hub_ids=())

    role = await effective_project_access(db_session, principal, project)

    assert role == "admin"


async def test_rule2_portfolio_manager_is_admin_unconditionally(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, hub_scope_all=False, hub_ids=())

    role = await effective_project_access(db_session, principal, project)

    assert role == "admin"


async def test_rule3_hub_planner_scoped_to_project_hub_is_admin(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    principal = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub.id])

    role = await effective_project_access(db_session, principal, project)

    assert role == "admin"


async def test_rule3_hub_planner_out_of_scope_hub_gets_no_access(db_session):
    hub = await make_hub(db_session)
    other_hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project = await make_project(db_session, other_hub)
    principal = make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub.id])

    role = await effective_project_access(db_session, principal, project)

    assert role is None


async def test_rule4_executive_viewer_is_viewer_unconditionally(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    principal = make_principal(RoleName.EXECUTIVE_VIEWER, hub_scope_all=True)

    role = await effective_project_access(db_session, principal, project)

    assert role == "viewer"


async def test_rule5_active_grant_gives_its_role(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    grantee = await make_user(db_session, hub_scope_all=False)
    granter = await make_user(db_session, RoleName.ADMIN)
    db_session.add(
        ProjectAccessGrant(
            project_id=project.id,
            user_id=grantee.id,
            project_role="editor",
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()
    # A bare Engineer principal (no linked Engineer row, so rule 6 does not
    # apply) with no other rule contributing — isolates rule 5.
    principal = make_principal(
        RoleName.ENGINEER, user_id=grantee.id, hub_scope_all=False, hub_ids=()
    )

    role = await effective_project_access(db_session, principal, project)

    assert role == "editor"


async def test_rule5_revoked_grant_is_ignored(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    grantee = await make_user(db_session, hub_scope_all=False)
    granter = await make_user(db_session, RoleName.ADMIN)
    db_session.add(
        ProjectAccessGrant(
            project_id=project.id,
            user_id=grantee.id,
            project_role="admin",
            granted_by_user_id=granter.id,
            revoked_at=datetime.now(UTC),
        )
    )
    await db_session.flush()
    principal = make_principal(
        RoleName.ENGINEER, user_id=grantee.id, hub_scope_all=False, hub_ids=()
    )

    role = await effective_project_access(db_session, principal, project)

    assert role is None


async def test_rule6_engineer_leading_the_project_is_viewer(db_session):
    hub = await make_hub(db_session)
    user = await make_user(db_session, RoleName.ENGINEER, hub_scope_all=False)
    engineer = await make_engineer(db_session, hub)
    engineer.user_id = user.id
    await db_session.flush()
    project = await make_project(db_session, hub, leader=engineer)
    principal = make_principal(
        RoleName.ENGINEER, user_id=user.id, hub_scope_all=False, hub_ids=()
    )

    role = await effective_project_access(db_session, principal, project)

    assert role == "viewer"


async def test_rule6_engineer_assigned_a_step_in_the_active_run_is_viewer(db_session):
    hub = await make_hub(db_session)
    user = await make_user(db_session, RoleName.ENGINEER, hub_scope_all=False)
    engineer = await make_engineer(db_session, hub)
    engineer.user_id = user.id
    await db_session.flush()
    project = await make_project(db_session, hub)
    template = await make_workflow_step_template(db_session)
    run = await make_schedule_run(db_session, is_active=True)
    db_session.add(
        ScheduleRunProjectStep(
            schedule_run_id=run.id,
            project_id=project.id,
            step_template_id=template.id,
            sequence_order=1,
            duration_weeks=2,
            start_week=1,
            end_week=2,
            assigned_engineer_id=engineer.id,
        )
    )
    await db_session.flush()
    principal = make_principal(
        RoleName.ENGINEER, user_id=user.id, hub_scope_all=False, hub_ids=()
    )

    role = await effective_project_access(db_session, principal, project)

    assert role == "viewer"


async def test_engineer_with_no_assignment_gets_no_access(db_session):
    hub = await make_hub(db_session)
    user = await make_user(db_session, RoleName.ENGINEER, hub_scope_all=False)
    await make_engineer(db_session, hub)  # unrelated engineer row, not linked to `user`
    project = await make_project(db_session, hub)
    principal = make_principal(
        RoleName.ENGINEER, user_id=user.id, hub_scope_all=False, hub_ids=()
    )

    role = await effective_project_access(db_session, principal, project)

    assert role is None


async def test_no_applicable_rule_gives_none(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    principal = make_principal(
        RoleName.AUDITOR, hub_scope_all=False, hub_ids=(), user_id=uuid.uuid4()
    )

    role = await effective_project_access(db_session, principal, project)

    assert role is None


async def test_grant_never_reduces_what_rule_3_already_gives(db_session):
    """A Viewer-level grant on a project a Hub Planner already Admins (rule 3)
    must not pull them down to Viewer — MAX, never a reduction.
    """

    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    user = await make_user(db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub.id])
    granter = await make_user(db_session, RoleName.ADMIN)
    db_session.add(
        ProjectAccessGrant(
            project_id=project.id,
            user_id=user.id,
            project_role="viewer",
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()
    principal = make_principal(
        RoleName.HUB_PLANNER, user_id=user.id, hub_scope_all=False, hub_ids=[hub.id]
    )

    role = await effective_project_access(db_session, principal, project)

    assert role == "admin"


async def test_grant_adds_access_a_role_would_not_otherwise_surface(db_session):
    """An Executive Viewer (rule 4 -> Viewer everywhere) with an Editor grant
    on one project sees Editor there — the grant is additive.
    """

    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    user = await make_user(db_session, RoleName.EXECUTIVE_VIEWER, hub_scope_all=True)
    granter = await make_user(db_session, RoleName.ADMIN)
    db_session.add(
        ProjectAccessGrant(
            project_id=project.id,
            user_id=user.id,
            project_role="editor",
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()
    principal = make_principal(RoleName.EXECUTIVE_VIEWER, user_id=user.id, hub_scope_all=True)

    role = await effective_project_access(db_session, principal, project)

    assert role == "editor"
