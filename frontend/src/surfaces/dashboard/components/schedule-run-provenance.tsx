import * as React from 'react';

import { CardInfo } from '@/components/ui/card-info';
import { RunProvenanceChips } from '@/components/ui/run-provenance-chips';
import { SPILLOVER_YEAR, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatWeek } from '@/lib/format';

import type { ScheduleRunSummary } from '../api/types';

/**
 * Invariant I9 traceability for the Dashboard, as a CHIP ROW — not a sentence.
 *
 * DE-DUPLICATED 2026-10-01: the chip markup, the version / solver / timestamp
 * derivation and the `sr-only` sentence used to be written out here AND, line for
 * line, in `surfaces/capacity/components/run-provenance-chips.tsx` — two parallel
 * tasks building the same thing in the same hour. Both now render the shared
 * `<RunProvenanceChips>` (`@/components/ui/run-provenance-chips`). What is left in
 * this file is the only part that was ever Dashboard-specific: the surface's own
 * screen-reader wording and the within-year COUNTING RULES, which stay here next
 * to the surface they describe rather than in a shared primitive.
 *
 * `data-testid="schedule-run-provenance"` and the "How the count is defined"
 * accessible name are unchanged, so `schedule-run-provenance.test.tsx` and
 * `DashboardPage.test.tsx` assert exactly what they asserted before.
 *
 * The OTHER shared component — `@/components/shared/schedule-run-provenance.tsx`,
 * which paints the old full-sentence body copy — is deliberately untouched: the
 * Gantt still renders it, and that surface has not had the text cleanup.
 */


export interface ScheduleRunProvenanceProps {
  scheduleRunVersion: number | null;
  activeRun: ScheduleRunSummary | null | undefined;
  showVersionChip?: boolean;
  showSolverChip?: boolean;
  showTimestampChip?: boolean;
}

export function ScheduleRunProvenance({
  scheduleRunVersion,
  activeRun,
  showVersionChip = false,
  showSolverChip = false,
  showTimestampChip = false,
}: ScheduleRunProvenanceProps): React.JSX.Element {
  return (
    <RunProvenanceChips
      scheduleRunVersion={scheduleRunVersion}
      activeRun={activeRun}
      showVersionChip={showVersionChip}
      showSolverChip={showSolverChip}
      showTimestampChip={showTimestampChip}
      leadIn="Schedule-outcome figures below are read directly from"
      srTail="Not recalculated in your browser (Invariant I9)."
    >
      <CardInfo label="How the count is defined">
        <p>
          A project is counted as <strong className="text-text">completing within the year</strong>{' '}
          when it is not left out and its last scheduled step ends — plus any applied delay — on or
          before {formatWeek(WITHIN_YEAR_WEEK)} (<code>DOMAIN_RULES.md</code>). Projects with{' '}
          <strong className="text-text">Commercialized</strong> status are counted as already
          delivered this year.
        </p>
        <p>
          <strong className="text-text">Spillover (past {formatWeek(WITHIN_YEAR_WEEK)})</strong> = not
          done by {formatWeek(WITHIN_YEAR_WEEK)}, carried into {SPILLOVER_YEAR}. It includes any
          project the run could not place yet (shown as &quot;not yet placed&quot;).{' '}
          <strong className="text-text">On Hold</strong> = in the plan, waiting at a stage that is on
          hold (a paused project with status On Hold is not scheduled at all); it wins outright over
          the others, so the counts never overlap.
        </p>
        <p>
          Every number on this surface traces to a single field on the schedule-run response. None
          of it is recalculated in your browser (Invariant I9).
        </p>
      </CardInfo>
    </RunProvenanceChips>
  );
}
