import type { HubCapacityRow } from '../api/types';

/**
 * Portfolio-wide headline totals for the Capacity KPI row.
 *
 * ## Why this file exists (2026-10-01)
 *
 * `GET /capacity/hub-load` returns `rows[]` only — there is no server-computed
 * portfolio total on `HubCapacitySummary` (checked against `api/types.ts` and the
 * live response). The headline cards therefore have to add the served rows up in
 * the browser. That is permitted here, and only here, because it is an **aggregate
 * of figures the API already computed** — a table-footer total — not a
 * re-derivation of any ADR 0008 supply formula or any I6/I7 load sum. No
 * `working_weeks × fte`, no `capacity / load`, no scheduling: every term added
 * below is a field the server sent verbatim. (Same shape of display aggregate as
 * `surfaces/dashboard/lib/hub-geo.ts`'s `buildHubTotals()` and
 * `hub-type-pipeline-table.tsx`'s row/column/grand totals.)
 *
 * ## The trap this function exists to avoid: lab rows are REGION-level
 *
 * `api/types.ts` states it, and `hub-supply-breakdown.tsx` says it on screen:
 * "Lab figures are for the {region} lab region and repeat on every hub of that
 * region." `lab_load_weeks`, `lab_capacity_year` and `lab_capacity_remaining` are
 * the SAME region figure stamped onto every hub row sharing that region. Live
 * data makes the consequence concrete — four of the six hubs (R&D-India,
 * PD-India, OEM-HCK, OEM-Seltek) are in the India lab region and each carries
 * `lab_load_weeks: 122.0` / `lab_capacity_year: 188.3`:
 *
 *   naive Σ over rows   →  558 load / 1042.84 capacity   (India counted 4×)
 *   Σ over regions      →  192 load /  477.94 capacity   (correct)
 *
 * So a plain `rows.reduce(...)` nearly triples the portfolio lab load. De-duping
 * by `lab_region` is not new business logic — it is reading the row set for what
 * the contract says it is (one record per hub, carrying a per-region lab figure)
 * before adding anything up.
 *
 * DESIGN figures (`design_load_weeks`, `design_capacity_*`) are genuinely
 * per-hub, so those are summed over every row.
 *
 * ## Precision
 *
 * Nothing is rounded here. Supply figures are specified to two decimals
 * (ADR 0008 / Invariant I17) and the per-hub cards below the KPI row print them
 * with `formatDecimal`; the caller formats these totals the same way, so the
 * headline and the detail agree when a user sums the rows by eye.
 *
 * ## Follow-up owed to the backend
 *
 * The durable fix is a server-computed total on `HubCapacitySummary` (a
 * `totals: { design_load_weeks, design_capacity_year, lab_load_weeks,
 * lab_capacity_year, ... }` object), which would delete this file. Changing the
 * API shape was out of scope for the presentation-only task that found the
 * double-count; recorded in `docs/MEMORY.md` as a recommended backend follow-up.
 */

export interface CapacityPortfolioTotals {
  /** Σ `design_load_weeks` over every hub row. */
  designLoad: number;
  /** Σ `design_capacity_year` over every hub row. */
  designCapacity: number;
  /** Σ `lab_load_weeks` over each DISTINCT `lab_region`. */
  labLoad: number;
  /** Σ `lab_capacity_year` over each DISTINCT `lab_region`. */
  labCapacity: number;
  /** How many distinct lab regions the four lab figures above cover. */
  labRegionCount: number;
}

export function portfolioTotals(rows: readonly HubCapacityRow[]): CapacityPortfolioTotals {
  let designLoad = 0;
  let designCapacity = 0;
  let labLoad = 0;
  let labCapacity = 0;
  const seenRegions = new Set<string>();

  for (const row of rows) {
    designLoad += row.design_load_weeks;
    designCapacity += row.design_capacity_year;

    // One lab region contributes once, however many hubs repeat it.
    if (!seenRegions.has(row.lab_region)) {
      seenRegions.add(row.lab_region);
      labLoad += row.lab_load_weeks;
      labCapacity += row.lab_capacity_year;
    }
  }

  return {
    designLoad,
    designCapacity,
    labLoad,
    labCapacity,
    labRegionCount: seenRegions.size,
  };
}
