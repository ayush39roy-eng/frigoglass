import * as React from 'react';
import { Inbox } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Empty-state panel — required on every surface (ui-ux-pro-max SKILL): never a blank
 * panel. State what is missing and, where actionable, the action to fix it.
 *
 * Lottie is permitted here (one of its three sanctioned uses) — pass it via `media`,
 * wrapped in <LottieBoundary>. Default is a plain lucide icon; keep animation for
 * genuinely empty first-run states, not every filtered-to-zero table.
 */
export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Icon or <LottieBoundary>. Defaults to a neutral inbox glyph. */
  media?: React.ReactNode;
  /** Primary call to action (e.g. "Register a project"). */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  media,
  action,
  className,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center',
        className,
      )}
    >
      <div className="text-text-subtle [&_svg]:size-8" aria-hidden={media ? undefined : 'true'}>
        {media ?? <Inbox className="size-8" />}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-text">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-xs text-text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
