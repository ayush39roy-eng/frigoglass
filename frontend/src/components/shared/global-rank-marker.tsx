import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * P60 (ADR 0068): the small muted "G16" next to a hub rank — the served global
 * `band_rank`, shown only when no hub filter is active. The full text is in the
 * rank's tooltip, so this marker is hidden from assistive tech.
 */
export function GlobalRankMarker({
  bandRank,
  hidden,
  className,
}: {
  bandRank: number | null | undefined;
  /** A hub filter is active: show nothing. */
  hidden: boolean;
  className?: string;
}): React.JSX.Element | null {
  if (hidden || typeof bandRank !== 'number') return null;
  return (
    <span
      className={cn('shrink-0 font-mono text-[0.625rem] leading-none tabular-nums text-text-subtle', className)}
      aria-hidden="true"
      data-numeric=""
      data-testid="global-rank-marker"
    >
      G{bandRank}
    </span>
  );
}
