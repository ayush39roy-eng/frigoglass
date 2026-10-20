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

/** The four Project Pipeline row cards (ADR 0030). */
export type PipelineBucket = 'spillover' | 'new' | 'unregistered' | 'total';

/**
 * Per-country chips for one Project Pipeline card, read verbatim from the
 * served `GET /dashboard/region-summary` rows (count + the bucket's own
 * server-computed share; I19, no browser arithmetic).
 */
export function pipelineRegionItems(summary: RegionSummary, bucket: PipelineBucket): RegionChipItem[] {
  return summary.regions.map((row) => {
    switch (bucket) {
      case 'spillover':
        return { region: row.region, count: row.spillover_count, sharePct: row.spillover_share_pct };
      case 'new':
        return { region: row.region, count: row.newly_registered_count, sharePct: row.newly_registered_share_pct };
      case 'unregistered':
        return { region: row.region, count: row.unregistered_count, sharePct: row.unregistered_share_pct };
      case 'total':
        return { region: row.region, count: row.total_count, sharePct: row.share_pct };
    }
  });
}
