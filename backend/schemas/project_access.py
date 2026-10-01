"""Project-level access grants (2026-09-30, ADR 0012). See
`api/routers/project_access.py` and `services/project_access.py`.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from models.enums import ProjectAccessRole


class ProjectAccessGrantRead(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID
    project_role: ProjectAccessRole
    granted_by_user_id: uuid.UUID
    created_at: datetime


class ProjectAccessGrantCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: uuid.UUID
    project_role: ProjectAccessRole


class ManageableProjectRead(BaseModel):
    """P10-F02: one entry of `GET /users/me/manageable-projects` — just
    enough to populate a project picker (id, display name, hub for a
    sublabel). Deliberately NOT `schemas.project.ProjectRead`/
    `ProjectListItem`: this convenience endpoint has no surface permission
    gate (see `api/routers/users.py::list_manageable_projects`), so it must
    never carry the encrypted financial fields those schemas do, regardless
    of the caller's project-scoped Admin access.
    """

    id: uuid.UUID
    name: str
    hub_id: uuid.UUID
