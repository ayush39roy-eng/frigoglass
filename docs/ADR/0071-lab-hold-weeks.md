# ADR 0071 — Lab hold weeks: a lab step may hold its chamber for fewer weeks than its length

- **Status:** **Accepted** (2026-11-25, P62-T02). Workflow-auditor ruling P62-T01 (PASS with
  amendments, MEMORY "[2026-11-25] P62-T01") and the owner's answers of 2026-11-25 to Q1 / Q2 /
  leader / room week are folded in. **The binding text is "Ruling (binding) — R62-0 … R62-13"
  below**; where it differs from the proposal in §1–§10, the ruling wins. DOMAIN_RULES "Lab hold
  weeks" carries the same rules and invariants I64–I67.
- **Amends:** DOMAIN_RULES "Booking rules" (lab step, skipped step), "Lead times" (C/PDD-J, the
  skip predicate), "Per-project effort" (R2 S′, R7 certification off), "Category templates" §A–§C,
  "Derived remaining duration" / "How progress feeds a schedule run" (lab tails), "Load basis"
  (lab load), I2, I4, I7, I25 (lab half), and the "Manual step weeks" lab pin rule (ADR 0054).
- **Does not change:** design or elapsed booking, step lengths, precedence, gaps, the critical path,
  completion weeks of any project whose lab steps all hold their full length.

## Context

- On 2026-11-22 a Super Admin set PDD-J "Pre-Production (Pr. Pr)" and PDD-L "Pilot" to kind `lab` on
  Workflow Settings (MEMORY 2026-11-23 "P58 hosted fix"). DOMAIN_RULES' step table still says
  J = `design`, L = `elapsed` (seed values); the hosted settings now differ.
- A `lab` step books one chamber platform for **every** week of its length (DOMAIN_RULES "Booking
  rules", 1.0 platform-week per project-week).
- Hosted run v319 (2026-11-25): in India, PDD-J / PDD-L could book only IN-CH4 (`max_concurrent` 1).
  About 107 India J/L bookings queued one at a time. Example: "Extra shelf for Coke Feasibility"
  (26-00391, cat C, P2, leader Nikhil) had J at week 132 (2028), finish week 134, with Nikhil idle
  from week 72 to week 132.
- Template lengths (PDD), weeks:

  | Cat | F | H | J | L |
  |---|---|---|---|---|
  | A+ | 6 | 6 | 1 | 3 |
  | A | 4 | 6 | 1 | 3 |
  | B | 3 | 4 | 1 | 1 |
  | C | 0 | 0 | 1 | 0 |

- **Owner ruling (2026-11-25, verbatim):** "FOR PR. Pr and pilot are in lab but they only use logic
  for 1 week not for all and like C type didnt even use so do accordingly coz the lab time for both
  these steps is not equal to there timing". Clarified: the room week is **the LAST week** of the
  step.
- Elapsed steps (Marketing Brief, Business Case, CAPEX, Commercialization) book nothing. Correct,
  unchanged.

## Ruling (binding) — R62-0 … R62-13 *(2026-11-25, P62-T01 ruling + owner answers, folded at P62-T02)*

**Owner answers, 2026-11-25 (verbatim):**

- Q1 (own lab figure): "Only PoC + Certification".
- Q2 (certification off): "c doesnt have else have".
- Leader for Pr. Pr: "Room only".
- Room week: the LAST week of the step (unchanged).

**Reading of the Q2 answer (an orchestrator interpretation of the owner's words, recorded as
such):** category C projects have no Pr. Pr and no Pilot at all, so PDD-J and PDD-L are skipped for
C. Every other category always has Pr. Pr and Pilot, whether or not certification testing is
required. Certification-off still skips only PoC (F) and Certification (H). This supersedes the
proposal's "C hold 0" for J/L: a C project does not hold J for zero room weeks, it skips J entirely
(R62-11). If the owner meant something else, R62-2 / R62-11 are separable and can be reverted
without touching R62-0.

Predicate used below:

```
partialRoom(p,s) ⟺ kind(s) = lab ∧ plan_lab_hold_weeks(p,s) IS NOT NULL
```

With the approved defaults, `partialRoom` is exactly PDD-J and PDD-L in every PDD category, and
nothing else. The rules are written on the predicate (the auditor's form), not on step ids. The
consequence: setting a hold on PoC / Certification, or setting J / L back to "Full", moves that
step into / out of the lab split and the certification-off skip. The template editor must say so
(R62-1 UI text). OQ #125 asks the owner whether that coupling is acceptable.

- **R62-0 (base rule).** `hold(p,s) = plan_lab_hold_weeks(p,s) ?? eff(p,s)` (NULL = the full
  length). On a booked interval of `n` weeks, `h = min(hold, n)`. The chamber is held for the
  **last `h` weeks** of the interval only; the earlier `n − h` weeks book nothing. The step still
  occupies all `n` weeks on the project's path. Defaults: PDD-J and PDD-L hold **1** for A+, A and
  B; **0** for C (where both have length 0, R62-11); OEM-J/L only if `lab` at migration time
  (hosted: they are not, so NULL); everything else NULL.
- **R62-1 (Q1, owner-confirmed "Only PoC + Certification").** A `partialRoom` step is outside the
  lab S′ (like a held-back step, §G): no lab-figure share, `effort_weeks` NULL,
  `eff = user_override ?? plan_weeks`. A project's own lab figure is split over the remaining lab
  steps (PoC, Certification), as the client computes it. Enforced by an R6 re-derivation (trigger
  `lab_hold_default`, audit `project.effort_rederived`, stale, no run), with the same scope and
  rules as the 2026-11-22 step-kind re-derivation that created the current shares: every
  non-frozen project with a figure, R3 raises, ADR 0070 hold-back still applies, **no
  `started_share` refusal**. UI text on a lab step with a room-weeks value: "Room weeks set: length
  from the template, not the lab figure". J's old design share is not given back (J is no longer
  design).
- **R62-2 (Q2, owner-confirmed, interpreted above).** The certification-off skip applies to
  full-room lab steps only:
  `eff(p,s) = 0 if kind(s) = lab ∧ ¬p.certification_testing_required ∧ ¬partialRoom(p,s)`.
  R7's `certification_off` likewise covers the full-room lab steps only. Pr. Pr and Pilot run
  whether or not certification testing is required (A+, A, B).
- **R62-3 (Q3).** NULL = full length, and follows length edits. An explicit integer equal to the
  length is stored as given, not normalised to NULL (so the step is `partialRoom`).
- **R62-4 (Q4).** `h = 0` means no chamber is needed or booked, `chamber_id` is NULL and I4 is
  vacuous. The zero-eligible-chamber exits fire only when `h > 0`: greedy `no_chamber`, CP-SAT
  "zero eligible chamber → greedy LEFT_OUT", and What-if / plan import P58-A "lab step without a
  chamber".
- **R62-5 (Q5).** The room is one chamber, for the last `h` weeks, contiguous.
  - Greedy: the earliest `w` ≥ floor with one eligible chamber (chamber_id order) free in
    `[w+n−h, w+n)`.
  - CP-SAT: keeps `[s, s+n)` and adds one optional fixed-size-`h` occupancy interval at `s+n−h`
    per eligible chamber, exactly one present. The cumulative runs over occupancy intervals only.
  - Frozen: `eligible[0]` over the last `h` weeks; `h = 0` books nothing.
  - `cp_sat._book_solved_placements` and any prebooked / `consume_from` path book hold weeks only
    (added to the §8 reader list).
- **R62-6 (Q6).** Progress weights (I12) stay on `eff`.
- **R62-7 (Q7).** Hold copies are backfilled for every project, including reached, frozen,
  Cancelled and Commercialized ones. The R62-1 re-derivation runs in the same migration
  transaction, after the backfill (the backfill is what makes J/L `partialRoom`).
- **R62-8 (Q8).** The apply writes `plan_lab_hold_weeks` on `¬never` pairs, whatever ownEffort
  says. A hold change that flips NULL ↔ non-NULL on an own-lab-figure pair triggers the R62-1
  re-derivation for that project, with the same `started_share` treatment.
- **R62-9 (Q9).** What-if added projects and plan-import file projects take the hold (and the
  C/PDD-J length, R62-11) from their category template. R62-1 / R62-2 apply to them identically
  (I58 parity).
- **R62-10 (Q10).** Chamber supply is unchanged; booked % = Σ h / supply. The BUG-2 windowing
  (What-if before-load, full-year / remaining) counts the actual held weeks inside the window, not a
  pro-rata share of `n`.
- **R62-11 (Q2, C has no Pr. Pr / Pilot; supersedes §2 "C hold 0" for J/L).**
  - Template C/PDD-J `weeks` 1 → 0 (C/PDD-L is already 0), and C/PDD-J / C/PDD-L
    `lab_hold_weeks` = 0. Both are therefore `partialRoom` with `plan_weeks` 0, so skipped. They
    are not lab-split, and an override never revives a 0-length step.
  - The length change reaches project copies through the P33 §C rules on `¬never` pairs, written in
    the p71a migration (audits `workflow_template.applied` with reason `p62_c_no_pr_pr` /
    `project.template_applied`, stale, no run).
  - A C project whose J or L is reached (In Progress / Blocked / Done, or a later stage started),
    frozen, Cancelled or Commercialized keeps its copy. Recorded work is never erased.
  - `effort_weight_weeks` stays immutable (C/PDD-J keeps weight 1; unread while J is
    `partialRoom`).
  - Owner approval for this business-row change: the Q2 answer of 2026-11-25, for C/PDD-J /
    C/PDD-L only.
- **R62-12 (consistency, needed by R62-1 / R62-11).** A length change on a `partialRoom` step
  reaches `plan_weeks` on `¬never` pairs **whatever ownEffort** says, because that step is outside
  the split. The `own_effort_length_not_applied` flag never applies to it. Without this, a C project
  with its own lab figure would keep J at 1 week.
- **R62-13 (leader, owner "Room only").** Pr. Pr (and Pilot) book the room only, never the leader
  (kind `lab`). The design split is not re-widened to J.
- **Started / pinned / Done / Monte Carlo (§6):** as proposed.

**Invariants:** I64–I66 as tightened at P62-T01; I67 added. Exact text in DOMAIN_RULES "Lab hold
weeks". I67 is consistent with R62-11: C/PDD-J / C/PDD-L are `partialRoom` and skipped by their
0 length, never by the certification-off predicate.

**Hosted effect (to be measured at P62-T06):**

- R62-1: 76 projects reshaped, and 35 regain Pr. Pr / Pilot.
- R62-2: of the 60 certification-off projects, the 36 B ones regain J/L. The 24 C ones do not
  (R62-11).
- R62-11: C projects lose a not-reached J. For example, 26-00391 J at week 73 goes and the project
  finishes earlier.
- R62-0 / R62-4: J/L hold 1 room week.

Goldens stay byte-identical with all holds NULL; new goldens are needed.

## Decision (as proposed; superseded where the Ruling above differs)

### 1. The value

- New per-category, per-step template value `lab_hold_weeks` on `workflow_lead_times`: integer,
  `0..weeks`, **nullable; NULL = "the full length"** (follows `weeks` when the length changes).
- It is meaningful only on `lab`-kind steps. On a design / elapsed step it is ignored (and the API
  rejects a non-null value there, 422 `LAB_HOLD_NOT_LAB`). If a step's kind changes away from `lab`
  the stored value is kept but unread; back to `lab`, it applies again.
- Per-project copy `project_workflow_steps.plan_lab_hold_weeks` (same domain, NULL = full), copied
  at registration and on a category change like `plan_weeks`, and reached only through the P33 apply
  (§4).
- **Effective hold** of project `p`, step `s`, on a booked interval of `n` weeks:

  ```
  hold(p,s)   = plan_lab_hold_weeks(p,s) ?? eff(p,s)       # NULL = full length
  h(p,s,n)    = min(hold(p,s), n)                           # never more than the booked interval
  chamber weeks = the LAST h weeks of the booked interval; the earlier n − h weeks book nothing
  ```

  The step still occupies its full calendar span on the project's path (successors wait for its
  end). Only the room booking shrinks.

### 2. Defaults (migration)

- Every existing row: NULL (full length). So F/H and every golden file, input hash, fresh and stored
  run stay byte-identical.
- PDD-J and PDD-L: `lab_hold_weeks = 1` for A+, A and B; `0` for C (owner: "C type didnt even use").
  C/PDD-L has length 0 and is skipped anyway; C/PDD-J (length 1) holds no room.
  *(Superseded by R62-11: C/PDD-J length becomes 0, so C skips J and L entirely.)*
- OEM-J / OEM-L: same rule **only if** their kind is `lab` on the target database at migration time
  (A-OEM / B-OEM 1, C-OEM 0). OEM-L is 0 weeks in every OEM category and C-OEM/OEM-J is 0, so only
  A-OEM / B-OEM OEM-J could matter.
- Per-project copies: backfilled from the template for every project (p33b precedent), audited
  (`project.lab_hold_backfilled`, one per project), `schedule_stale` on every schedulable project.
  No run is dispatched (manual recalculation, ADR 0069).
- **Hosted-data rule.** Setting J/L/C values changes existing business rows. The owner's 2026-11-25
  ruling above is the approval for exactly these defaults (J/L hold 1, C hold 0) on template rows
  and project copies. Anything beyond that (other steps, other categories) needs a new owner
  approval.

### 3. Editing

- Workflow Settings → Workflow templates (Timeline previews / template editor, P33) and the P52
  Matrix: a "Room weeks" control next to the step length on `lab` steps, 0..length, "Full" = NULL.
- Admin and Super Admin, like P33 lengths. Saves through the one P33 apply.

### 4. Apply (P33 §C rules)

- A `lab_hold_weeks` change is a third kind of template change, alongside length and gap.
- It reaches project `p`'s step `S` only on `¬never(p,S)` pairs (automatic, or chosen), exactly as a
  length change does, writing `plan_lab_hold_weeks`.
- It is written **whatever ownEffort** says. The figure sets the length, the template sets the room
  share, and `h` clamps to the length.
- Reached / frozen / Cancelled / Commercialized pairs keep their copy. One transaction, audits
  `workflow_template.applied` / `project.template_applied` gain `lab_hold_weeks [before, after]`.
- An apply that changes only holds marks stale; it dispatches nothing (manual mode).

### 5. Own-effort projects

- An own-effort lab figure split by `effort_weight_weeks` sets the step length `eff`; the hold is
  `min(hold, eff)`. Example: B lab 10 split over F, H, J, L by weights 3:4:1:1 puts some weeks on
  J/L. J then holds 1 room week however long its share is.
- ~~**Open (Q1):**~~ Resolved by R62-1: J/L (`partialRoom`) are outside the lab-figure split.

### 6. Started steps, pins, frozen, Monte Carlo

- **In Progress / Blocked tail** of `remaining_span` weeks: the chamber is held for the last
  `min(hold, remaining)` weeks of the tail. The step's past weeks book nothing (unchanged).
- **Blocked hold:** books nothing (unchanged).
- **Done step:** the chamber weeks are the last `min(hold, actual length)` weeks of
  `[actual_start .. actual_end]`; only those at or after `CURRENT_WEEK` consume capacity.
- **Pinned lab step (ADR 0054):** the last `h` weeks of the pinned window, same chamber choice and
  OVERLAP rule as today.
- **Frozen:** the last `h` weeks of the locked window; OVERLAP as today.
- **Monte Carlo:** a sampled length `d` → `h = min(hold, d)`. The hold is never sampled.
- **`h = 0`:** the step books no chamber and needs none. `chamber_id` is null, I4 is vacuous for
  it, and a region with no chamber listing the step does **not** make it `no_chamber` / LEFT_OUT.
  It still occupies its calendar weeks. **Open (Q4).**

### 7. Scheduler

- **Greedy.** For a lab step of length `n` and hold `h > 0`, the earliest start `w` ≥ the step's
  floor such that one eligible chamber (chamber_id order, as today) is free in
  `[w + n − h, w + n)`. One chamber for the whole hold window (no chamber switch inside it).
- **CP-SAT parity.** The step keeps its interval `[s, s + n)`. The chamber occupancy is a second
  interval of fixed size `h`, starting at `s + n − h`, optional per eligible chamber, with exactly one
  presence true. The per-chamber cumulative (capacity `max_concurrent`, demand 1) runs over these
  occupancy intervals only. `h = 0`: no presence literals. Objective unchanged.
- **Run rows.** `schedule_run_project_steps` gains nullable `lab_hold_weeks` (the `h` booked; NULL on
  non-lab rows and on rows written before this ADR, read as full length), so stored runs keep
  meaning what they meant.
- **Input / hash.** `StepInput.lab_hold_weeks` (None = full). The canonical input and the snapshot
  omit None (R33-7 style), so all-NULL input hashes are unchanged.

### 8. Readers of "lab weeks" — must count hold weeks, not step length

Lab **load** (room occupancy) becomes `h`; lab **calendar** stays `n`. Each reader below is checked
and moved to `h` where it means room load:

| Reader | Today reads | After |
|---|---|---|
| `scheduling/greedy.py` chamber booking, `chamber_busy` | every week of the step | hold weeks only |
| `scheduling/cp_sat.py` chamber cumulative | step interval | occupancy interval |
| `scheduling/invariants.py` I2, I4, I7 (+ `_selftest_*`) | Σ duration | Σ h; occupancy weeks |
| `scheduling/demand.py` `compute_demand_load` (I25 full-year / remaining lab demand; `rem`) | Σ eff / rem | Σ min(hold, eff) / min(hold, rem) |
| `scheduling/whatif.py`, `services/whatif.py`, `services/whatif_chat.py` (before/after lab load, utilisation windowing BUG-2) | duration | h |
| `scheduling/plan_import.py`, `services/whatif_import_register.py` | duration | h (+ hold read from the template for file projects) |
| `scheduling/template_timeline.py`, `services/workflow_previews.py` (preview bars, D/L totals) | length | length for the bar, held weeks marked; L total = Σ h |
| `api/routers/capacity.py`, `services/capacity_priority.py` (lab load by priority, booked %, gap, completion %) | Σ duration | Σ h |
| `api/routers/chambers.py` (chamber utilisation / weekly occupancy) | weeks of the row | hold weeks |
| `api/routers/dashboard.py` lab KPIs / any capacity card | served fields | served fields (follow) |
| `api/routers/gantt.py` per-project `lab_weeks`, step rows | Σ eff | Σ h; step rows gain `lab_hold_weeks` / held-week range |
| `api/routers/planning.py`, `api/routers/priority_board.py`, `services/project_cards.py` | Σ lab eff | Σ h |
| `services/register_export.py`, `services/xlsx_writer.py`, `services/whatif_export.py` (exports) | lab duration | room weeks column = h; length unchanged |
| `services/workspace.py` progress weights (I12) | eff | **unchanged** (progress is about the step, not the room) — confirm (Q6) |
| `services/capacity_supply.py` | supply only | unchanged |

The backend-builder confirms this list by grep at P62-T04; any reader found later is a bug against
I66.

### 9. Invariants (proposed)

- **I64 (lab occupancy):** for every non-skipped `lab` row with booked interval of `n` weeks and
  `h = min(hold, n)`, the row's chamber occupancy is exactly its last `h` weeks; it occupies no
  chamber in any other week. I2 counts occupancy weeks only. `h = 0` ⟺ `chamber_id` null.
- **I65 (hold domain):** `0 ≤ lab_hold_weeks ≤ weeks` on every template row and
  `0 ≤ plan_lab_hold_weeks ≤ plan_weeks` on every copy (DB CHECKs; NULL allowed); a run row's
  `lab_hold_weeks ≤ duration_weeks`. Non-lab template rows carry NULL (API).
- **I66 (lab load = hold):** I7 rev.: booked lab load per region = Σ `h` over the active run's
  non-skipped lab rows (NULL = `duration_weeks`), equal to the served `lab_load_booked_weeks` and to
  Σ Gantt per-project `lab_weeks`. I25's lab half uses `min(hold, eff)` / `min(hold, rem)`.
- **I8 / I14:** with every hold NULL, every golden file, hash and stored run is byte-identical.

### 10. Migration

- `p71a_lab_hold_weeks`: additive nullable columns on `workflow_lead_times`,
  `project_workflow_steps`, `schedule_run_project_steps`; CHECKs per I65.
- Data: only the J/L defaults of §2 (template + copies), audited. No rewrite of any other business
  row. Downgrade drops the columns (audits stay).
- Ships with the code; then a Super Admin presses Recalculate.

## Consequences

- India J/L no longer queue on IN-CH4 for their whole length: A+/A L holds 1 week instead of 3,
  C/J holds none. Within-year counts should rise (measured at P62-T06).
- The hosted IN-CH1..3 change of 2026-11-25 (J/L added) adds India room for J/L independently of
  this ADR.
- Lab load figures on Capacity drop by the non-held J/L weeks.

## Questions for the workflow-auditor (P62-T01) — all answered; see the Ruling (R62-1 … R62-10)

1. **Lab-figure split.** Since J/L became `lab`, a project's own lab figure (`lab_effort_weeks`,
   the client's F + H pivot, P51-T03) is split over F, H, J **and** L by weight. The design figure no
   longer includes J. Should J/L (a) stay in the lab split (status quo since 2026-11-22), or (b) be
   excluded from it and take their template `plan_weeks`, so the figure stays F + H as the client
   computes it? Proposal: (b), via "a lab step with a non-NULL hold below its weight is outside S′".
   Owner decision if the auditor cannot settle it from the record. Also: did the 2026-11-22 kind edit
   trigger R6 re-derivation on hosted, i.e. are lab splits already reshaped?
2. **Certification off.** `certification_testing_required = false` skips **every** lab step, so since
   2026-11-22 it also skips Pr. Pr and Pilot. Should the skip apply only to F/H (e.g. to lab steps
   with a full hold)? Owner decision likely.
3. **NULL = full** vs a stored integer default. Proposal NULL (byte-identical, follows length edits).
4. **`h = 0`**: no chamber needed, never `no_chamber`, `chamber_id` null. Agree?
5. **Last weeks, contiguous, one chamber.** Agree that the hold window cannot be split across
   chambers or non-contiguous weeks?
6. **Progress weights (I12)** stay on `eff` (length), not `h`. Agree?
7. **Backfill scope**: project copies for every project including reached / frozen (new field,
   p33b precedent), or only `¬never` pairs? Proposal: all, since the owner approved the defaults
   globally, and holding fewer weeks never adds a conflict.
8. **Apply on own-effort pairs:** hold written whatever ownEffort (§4). Agree?
9. **What-if added projects / plan-import file projects** take the hold from the template of their
   category. Agree?
10. **Supply.** Chamber supply (efficient lab weeks) is unchanged; booked % falls with the load.
    Agree that is the intended reading?
