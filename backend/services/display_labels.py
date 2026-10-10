"""User-facing labels for server-generated text (ADR 0017).

The stored and wire values never change: `WorkflowStepStatus.BLOCKED` stays
`"Blocked"`, the reason stays `blocked_reason`, the outcome flag stays
`blocked` and the health value stays `"blocked"`. Only text the server writes
for a person to read goes through this map:
- the `stage_blocked` notification message (`services.notifications`);
- Workspace activity summaries (`services.workspace.event_summary`);
- stage-progress 422 messages (`services.workspace.merge_stage_update`);
- the Ask-the-agent context (`services.ask_agent`).

A stage on hold is not the project-level status `On Hold` (that one takes the
whole project out of the plan). This module labels stage statuses only.
"""

from __future__ import annotations

from models.enums import WorkflowStepStatus

#: The one place the Blocked → On Hold label lives on the backend.
STAGE_STATUS_LABELS: dict[WorkflowStepStatus, str] = {
    WorkflowStepStatus.NOT_STARTED: "Not Started",
    WorkflowStepStatus.IN_PROGRESS: "In Progress",
    WorkflowStepStatus.BLOCKED: "On Hold",
    WorkflowStepStatus.DONE: "Done",
}

#: Lower-case form for running text ("stage X is on hold").
STAGE_ON_HOLD_PHRASE = "on hold"

#: The health value `"blocked"` as the Ask-the-agent context shows it.
HEALTH_ON_HOLD = "on_hold"


def stage_status_label(status: WorkflowStepStatus | str | None) -> str:
    """The label a person sees for a stage status. Accepts the enum or its
    stored string (audit snapshots hold the string). Unknown strings are
    returned unchanged, and `None` becomes `"—"`.
    """

    if status is None:
        return "—"
    try:
        member = WorkflowStepStatus(status)
    except ValueError:
        return str(status)
    return STAGE_STATUS_LABELS[member]


def agent_health_label(health: str) -> str:
    """Health value for the Ask-the-agent context: `"blocked"` reads as
    `"on_hold"` so the agent says "on hold". Every other value is unchanged.
    """

    return HEALTH_ON_HOLD if health == "blocked" else health
