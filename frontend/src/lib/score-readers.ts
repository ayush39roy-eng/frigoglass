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
