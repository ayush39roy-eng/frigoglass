import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';

/** Served VIP pin (`projects.is_vip`, ADR 0040); absent from an older API reads as not VIP. */
export function isVipProject(row: ProjectFilterRow): boolean {
  return (row as Partial<ProjectFilterRow>).is_vip === true;
}

/**
 * ADR 0040 §5: VIP projects first, each group keeping the served order (the
 * server's sort is not re-derived; this is a stable partition). With
 * `vipOnly` the list is narrowed to the VIP rows.
 */
export function orderForDisplay(rows: ProjectFilterRow[], vipOnly: boolean): ProjectFilterRow[] {
  const vip: ProjectFilterRow[] = [];
  const rest: ProjectFilterRow[] = [];
  for (const r of rows) (isVipProject(r) ? vip : rest).push(r);
  if (vipOnly) return vip;
  return rest.length === rows.length ? rows : [...vip, ...rest];
}
