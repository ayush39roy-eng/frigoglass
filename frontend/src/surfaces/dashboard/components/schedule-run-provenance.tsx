import * as React from 'react';
import { Cpu, GitBranch, Clock3 } from 'lucide-react';

import { formatWeek } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { ScheduleRunSummary } from '../api/types';
import { CardInfo } from './card-info';

/**
 * Invariant I9 traceability, as a CHIP ROW — not a sentence.
 *
 * RESTYLED 2026-10-01 (client text cleanup). This used to render the shared
 * `<ScheduleRunProvenance>` (`@/components/shared/schedule-run-provenance.tsx`)
 * which paints a full sentence of body copy ("Schedule-outcome figures below are
 * read directly from active schedule run v1 (greedy scheduler) · computed 30
 * Sept 2026.") plus a "How the count is defined" text link. The client asked for
 * every loose paragraph on this surface to become part of a card. Nothing was
 * lost:
 *
 *  - The three FACTS (run version, solver, computed-at) are now three compact
 *    chips — still visible, still on screen, still naming the exact run every
 *    figure on this surface traces back to.
 *  - The full SENTENCE survives verbatim as `sr-only` text, so a screen-reader
 *    user still hears "…read directly from active schedule run v1, computed …"
 *    as a sentence rather than three unconnected chips.
 *  - The counting-rule PROSE (the `DOMAIN_RULES.md` within-year definition, the
 *    Commercialized-counts-as-delivered note, the "not recalculated in your
 *    browser" I9 statement) moved into the `<CardInfo>` popover, still keyboard
 *    reachable under the same accessible name it had as a link.
 *
 * The SHARED component is deliberately left untouched — Capacity's hub-load
 * panel and the Gantt still render it, and neither is in this task's scope.
 */

const WITHIN_YEAR_WEEK = 52;

export interface ScheduleRunProvenanceProps {
  scheduleRunVersion: number | null;
  activeRun: ScheduleRunSummary | null | undefined;
}

function formatRunTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

const CHIP = 'inline-flex items-center gap-1.5 rounded-pill bg-dash-alt px-2.5 py-1 text-2xs font-medium text-text-muted';

export function ScheduleRunProvenance({
  scheduleRunVersion,
  activeRun,
}: ScheduleRunProvenanceProps): React.JSX.Element {
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
      className="flex flex-wrap items-center gap-s2"
      data-testid="schedule-run-provenance"
    >
      {/* The sentence the chips replace, preserved for assistive tech. Deliberately
          omits the solver phrase — the solver chip below carries that, visibly, and
          duplicating it would have a screen reader read it twice. */}
      <span className="sr-only">
        Schedule-outcome figures below are read directly from active schedule run {versionLabel}
        {computedAt ? `, computed ${computedAt}` : ''}. Not recalculated in your browser (Invariant
        I9).
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

      <CardInfo label="How the count is defined">
        <p>
          A project is counted as <strong className="text-text">completing within the year</strong>{' '}
          when it is not left out and its last scheduled step ends — plus any applied delay — on or
          before {formatWeek(WITHIN_YEAR_WEEK)} (<code>DOMAIN_RULES.md</code>). Projects with{' '}
          <strong className="text-text">Commercialized</strong> status are counted as already
          delivered this year.
        </p>
        <p>
          <strong className="text-text">Spillover</strong> = scheduled but not completing by{' '}
          {formatWeek(WITHIN_YEAR_WEEK)}. <strong className="text-text">Left out</strong> = no
          feasible window before the 78-week horizon.{' '}
          <strong className="text-text">Blocked</strong> = held at a Blocked stage; it wins outright
          over the other three, so the four counts never overlap.
        </p>
        <p>
          Every number on this surface traces to a single field on the schedule-run response. None
          of it is recalculated in your browser (Invariant I9).
        </p>
      </CardInfo>
    </div>
  );
}
