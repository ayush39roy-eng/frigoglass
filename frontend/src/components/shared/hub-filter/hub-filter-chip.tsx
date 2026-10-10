import * as React from 'react';
import { Building2, X } from 'lucide-react';

import { useHubs } from '@/lib/api/reference';
import { cn } from '@/lib/utils';
import { useHubFilter } from '@/stores/hub-filter';

/**
 * "Hub: <name>" with a clear button (ADR 0020 §2). Sits in the header of every
 * page that follows the global hub filter, so a filtered figure is never
 * mistaken for the portfolio total. Renders nothing under "All hubs".
 */
export function HubFilterChip({ className }: { className?: string }): React.JSX.Element | null {
  const { hubId, setHubId } = useHubFilter();
  const hubsQuery = useHubs();
  if (hubId === null) return null;
  const name = hubsQuery.data?.find((h) => h.id === hubId)?.name ?? 'selected hub';

  return (
    <span
      className={cn(
        'inline-flex h-8 max-w-full items-center gap-1.5 rounded-pill border-[1.5px] border-primary/40 bg-primary-subtle pl-s3 pr-1 text-2xs font-semibold text-primary-subtle-fg',
        className,
      )}
      data-testid="hub-filter-chip"
    >
      <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">Hub: {name}</span>
      <button
        type="button"
        onClick={() => setHubId(null)}
        aria-label={`Clear hub filter (${name})`}
        title="Show all hubs"
        className="grid size-6 shrink-0 place-items-center rounded-full transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}
