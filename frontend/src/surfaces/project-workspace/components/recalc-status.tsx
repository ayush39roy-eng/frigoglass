import * as React from 'react';
import { CircleCheck, RefreshCw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';

import type { RecalcState } from '../hooks/use-recalc-flow';

export function RecalculateButton({
  onClick,
  busy,
  size = 'sm',
  variant = 'primary',
}: {
  onClick: () => void;
  busy: boolean;
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary';
}): React.JSX.Element {
  return (
    <Button type="button" size={size} variant={variant} onClick={onClick} disabled={busy}>
      <RefreshCw className={busy ? 'motion-safe:animate-spin' : undefined} aria-hidden="true" />
      {busy ? 'Recalculating…' : 'Recalculate schedule'}
    </Button>
  );
}

/** Live solver status (polite region) with a determinate bar when the worker
 *  reports a percentage. */
export function RecalcStatus({ state }: { state: RecalcState }): React.JSX.Element | null {
  if (state.phase === 'idle') return null;
  const failed = state.phase === 'failed';
  const done = state.phase === 'completed';
  return (
    <div role="status" aria-live="polite" className="flex min-w-48 flex-col gap-1 text-2xs" data-testid="recalc-status" data-phase={state.phase}>
      <span className={failed ? 'flex items-center gap-1 text-danger' : 'flex items-center gap-1 text-text-muted'}>
        {failed ? <TriangleAlert className="size-3.5" aria-hidden="true" /> : done ? <CircleCheck className="size-3.5 text-success" aria-hidden="true" /> : null}
        {state.message}
      </span>
      {state.phase === 'running' || state.phase === 'dispatching' ? (
        <div
          className="h-1.5 overflow-hidden rounded-pill bg-surface-sunken"
          role="progressbar"
          aria-label="Solver progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.percent ?? undefined}
        >
          <div
            className={state.percent === null ? 'h-full w-1/3 rounded-pill bg-primary/60 motion-safe:animate-pulse' : 'h-full rounded-pill bg-primary transition-[width] duration-base'}
            style={state.percent === null ? undefined : { width: `${String(state.percent)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
