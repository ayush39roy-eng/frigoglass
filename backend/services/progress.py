"""The one project-progress formula (DOMAIN_RULES "Project roll-up progress",
I12; "Gate remediation rulings" 3).

`project_progress_pct` is the scheduler's own shared function, exported from
`scheduling` by P9-R01 (`scheduling.workflow.project_progress_pct`). This
module re-exports it so every API path has a single import point, and the
workspace and both solvers run literally the same body.

Callers pass `(stored percent_complete, effective_duration_weeks)` pairs, with
effective duration 0 for a skipped step (0-week lead time, or a lab step with
certification testing off). See `services.workspace.build_workspace`.
"""

from __future__ import annotations

from scheduling import project_progress_pct

__all__ = ["project_progress_pct"]
