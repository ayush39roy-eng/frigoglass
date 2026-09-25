"""SQLAlchemy 2.0 async data model for the RPD Web Application.

Import everything here so that (a) `Base.metadata` has every table registered
before Alembic autogenerates against it (P1-T02: `from models import Base;
target_metadata = Base.metadata`), and (b) callers can do
`from models import Project, Engineer, ...` without knowing the internal module
layout.

Deliberately excludes anything under `scheduling/` — that package is
algorithm-engineer's, is not part of the persistence model, and per P2-T01 will
be pure dataclasses with no DB dependency at all.
"""

from models.audit import AuditLogEntry
from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.chamber import Chamber
from models.currency import CurrencyRate
from models.engineer import Engineer
from models.export import ExportJob
from models.hub import Hub
from models.notification import Notification
from models.priority import (
    DIMENSION_FIELD_NAMES,
    PriorityApplicationResult,
    PriorityApplicationRun,
    PriorityScore,
)
from models.project import Project
from models.scenario import ScenarioApplyChange, ScenarioApplyRun
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.user import Role, User, UserHubScope, UserRole
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate

__all__ = [
    "Base",
    "TimestampMixin",
    "UUIDPrimaryKeyMixin",
    "Hub",
    "Engineer",
    "Chamber",
    "CurrencyRate",
    "WorkflowStepTemplate",
    "ProjectWorkflowStep",
    "Project",
    "PriorityScore",
    "PriorityApplicationRun",
    "PriorityApplicationResult",
    "DIMENSION_FIELD_NAMES",
    "ScheduleRun",
    "ScheduleRunProjectStep",
    "ScheduleRunProjectOutcome",
    "AuditLogEntry",
    "ScenarioApplyRun",
    "ScenarioApplyChange",
    "ExportJob",
    "Notification",
    "User",
    "Role",
    "UserRole",
    "UserHubScope",
]
