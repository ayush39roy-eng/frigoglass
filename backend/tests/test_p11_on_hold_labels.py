"""P11-T01: "Blocked" is shown as "On Hold" in server-generated text
(ADR 0017, docs/API_CONTRACT_P11.md §5). Wire values are unchanged.

The notification message itself is asserted end to end in
`tests/test_workspace_api.py::test_blocked_transition_notifies_planners_and_pms_without_names`
and the Ask-the-agent context in `tests/test_ask_agent.py`.
"""

from __future__ import annotations

import pytest

from models.audit import AuditLogEntry
from models.enums import NotificationReason, WorkflowStepStatus
from models.workflow import ProjectWorkflowStep
from services.display_labels import agent_health_label, stage_status_label
from services.notifications import stage_blocked_message
from services.workspace import event_summary, merge_stage_update


@pytest.mark.parametrize(
    ("status", "label"),
    [
        (WorkflowStepStatus.BLOCKED, "On Hold"),
        ("Blocked", "On Hold"),
        (WorkflowStepStatus.NOT_STARTED, "Not Started"),
        (WorkflowStepStatus.IN_PROGRESS, "In Progress"),
        ("Done", "Done"),
        (None, "—"),
        ("Something Else", "Something Else"),
    ],
)
def test_stage_status_label(status, label):
    assert stage_status_label(status) == label


def test_wire_values_are_unchanged():
    assert WorkflowStepStatus.BLOCKED.value == "Blocked"
    assert NotificationReason.STAGE_BLOCKED.value == "stage_blocked"
    assert agent_health_label("blocked") == "on_hold"
    assert agent_health_label("on_track") == "on_track"


def test_notification_message_says_on_hold():
    msg = stage_blocked_message(
        project_name="X", hub_name="PD-India", step_id="PDD-F", step_name="Proof of Concept",
        reason="Waiting for samples",
    )
    assert msg == (
        'Project "X" (PD-India): stage PDD-F Proof of Concept is on hold — Waiting for samples'
    )
    assert "blocked" not in msg.lower()


def _entry(action, before=None, after=None):
    return AuditLogEntry(action=action, before_state=before, after_state=after)


def test_activity_summary_shows_on_hold():
    assert event_summary(
        _entry("project_stage.update", {"status": "In Progress"},
               {"step_id": "PDD-F", "status": "Blocked"})
    ) == "PDD-F marked On Hold"
    # The project-level status On Hold is a different thing and keeps its text.
    assert event_summary(
        _entry("project.update", {"status": "In Queue"}, {"status": "On Hold"})
    ) == "Status changed In Queue → On Hold"


@pytest.mark.parametrize(
    ("recalc", "summary"),
    [
        ("queued", "Priority moved P1 → P2 — timeline recalculation queued"),
        (
            "deferred",
            "Priority moved P1 → P2 — recalculation deferred, another run was in progress",
        ),
        ("not_needed", "Priority moved P1 → P2 — not in the plan, no recalculation"),
        ("other", "Priority moved P1 → P2"),
    ],
)
def test_activity_summary_for_priority_move(recalc, summary):
    entry = _entry(
        "project.priority_move", {"priority": "P1"}, {"priority": "P2", "recalc_status": recalc}
    )
    assert event_summary(entry) == summary


def test_stage_validation_messages_name_on_hold():
    row = ProjectWorkflowStep(
        status=WorkflowStepStatus.NOT_STARTED, percent_complete=0, actual_start_week=None,
        actual_end_week=None, remaining_weeks_override=None, blocked_reason=None,
    )
    _, errors = merge_stage_update(row, {"status": WorkflowStepStatus.BLOCKED})
    assert ("blocked_reason", "is required when status is On Hold") in errors
    assert ("actual_start_week", "is required when status is On Hold") in errors

    _, errors = merge_stage_update(
        row, {"status": WorkflowStepStatus.IN_PROGRESS, "actual_start_week": 30,
              "blocked_reason": "x"}
    )
    assert ("blocked_reason", "must be null unless status is On Hold") in errors
    assert all("Blocked" not in msg for _, msg in errors)
