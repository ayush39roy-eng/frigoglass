# ADR 0036: P1 capacity fill of the suggested band

## Status

Accepted (2026-10-21). Part of P25 (P25-T01 backend, P25-T02 frontend label). Amends
`docs/DOMAIN_RULES.md` "Prioritization scoring" (bands) with a capacity-based promotion of the
**suggested** band only. Scores, the score bands, hard gates, committed priorities and the
scheduler are unchanged.

## Context

Owner ruling, 2026-10-21: "P1 for score ≥ 70 is right, but if capacity is not full, add projects to
P1 until capacity is full." The owner accepted these details:

- (a) per hub, against **design** capacity;
- (b) "full" = the P1 projects' design load reaches 100 % of the hub's remaining-year design
  capacity, with the Capacity page's capacity and load definitions (effort weeks, ADR 0032);
- (c) projects scoring below 70 are promoted in descending score order, stopping at the first one
  that would push the hub over 100 %;
- (d) only the SUGGESTED band changes, shown as "P1 (capacity fill)". The committed priority stays
  a human decision on the Priority board.

## Decision

1. **Per hub, inputs.**
   - `C` = the hub's remaining-year design capacity, the figure `GET /capacity/hub-load` serves as
     `design_capacity_remaining` (ADR 0008: `((52 − CURRENT_WEEK) − deduction × remaining_fraction)
     × Σ fte`, on the hub's calendar, 2 dp). The same helpers compute both, and a test pins them
     equal.
   - Base P1 set = the hub's scored projects with `normalized_pct ≥ 70`, i.e. the existing score
     band P1, whatever their status.
   - A project's load = its remaining design effort in the **active run**
     (`services.capacity_priority.remaining_run_load_by_project`: non-skipped, not-Done design rows,
     the part at or after the run's `current_week`, in effort weeks per ADR 0032). A project not in
     the run counts 0.
   - Base load `L` = Σ load over the base P1 set.
2. **Walk.** If `C > 0` and `L < C`, the candidates are the hub's scored projects with
   `normalized_pct < 70` whose live status is schedulable (not Commercialized, Cancelled, On Hold or
   Draft; DOMAIN_RULES booking rules). They are walked in a fixed order: **`normalized_pct`
   descending, then `project_id` ascending** (canonical lowercase UUID string). For each:
   - load 0: **skipped** (not promoted, the walk continues). It uses no capacity, so promoting it
     would not "fill" anything, and the label would be misleading;
   - `L + load ≤ C`: **promoted** to P1 (capacity fill), `L += load`. Reaching exactly 100 % is
     allowed;
   - otherwise: **stop**. Later candidates are not considered, even if a smaller one would fit
     (owner rule (c)).

   If `L ≥ C` (full or overfull), `C = 0`, or there is no active run, nothing is promoted. All
   arithmetic is exact 2 dp decimal.
3. Projects that are not promoted keep their score band. Unscored projects are never in the base
   set and never candidates.
4. **Reads only.** The fill is computed on every read and never stored. It never writes
   `Project.priority`, a score or an audit row, and it never marks anything stale or runs the
   scheduler. A new active run, a score edit or an FTE/calendar change shows up on the next read.
5. **Independent of the request.** The walk for a hub always uses every project of that hub,
   whatever row filters (`category`, `type`, `status_`, `q`) the request applied, so a row's
   promoted band does not depend on the filter or on who asks. Callers only get hubs in their scope
   (a Hub Planner sees only their own hubs' fill).
6. **Served** (`docs/API_CONTRACT_P25.md`). Matrix rows (`GET /priorities`, `GET /priorities/{id}`)
   and compare items have:
   - `suggested_band`: the promoted band;
   - `score_band`: the pure score band;
   - `capacity_fill: bool`;
   - `capacity_fill_reason`: set for promoted, stopped and zero-load-skipped candidates, otherwise
     null.

   `GET /priorities/capacity-fill` serves one entry per in-scope hub:
   `{hub, capacity_weeks, base_load_weeks, filled_load_weeks, promoted_count}`. In
   `GET /priorities/distribution` and `GET /priorities/summary`, the band counts use the
   **promoted** band, and `capacity_fill_count` is shown separately. The summary also adds
   `score_band_counts`.

## Judgement calls (recorded, not silent)

- **Load basis.** The base load is the remaining design work from the active run, compared with the
  remaining-year capacity. It is not the whole-run `design_load_weeks` that the Capacity page's
  booked % uses. Remaining work against remaining capacity is the like-for-like reading of "until
  capacity is full". Remaining work that runs past W52 is still counted. This is the conservative
  choice: it promotes less.
- **Base set status.** Base P1 projects count by score whatever their live status. A project set
  On Hold after the run still has its run rows, so its load still counts until the next run. This
  is the same snapshot basis as the Capacity page.
- **Hard gates** do not enter the base set (`suggested_band` ignores hard gates, unchanged since
  P3; contract P21 §0). A hard-gated project scoring below 70 is a normal candidate. See
  `docs/OPEN_QUESTIONS.md` #51.
- **Zero-load candidates are skipped**, not promoted (see 2).

## Consequences

- The Matrix shows more P1 suggestions in hubs with spare design capacity. P25-T02 labels them
  "P1 (capacity fill)" from `capacity_fill`.
- Other surfaces still read the stored score band (`PriorityScore.suggested_band`): the Priority
  board (`schemas/priority_board.py`), Project cards (`services/project_cards.py`), the Workspace
  score section and `GET /exports/matrix`. Mirroring the fill there is a follow-up, not part of
  P25-T01.
- Cost per read: a constant number of queries for the hubs involved (no N+1), plus the existing
  per-row work of `remaining_run_load_by_project`.
