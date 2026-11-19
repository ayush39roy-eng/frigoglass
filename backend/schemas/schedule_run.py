"""Pydantic response models for `api/routers/schedule_runs.py` — versioned
`ScheduleRun` summaries, per the "Versions & History" cross-cutting
requirement (`docs/PROJECT_AND_STACK.md` §2).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator

from models.enums import HubName, ProjectPriority, ScheduleRunStatus, SolverType
from models.schedule import PRE_P53_RULES_LABEL
from scheduling.weeks import plan_year_end_week


class ScheduleRunSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int
    solver_type: SolverType
    status: ScheduleRunStatus
    is_active: bool
    horizon_weeks: int
    current_week: int
    trigger_reason: str | None
    #: P9-R02 (ruling 6): the CP-SAT verdict, "OPTIMAL" / "FEASIBLE". Always
    #: null for greedy runs (`solver_type` records the solver) and for older runs.
    solver_status: str | None = None
    created_at: datetime
    #: P53 (R53-7, API_CONTRACT_P53 §3): `"p53"`, or null for a run computed
    #: under the earlier rules.
    rules_epoch: str | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def within_year_week(self) -> int:
        """`year_end(year_of(current_week))` (52 for every 2026 run)."""

        return plan_year_end_week(self.current_week)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def pre_p53(self) -> bool:
        return self.rules_epoch is None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def rules_label(self) -> str | None:
        """Shown wherever a pre-P53 run is shown (R53-7)."""

        return PRE_P53_RULES_LABEL if self.rules_epoch is None else None


class GreedyRecalcResponse(BaseModel):
    """Response for `POST /schedule-runs/greedy-recalc`."""

    schedule_run: ScheduleRunSummary
    project_count: int
    #: P42 (R42-6, I53): the three year counts cover counting outcomes only
    #: (`counts_toward_year` true and not `not_scheduled_priority`).
    left_out_count: int
    within_year_count: int
    spillover_count: int
    #: P42: outcomes with `counts_toward_year` false that are not P4-excluded.
    queued_count: int
    #: P42: outcomes with `not_scheduled_priority` true.
    not_scheduled_priority_count: int


class CpSatDispatchRequest(BaseModel):
    """Request body for `POST /schedule-runs/cp-sat-dispatch` (P3-T06).
    Every field is optional — an empty `{}` body is a valid request (dispatch
    with every solver default).
    """

    #: P9-F01/R04-L1: reject non-finite floats outright (was surfacing as a
    #: 500 on `NaN`) and validate strictly (was coercing `"15"` / `true` in
    #: lax mode).
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)

    @model_validator(mode="before")
    @classmethod
    def _ignore_legacy_max_time_in_seconds(cls, data: Any) -> Any:
        """P9-R02b: for ONE release, silently accept and ignore a legacy
        `max_time_in_seconds` key (same pattern as the chamber
        `weeks_per_chamber` tolerance), so an older client does not 422.
        DOMAIN_RULES "Gate remediation rulings" #6 retired wall-clock CP-SAT
        limits; the value is never forwarded. Remove this hook in the release
        after P9.
        """

        if isinstance(data, dict) and "max_time_in_seconds" in data:
            data = {k: v for k, v in data.items() if k != "max_time_in_seconds"}
        return data

    #: Pass-1 CP-SAT budget in deterministic-time units (ruling 6), forwarded
    #: to `scheduling.cp_sat.run_cp_sat(deterministic_time=...)`. `None` (the
    #: default) means "use `core.celery_config.CelerySettings.
    #: cp_sat_deterministic_time`, else the solver's own default" — resolved
    #: inside the Celery task (`workers/schedule_tasks.py`), not here.
    deterministic_time: float | None = Field(default=None, gt=0, le=60)


class CpSatDispatchResponse(BaseModel):
    """Response for `POST /schedule-runs/cp-sat-dispatch` — 202-style:
    returned as soon as the `ScheduleRun` row is created and the Celery task
    is enqueued, well before the solve itself runs. `schedule_run_id` /
    `celery_task_id` are what the client needs to open a P3-T05 SSE
    connection against `workers.progress.channel_name(schedule_run_id)`.
    """

    schedule_run: ScheduleRunSummary
    celery_task_id: str


class ScheduleRunChangeRow(BaseModel):
    """One project whose stored outcome differs between the two runs
    (docs/API_CONTRACT_P11.md §3, I20). Every value is read from the two
    runs' `ScheduleRunProjectOutcome` rows; nothing is recomputed.

    `is_new`: no outcome row in the baseline run, so the `before_*` side is
    empty (`before_projected_end_week` null, `before_*` flags false).
    `is_removed`: no outcome row in the new run, so the `after_*` side is
    empty the same way.
    """

    project_id: uuid.UUID
    project_name: str
    hub: HubName
    #: The project's live priority now (not part of the comparison).
    priority: ProjectPriority | None
    before_projected_end_week: int | None
    after_projected_end_week: int | None
    #: `after − before`; null if either side is null.
    delta_weeks: int | None
    before_within_year: bool
    after_within_year: bool
    before_left_out: bool
    after_left_out: bool
    before_blocked: bool
    after_blocked: bool
    #: P42 (R42-6, I20): compared too.
    before_counts_toward_year: bool
    after_counts_toward_year: bool
    before_not_scheduled_priority: bool
    after_not_scheduled_priority: bool
    #: P42 (R42-1): the live band's label; null with no band.
    priority_label: str | None
    is_new: bool
    is_removed: bool


class ScheduleRunChanges(BaseModel):
    """`GET /schedule-runs/{run_id}/changes?against={baseline_run_id}`.

    `rows` holds only in-scope projects whose compared fields
    (`projected_end_week`, `within_year`, `left_out`, `blocked`, and since
    P42 `counts_toward_year`, `not_scheduled_priority`) differ, or
    that are present in only one of the runs. They are sorted by
    `|delta_weeks|` descending (null last), then `project_name`.
    `hidden_count` counts the changed projects outside the caller's scope;
    their names and ids are never returned.
    """

    run_id: uuid.UUID
    run_version: int
    against_run_id: uuid.UUID
    against_run_version: int
    #: P37-T04 (ADR 0052 R37-4, API_CONTRACT_P37 §3): the two runs' stored
    #: `current_week` (`against` run = baseline). When they differ, the list
    #: also carries the effect of the week passing, and the UI labels it
    #: "includes the move from W<baseline_week> to W<run_week>". Rows are
    #: unchanged (I20).
    baseline_week: int
    run_week: int
    hidden_count: int
    rows: list[ScheduleRunChangeRow]
    #: P53 (R53-7): the baseline is a pre-P53 run and this run is a P53 run;
    #: the UI labels the list "includes the scheduling-rule change (P53)".
    includes_rule_change: bool = False
