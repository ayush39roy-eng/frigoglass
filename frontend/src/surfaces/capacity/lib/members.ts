import { formatInteger } from '@/lib/format';
import { joinNames } from '@/lib/hub-labels';

import type { CapacityHubMember, HubCapacityRow } from '../api/types';

/**
 * P29 (ADR 0042, API_CONTRACT_P29 §2.2): selection helpers over a capacity
 * row's served `members`. Selection and wording only; nothing is added up
 * (the row's own `design_load_weeks` is the total, I9/I19).
 */

/** The served members other than the capacity hub itself (OEM-HCK, OEM-Seitek). */
export function otherMembers(row: Pick<HubCapacityRow, 'members'>): CapacityHubMember[] {
  return (row.members ?? []).filter((m) => !m.own);
}

/** True when the row has a breakdown worth showing: at least one served member
 *  hub besides the capacity hub itself. An older API (no `members`) gives false. */
export function hasMemberBreakdown(row: Pick<HubCapacityRow, 'members'>): boolean {
  return otherMembers(row).length > 0;
}

/** "Includes OEM-HCK and OEM-Seitek" (served member names, in served order). */
export function membersCaption(row: Pick<HubCapacityRow, 'members'>): string {
  return `Includes ${joinNames(otherMembers(row).map((m) => m.hub))}`;
}

export const SELECTED_MEMBER_SR = 'selected in the hub filter';

/** "11 projects" / "1 project", from the served count. */
export function projectsText(count: number): string {
  return `${formatInteger(count)} ${count === 1 ? 'project' : 'projects'}`;
}


/**
 * P30 (ADR 0041, API_CONTRACT_P30 §4): a member's served design DEMAND for the
 * horizon (full year → `design_load_weeks`, remaining → `design_load_remaining_weeks`),
 * matching the row's own pair (I19 rev.). Null when an older API does not serve it.
 */
export function memberDemand(m: CapacityHubMember, horizon: 'year' | 'remaining'): number | null {
  const served: Partial<CapacityHubMember> = m;
  const v = horizon === 'year' ? served.design_load_weeks : served.design_load_remaining_weeks;
  return typeof v === 'number' ? v : null;
}

/** P30: a member's served run-booked design weeks, or null on an older API. */
export function memberBooked(m: CapacityHubMember): number | null {
  const served: Partial<CapacityHubMember> = m;
  return typeof served.design_load_booked_weeks === 'number' ? served.design_load_booked_weeks : null;
}
