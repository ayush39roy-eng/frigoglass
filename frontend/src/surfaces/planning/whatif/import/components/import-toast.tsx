import * as React from 'react';
import { CircleCheck, X } from 'lucide-react';

import { cn } from '@/lib/utils';

import { useImportToast } from '../toast-store';

/**
 * P41: the plan import's success toast ("Scenario saved", "Format saved"). A non-modal
 * panel, bottom-right, the same shape as the register-save and deactivation panels; it
 * closes itself after a few seconds, on Escape or with its close button.
 */

const TOAST_MS = 6_000;

export function ImportToast(): React.JSX.Element | null {
  const message = useImportToast((s) => s.message);
  const nonce = useImportToast((s) => s.nonce);
  const dismiss = useImportToast((s) => s.dismiss);
  React.useEffect(() => {
    if (message === null) return undefined;
    const t = window.setTimeout(dismiss, TOAST_MS);
    return () => window.clearTimeout(t);
  }, [message, nonce, dismiss]);
  React.useEffect(() => () => dismiss(), [dismiss]);
  if (message === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-4 right-4 z-40 flex w-[min(24rem,calc(100vw-2rem))] items-start gap-2',
        'rounded-dash border-[1.5px] border-dash-hairline bg-surface p-3 text-sm text-text shadow-pop',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2',
      )}
      data-testid="import-toast"
      onKeyDown={(e) => {
        if (e.key === 'Escape') dismiss();
      }}
    >
      <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      <p className="min-w-0 flex-1">{message}</p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Close"
        className="rounded p-0.5 text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
