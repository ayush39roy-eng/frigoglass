import * as React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAutoRecalc, useRecalcModeStore } from '@/stores/recalc-mode';
import { useSessionStore } from '@/stores/session';

/**
 * P61 (ADR 0069): the header "Auto-recalculate" switch (per user, this
 * browser, default On). Off: plan writes carry `defer_recalc: true` and the
 * freshness banner offers one "Recalculate now".
 */
export const AUTO_RECALC_TOOLTIP = "Off: your edits save instantly; recalculate the plan once when you're done.";

/** Points the switch at the signed-in user. Rendered once in the app shell. */
export function RecalcModeSync(): null {
  const email = useSessionStore((s) => s.me?.email ?? null);
  const setActiveEmail = useRecalcModeStore((s) => s.setActiveEmail);
  React.useEffect(() => {
    setActiveEmail(email);
  }, [email, setActiveEmail]);
  return null;
}

export function AutoRecalcSwitch(): React.JSX.Element {
  const on = useAutoRecalc();
  const setAutoRecalc = useRecalcModeStore((s) => s.setAutoRecalc);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Auto-recalculate"
          data-testid="auto-recalc-switch"
          onClick={() => setAutoRecalc(!on)}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-pill px-s2 py-1.5 text-2xs font-semibold text-text transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span
            aria-hidden="true"
            className={cn(
              'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors motion-reduce:transition-none',
              on ? 'bg-primary' : 'bg-border',
            )}
          >
            <span
              className={cn(
                'absolute size-3 rounded-full bg-surface shadow transition-transform motion-reduce:transition-none',
                on ? 'translate-x-3.5' : 'translate-x-0.5',
              )}
            />
          </span>
          <span className="hidden xl:inline">Auto-recalculate</span>
          <span className="xl:hidden">Auto</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{AUTO_RECALC_TOOLTIP}</TooltipContent>
    </Tooltip>
  );
}
