import type { ProjectStatus } from '@/types/enums';

import type { RegionSummary } from '../api/types';
import type { RegionChipItem } from '../components/region-chips';

/**
 * P13 (ADR 0025 §4): one status card's per-country chips, read verbatim from
 * the served per-region status maps of `GET /dashboard/region-summary`. No
 * arithmetic — a missing share is passed on as `null` and not shown.
 */
/** Chips for one project status, read from the served per-region status maps. */
export function statusRegionItems(summary: RegionSummary, status: ProjectStatus): RegionChipItem[] {
  return summary.regions.map((row) => ({
    region: row.region,
    count: row.status_counts[status] ?? 0,
    sharePct: row.status_share_pct[status] ?? null,
  }));
}
