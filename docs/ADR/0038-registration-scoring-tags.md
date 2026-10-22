# ADR 0038: Registration "project nature" tags pre-fill dimension scores

## Status

Accepted (2026-10-22). Part of P27 (P27-T01 backend, P27-T02 frontend). Amends
`docs/DOMAIN_RULES.md` "Prioritization scoring". Keeps the points formula, the bands, ADR 0033
(scores 0..5), ADR 0036 (P1 capacity fill) and ADR 0037 (editable rubric) unchanged. Does not
change scheduling.

## Context

Owner request, 2026-10-22: "if the project while registering we know whether it is a New Customer,
Strategic Project, New Options, Regulatory Compliance / business Compliance, New Models,
improvement … the scoring for them is given full for that project, example if a new option
project then it should get full 25 points in new option score and then other score will be
changed [manually]".

Owner answers to the orchestrator's questions (2026-10-22):
1. Capture: a **multi-select** of tags at Registration (any combination). The existing single
   `type` field (NM/CO/RC/NO/IMP) stays as it is.
2. A tag **pre-fills** the score with 5; the score stays **editable** in the Matrix / Workspace.
3. Dimensions a project is not tagged with are scored manually as before (not forced to 0).
4. Existing projects are **backfilled from their current `type`**.

## Decision

1. **Tags.** `Project.scoring_tags` is a set of zero or more of six fixed values. Each maps to one
   rubric dimension by its stable key (ADR 0037):

   | Tag (wire value) | Label | Dimension key |
   |---|---|---|
   | `new_customer` | New Customer | `new_customer` |
   | `strategic_project` | Strategic Project | `strategic_project` |
   | `new_options` | New Options | `new_options` |
   | `regulatory_compliance` | Regulatory / Business Compliance | `regulatory_compliance` |
   | `new_models` | New Models | `new_models` |
   | `improvement` | Improvement | `quality_improvements` |

   The mapping is by dimension key, not label, so an Admin renaming a dimension does not break it.
2. **Pre-fill rule.** When a tag goes from *not set* to *set* (on create or on an edit), that
   dimension's score is written as **5** in the same transaction, creating the project's score
   row if it has none, and the score is recomputed (normalised %, band, missing dimensions).
   Re-saving a tag that was already set does **not** rewrite the score, so a manual change
   survives later edits of other Registration fields. Removing a tag leaves the score unchanged.
3. **Editable.** The pre-filled 5 is an ordinary score: anyone who may edit scores may change it.
   Tag-driven score writes are audited like other score writes, with the source recorded as the
   registration tag.
4. **Inactive dimensions.** If an Admin has deactivated the mapped dimension, the score is still
   written; it counts again if the dimension is reactivated (ADR 0037 rules).
5. **Who may set tags.** Whoever may edit the project's Registration fields. The pre-fill is a
   consequence of that edit.
6. **Backfill** (data migration). For every existing project: `type` NM → `new_models`, NO →
   `new_options`, RC → `regulatory_compliance`, IMP → `improvement`; CO, BC, AC, SER and null get no
   tag. For each tag added, the mapped dimension's score is set to 5 and the project's score is
   recomputed. No project gets New Customer or Strategic Project from the backfill (no source).
7. **Schedule.** Unchanged. The scheduler does not read scores; nothing is marked stale. The
   committed `Project.priority` is never rewritten; only the score and the suggested band move.

## Consequences

- Existing (synthetic, OQ #56) scores change for every NM/NO/RC/IMP project, so normalised % and
  suggested bands (including the P1 capacity fill) can move. The migration reports the count of
  projects whose suggested band changed.
- New Customer and Strategic Project start empty for existing projects until someone ticks them.

## Amendment 2026-10-22 — the client's `BC` type is the Regulatory / Business Compliance type

Owner ruling: "the regulatory compliance projects are not coming because it is not named
correctly — search for Business Continuation / Business Continuity". The client's project sheet
codes these projects `BC` ("Business Continuity", header row 1 of `2024-25-26 Projects` and
`Lists & Explanations`); the app's `RC` code came from the prototype and matches no client row.
Decision (implemented in P29-T01):
- Workbook type `BC` (and the text variants "Business Continuity", "Business Continiuty",
  "Business Continuation") maps to app type `RC`. The raw code stays in `excel_type`.
- `RC` is labelled **"Regulatory / Business Compliance"** everywhere (API, Registration, filters,
  Dashboard By Type).
- Existing projects whose `excel_type` is `BC` become `RC`, receive the `regulatory_compliance`
  tag and the §2 pre-fill (score 5 on `regulatory_compliance`) in the same migration, audited
  with source `registration_tag_backfill`.
- `AC` (Alternative Component) and `SER` (Service) stay unmapped pending the data reconciliation
  (`docs/DATA_RECONCILIATION_2026.md`).

