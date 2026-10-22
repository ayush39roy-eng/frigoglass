import * as React from 'react';
import { Star } from 'lucide-react';

import { useSetProjectVip } from '@/lib/api/vip';
import { cn } from '@/lib/utils';
import type { Id } from '@/types/common';

/**
 * The VIP pin control (ADR 0040), same look as the Matrix scoring grid's:
 * outline star = not VIP, filled accent star = VIP. It calls
 * `PUT /projects/{id}/vip` through `useSetProjectVip()`; the server
 * authorises and audits the write, and a refusal shows in the button title.
 *
 * Without write rights (`canPin` false) a VIP project shows a filled star
 * mark only, and a non-VIP project shows nothing.
 */
export function VipToggle({
  projectId,
  projectName,
  isVip,
  canPin,
  className,
}: {
  projectId: Id;
  projectName: string;
  isVip: boolean;
  canPin: boolean;
  className?: string;
}): React.JSX.Element | null {
  const setVip = useSetProjectVip();
  if (!canPin && !isVip) return null;
  if (!canPin) {
    return (
      <span
        className={cn('grid size-6 shrink-0 place-items-center text-accent', className)}
        title="VIP project"
        data-testid="vip-mark"
      >
        <Star className="size-3.5 fill-current" aria-hidden="true" />
        <span className="sr-only">VIP</span>
      </span>
    );
  }
  const label = isVip ? `Remove VIP from ${projectName}` : `Make ${projectName} VIP`;
  const failed = setVip.isError ? ' (the last change was refused: you need edit rights on this project)' : '';
  return (
    <button
      type="button"
      aria-pressed={isVip}
      aria-label={label}
      title={label + failed}
      disabled={setVip.isPending}
      onClick={() => setVip.mutate({ projectId, isVip: !isVip })}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        isVip ? 'text-accent hover:bg-accent/12' : 'text-text-subtle hover:bg-surface-sunken hover:text-accent',
        setVip.isError && 'text-danger',
        className,
      )}
      data-testid="vip-toggle"
    >
      <Star className={cn('size-3.5', isVip && 'fill-current')} aria-hidden="true" />
    </button>
  );
}
