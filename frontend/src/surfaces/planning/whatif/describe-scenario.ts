import { PROJECT_TYPE_LABELS } from '@/types/enums';

import type { ChatScenario } from '../api/whatif-types';

/** Plain-language lines for a scenario (presentation of the request's own
 *  fields: it states what was asked, it computes nothing). */
export function describeScenario(s: ChatScenario): string[] {
  const out: string[] = [];
  for (const p of s.add_projects ?? []) {
    const bits = [`${String(p.count ?? 1)} x category ${p.category} in ${p.hub}`];
    if (p.project_type) bits.push(PROJECT_TYPE_LABELS[p.project_type]);
    bits.push(p.status ?? 'In Queue');
    if (p.priority) bits.push(`priority ${p.priority}`);
    else if (p.score !== null && p.score !== undefined) bits.push(`score ${String(p.score)}`);
    out.push(`Add projects: ${bits.join(', ')}`);
  }
  for (const e of s.add_engineers ?? []) {
    out.push(`Add designers: ${String(e.count ?? 1)} in ${e.hub} at ${String(e.fte ?? 1)} FTE each`);
  }
  for (const r of s.remove_engineer_counts ?? []) {
    out.push(`Remove designers: ${String(r.count ?? 1)} from ${r.hub}`);
  }
  for (const c of s.add_chambers ?? []) {
    const bits: string[] = [];
    if (c.platforms !== null && c.platforms !== undefined) bits.push(`${String(c.platforms)} platforms`);
    if (c.efficiency !== null && c.efficiency !== undefined) bits.push(`efficiency ${String(c.efficiency)}`);
    if (c.maintenance_weeks !== null && c.maintenance_weeks !== undefined) bits.push(`maintenance ${String(c.maintenance_weeks)} wk`);
    if (c.breakdown_weeks !== null && c.breakdown_weeks !== undefined) bits.push(`breakdown ${String(c.breakdown_weeks)} wk`);
    if (c.calibration_weeks !== null && c.calibration_weeks !== undefined) bits.push(`calibration ${String(c.calibration_weeks)} wk`);
    out.push(
      `Add chambers: ${String(c.count ?? 1)} in ${c.lab_region}${bits.length > 0 ? ` (${bits.join(', ')})` : ' (region norm)'}`,
    );
  }
  for (const d of s.chamber_downtime ?? []) {
    const bits: string[] = [];
    if (d.maintenance_weeks !== null && d.maintenance_weeks !== undefined) bits.push(`maintenance ${String(d.maintenance_weeks)} wk`);
    if (d.breakdown_weeks !== null && d.breakdown_weeks !== undefined) bits.push(`breakdown ${String(d.breakdown_weeks)} wk`);
    if (d.calibration_weeks !== null && d.calibration_weeks !== undefined) bits.push(`calibration ${String(d.calibration_weeks)} wk`);
    out.push(`Chamber downtime: chamber ${d.chamber_id}${bits.length > 0 ? ` set to ${bits.join(', ')}` : ''}`);
  }
  return out;
}
