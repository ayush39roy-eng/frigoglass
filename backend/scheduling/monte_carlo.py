"""Monte Carlo delivery forecast (P50/P80) on top of the P2 solvers (P2-T08).

Runs one of the P2 solvers (`run_greedy_sgs` by default, `run_cp_sat` optionally)
repeatedly on *perturbed* copies of a single `ScheduleInput`, then summarises each
project's completion-week distribution as P50 / P80 nearest-rank percentiles plus
a per-project left-out frequency and within-year frequency.

--------------------------------------------------------------------------------
Purity / determinism
--------------------------------------------------------------------------------
`forecast_delivery` is pure: `ScheduleInput` in, `DeliveryForecast` (frozen
dataclass) out. No DB / network / filesystem access anywhere in this function or
anything it calls. The `__main__` block and `scheduling._selftest_monte_carlo`
load `backend/seed/prototype_seed_data.json` directly -- exactly as
`scheduling._selftest_cp_sat` / `._selftest_invariants` / `._selftest_solver_comparison`
do -- and that JSON read lives *only* in the script entry point, never in
`forecast_delivery`.

Determinism is non-negotiable and matches the rest of `backend/scheduling/`:

  - A single `random.Random(seed)` instance is threaded through the whole run.
    No `random.` module-level calls, no `numpy`, no global RNG state.
  - Every per-iteration draw happens in a fixed, sorted order (duration factor
    first, then per-project delay in `project_id` order), so a fixed `seed`
    reproduces the exact same list of perturbed inputs and therefore the exact
    same forecast, byte for byte.
  - With `solver="greedy"` the inner solve is itself deterministic (Invariant
    I8). With `solver="cp_sat"` each iteration's solve is given its own fixed
    `random_seed` (drawn from the threaded RNG) and `num_search_workers=1`; this
    is "empirically deterministic" with the same caveat `cp_sat.py` documents --
    a wall-clock-bounded solver cannot *formally* guarantee cross-machine
    byte-identity. Greedy is therefore the recommended inner solver for the
    forecast.

--------------------------------------------------------------------------------
Design decisions (DOMAIN_RULES.md does not specify these -- see the P2-T08
docs/MEMORY.md entry for the full justification)
--------------------------------------------------------------------------------
1. Inner solver: greedy by default (~2 ms/solve on the real 46-project dataset,
   deterministic). CP-SAT is ~1.8 s/solve -> a 500-iteration loop would take
   ~15 min and only be empirically deterministic. `solver="cp_sat"` is available
   for callers who want it (reduce `iterations` accordingly).

2. Perturbation model, two independent dimensions, both on by default:
   a. Per-project additive delay (ADR 0004 makes `delay_weeks` a *terminal*
      adjustment, so it moves the completion week without destabilising the
      schedule structure). Extra weeks ~ Poisson(lambda_i) with
      lambda_i = delay_lambda_base + delay_lambda_per_current_week * max(0,
      project.delay_weeks) -- i.e. projects already flagged late slip more in
      expectation. Poisson is the natural non-negative integer "count of extra
      weeks" distribution and has a single parameter per project.
   b. A per-iteration global multiplicative factor on every workflow step's
      `base_weeks`, drawn from a triangular distribution
      Triangular(low=0.85, high=1.30, mode=1.0) -- the classic PERT / three-point
      project-estimate distribution, deliberately right-skewed (overruns more
      common than underruns). This is what makes contention -- and therefore
      `left_out` / `spillover` -- actually vary across iterations; delay
      perturbation alone never changes feasibility.
   Every distribution parameter is a function argument with a documented
   default. A real client-calibrated distribution replaces exactly those
   defaults (or the whole model, by setting both `*_perturbation` flags False
   and pre-perturbing the inputs upstream).

3. Iterations: default 500. Measured wall clock on the real 46-project seed
   dataset with the greedy inner solver: see the P2-T08 docs/MEMORY.md entry.

4. "Completion week" for an iteration:
   - fully-scheduled project: `last_step_end_week + perturbed_delay_weeks`
     (identical to greedy's own within-year formula input).
   - `left_out` in that iteration: `None` -- excluded from that project's
     percentile computation, counted in `iterations_left_out`.
   - `excluded` project (Commercialized / On Hold / Draft / ...): never
     forecast; `excluded=True`, percentiles `None`, `within_year_frequency`
     mirrors the solver (1.0 iff Commercialized).

5. Percentile method: nearest-rank on the ascending-sorted completion weeks.
   For percentile p and N samples, rank = ceil(p/100 * N) (1-indexed, clamped
   to [1, N]); the value at that rank is returned. No interpolation, no library
   default -- fully reproducible. N == 0 -> `None`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from random import Random

from scheduling.cp_sat import run_cp_sat
from scheduling.greedy import run_greedy_sgs
from scheduling.types import (
    ProjectInput,
    ScheduleInput,
    ScheduleOutput,
    WorkflowStepTemplate,
)

# --- Public constants -------------------------------------------------------

SOLVER_GREEDY = "greedy"
SOLVER_CP_SAT = "cp_sat"
VALID_SOLVERS = (SOLVER_GREEDY, SOLVER_CP_SAT)

DEFAULT_ITERATIONS = 500
DEFAULT_SEED = 20260830

DEFAULT_DELAY_LAMBDA_BASE = 1.0
DEFAULT_DELAY_LAMBDA_PER_CURRENT_WEEK = 0.5

DEFAULT_DURATION_FACTOR_LOW = 0.85
DEFAULT_DURATION_FACTOR_HIGH = 1.30
DEFAULT_DURATION_FACTOR_MODE = 1.0

DEFAULT_CP_SAT_MAX_TIME_IN_SECONDS = 60.0


# --- Result dataclasses ----------------------------------------------------


@dataclass(frozen=True)
class PerturbationParams:
    """Echo of the perturbation configuration a `DeliveryForecast` was produced
    under, so a forecast is self-describing and a re-run is unambiguous."""

    delay_perturbation: bool
    delay_lambda_base: float
    delay_lambda_per_current_week: float
    duration_perturbation: bool
    duration_factor_low: float
    duration_factor_high: float
    duration_factor_mode: float


@dataclass(frozen=True)
class ProjectDeliveryForecast:
    """Per-project forecast over `iterations` perturbed solver runs.

    `completion_weeks` is the raw drill-in data: one entry per iteration in
    which the project was scheduled (not `left_out`, not `excluded`), sorted
    ascending. Its length is `iterations_scheduled`.

    Frequencies are fractions of *all* `iterations` (not of the scheduled
    subset), so `left_out_frequency + within_year_frequency` need not sum to
    anything in particular -- a project can be scheduled-but-spillover in the
    remaining iterations.
    """

    project_id: str
    excluded: bool
    iterations: int
    iterations_scheduled: int
    iterations_left_out: int
    iterations_within_year: int
    left_out_frequency: float
    within_year_frequency: float
    p50_completion_week: int | None
    p80_completion_week: int | None
    min_completion_week: int | None
    max_completion_week: int | None
    completion_weeks: tuple[int, ...]


@dataclass(frozen=True)
class DeliveryForecast:
    """Full forecast output. `project_forecasts` is sorted by `project_id`.

    `within_year_count_per_iteration` is the portfolio-level count of
    within-year projects for each iteration, in iteration order (the raw
    drill-in series). `p50_within_year_count` / `p80_within_year_count` are
    nearest-rank percentiles of that series sorted ascending -- i.e.
    `p80_within_year_count` is the optimistic tail (80% of iterations delivered
    this many or fewer).
    """

    iterations: int
    seed: int
    solver: str
    perturbation: PerturbationParams
    project_forecasts: tuple[ProjectDeliveryForecast, ...]
    within_year_count_per_iteration: tuple[int, ...]
    p50_within_year_count: int
    p80_within_year_count: int


# --- Sampling helpers ------------------------------------------------------


def _poisson(rng: Random, lam: float) -> int:
    """Knuth's algorithm, driven by `rng.random()` so it stays inside the single
    threaded RNG. `lam` is small in this domain (<= ~2.5), so the expected
    number of draws is small. `lam == 0` -> always 0."""

    if lam < 0:
        raise ValueError(f"Poisson lambda must be >= 0, got {lam}")
    if lam == 0:
        return 0
    target = math.exp(-lam)
    k = 0
    p = 1.0
    while True:
        p *= rng.random()
        if p <= target:
            return k
        k += 1


def _nearest_rank(sorted_values: list[int], pct: float) -> int | None:
    """Nearest-rank percentile: rank = ceil(pct/100 * N), 1-indexed, clamped to
    [1, N]. No interpolation. `sorted_values` MUST already be ascending."""

    n = len(sorted_values)
    if n == 0:
        return None
    rank = math.ceil(pct / 100.0 * n)
    rank = max(1, min(rank, n))
    return sorted_values[rank - 1]


def _perturbed_steps(
    base_steps: tuple[WorkflowStepTemplate, ...], factor: float
) -> tuple[WorkflowStepTemplate, ...]:
    """Scale every step's nominal `base_weeks` by `factor`, re-round to a
    positive integer. The category multiplier + `max(1, round(...))` in
    `duration_weeks` is then applied downstream by the solver as usual."""

    return tuple(
        replace(s, base_weeks=max(1, round(s.base_weeks * factor)))
        for s in base_steps
    )


# --- Core entry point ------------------------------------------------------


def forecast_delivery(
    schedule_input: ScheduleInput,
    *,
    iterations: int = DEFAULT_ITERATIONS,
    seed: int = DEFAULT_SEED,
    solver: str = SOLVER_GREEDY,
    delay_perturbation: bool = True,
    delay_lambda_base: float = DEFAULT_DELAY_LAMBDA_BASE,
    delay_lambda_per_current_week: float = DEFAULT_DELAY_LAMBDA_PER_CURRENT_WEEK,
    duration_perturbation: bool = True,
    duration_factor_low: float = DEFAULT_DURATION_FACTOR_LOW,
    duration_factor_high: float = DEFAULT_DURATION_FACTOR_HIGH,
    duration_factor_mode: float = DEFAULT_DURATION_FACTOR_MODE,
    cp_sat_max_time_in_seconds: float = DEFAULT_CP_SAT_MAX_TIME_IN_SECONDS,
) -> DeliveryForecast:
    """Monte Carlo delivery forecast. Pure and deterministic given `seed`.

    See the module docstring for the perturbation model and every gap-fill
    decision. `iterations=1` with both `*_perturbation` flags `False` reproduces
    the unperturbed solver's completion weeks exactly.
    """

    if iterations < 1:
        raise ValueError(f"iterations must be >= 1, got {iterations}")
    if solver not in VALID_SOLVERS:
        raise ValueError(f"solver must be one of {VALID_SOLVERS}, got {solver!r}")
    if delay_perturbation and (
        delay_lambda_base < 0 or delay_lambda_per_current_week < 0
    ):
        raise ValueError("delay lambda parameters must be >= 0")
    if duration_perturbation and not (
        0 < duration_factor_low <= duration_factor_mode <= duration_factor_high
    ):
        raise ValueError(
            "require 0 < duration_factor_low <= duration_factor_mode "
            "<= duration_factor_high"
        )

    rng = Random(seed)
    params = PerturbationParams(
        delay_perturbation=delay_perturbation,
        delay_lambda_base=delay_lambda_base,
        delay_lambda_per_current_week=delay_lambda_per_current_week,
        duration_perturbation=duration_perturbation,
        duration_factor_low=duration_factor_low,
        duration_factor_high=duration_factor_high,
        duration_factor_mode=duration_factor_mode,
    )

    projects_sorted = sorted(schedule_input.projects, key=lambda p: p.project_id)
    base_steps = tuple(
        sorted(schedule_input.workflow_steps, key=lambda s: s.sequence_order)
    )

    completion_samples: dict[str, list[int]] = {
        p.project_id: [] for p in projects_sorted
    }
    left_out_counts: dict[str, int] = {p.project_id: 0 for p in projects_sorted}
    within_year_counts: dict[str, int] = {p.project_id: 0 for p in projects_sorted}
    excluded_flags: dict[str, bool] = {p.project_id: False for p in projects_sorted}
    within_year_count_per_iteration: list[int] = []

    for _ in range(iterations):
        # 1. Duration factor -- one draw, always first, so the RNG call sequence
        #    is fixed regardless of project count.
        if duration_perturbation:
            factor = rng.triangular(
                duration_factor_low, duration_factor_high, duration_factor_mode
            )
            iter_steps = _perturbed_steps(base_steps, factor)
        else:
            iter_steps = base_steps

        # 2. Per-project additive delay, in project_id order.
        perturbed_delay: dict[str, int] = {}
        for p in projects_sorted:
            if delay_perturbation:
                lam = delay_lambda_base + delay_lambda_per_current_week * max(
                    0, p.delay_weeks
                )
                extra = _poisson(rng, lam)
            else:
                extra = 0
            perturbed_delay[p.project_id] = p.delay_weeks + extra

        perturbed_projects = tuple(
            replace(p, delay_weeks=perturbed_delay[p.project_id])
            for p in schedule_input.projects
        )
        perturbed_input = ScheduleInput(
            projects=perturbed_projects,
            engineers=schedule_input.engineers,
            chambers=schedule_input.chambers,
            workflow_steps=iter_steps,
            current_week=schedule_input.current_week,
            horizon_weeks=schedule_input.horizon_weeks,
            within_year_week=schedule_input.within_year_week,
        )

        # 3. Solve.
        output = _solve(
            perturbed_input, solver, rng, cp_sat_max_time_in_seconds
        )

        # 4. Collect.
        iter_within_year = 0
        for oc in output.project_outcomes:
            if oc.excluded:
                excluded_flags[oc.project_id] = True
                if oc.within_year:
                    within_year_counts[oc.project_id] += 1
                    iter_within_year += 1
                continue
            if oc.left_out:
                left_out_counts[oc.project_id] += 1
                continue
            if oc.end_week is not None:
                completion_samples[oc.project_id].append(
                    oc.end_week + perturbed_delay[oc.project_id]
                )
            if oc.within_year:
                within_year_counts[oc.project_id] += 1
                iter_within_year += 1
        within_year_count_per_iteration.append(iter_within_year)

    project_forecasts = tuple(
        _build_project_forecast(
            project_id=p.project_id,
            iterations=iterations,
            samples=completion_samples[p.project_id],
            left_out=left_out_counts[p.project_id],
            within_year=within_year_counts[p.project_id],
            excluded=excluded_flags[p.project_id],
        )
        for p in projects_sorted
    )

    wy_sorted = sorted(within_year_count_per_iteration)
    p50_count = _nearest_rank(wy_sorted, 50.0)
    p80_count = _nearest_rank(wy_sorted, 80.0)
    assert p50_count is not None and p80_count is not None  # iterations >= 1

    return DeliveryForecast(
        iterations=iterations,
        seed=seed,
        solver=solver,
        perturbation=params,
        project_forecasts=project_forecasts,
        within_year_count_per_iteration=tuple(within_year_count_per_iteration),
        p50_within_year_count=p50_count,
        p80_within_year_count=p80_count,
    )


def _solve(
    perturbed_input: ScheduleInput,
    solver: str,
    rng: Random,
    cp_sat_max_time_in_seconds: float,
) -> ScheduleOutput:
    if solver == SOLVER_GREEDY:
        return run_greedy_sgs(perturbed_input)
    # cp_sat: give each iteration its own fixed seed drawn from the threaded RNG
    # so the whole forecast stays reproducible; single-threaded for determinism.
    iter_seed = rng.randrange(1, 2_147_483_647)
    output, _info = run_cp_sat(
        perturbed_input,
        max_time_in_seconds=cp_sat_max_time_in_seconds,
        num_search_workers=1,
        random_seed=iter_seed,
    )
    return output


def _build_project_forecast(
    *,
    project_id: str,
    iterations: int,
    samples: list[int],
    left_out: int,
    within_year: int,
    excluded: bool,
) -> ProjectDeliveryForecast:
    ordered = sorted(samples)
    return ProjectDeliveryForecast(
        project_id=project_id,
        excluded=excluded,
        iterations=iterations,
        iterations_scheduled=len(ordered),
        iterations_left_out=left_out,
        iterations_within_year=within_year,
        left_out_frequency=left_out / iterations,
        within_year_frequency=within_year / iterations,
        p50_completion_week=_nearest_rank(ordered, 50.0),
        p80_completion_week=_nearest_rank(ordered, 80.0),
        min_completion_week=ordered[0] if ordered else None,
        max_completion_week=ordered[-1] if ordered else None,
        completion_weeks=tuple(ordered),
    )


# --- Text formatter -------------------------------------------------------


def format_forecast(forecast: DeliveryForecast, *, max_projects: int = 60) -> str:
    lines: list[str] = []
    lines.append("=" * 78)
    lines.append("MONTE CARLO DELIVERY FORECAST")
    lines.append("=" * 78)
    lines.append(
        f"iterations={forecast.iterations}  seed={forecast.seed}  "
        f"solver={forecast.solver}"
    )
    p = forecast.perturbation
    lines.append(
        f"delay_perturbation={p.delay_perturbation} "
        f"(lambda_base={p.delay_lambda_base}, "
        f"lambda_per_current_week={p.delay_lambda_per_current_week})"
    )
    lines.append(
        f"duration_perturbation={p.duration_perturbation} "
        f"(triangular low={p.duration_factor_low}, mode={p.duration_factor_mode}, "
        f"high={p.duration_factor_high})"
    )
    lines.append("")
    lines.append(
        f"portfolio within-year count: P50={forecast.p50_within_year_count}  "
        f"P80={forecast.p80_within_year_count}  "
        f"(min={min(forecast.within_year_count_per_iteration)}, "
        f"max={max(forecast.within_year_count_per_iteration)})"
    )
    lines.append("")
    lines.append(
        f"{'project':<12} {'P50':>5} {'P80':>5} {'left_out':>9} "
        f"{'within_yr':>10}  note"
    )
    lines.append("-" * 78)
    for pf in forecast.project_forecasts[:max_projects]:
        if pf.excluded:
            note = "excluded"
        elif pf.iterations_scheduled == 0:
            note = "left out every iteration"
        else:
            note = ""
        p50 = "-" if pf.p50_completion_week is None else str(pf.p50_completion_week)
        p80 = "-" if pf.p80_completion_week is None else str(pf.p80_completion_week)
        lines.append(
            f"{pf.project_id:<12} {p50:>5} {p80:>5} "
            f"{pf.left_out_frequency:>9.2f} {pf.within_year_frequency:>10.2f}  {note}"
        )
    if len(forecast.project_forecasts) > max_projects:
        lines.append(
            f"  ... {len(forecast.project_forecasts) - max_projects} more project(s)"
        )
    lines.append("=" * 78)
    return "\n".join(lines)


# --- Script entry point (loads the real seed dataset) --------------------


def _load_seed_schedule_input() -> ScheduleInput:
    """Load `backend/seed/prototype_seed_data.json` into a `ScheduleInput`,
    byte-for-byte the same mapping the other `_selftest_*` modules use. Only
    ever called from `__main__` / the self-test -- never from
    `forecast_delivery`."""

    import json
    from pathlib import Path

    from scheduling.types import ChamberInput, EngineerInput

    seed_path = (
        Path(__file__).resolve().parent.parent / "seed" / "prototype_seed_data.json"
    )
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
    forecast = forecast_delivery(schedule_input)
    print(format_forecast(forecast))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
