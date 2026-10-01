import * as React from 'react';
import { Clock3, Cpu, GitBranch } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Schedule-run traceability as a CHIP ROW, not a sentence.
 *
 * Replaces the shared `<ScheduleRunProvenance>`
 * (`@/components/shared/schedule-run-provenance.tsx`, still rendered by the
 * Gantt) on surfaces that went through the 2026-10-01 client text cleanup. That
 * component paints a full sentence of body copy — "Load figures below are read
 * directly from active schedule run v1 (greedy scheduler) · computed 30 Sept
 * 2026, 18:35." — plus a definitions text link, floating between the card header
 * and the first figure. The client asked for every loose paragraph to become
 * part of a card. NOTHING WAS LOST:
 *
 *  - The three FACTS (run version, solver, computed-at) are three compact chips
 *    in the card header — still visible, still naming the exact run every figure
 *    in the card traces back to (Invariants I6 / I7 / I9).
 *  - The full SENTENCE survives as `sr-only` text, so a screen-reader user hears
 *    "…read directly from active schedule run v1, computed …" as a sentence
 *    rather than three unconnected chips. `leadIn` and `srTail` let each surface
 *    keep its own wording and its own invariant citation.
 *  - `data-testid="schedule-run-provenance"` is unchanged from both originals,
 *    so the existing provenance assertions in `hub-load-panel.test.tsx`,
 *    `CapacityPage.test.tsx` and `schedule-run-provenance.test.tsx` still verify
 *    the exact run version reaches the screen.
 *  - `children` render after the chips, which is where a surface slots its own
 *    `<CardInfo>` popover of counting-rule prose (the Dashboard does; Capacity
 *    puts its popover elsewhere in the card header and passes none).
 *
 * ## Provenance of this file (2026-10-01)
 *
 * Two parallel tasks built this independently in the same hour:
 * `surfaces/capacity/components/run-provenance-chips.tsx` and
 * `surfaces/dashboard/components/schedule-run-provenance.tsx`. The version /
 * solver / timestamp derivation, the chip markup and the `sr-only` sentence were
 * identical line-for-line; only the lead-in wording, the trailing invariant
 * citation and the Dashboard's embedded popover differed, and those three are
 * now props. The Capacity copy is deleted; the Dashboard copy is reduced to a
 * thin wrapper that supplies its own wording and its counting-rule popover.
 */

/**
 * The `ScheduleRun` fields this row reads. Structurally compatible with both
 * surfaces' `ScheduleRunSummary` (each surface keeps its own hand-authored
 * mirror of the backend schema under `api/types.ts`), so neither has to import
 * the other's types to use this.
 */
export interface RunProvenanceRun {
  version: number;
  solver_type: string | null;
  created_at: string | null;
}

export interface RunProvenanceChipsProps {
  /** Version from the surface's own schedule-run-backed endpoint (the fallback
   *  when `/schedule-runs/active` is not reachable). */
  scheduleRunVersion: number | null;
  /** Enrichment from `GET /schedule-runs/active` — solver + timestamp. */
  activeRun: RunProvenanceRun | null | undefined;
  /** Sentence lead-in for the screen-reader-only copy, ending right before
   *  "active schedule run …". */
  leadIn?: string;
  /** Sentence tail for the screen-reader-only copy — the surface's own invariant
   *  citation (I9 on the Dashboard, I17 on Capacity). */
  srTail?: string;
  /** Rendered after the chips: the surface's own `<CardInfo>`, if it has one. */
  children?: React.ReactNode;
  className?: string;
}

const DEFAULT_LEAD_IN = 'Figures in this card are read directly from';
const DEFAULT_SR_TAIL = 'None of it is recalculated in your browser.';

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
  srTail = DEFAULT_SR_TAIL,
  children,
  className,
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
    <div
      className={cn('flex flex-wrap items-center gap-s2', className)}
      data-testid="schedule-run-provenance"
    >
      {/* The sentence the chips replace, preserved for assistive tech.
          Deliberately omits the solver phrase — the solver chip below carries
          that visibly, and duplicating it would have a screen reader say it
          twice. */}
      <span className="sr-only">
        {leadIn} active schedule run {versionLabel}
        {computedAt ? `, computed ${computedAt}` : ''}. {srTail}
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

      {children}
    </div>
  );
}
