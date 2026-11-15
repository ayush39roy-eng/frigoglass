"""Expected project status from the current workflow step (P35-T08b).

**Owner-pending assumption — docs/OPEN_QUESTIONS.md #84** (adopted as a
non-blocking assumption on 2026-11-15, MEMORY "P35 continued"). The mapping is
the old tool's `getExpectedStatus`, the same for the PDD and OEM workflows,
keyed by the step letter (the part of the step id after the workflow prefix,
e.g. ``PDD-E`` / ``OEM-E`` → ``E``):

- A → In Queue
- B–H → In Development
- I–M → Under Industrialization
- N → Commercialized
- no current step (every step Done or skipped) → Commercialized

No expectation (``None``, never a mismatch) for a project whose status is
On Hold, Cancelled, In Buyoff or Draft.

This is a **display warning only** (the Projects register's red outline). It
is never a scheduler input, never written back to the project, and changes
nothing about which statuses are schedulable. If the owner answers OQ #84
differently, this module is the one place to change.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final

from models.enums import ProjectStatus

#: OQ #84: step letter → expected project status (PDD and OEM alike).
EXPECTED_STATUS_BY_STEP_LETTER: Final[Mapping[str, ProjectStatus]] = {
    "A": ProjectStatus.IN_QUEUE,
    **{letter: ProjectStatus.IN_DEVELOPMENT for letter in "BCDEFGH"},
    **{letter: ProjectStatus.UNDER_INDUSTRIALIZATION for letter in "IJKLM"},
    "N": ProjectStatus.COMMERCIALIZED,
}

#: OQ #84: statuses that get no expectation and never a mismatch warning.
EXPECTED_STATUS_EXEMPT: Final[frozenset[ProjectStatus]] = frozenset(
    {
        ProjectStatus.ON_HOLD,
        ProjectStatus.CANCELLED,
        ProjectStatus.IN_BUYOFF,
        ProjectStatus.DRAFT,
    }
)


def expected_status_for(status: ProjectStatus, current_step_id: str | None) -> ProjectStatus | None:
    """OQ #84 (assumption): the status the project's current step implies.

    `current_step_id` is the step id already served as the row's
    `current_step_code` (``"PDD-E"``, ``"OEM-K"``…; `None` when every step is
    Done or skipped). Returns `None` for an exempt status, or for a step id
    whose letter is not in the mapping (no guess is made).
    """

    if status in EXPECTED_STATUS_EXEMPT:
        return None
    if current_step_id is None:
        return ProjectStatus.COMMERCIALIZED
    letter = current_step_id.rsplit("-", 1)[-1]
    return EXPECTED_STATUS_BY_STEP_LETTER.get(letter)


def status_mismatch(status: ProjectStatus, expected: ProjectStatus | None) -> bool:
    """OQ #84: true when an expectation exists and the status differs."""

    return expected is not None and status != expected
