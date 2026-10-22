/**
 * Row SELECTION for the Executive view (P28, ADR 0039 §3). Everything here
 * picks served rows and served flags — it never computes a new judgement, a
 * share or a schedule figure (I9/I19). The only arithmetic is the same class
 * the Detailed header already uses: adding served counts up for presentation
 * (`DashboardPage`'s `totalProjectsCount`, `lib/outcome.ts::outcomeTotal`).
 */

import type { HubName } from '@/types/enums';
import type { VipBoardResponse, VipItem, VipItemProject } from '@/lib/api/vip';

import type { CompletingWithinYearRow, ProjectFilterRow } from '../api/types';
import { outcomeOf } from './outcome';

/** The risks list is capped; the rest live in the project register. */
export const RISK_LIST_CAP = 8;

/* ----------------------------- KPI click-through --------------------------- */

/** The run-derived KPI tiles (P28 addendum): each opens the rows behind its
 *  served count. `scheduled` = every row the run placed in one of the four
 *  mutually exclusive buckets (the tile's own sum, `outcomeTotal`). */
export type KpiBucket = 'scheduled' | 'within_year' | 'spillover' | 'left_out' | 'blocked';

export const KPI_BUCKET_META: Record<KpiBucket, { title: string }> = {
  scheduled: { title: 'Scheduled projects' },
  within_year: { title: 'Completing within the year' },
  spillover: { title: 'Spillover (past W52)' },
  left_out: { title: 'Left out (no slot found)' },
  // Owner ask 2026-10-23: "On hold", not "Blocked" (the schedule outcome, ADR 0017 §3).
  blocked: { title: 'On hold (at a stage)' },
};

/**
 * The rows behind one KPI tile — pure SELECTION of the already-fetched
 * `completing-within-year` rows by their served flags, resolved through the
 * surface's ONE outcome classification (`lib/outcome.ts::outcomeOf`, the
 * backend's P9-F02 precedence: blocked wins outright), so each tile's list
 * length equals the served aggregate count it shows (I9 — nothing is
 * recomputed, no row is double-listed).
 */
export function selectOutcomeRows(
  rows: readonly CompletingWithinYearRow[],
  bucket: KpiBucket,
): CompletingWithinYearRow[] {
  if (bucket === 'scheduled') return rows.filter((row) => outcomeOf(row) !== 'unresolved');
  return rows.filter((row) => outcomeOf(row) === bucket);
}

export type RiskReason = 'blocked' | 'overdue' | 'vip_not_in_year';

export const RISK_REASON_META: Record<
  RiskReason,
  { label: string; title: string; tone: 'warning' | 'danger' | 'primary' }
> = {
  // Chip labels per ADR 0039 §3; the ADR 0017 §3 qualification ("On Hold at a
  // stage", the schedule OUTCOME, not the project status) travels in `title`.
  blocked: { label: 'On hold', title: 'On hold at a stage in the active run', tone: 'warning' },
  overdue: { label: 'Overdue check-in', title: 'A due stage has had no check-in this week or last week', tone: 'danger' },
  vip_not_in_year: { label: 'VIP not in year', title: 'VIP project not completing within the year in the active run', tone: 'primary' },
};

export interface RiskRow {
  projectId: string;
  name: string;
  hub: HubName | null;
  reason: RiskReason;
}

/** Depth-first flatten of the served VIP items (one level of children, served order). */
function flattenVipItems(items: VipItem[]): VipItem[] {
  const out: VipItem[] = [];
  for (const item of items) {
    out.push(item);
    for (const child of item.children) out.push(child);
  }
  return out;
}

/** The VIP (highlighted) items' linked projects whose served run outcome is not
 *  within the year (`within_year === false`; a null outcome — no active run —
 *  is no judgement, so it is never listed as a risk). */
export function vipProjectsNotInYear(board: VipBoardResponse | null | undefined): VipItemProject[] {
  if (!board) return [];
  const out: VipItemProject[] = [];
  for (const area of board.areas) {
    for (const item of flattenVipItems(area.items)) {
      if (!item.highlighted) continue;
      for (const project of item.projects) {
        if (project.within_year === false) out.push(project);
      }
    }
  }
  return out;
}

/**
 * The served VIP headline for the KPI strip: the per-area `vip_project_count`
 * (projects pinned VIP, ADR 0040) added up for presentation (the same derivation
 * class as the Detailed header's scheduled total: a sum of served counts, never a
 * recomputation). Highlighted board items are slide bullets, not VIP projects.
 */
export function vipHighlightedTotal(board: VipBoardResponse | null | undefined): number | null {
  if (!board) return null;
  // Absent from an API older than the ADR 0040 follow-up: no headline rather than NaN.
  if (board.areas.some((a) => typeof (a as Partial<typeof a>).vip_project_count !== 'number')) return null;
  return board.areas.reduce((sum, area) => sum + area.vip_project_count, 0);
}

/**
 * Risks & escalations (ADR 0039 §3): a SELECTION of served rows, in the fixed
 * order blocked → overdue check-ins → VIP not within year, de-duplicated by
 * project id (the first reason wins). The caller caps the list for display.
 *
 * - blocked: `GET /dashboard/completing-within-year` rows with `blocked === true`
 *   (the served flag — P9-F02 made it win outright over the other outcome flags);
 * - overdue: `GET /dashboard/projects` rows with the SERVED
 *   `tracking_status === 'overdue'` (ADR 0021 §4 — computed server-side);
 * - VIP: `GET /vip-board` highlighted items' linked projects with the served
 *   `within_year === false`.
 */
export function selectRiskRows(
  withinYearRows: readonly CompletingWithinYearRow[],
  projectRows: readonly ProjectFilterRow[],
  vipBoard: VipBoardResponse | null | undefined,
): RiskRow[] {
  const out: RiskRow[] = [];
  const seen = new Set<string>();
  const push = (projectId: string, name: string, hub: HubName | null, reason: RiskReason): void => {
    if (seen.has(projectId)) return;
    seen.add(projectId);
    out.push({ projectId, name, hub, reason });
  };

  for (const row of withinYearRows) {
    if (row.blocked) push(row.project_id, row.project_name, row.hub, 'blocked');
  }
  for (const row of projectRows) {
    if (row.tracking_status === 'overdue') push(row.project_id, row.project_name, row.hub, 'overdue');
  }
  for (const project of vipProjectsNotInYear(vipBoard)) {
    push(project.id, project.name, project.hub, 'vip_not_in_year');
  }
  return out;
}
