"""Read-only response models for reference/lookup data (`Hub`,
`WorkflowStepTemplate`) — seeded once (P1-T03), not user-editable in v1.
Shared across every surface's dropdowns/labels (hub pickers on Project
Registration and Capacity Planning; step names on the Gantt).
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict

from models.enums import HubName, LabRegion, WorkflowStepKind


class HubRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: HubName
    lab_region: LabRegion
    is_oem: bool


class WorkflowStepTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    kind: WorkflowStepKind
    base_weeks: int
    sequence_order: int
