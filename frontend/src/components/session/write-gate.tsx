import * as React from 'react';
import { Lock } from 'lucide-react';

import { cn } from '@/lib/utils';
import { usePermission } from '@/stores/session';
import type { SurfaceKey } from '@/types/enums';

/**
 * Write-control gating on the server-declared permission table (ADR 0010 §2).
 *
 * `<WriteGate surface>` renders its children only when the session holds
 * `write` on that surface; otherwise `fallback` (default: nothing). Pair it
 * with `<ReadOnlyNotice surface>` once per surface so a read-only role sees
 * WHY the controls are missing rather than an unexplained gap.
 *
 * This is convenience, not security — the API still enforces every write.
 * Surfaces additionally keep their existing "403 → downgrade" path so a
 * server that disagrees with the table still wins.
 */
export function WriteGate({
  surface,
  children,
  fallback = null,
}: {
  surface: SurfaceKey;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}): React.JSX.Element {
  const { write } = usePermission(surface);
  return <>{write ? children : fallback}</>;
}

/** Compact, single-line read-only notice — the `access-notice.tsx` pattern
 *  every surface already uses, but driven by the session table rather than a
 *  rejected write. Renders nothing when the role CAN write. */
export function ReadOnlyNotice({
  surface,
  what = 'Editing',
  className,
}: {
  surface: SurfaceKey;
  /** What is withheld, e.g. "Freezing projects". */
  what?: string;
  className?: string;
}): React.JSX.Element | null {
  const { write } = usePermission(surface);
  if (write) return null;
  return (
    <div
      role="status"
      data-testid="read-only-notice"
      className={cn(
        'flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-2xs text-text-muted',
        className,
      )}
    >
      <Lock className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        <span className="font-medium text-text">Read-only for your role.</span> {what} is not
        available to you on this surface.
      </span>
    </div>
  );
}
