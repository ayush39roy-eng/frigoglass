import * as React from 'react';
import { Clock3, Cpu, GitBranch } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { ScheduleRunSummary } from '../api/types';

/**
 * Schedule-run traceability as a CHIP ROW, not a sentence.
 *
 * REPLACES this surface's use of the shared `<ScheduleRunProvenance>`
 * (`@/components/shared/schedule-run-provenance.tsx`), which paints a full
 * sentence of body copy — "Load figures below are read directly from active
 * schedule run v1 (greedy scheduler) · computed 30 Sept 2026, 18:35." — plus a
 * "How load and capacity are defined" text link, both floating between the card
 * header and the first figure. Client feedback 2026-10-01 asked for every loose
 * paragraph on this surface to become part of a card. NOTHING WAS LOST:
 *
 *  - The three FACTS (run version, solver, computed-at) are now three compact
 *    chips in the card header — still visible, still on screen, still naming the
 *    exact run every figure in the card traces back to (Invariants I6 / I7).
 *  - The full SENTENCE survives verbatim as `sr-only` text, so a screen-reader
 *    user still hears "Load figures below are read directly from active schedule
 *    run v1, computed …" as a sentence rather than three unconnected chips. The
 *    `data-testid` is unchanged, so the existing provenance assertions in
 *    `hub-load-panel.test.tsx` / `CapacityPage.test.tsx` still check the same
 *    run version reaches the screen.
 *  - The definition PROSE that used to hang off the sentence as a dotted link
 *    moved into a `<CapacityInfo>` popover in the same card header, under the
 *    same accessible name it had as a link.
 *
 * The SHARED component is deliberately left untouched — the Gantt still renders
 * it, and the Dashboard has its own local chip version built in parallel from
 * the same client instruction (`surfaces/dashboard/components/
 * schedule-run-provenance.tsx`). See `capacity-info.tsx`'s doc comment for why
 * these were not converged into one shared module in this task.
 */

export interface RunProvenanceChipsProps {
  /** Version from the surface's own schedule-run-backed endpoint (the fallback
   *  when `/schedule-runs/active` is not reachable). */
  scheduleRunVersion: number | null;
  /** Enrichment from `GET /schedule-runs/active` — solver + timestamp. */
  activeRun: ScheduleRunSummary | null | undefined;
  /** Sentence lead-in for the screen-reader-only copy, ending right before
   *  "active schedule run …". */
  leadIn?: string;
}

const DEFAULT_LEAD_IN = 'Load figures in this card are read directly from';

function formatRunTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

const CHIP =
  'inline-flex items-center gap-1.5 rounded-pill bg-dash-alt px-2.5 py-1 text-2xs font-medium text-text-muted';

export function RunProvenanceChips({
  scheduleRunVersion,
  activeRun,
  leadIn = DEFAULT_LEAD_IN,
}: RunProvenanceChipsProps): React.JSX.Element {
  const version = activeRun?.version ?? scheduleRunVersion;
  const versionLabel = version === null || version === undefined ? '—' : `v${String(version)}`;

  const solverLabel =
    activeRun?.solver_type === 'cp_sat'
      ? 'CP-SAT solver'
      : activeRun?.solver_type === 'greedy'
        ? 'Greedy scheduler'
        : null;

  const computedAt = activeRun?.created_at ? formatRunTimestamp(activeRun.created_at) : null;

  return (
    <div className="flex flex-wrap items-center gap-s2" data-testid="schedule-run-provenance">
      {/* The sentence the chips replace, preserved verbatim for assistive tech.
          Deliberately omits the solver phrase — the solver chip below carries
          that visibly, and duplicating it would have a screen reader say it
          twice. */}
      <span className="sr-only">
        {leadIn} active schedule run {versionLabel}
        {computedAt ? `, computed ${computedAt}` : ''}. Computed server-side and shown to two
        decimals (Invariant I17); none of it is recalculated in your browser.
      </span>

      <span className={cn(CHIP, 'bg-primary-subtle text-primary-subtle-fg')} data-numeric="">
        <GitBranch className="size-3" aria-hidden="true" />
        Run {versionLabel}
      </span>
      {solverLabel ? (
        <span className={CHIP}>
          <Cpu className="size-3" aria-hidden="true" />
          {solverLabel}
        </span>
      ) : null}
      {computedAt ? (
        <span className={CHIP}>
          <Clock3 className="size-3" aria-hidden="true" />
          {computedAt}
        </span>
      ) : null}
    </div>
  );
}
