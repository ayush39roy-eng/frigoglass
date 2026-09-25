import * as React from 'react';
import { Info } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SolverType } from '@/types/enums';

/**
 * The visible, unambiguous "which schedule run did these numbers come from"
 * statement. Every surface that shows figures derived from the active
 * `ScheduleRun` (Dashboard within-year counts — Invariant I9; Capacity design/
 * lab load — Invariants I6 / I7) renders this so a reader can always trace a
 * number back to one run version, and so P4-T10 can reconcile the four
 * schedule-driven surfaces against a single source.
 *
 * Cross-surface component (lifted from the Dashboard in P4-T03). The wording of
 * *what* the figures mean differs per surface, so the lead-in sentence, the
 * affordance label, and the explanation body are all injected by the caller;
 * only the "read directly from active schedule run vN (solver · computed at)"
 * spine is shared.
 */

/** The minimal `GET /schedule-runs/active` slice this component reads. Every
 *  surface's own `ScheduleRunSummary` is structurally assignable to this. */
export interface ProvenanceRun {
  version: number;
  solver_type: SolverType;
  created_at: string;
}

export interface ScheduleRunProvenanceProps {
  /** Version from the surface's own schedule-run-backed endpoint (the fallback
   *  when `/schedule-runs/active` is not reachable). */
  scheduleRunVersion: number | null;
  /** Enrichment from `GET /schedule-runs/active` — solver + timestamp. */
  activeRun: ProvenanceRun | null | undefined;
  /** Sentence lead-in, ending right before "active schedule run …". */
  leadIn?: string;
  /** Accessible name of the tooltip affordance button. */
  affordanceLabel?: string;
  /** Tooltip body describing how the surface's figures are defined. Omit to
   *  render the provenance line with no affordance. */
  children?: React.ReactNode;
}

const DEFAULT_LEAD_IN = 'Schedule-outcome figures below are read directly from';
const DEFAULT_AFFORDANCE = 'How the count is defined';

function formatRunTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function ScheduleRunProvenance({
  scheduleRunVersion,
  activeRun,
  leadIn = DEFAULT_LEAD_IN,
  affordanceLabel = DEFAULT_AFFORDANCE,
  children,
}: ScheduleRunProvenanceProps): React.JSX.Element {
  const version = activeRun?.version ?? scheduleRunVersion;
  const versionLabel = version === null || version === undefined ? '—' : `v${String(version)}`;

  const solverLabel =
    activeRun?.solver_type === 'cp_sat'
      ? 'CP-SAT solver'
      : activeRun?.solver_type === 'greedy'
        ? 'greedy scheduler'
        : null;

  return (
    <p
      className="flex flex-wrap items-center gap-1.5 text-2xs text-text-muted"
      data-testid="schedule-run-provenance"
    >
      <span>
        {leadIn} active schedule run{' '}
        <span className="font-semibold text-text">{versionLabel}</span>
        {solverLabel ? <> ({solverLabel})</> : null}
        {activeRun?.created_at ? <> · computed {formatRunTimestamp(activeRun.created_at)}</> : null}.
      </span>
      {children ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-sm text-text-muted underline decoration-dotted underline-offset-2 hover:text-text"
            >
              <Info className="size-3" aria-hidden="true" />
              {affordanceLabel}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-left">{children}</TooltipContent>
        </Tooltip>
      ) : null}
    </p>
  );
}
