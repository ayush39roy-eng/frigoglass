# API contract — P58-A: What-if does the real scheduling; no silent lab step without a chamber

Owner, 2026-11-23: "they used the what if planner and it is not working right, when they are just
adding 5 projects it is giving some unplaced … what if should use correct logic and do the real
future scheduling".

Root cause on hosted (run v217, week 48): on 2026-11-22 PDD-J and PDD-L were set to kind `lab` in
the Effort matrix. No chamber lists either step in `allowed_stages`, so every PDD project that still
has to pass J or L is LEFT_OUT `no_chamber` in the live run, and so is every What-if project added.
The What-if engine was right; the data made those steps impossible to book.

## 1. `PUT /workflow-settings/steps/{workflow_id}` — a lab step must have a chamber

Request (`StepsUpdateRequest`) gains two optional, mutually exclusive fields:

| Field | Type | Meaning |
|---|---|---|
| `add_to_chambers` | `uuid[]` (1–100) or omitted | These chambers accept every lab step of this workflow that no chamber lists. |
| `add_to_chambers_like` | `string` (a step id, e.g. `"PDD-H"`) or omitted | The same, onto every chamber that already lists this step. |

Both given → 422 (validation).

Rules, checked after the existing precedence / `KIND_IN_USE` checks:

- A step that becomes `lab` (it was `design` / `elapsed`) while no chamber lists it, and neither field
  is given → **409 `LAB_STEP_HAS_NO_CHAMBER`**. Body:
  `{"code": "LAB_STEP_HAS_NO_CHAMBER", "detail": "<text naming the steps>", "steps": ["PDD-J", ...]}`.
  Nothing is written.
- With either field, every proposed lab step of this workflow that no chamber lists (the newly lab
  ones and any left uncovered by an earlier save, e.g. the hosted PDD-J/PDD-L) is appended to the
  target chambers' `allowed_stages`, in the same transaction as the step save.
  - `add_to_chambers` naming an unknown chamber → 422 `UNKNOWN_CHAMBER`.
  - `add_to_chambers_like` naming a step no chamber lists → 422 `UNKNOWN_LIKE_STEP`.
  - A chamber that already lists the step is left as it is.
- A lab step that was already lab and uncovered does not block a save on its own (it predates this
  rule). The same save with either field repairs it.
- Lab region is not checked: the request decides which chambers (and so which regions) take the step.

Audit: one `workflow_settings.chamber_allowed_stages_add` row per changed chamber (entity `Chamber`,
full before / after chamber state, `added_stages`, `via`, `workflow_id`), and the
`workflow_settings.steps_update` row's `after_state.chamber_stages_added = {chamber_code: [steps]}`.
The response is the usual `WorkflowSettings` payload with `X-Schedule-Stale-Count`.

Suggested UI (Effort matrix "Apply to App", Resource row): on 409 show "No chamber accepts PDD-J.
Projects reaching it cannot be scheduled. Run it on the same chambers as [PDD-H ▾]?" and retry the
same body with `add_to_chambers_like`, or offer the chamber list for `add_to_chambers`.

## 2. What-if results: why a project was not placed

`ProjectResultOut` (in `POST /whatif/simulate` → `projects[]`, and `POST /whatif/solve` →
`achieved.projects[]`) gains three fields:

| Field | Type | Meaning |
|---|---|---|
| `left_out_reason` | `"no_leader" \| "no_chamber" \| "data_error" \| "beyond_horizon" \| null` | Same values and derivation as the live run (I58). `null` when placed. |
| `left_out_reason_label` | `string \| null` | The reason in words: "No leader assigned", "No lab chamber accepts step PDD-J", "Data error — check the project setup", "Cannot be scheduled within 5 years — check resources". `null` when placed. |
| `no_chamber_step_id` | `string \| null` | The lab step no chamber accepts (with `no_chamber`), else `null`. |

## 3. What-if outcome classes = the Dashboard's buckets (I9, I58)

`outcome_counts_before` / `outcome_counts_after`, each project's `outcome`, and
`diff.*[].before_outcome` / `after_outcome` now use the Dashboard's bucket precedence
(`services.outcome_buckets.outcome_bucket`: not scheduled > queued > blocked > within year >
spillover > left out). Two differences from before:

- A Commercialized project delivered in the plan year was served `excluded`; it is now
  `within_year` (it is in the Dashboard's within-year count, R53-2b). This was the hosted mismatch
  (within_year 27 / excluded 134 vs Dashboard 95 / 66).
- A blocked project the engine also left out is `blocked` (was `left_out`).

So for an unchanged plan: `outcome_counts_before[k]` equals the Dashboard's `{k}_count` for
`within_year`, `spillover`, `left_out`, `blocked`, `queued`, `not_scheduled_priority`, and
`excluded + data_error` equals the Dashboard's `excluded_count`.

Frontend: the What-if note "Counted by outcome class … can be higher, because it also counts
commercialized projects" is no longer true and should go. The planner export Summary now shows
"of which Delivered (Commercialized) — counts as within year" under "Within year".

## 4. What-if is the live scheduling (verified, unchanged)

The What-if baseline is built by the same `build_schedule_input_from_db` as the live run (worker,
recalc): current week = the request's plan clock, search limit = week + N × 52 (Admin setting),
P1–P3 scheduled to completion, frozen / in-progress projects from their recorded stages, locked
(frozen) bookings, P56 incomplete projects left out. It runs the same greedy engine
(`run_greedy_sgs`) on a copy with the scenario applied. Added projects have no earliest start, so they
are placed from the current week. Tests: `backend/tests/test_p58_whatif_real_scheduling.py`.
