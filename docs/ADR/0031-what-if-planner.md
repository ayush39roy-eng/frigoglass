# ADR 0031: What-if planner — a pure scenario engine over the real greedy scheduler

## Status

Accepted (2026-10-20). Part of P18. Adds `backend/scheduling/whatif.py`. No scheduling rule in
`docs/DOMAIN_RULES.md` changes; nothing is persisted by a what-if; the scheduler itself is
untouched.

## Context

Planners want to ask "what if we add these projects, or more designers, or another chamber?" and
get a believable answer: what it does to booked %, which projects slip, and how many designers and
chambers are the least that keeps the plan healthy. They also want to ask in plain text (a chat
panel). The answer must agree with the Capacity and Dashboard surfaces (I6, I7, I9, I17, I19) and
must not be a second scheduler.

## Decision

1. **One pure module, no I/O, no LLM, no CP-SAT.** `scheduling/whatif.py` takes frozen dataclasses
   and returns frozen dataclasses. Deterministic (I8): sorted iteration, no clock, no randomness.
   The baseline is only read.
2. **Two paths, one input.**
   - *Analytic* (`analytic_requirements`): instant, formulas only, from the DOMAIN_RULES lead-time
     and capacity-supply sections. Extra design-weeks and lab-weeks of the added projects, new load
     versus capacity and booked % per hub and per lab region (ADR 0016 thresholds, served 2 dp
     rule), and the integer ceiling of extra designers and chambers that keeps booked % strictly
     below `BOOKING_FULL_PCT`, with a `workings` list showing the arithmetic.
   - *Simulated* (`simulate`): runs `run_greedy_sgs` (the scheduler the priority-move preview uses;
     it is imported, not copied) on the baseline and on a copy with the scenario applied. Returns
     per-project outcome class and finish week, utilization per hub and lab region, and a diff
     (newly slipping, recovered, otherwise moved, within-year count delta).
3. **Minimum additions** (`solve_minimum_additions`): repeated greedy runs. Lab regions are
   independent subsystems (a project uses only its hub's designers and its region's chambers), so
   each region is solved alone with the others held fixed and the minimum total is the sum. Per
   region: one pool by doubling and bisection, two pools by bisection to a feasible corner and a
   staircase walk, three or more by exhaustive levels then a climb from the analytic estimate and a
   prune. The search assumes more capacity never hurts and audits every pair it evaluated for that.
   Hard cap 60 greedy runs (baseline run included), reported as `capped`; `exact` says whether the
   minimum total is proven.
4. **Unreachable targets are reported, not chased.** A project whose lead-time critical path alone
   ends after W52 (`unconstrained_end_week > 52`) cannot finish in the year whatever is added. The
   engine lists these as `unattainable_project_ids` and leaves them out of the search.
5. **Applying a scenario** (assumptions, OQ #43 to #48): hypothetical projects default to
   `In Queue` and priority P3 (or the band of a given score); each gets the eligible designer of its
   hub with the fewest led design-weeks per FTE; the projects of a removed designer are reassigned
   the same way; existing projects are not rebalanced onto added designers; a chamber added
   without values takes the region norm; downtime changes move supply, not the schedule.
6. **Privacy.** No financial field and no engineer name is read or returned. Hypothetical designers
   are labelled "What-if designer N". The scenario never touches the database.
7. **Caller responsibilities.** The backend (P18-T02) builds the baseline from the DB under the
   caller's hub scope, runs the engine in a worker thread with a time cap (the preview pattern), and
   exposes it as an API and as the tools of the chat. The LLM only turns text into a `Scenario` and
   explains returned figures; it never calculates, and it receives only the engine's output.

## Consequences

- The numbers on the What-if surface are the numbers the real scheduler produces, so a recommended
  addition can be applied for real and will behave the same.
- Hub scope matters: lab capacity is region-wide, so a Hub Planner's baseline must still include the
  whole region's chambers and projects (as the Capacity surface does) while recommendations are
  reported only for hubs in scope.
- The year-end rule (52 weeks, `CURRENT_WEEK` 42) makes most new projects unreachable; the UI should
  show `unattainable` clearly (OQ #47).

## Alternatives rejected

- *CP-SAT for the minimum.* Not allowed in a request process, and it would not match what the app
  actually runs (greedy).
- *LLM does the arithmetic.* Not reproducible and not auditable.
- *Fork the scheduler for speed.* Greedy runs in tens of milliseconds at 250 projects; a fork would
  drift from the rules.

## Follow-ups (added 2026-10-21, P18-T02)

- **Egress (open, ties to OQ #23).** With the chat enabled, scenario figures leave the network for
  the configured model endpoint (Groq by default): hub-level load, capacity, booked % and counts
  of added or slipping projects, plus the user's typed question. No project name, customer,
  financial field, designer name or id of an existing project or designer is sent (allowlist in
  `services/whatif_chat.py`, asserted on the exact payload in tests). Whether even those aggregate
  figures may leave the corporate network is the client's call. The client is behind a small
  interface and an OpenAI-compatible base URL setting (`RPD_GROQ_BASE_URL`), so a self-hosted model
  inside the network is a configuration change. Until the client answers, leave `RPD_GROQ_API_KEY`
  unset on any site that must not egress: the What-if forms work without it.
- **Hub scope of results.** The engine runs on the whole plan; the API narrows what is returned
  (`services/whatif.py`). For a restricted caller, `no_existing_slips` reports only their own
  hubs' projects, although the search still treats every hub's projects as the target.
- **Chat guard.** The model's final answer is checked on the server: every number must appear in
  an engine output, the question or the scenario; otherwise one corrective retry, then a fixed
  notice with the figures still returned for the UI.

## Follow-ups (added 2026-10-21, P18-R01 gate remediation)

- **Single source for "before".** The analytic path now takes the "before" load from one greedy run of
  the unmodified baseline (the active run's I6/I7 sums) and adds lead-time demand only for the new
  work, so estimate, simulate and Capacity agree to 2 dp. The earlier text "analytic load equals the
  Capacity load" was wrong on real data (finished work, left-out projects).
- **Headline totals are scoped to what the scenario touches** (`touched_hubs`, `touched_lab_regions`);
  per-hub and per-region rows stay complete.
- **`exact` means verified.** The search can still assume that more capacity never hurts (greedy is not
  monotone), so `exact` is true only when every smaller combination was simulated. Otherwise the result
  is "smallest found, assuming more capacity never hurts".
- **Cost bounds (S18-M1).** Per-scenario caps (200 projects, 50 designers, 20 chambers, 50 removed) and a
  cooperative `deadline_s` raising `WhatIfBudgetExceeded`; the API layer mirrors the caps and maps the
  exception to the existing timeout response.

## Follow-ups (added 2026-10-21, P18-R02 API gate remediation)

- **One definition of "within the year".** The What-if counts `within_year AND NOT blocked` of the project's flag, the
  Dashboard's bucket, so Commercialized projects (outcome class `excluded`) are included; a zero scenario equals the Dashboard figure
  for every hub scope. Outcome-class counts stay by class and are shown separately.
- **Cost and abuse bounds (S18-M1).** Strict request models cap the totals per scenario (200 projects, 50 designers added, 50
  removed, 20 chambers); the engine gets a cooperative deadline under the HTTP cap; each user may have one heavy job running (the 2-thread
  pool is shared by everyone), which also covers the chat's tool calls.
- **Provider hardening (S18-L1..L3).** The base URL must be https unless the host is loopback or private and an explicit opt-in is set;
  provider error messages are never logged and the key is scrubbed from what is; a non-JSON or wrong-shape 200 is a 502.
  The DB read transaction is released before each model call so a slow model cannot hold a pooled connection.
- **What the grounding guard can and cannot do (owner decision, workflow-auditor advisory).** The prompt forbids number words and
  the guard flags spelled-out numbers ("twelve") and treats "1,078" as one number. It stops most invented figures, but it checks
  that a number occurs in the engine output, not where it came from: a small number the model computed itself can coincide with
  one that is present. It cannot prove the model never computes. The engine results are always returned beside the answer so the user
  can read the figures directly, and the answer is plain text.
- **Egress (S18-I1).** `POST /whatif/ask` sends the user's typed question and aggregate scenario figures (hub-level load, capacity,
  booked %, counts, chamber codes) to the configured model endpoint. A user can type a customer or person name into the question; the
  server cannot prevent that. The UI shows a fixed hint "do not type names or prices" next to the chat input, the question text is never
  stored in our audit log (length and digest only), and a self-hosted OpenAI-compatible endpoint inside the network removes the egress
  (OQ #23). Leave `RPD_GROQ_API_KEY` unset where egress is not allowed.
