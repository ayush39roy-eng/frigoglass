/**
 * P17-R08: the Hub × Type drill-down target model and its labels (shared by the
 * two tables and the dialog in `components/hub-type-drilldown.tsx`).
 */

import type { HubName } from '@/types/enums';
import { formatInteger } from '@/lib/format';

import type { AnalyticsTypeKey } from '../api/types';
import { typeLabel } from './analytics';

/**
 * P17-R09: `GET /dashboard/projects?type=Unmapped` (the analytics bucket key)
 * serves the projects with NO type (`Project.type IS NULL`), so the pipeline
 * table's untyped ("—") cells and column total are clickable like the rest.
 */
export const UNTYPED_REGISTER_FILTER_SERVED = true;

export type DrillSource = 'pipeline' | 'completing';

export interface DrillTarget {
  source: DrillSource;
  /** null = every hub in view (a column total or the grand total). */
  hub: HubName | null;
  /** null = every type (a row total or the grand total). */
  typeKey: AnalyticsTypeKey | null;
  /** The served figure on the clicked cell. */
  count: number;
}

/** True when the pipeline drill-down for this type can be asked of the server. */
export function pipelineDrillServed(typeKey: AnalyticsTypeKey | null): boolean {
  return typeKey !== 'Unmapped' || UNTYPED_REGISTER_FILTER_SERVED;
}

function typePhrase(typeKey: AnalyticsTypeKey | null): string {
  if (typeKey === null) return '';
  return typeKey === 'Unmapped' ? 'untyped ' : `${typeLabel(typeKey)} `;
}

/** "View 3 New Model projects in PD-India" (cells), "View all 165 projects in PD-India" (totals). */
export function drillAriaLabel(t: DrillTarget): string {
  const n = formatInteger(t.count);
  const noun = t.count === 1 ? 'project' : 'projects';
  const all = t.hub === null || t.typeKey === null ? 'all ' : '';
  const where = t.hub ? ` in ${t.hub}` : '';
  const tail = t.source === 'completing' ? ' completing within the year' : '';
  return `View ${all}${n} ${typePhrase(t.typeKey)}${noun}${where}${tail}`;
}

export function drillTitle(t: DrillTarget): string {
  const type = t.typeKey === null ? 'All types' : t.typeKey === 'Unmapped' ? 'Untyped' : typeLabel(t.typeKey);
  const hub = t.hub ?? 'All hubs in view';
  return `${type} · ${hub}`;
}

