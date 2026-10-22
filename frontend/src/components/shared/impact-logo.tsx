import * as React from 'react';

import impactWordmark from '@/assets/impact-wordmark.png';
import { cn } from '@/lib/utils';

/**
 * The client's "impact" programme mark (owner ask 2026-10-23), the brand of
 * the VIP board: its three pillars are Innovation, Market Expansion and
 * Performance (`VIP_PILLARS`). The wordmark is the client's artwork; the
 * tagline is live text. It sits on a white chip so the black "imp" stays
 * legible in dark mode.
 */
export function ImpactLogo({
  className,
  tagline = true,
  size = 'md',
}: {
  className?: string;
  tagline?: boolean;
  size?: 'sm' | 'md';
}): React.JSX.Element {
  return (
    <span
      className={cn('inline-flex flex-col items-start gap-0.5 rounded-lg bg-white px-2 py-1', className)}
      data-testid="impact-logo"
    >
      <img
        src={impactWordmark}
        alt="impact"
        className={cn('w-auto select-none', size === 'sm' ? 'h-4' : 'h-6')}
        draggable={false}
      />
      {tagline ? (
        <span className="whitespace-nowrap text-[0.5625rem] font-medium leading-none tracking-wide text-slate-500">
          Innovation <span className="text-[#3a5df6]">•</span> Market Expansion{' '}
          <span className="text-[#3a5df6]">•</span> Performance
        </span>
      ) : null}
    </span>
  );
}
