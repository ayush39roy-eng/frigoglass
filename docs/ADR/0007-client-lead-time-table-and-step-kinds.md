# ADR 0007: The client's per-category lead-time table replaces category multipliers; steps are design, lab or elapsed; OEM projects get their own workflow

## Status

Accepted (2026-09-27). Supersedes the "Category multipliers" section of `docs/DOMAIN_RULES.md` and
the `base_weeks` column of the workflow template. Evidence: `docs/CLIENT_FORMULAS.md` §1
(`reference/Formula-2025-26 Global RPD Project Pipeline.xlsx`, sheet `Final RPD`).

## Context

The prototype (and therefore DOMAIN_RULES.md until today) derived every step duration as
`max(1, round(base_weeks × multiplier))` with `A+ 1.0 / A 0.8 / B 0.5 / C 0.25`. Frigoglass has now
supplied the workbook their planners actually use. It contains an explicit **lead-time table**: one
integer week count per (category, step), with zeros where a category skips a step entirely (a B
project has no Feasibility Study, no Business-case approval and no CAPEX approval). No multiplier
reproduces that table — e.g. PDD-B is 8 weeks for A+, 4 for A and 0 for B/C.

The same sheet's row formulas also say which steps consume which resource. Design time sums steps
A, B, D, E, I, J, K, M; lab time sums F and H; steps C, G, L, N are in the total lead time but in
neither — they are approvals, a plant pilot and commercial launch: calendar time that no engineer or
chamber is booked for. The prototype treated F, H, J, L as chamber-booked and everything else as
engineer-booked; six of the fourteen step names also differ from the client's.

Finally the workbook has a second, OEM-specific workflow (OEM-A … OEM-N) with categories
A-OEM / B-OEM / C-OEM and its own lead times ("only for Frigoglass resources — steps are done by
OEM"). The app currently forces OEM-hub projects through the PDD template with A+/A/B/C.

## Decision

1. **Durations come from a configurable lead-time table**, seeded verbatim from the workbook:
   `duration_weeks = lead_time[workflow][category][step]`. The `max(1, …)` floor is gone: a
   0-week entry means *the step does not apply to that category* and it is recorded as `skipped`
   (no calendar time, no capacity, `start = end = predecessor end`). The table is editable by
   Super Admin on the Workflow Settings surface; every change is audit-logged and marks every
   schedulable project `schedule_stale` (a settings change never auto-solves — same rule as
   progress edits, ADR 0006).
2. **Three step kinds.** `design` books the project leader; `lab` books a chamber; `elapsed`
   books nothing but occupies calendar weeks on the project's critical path. PDD kinds:
   design = A, B, D, E, I, J, K, M; lab = F, H; elapsed = C, G, L, N. The B/C rows' design
   formulas omit A and J; we treat that as a workbook inconsistency (OPEN_QUESTIONS #13) and keep
   A and J as design for every category.
3. **Step names and codes follow the client** (`docs/CLIENT_FORMULAS.md` §1.1). Step IDs
   (`PDD-A` … `PDD-N`) are unchanged, so no historical `ScheduleRun` row is invalidated.
4. **A second workflow, `OEM`**, with steps OEM-A … OEM-N, is assigned to every project whose hub is
   OEM (`OEM-HCK`, `OEM-Seltek`). `ProjectCategory` gains `A-OEM`, `B-OEM`, `C-OEM`; OEM-hub
   projects must use one of those, non-OEM projects one of `A+/A/B/C`. The workbook gives no
   design/lab split for OEM steps; kinds are assigned by analogous name (OPEN_QUESTIONS #14):
   design = A, B, D, G, I, J, K, M; lab = E, H; elapsed = C, F, L, N. Scheduling-order category
   rank becomes `A+ → A → B → C → A-OEM → B-OEM → C-OEM`.
5. **Lab steps apply only when the project requires certification testing.** New
   `Project.certification_testing_required` (default `true`); when `false`, F and H are `skipped`
   exactly like a 0-week entry. This is how the client's own lab-load pivot works
   (`docs/CLIENT_FORMULAS.md` §2.3).
6. **Lab consumption is 1 platform-week per project-week**, not the prototype's 0.5. The client's
   lab load is the plain sum of lab lead-times and their supply is platform-weeks (ADR 0008); a 0.5
   factor would make load and capacity incomparable. `Chamber.max_concurrent` is the platform count.

## Consequences

- `docs/DOMAIN_RULES.md` "Workflow template", "Category multipliers" (now "Lead times"), booking
  rules, scheduling order and invariants I5/I6/I7 are rewritten in the same change.
- `backend/domain_constants.py` loses `CATEGORY_MULTIPLIERS`/`duration_weeks()`; the seed tables
  carry the lead times. The P2 golden files that encode multiplier-derived durations are
  regenerated from the new contract by `algorithm-engineer` and re-adjudicated by
  `workflow-auditor` — the prototype oracle was retired at P2 close and is **not** consulted.
- Every existing `ScheduleRun` was produced under the old durations. They remain readable history
  (I14) and are simply superseded by the first run after this change.
- Capacity Planning's engineer `allowed_categories` already includes `OEM`; it now also has to
  accept the three OEM categories explicitly.
- What the client must still confirm is listed in `docs/OPEN_QUESTIONS.md` #12–#15. Any answer that
  differs from the assumptions above is a data change (lead-time table, kind column), not a code
  change.

## Amendment 2026-11-17 (P39): PDD-A Marketing Brief is `elapsed`, not `design`

**Status:** Proposed until the workflow-auditor rules at P39-T01 (questions Q1–Q6 below).

**Owner ruling, 2026-11-17, verbatim:** "also marketing is under others, not a design step".

**Evidence.**
- The client's old tool, "Responsible for activity" row (`docs/DATA_RECONCILIATION_2026.md` §2.3;
  OQ #61): PDD-A is done by Marketing, not by the design resource.
- The workbook's B and C design-time formulas omit PDD-A (OQ #13; `docs/CLIENT_FORMULAS.md`
  inconsistency 5). The A+/A formula and the step-name colour still group it with design. The
  owner's ruling settles that for PDD-A.
- "Others" in the old tool's legend means work not done by the design resource. Nothing in the
  roster or the capacity model stands for Marketing, so there is nothing to book.

**Decision.**
1. **PDD-A's kind becomes `elapsed`.** It books nobody and has no FTE stretch. It adds nothing to
   design demand (I25) or to booked load (I6). It keeps its calendar weeks on the critical path.
2. **No new kind.** A distinct `other` kind would schedule exactly like `elapsed`. It would also
   cost a Postgres enum change and a new branch in every kind reader (scheduler, split, demand,
   Gantt, legends), for a difference that is only a label. If the owner wants the old tool's word
   on screen, that is a label for the existing kind (OQ #100 b), not a new kind.
3. **The split.** R2 runs over PDD's remaining design steps (B, D, E, I, J, K, M) with their
   `effort_weight_weeks` (R33-2). DOMAIN_RULES "Per-project effort" carries the recomputed examples
   (PDD/B design 4: A 1, E 2, K 1 → D 1, E 2, K 1).
4. **History.** Stage statuses, actual dates and check-ins on PDD-A stay as recorded. Stored runs
   keep their `workflow_snapshot` kinds (I14), so earlier runs still show PDD-A as design.
5. **Mechanism.** The change is a kind-column data change, as this ADR anticipated. It goes
   through the existing Workflow Settings step-kind edit path:
   - **In one transaction:**
     - set the kind;
     - run `rederive_all_projects(trigger=step_kind_edit)` (R6): PDD-A loses its `effort_weeks`,
       and S′ shrinks;
     - write the `workflow_settings.steps_update` audit (actor NULL = system, reason "ADR 0007
       amendment 2026-11-17"), plus one `project.effort_rederived` per changed project;
     - set `schedule_stale` on every schedulable project.
   - **Then dispatch one greedy run** with `trigger_reason="step_kind_changed"` and the ADR 0023
     lifecycle (queued / deferred / not_needed).
   - **Who does it.** An idempotent one-off script, `scripts/p39_marketing_brief_elapsed.py`,
     following the `scripts/p33_recalc_after_timing_clear.py` pattern. Not an Alembic data
     migration: a migration cannot run the async R6 service in the same transaction, and a second
     copy of R2 in SQL would drift. The router's step-kind body is extracted into a service that
     both the router and the script call. Router behaviour does not change.
   - **Fresh installs** get the kind from `domain_constants.WORKFLOW_STEP_TEMPLATE_SEED`. The seed
     `merge`s template rows, which can change a kind on an existing DB without R6. So the script
     always re-derives, even when the kind is already `elapsed`.
6. **OEM-A Commercial Brief is unchanged (`design`).** The old tool lists OEM-A as "R&D Resource",
   which is ADR 0042's basis. The owner is asked to confirm (OQ #100 a).

**Consequences.**
- **Projects with no design figure:** design demand falls by PDD-A's `plan_weeks` (1 in every
  seeded category). The calendar does not change.
- **Projects with a design figure:** they keep E. Their chain gains PDD-A's `plan_weeks` of calendar
  time. Before, PDD-A was either one of the E weeks or skipped by a 0 share.
- **R3-raised PDD-A weeks** leave the load.
- **0.5 FTE leaders** no longer stretch PDD-A to 2 weeks.
- **When figures move:** booked %, within-year and the P1 capacity fill (ADR 0036) move with the
  first run after the change. Demand and the register's "Design time" move at commit.
- **Open questions:** this closes OQ #13 and OQ #61 for PDD-A only. PDD-J ("engineering" in the old
  tool) stays design, and stays open in both.
- **Scheduler:** `backend/scheduling/` is unchanged, because the scheduler reads kinds from its
  input. Golden fixtures carry their own templates.

**Questions for the P39-T01 ruling.**
- **Q1.** `elapsed` vs a distinct kind (Decision 2).
- **Q2.** A PDD-A that is In Progress loses its leader booking for its remaining weeks. Is
  "recorded history kept, no further booking" right, with no I21/I22 effect?
- **Q3.** Script vs migration. Is a guard migration or a migrated-vs-fresh equality test still
  wanted?
- **Q4.** On projects whose design was own-effort, PDD-A's `plan_weeks` was not updated by template
  applies (a "length not applied" step), so it can lag the template. Should the change re-copy the
  current template `weeks` onto not-reached PDD-A rows, as OR-5 does for a cleared figure?
- **Q5.** The `trigger_reason` value. Does any CHECK or enum need it, and is a run `not_needed`
  when no schedulable project changed?
- **Q6.** Excluded PDD-A rows (ADR 0049) stay excluded. Does R35-5 (`EFFORT_NEEDS_A_STEP`) need a
  re-check for a project whose only remaining non-excluded design step was PDD-A?

### Ruling (P39-T01, workflow-auditor, 2026-11-17)

**Verdict: Q1 ACCEPT; Q2–Q6 ACCEPT WITH AMENDMENT; plus R39-1 (owner decision, blocks P39-T05 and the
release) and R39-2 (corrected consequences).** Ruled against DOMAIN_RULES, not against the code.

**Measured** on `rpd_p39t01_copy` (a `pg_dump` of `rpd` at p33c; 330 projects, 14 runs; dropped afterwards; `rpd`
untouched). Code: the clean worktree at 9a41987 (pre-P37, so the pin is read through `domain_constants`).
`RPD_CURRENT_WEEK=47` for both runs. Harness check: an in-memory greedy at W42 equals stored v14 (0 differences).
- v15 is the fresh greedy run before the change (`POST /schedule-runs/greedy-recalc`).
- Then `PUT /workflow-settings/steps/PDD` with PDD-A → `elapsed` (Super Admin, the existing router path).
- v16 is the fresh greedy run after. Figures are served values. Bucket counts include the 51 Commercialized
  projects, as the Dashboard does.

| Hub | within / spillover / left out, v15 → v16 |
|---|---|
| All | 114 / 82 / 76 → **82 / 75 / 115** |
| PD-India | 78 / 42 / 65 → 46 / 45 / 94 |
| R&D-India | 2 / 22 / 6 → 2 / 12 / 16 |
| PD-Romania | 16 / 10 / 2 → unchanged |
| R&D-Greece | 3 / 0 / 3 → unchanged |
| OEM-HCK | 6 / 5 / 0 → unchanged |
| OEM-Seitek | 9 / 3 / 0 → unchanged |

Blocked is 0 in both runs. No project improved. 52 projects got worse: 19 within → left out, 20 spillover → left
out, 13 within → spillover. All 52 are PD-India or R&D-India; 50 of them are P3 and In Development or Under
Industrialization.

| Capacity hub | design demand full-year | design demand remaining | booked load (run) | booked % year / remaining |
|---|---|---|---|---|
| PD-India | 884 → 866 | 436 → **487** | 401 → 339 | 348.09 / 1785.42 → 341.00 / 1994.27 |
| PD-Romania | 534 → 517 | 81 → 84 | 186 → 177 | 211.07 / 332.92 → 204.35 / 345.25 |
| R&D-Greece | 266 → 266 | 106 → 109 | 189 → 188 | 213.00 / 882.60 → 213.00 / 907.58 |
| R&D-India | 150 → 150 | 65 → **89** | 117 → 99 | 169.82 / 765.61 → 169.82 / 1048.29 |
| Total | 1834 → 1799 | 688 → **769** | 893 → 803 | — |

- **Commit vs run.** Demand, booked % and the P1 fill had all moved at commit, before v16. Only the booked load and
  the verdicts moved with the run.
- **P1 capacity fill:** 15 → 13. Two R&D-India B projects lost it: the hub's P1 remaining design load rose to
  10.00 of 8.49 weeks.
- **Finish moves:** 107 projects' finish moved, 102 of them with a design figure. 3 moved 1 week earlier, 39 went
  to left out, and the rest moved 1–28 weeks later.
- **Unconstrained finish:** +1 on 142 projects, +2 on 9, −1 on 6.
- **Audit:** `project.effort_rederived` = **247** (75 In Queue, 65 In Development, 35 Under Industrialization, 44
  Commercialized, 20 On Hold, 8 Cancelled). 0 of them carry `template_copy` (OR-5 does not fire, see Q4). 221
  projects were marked stale. The audit rows contain no financial field.
- **Split examples.** My hand derivation matches the DOMAIN_RULES text for B 4, C 3, B 8, A 18 and A+ 44. Real
  data, every project of the class:
  - B 4, A1 E2 K1 → D1 E2 K1: 122 projects;
  - C 3, A1 D1 E1 → D1 E1 J1: 63 projects;
  - B 8 → D1 E3 J1 K2 M1: 13 projects;
  - B 20, A2 D2 E8 J2 K4 M2 → D2 E9 J2 K5 M2: 17 projects;
  - B 1.5 is unchanged, and C 1.5 goes A1 E1 → D1 E1.
- **Invariants:** 0 violations on v15 and v16.
  - Checked: `validate_invariants(check_determinism=True, live_state=True)`, which covers I1–I7, I8, I9–I12, I15,
    I16, I21, I22, I26-recorded, I27–I30, I35, I37a/b. Also I25 against served demand, and I26 on the live rows.
  - A fresh greedy run on the rebuilt input equals the stored run row for row.
  - I6/I9/I23: Capacity booked = Σ stored design rows = Σ Gantt `design_weeks` per capacity hub, exactly, in both
    runs.
  - I14: v1–v14 steps, outcomes and `workflow_snapshot` hash-identical. v15's snapshot says PDD-A `design` and
    v16's says `elapsed`.
  - Not applicable on this code: I33/I34 (no `excluded` column at p33c), I38–I41 (P37) and I42–I44 (P38).

**Cause of the drop (explained, not a code defect).** 99 schedulable projects have a design figure and a started PDD-A: 98 Done
(B 60, C 35, A 3) and 1 In Progress (A+). Before the change, R2 gave PDD-A a share of E (usually 1), and that share was recorded
work. After the change E is split over B/D/E/I/J/K/M only, so the share moves to a Not Started design step, usually
D or J. Remaining demand on these projects rises by +92 in total; the no-figure projects lose −13.
- In 80 schedulable projects the receiving step is behind a successor that has already started. Example: C 3 with
  A/D/E/H Done and N In Progress now needs J 1.
- PD-India leaders are booked every week from W47 to W77 in both runs. A P3 project that needed no leader before
  now waits behind higher ranks, and goes left out.
- Counterfactual (rolled back, for the owner only): credit a started PDD-A's previous share against the figure, so
  `x − effort_weeks(PDD-A)` before the split. The result is **114 / 82 / 76, identical to v15**. Remaining demand
  falls on every hub: PD-India 426, PD-Romania 78, R&D-Greece 105, R&D-India 65.
- Second counterfactual: drop bypassed steps from S′ (P33 `reached` successor clause). Rejected: it pushes shares
  onto the remaining steps, and 63 → 24 scheduled within-year.

**Q1 — ACCEPT.** `elapsed`, no new kind. The scheduler, split and demand need nothing new. "Others" is a label (OQ
#100 b).

**Q2 — ACCEPT WITH AMENDMENT.** In Progress PDD-A keeps its status, actual start and check-ins. The next run anchors
it with no engineer. Measured on the A+ project in R&D-Greece: W41–W47, no engineer, no I21/I22 violation. A
check-in on it works as it does today on an In Progress N.
- *Amendment:* "history kept" means stage status, actual weeks and check-ins. It does **not** mean `effort_weeks`.
  - A Done or In Progress design step can take a new R3 share. Measured: Done E 1 → 2.
  - The R3-raised PDD-A share (2 weeks here) leaves the figure. See R39-1.

**Q3 — ACCEPT WITH AMENDMENT.** Script, not migration. No guard migration. The migrated-vs-fresh kind equality test
stays (T03).
- (a) **Runbook:** the script runs in the same deploy, right after the code with the new seed. A seed `merge` in
  between flips the kind without R6, which leaves I26 violated until the script runs. T03 tests that I26 holds on a
  seed-merged DB after the script.
- (b) **The run:** created through `services.run_dispatch`. The week is read when the `QUEUED` row is created
  (R37-2). The script never builds an input with an import-time default.
- (c) **Failure handling:** a FAILED or DISPATCH_FAILED inline run exits non-zero and can be retried (P33-R01).
- (d) **Audit:** actor NULL. The reason is "ADR 0007 amendment 2026-11-17", in `after_state`.

**Q4 — ACCEPT WITH AMENDMENT (re-copy, done explicitly).** The OR-5 path in `rederive_project_effort` does not fire.
It computes `lost` with the new kinds on both sides, and `elapsed` is not an effort kind. Measured: 0
`template_copy` in 247 audits.
- **What the script does:** for every non-frozen project that owned a design figure before the change, a
  not-reached PDD-A whose `plan_weeks` ≠ the template `weeks` gets the template weeks. Lengths only (`gaps=False`,
  as OR-5). The copy is recorded in that project's `project.effort_rederived` `template_copy`.
- **Dev data:** a no-op. All 302 PDD-A rows equal the template (1 / gap 0), and `template_changes` is empty.
- **Client data:** T05 counts it.

**Q5 — ACCEPT WITH AMENDMENT.** `schedule_runs.trigger_reason` is `varchar(100)`, with no CHECK, enum or frontend
mapping, so `step_kind_changed` needs no schema change.
- **Dispatch:** one run when the kind changed in this invocation, or when any schedulable project's `effort_weeks`
  or `plan_weeks` changed. Otherwise `not_needed`.
- **Second invocation:**
  - The kind is already `elapsed`, re-derivation changes nothing, and a `step_kind_changed` run is in flight or
    COMPLETED: `already_dispatched` or `not_needed`, exit 0, no audit row. That gives one `steps_update` in total.
  - The kind is already `elapsed` but the split is stale (a seed merge): it re-derives and writes the per-project
    audits. No `steps_update`, because no kind changed. It dispatches only if a schedulable project changed.

**Q6 — ACCEPT WITH AMENDMENT (prospective).** At p33c there is no `excluded` column (P35 storage has not landed),
so there is nothing to check on the dev data. Once it lands:
- Before commit, the script checks every non-frozen project with `inForce(p, design)`. If S′ without PDD-A is
  empty, the script writes nothing: it rolls back and exits non-zero, printing the count and the project ids only.
  The Admin re-includes a step or clears the figure, then re-runs.
- The steps PUT applies the same R35-5 (a) guard (409 `EFFORT_NEEDS_A_STEP`, naming the kind). Today it would store
  `all_steps_excluded`, an I26 violation.
- R35-5 (b) cannot trigger: PDD-A keeps `eff = plan_weeks`.

**R39-1 — owner decision before the script runs on client data (blocks P39-T05 and the release, not T03's
build).** Does a started PDD-A's recorded share stay credited against the design figure?
- **(a) No, the literal rule.** The figure is design-only, so the week returns to design. Measured: 114 → 82
  within-year at W47 (all PD-India / R&D-India). Remaining design +81.
  - This agrees with the workbook's B/C design formula, which omits PDD-A. 95 of the 99 affected projects are B
    or C.
- **(b) Yes, history credit.** Verdicts are unchanged (114). Remaining demand falls.
  - It needs a stored credit, because the client's figure cannot be edited (an import overwrites it). For
    example, a credit frozen at the change from the PDD-A `effort_weeks` of started PDD-A rows.
  - It also amends R2 and I26: `E = max(1, round_half_up(x − credit))`.
  - If chosen: a T03 addendum, a DOMAIN_RULES amendment and a migration for the credit column.
- **The auditor's view:** both are coherent. (a) is the literal consequence of the owner's sentence. (b) matches
  what the owner was told the effect would be ("demand drops").

**R39-2 — corrected consequences.** These replace the "Consequences" bullets above and D39-5 where they differ.
- (i) Full-year design demand falls only on projects without a figure. Measured −35.
- (ii) Remaining design demand **rises** by the recorded PDD-A share on every figure project whose PDD-A was
  started (under R39-1 (a)), and falls by 1 per no-figure project whose PDD-A is not started.
- (iii) Booked % (I19 rev.: demand / capacity) and the P1 fill (live remaining demand,
  `services/priority_capacity_fill.py:182`) move **at commit**. Only `design_load_booked_weeks`, the verdicts and
  the finishes move with the run.
- (iv) `effort_weeks` on Done design steps may change (R3). Actual weeks do not.

**R39-3 — observation, not P39.** Not Started steps behind a started successor still take capacity.
- Before the change: 58 schedulable projects, all lab H/F/E.
- After: 141, including PDD-D 75 and PDD-J 42.
- This deserves its own ruling. The "drop from S′" variant is not the fix (see above).

**R39-4 — measurement conditions for P39-T05.**
- Pin W47, or explain every difference.
- Use a copy with no P38 deactivations, or separate their effect.
- With P37 landed, the script's run takes the pinned or calendar week when its row is created. A weekly rollover
  run in the same week coalesces under ADR 0023, with no other interaction.
- P38 does not touch kinds or effort, so there is no interaction beyond the leaders it clears.
