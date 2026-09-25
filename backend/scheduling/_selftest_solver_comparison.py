"""Informal self-test for P2-T07's solver comparison harness
(`scheduling.solver_comparison`).

Run directly: `python -m scheduling._selftest_solver_comparison` from `backend/`.

Same status as `scheduling._selftest` (P2-T01), `scheduling._selftest_invariants`
(P2-T04) and `scheduling._selftest_cp_sat` (P2-T06): deliberately NOT a pytest
module under `backend/tests/` -- formal pytest coverage of `backend/scheduling/`
is P2-T09's job.

What this verifies:

  1. On an input where both solvers land the same schedule, `compare_solvers`
     reports zero divergences and `report.clean is True`.
  2. The divergence classifier (`_classify`) assigns each of P2-T07's four
     pre-declared INTENTIONAL buckets correctly, and flags a genuine
     frozen-project / leader-mismatch divergence as UNEXPLAINED.
  3. On the full real 46-project seed dataset (loaded exactly as
     `_selftest_cp_sat` / `_selftest_invariants` load it): `validate_invariants`
     returns zero violations for BOTH solvers, zero frozen projects diverge,
     and every remaining divergence is classified as explained
     (`report.clean is True`). Headline numbers are printed for the MEMORY.md
     entry.
  4. `compare_solvers` is deterministic: two runs on the same input produce the
     same divergence set, objectives, and invariant results.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from scheduling import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ScheduleInput,
    WorkflowStepTemplate,
    compare_solvers,
    format_report,
)
from scheduling.solver_comparison import (
    BUCKET_DIFFERENT_PROJECT_SET,
    BUCKET_I5_CLEAN_LEFT_OUT,
    BUCKET_OPEN_CHOICE_COMPLETION,
    BUCKET_OPEN_CHOICE_WEEK_CHAMBER,
    BUCKET_UNEXPLAINED,
    BUCKET_UNEXPLAINED_FROZEN,
    EXPLAINED_BUCKETS,
    _classify,
    _compare_project,
)
from scheduling.types import ProjectScheduleOutcome, StepSchedule

FAILURES: list[str] = []


def check(label: str, condition: bool) -> None:
    status = "OK" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        FAILURES.append(label)


# --- Shared fixtures ---------------------------------------------------------

TEMPLATE = (
    WorkflowStepTemplate("PDD-A", "Marketing Brief", "design", base_weeks=2, sequence_order=1),
    WorkflowStepTemplate("PDD-F", "Proof of Concept", "lab", base_weeks=3, sequence_order=2),
)

ENGINEER_A = EngineerInput("eng-a", "Engineer A", "R&D-Greece", ("A+", "A", "B", "C"))
CHAMBER_GR1 = ChamberInput(
    "ch-gr1", "GR-CH1", "Greece", max_concurrent=1, allowed_stages=("PDD-F",)
)


def _outcome(
    project_id: str,
    *,
    left_out: bool = False,
    within_year: bool = True,
    spillover: bool = False,
    steps: tuple[StepSchedule, ...] = (),
    start_week: int | None = None,
    end_week: int | None = None,
    eng_conflict: bool = False,
    overlap: bool = False,
) -> ProjectScheduleOutcome:
    return ProjectScheduleOutcome(
        project_id=project_id,
        excluded=False,
        left_out=left_out,
        eng_conflict=eng_conflict,
        overlap=overlap,
        cat_not_allowed=False,
        spillover=spillover,
        within_year=within_year,
        no_leader=False,
        no_chamber_step_id=None,
        steps=steps,
        start_week=start_week,
        end_week=end_week,
    )


def _design_step(start: int, *, end: int, engineer: str = "eng-a") -> StepSchedule:
    return StepSchedule(
        step_id="PDD-A",
        sequence_order=1,
        kind="design",
        start_week=start,
        end_week=end,
        duration_weeks=end - start + 1,
        assigned_engineer_id=engineer,
        assigned_chamber_id=None,
    )


def _lab_step(start: int, *, end: int, chamber: str = "ch-gr1") -> StepSchedule:
    return StepSchedule(
        step_id="PDD-F",
        sequence_order=2,
        kind="lab",
        start_week=start,
        end_week=end,
        duration_weeks=end - start + 1,
        assigned_engineer_id=None,
        assigned_chamber_id=chamber,
    )


NON_FROZEN = ProjectInput(
    project_id="p",
    name="P",
    hub="R&D-Greece",
    status="In Queue",
    category="A",
    priority="P2",
    frozen=False,
    leader_engineer_id="eng-a",
)
FROZEN = ProjectInput(
    project_id="p",
    name="P",
    hub="R&D-Greece",
    status="In Development",
    category="A",
    priority="P2",
    frozen=True,
    leader_engineer_id="eng-a",
    actual_start_week=12,
)


# --- 1. Agreeing input -> zero divergences ----------------------------------


def scenario_solvers_agree() -> None:
    proj = ProjectInput(
        project_id="p-agree",
        name="Agree",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P2",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    si = ScheduleInput(
        projects=(proj,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    report = compare_solvers(si)
    check("agree: greedy has zero invariant violations", report.greedy_invariant_violations == ())
    check("agree: cp_sat has zero invariant violations", report.cp_sat_invariant_violations == ())
    check("agree: zero field divergences", report.total_field_divergence_count == 0)
    check("agree: zero diverging projects", report.diverging_project_count == 0)
    check("agree: no unexplained divergences", not report.has_unexplained_divergence)
    check("agree: report.clean is True", report.clean)
    check(
        "agree: greedy and cp_sat objectives equal",
        report.greedy_objective == report.cp_sat_objective,
    )
    check(
        "agree: objective is P2 band weight 3 (one within-year P2 project)",
        report.greedy_objective == 3,
    )


# --- 2. Classifier assigns every bucket correctly --------------------------


def scenario_classifier_buckets() -> None:
    # Bucket 2a: both scheduled fully, different lab chamber / week for a step.
    g = _outcome(
        "p",
        steps=(_design_step(31, end=32), _lab_step(33, end=35, chamber="ch-gr1")),
        start_week=31,
        end_week=35,
    )
    c = _outcome(
        "p",
        steps=(_design_step(31, end=32), _lab_step(34, end=36, chamber="ch-gr2")),
        start_week=31,
        end_week=36,
    )
    divs = _compare_project(NON_FROZEN, g, c)
    buckets = {d.bucket for d in divs}
    check(
        "classifier 2a: step week/chamber diff -> OPEN_CHOICE_WEEK_OR_CHAMBER",
        buckets == {BUCKET_OPEN_CHOICE_WEEK_CHAMBER},
    )
    check("classifier 2a: all explained", all(d.explained for d in divs))

    # Bucket 2b: both scheduled, completion lands either side of within_year_week.
    g2 = _outcome("p", within_year=True, spillover=False, start_week=31, end_week=50)
    c2 = _outcome("p", within_year=False, spillover=True, start_week=31, end_week=53)
    divs2 = _compare_project(NON_FROZEN, g2, c2)
    b2 = {d.field: d.bucket for d in divs2}
    check(
        "classifier 2b: within_year diff -> OPEN_CHOICE_COMPLETION_WEEK",
        b2.get("within_year") == BUCKET_OPEN_CHOICE_COMPLETION,
    )
    check(
        "classifier 2b: spillover diff -> OPEN_CHOICE_COMPLETION_WEEK",
        b2.get("spillover") == BUCKET_OPEN_CHOICE_COMPLETION,
    )
    check(
        "classifier 2b: end_week diff -> OPEN_CHOICE_WEEK_OR_CHAMBER",
        b2.get("end_week") == BUCKET_OPEN_CHOICE_WEEK_CHAMBER,
    )

    # Bucket 1: both LEFT_OUT, greedy retains a partial step, CP-SAT clears it.
    g3 = _outcome(
        "p", left_out=True, within_year=False, steps=(_design_step(31, end=32),), start_week=31,
        end_week=32,
    )
    c3 = _outcome("p", left_out=True, within_year=False, steps=(), start_week=None, end_week=None)
    divs3 = _compare_project(NON_FROZEN, g3, c3)
    check("classifier 1: at least one divergence", len(divs3) > 0)
    check(
        "classifier 1: every divergence -> I5_CLEAN_LEFT_OUT_VS_PARTIAL_RETENTION",
        {d.bucket for d in divs3} == {BUCKET_I5_CLEAN_LEFT_OUT},
    )
    check("classifier 1: all explained", all(d.explained for d in divs3))

    # Bucket 3: solvers disagree on whether the project is LEFT_OUT.
    g4 = _outcome(
        "p", left_out=False, within_year=True,
        steps=(_design_step(31, end=32), _lab_step(33, end=35)), start_week=31, end_week=35,
    )
    c4 = _outcome("p", left_out=True, within_year=False, steps=(), start_week=None, end_week=None)
    divs4 = _compare_project(NON_FROZEN, g4, c4)
    check(
        "classifier 3: every divergence -> DIFFERENT_PROJECT_SET_ADR0005",
        {d.bucket for d in divs4} == {BUCKET_DIFFERENT_PROJECT_SET},
    )
    check("classifier 3: all explained", all(d.explained for d in divs4))

    # Bucket 4: a frozen project diverges at all -> UNEXPLAINED_FROZEN_DIVERGENCE.
    g5 = _outcome("p", steps=(_design_step(12, end=13),), start_week=12, end_week=13)
    c5 = _outcome("p", steps=(_design_step(14, end=15),), start_week=14, end_week=15)
    divs5 = _compare_project(FROZEN, g5, c5)
    check("classifier 4: frozen divergence flagged", len(divs5) > 0)
    check(
        "classifier 4: every frozen divergence -> UNEXPLAINED_FROZEN_DIVERGENCE",
        {d.bucket for d in divs5} == {BUCKET_UNEXPLAINED_FROZEN},
    )
    check("classifier 4: NOT explained", all(not d.explained for d in divs5))

    # Non-frozen, both fully scheduled, engineer assignment differs (leader is
    # fixed -> this is a real signal, must be UNEXPLAINED).
    bucket = _classify(
        NON_FROZEN,
        _outcome("p", steps=(_design_step(31, end=32, engineer="eng-a"),)),
        _outcome("p", steps=(_design_step(31, end=32, engineer="eng-b"),)),
        "step:PDD-A",
        "assigned_engineer_id",
    )
    check("classifier: differing assigned_engineer_id -> UNEXPLAINED", bucket == BUCKET_UNEXPLAINED)

    # cat_not_allowed is deterministic from input -> a divergence is UNEXPLAINED.
    g6 = _outcome("p")
    c6 = ProjectScheduleOutcome(
        project_id="p", excluded=False, left_out=False, eng_conflict=False, overlap=False,
        cat_not_allowed=True, spillover=False, within_year=True, no_leader=False,
        no_chamber_step_id=None, steps=(), start_week=None, end_week=None,
    )
    divs6 = _compare_project(NON_FROZEN, g6, c6)
    check(
        "classifier: cat_not_allowed divergence -> UNEXPLAINED",
        any(d.field == "cat_not_allowed" and d.bucket == BUCKET_UNEXPLAINED for d in divs6),
    )


# --- 3. Full real 46-project seed dataset ----------------------------------


def _load_seed_schedule_input() -> ScheduleInput:
    seed_path = Path(__file__).resolve().parent.parent / "seed" / "prototype_seed_data.json"
    seed = json.loads(seed_path.read_text())
    engineers = tuple(
        EngineerInput(
            engineer_id=e["name"], name=e["name"], hub=e["hub"],
            allowed_categories=tuple(e["cats"]), fte=e["fte"],
        )
        for e in seed["engineers"]
    )
    chambers = tuple(
        ChamberInput(
            chamber_id=c["id"], code=c["id"], lab_region=c["labHub"], max_concurrent=c["max"],
            allowed_stages=tuple(f"PDD-{letter}" for letter in c["stages"]),
            efficiency=c["eff"], weeks_per_chamber=c["wksCh"],
        )
        for c in seed["chambers"]
    )
    projects = tuple(
        ProjectInput(
            project_id=p["id"], name=p["name"], hub=p["hub"], status=p["status"],
            category=p["cat"], priority=p["prio"], frozen=p["frozen"],
            leader_engineer_id=p["leader"],
            actual_start_week=p["actualStart"] if p["frozen"] else None, delay_weeks=p["delay"],
        )
        for p in seed["projects"]
    )
    return ScheduleInput(projects=projects, engineers=engineers, chambers=chambers)


def real_seed_dataset() -> None:
    seed_path = Path(__file__).resolve().parent.parent / "seed" / "prototype_seed_data.json"
    if not seed_path.exists():
        check("real_seed_dataset: seed file present (skipped, not found)", False)
        return

    si = _load_seed_schedule_input()
    t0 = time.time()
    report = compare_solvers(si, cp_sat_max_time_in_seconds=60.0)
    wall = time.time() - t0

    print()
    print(format_report(report))
    print()
    print(f"(compare_solvers wall clock: {wall:.2f}s)")
    print()

    check(
        f"real_seed_dataset: CP-SAT status OPTIMAL (got {report.cp_sat_status})",
        report.cp_sat_status == "OPTIMAL",
    )
    check(
        f"real_seed_dataset: greedy zero invariant violations "
        f"(got {len(report.greedy_invariant_violations)})",
        report.greedy_invariant_violations == (),
    )
    check(
        f"real_seed_dataset: CP-SAT zero invariant violations "
        f"(got {len(report.cp_sat_invariant_violations)})",
        report.cp_sat_invariant_violations == (),
    )
    check(
        f"real_seed_dataset: zero frozen-project divergences "
        f"(got {report.frozen_diverging_project_count})",
        report.frozen_diverging_project_count == 0,
    )
    check(
        f"real_seed_dataset: zero UNEXPLAINED divergences "
        f"(got {len(report.unexplained_divergences)})",
        len(report.unexplained_divergences) == 0,
    )
    check("real_seed_dataset: report.clean is True", report.clean)
    check(
        "real_seed_dataset: every divergence bucket is an explained bucket",
        all(b in EXPLAINED_BUCKETS for b in report.divergence_counts_by_bucket),
    )


# --- 4. Determinism -------------------------------------------------------


def determinism() -> None:
    si = _load_seed_schedule_input()
    r1 = compare_solvers(si, cp_sat_max_time_in_seconds=60.0)
    r2 = compare_solvers(si, cp_sat_max_time_in_seconds=60.0)
    check("determinism: greedy output identical", r1.greedy_output == r2.greedy_output)
    check("determinism: cp_sat output identical", r1.cp_sat_output == r2.cp_sat_output)
    check(
        "determinism: objectives identical",
        (r1.greedy_objective, r1.cp_sat_objective)
        == (r2.greedy_objective, r2.cp_sat_objective),
    )
    check(
        "determinism: divergence set identical",
        r1.project_divergences == r2.project_divergences,
    )
    check(
        "determinism: bucket counts identical",
        r1.divergence_counts_by_bucket == r2.divergence_counts_by_bucket,
    )
    check(
        "determinism: invariant results identical",
        (r1.greedy_invariant_violations, r1.cp_sat_invariant_violations)
        == (r2.greedy_invariant_violations, r2.cp_sat_invariant_violations),
    )


def main() -> int:
    print("=== 1. Solvers agree on a simple input ===")
    scenario_solvers_agree()
    print()
    print("=== 2. Divergence classifier buckets ===")
    scenario_classifier_buckets()
    print()
    print("=== 3. Full real 46-project seed dataset ===")
    real_seed_dataset()
    print()
    print("=== 4. Determinism ===")
    determinism()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) FAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
