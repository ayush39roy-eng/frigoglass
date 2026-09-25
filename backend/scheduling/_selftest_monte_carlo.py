"""Informal self-test for P2-T08's Monte Carlo delivery forecast
(`scheduling.monte_carlo`).

Run directly: `python -m scheduling._selftest_monte_carlo` from `backend/`.

Same status as `scheduling._selftest` (P2-T01), `scheduling._selftest_invariants`
(P2-T04), `scheduling._selftest_cp_sat` (P2-T06) and
`scheduling._selftest_solver_comparison` (P2-T07): deliberately NOT a pytest
module under `backend/tests/` -- formal pytest coverage of `backend/scheduling/`
(>=85%) is P2-T09's job, which will port these `_selftest_*` scripts.

What this verifies:

  1. `_nearest_rank` (the percentile method) is correct on hand-computed
     examples, including the empty, single-sample, duplicate-value, and
     endpoint (p=1 / p=100) cases.
  2. Determinism (Invariant I8, extended to the forecaster): `forecast_delivery`
     called twice with the same `seed` returns an *equal* `DeliveryForecast`
     (frozen dataclasses, all-tuple fields -> value equality is byte-identity
     of the serialised form), and the result does not depend on the order the
     projects are supplied in.
  3. Perturbation is actually wired: a different `seed` produces different
     perturbed draws; delay-only perturbation never moves a completion week
     earlier and moves at least one later; duration-only perturbation changes
     the completion-week distribution.
  4. `iterations=1` with both `*_perturbation=False` reproduces the unperturbed
     greedy solver's completion weeks *exactly* -- cross-checked field by field
     against a direct `run_greedy_sgs` call.
  5. Percentile ordering (P50 <= P80 for every project), frequencies in [0, 1],
     `iterations_scheduled + iterations_left_out <= iterations`, and excluded
     projects are never forecast (percentiles `None`, no samples).
  6. The whole thing runs on the real 46-project seed dataset and the headline
     numbers are printed for the MEMORY.md entry.
"""

from __future__ import annotations

from dataclasses import replace

from scheduling import forecast_delivery, format_forecast, run_greedy_sgs
from scheduling.monte_carlo import (
    _load_seed_schedule_input,
    _nearest_rank,
)

FAILURES: list[str] = []


def check(label: str, condition: bool) -> None:
    status = "OK" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        FAILURES.append(label)


# --- 1. Percentile method (_nearest_rank) ---------------------------------


def percentile_method() -> None:
    check("_nearest_rank: empty -> None", _nearest_rank([], 50.0) is None)
    check("_nearest_rank: empty p80 -> None", _nearest_rank([], 80.0) is None)

    vals = [10, 20, 30, 40, 50]
    # rank = ceil(p/100 * 5): p50 -> ceil(2.5)=3 -> vals[2]=30
    check("_nearest_rank: p50 of 1..5 -> 30", _nearest_rank(vals, 50.0) == 30)
    # p80 -> ceil(4.0)=4 -> vals[3]=40
    check("_nearest_rank: p80 of 1..5 -> 40", _nearest_rank(vals, 80.0) == 40)
    # p100 -> ceil(5.0)=5 -> vals[4]=50
    check("_nearest_rank: p100 of 1..5 -> 50", _nearest_rank(vals, 100.0) == 50)
    # p1 -> ceil(0.05)=1 (clamped) -> vals[0]=10
    check("_nearest_rank: p1 of 1..5 -> 10", _nearest_rank(vals, 1.0) == 10)

    check("_nearest_rank: single sample p50", _nearest_rank([7], 50.0) == 7)
    check("_nearest_rank: single sample p80", _nearest_rank([7], 80.0) == 7)

    dup = [5, 5, 9, 9]
    # p50 -> ceil(2.0)=2 -> dup[1]=5 ; p80 -> ceil(3.2)=4 -> dup[3]=9
    check("_nearest_rank: p50 of [5,5,9,9] -> 5", _nearest_rank(dup, 50.0) == 5)
    check("_nearest_rank: p80 of [5,5,9,9] -> 9", _nearest_rank(dup, 80.0) == 9)

    check(
        "_nearest_rank: p50 <= p80 on a random-ish sorted list",
        _nearest_rank([3, 3, 4, 7, 11, 11, 40], 50.0)
        <= _nearest_rank([3, 3, 4, 7, 11, 11, 40], 80.0),
    )


# --- 2. Determinism -------------------------------------------------------


def determinism() -> None:
    si = _load_seed_schedule_input()

    f1 = forecast_delivery(si, iterations=40, seed=12345)
    f2 = forecast_delivery(si, iterations=40, seed=12345)
    check("determinism: same seed -> equal DeliveryForecast", f1 == f2)
    check(
        "determinism: same seed -> equal project_forecasts tuple",
        f1.project_forecasts == f2.project_forecasts,
    )
    check(
        "determinism: same seed -> equal within_year series",
        f1.within_year_count_per_iteration == f2.within_year_count_per_iteration,
    )
    check(
        "determinism: same seed -> equal portfolio percentiles",
        (f1.p50_within_year_count, f1.p80_within_year_count)
        == (f2.p50_within_year_count, f2.p80_within_year_count),
    )

    # No dependence on the order projects are supplied in.
    si_rev = replace(si, projects=tuple(reversed(si.projects)))
    f3 = forecast_delivery(si_rev, iterations=40, seed=12345)
    check("determinism: project input order does not affect forecast", f1 == f3)


# --- 3. Perturbation is actually wired ----------------------------------


def perturbation_wired() -> None:
    si = _load_seed_schedule_input()

    # Different seed -> different perturbed draws.
    a = forecast_delivery(si, iterations=60, seed=1)
    b = forecast_delivery(si, iterations=60, seed=2)
    all_weeks_a = tuple(
        w for pf in a.project_forecasts for w in pf.completion_weeks
    )
    all_weeks_b = tuple(
        w for pf in b.project_forecasts for w in pf.completion_weeks
    )
    check(
        "perturbation: different seed -> different draws",
        a.within_year_count_per_iteration != b.within_year_count_per_iteration
        or all_weeks_a != all_weeks_b,
    )

    # Unperturbed baseline (one deterministic solve).
    base = forecast_delivery(
        si,
        iterations=1,
        seed=5,
        delay_perturbation=False,
        duration_perturbation=False,
    )
    base_by_id = {pf.project_id: pf for pf in base.project_forecasts}

    # Delay-only perturbation: ADR 0004 makes delay terminal, so step end
    # weeks are unchanged and completion = end_week + (delay + extra >= 0).
    # No completion week may move earlier; at least one must move later.
    delay_only = forecast_delivery(
        si,
        iterations=80,
        seed=5,
        delay_perturbation=True,
        duration_perturbation=False,
    )
    never_earlier = True
    at_least_one_later = False
    for pf in delay_only.project_forecasts:
        bp = base_by_id[pf.project_id]
        if bp.p50_completion_week is None or pf.min_completion_week is None:
            continue
        if pf.min_completion_week < bp.p50_completion_week:
            never_earlier = False
        if pf.max_completion_week > bp.p50_completion_week:
            at_least_one_later = True
    check("perturbation: delay-only never moves a completion week earlier", never_earlier)
    check("perturbation: delay-only moves at least one completion week later", at_least_one_later)

    # Duration-only perturbation changes the completion-week distribution.
    dur_only = forecast_delivery(
        si,
        iterations=80,
        seed=7,
        delay_perturbation=False,
        duration_perturbation=True,
    )
    dur_weeks = {
        pf.project_id: pf.completion_weeks for pf in dur_only.project_forecasts
    }
    base_weeks = {
        pf.project_id: pf.completion_weeks for pf in base.project_forecasts
    }
    check(
        "perturbation: duration-only changes the completion-week distribution",
        any(
            set(dur_weeks[pid]) - set(base_weeks[pid])
            for pid in dur_weeks
            if base_weeks[pid]
        ),
    )

    # The forecast echoes the perturbation config it ran under.
    check(
        "perturbation: params echoed on the forecast",
        delay_only.perturbation.delay_perturbation is True
        and delay_only.perturbation.duration_perturbation is False,
    )


# --- 4. iterations=1, no perturbation == unperturbed greedy --------------


def matches_unperturbed_greedy() -> None:
    si = _load_seed_schedule_input()
    f = forecast_delivery(
        si,
        iterations=1,
        seed=999,
        delay_perturbation=False,
        duration_perturbation=False,
    )
    out = run_greedy_sgs(si)
    outcome_by_id = {o.project_id: o for o in out.project_outcomes}
    project_by_id = {p.project_id: p for p in si.projects}

    check(
        "cross-check: one forecast per input project",
        len(f.project_forecasts) == len(si.projects),
    )

    expected_within_year = 0
    all_match = True
    for pf in f.project_forecasts:
        o = outcome_by_id[pf.project_id]
        if o.within_year:
            expected_within_year += 1

        if o.excluded:
            ok = (
                pf.excluded
                and pf.completion_weeks == ()
                and pf.p50_completion_week is None
                and pf.p80_completion_week is None
                and pf.iterations_scheduled == 0
                and pf.iterations_left_out == 0
            )
        elif o.left_out:
            ok = (
                not pf.excluded
                and pf.completion_weeks == ()
                and pf.iterations_left_out == 1
                and pf.iterations_scheduled == 0
                and pf.p50_completion_week is None
            )
        else:
            expected = o.end_week + project_by_id[pf.project_id].delay_weeks
            ok = (
                pf.completion_weeks == (expected,)
                and pf.p50_completion_week == expected
                and pf.p80_completion_week == expected
                and pf.min_completion_week == expected
                and pf.max_completion_week == expected
                and pf.iterations_scheduled == 1
                and pf.iterations_within_year == (1 if o.within_year else 0)
            )
        if not ok:
            all_match = False
            print(f"    mismatch for {pf.project_id}: forecast={pf} outcome={o}")
    check("cross-check: every project forecast matches unperturbed greedy exactly", all_match)

    check(
        "cross-check: portfolio within-year count matches greedy",
        f.within_year_count_per_iteration == (expected_within_year,),
    )
    check(
        "cross-check: portfolio P50/P80 == the single-iteration count",
        f.p50_within_year_count == expected_within_year
        and f.p80_within_year_count == expected_within_year,
    )


# --- 5. Structural invariants of the forecast --------------------------


def forecast_structure() -> None:
    si = _load_seed_schedule_input()
    f = forecast_delivery(si, iterations=60, seed=424242)

    excluded_ids = {
        o.project_id for o in run_greedy_sgs(si).project_outcomes if o.excluded
    }

    p50_le_p80 = True
    freqs_in_range = True
    counts_bounded = True
    excluded_never_forecast = True
    samples_sorted = True
    minmax_consistent = True

    for pf in f.project_forecasts:
        if pf.p50_completion_week is not None and pf.p80_completion_week is not None:
            if pf.p50_completion_week > pf.p80_completion_week:
                p50_le_p80 = False
        if not (0.0 <= pf.left_out_frequency <= 1.0):
            freqs_in_range = False
        if not (0.0 <= pf.within_year_frequency <= 1.0):
            freqs_in_range = False
        if pf.iterations_scheduled + pf.iterations_left_out > pf.iterations:
            counts_bounded = False
        if len(pf.completion_weeks) != pf.iterations_scheduled:
            counts_bounded = False

        if pf.project_id in excluded_ids or pf.excluded:
            if not (
                pf.excluded
                and pf.completion_weeks == ()
                and pf.p50_completion_week is None
                and pf.p80_completion_week is None
                and pf.iterations_scheduled == 0
                and pf.iterations_left_out == 0
                and pf.iterations_within_year in (0, pf.iterations)
            ):
                excluded_never_forecast = False

        if list(pf.completion_weeks) != sorted(pf.completion_weeks):
            samples_sorted = False
        if pf.completion_weeks:
            if (
                pf.min_completion_week != pf.completion_weeks[0]
                or pf.max_completion_week != pf.completion_weeks[-1]
            ):
                minmax_consistent = False

    check("structure: P50 <= P80 for every project", p50_le_p80)
    check("structure: left_out / within_year frequencies in [0, 1]", freqs_in_range)
    check(
        "structure: iterations_scheduled + iterations_left_out <= iterations "
        "and len(completion_weeks) == iterations_scheduled",
        counts_bounded,
    )
    check("structure: excluded projects are never forecast", excluded_never_forecast)
    check("structure: completion_weeks is ascending-sorted", samples_sorted)
    check("structure: min/max_completion_week match the sample tuple", minmax_consistent)
    check(
        "structure: forecast covers exactly the input projects",
        {pf.project_id for pf in f.project_forecasts}
        == {p.project_id for p in si.projects},
    )
    check(
        "structure: project_forecasts sorted by project_id",
        [pf.project_id for pf in f.project_forecasts]
        == sorted(pf.project_id for pf in f.project_forecasts),
    )


# --- 6. Real seed dataset headline numbers -----------------------------


def real_seed_headline() -> None:
    si = _load_seed_schedule_input()
    check("real dataset: 46 projects loaded", len(si.projects) == 46)

    f = forecast_delivery(si, iterations=200, seed=20260830)
    print()
    print(format_forecast(f))
    print()

    left_out_every_iter = sum(
        1
        for pf in f.project_forecasts
        if not pf.excluded and pf.iterations_scheduled == 0
    )
    scheduled_some = [
        pf
        for pf in f.project_forecasts
        if pf.iterations_scheduled > 0 and pf.p50_completion_week is not None
    ]
    print(
        f"portfolio within-year count: P50={f.p50_within_year_count}  "
        f"P80={f.p80_within_year_count}  "
        f"(min={min(f.within_year_count_per_iteration)}, "
        f"max={max(f.within_year_count_per_iteration)})"
    )
    print(f"projects left out in every one of {f.iterations} iterations: {left_out_every_iter}")
    print("representative per-project P50/P80 completion week:")
    for pf in scheduled_some[:6]:
        print(
            f"  {pf.project_id}: P50={pf.p50_completion_week} P80={pf.p80_completion_week} "
            f"within_year_freq={pf.within_year_frequency:.2f}"
        )

    check("real dataset: forecast produced for all 46 projects", len(f.project_forecasts) == 46)
    check(
        "real dataset: portfolio P50 <= P80 within-year count",
        f.p50_within_year_count <= f.p80_within_year_count,
    )


def main() -> int:
    print("=== 1. Percentile method (_nearest_rank) ===")
    percentile_method()
    print()
    print("=== 2. Determinism ===")
    determinism()
    print()
    print("=== 3. Perturbation is actually wired ===")
    perturbation_wired()
    print()
    print("=== 4. iterations=1 + no perturbation == unperturbed greedy ===")
    matches_unperturbed_greedy()
    print()
    print("=== 5. Forecast structural invariants ===")
    forecast_structure()
    print()
    print("=== 6. Real seed dataset headline numbers ===")
    real_seed_headline()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) FAILED:")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
