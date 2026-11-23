import type { QueryClient } from '@tanstack/react-query';

/**
 * P27 (ADR 0038): a Registration save that carries `scoring_tags` may pre-fill
 * dimension scores server-side (a newly set tag → 5), and the PATCH / POST
 * response carries no score (API_CONTRACT_P27 §3). Re-read every query that
 * shows a score or band: the Matrix (rows, summary, distribution, capacity
 * fill, compare, edit rows — all under `priority-matrix`), the Priority board,
 * the VIP board (ordered by weighted score) and every Workspace (under
 * `projects`). A tag never changes the schedule (`schedule_stale` is not set),
 * so run-derived views are not refreshed.
 */
export function invalidateScoreReaders(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['priority-matrix'] });
  void queryClient.invalidateQueries({ queryKey: ['priority-board'] });
  void queryClient.invalidateQueries({ queryKey: ['vip-board'] });
  void queryClient.invalidateQueries({ queryKey: ['projects', 'workspace'] });
}

/** Project fields every project view shows (register, Dashboard, Gantt,
 *  boards, Matrix): a PATCH that sends one of them re-reads them all. */
const PROJECT_VIEW_FIELDS = ['status', 'priority', 'leader_engineer_id', 'hub_id', 'category', 'type'] as const;

/**
 * Owner 2026-11-23 ("I change the status but it is still not updated"): a
 * `PATCH /projects/{id}` is shown at once everywhere. The register list and
 * every Dashboard figure read `dashboard` keys (not `projects`), so they are
 * always re-read; when the body sends a field the other views show (status,
 * priority, leader, hub, category, type), the Gantt, the Priority / VIP
 * boards and the Matrix are re-read too.
 */
export function invalidateProjectWriteReaders(queryClient: QueryClient, body: object): void {
  void queryClient.invalidateQueries({ queryKey: ['projects'] });
  void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  if (!PROJECT_VIEW_FIELDS.some((field) => field in body)) return;
  for (const key of [['gantt'], ['priority-board'], ['priority-matrix'], ['vip-board']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
