import * as React from 'react';
import { Lock, Snowflake } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ProjectPriority } from '@/types/enums';

/**
 * P36 (ADR 0050): the served `band_rank` as "#n" — the project's position inside
 * its whole priority band (filters never change it), which is its scheduling
 * order inside the band. Printed verbatim (I9).
 */
export function BandRankChip({
  rank,
  band,
  className,
}: {
  rank: number;
  band: ProjectPriority;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-sm bg-surface-sunken px-1 py-0.5 font-mono text-2xs font-semibold leading-none tabular-nums text-text-muted',
        className,
      )}
      title={`Position ${String(rank)} in ${band}: its scheduling order inside the band`}
      data-numeric=""
      data-testid="board-rank-chip"
    >
      <span aria-hidden="true">#{rank}</span>
      <span className="sr-only">{`Position ${String(rank)} in ${band}`}</span>
    </span>
  );
}

/**
 * P36 (R36-2): a frozen project schedules first whatever its board position, and
 * its dates are locked (I10), so its place in the column is not its walk position.
 */
export function FrozenBadge({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-sm bg-primary-subtle px-1.5 py-0.5 text-2xs font-semibold leading-none text-primary-subtle-fg',
        className,
      )}
      title="Frozen: dates locked; scheduled first whatever its position in the column"
      data-testid="board-frozen-badge"
    >
      <Snowflake className="size-3 shrink-0" aria-hidden="true" />
      Frozen
    </span>
  );
}

/** P36: a hard-gated P1 card that can still be reordered shows a small lock beside its handle. */
export function HardGateLock({ size = 'size-3.5', testId }: { size?: string; testId?: string }): React.JSX.Element {
  return (
    <span className="grid shrink-0 place-items-center text-text-muted" title="Hard gate: this project must stay P1" data-testid={testId}>
      <Lock className={size} aria-hidden="true" />
      <span className="sr-only">Hard gate: stays P1</span>
    </span>
  );
}
