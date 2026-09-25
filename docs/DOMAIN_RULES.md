# Domain Rules — RPD Web Application

This is the executable contract every agent validates against. Values here are extracted from
`reference/RPD_Web_Application_mock-up-Frigoglass.pptx` (slides 3–4: scheduling logic flowchart
and prioritization matrix) and cross-checked against `reference/rpd-platform-prototype.html`.

Where our implementation and the prototype disagree, **this document and the deck win.** The
prototype is a differential test oracle during P2 only (see `docs/IMPLEMENTATION_PLAN.md` P2-T02/T03)
and is retired when P2 closes. It is not the specification and it is not the architecture.

---

## Workflow template — 14 steps

| ID | Name | Kind | Base weeks |
|---|---|---|---|
| PDD-A | Marketing Brief | design | 2 |
| PDD-B | Concept Study | design | 2 |
| PDD-C | Feasibility & Costing | design | 2 |
| PDD-D | Final Tech Brief & Kick-off | design | 1 |
| PDD-E | Design Detailing | design | 4 |
| PDD-F | Proof of Concept | lab | 3 |
| PDD-G | Design Refinement | design | 2 |
| PDD-H | Certification | lab | 4 |
| PDD-I | Tooling & Sourcing | design | 3 |
| PDD-J | Pre-Pilot Validation | lab | 2 |
| PDD-K | TF-2 | design | 2 |
| PDD-L | Pilot | lab | 3 |
| PDD-M | Buy-off | design | 2 |
| PDD-N | Commercialization | design | 1 |

All 14 steps run strictly sequentially per project (see Invariant I3). Whether the true dependency
structure is a DAG with parallel branches is open — see `docs/OPEN_QUESTIONS.md` #1. Until answered,
implement as strictly sequential.

## Category multipliers

```
A+ = 1.0
A  = 0.8
B  = 0.5
C  = 0.25

duration_weeks = max(1, round(base_weeks * multiplier))
```

## Hubs and lab-region mapping

Hubs: `R&D-Greece`, `R&D-India`, `PD-India`, `PD-Romania`, `OEM-HCK`, `OEM-Seltek`

Lab region mapping:

| Hub | Lab region |
|---|---|
| R&D-Greece | Greece |
| R&D-India | India |
| PD-India | India |
| PD-Romania | Romania |
| OEM-HCK | India |
| OEM-Seltek | India |

## Horizon constants

```
CURRENT_WEEK      = 31
WITHIN_YEAR_WEEK   = 52
HORIZON_WEEKS      = 78
```

## Scheduling order (serial schedule-generation scheme)

Sort all projects by, in order:

1. `frozen` descending (frozen projects scheduled first, dates locked)
2. Priority: `P1 → P2 → P3 → P4 → Q`
3. Status: `In Buyoff (0) → Under Industrialization (1) → In Development (2) → In Queue (3)`
4. Category: `A+ → A → B → C`

## Booking rules

- **Design step**: the project's assigned leader must be free for every week in `[w, w + duration)`.
  Non-frozen projects advance `w` until a free window is found.
- **Lab step**: a chamber in the project's lab region whose `allowed_stages` includes this step, with
  concurrent project count `< chamber.max` for every week in the window. Consumption is `0.5` per
  project-week.
- **Frozen projects**: dates are locked at `actual_start`; capacity is consumed regardless of
  conflict. A double-booked engineer raises `ENG_CONFLICT`; an over-capacity chamber raises `OVERLAP`.
- **LEFT_OUT**: no feasible window before `HORIZON_WEEKS`.
- **CAT_NOT_ALLOWED**: assigned leader's `allowed_categories` excludes the project's category (or
  `OEM` for OEM-hub projects). Warning, not a scheduling block.
- **Completing within year**: `!left_out AND (last_step_end + delay <= WITHIN_YEAR_WEEK)`. Otherwise
  `SPILLOVER`.
- Status `Commercialized` and `On Hold` are excluded from scheduling entirely.

## Prioritization scoring — 13 dimensions

| Pillar | Dimension | Weight |
|---|---|---|
| Strategic Alignment | Strategic Project | 25 |
| Strategic Alignment | New Customer | 25 |
| Strategic Alignment | New Options | 25 |
| Regulatory & Quality | Regulatory Compliance | 25 |
| Regulatory & Quality | Quality Improvements | 25 |
| Financial Return | RM Savings | 25 |
| Financial Return | Total RM Savings | 25 |
| Financial Return | Gross Margins | 25 |
| Financial Return | Profitability | 25 |
| Market & Volume | Annual Volume | 15 |
| Market & Volume | 3-Year Volume | 15 |
| Market & Volume | New Models | 15 |
| Investment & Feasibility | CAPEX Investment (inverted) | 10 |

```
TOTAL_WEIGHT = 280
weighted_score = Σ(dimension_score × weight)   where each score ∈ [1..5]
normalised_pct = round(weighted_score / (280 × 5) × 100)

Bands:
  >= 70 → P1
  >= 55 → P2
  >= 40 → P3
  else  → P4
```

### Hard gates (override band, force P1)

- Regulatory deadline within 6 months
- Customer certification at risk (Coke/Pepsi)
- Active safety non-compliance

## Currency

Base EUR. `EUR = 1.0`, `USD = 1.08`, `INR = 97`. Rates must be configurable at runtime, not
hardcoded constants — store them in a config table, not in code.

---

## KNOWN DEFECTS IN THE PROTOTYPE — do not silently replicate or silently fix

These three are **open decisions**. Each requires an ADR before implementation. Recording them here
so no agent "fixes" them without approval and no agent copies them blindly.

1. **FTE is not applied in scheduling.** The Capacity Planning surface reports capacity scaled by
   FTE (0.5 FTE → 9.4 weeks, 1.0 FTE → 18.9 weeks), but the scheduler treats every engineer as fully
   available for whole weeks. Capacity reporting and the Gantt therefore disagree.
   → `docs/OPEN_QUESTIONS.md` #2.
2. **Chamber `efficiency` and `weeks_per_chamber` are display-only.** Only `max` concurrent gates
   booking. → `docs/OPEN_QUESTIONS.md` #3.
3. **Delay is not propagated.** It is applied once at the end (`end + delay <= 52`) rather than
   pushed into downstream steps. → `docs/OPEN_QUESTIONS.md` #5.

## Invariants (the workflow-auditor asserts all of these on every solver run)

- **I1**: No engineer is assigned two design steps in the same week — unless at least one project is
  `frozen`, in which case `ENG_CONFLICT` is raised.
- **I2**: No chamber exceeds `max` concurrent projects in any week — unless frozen, then `OVERLAP`.
- **I3**: Steps within a project are strictly sequential and non-overlapping;
  `step[n].start >= step[n-1].end + 1`.
- **I4**: A lab step is only ever booked to a chamber in the project's lab region whose
  `allowed_stages` contains that step.
- **I5**: Every scheduled project has either a complete 14-step schedule or `LEFT_OUT = true`.
- **I6**: Total design load per hub = Σ design step durations for that hub's projects. Must reconcile
  with the Capacity surface to the week.
- **I7**: Total lab load per hub = Σ (lab step durations × 0.5). Must reconcile with the Capacity
  surface.
- **I8**: Re-running the greedy scheduler on identical input produces byte-identical output
  (determinism).
- **I9**: `within_year` count on the Dashboard equals the count of projects satisfying the
  within-year rule in the current schedule run. No independent calculation anywhere.
- **I10**: Applying priorities never mutates a `frozen` project's dates.

These invariants are the permanent correctness contract (see P2-T04). The prototype oracle is
temporary; these are not.

---

## Per-stage progress capture (Project Workspace, Surface #7)

Added 2026-09-08 for the Project Workspace surface (`docs/PROJECT_AND_STACK.md` §2). The prototype
has no equivalent — it is **not** an oracle for any rule in this section. See `docs/ADR/0006`.

### Per-stage progress fields

Each of a project's 14 `ProjectWorkflowStep` rows carries progress state a Hub Planner edits on the
Project Workspace:

| Field | Domain | Consistency rule |
|---|---|---|
| `status` | `Not Started` \| `In Progress` \| `Blocked` \| `Done` | see below |
| `percent_complete` | integer `0..100` | `Not Started ⇒ 0`; `Done ⇒ 100` |
| `actual_start_week` | int or null | required (non-null) when `status ∈ {In Progress, Blocked, Done}` |
| `actual_end_week` | int or null | required when `status == Done`; must be null otherwise; `>= actual_start_week` |
| `remaining_weeks_override` | int `>= 0` or null | when null, remaining is derived (below) |
| `blocked_reason` | text or null | required (non-empty) when `status == Blocked`; null otherwise |

A project is **progress-tracked** once any one of its 14 stages has `status != Not Started`.
`percent_complete` and `remaining_weeks_override` are advisory inputs to the scheduler, not stored
schedule output — they are never overwritten by a schedule run.

### Derived remaining duration

```
if remaining_weeks_override is not null:
    remaining = remaining_weeks_override
else:
    remaining = ceil(duration_weeks * (1 - percent_complete / 100))
remaining = max(0, remaining)
```

`duration_weeks` is the step's category-scaled planned duration (`duration_weeks = max(1,
round(base_weeks * multiplier))`, unchanged). A `remaining == 0` in-progress step occupies no future
weeks and consumes no future capacity, but is **not** treated as fixed history unless `status ==
Done`.

### How progress feeds a schedule run

For a progress-tracked project, the serial schedule-generation scheme replaces "schedule every step
from scratch" with the following per step, walking steps in sequence order:

```
if status == Done:
    schedule = [actual_start_week .. actual_end_week]      # fixed history, never moved
    consume capacity for the portion of that interval at or after CURRENT_WEEK
    do not search for a slot

if status == In Progress:
    start   = actual_start_week                            # fixed
    tail    = [max(CURRENT_WEEK, prev_step_end + 1) .. + remaining)   # the not-yet-done part
    the step's booked interval for capacity/conflict purposes is `tail`
    if remaining == 0: the step is complete for scheduling; end = max(actual_start_week, prev_step_end)

if status == Blocked:
    as In Progress, but `tail` may not begin until the block clears — the step (and therefore every
    downstream step) is held at the earliest-feasible frontier and the project is flagged; a Blocked
    step whose `remaining > 0` and whose predecessor is complete still cannot be placed, so the
    project takes a BLOCKED hold and surfaces on Notifications (`docs/PROJECT_AND_STACK.md` §2).

if status == Not Started:
    schedule normally — earliest feasible window at or after max(CURRENT_WEEK, prev_step_end + 1),
    per the existing Booking rules.
```

- **Capacity is only tracked for weeks `>= CURRENT_WEEK`.** Work already executed (weeks before
  `CURRENT_WEEK`) is recorded for display but does not consume schedulable capacity.
- **Determinism (I8) is preserved** — progress fields are part of the sorted, hashed solver input.
- If an `In Progress`/`Blocked`/`Done` step is missing a required `actual_*_week` the run **rejects
  the project as a data error** (it is not silently scheduled from scratch) — the workspace's
  consistency rules above are enforced at write time, and the solver re-checks.

### Relationship to the `frozen` flag

`frozen` (project-level, Gantt surface) and per-stage progress are two anchoring mechanisms:

1. If `project.frozen` is true → the existing frozen rules apply unchanged (all 14 steps locked
   from `actual_start`, capacity consumed regardless of conflict, `ENG_CONFLICT`/`OVERLAP` raised).
   `frozen` still wins, for backward compatibility (ADR 0006).
2. Else if the project is progress-tracked → the per-stage rules above apply.
3. Else → schedule from scratch, unchanged.

`frozen` is **retained but deprecated**: it is expected to fall out of use once real progress data
is loaded, and is not offered alongside stage-level progress in the Project Workspace UI. It is not
removed in v1.

### Rescheduling is explicit

A progress edit **never triggers a solve.** It sets a per-project `schedule_stale` flag and shows a
banner; the user runs "Recalculate schedule", which dispatches a solver run (Celery, per
`docs/PROJECT_AND_STACK.md` §4) and writes a **new immutable `ScheduleRun` version**. Prior
`ScheduleRun` rows are never mutated — "what did the plan look like before I updated this?" is always
answerable (I14).

### Project roll-up progress

```
project_progress_pct = round( Σ(step.percent_complete * step.duration_weeks)
                               / Σ(step.duration_weeks) )
```

Duration-weighted, never a 14-way mean (I12).

### Health badge (derived, never entered)

A pure function of the **active `ScheduleRun`'s stored outcome** for the project (I13):

| Badge | Condition |
|---|---|
| ⚫ Left Out | `left_out == true` |
| 🔴 Off Track | projected finish week `> WITHIN_YEAR_WEEK` |
| 🟡 At Risk | projected finish `<= WITHIN_YEAR_WEEK` **and** some stage's `(actual_end_week or projected end) - (planned end)` `> 0` (running over planned duration) |
| 🟢 On Track | projected finish `<= WITHIN_YEAR_WEEK` and no stage overrunning and no overdue stage |

"Projected finish" is `last_step_end + delay` from the active run (consistent with the within-year
rule and ADR 0004 — delay is still terminal).

### Additional invariants (workflow-auditor asserts I11–I14 on every progress-aware run)

- **I11**: A `Done` stage's scheduled `[start, end]` in every subsequent `ScheduleRun` equals its
  recorded `[actual_start_week, actual_end_week]`. Done stages are immutable history; the solver
  never re-places them.
- **I12**: `project_progress_pct` equals the duration-weighted formula above — never an unweighted
  mean of the 14 `percent_complete` values.
- **I13**: The Project Workspace health badge for a project is a pure function of that project's
  stored outcome in the active `ScheduleRun` (finish week, per-stage overrun, `left_out`). No
  independent recomputation anywhere — mirrors I9.
- **I14**: "Recalculate schedule" creates a new `ScheduleRun` row; it never mutates an existing one.
  Every historical schedule version remains byte-stable after later recalculations.
