import * as React from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Error-state panel — required on every surface (ui-ux-pro-max SKILL): state what
 * failed and whether it is retryable. Never a bare "Something went wrong."
 */
export interface ErrorStateProps {
  title?: string;
  description: string;
  /** Provide to show a Retry button (e.g. TanStack Query's `refetch`). */
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = 'Could not load this data',
  description,
  onRetry,
  className,
}: ErrorStateProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-danger-subtle bg-danger-subtle/40 px-6 py-12 text-center',
        className,
      )}
    >
      <TriangleAlert className="size-8 text-danger" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-text">{title}</p>
        <p className="mx-auto max-w-sm text-xs text-text-muted">{description}</p>
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw />
          Retry
        </Button>
      ) : null}
    </div>
  );
}
