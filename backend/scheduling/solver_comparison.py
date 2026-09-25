"""Solver comparison harness (P2-T07): greedy SGS vs CP-SAT on one input.

Runs `scheduling.greedy.run_greedy_sgs` (P2-T01) and `scheduling.cp_sat.run_cp_sat`
(P2-T06) on the **same** `ScheduleInput` and produces a structured, field-by-field
diff report over `ProjectScheduleOutcome` / `StepSchedule`, plus:

  - an "objective value" for each solver (see `_weighted_within_year_objective`),
  - `validate_invariants` (P2-T04) run on **both** outputs — an invariant
    violation on either side is the single most important thing this harness can
    catch, and is surfaced at the top of the report,
  - a classification of every field-level divergence into one of a small set of
    **explained** buckets (documented below) or, if it fits none of them,
    `UNEXPLAINED` — which `workflow-auditor` must investigate before P2 closes.

Purity: this module is pure (`ScheduleInput` in, dataclass report out). It reads
no DB / network / filesystem. The `__main__` block and
`scheduling._selftest_solver_comparison` load `backend/seed/prototype_seed_data.json`
directly, exactly as `scheduling._selftest_cp_sat` and
`scheduling._selftest_invariants` already do — that JSON read lives only in the
script entry point, never in `compare_solvers`.

Determinism: `run_cp_sat` is always called with `num_search_workers=1` (per
P2-T07's brief and `cp_sat.py`'s determinism caveat). `run_greedy_sgs` is
deterministic by construction (Invariant I8).

--------------------------------------------------------------------------------
Objective
--------------------------------------------------------------------------------
The greedy SGS scheduler has **no** numeric objective — it only uses priority as
a sort key (`docs/DOMAIN_RULES.md` "Scheduling order"). To compare the two
solvers on a single number, this harness applies CP-SAT's own objective metric
(ADR 0005: `PRIORITY_OBJECTIVE_WEIGHT = {P1:4, P2:3, P3:2, P4:1, Q:0}`) to
**both** outputs identically:

    objective = Σ  PRIORITY_OBJECTIVE_WEIGHT[project.priority]   over every
               project whose outcome has `within_year == True`

Reported alongside is CP-SAT's own internally-reported primary objective value
(`CpSatSolveInfo.objective_value`), which is computed over the solver's
*solvable* subset only (excludes frozen / excluded / pre-resolved-LEFT_OUT
projects). The two CP-SAT figures differ by exactly the fixed contribution of
frozen + Commercialized projects that are `within_year` on both sides.

--------------------------------------------------------------------------------
Explained divergence buckets (per P2-T07 brief — do NOT triage these as anomalies)
--------------------------------------------------------------------------------
1. ``I5_CLEAN_LEFT_OUT_VS_PARTIAL_RETENTION`` — both solvers agree the project is
   ``LEFT_OUT``, but greedy retains the steps it had already booked before hitting
   the dead end while CP-SAT reports ``steps=()`` (Invariant I5's clean "fully
   scheduled OR fully left_out" reading). Source: MEMORY.md P2-T06 review entry;
   `cp_sat.py::_no_chamber_outcome` docstring; `types.py::ProjectScheduleOutcome`
   docstring.

2a. ``OPEN_CHOICE_WEEK_OR_CHAMBER`` — both solvers schedule the project fully, but
    pick a different start week and/or chamber for a step. CP-SAT optimises
    globally; greedy is one-pass first-fit. Wherever `docs/DOMAIN_RULES.md` leaves
    the exact week/chamber open, the two legitimately differ.
2b. ``OPEN_CHOICE_COMPLETION_WEEK`` — a downstream consequence of 2a: the two
    solvers' different week choices land the project's completion on different
    sides of `within_year_week`, so `within_year` / `spillover` differ. Still not
    a bug on either side as long as `validate_invariants` passes for both.

3. ``DIFFERENT_PROJECT_SET_ADR0005`` — the two solvers leave a *different* project
   ``LEFT_OUT`` under contention. ADR 0005's band-weight objective lets CP-SAT
   choose a globally better selection than greedy's sort-order-then-first-fit.
   Every field divergence for a project whose `left_out` flag itself differs is
   attributed here.

4. ``UNEXPLAINED_FROZEN_DIVERGENCE`` — **any** divergence on a `frozen` project.
   Both solvers schedule frozen projects via `run_greedy_sgs` (CP-SAT pre-resolves
   them outside the model), so frozen outcomes must be byte-identical. A frozen
   divergence is a real correctness signal, never noise — reported as unexplained.

Anything else → ``UNEXPLAINED``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from scheduling.cp_sat import PRIORITY_OBJECTIVE_WEIGHT, CpSatSolveInfo, run_cp_sat
from scheduling.greedy import run_greedy_sgs
from scheduling.invariants import InvariantViolation, validate_invariants
from scheduling.types import (
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
)

# --- Divergence classification buckets --------------------------------------

BUCKET_I5_CLEAN_LEFT_OUT = "I5_CLEAN_LEFT_OUT_VS_PARTIAL_RETENTION"
BUCKET_OPEN_CHOICE_WEEK_CHAMBER = "OPEN_CHOICE_WEEK_OR_CHAMBER"
BUCKET_OPEN_CHOICE_COMPLETION = "OPEN_CHOICE_COMPLETION_WEEK"
BUCKET_DIFFERENT_PROJECT_SET = "DIFFERENT_PROJECT_SET_ADR0005"
BUCKET_UNEXPLAINED_FROZEN = "UNEXPLAINED_FROZEN_DIVERGENCE"
BUCKET_UNEXPLAINED = "UNEXPLAINED"

#: The buckets that P2-T07's brief pre-classifies as INTENTIONAL. A divergence
#: whose bucket is *not* in this set must be investigated by workflow-auditor.
EXPLAINED_BUCKETS: frozenset[str] = frozenset(
    {
        BUCKET_I5_CLEAN_LEFT_OUT,
        BUCKET_OPEN_CHOICE_WEEK_CHAMBER,
        BUCKET_OPEN_CHOICE_COMPLETION,
        BUCKET_DIFFERENT_PROJECT_SET,
    }
)

_OUTCOME_FIELDS: tuple[str, ...] = (
    "excluded",
    "left_out",
    "eng_conflict",
    "overlap",
    "cat_not_allowed",
    "spillover",
    "within_year",
    "no_leader",
    "no_chamber_step_id",
    "start_week",
    "end_week",
)

_STEP_FIELDS: tuple[str, ...] = (
    "sequence_order",
    "kind",
    "start_week",
    "end_week",
    "duration_weeks",
    "assigned_engineer_id",
    "assigned_chamber_id",
)


# --- Report dataclasses -----------------------------------------------------


@dataclass(frozen=True)
class FieldDivergence:
    """One field of one project's outcome (or one of its steps) on which the two
    solvers disagree.

    `location` is `"outcome"` for a `ProjectScheduleOutcome` field, or
    `f"step:{step_id}"` for a `StepSchedule` field (including the synthetic
    `"present"` field, `True`/`False`, when a step exists on one side only).
    """

    project_id: str
    location: str
    field: str
    greedy_value: object
    cp_sat_value: object
    bucket: str

    @property
    def explained(self) -> bool:
        return self.bucket in EXPLAINED_BUCKETS


@dataclass(frozen=True)
class ProjectDivergence:
    """Every field-level divergence for a single project, plus context."""

    project_id: str
    frozen: bool
    priority: str | None
    greedy_left_out: bool
    cp_sat_left_out: bool
    field_divergences: tuple[FieldDivergence, ...]

    @property
    def has_unexplained(self) -> bool:
        return any(not d.explained for d in self.field_divergences)


@dataclass(frozen=True)
class SolverComparisonReport:
    """The full structured diff between the greedy and CP-SAT solvers on one
    `ScheduleInput`. Pure data — safe to serialize, snapshot, or assert against.
    """

    # --- objective ---
    greedy_objective: int
    cp_sat_objective: int
    cp_sat_internal_objective: float
    cp_sat_status: str
    cp_sat_solve_info: CpSatSolveInfo

    # --- headline counts ---
    project_count: int
    greedy_within_year_count: int
    cp_sat_within_year_count: int
    greedy_left_out_count: int
    cp_sat_left_out_count: int

    # --- invariant validation (the most important output) ---
    greedy_invariant_violations: tuple[InvariantViolation, ...]
    cp_sat_invariant_violations: tuple[InvariantViolation, ...]

    # --- per-project divergence ---
    project_divergences: tuple[ProjectDivergence, ...]
    total_field_divergence_count: int
    diverging_project_count: int
    frozen_diverging_project_count: int
    divergence_counts_by_bucket: dict[str, int]
    unexplained_divergences: tuple[FieldDivergence, ...]

    # --- the raw outputs, for callers that want to drill in ---
    greedy_output: ScheduleOutput = field(repr=False)
    cp_sat_output: ScheduleOutput = field(repr=False)

    @property
    def has_invariant_violations(self) -> bool:
        return bool(self.greedy_invariant_violations or self.cp_sat_invariant_violations)

    @property
    def has_unexplained_divergence(self) -> bool:
        return bool(self.unexplained_divergences)

    @property
    def clean(self) -> bool:
        """True iff neither solver violates an invariant AND every divergence is
        classified as one of P2-T07's explained buckets. This is the condition
        workflow-auditor needs before P2 can close."""

        return not self.has_invariant_violations and not self.has_unexplained_divergence


# --- Objective metric -------------------------------------------------------


def _weighted_within_year_objective(
    output: ScheduleOutput, priority_by_id: dict[str, str | None]
) -> int:
    """ADR 0005's objective metric applied to a `ScheduleOutput`: the
    priority-band-weighted count of projects completing within the year.

    Applied identically to both solvers' outputs so the two are comparable on a
    single number (greedy has no native objective — see the module docstring).
    """

    total = 0
    for outcome in output.project_outcomes:
        if not outcome.within_year:
            continue
        band = priority_by_id.get(outcome.project_id) or "Q"
        total += PRIORITY_OBJECTIVE_WEIGHT.get(band, 0)
    return total


# --- Per-project diff ------------------------------------------------------


def _classify(
    project: ProjectInput,
    greedy_o: ProjectScheduleOutcome,
    cp_sat_o: ProjectScheduleOutcome,
    location: str,
    field_name: str,
) -> str:
    """Assign one field divergence to a bucket. See the module docstring for the
    bucket definitions and their sources."""

    is_step = location.startswith("step:")

    # Bucket 4: frozen projects must be byte-identical on both sides.
    if project.frozen:
        return BUCKET_UNEXPLAINED_FROZEN

    # Bucket 3: the two solvers disagree on whether this project is LEFT_OUT at
    # all -> every field divergence for it traces to ADR 0005's objective.
    if greedy_o.left_out != cp_sat_o.left_out:
        return BUCKET_DIFFERENT_PROJECT_SET

    # Bucket 1: both agree LEFT_OUT; greedy keeps partial steps, CP-SAT clears them.
    if greedy_o.left_out and cp_sat_o.left_out:
        if is_step or field_name in ("start_week", "end_week", "no_chamber_step_id"):
            return BUCKET_I5_CLEAN_LEFT_OUT
        return BUCKET_UNEXPLAINED

    # Both solvers schedule the project fully.
    # Bucket 2b: different week choice pushed completion across within_year_week.
    if field_name in ("within_year", "spillover"):
        return BUCKET_OPEN_CHOICE_COMPLETION
    # Bucket 2a: different open week / chamber choice for a step (or the derived
    # project-level start/end week).
    if is_step and field_name in ("start_week", "end_week", "assigned_chamber_id"):
        return BUCKET_OPEN_CHOICE_WEEK_CHAMBER
    if field_name in ("start_week", "end_week"):
        return BUCKET_OPEN_CHOICE_WEEK_CHAMBER

    # assigned_engineer_id (fixed = project leader), duration_weeks, kind,
    # sequence_order, cat_not_allowed, no_leader, eng_conflict, overlap, excluded
    # -- all deterministic from the input and identical-by-construction on both
    # sides. A divergence here is a real signal.
    return BUCKET_UNEXPLAINED


def _compare_project(
    project: ProjectInput,
    greedy_o: ProjectScheduleOutcome,
    cp_sat_o: ProjectScheduleOutcome,
) -> tuple[FieldDivergence, ...]:
    divergences: list[FieldDivergence] = []

    for field_name in _OUTCOME_FIELDS:
        g_val = getattr(greedy_o, field_name)
        c_val = getattr(cp_sat_o, field_name)
        if g_val != c_val:
            divergences.append(
                FieldDivergence(
                    project_id=project.project_id,
                    location="outcome",
                    field=field_name,
                    greedy_value=g_val,
                    cp_sat_value=c_val,
                    bucket=_classify(project, greedy_o, cp_sat_o, "outcome", field_name),
                )
            )

    greedy_steps: dict[str, StepSchedule] = {s.step_id: s for s in greedy_o.steps}
    cp_sat_steps: dict[str, StepSchedule] = {s.step_id: s for s in cp_sat_o.steps}
    all_step_ids = sorted(
        set(greedy_steps) | set(cp_sat_steps),
        key=lambda sid: (greedy_steps.get(sid) or cp_sat_steps[sid]).sequence_order,
    )
    for sid in all_step_ids:
        g_step = greedy_steps.get(sid)
        c_step = cp_sat_steps.get(sid)
        location = f"step:{sid}"
        if g_step is None or c_step is None:
            divergences.append(
                FieldDivergence(
                    project_id=project.project_id,
                    location=location,
                    field="present",
                    greedy_value=g_step is not None,
                    cp_sat_value=c_step is not None,
                    bucket=_classify(project, greedy_o, cp_sat_o, location, "present"),
                )
            )
            continue
        for field_name in _STEP_FIELDS:
            g_val = getattr(g_step, field_name)
            c_val = getattr(c_step, field_name)
            if g_val != c_val:
                divergences.append(
                    FieldDivergence(
                        project_id=project.project_id,
                        location=location,
                        field=field_name,
                        greedy_value=g_val,
                        cp_sat_value=c_val,
                        bucket=_classify(project, greedy_o, cp_sat_o, location, field_name),
                    )
                )

    return tuple(divergences)


# --- Public entry point ---------------------------------------------------


def compare_solvers(
    schedule_input: ScheduleInput,
    *,
    cp_sat_max_time_in_seconds: float | None = None,
) -> SolverComparisonReport:
    """Run both solvers on `schedule_input` and return a structured diff report.

    Pure: no DB / network / filesystem access. `run_cp_sat` is always called
    single-threaded (`num_search_workers=1`) for determinism.

    `cp_sat_max_time_in_seconds` is forwarded to `run_cp_sat` when set; left at
    `run_cp_sat`'s own default otherwise.
    """

    greedy_output = run_greedy_sgs(schedule_input)

    cp_sat_kwargs: dict[str, object] = {"num_search_workers": 1}
    if cp_sat_max_time_in_seconds is not None:
        cp_sat_kwargs["max_time_in_seconds"] = cp_sat_max_time_in_seconds
    cp_sat_output, cp_sat_info = run_cp_sat(schedule_input, **cp_sat_kwargs)  # type: ignore[arg-type]

    projects_by_id: dict[str, ProjectInput] = {
        p.project_id: p for p in schedule_input.projects
    }
    priority_by_id: dict[str, str | None] = {
        p.project_id: p.priority for p in schedule_input.projects
    }

    greedy_violations = validate_invariants(schedule_input, greedy_output)
    # I8 (determinism) re-runs the greedy scheduler internally and is not a
    # meaningful check against the CP-SAT output -- skip it on that side. Every
    # other invariant (I1-I7, I9, I10) is the real point of validating CP-SAT.
    cp_sat_violations = validate_invariants(
        schedule_input, cp_sat_output, check_determinism=False
    )

    greedy_by_id = {o.project_id: o for o in greedy_output.project_outcomes}
    cp_sat_by_id = {o.project_id: o for o in cp_sat_output.project_outcomes}

    project_divergences: list[ProjectDivergence] = []
    for project_id in sorted(projects_by_id):
        project = projects_by_id[project_id]
        g_out = greedy_by_id[project_id]
        c_out = cp_sat_by_id[project_id]
        field_divergences = _compare_project(project, g_out, c_out)
        if not field_divergences:
            continue
        project_divergences.append(
            ProjectDivergence(
                project_id=project_id,
                frozen=project.frozen,
                priority=project.priority,
                greedy_left_out=g_out.left_out,
                cp_sat_left_out=c_out.left_out,
                field_divergences=field_divergences,
            )
        )

    all_field_divergences: list[FieldDivergence] = [
        d for pd in project_divergences for d in pd.field_divergences
    ]
    counts_by_bucket: dict[str, int] = {}
    for d in all_field_divergences:
        counts_by_bucket[d.bucket] = counts_by_bucket.get(d.bucket, 0) + 1
    unexplained = tuple(d for d in all_field_divergences if not d.explained)

    non_excluded_greedy = [o for o in greedy_output.project_outcomes if not o.excluded]
    non_excluded_cp_sat = [o for o in cp_sat_output.project_outcomes if not o.excluded]

    return SolverComparisonReport(
        greedy_objective=_weighted_within_year_objective(greedy_output, priority_by_id),
        cp_sat_objective=_weighted_within_year_objective(cp_sat_output, priority_by_id),
        cp_sat_internal_objective=cp_sat_info.objective_value,
        cp_sat_status=cp_sat_info.status_name,
        cp_sat_solve_info=cp_sat_info,
        project_count=len(schedule_input.projects),
        greedy_within_year_count=sum(1 for o in greedy_output.project_outcomes if o.within_year),
        cp_sat_within_year_count=sum(1 for o in cp_sat_output.project_outcomes if o.within_year),
        greedy_left_out_count=sum(1 for o in non_excluded_greedy if o.left_out),
        cp_sat_left_out_count=sum(1 for o in non_excluded_cp_sat if o.left_out),
        greedy_invariant_violations=greedy_violations,
        cp_sat_invariant_violations=cp_sat_violations,
        project_divergences=tuple(project_divergences),
        total_field_divergence_count=len(all_field_divergences),
        diverging_project_count=len(project_divergences),
        frozen_diverging_project_count=sum(1 for pd in project_divergences if pd.frozen),
        divergence_counts_by_bucket=counts_by_bucket,
        unexplained_divergences=unexplained,
        greedy_output=greedy_output,
        cp_sat_output=cp_sat_output,
    )


# --- Human-readable rendering -------------------------------------------------


def format_report(report: SolverComparisonReport, *, max_projects: int = 60) -> str:
    """Render a `SolverComparisonReport` as a readable multi-line string."""

    lines: list[str] = []
    lines.append("=" * 78)
    lines.append("SOLVER COMPARISON: greedy SGS  vs  CP-SAT")
    lines.append("=" * 78)
    lines.append("")
    lines.append(f"projects in input .................. {report.project_count}")
    lines.append(f"CP-SAT status ..................... {report.cp_sat_status}")
    lines.append(
        f"CP-SAT solve time (s) ............. {report.cp_sat_solve_info.wall_time_seconds:.2f}"
    )
    lines.append(
        f"  solvable / frozen / pre-left-out . "
        f"{report.cp_sat_solve_info.num_solvable_projects} / "
        f"{report.cp_sat_solve_info.num_frozen_projects} / "
        f"{report.cp_sat_solve_info.num_pre_resolved_left_out}"
    )
    lines.append("")
    lines.append("-- OBJECTIVE (ADR 0005 band weights x within_year, applied to both) --")
    lines.append(f"  greedy objective ............... {report.greedy_objective}")
    lines.append(f"  CP-SAT objective .............. {report.cp_sat_objective}")
    lines.append(
        f"  CP-SAT internal (solvable only)  {report.cp_sat_internal_objective:.0f}"
    )
    lines.append(
        f"  delta (CP-SAT - greedy) ....... {report.cp_sat_objective - report.greedy_objective:+d}"
    )
    lines.append("")
    lines.append("-- HEADLINE COUNTS --")
    lines.append(
        f"  within_year   greedy={report.greedy_within_year_count}  "
        f"cp_sat={report.cp_sat_within_year_count}"
    )
    lines.append(
        f"  left_out      greedy={report.greedy_left_out_count}  "
        f"cp_sat={report.cp_sat_left_out_count}   (non-excluded projects)"
    )
    lines.append("")
    lines.append("-- INVARIANT VALIDATION (I1-I10) --")
    lines.append(
        f"  greedy .... {len(report.greedy_invariant_violations)} violation(s)"
        + ("" if not report.greedy_invariant_violations else "   <<< MUST FIX")
    )
    for v in report.greedy_invariant_violations:
        lines.append(f"      {v.invariant}: {v.description}")
    lines.append(
        f"  CP-SAT ... {len(report.cp_sat_invariant_violations)} violation(s)"
        + ("" if not report.cp_sat_invariant_violations else "   <<< MUST FIX")
    )
    for v in report.cp_sat_invariant_violations:
        lines.append(f"      {v.invariant}: {v.description}")
    lines.append("")
    lines.append("-- DIVERGENCE SUMMARY --")
    lines.append(f"  total field divergences ......... {report.total_field_divergence_count}")
    lines.append(
        f"  projects diverging ............. {report.diverging_project_count} "
        f"/ {report.project_count}"
    )
    lines.append(
        f"  frozen projects diverging ..... {report.frozen_diverging_project_count}   "
        "(MUST be 0 -- frozen is byte-identical on both sides)"
    )
    lines.append("  by bucket:")
    for bucket in sorted(report.divergence_counts_by_bucket):
        count = report.divergence_counts_by_bucket[bucket]
        tag = "explained" if bucket in EXPLAINED_BUCKETS else "!! UNEXPLAINED !!"
        lines.append(f"      {count:5d}  {bucket}  [{tag}]")
    lines.append("")
    if report.unexplained_divergences:
        lines.append("-- UNEXPLAINED DIVERGENCES (workflow-auditor: investigate) --")
        for d in report.unexplained_divergences:
            lines.append(
                f"      {d.project_id}  {d.location}.{d.field}  "
                f"greedy={d.greedy_value!r}  cp_sat={d.cp_sat_value!r}  [{d.bucket}]"
            )
    else:
        lines.append("-- UNEXPLAINED DIVERGENCES: none --")
    lines.append("")
    lines.append("-- PER-PROJECT DIVERGENCE DETAIL --")
    shown = report.project_divergences[:max_projects]
    for pd in shown:
        flags = []
        if pd.frozen:
            flags.append("FROZEN")
        if pd.greedy_left_out != pd.cp_sat_left_out:
            flags.append(
                f"left_out greedy={pd.greedy_left_out} cp_sat={pd.cp_sat_left_out}"
            )
        flag_str = f"  ({'; '.join(flags)})" if flags else ""
        lines.append(
            f"  {pd.project_id}  prio={pd.priority}  "
            f"{len(pd.field_divergences)} field(s){flag_str}"
        )
        for d in pd.field_divergences:
            lines.append(
                f"      {d.location}.{d.field}: "
                f"greedy={d.greedy_value!r}  cp_sat={d.cp_sat_value!r}  -> {d.bucket}"
            )
    if len(report.project_divergences) > len(shown):
        lines.append(f"  ... {len(report.project_divergences) - len(shown)} more project(s)")
    lines.append("")
    lines.append("=" * 78)
    verdict = "CLEAN" if report.clean else "NEEDS ATTENTION"
    lines.append(f"VERDICT: {verdict}")
    lines.append("=" * 78)
    return "\n".join(lines)


# --- Script entry point (loads the real seed dataset) -----------------------


def _load_seed_schedule_input() -> ScheduleInput:
    """Load `backend/seed/prototype_seed_data.json` into a `ScheduleInput`,
    byte-for-byte the same mapping `scheduling._selftest_cp_sat` and
    `scheduling._selftest_invariants` use. Only ever called from `__main__` /
    the self-test -- never from `compare_solvers`."""

    import json
    from pathlib import Path

    from scheduling.types import ChamberInput, EngineerInput

    seed_path = Path(__file__).resolve().parent.parent / "seed" / "prototype_seed_data.json"
    seed = json.loads(seed_path.read_text())

    engineers = tuple(
        EngineerInput(
            engineer_id=e["name"],
            name=e["name"],
            hub=e["hub"],
            allowed_categories=tuple(e["cats"]),
            fte=e["fte"],
        )
        for e in seed["engineers"]
    )
    chambers = tuple(
        ChamberInput(
            chamber_id=c["id"],
            code=c["id"],
            lab_region=c["labHub"],
            max_concurrent=c["max"],
            allowed_stages=tuple(f"PDD-{letter}" for letter in c["stages"]),
            efficiency=c["eff"],
            weeks_per_chamber=c["wksCh"],
        )
        for c in seed["chambers"]
    )
    projects = tuple(
        ProjectInput(
            project_id=p["id"],
            name=p["name"],
            hub=p["hub"],
            status=p["status"],
            category=p["cat"],
            priority=p["prio"],
            frozen=p["frozen"],
            leader_engineer_id=p["leader"],
            actual_start_week=p["actualStart"] if p["frozen"] else None,
            delay_weeks=p["delay"],
        )
        for p in seed["projects"]
    )
    return ScheduleInput(projects=projects, engineers=engineers, chambers=chambers)


def main() -> int:
    schedule_input = _load_seed_schedule_input()
    report = compare_solvers(schedule_input, cp_sat_max_time_in_seconds=60.0)
    print(format_report(report))
    return 0 if report.clean else 1


if __name__ == "__main__":
    raise SystemExit(main())
