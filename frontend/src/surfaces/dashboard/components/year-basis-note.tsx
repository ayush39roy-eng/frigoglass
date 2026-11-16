import * as React from 'react';
import { Info } from 'lucide-react';

import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { CompletingWithinYear } from '../api/types';
import type { KpiBucket } from '../lib/executive';

/** P42 (ADR 0056, R42-6): the one sentence that says what the year figures count. */
export const YEAR_BASIS_COPY = 'Year figures count P1, P2 and started P3 only.';

/**
 * P42 (ADR 0056, I53): the KPI copy under the outcome tiles. The year figures
 * (within year, spillover, on hold and their shares) count P1, P2 and started
 * P3 only; queued P3 and P4 projects are served as their own counts
 * (`queued_count`, `not_scheduled_priority_count`) and shown here verbatim —
 * the browser derives none of them. Each count opens the rows behind it when
 * `onOpen` is given (the same dialog as the tiles, selected by served bucket).
 */
export function YearBasisNote({
  data,
  onOpen,
  className,
}: {
  data: Pick<CompletingWithinYear, 'queued_count' | 'not_scheduled_priority_count'>;
  onOpen?: (bucket: Extract<KpiBucket, 'queued' | 'not_scheduled'>, trigger: HTMLButtonElement) => void;
  className?: string;
}): React.JSX.Element {
  const part = (
    bucket: Extract<KpiBucket, 'queued' | 'not_scheduled'>,
    label: string,
    count: number,
  ): React.JSX.Element => {
    const text = (
      <>
        {label}{' '}
        <span className="font-semibold tabular-nums text-text" data-numeric="">
          {formatInteger(count)}
        </span>
      </>
    );
    if (!onOpen || count === 0) {
      return <span data-testid={`year-basis-${bucket}`}>{text}</span>;
    }
    return (
      <button
        type="button"
        className="rounded-sm underline decoration-border-strong underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(e) => onOpen(bucket, e.currentTarget)}
        aria-label={`${label}: list the ${formatInteger(count)} ${count === 1 ? 'project' : 'projects'}`}
        data-testid={`year-basis-${bucket}`}
      >
        {text}
      </button>
    );
  };

  return (
    <p
      className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs font-medium text-text-muted', className)}
      data-testid="year-basis-note"
    >
      <Info className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{YEAR_BASIS_COPY}</span>
      <span>Not counted:</span>
      {part('queued', 'Queued P3', data.queued_count)}
      <span aria-hidden="true">·</span>
      {part('not_scheduled', 'Not scheduled (P4)', data.not_scheduled_priority_count)}
    </p>
  );
}
