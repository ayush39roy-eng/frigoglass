# API contract P18 — the what-if engine (pure Python interface)

Owner: algorithm-engineer (`backend/scheduling/whatif.py`, ADR 0031). Consumer: backend-builder
(P18-T02). This is not an HTTP contract; it is the function interface backend-builder wires into
the scenario API, the tool layer and the chat. Everything is a frozen dataclass; everything is
exported from `scheduling` (`from scheduling import Scenario, simulate, ...`). Engine-only helpers
(`to_jsonable`, `chamber_norm`, `classify_outcome`, the constants) are imported from
`scheduling.whatif`.

No function does I/O, reads a clock, uses randomness, or talks to a model. Calling any of them
never changes the baseline. Run them off the event loop (a worker thread with a time cap, as the
priority preview does). Measured: one greedy run on 250 projects is about 20 ms, so `simulate` is
two runs and `solve_minimum_additions` is at most 60.

## 1. Baseline (caller builds it)

```python
WhatIfBaseline(
    schedule: ScheduleInput,                       # build_schedule_input_from_db(db), the worker's builder
    calendars: tuple[HubCalendarInput, ...] = (),  # one per hub, from HubWorkCalendar
    chamber_supply: tuple[ChamberSupplyInput, ...] = (),  # one per chamber, from Chamber
)
HubCalendarInput(hub, weekdays_per_week=5, national_holiday_days=0.0, medical_leave_days=0.0,
                 casual_leave_days=0.0, annual_leave_days=0.0, weeks_in_year=52)
ChamberSupplyInput(chamber_id, lab_region, platforms, efficiency=1.0, maintenance_weeks=0.0,
                   breakdown_weeks=0.0, calibration_weeks=0.0)
```

`chamber_id` in `chamber_supply` is the same string as `ChamberInput.chamber_id`. A chamber with no
supply row is treated as platforms = `max_concurrent`, its efficiency, zero downtime. A hub with no
calendar row has zero deductions (same as the Capacity surface). `schedule.current_week` fixes the
"remaining" basis. Include every project, engineer and chamber of the plan, not only the caller's
hub: lab capacity is shared across a lab region. Apply hub scope when presenting.

## 2. Scenario (what the planner or the chat describes)

```python
Scenario(
    add_projects: tuple[AddProject, ...] = (),
    add_engineers: tuple[AddEngineer, ...] = (),
    remove_engineers: tuple[str, ...] = (),                 # engineer ids
    remove_engineer_counts: tuple[RemoveEngineerCount, ...] = (),
    add_chambers: tuple[AddChamber, ...] = (),
    chamber_downtime: tuple[ChamberDowntimeChange, ...] = (),
    priority_overrides: tuple[tuple[str, str], ...] = (),   # (project_id, "P1".."Q")
)
AddProject(hub, category, count=1, project_type=None, status="In Queue", priority=None,
           score=None, workflow_id=None, certification_testing_required=True)
AddEngineer(hub, fte=1.0, count=1, allowed_categories=None)
RemoveEngineerCount(hub, count=1)        # removes the least-loaded designers of the hub
AddChamber(lab_region, count=1, platforms=None, efficiency=None, maintenance_weeks=None,
           breakdown_weeks=None, calibration_weeks=None, allowed_stages=None)
ChamberDowntimeChange(chamber_id, maintenance_weeks=None, breakdown_weeks=None,
                      calibration_weeks=None)
```

The plan-year horizon is never changed. `Scenario().is_empty()` is true for the zero scenario.
Validation raises `ValueError` with a plain message (unknown hub, category not valid for the hub's
workflow, `count` outside 1..500, non-schedulable status, unknown priority, unknown engineer /
chamber / project id, negative values, `fte <= 0`). Map it to HTTP 422. `AddProject.priority` wins
over `score` (0..100, DOMAIN_RULES bands). Hubs: the six DOMAIN_RULES hubs. Lab regions: Greece,
India, Romania.

Applied scenario (also what the tests validate against I1 to I22):

```python
apply_scenario(baseline, scenario) -> AppliedScenario   # .schedule_input, .new_project_ids, ...
build_scenario_input(baseline, scenario) -> ScheduleInput
```

New ids are `whatif-p{NNN}-{KKK}`, `whatif-eng-{NNN}`, `whatif-ch-{NNN}`. Names are "What-if
project N" and "What-if designer N". Never persist these.

## 3. `analytic_requirements(baseline, scenario, *, basis="year", designer_fte=1.0, target_below_pct=100.0) -> AnalyticRequirements`

One greedy run of the baseline (about 20 ms), no scenario run. `basis` is `"year"` or `"remaining"` (capacity basis). Fields:

- `extra_design_weeks_total: int`, `extra_lab_weeks_total: float`
- `min_extra_designers_total: int`, `min_extra_chambers_total: int`
- `design: tuple[HubDesignRequirement]` (hubs that have load, added projects or a supply change):
  `hub, added_projects, extra_design_weeks, baseline_load_weeks, new_load_weeks, fte_before,
  fte_after_scenario, working_weeks_per_engineer, capacity_before, capacity_after_scenario,
  booked_pct_before, booked_pct_after, status_before, status_after, min_extra_designers,
  min_extra_fte, designer_fte, reachable`
- `lab: tuple[LabRegionRequirement]`: `lab_region, added_projects, extra_lab_weeks,
  baseline_load_weeks, new_load_weeks, chambers_before, chambers_after_scenario, capacity_before,
  capacity_after_scenario, booked_pct_before, booked_pct_after, status_before, status_after,
  efficient_lab_weeks_per_new_chamber, min_extra_chambers, reachable`
- `workings: tuple[str, ...]`: the arithmetic in reading order, ready to show or to hand to the
  chat as "show your working".

Rules (amended by P18-R01, section 10): "before" load is the ACTIVE RUN's load (the I6 design-week and
I7 lab-week sums of one greedy run of the unmodified baseline, as on Capacity and in `simulate`'s
`utilization_before`); the scenario adds the lead-time demand of the new projects only; capacity follows DOMAIN_RULES "Capacity supply" (`working_weeks_per_engineer x FTE`;
`working_weeks_per_chamber x efficiency x platforms`, region holiday = largest hub holiday-weeks in
the region); booked % and status follow ADR 0016 on the 2 dp figures; `min_extra_*` is the smallest
integer so that the served booked % is strictly below `target_below_pct` (`reachable=False` when a
unit adds no capacity). Statuses are `available`, `near_full`, `full`.

## 4. `simulate(baseline, scenario) -> SimulationResult`

Two greedy runs (baseline, scenario). Fields:

- `projects: tuple[ProjectResult]`, sorted by id, existing and new: `project_id, name, hub,
  category, priority, is_new, outcome, finish_week, within_year, unconstrained_end_week`.
  `outcome` is one of `within_year, spillover, left_out, blocked, excluded, data_error`.
  `finish_week` is `projected_end_week` (null when not scheduled). `unconstrained_end_week > 52`
  means the project cannot finish in the year whatever is added.
- `outcome_counts_before`, `outcome_counts_after`: `{outcome: count}`
- `utilization_before`, `utilization_after: tuple[UtilizationRow]`: six hub rows then three
  lab-region rows: `scope ("hub"|"lab_region"), key, load_weeks, capacity_year, booked_pct_year,
  status_year, capacity_remaining, booked_pct_remaining, status_remaining, units` (`units` = FTE for
  hubs, chamber count for regions). Load is the I6/I7 sum over the scenario run.
- `diff: ScenarioDiff`: `within_year_before, within_year_after, within_year_delta,
  existing_within_year_before, existing_within_year_after, new_projects_total,
  new_projects_within_year, newly_slipping, recovered, moved` where each list is a
  `ProjectChange(project_id, name, hub, kind, before_outcome, after_outcome, before_finish_week,
  after_finish_week)`. Only existing projects whose finish week, within-year flag, left-out,
  blocked or excluded state changed appear.
- `new_project_ids, added_engineer_ids, added_chamber_ids, removed_engineer_ids,
  reassigned_project_ids, greedy_runs, workings`

The within-year rule and finish weeks are the scheduler's own (I9). A downtime-only scenario leaves
the schedule unchanged and moves only supply.

## 5. `solve_minimum_additions(baseline, scenario, target="all_new_within_year", *, max_runs=60, designer_fte=1.0, max_units_per_dimension=25) -> MinimumAdditionsResult`

`target` is `"all_new_within_year"` (every added project that capacity can help finishes by W52) or
`"no_existing_slips"` (no existing project that is within the year in the baseline stops being so).
Additions are on top of the scenario. Result fields:

- `met`: the target holds for every project of the target (false whenever
  `unattainable_project_ids` is non-empty); `met_attainable`: it holds for every project capacity can
  still help.
- `unattainable_project_ids`: added projects whose lead-time critical path alone ends after W52. They
  are excluded from the search; show them as "cannot finish this year whatever is added".
- `additions: Additions(designers=((hub, n), ...), chambers=((lab_region, n), ...))`, `.total`.
  Designers are `designer_fte` FTE each. Chambers take the region norm.
- `capped` (the run cap ended the search early; `additions` is then the best found), `exact` (the
  minimum total is proven), `runs_used`, `run_cap` (at most 60, baseline run included),
  `unmet_project_ids`, `achieved: SimulationResult | None` (the scenario with the additions applied),
  `searched_designer_hubs`, `searched_chamber_regions`, `workings`.
- To re-simulate or validate the recommendation: `scenario_with_additions(scenario, additions,
  designer_fte)` returns the scenario with the additions merged in.

## 6. Serialization

`scheduling.whatif.to_jsonable(obj)` turns any result dataclass into dicts, lists and scalars with
stable key order. The backend still defines its own Pydantic response models (strict); `to_jsonable`
is for tests, logs of non-sensitive structure and chat tool output.

## 7. Guarantees the backend and the chat may rely on

- Same input, same output (I8); safe to cache by a hash of baseline and scenario.
- The baseline objects are not modified.
- The empty scenario gives a zero diff and `met = True` with no additions.
- Adding designers or chambers to a region never lowers its within-year count in the tests (audited
  at runtime; a violation is written to `workings` and clears `exact`).
- Invariants I1 to I22 hold on every simulated run (validated in `tests/scheduling/test_whatif.py`).
- Outputs contain no financial field, customer name or engineer name. The chat must be given only
  these outputs, never the baseline.

## 8. Assumptions (open questions)

OQ #43 (leader assignment, no rebalancing of existing work), #44 (defaults P3 / In Queue, no hard
gates), #45 (year versus remaining basis, strictly below 100), #46 (downtime does not gate booking;
new-chamber norm), #47 (most new projects cannot finish a 52-week year from W42), #48 (cost of a
designer versus a chamber, search limits).

---

# 9. HTTP API (P18-T02, backend-builder) — consumer: frontend-builder (P18-T03)

Router `backend/api/routers/whatif.py`, schemas `backend/schemas/whatif.py`, services
`backend/services/whatif*.py`. All four endpoints are `POST`, JSON in, JSON out, under `/whatif`.
Every request model is strict and rejects unknown keys (422). Every response is a named Pydantic
model (see `GET /openapi.json`). Nothing is persisted by any of them except one audit row.

**Access.** `CAPACITY_PLANNING` read: Portfolio Manager, Hub Planner, Admin, Super Admin. Executive
Viewer, Engineer, Auditor: 403. No token: 401.

**Scope.** The simulation always runs on the whole plan (lab capacity is shared by region). What
comes back is narrowed to the caller's hubs and the lab regions of those hubs. `scope` on every
response says what it covers: `{all_hubs, hubs[], lab_regions[]}`. Lab-region rows are region-wide
(they include other hubs' load), as on the Capacity surface; no other hub's design row, project,
count or workings line is returned, and every total is a sum of the visible rows. A scenario that
names a hub or lab region outside the scope is `403 {code: SCENARIO_OUT_OF_SCOPE}`; a designer,
chamber or project id outside the scope is `422 INVALID_SCENARIO` ("unknown ... id"), the same as
an unknown id.

**Errors.** `422` (Pydantic shape errors, or `{detail, code: "INVALID_SCENARIO"}` when the engine
raises `ValueError`), `403 SCENARIO_OUT_OF_SCOPE`, `429` with `Retry-After` (per user: 30 burst
refilled 1 per 2 s for estimate/simulate; 6 burst, 1 per 10 s for solve; 5 burst, 1 per 12 s for
ask), `503 {code: WHATIF_TIMEOUT}` past the time cap (20 s; solve 40 s), and for ask only
`503 {"error": "AGENT_UNAVAILABLE"}` (no API key configured; the forms keep working), `502` (model
provider failed), `504 {code: AGENT_TIMEOUT}` (90 s).

## 9.1 Scenario (request)

`ScenarioRequest` (forms). All lists default to empty; max 30 lines per list.

```jsonc
{
  "add_projects":   [{"hub": "R&D-Greece", "category": "C", "count": 1,            // count 1..500
                      "project_type": null /* NM|CO|RC|NO|IMP */, "status": "In Queue",
                      "priority": null /* P1|P2|P3|P4|Q */, "score": null /* 0..100 */,
                      "workflow_id": null /* PDD|OEM */, "certification_testing_required": true}],
  "add_engineers":  [{"hub": "PD-India", "fte": 1.0 /* (0,1] */, "count": 1 /* 1..100 */,
                      "allowed_categories": null}],
  "remove_engineer_counts": [{"hub": "PD-India", "count": 1}],   // least-loaded designers of the hub
  "add_chambers":   [{"lab_region": "India", "count": 1 /* 1..50 */, "platforms": null,
                      "efficiency": null, "maintenance_weeks": null, "breakdown_weeks": null,
                      "calibration_weeks": null, "allowed_stages": null /* ["PDD-F", ...] */}],
  "chamber_downtime": [{"chamber_id": "<uuid string>", "maintenance_weeks": null,
                        "breakdown_weeks": null, "calibration_weeks": null}],   // weeks 0..52
  "remove_engineers": ["<engineer id>"],                 // forms only
  "priority_overrides": [{"project_id": "<uuid string>", "priority": "P1"}]   // forms only
}
```

`hub` in {R&D-Greece, R&D-India, PD-India, PD-Romania, OEM-HCK, OEM-Seltek}; `lab_region` in
{Greece, India, Romania}; `category` in {A+, A, B, C, A-OEM, B-OEM, C-OEM} and must belong to the hub's
workflow (OEM hubs use the `-OEM` categories). `ChatScenario` is the same without
`remove_engineers` and `priority_overrides` (the chat never sees those ids). Chamber ids come from
`capacity_snapshot` (below) or `GET /capacity/hubs`.

## 9.2 Endpoints

| Endpoint | Body | 200 body |
|---|---|---|
| `POST /whatif/estimate` | `{scenario, basis: "year"\|"remaining" = "year", designer_fte: (0,1] = 1.0}` | `EstimateResponse` |
| `POST /whatif/simulate` | `{scenario}` | `SimulateResponse` |
| `POST /whatif/solve` | `{scenario, target: "all_new_within_year"\|"no_existing_slips" = "all_new_within_year", designer_fte = 1.0, max_runs: 2..60 = 60, max_units_per_dimension: 1..25 = 25}` | `SolveResponse` |
| `POST /whatif/ask` | `{question: 1..1000 chars, prior_scenario?: ChatScenario}` | `AskResponse` |

Every 200 body has a `kind` discriminator: `"estimate"`, `"simulation"`, `"solution"`,
`"capacity_snapshot"` (the last only inside `AskResponse.results`).

**EstimateResponse** = the engine's `AnalyticRequirements` (section 3) + `scope`, with `design[]`
limited to in-scope hubs and `lab[]` to in-scope lab regions, totals recomputed from those rows,
`workings: string[]` limited to general lines and in-scope hubs/regions.

**SimulateResponse** = the engine's `SimulationResult` (section 4) + `scope` and `kind`.
`projects[]` (in-scope only, with `name`; new ones are "What-if project N"), `outcome_counts_before`
/ `outcome_counts_after` (all six outcome keys, always present), `utilization_before/after[]`
(in-scope hub rows and in-scope lab-region rows), `diff` (counts recomputed over the visible
projects; `newly_slipping/recovered/moved` filtered to visible hubs; `within_year_*` use the
`within_year` outcome class, I9), `new_project_ids`, `added_engineer_ids`, `added_chamber_ids`,
`removed_engineer_ids`, `reassigned_project_ids`, `greedy_runs`, and `workings` (written by the
server from the visible figures).

**SolveResponse** = the engine's `MinimumAdditionsResult` (section 5) + `scope`, `kind`, plus:

- `semantics`: a fixed sentence to show next to `met` (OQ #47). **`met`** = every project of the
  target finishes inside the planning year. **`met_attainable`** = every project that capacity can
  still help does. They differ exactly when `unattainable_project_ids` is non-empty.
- `unattainable_project_ids` and `unattainable_projects[]` (`project_id, name, hub, category,
  unconstrained_end_week`): added projects whose lead-time critical path alone ends after W52
  ("cannot finish this year whatever is added"). They are excluded from the search. Show them
  separately, not as a failure of the recommendation.
- `additions: {designers: [{hub, count}], chambers: [{lab_region, count}], total}`, `capped`,
  `exact`, `runs_used`, `run_cap`, `unmet_project_ids`, `searched_designer_hubs`,
  `searched_chamber_regions`, `achieved` (a full `SimulateResponse` of the scenario with the
  additions applied, or null), `workings`.
- For a restricted caller with `target = "no_existing_slips"`, `met`, `met_attainable` and
  `unmet_project_ids` describe the caller's own hubs' projects only.

## 9.3 Chat: `POST /whatif/ask`

Stateless (ADR 0014). The model can only call four tools; it cannot compute, change the scope or
role, or see names, costs or ids of existing projects and designers. Response:

```jsonc
{
  "answer": "string",            // prose; every number in it is verified against the engine outputs
  "refused": false,              // true: out of scope, answer is the fixed refusal text
  "grounded": true,              // false: an unverified number survived a retry, answer is a fixed notice
  "ungrounded_numbers": [],
  "scenario": { /* ChatScenario */ } | null,   // the last scenario the assistant built: load it into the form
  "results": [                   // every tool call, in order
    {"tool": "estimate_requirements" | "simulate_scenario" | "find_minimum_additions" | "get_capacity_snapshot",
     "scenario": {...} | null, "error": "string" | null,
     "result": EstimateResponse | SimulateResponse | SolveResponse | CapacitySnapshotResponse | null}
  ],
  "workings": ["..."],           // the engine's lines for the last scenario tool
  "rounds_used": 1,              // tool rounds (cap 4, then one tool-less final turn)
  "truncated": false             // the round cap ended the conversation
}
```

`CapacitySnapshotResponse` = `{kind, scope, current_week, year_end_week, near_full_threshold_pct,
full_threshold_pct, has_active_schedule_run, hubs: [{hub, lab_region, engineer_fte_total,
design_load_weeks, design_capacity_year, design_capacity_remaining, design_booked_pct_year,
design_booked_pct_remaining, design_booking_status_year, lab_load_weeks, lab_capacity_year,
lab_capacity_remaining, lab_booked_pct_year, lab_booked_pct_remaining, lab_booking_status_year,
chambers: [{chamber_id, code, platforms, efficiency}]}]}`. It is the Capacity surface's own scoped
`hub-load` figures (active run load), so it can differ slightly from `estimate`'s lead-time load.

UI guidance: show `answer`, then the figures from `results[].result` (the user trusts those, not the
prose), a "Use this scenario" button that fills the form from `scenario`, and the `workings`.
`error` on a result is shown as a small note ("could not run: ..."). A 503 `AGENT_UNAVAILABLE`
hides the chat input; the forms are unaffected.

## 9.4 Audit

`whatif.estimate|simulate|solve`: one row per user, kind and scenario per minute; `whatif.ask`: one
per message. `after_state` holds the scenario shape (hubs, categories, counts, chamber and project
ids, a count of removed designers), never names, never the question text (only its length and a
digest), never a financial field.

## 9.5 LLM client (swappable)

`services/llm_client.py`: `LlmClient` protocol and `OpenAICompatibleClient`. Env: `RPD_GROQ_API_KEY`
(unset = chat 503), `RPD_GROQ_MODEL`, and new `RPD_GROQ_BASE_URL` (default
`https://api.groq.com/openai/v1`; point at a self-hosted OpenAI-compatible server later, no code
change). Tests inject a fake through the `get_llm_client` dependency.


---

# 10. P18-R01 amendments (algorithm-engineer, 2026-10-21) — consumer: backend-builder (P18-R02)

All names are exported from `scheduling` and defined in `scheduling.whatif`. Pure, DB-free, no new
dependency. Nothing in `greedy.py` changed.

## 10.1 D2: "before" load is the run's (single source)

Choice: the engine computes the "before" load itself from one greedy run of the unmodified baseline
(the same `run_greedy_sgs` and the same I6/I7 sums that `simulate` uses for `utilization_before`),
rather than taking DB sums as an input. This keeps the engine pure and guarantees estimate "before" ==
simulate "before" by construction; for the seeded plan the stored active run equals a fresh greedy run
(workflow-auditor: 253/253), so it also equals the Capacity surface. `WhatIfBaseline` is unchanged: no
new field is needed. `analytic_requirements` therefore costs one greedy run, not zero.

- `HubDesignRequirement.baseline_load_weeks` / `LabRegionRequirement.baseline_load_weeks` = run load
  (year or remaining basis share the same load; only capacity differs). `new_load_weeks` = that plus the
  lead-time demand of the added projects. `booked_pct_before` equals `utilization_before.booked_pct_year`
  (basis `year`) or `booked_pct_remaining` (basis `remaining`) to 2 dp.
- `min_extra_designers` / `min_extra_chambers` (and so the solver's analytic seed) use `new_load_weeks`.
- The backend must not mix in a lead-time figure anywhere on the same tab. OQ #45 should say: the "before"
  load is what the active schedule books (finished history is not counted against remaining capacity),
  the added work is its full lead-time demand.

## 10.2 D2b: headline totals over the touched hubs and lab regions

`AnalyticRequirements` gains `touched_hubs: tuple[str, ...]` and `touched_lab_regions: tuple[str, ...]`
(sorted; both empty for the zero scenario). `touched_scope(baseline, scenario)` returns the same pair.
Touched hubs: hubs of `add_projects`, `add_engineers`, `remove_engineer_counts`, `remove_engineers`
(hub of the id) and `priority_overrides` (hub of the project). Touched lab regions: regions of
`add_chambers`, of chambers in `chamber_downtime`, and the lab region of every touched hub.

`extra_design_weeks_total`, `extra_lab_weeks_total`, `min_extra_designers_total`,
`min_extra_chambers_total` now sum ONLY the rows whose hub is in `touched_hubs` / whose region is in
`touched_lab_regions`. `design[]` and `lab[]` still hold every hub / region with load. Zero scenario:
all four totals are 0. For a hub-scoped caller the API recomputes the totals from the visible rows that
are also in the touched sets (never from the engine totals). The UI should say "needed for the hubs and
regions this scenario touches" and may show the touched sets; a portfolio-wide deficit is the per-row
`min_extra_*` of untouched rows.

## 10.3 D3: `exact` means verified

`MinimumAdditionsResult.exact` is true only when `met`, not `capped`, and every combination of
designers/chambers (within the per-dimension limits) with a smaller total than the answer was actually
simulated and failed the target. It is no longer a claim derived from the monotone assumption. Otherwise
`exact=false` and a `workings` line reads: "Minimum under the assumption that more capacity never hurts
... (N smaller combination(s) not simulated)". Search additions: for two pools the engine now also probes
each axis from zero (greedy is not monotone in chambers), then polishes each region by trying the totals
just below its answer (nearest first, fair share of the remaining run budget). Expect `exact=false` for
answers larger than a handful of units within the 60-run cap; the UI should word it as "smallest found;
assumes more capacity never hurts" and only claim "proven minimum" when `exact` is true. No field was
added or renamed. The `semantics` text the API adds beside `met` should carry that wording.

## 10.4 S18-M1: caps and cooperative deadline

Constants (importable from `scheduling`); the sums are over all lines of one scenario:

| Constant | Value | Applies to |
|---|---|---|
| `MAX_ADDED_PROJECTS_TOTAL` | 200 | sum of `add_projects[].count` |
| `MAX_ADDED_DESIGNERS_TOTAL` | 50 | sum of `add_engineers[].count` |
| `MAX_REMOVED_DESIGNERS_TOTAL` | 50 | sum of `remove_engineer_counts[].count` + distinct `remove_engineers` |
| `MAX_ADDED_CHAMBERS_TOTAL` | 20 | sum of `add_chambers[].count` |
| `MAX_COUNT` (existing) | 500 | per-line `count` (now dominated by the totals above; mirror the totals) |

Exceeding any raises `ValueError("at most N ... can be added in one scenario (got M)")` from
`simulate`, `analytic_requirements`, `solve_minimum_additions`, `apply_scenario` and
`validate_scenario_limits(scenario)` (map to 422 `INVALID_SCENARIO`). backend-builder mirrors the
totals in the strict request models (a model validator on `ScenarioRequest` / `ChatScenario`, and lower
per-line `count` maxima: projects 200, designers 50, chambers 20) and frontend-builder in the zod schema
and form hints. The solver clamps its own search so that scenario + recommended additions stay within
the designer (50) and chamber (20) caps; if a combination across hubs still exceeds them a workings line
says so.

Deadline: `simulate`, `analytic_requirements` and `solve_minimum_additions` take keyword-only
`deadline_s: float | None = None` (seconds from the call; `> 0`) and `clock: Callable[[], float] | None =
None` (default `time.monotonic`; inject a fake in tests). The check is cooperative: before and after every
greedy run and inside the loop that builds the added projects. On expiry they raise
`WhatIfBudgetExceeded` (a plain `Exception` subclass, exported from `scheduling`). With `deadline_s=None`
the engine never reads a clock and output is byte-identical to before. Wiring: pass
`deadline_s` a little under the HTTP cap (for example 18 s estimate/simulate, 38 s solve against the 20 s
/ 40 s caps) so the worker thread stops itself; catch `WhatIfBudgetExceeded` and return the existing 503
`WHATIF_TIMEOUT`. One greedy run is bounded (at most 250 + 200 projects, tens of milliseconds), so the
overshoot is one run. A per-user in-flight limit remains a backend decision (S18-M1 optional part).

Estimated worst-case engine cost now: solve = 60 runs x one greedy run on <= (plan + 200) projects.


---

# 11. P18-R02 amendments (backend-builder, 2026-10-21) — consumer: frontend-builder

HTTP-layer remediation after the P18 gate (workflow D1/D2/D2b/D3, security S18-M1/L1-L4, chat advisory).
Everything not listed here is unchanged from section 9.

## 11.1 Shape changes (additive unless stated)

| Where | Change |
|---|---|
| `EstimateResponse` | New `touched_hubs: string[]`, `touched_lab_regions: string[]` (D2b). Sorted; for a restricted caller only the ones inside their scope. Empty for the zero scenario. |
| `EstimateResponse` totals | `extra_design_weeks_total`, `extra_lab_weeks_total`, `min_extra_designers_total`, `min_extra_chambers_total` now sum ONLY the visible rows whose hub is in `touched_hubs` / whose region is in `touched_lab_regions` (recomputed on the server from the visible rows, never the engine's totals). Zero scenario: all four are 0. `design[]` / `lab[]` still list every visible hub / region; a deficit of an untouched row is that row's own `min_extra_*`. Suggested label: "Needed for the hubs and regions this scenario touches". |
| `EstimateResponse` "before" (D2) | `baseline_load_weeks`, `booked_pct_before`, `capacity_before` per row equal the Capacity surface (`GET /capacity/hub-load`: `design_booked_pct_year|remaining`, `lab_booked_pct_year|remaining`, `*_load_weeks`) to 2 dp, and equal `SimulateResponse.utilization_before`. Behaviour change: numbers differ from the previous release (finished work is no longer counted against remaining capacity). The UI must not show a lead-time-based "before" anywhere. |
| `SimulateResponse.diff` (D1) | `within_year_before|after|delta`, `existing_within_year_*`, `new_projects_within_year` and the "Within-year projects: a -> b" workings line now count `within_year AND NOT blocked` of the project's flag, the Dashboard's bucket (`/dashboard/completing-within-year.within_year_count`, ADR 0030: Commercialized projects are counted). Zero scenario: before == after == the Dashboard figure for every hub scope. `outcome_counts_*` are still by outcome CLASS (Commercialized and other excluded projects sit in `excluded`), so `outcome_counts_after.within_year` can be lower than `within_year_after`; the UI headline must use `diff.within_year_*`. The text in 9.2 that says "`within_year` outcome class (I9)" is superseded by this. |
| `SolveResponse.semantics` (D3) | The fixed sentence now also explains `exact`: true only when every smaller combination of designers and chambers was simulated and failed; otherwise "smallest found, assuming more capacity never hurts" (a smaller combination may exist that was not simulated within the run budget). Expect `exact=false` for answers above a handful of units inside the 60-run cap. UI wording: "proven minimum" only when `exact`, else "smallest found". When not exact, `workings` carries the line "Minimum under the assumption that more capacity never hurts ... (N smaller combination(s) not simulated)". |

## 11.2 Request limits (S18-M1)

Per-line `count` maxima are now: `add_projects` 200, `add_engineers` 50, `remove_engineer_counts` 50, `add_chambers` 20
(was 500 / 100 / 100 / 50), and the TOTALS over all lines of one scenario are capped (same constants as the engine):

| Total over all lines | Max |
|---|---|
| added projects | 200 |
| added designers | 50 |
| removed designers (`remove_engineer_counts` counts + distinct `remove_engineers` ids) | 50 |
| added chambers | 20 |

A total over a cap is `422` with the standard validation envelope `{"detail":[{"loc":["body","scenario"],"type":"scenario_limit","msg":"at most 200 projects can be added in one scenario (got 201)"}],"code":"INVALID_SCENARIO"}`
(a `code` key is added; `detail` stays a list). A single line over its maximum is the ordinary `less_than_equal` 422 (no `code`).
The chat tool arguments use the same models, so the model gets a tool error instead. frontend-builder: mirror the totals in zod and the
form hints; the form should show the remaining allowance.

## 11.3 Time, concurrency (S18-M1)

- The engine gets `deadline_s` = 18 s (estimate, simulate) and 38 s (solve), under the HTTP caps of 20 s / 40 s, so the worker thread
  stops itself. `WhatIfBudgetExceeded` and the HTTP cap both answer `503 {"detail": ..., "code": "WHATIF_TIMEOUT"}` (unchanged shape).
- New: **one running heavy job per user** across `estimate`, `simulate`, `solve` and the chat's tool calls. A second request while the
  first one's engine thread is still running answers `429` with `Retry-After: 2` and
  `{"detail": "A what-if calculation of yours is still running. Please wait for it to finish before starting another."}`
  (plain `detail` string, no `code`, the same shape as the rate-limit 429). The slot is released when the thread finishes, not when a
  request gives up, so a 503 followed immediately by a retry can still be 429 for the remaining seconds of the capped job. Normal
  runs take tens of milliseconds, so the UI should disable its Run buttons while a request is pending and show the 429 text if it
  happens. In a chat turn a tool call that hits the limit returns a tool error to the model (shown as the small "could not run" note), it
  does not fail the turn.
- Rate limits (9.x) are unchanged.

## 11.4 Chat (advisory decisions, S18-I1/I2, S18-L2..L4)

- Grounding guard: besides digits, **spelled-out numbers** ("twelve", "twenty-five", "two hundred", "dozen", "thirteenfold") in the
  answer are flagged (`grounded=false` after the single retry, the word appears in `ungrounded_numbers`) unless the user typed that
  word in the question. "one" is not flagged (it is also a pronoun). A number with thousands separators ("1,078") is one number. The
  system prompt forbids number words. The guard stops most invented figures; it checks membership, not provenance (ADR 0031).
- A provider reply that is not JSON or not a chat completion is `502` (same as a transport failure).
- The database transaction is released before every model call.
- **Egress hint (frontend-builder, S18-I1).** `POST /whatif/ask` sends the user's typed question and aggregate scenario figures to the
  configured model endpoint (Groq by default). The chat input must carry a visible hint such as "Do not type names or prices. Your
  question and the scenario figures are sent to the AI provider." (fixed text; do not make it dismissible permanently).

## 11.5 Operator configuration (S18-L1)

`RPD_GROQ_BASE_URL` must be `https://`. `http://` is accepted only when the host is loopback or private (`localhost`, `127.0.0.0/8`,
`::1`, RFC 1918 and link-local addresses, or a single-label container name such as `vllm`) AND `RPD_GROQ_ALLOW_INSECURE_BASE_URL=true`
is set. Anything else fails settings validation at first use. Provider error bodies are never logged: only status, error type and
error code, each scrubbed of the configured key.
