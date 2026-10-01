import * as React from 'react';
import { RefreshCw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatInteger } from '@/lib/format';

/**
 * Persistent banner after any successful save (P9 contract §3): a settings
 * change marks every schedulable project `schedule_stale` and NEVER auto-solves
 * (ADR 0007 / 0009). `count` is the `X-Schedule-Stale-Count` response header,
 * verbatim. Stays until dismissed — a banner that fades would hide the one
 * thing the planner has to act on.
 */
export function StaleBanner({ count, onDismiss }: { count: number; onDismiss: () => void }): React.JSX.Element {
  return (
    <div
      role="status"
      data-testid="stale-banner"
      className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning-subtle px-3 py-2 text-2xs text-warning-subtle-fg"
    >
      <RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="flex-1">
        <strong>Workflow settings changed — {formatInteger(count)} {count === 1 ? 'project needs' : 'projects need'} a recalculation.</strong>{' '}
        Nothing was re-scheduled: the active run still reflects the previous settings until a Hub
        Planner or Admin runs a schedule recalculation.
      </span>
      <Button type="button" variant="ghost" size="icon" className="size-6" onClick={onDismiss} aria-label="Dismiss">
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
