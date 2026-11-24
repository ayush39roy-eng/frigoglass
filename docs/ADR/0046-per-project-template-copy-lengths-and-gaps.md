# ADR 0046: Per-project copies of the category template, and signed step gaps (overlap or wait)

## Status

**Accepted (2026-11-13, P33-T01).** Three layers apply, highest first:
1. "Owner ruling (OQ #76/#77) — fold-in P33-T01" at the end of this ADR;
2. the workflow-auditor's "Ruling (P33-T00)", R33-1..R33-12;
3. §1–§6 below.

The text of §1–§6 is left as proposed so the history stays readable. **Nothing pins any more**:
`length_pinned` and `length_set` are dropped from the design, and an applied length never overrides
a project's own effort figure. Originally: Proposed (2026-11-13), binding only after the
workflow-auditor's ruling, task P33-T00. The ruling answers questions Q1–Q9 at the end.
Part of P33. This is a scheduler input change. It amends ADR 0041 (eff, R2, R6), ADR 0043 (overlap
source and gate) and ADR 0009 (precedence). Contract: `docs/API_CONTRACT_P33.md` Part F.

## Context

ADR 0045 lets Admins change a category's step lengths and signed gaps, and applies a change only to
the projects the stage rule allows. Two consequences follow for the data and the scheduler.

- **The table can no longer be the per-project truth.** A project that was not selected must keep
  the length and gap it had, even after the table changes. Each project therefore needs its own
  copy of its template values.
- **Gaps can be positive.** ADR 0043 has a per-project `overlap_weeks`: overlap only (0..104), set
  by Gantt drag, gate `max G(q) + 1 − o(s)`. That drag is retired (ADR 0048). Positive waits are new.

The owner also asked for one length rule. When a length change is applied to a project, that step's
duration becomes the template length and supersedes its effort-split value (ADR 0041). This ADR
spells out what that means for R2/R6, load and the skip predicate.

## Decision

### 1. Storage: template rows and per-project copies

- **Template.** `workflow_lead_times` (one row per workflow × category × step) gains two columns.
  - `gap_weeks` (int −104..104, not null, default 0).
  - `length_set` (bool, not null, default false). It is true once an Admin has saved a length for
    that row through P33. Seeded rows are false.
  - `weeks` keeps its meaning (the category length). The table is now called the **category
    template**.
- **Per-project copy.** `project_workflow_steps` gains three columns.
  - `plan_weeks` (int 0..104, not null after backfill): the project's own `lead(p,s)`.
  - `plan_gap_weeks` (int −104..104, not null, default 0): the project's own signed gap `g(p,s)`.
  - `length_pinned` (bool, not null, default false).
  - `template_change_id` (nullable FK to the apply record) gives provenance.
- **Backfill (migration).** Every existing step row gets `plan_weeks` = today's table value for
  its workflow and category, `plan_gap_weeks = 0` and `length_pinned = false`. After the backfill,
  every project's effective durations are byte-identical to today's.
- **Copy rule** (registration, category change, apply). When a template row is copied:
  - `plan_weeks` = `weeks`;
  - `plan_gap_weeks` = `gap_weeks`;
  - `length_pinned` = `length_set` (registration and category change), or `true` when an apply
    changes the length (ADR 0045 §3).
  - This is option **Q3(b)**. A template step whose length an Admin has set governs every project
    that takes the template, including later ones. See Q3 for the alternative.

### 2. Effective duration and the skip predicate (amends ADR 0041 R4/R5)

```
lead(p,s) = p.step(s).plan_weeks                         # was: lead_time[workflow][category][s]
eff(p,s)  = 0                     if lead(p,s) = 0
          = 0                     if kind(s) = lab and not p.certification_testing_required
          = lead(p,s)             if p.step(s).length_pinned
          = user_override ?? effort_weeks ?? lead(p,s)    otherwise
skipped(p,s) ⟺ eff(p,s) = 0                               # the one predicate, unchanged in form
```

- A template change of a step from 0 to n weeks, once applied, **revives** the step for that project
  (its own `lead` is now > 0). A change from n to 0 skips it.
- `user_override` (`duration_override_weeks`) is always null for live projects after ADR 0048. The
  term stays for the what-if and plan-import inputs.

### 3. Length vs per-project effort (amends ADR 0041 R2, R6)

- **Pinned beats effort.** An applied length is the step's duration for that project, whatever the
  project's effort figure says (owner, 2026-11-13).
- **R2 split.** The split is computed exactly as today, with the project's own `plan_weeks` as the
  weights. That is, over the steps of the kind with `lead(p,s) > 0`, pinned steps included.
  - `effort_weeks` is stored for every step as R2 computes it. A pinned step's effort value is
    stored but **shadowed**: `eff` ignores it. I26 therefore holds unchanged as written.
  - Effect: the project's load of that kind = `E − share(s) + plan(s)` summed over pinned steps.
    Unpinned steps keep their share. Because the weights changed, rounding may move at most the
    usual R2 remainder weeks among the unpinned steps.
  - Worked example: B project, design figure 4 (today A 1, E 2, K 1). The template B/E goes 4 → 5
    and is applied. Weights A1 D1 E5 J1 K2 M1 give A 1, E 2, K 1 as before. E is pinned at 5, so the
    effective design is A 1, E 5, K 1 = 7 effort weeks.
- **R6 re-derivation never undoes an applied length.** Re-derivation rewrites `effort_weeks` only. A
  pinned step's `eff` is `plan_weeks` before and after. The R6 triggers become:
  - a figure edit;
  - a change of `certification_testing_required`;
  - a category change (which re-copies the template onto Not Started steps, §1);
  - a workflow change;
  - a step-kind edit (Super Admin, global);
  - **an apply that changes `plan_weeks` on a project** (that project only). This replaces "a
    lead-time edit on Workflow Settings re-derives every project".
  - a stage status crossing Not Started (R3);
  - unfreezing.
- **How a pin is cleared.** Only a category change clears pins, on the Not Started steps that take
  the new template. Those steps take the new template's `length_set` as their pin. There is no "give
  this step back to the effort figure" control in P33 (OPEN_QUESTIONS #77).
- **Load and booked %.**
  - Demand (I25) is computed from live rows with `eff`, so full-year and remaining demand change
    at apply time.
  - The booked loads (I6/I7) change when the recalculation completes.
  - The P1 capacity fill (ADR 0036, remaining demand) may promote or drop suggestions.
  - Supply is unchanged.
  - Progress weights (I12) and the health badge's planned durations use `eff`, as today.
- **Started steps are never touched** by an apply (ADR 0045 stage rule), so R3 is not affected.

### 4. Signed gap in the scheduler (amends ADR 0043, ADR 0009)

For a non-frozen project, `g(s) = plan_gap_weeks`, `o(s) = max(0, −g(s))` (overlap, ADR 0043
unchanged in meaning) and `w(s) = max(0, g(s))` (wait).

```
G(q)       = as ADR 0043 (unchanged; a wait does not change how a step passes its release on)
release(s) = max(G(q) for q in P(s))      (frontier − 1 if none)
gate(s)    = max(release(s) + 1 − o(s) + w(s),
                 max start of the nearest non-skipped predecessors   if o(s) > 0,
                 frontier)
```

- **Not Started** floor: `max(CURRENT_WEEK, gate(s), start_not_before_week)`. Capacity then applies
  as today.
- **A wait books nothing.** No engineer, no chamber, no row and no load (I6, I7, I25). It does not
  count as a progress weight and is not drawn as a bar. The step simply cannot start earlier.
- **In Progress / Blocked tail:** `w(s)` is taken as 0, because the step has started and its wait is
  over. `o(s)` applies as in ADR 0043.
- **Done:** unaffected (I11).
- **Skipped step:** `g` is ignored, as overlap is today. A skipped step stays transparent and is
  emitted at `G`.
- **First step** of a workflow: `g` must be 0. It is rejected at template save (422) and validated
  in the scheduler input.
- **Frozen project:** `g` is ignored (I10), as overlap and `start_not_before_week` are.
- **Unconstrained finish:** honours both `o` and `w`. They are plan inputs, like a floor, not
  resource limits.
- **CP-SAT and the validator** use the same definitions.
- **Scheduler input.** `StepTimingInput` gains `lead_weeks: int | None = None` (None = the table;
  0..104) and `wait_weeks: int = 0` (0..104). `overlap_weeks` stays.
  - At most one of `overlap_weeks` and `wait_weeks` is non-zero; both non-zero is a validation
    error.
  - The backend maps `g < 0` to `overlap_weeks = −g` and `g > 0` to `wait_weeks = g`.
  - It passes `lead_weeks` only when `plan_weeks` differs from the table value, and passes the
    pinned or effort merge in `duration_override_weeks` as today (pinned → `None`, so the
    scheduler uses `lead_weeks`).
- **Canonical / hashed form** omits `wait_weeks = 0` and `lead_weeks = None`. With every gap 0 and
  every copy equal to the table, the input, its hash, every golden file and every stored run are
  byte-identical to today (I8, I14). That is the state straight after the backfill.

### 5. The template preview

The category timeline is computed by one pure function in `scheduling`
(`template_timeline(workflow, category, lengths, gaps, predecessors)`). It walks the DAG with §4's
gate, from week 0, with no capacity and FTE 1.0. It applies the **one-leader rule**: two design
steps never overlap, so a design step whose gate falls inside an earlier design step's window
starts when that step ends. Each step returns:
- `start_week` and `end_week`;
- `requested_gap_weeks` and `effective_gap_weeks`;
- `flags`: `same_leader_serialised`, `anchor_clamped` (an overlap larger than the predecessor allows
  under the start anchor) and `gap_ignored_zero_length`.

The UI shows the flags as notes. The preview is a template view; real projects also wait for
engineers and chambers (ADR 0045 §1).

### 6. Invariants

- **I27 (rev.)**: every non-skipped Not Started step of a non-frozen project starts at or after
  `gate(s)` as defined in §4. I3 holds unchanged for every step with `g(s) = 0`.
- **I28 (new)**: a step with `w(s) > 0` (non-frozen, Not Started, not skipped) starts at or after
  `release(s) + 1 + w(s)`. Waits add 0 to every load (I6, I7, I25) and to every progress weight.
- **I29 (new)**: every run row's `duration_weeks` equals `eff(p,s)` of §2, evaluated on the run's
  input (per-project `lead_weeks` and the merged override). The validator derives "skipped" from the
  per-project lead.

## Consequences

- The scheduler gains two optional inputs. Neither changes any existing output.
- Every reader of "the lead time of a project's step" moves from the table to `plan_weeks`:
  - demand, the Workspace and Gantt durations, project cards, tracking and the effort split;
  - the what-if baseline and the plan import's matched live projects (`services/whatif_import.py`
    reads the table for live plan projects today).
  New what-if projects keep using the table.
- The P32 per-project `overlap_weeks` column is cleared and no longer written (ADR 0048). Overlap
  now comes from `plan_gap_weeks`.

## Alternatives considered

- *Pin only at apply time (Q3(a)).* New registrations and category changes would copy the length
  unpinned, so the effort figure wins for them while projects that were applied to keep the template
  length. Rejected as the default because two projects of the same category, both not started, would
  read the same template differently. Kept as the alternative in Q3.
- *Exclude pinned steps from the split (E over the rest).* In the B example this gives
  A 1 D 1 J 1 K 1 + E 5 = 9: a template click inflates the other steps too.
- *Subtract pinned weeks from E.* In the B example this gives E 5 and every other design step 0
  (Marketing Brief skipped), and the load becomes `max(E, pinned)`. That is surprising.
- *Pin the excluded projects' old value instead of copying to every project.* This has the same
  outcome with an extra `?? table` fallback everywhere. Materialising once is simpler to audit.
- *A separate `wait_weeks` DB column beside `overlap_weeks`.* Two columns for one signed concept,
  where at most one may be non-zero. The scheduler keeps the two non-negative fields; the DB keeps
  one signed field.

## Questions for the workflow-auditor's ruling (P33-T00)

- **Q1.** §2: `eff` with pin and per-project lead, and the skip predicate on per-project lead
  (an applied 0 → n revives a step; n → 0 skips it).
- **Q2.** §3: R2 weights are the project's own `plan_weeks`, and a pinned step's share is shadowed
  (stored, unused). Or one of the alternatives.
- **Q3.** §1 copy rule: (b) the template's `length_set` pins on every copy, or (a) only an apply
  pins.
- **Q4.** §4: wait ignored on started steps, skipped steps and frozen projects; first-step gap 0;
  at most one of overlap and wait.
- **Q5.** §4: the unconstrained finish and CP-SAT honour waits.
- **Q6.** §5: the preview applies the one-leader rule. Should `unconstrained_end_week` also apply
  it when two design steps overlap? Today it ignores the leader except for FTE stretch. After
  ADR 0048 clears hand-set overlaps there are none live, but the template may create them.
- **Q7.** §4: the canonical form omits the defaults, so golden files and stored runs are
  unchanged.
- **Q8.** ADR 0047 §3: category order from data (`ScheduleInput.categories`), its snapshot on the
  run, and I30.
- **Q9.** ADR 0048 §4: `duration_override_weeks`, `start_not_before_week` and `overlap_weeks` stay
  in `StepTimingInput` for what-if and plan import only. I22 is vacuous for live runs.

## Ruling (P33-T00) — workflow-auditor, 2026-11-13

**Verdict: ACCEPT WITH CHANGES.** R33-1..R33-12 below are binding over §1–§6, ADR 0047 §3 and
ADR 0048 §4, as R1–R14 were for ADR 0041. Where this section and the text above disagree, this
section wins. No code was written. The status line is left to the orchestrator (P33-T01).

**Evidence.** I re-derived from DOMAIN_RULES and read the scheduler as it is at HEAD
(`scheduling/workflow.py` `step_gate` / `passed_release` / `unconstrained_end_week` /
`canonical_step_timing*`, `greedy.py` walk and `_sort_key`, `cp_sat.py` precedence block,
`services/schedule_persistence.py` snapshot, `services/priority_preview.py` token). I ran the real
`scheduling.effort_split.apportion_effort` on PDD/B design, figure 4. The probe is
`p33/r2probe.py` in the session scratchpad.

| Weights (A D E J K M) | Started | R2 result | ADR §3 claim |
|---|---|---|---|
| 1 1 4 1 2 1 (today) | — | A1 E2 K1 | — |
| E → 5 | — | A1 E2 K1 | holds (worked example correct) |
| E → 8 | — | **E3 K1, A 0 → Marketing Brief skipped** | "unpinned keep their share": false |
| E → 40 | — | **E4, every other design step skipped** | false |
| K → 6 | E In Progress | **E 2 → 1** (an In Progress step re-timed) | "started steps never touched": false |

### Per question

**Q1 (§2 `eff`, pin, skip on per-project lead): ACCEPT WITH AMENDMENT (R33-1).**
At the scheduler level, `eff` is evaluated only on the run input. The pin is resolved by the input
builder, never inside the solver:
```
lead(p,s) = lead_weeks(p,s) ?? lead_time_table[workflow][category][s]     # the run input's own table
eff(p,s)  = 0                          if lead(p,s) = 0
          = 0                          if kind(s) = lab and not p.certification_testing_required
          = override(p,s) ?? lead(p,s) otherwise                         # override = StepTimingInput.duration_override_weeks
skipped(p,s) ⟺ eff(p,s) = 0
```
The live builder sets `override = None` when `length_pinned`, else `effort_weeks` (the user override
is null by the ADR 0048 CHECK). It sets `lead_weeks = plan_weeks`, or None when that equals the input
table (R33-9). That gives the domain-level reading of §2: pinned → `plan_weeks`; unpinned → `effort ??
plan`. Pinning never revives a lab step when certification testing is off. A pinned `plan_weeks = 0`
skips. A pinned `plan_weeks > 0` revives a step whose effort share was 0, and the apply preview must
show it. The service-side predicate (`services.workspace.is_step_skipped` and every reader in ADR 0041
R5) takes `(plan_weeks, kind, cert, length_pinned, effort_weeks)` and must equal the scheduler's on the
built input. An applied 0 → n revives a step and n → 0 skips it. Both happen only on not-reached steps
(R33-10), so R3 ("recorded work is never erased") still holds.

**Q2 (§3 R2 weights = `plan_weeks`, pinned share shadowed): REJECT the weights; ACCEPT the shadow (R33-2).**
If the weights are `plan_weeks`, an applied length moves the shares of other steps. Those steps were
not in the change set. That includes started steps, through R6 (table above). So the stage rule
(ADR 0045) and I31 are broken through `effort_weeks`, and the preview (changed steps only) under-reports
the effect. Replacement:
- `workflow_lead_times` gains `effort_weight_weeks` (int 0..104, not null). The backfill sets it to
  `weeks`. No apply, Lead times edit or timeline edit ever changes it. "+ Add category" copies it from
  `copy_from`. These are the client's Final RPD proportions that R2 was ruled on (ADR 0007/0041).
- **R2 weights are the project's category's `effort_weight_weeks`**, not `plan_weeks`. `S` = steps of
  the kind with `effort_weight_weeks > 0`. The rest of R2, R3 and R7 is unchanged. A pinned step's
  share is stored and shadowed, as §3 says.
- **An apply never re-derives effort.** Remove "an apply that changes `plan_weeks`" from the R6
  triggers, and remove step 6 of contract E3. An apply writes no `effort_weeks`.
- Result: unpinned steps keep their exact share. Started steps are untouched. Per kind, load =
  `E + raised − Σ_pinned share + Σ_pinned non-skipped plan_weeks`, exactly as §3 states. The B
  example still gives A1 E5 K1 = 7.
- Both §3 alternatives remain rejected, for the reasons given.
- The other R6 triggers keep their ADR 0041 behaviour, including re-deriving started steps on a
  category change. That is pre-existing and not introduced here.

**Q3 (copy rule (a) vs (b)): mechanics ruled for both; (b) is the default pending OQ #76(b) (R33-3).**
- (b): every copy of a `length_set = true` row is pinned, and an apply pins every length it changes.
  Under (b) and R33-2, **I32** holds: an unpinned step always has `plan_weeks = effort_weight_weeks`.
  Two Not Started projects of one category therefore read the template the same way. This is why (b)
  is the default.
- (a): only an apply pins. Registration and category-change copies are unpinned, so `eff = effort ??
  plan_weeks`. I32 does not hold under (a) and must not be asserted.
- `length_set` is sticky. Setting a length back to its original value still pins. Undoing that is
  OQ #77.
- **Owner dependency.** If OQ #76(a) is answered "relative (+1 on the project's current length)",
  then (b) is impossible: a registration copy has no "current length". The rule then becomes (a),
  with apply writing `plan_weeks = clamp(eff_before + (new − old template weeks), 0, 104)`, pinned.
  The preview and I31 are unchanged in form. Only the copy value changes. If OQ #76(b) is answered
  "no", use (a) with the absolute value.

**Q4 (wait ignored on started, skipped and frozen steps; first-step gap 0; at most one of o and w):
ACCEPT WITH AMENDMENT (R33-4).** The gate is stated piecewise, so that it reduces exactly to the
code (`step_gate` has no frontier term when `o = 0`):
```
gate(s) = release(s) + 1 + w(s)                                           if o(s) = 0
        = max(release(s) + 1 − o(s), max start of SG(s), frontier)        if o(s) > 0
```
- `G(q)` is unchanged. With `o(q) = 0`, `end(q) ≥ start(q) ≥ release(q) + 1 + w(q) > release(q)`,
  so a wait never needs to pass anything on.
- The anchor applies only when `o > 0`. Because `o` and `w` are exclusive, a wait never meets an
  anchor. A step with `o(s) > 0` whose predecessor waited is anchored at that predecessor's
  (waited) start, which is coherent.
- A wait counts from the release, not from `CURRENT_WEEK`. When the release is far in the past, a
  wait already elapsed costs nothing (floor `max(CURRENT_WEEK, gate, snb)`).
- Waits count against `HORIZON_WEEKS`, like any delay, so they can turn a project `LEFT_OUT`.
- `w = 0` on In Progress / Blocked tails and in the Blocked-hold emission. `o` is kept on started
  steps (ADR 0043).
- Skipped step: `g` is ignored and the step is emitted at `G = release`; no wait is carried
  (OQ #80). Under the effort split this is common: for a B project with figure 4, D, J and M are
  skipped. So the apply preview must flag `gap_ignored_skipped` per project, not only on the template.
- Frozen project: `o = w = 0`, but `lead_weeks` and the pin are honoured. They are durations, not
  timing, and since applies never touch frozen copies, this protects I10 better than today's global
  table edit.
- First step: `g ≠ 0` → `ValueError` in the input, 422 `FIRST_STEP_GAP` at the template.
- `o > 0 ∧ w > 0` → `ValueError`.

**Q5 (unconstrained finish and CP-SAT honour waits): ACCEPT (R33-5).**
- CP-SAT adds `start ≥ pe + w` per precedence term. With release sets, the terms are the release
  sets, exactly as `− o` is handled today.
- Monte Carlo samples durations only (the R10 floor applies to `lead_weeks` and the table). It never
  samples or scales `o`, `w` or `g`.
- I16 still holds: unconstrained ≤ constrained, because both add the same `w`.

**Q6 (one-leader rule in `unconstrained_end_week`): ACCEPT — yes, apply it (R33-6).**
In the unconstrained walk, a non-frozen, Not Started design step is placed at the first
`w ≥ floor` such that `[w, w + span)` does not intersect the window of any design step of the same
project already placed in walk order. Anchored tails count from `CURRENT_WEEK`. This is greedy's
leader search restricted to the project itself. Why:
- the leader is a fixed person, which is the same reason the FTE stretch is already kept (ADR 0032);
- without it, a template design ∥ design overlap makes `expected_end_week` too early by the overlap
  amount, so every such project shows spurious slip;
- the template preview, the apply preview and the unconstrained finish must agree.

I16 still holds: greedy's leader calendar is a superset of the project's own bookings, and first fit
is monotone in the floor. With `o = 0` everywhere and design steps totally ordered by precedence (the
seeded strict chain), the rule is vacuous, so outputs are unchanged. If any golden file or fixture
changes, that fixture has parallel design branches. The algorithm-engineer stops and reports it to
the workflow-auditor and does not re-bless the golden file. P33-T05 confirms the live
`workflow_snapshot` DAG keeps design steps totally ordered.

**Q7 (canonical form omits defaults): ACCEPT WITH AMENDMENT (R33-7).**
- `canonical_step_timing` keeps a row only if it carries a non-null duration or floor, or a
  non-zero `overlap_weeks` or `wait_weeks`, or a non-null `lead_weeks`.
- `canonical_step_timing_dict` and the inline `step_timing` list in
  `build_workflow_snapshot_from_input` add `wait_weeks` / `lead_weeks` **only when non-default**.
- `workflow_snapshot["categories"]` is written **only when the list differs from the seven
  defaults**. Absent means the defaults. This amends ADR 0047 §3 "every new run records", so a fresh
  run straight after p33a/p33b is byte-identical, snapshot included.
- `services/priority_preview._canonical` uses `dataclasses.asdict`, which would serialise the new
  defaults. It must use the canonical forms. Otherwise, after the deploy every preview token changes
  and a token from before the deploy no longer matches.
- Verification order: run byte-identity (input hash, fresh greedy, re-serialised stored runs I14)
  after p33a and p33b and **before** p33c, whose 4-project clearing is an intended change.

**Q8 (ADR 0047 §3, rank from data, I30): ACCEPT WITH AMENDMENT (R33-8).**
- `categories` is validated: codes unique, ranks unique integers ≥ 1, each `workflow_id` an input
  workflow, and every project's category present and of the project's workflow.
- Sort key 5 is `rank` (the value, not an index). The seeded 1..7 order equals `CATEGORY_RANK`, and
  sort keys are not output, so nothing changes.
- CAT_NOT_ALLOWED's OEM test, `whatif` and `plan_import` category lists read `workflow_id` from the
  input, not `PDD_CATEGORIES` / `OEM_CATEGORIES`.
- CP-SAT uses rank only through `ctx.ordered`. Its objective does not read category.

**Q9 (ADR 0048 §4, timing fields kept for what-if and plan import only): ACCEPT WITH AMENDMENT (R33-9).**
- For live runs, `duration_override_weeks` only carries the effort merge (pinned → None).
  `start_not_before_week` is always null, so I22 is vacuous but stays in the validator. `overlap_weeks`
  is `−plan_gap_weeks` when negative.
- The live builder passes `lead_weeks = None` whenever `plan_weeks` equals the input table. A test
  asserts that no live input row carries a `lead_weeks` equal to its table value.
- In a what-if or plan-import scenario, an edit replaces the merge at the scheduler level, where
  override beats lead. A scenario overlap drag sets `o` and clears `w` on that step, so that one
  signed value remains.

### Stage rule of ADR 0045 (question (d)) — AMEND (R33-10)
Evaluated per (project `p`, changed step `S`) on **stored** stage statuses of all 14 rows (never the
scheduler's normalised "skipped ⇒ Done"):
```
reached(p,S)    ⟺ stage(S) ∈ {In Progress, Blocked, Done}
                   ∨ ∃ t ∈ succ⁺(S) in the DAG in force: stage(t) ≠ Not Started
never(p,S)      ⟺ p.frozen ∨ p.status ∈ {Cancelled, Commercialized} ∨ reached(p,S)
automatic(p,S)  ⟺ ¬never(p,S) ∧ every stored stage of p is Not Started
choosable(p,S)  ⟺ ¬never(p,S) ∧ ¬automatic(p,S)
```
- The successor clause matters. Under the strict chain, a Not Started step behind an In Progress one
  exists only when it is skipped. Applying 0 → n there, or a length or gap, would re-time the started
  step's tail.
- The status of a skipped step is read as stored. The project status does not matter apart from the
  three `never` cases: On Hold, Draft and the four schedulable statuses all follow the stage test.
- A stored non-Not-Started stage on a skipped step makes the project "started". This happens, for
  example, when certification testing was turned off after a lab stage started.
- A category change re-copies exactly the steps with `¬reached`.
- **Locking.** At apply, the project rows of the category are taken `FOR UPDATE` in `project_id`
  order before the rule is evaluated. The stage PATCH and the check-in paths take the same project
  row lock, so no stage can cross Not Started between evaluation and write.
- A copy written on a schedulable project counts as "changed" for dispatch. Copies only on
  non-schedulable projects give `not_needed`, while demand (I25) still changes at commit.

### R33-11 / R33-12
- **R33-11 (preview honesty).** E2 lists, per project, every step whose `eff` or `g` changes. Under
  R33-2 these are exactly the changed steps. Each entry carries the flags `revived`, `skipped_now`,
  `gap_ignored_skipped` and `cert_off_no_effect`.
- **R33-12 (sequencing).** P33-T08 adds `effort_weight_weeks` to the template and
  `services.effort_split` weights. The B example acceptance stays at 7. A new test covers R33-2: on a
  project with E In Progress, an apply that changes K writes no `effort_weeks`.

### Invariants (final, testable)
- **I26 (rev.)**: for every non-frozen project with figure `x > 0` of a kind:
  - if its category has a step of that kind with `effort_weight_weeks > 0` (certification testing
    on, for lab), the stored `effort_weeks` on those steps equal the R2 apportionment of
    `E = max(1, round_half_up(x))` over `effort_weight_weeks`, raised to `max(1, ·)` on started
    steps;
  - Σ = E + the raised count, pinned steps included (shadowed);
  - other steps carry none.
- **I27 (rev.)**: in every run, every non-skipped, Not Started step of a non-frozen project that is
  not in a Blocked hold starts at or after `max(CURRENT_WEEK, gate(s), start_not_before_week)`, with
  `gate` piecewise as in R33-4 and `release`/`G` taken from the run's own rows. I3 holds unchanged
  for every step with `o(s) = 0`, including `w(s) > 0`.
- **I28**: every such step with `w(s) > 0` starts at or after `release(s) + 1 + w(s)`. No run row
  and no load or weight is derived from `w`: two inputs that differ only in `w` give identical
  `duration_weeks` on every row, identical I25 demand and identical I12 weights.
- **I29**: every run row's `duration_weeks` equals `eff(p,s)` of R33-1 on the run's input (0 and
  `skipped` exactly when `eff = 0`). The validator derives "skipped" from `lead_weeks ?? table`, not
  from the table alone.
- **I30**: for every pair of consecutive ids `a, b` in `ScheduleOutput.scheduling_order` (greedy and
  CP-SAT) that are equal on sort keys 1–4: `rank(a) ≤ rank(b)`, and equal rank implies
  `project_id(a) < project_id(b)`. Ranks come from `ScheduleInput.categories`.
  `workflow_snapshot["categories"]` equals that list when it is non-default and is absent otherwise.
- **I31 (rev.)**: an apply transaction:
  - (i) writes `plan_weeks`, `plan_gap_weeks`, `length_pinned` and `template_change_id` only on
    pairs with `¬never(p,S)` evaluated under lock (R33-10);
  - (ii) on every such pair, writes copy = the template's new value, with `length_pinned = true` when
    the length changed;
  - (iii) writes no `effort_weeks`, no progress field, and no field of a pair with `reached(p,S)`;
  - (iv) every written pair has a `project.template_applied` row naming the `template_change_id`,
    with before and after;
  - (v) the automatic pairs are applied whatever the selection mode.
- **I32 (new; only under Q3(b))**: every project step with `length_pinned = false` has
  `plan_weeks = effort_weight_weeks` of its project's category row.

### Owner-dependent points (OQ #76 / #77)
- #76(a) "relative": switch to Q3(a) with the clamp formula above. Do not assert I32.
- #76(b) "no": Q3(a), absolute. Do not assert I32.
- #77 (give a step back to its effort share): if wanted, it is a per-project unpin of not-reached
  steps under the R33-10 rule. Under R33-2 it needs no re-derivation, because the stored share is
  already there.

## Owner ruling (OQ #76/#77) — fold-in P33-T01, orchestrator, 2026-11-13

**Owner, verbatim:** "if it is manually set then use them only as the timeline". It was explained to
the owner that "manually set" means the project has its own client effort figure, from the
spreadsheet import or the Registration form's Design / Lab effort boxes. This section is binding
over §1–§3 and over R33-1, R33-3, R33-11 and I26/I31/I32 where they mention pins.

- **OR-1 — own effort, per kind.** For `k ∈ {design, lab}`:
  `ownEffort(p,k)` ⟺ some step of `p` of kind `k` carries a non-null `effort_weeks`. That is, R2
  was applied: the figure is > 0, the category has a step of kind `k` with
  `effort_weight_weeks > 0`, and, for lab, certification testing is on. Elapsed steps never have
  their own effort.

- **OR-2 — effective duration (domain level; replaces §2 and the domain reading of R33-1):**
  ```
  eff(p,s) = 0                      if kind(s) = lab and not p.certification_testing_required
           = effort_weeks(p,s) ?? 0 if ownEffort(p, kind(s))      # plan_weeks never matters here
           = plan_weeks(p,s)        otherwise                      # template copy, absolute
  skipped(p,s) ⟺ eff(p,s) = 0
  ```
  - Straight after the p33b backfill (`plan_weeks = weeks = effort_weight_weeks`) this equals
    today's `effort ?? lead` exactly: an own-effort step with weight 0 has table 0, and both rules
    give 0.
  - The user override is null for live projects (ADR 0048 CHECK). It stays a scenario-level input.

- **OR-3 — input builder mapping.** R33-1's scheduler-level formula is **unchanged**
  (`lead = lead_weeks ?? table`, `eff = override ?? lead`). The live builder maps each step:

  | Step | `lead_weeks` | `duration_override_weeks` |
  |---|---|---|
  | `ownEffort(p, kind(s))` | `effort_weight_weeks` of the category row, or None when equal to the input table's `weeks` | `effort_weeks` (as today's merge) |
  | any other step | `plan_weeks`, or None when equal to the input table's `weeks` | None |

  - The scheduler therefore sees `eff = effort_weeks` on own-effort steps (0 or null with weight 0 →
    skipped) and `eff = plan_weeks` elsewhere, which is OR-2 exactly.
  - R33-9's test (no live row carries a `lead_weeks` equal to its table value) stays. A new test
    checks that the builder's `eff` equals OR-2 on every live step.

- **OR-4 — what an apply writes.** Per pair `(p, S)` with `¬never(p,S)` under R33-10, automatic or
  selected:
  - **Gap change:** writes `plan_gap_weeks`, for every project with or without effort figures.
  - **Length change:** writes `plan_weeks` only when `¬ownEffort(p, kind(S))`. Elapsed steps and
    steps of a kind without a figure follow the template, as an absolute value.
  - **Length change with own effort:** nothing is written for that pair. The apply preview lists it
    with the flag `own_effort_length_not_applied` ("uses its own effort figure — length not
    applied"). A project whose only receivable changes are such lengths is listed in E2's
    `own_effort` section and is not offered as choosable.
  - **No effort writes:** an apply still writes no `effort_weeks` (R33-2) and never re-derives.

- **OR-5 — registration, category change, figure edits.**
  - **Registration:** copies `plan_weeks = weeks` and `plan_gap_weeks = gap_weeks` on all 14 rows.
    The effort figure, if entered, is split over `effort_weight_weeks` (R2) and governs its kind.
  - **Category change:** re-copies weeks and gaps onto `¬reached` steps (R33-10). R6 re-derives with
    the new category's weights, as today.
  - **Figure cleared** (kind `k` loses own effort; this answers OQ #77): in the same transaction,
    R6 clears the effort and the current template `weeks` are re-copied onto the `¬reached` steps of
    kind `k`. The project then follows the template. Reached steps keep their copies, as ADR 0041
    does today for a blank figure. Audit: `project.updated` carries the per-step copy before/after.
  - **Figure entered:** effort governs that kind. `plan_weeks` is kept but unused.
  - There is no separate unpin control.

- **OR-6 — simplification.**
  - `length_pinned` (project step) and `length_set` (template row) are **removed from the design**.
    Nothing ever pins over an effort figure, and a template length never needs to remember it was
    set. Q3(a) and Q3(b) are both moot, and R33-3 is superseded.
  - `effort_weight_weeks` (R33-2) stays and is essential: it keeps an own-effort project's split
    shape fixed whatever the template `weeks` become.
  - Checked against the ruling's invariants:
    - I26 rev.: "pinned steps included (shadowed)" drops out; Σ = E + raised.
    - I27, I28, I29 and I30: unchanged (scheduler level).
    - I31: the `length_pinned` write goes; (i) gains the OR-4 own-effort exclusion.
    - I32: restated below.
    - R33-4 "frozen honours lead_weeks and the pin" reads "honours lead_weeks and the effort merge".
    - R33-11 flags gain `own_effort_length_not_applied`.
    - R33-12: the B example is now "a B project with design figure 4 keeps A1 E2 K1 when B/E goes
      4 → 5; a B project without a figure goes E 4 → 5".

- **Load.** Per own-effort kind, load = `E + raised`, untouched by any template. Per other kind, and
  for elapsed steps, load = Σ `plan_weeks` of the non-skipped steps. Demand (I25) moves at commit,
  booked loads after the run.

### Invariants (final, superseding the ruling's I26/I31/I32 text where they differ)

- **I26 (rev.)**: as in the ruling, without the pinned clause. Σ = E + the raised count.
- **I31 (rev.)**: an apply transaction:
  - (i) writes `plan_gap_weeks` and `template_change_id` only on pairs `¬never(p,S)` evaluated under
    lock, and writes `plan_weeks` only on such pairs with `¬ownEffort(p, kind(S))`;
  - (ii) every written value equals the template's new value;
  - (iii) it writes no `effort_weeks`, no progress field, and nothing on a pair with `reached(p,S)`;
  - (iv) every written pair has a `project.template_applied` row naming the `template_change_id`,
    with before and after;
  - (v) automatic pairs are applied whatever the selection mode.
- **I32 (restated)**:
  - (i) after an apply, every pair whose length was written has `plan_weeks` = the template's new
    `weeks`;
  - (ii) for every step `s` with `¬ownEffort(p, kind(s))`, `eff = plan_weeks` (or 0 for lab with
    certification off);
  - (iii) for every step with `ownEffort(p, kind(s))`, `eff = effort_weeks ?? 0`. Two inputs that
    differ only in those steps' `plan_weeks` or in the template `weeks` give identical runs.

## Amendment (2026-11-24) — ADR 0070: a step revived from 0 weeks joins the effort split

Owner decision "Split the figure", in full in ADR 0070. Summary:

- **R33-2:** a template apply that sets a step's `weeks` from 0 to N > 0 while its
  `effort_weight_weeks` is 0 also sets the weight to N. Every other weight stays immutable. Migration
  `p70a` lets the trigger accept exactly this change.
- **OR-4:** a received own-effort pair of such a step gets the copy `plan_weeks = N`, and its
  project's effort is re-derived (R6, trigger `template_revive`). The pair is refused, and keeps
  `own_effort_length_not_applied`, when the re-split would change a reached step's share or R7 rejects it.
- **I26:** a Not Started, share-less, weighted, not-excluded step of an own-effort kind whose copy is 0
  is held out of S′. This makes the revive stick only to the projects that received it.
- **OR-3:** an own-effort step with no share maps to `lead_weeks = 0`.
- **One-time catch-up:** `POST /workflow-templates/sync-effort-weights` (Super Admin; dry run / apply).
