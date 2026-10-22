# ADR 0041: Per-project effort drives the schedule and the load; full-year load scope; client vocabulary

## Status

**Accepted** (2026-10-23, orchestrator), with the workflow-auditor's R1–R14 below as binding
amendments: where §§1–n of the draft text conflict with R1–R14 or the "Invariant wording" section,
the ruling wins (e.g. the B example is A1 E2 K1; the new invariants are I25/I26).

**Owner acceptance of R1 (2026-10-23):** the owner accepted that one per-project effort figure sets
both the load and the calendar span (`ceil(effort / fte)`, leader exclusive) — so B design at 1.0
FTE goes from 10 weeks to the client's 4. Context: the client wants the within-year delivery rate to
reflect their own effort figures (measured 19.6 % → 43.5 % from this lever alone; 48.8 % with the
ADR 0042 data fixes). The owner also confirmed that current project progress is not available from
the client, so the April status stays; no figure is tuned toward a target — the Dashboard shows
whatever the run produces.

Original status: **Proposed** (draft, 2026-10-22). Written by the data reconciliation
(`docs/DATA_RECONCILIATION_2026.md`). Not implemented. It changes the scheduler's definition of
step durations (override domain), the Capacity surface's load basis and the seed's project
selection, so it needs the **workflow-auditor's** ruling before any task is opened, and the
algorithm-engineer for the `backend/scheduling/` part. Companion: ADR 0042 (Accepted) — OEM hubs
are capacity children of R&D-Greece, `engineers.counts_in_capacity`, Theoni → R&D-Greece; this ADR
builds on it and does not restate it. Supersedes ADR 0035 §10 (carry-over from `Spillover '25`) and
§12 (types); amends ADR 0007 "Lead times" (per-project effort), ADR 0019 (override domain), ADR
0024/0035 (dataset), DOMAIN_RULES "Capacity supply" (load basis) and the hubs table (spelling).

## Context

The client keeps saying "the data doesn't make sense". The reconciliation found five causes, in
order of size (`docs/DATA_RECONCILIATION_2026.md` §5):

1. The client's load is the sum of a **typed per-project figure** (`Process Design Man Week`,
   column 16 of `2024-25-26 Projects`; `Lab Weeks- Process Derived`, column 21). India types 4
   design weeks per B project and 3 per C; Romania 20 and 15; Greece 20–30 per A/A+. The app books
   the lead-time table through ADR 0007's step kinds: **10** per B, **6** per C. PD-India: client
   658 full-year weeks against the app's 1078 demand on the 2026 open rows alone.
2. OEM load without OEM capacity — now ADR 0042.
3. Six provisional leaders at 1.0 FTE in the supply — now ADR 0042 §5.
4. **Scope.** The client's full-year booked % counts every row flagged `Project to be considered
   for Capacity Calculation = Y`, of every status except Cancelled (owner ruling 2026-10-22:
   projects Commercialized during 2026 consumed this year's capacity; On Hold projects are still
   booked). The app counts projects requested in 2026 (ADR 0024) and loads only what the active run
   booked. The two populations share 185 rows of 262 / 253.
5. The formula workbook's pivot is stale (refreshed 2026-06-29) and two of its lab cells sum the
   wrong field; recomputed from the live sheet the client's figures are: Greece (incl. OEM) 243 wk
   vs 124.88 capacity (194.6 %), R&D-India 150 vs 87.87 (170.7 %), PD-India 658 vs 252.62 (260.5 %),
   PD-Romania 375 vs 165.00 (227.3 %).

The app already has the hook for a per-project duration: `project_workflow_steps.
duration_override_weeks` (ADR 0019, 1..104) is honoured everywhere a table duration is used. Its
domain excludes 0, and a B project has six non-zero design-kind steps (A 1, D 1, E 4, J 1, K 2,
M 1) — so a client figure of 4 cannot be expressed without letting a step go to 0.

## Decision

### 1. Dataset: 2026 ∪ flagged; carry-over from the request year

The seed imports every row requested in 2026 **or** flagged Y: 330 rows (253 + 77). A flagged row
requested before 2026 gets `carry_over = true` and `reg_year = request year` (2025: 62, 2024: 15).
`projects.capacity_flag` (new, boolean) stores column 3. `spillover_2025` stays a display flag and
no longer sets `carry_over` (ADR 0035 §10 superseded). Cancelled rows are imported (30) and never
load anything.

### 2. Load scope on the Capacity surfaces

- **Full-year load** (per capacity hub, ADR 0042) = Σ effective design-kind durations over every
  stored project of the capacity hub (members included) with status ≠ Cancelled; lab likewise per
  lab region, lab steps counted only when `certification_testing_required`. Computed from
  `project_workflow_steps` (`coalesce(duration_override_weeks, duration_weeks)`, skipped steps 0),
  **independent of the active run**. This is the figure `booked_pct` (year), `gap` and
  `completion_pct` (year) use.
- **Remaining-year load** = the same over projects in an open status (In Queue, In Development,
  Under Industrialization), counting only steps that are not Done (ADR "Per-stage progress"
  remaining duration). `booked_pct` (remaining) uses it against the remaining capacity.
- **Booked in plan** = today's run-based figure (I6/I7), served beside the two above as
  `design_load_booked_weeks` / `lab_load_booked_weeks`. I6 and I7 keep binding it to the run; two
  new invariants bind the demand figures (§5).

### 3. Per-project effort fields and the distribution rule

New `projects` columns (Numeric(6,2) ≥ 0, nullable unless noted): `design_effort_weeks` (col 16),
`lab_effort_weeks` (col 21), `safety_lab_weeks` (col 22), `actual_design_weeks` (col 17),
`actual_testing_weeks` (col 23); `safety_certification_required` boolean (col 24). The import sets
`certification_testing_required = (col 18 = "Yes") OR (lab_effort_weeks > 0)`, because the
client's pivot applies no cert filter and 13 open rows carry lab weeks with cert ≠ Yes.

**Rule.** For a project with `design_effort_weeks > 0`: let S be the category's design-kind steps
with table duration t_i > 0, T = Σ t_i, E = round-half-up(design_effort_weeks) (≥ 1). Quota
q_i = E × t_i / T; each step gets ⌊q_i⌋; the remainder E − Σ⌊q_i⌋ is given one week at a time to the
steps with the largest fractional part, ties broken by larger t_i, then step order. Σ = E exactly. A
step that receives 0 is **skipped** (`skipped = true`, zero duration, transparent to successors, I5
shape preserved). The result is written to `duration_override_weeks` of those steps; the project's
other steps keep `NULL`. The same rule applies to the lab-kind steps with `lab_effort_weeks` (steps
with cert skipped as today when `certification_testing_required = false`). When the figure is
blank or 0 the step keeps the table duration (fallback; 25 of 221 open rows, 36 of 300 full-year
rows). Worked examples: B, E = 4: quotas 0.4, 0.4, 1.6, 0.4, 0.8, 0.4 → A 1, D 1, E 1, K 1; J and M
skipped. C, E = 3 (A 1, D 1, E 2, J 1, K 1): → A 1, D 1, E 1; J and K skipped. B lab 10 (F 0, H 6): H
10. A+ lab 4 (F 6, H 6): F 2, H 2. PD-Romania B lab 70: H 70. A figure of 1.5 rounds to 2.

**Override domain.** `duration_override_weeks` becomes 0..104 (0 = skip). ADR 0019's "an override
never revives a 0-week step" still holds; a non-zero step may now be zeroed. A user-entered
override (Gantt / Workspace) keeps its 1..104 UI range.

**Re-derivation.** `services/project_effort.apply_effort_overrides(project)` runs on import, when
`design_effort_weeks`, `lab_effort_weeks`, `category` or `certification_testing_required` change,
and after a lead-time table edit (the distribution depends on the table's shape); it sets
`schedule_stale`, never runs a solve, and is audit-logged like a step-timing edit.

**Fallback for hubs with a convention.** Romania's unflagged 2026 rows carry no figure (17 rows).
The fallback is the category table (A 18 / B 10 / C 6 → 150 wk over those rows); Romania's own 20 /
15 convention would give 291. The app invents no hub constant: if the client confirms the
convention (OQ #67) it becomes a per-hub default on Workflow Settings in a later ADR.

### 4. Vocabulary and chambers

- `ProjectType` gains `AC` (Alternative Component) and `SER` (Service), both in the client's own
  type list. No scoring tag (ADR 0038 §6 unchanged). `BC` is not added: it maps to `RC`
  ("Regulatory / Business Compliance") by the ADR 0038 amendment of 2026-10-22 (P29-T04). `CER` and
  `TCO` stay null with `excel_type` (OQ #58).
- Hub `OEM-Seltek` is renamed **`OEM-Seitek`** (PG `ALTER TYPE hub_name RENAME VALUE`). Every
  client source writes Seitek; the only "Seltek" is the prototype, which is not the spec.
- Chamber `allowed_stages` follow the client's test-type mapping: "ALL test" → {PDD-F, PDD-H};
  "POC & Industrialization" → {PDD-F}; "POC & Certification" → {PDD-F, PDD-H, OEM-E, OEM-H}
  (Greece serves the OEM hubs); Romania (unspecified) → {PDD-F, PDD-H}. Changes: IN-CH1 −H, IN-CH2
  +H, IN-CH4 +F, GR-CH2 +H +OEM-H, RO-CH2 +H. India CH-4 is asked about (OQ #71).
- The seed uses `Development Step` for Under Industrialization as well as In Development
  (In Queue stays Not Started); `Mon'YY` end-date strings are parsed; `OEM-SEITEK` is normalised.

### 5. Invariants (proposed additions; the workflow-auditor words them)

- **I22** Full-year design demand per capacity hub = Σ `coalesce(duration_override_weeks,
  duration_weeks)` over design-kind steps of its non-cancelled projects (members included), and
  the served `design_load_weeks` equals it to the week. Lab demand per region likewise, cert-gated.
- **I23** For a project with `design_effort_weeks > 0`, Σ effective design-kind durations =
  round-half-up(`design_effort_weeks`); likewise for lab. Re-derivation after a table edit or a
  field change restores this.
- I6/I7 unchanged in meaning, bound to `design_load_booked_weeks` / `lab_load_booked_weeks`.

## Consequences

Measured on the live sheet (details `docs/DATA_RECONCILIATION_2026.md` §7.7), with ADR 0042's
roster and Elena Micu / Marian counted:

| Capacity hub | Capacity (year) | Full-year demand (client figures, table fallback) | Booked % | Completion % | Client's own figure (flag Y excl. Cancelled, no fallback) |
|---|---|---|---|---|---|
| Greece (own + OEM-HCK + OEM-Seitek) | 124.88 | 266 | 213.0 | 46.9 | 243 / 194.6 % |
| R&D-India | 88.33 | 150 | 169.8 | 58.9 | 150 / 170.7 % |
| PD-India | 253.96 | 884 | 348.1 | 28.7 | 658 / 260.5 % |
| PD-Romania | 253.00 (165.00 without Elena/Marian) | 534 (675 under Romania's 20/15 convention) | 211.1 (323.6) | 47.4 | 375 / 227.3 % |

- The 36 blank rows' table fallback (PD-India +180, PD-Romania +150) is the whole difference
  between the app's figure and the client's; the per-project rounding adds 6 wk in PD-India.
- Lab full-year demand India 860 / Greece 46 / Romania 860 vs capacity 188.30 / 73.34 / 216.30.
- Remaining demand (open rows, before progress): Greece 215, R&D-India 150, PD-India 676,
  PD-Romania 198.
- Projects: 330 (open 221, carry-over 77, flagged 262); type null 1 (`CER`).
- The schedule changes for every project with a typed figure (most B/C projects shrink from 10/6 to
  4/3 design weeks; Romania's grow to 20/15; a handful of lab steps grow to 70 weeks). Within-year
  counts, the Gantt and the board change; the greedy golden files are re-cut.
- `docs/CLIENT_FORMULAS.md` §2.3 is corrected (the pivot sums every row; "Count of Certification
  Testing Required" counts non-blank cells).
- Open questions raised: OQ #64–#75.

## Not decided here

Who the non-roster leaders are and their FTE (OQ #64–#66), Romania's convention as a default (OQ
#67), whether the 68 unflagged 2026 rows and On Hold belong in the remaining-year scope (OQ #72),
and the chamber CH-4 mapping (OQ #71).

## Workflow-auditor ruling (2026-10-22)

**Verdict: ACCEPT WITH CHANGES.** This is a domain ruling, not a phase gate. No implementation task opens
until this ADR carries R1–R14 and the owner has recorded R1. The status line is the orchestrator's.

**Evidence.** Everything below was re-derived independently. The scripts are in the session scratchpad,
`wa0041/`: an exact implementation of §3; the current solver and validator run on the 46-project fixture
with every project's design and lab figure apportioned (100 steps zeroed); FTE 1.0 and 0.63; progress on
zeroed steps; a floor on a zeroed step; greedy and CP-SAT.

- **Today, a 0 override fails the whole run.** `validate_step_timing` raises on it.
- **Widening the domain is not enough.** Without changing the skip rule, it gives 72 degenerate rows
  (`end = start − 1`), and I3 and I15 fire.
- **The skip rule makes it safe.** With "effective duration 0 ⇒ skipped" in `analyse_project`, I1–I22
  hold, the output is deterministic (same hash on re-run), and greedy and CP-SAT agree on every skipped
  flag.
- **The §3 B example is wrong by its own rule.** Quotas 2/5, 2/5, 8/5, 2/5, 4/5, 2/5 give **A1 E2 K1**
  (D, J and M skipped), not A1 D1 E1 K1. The C, lab, A+ and Romania examples check out.
- **Float arithmetic changes the split.** A float version disagrees with exact arithmetic in 52 cases
  (PDD/A, E = 1..300).
- **Recorded work can vanish silently.** A Done or In Progress stage on a zeroed step disappears from the
  run: it is shown skipped at its predecessor's end. No invariant fires, because I11 exempts skipped
  steps.
- **A 1-week floor does not meet the ADR's own goal.** The floor used by the delivery-rate experiment is
  also invariant-clean. But B has 6 non-zero design steps and C has 5, so with a floor B cannot go below
  6 weeks or C below 5. The client's 4 and 3 cannot be reached, and load would not reconcile with col 16.
  Keep 0..104.

### Required changes

- **R1 — span vs load (owner decision).** Under ADR 0032 one effort figure sets both the load and the
  calendar span (`ceil(effort / fte)`, with the leader exclusive).
  - **What it means.** §3 therefore shortens B design from 10 weeks to 4 at 1.0 FTE. The client's own
    "Design Time – Project leader concept" is 8. This is the largest single lever on the within-year
    count (19.6 → 43.5 %, measured).
  - **Required.** State this as the rule, and record the owner's acceptance.
  - **Not 0041.** "Lead-time span, effort load" needs fractional allocation (I1 rewritten as Σ
    allocation ≤ fte per week). That is a separate ADR.
  - **Rejected.** A hybrid with table spans, an exclusive leader and effort-only load. It reopens known
    defect #1: the Gantt and the Capacity page would disagree.
- **R2 — exact split.** Correct the B example to A1 E2 K1.
  - Quotas are exact rationals.
  - Remainder ties go by larger fractional part, then larger t_i, then `sequence_order`, then `step_id`.
  - `E = max(1, round_half_up(x))` on the stored decimal, for x > 0.
- **R3 — recorded work is never erased.**
  - A step whose stored status is not Not Started gets `max(1, A_i)`. The total may then exceed E by
    the number of raised steps.
  - The seed apportions before `derive_progress`, and derives progress on effective durations.
- **R4 — provenance.** `duration_override_weeks` stays the user's figure (1..104; ADR 0019 unchanged).
  - **Storage.** The split goes in its own column, e.g. `project_workflow_steps.effort_weeks` (0..104).
  - **Precedence.** effective = user ?? effort ?? lead. The solver input carries the merged value
    (domain 0..104).
  - **Re-derivation** writes only the effort column, so "a table edit never clears an override" still
    holds.
  - **Reset timing** restores the effort value. The Gantt "(table T)" tooltip and `hasTimingEdit`
    ignore effort values.
  - **Alternative.** A provenance flag on the single column is acceptable if it meets the same four
    conditions.
  - **User overrides on skipped steps.** A new user override cannot be set on a step whose effective
    duration is 0 (409 `STEP_SKIPPED`). An existing one keeps the step.
- **R5 — one skip predicate everywhere:** skipped ⟺ lead = 0 ∨ (lab ∧ ¬cert) ∨ effective = 0.
  - **Where it lives.** `scheduling.workflow.analyse_project` and `services.workspace.is_step_skipped`.
  - **Who must use it.** `step_timing` (`STEP_SKIPPED`), the Workspace stage PATCH (`STAGE_SKIPPED`),
    gantt `timing_editable`, `project_cards` and `tracking`. Today these test `duration_weeks == 0`.
  - **The demand query too.** A bare `coalesce(override, duration_weeks)` revives a table-0 step that
    carries a stale override.
  - **The validator.** The I5 check must derive skip from the inputs, not from `analyse_project`.
- **R6 — re-derivation triggers.**
  - **Added triggers:** a workflow change (a hub move between PDD and OEM; `sync_project_steps` clears
    overrides), a step-kind edit on Workflow Settings, and unfreezing.
  - **Scope.** Every project with a figure, non-schedulable ones included.
  - **Frozen projects.** A no-op for a frozen project, just as a Gantt timing edit is refused (I10).
  - **Audit.** It gets its own audit action. It only sets `schedule_stale`; it never recalculates.
- **R7 — edge cases.**
  - The table has no non-zero step of a kind (T = 0): no split; the figure is flagged as not applied.
  - A split that puts a step above 104 weeks: rejected at write and at import.
  - Certification testing off: lab steps stay skipped, whatever `lab_effort_weeks` says.
- **R8 — status sets.** "Open" means the four schedulable statuses; In Buyoff is missing from the ADR's
  list. The full year excludes Cancelled and Draft.
- **R9 — remaining demand.** Defined exactly as in I25 below.
- **R10 — Monte Carlo.** `_perturbed_step_timing` keeps a sampling floor of 1 for a non-zero override.
  An input 0 stays 0.
- **R11 — invariant IDs.** I22 and I23 already exist (step floor, hub filter). The new invariants are
  I25 and I26, as worded below.
- **R12 — which load each reader uses.** Say it for each:
  - **P1 capacity fill (ADR 0036).** Recommended: remaining demand, so "capacity full" means the same
    as on the Capacity page.
  - **What-if "before".** Reconciles with `*_load_booked_weeks`.
  - **`*_load_by_priority`.** Sums to the full-year demand.
  - **Dashboard capacity cards.** The same served fields.
  - **ADR 0042 `members`.** Carry demand and booked, and sum to their row.
  - **Engineer utilization.** Stays run-booked.
- **R13 — DOMAIN_RULES text.**
  - The per-project override paragraph.
  - The `estimated_*` "never affect the schedule" sentence (OQ #12): retire the Estimated column, or
    relate it to the effort fields.
  - The lab-skip justification that cites CLIENT_FORMULAS §2.3, which is wrong (W9).
  - The hub spelling.
- **R14 — sequencing.**
  - The solver change (R5, domain 0..104) lands before any 0 is written.
  - The migration runs after `p29a_capacity_hubs`.
  - The rename also covers the scheduler fixtures (`prototype_seed_data.json`,
    `_selftest_common._OEM_HUBS`) and the golden files. Stored runs keep "OEM-Seltek" (I14).

### Invariant wording (replaces / adds in DOMAIN_RULES)

Definition, under "Lead times": `eff(p,s) = 0` if `lead(p,s) = 0` or (`kind(s) = lab` and not
`p.certification_testing_required`); else `user_override ?? effort_weeks ?? lead`. `skipped(p,s) ⟺
eff(p,s) = 0`. I5, I11, I21 and I22 read "skipped" this way; their wording is otherwise unchanged.

- **I6** *(rev. ADR 0041)* — **booked design load** per capacity hub (ADR 0042): Σ `duration_weeks` of
  the non-skipped `design`-kind rows **of the active run**, over the projects of the hub and its
  members. Elapsed and skipped rows add 0. These are effort weeks, never the span. The served
  `design_load_booked_weeks` equals it to the week, and so does Σ Gantt per-project design weeks. Each
  row's `duration_weeks` = `eff` of the run input.
- **I7** *(rev.)* — **booked lab load** per lab region: Σ `duration_weeks` × 1.0 of the non-skipped
  `lab` rows of the active run. It equals the served `lab_load_booked_weeks`, with each region counted
  once.
- **I17** *(rev.)* — Supply as before. The load figures equal I25 (demand) and I6/I7 (booked), each
  served field to its own definition.
- **I19** *(rev.)* — Every served `booked_pct` = load / capacity × 100 of the same row, to 2 dp.
  - **Year** pairs `design_load_weeks` / `lab_load_weeks` (full-year demand) with the yearly capacity.
  - **Remaining** pairs `*_load_remaining_weeks` with the remaining capacity.
  - `gap` and `completion_pct` use the same pairs.
  - Nothing of this kind is served for `*_load_booked_weeks`.
  - Thresholds and the each-region-once rule are unchanged. No browser arithmetic.
- **I23** *(rev.)* — As before, except that Dashboard and Capacity show the same served capacity
  fields for h. The Gantt's per-project design and lab weeks for h sum to the Capacity
  `*_load_booked_weeks` (not the demand), to 2 dp.
- **I25** *(new)* — **demand load**, from live project and step rows, never from a run, with the same
  `eff` the scheduler uses.
  - **Full-year design demand(h)** = Σ `eff(p,s)` over design-kind s, for every project of h and its
    members with status ∉ {Cancelled, Draft}.
  - **Remaining design demand(h)** = Σ `rem(p,s)` over the same, for projects in a schedulable status
    (In Buyoff, Under Industrialization, In Development, In Queue).
  - **`rem(p,s)`** is 0 when `eff` = 0 or the stage is Done. For In Progress or Blocked it is
    `derive_remaining(eff, percent_complete, remaining_weeks_override)`. For Not Started it is `eff`.
    Effort, never a span. Not windowed to W52. Stored progress applies to every project, frozen
    included.
  - **Lab** is the same per lab region.
  - **Served fields.** `design_load_weeks`, `design_load_remaining_weeks`, `lab_load_weeks` and
    `lab_load_remaining_weeks` equal these (design to the week, lab to 2 dp).
- **I26** *(new)* — **effort split.** Applies to every non-frozen project with
  `design_effort_weeks = x > 0` whose category has a design-kind step with `lead > 0`.
  - **Rule.** The derived effort on those steps equals the R2 apportionment of
    `E = max(1, round_half_up(x))` over their lead times, raised to `max(1, ·)` on started steps (R3).
  - **Total.** Σ = E plus the number of raised steps.
  - **Other steps** carry no derived effort.
  - **Lab** is the same with `lab_effort_weeks`, when certification testing is on.
  - **When.** It holds in the same transaction as any R6 trigger.

**Unaffected:** I8 and the scheduling order. Durations are not a sort key, and the CP-SAT objective
weights do not read them. The split is computed and stored outside the solver, which sees canonical
`step_timing`. I9, I10 (given R6), I12 (the formula; the weights become effort) and I20 are unchanged.

### Observations (non-blocking)

- **LEFT_OUT by construction.** A Not Started step longer than `HORIZON_WEEKS − CURRENT_WEEK` (36 weeks
  at W42) can never be placed. Romania's 70-week H steps are examples. Say so in Consequences.
- **At Risk badges.** In Progress stages whose effective duration shrinks will read as overrunning
  ("At Risk") on the first run.
- **Fallback.** Rows with no figure load the app's 10/6 (A and J are design steps, OQ #13), not the
  client's 8/4. A typed 0 is treated like a blank.
- **C-category lab effort.** It lands entirely on PDD-H (certification) chambers, even where the client
  means POC testing (OQ #70).
