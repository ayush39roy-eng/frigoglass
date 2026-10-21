import * as React from 'react';
import { RotateCw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { useRetryCountdown, type WhatIfErrorInfo } from '../use-whatif';

/**
 * A failed what-if call, in words. A 429 shows a live `Retry-After` countdown
 * and keeps Retry disabled until it reaches zero. The announcement is the
 * alert itself; the ticking number is not re-announced every second.
 */
export function WhatIfErrorNotice({
  info,
  errorToken,
  onRetry,
  retryLabel = 'Try again',
}: {
  info: WhatIfErrorInfo;
  /** Changes on each new failure, restarting the countdown. */
  errorToken: unknown;
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
}): React.JSX.Element {
  const left = useRetryCountdown(info.retryAfterSeconds ?? null, errorToken);
  const waiting = info.kind === 'rate_limited' && info.retryAfterSeconds !== undefined && left > 0;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-s3 rounded-md border border-warning/50 bg-warning-subtle px-s4 py-s3 text-xs text-warning-subtle-fg"
      data-testid="whatif-error"
      data-error-kind={info.kind}
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{info.message}</span>
      {waiting ? (
        <span className="font-mono tabular-nums" data-testid="whatif-countdown" aria-hidden="true">
          {left} s
        </span>
      ) : null}
      {info.retryable && onRetry ? (
        <Button type="button" size="sm" variant="secondary" disabled={waiting} onClick={onRetry}>
          <RotateCw />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
