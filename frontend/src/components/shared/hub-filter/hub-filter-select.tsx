import * as React from 'react';
import { Building2 } from 'lucide-react';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useHubs } from '@/lib/api/reference';
import { cn } from '@/lib/utils';
import { useHubFilter } from '@/stores/hub-filter';
import { useSessionStore } from '@/stores/session';

import { hubsInScope, shouldResetHub } from './hub-scope';

/** Radix Select needs a non-empty value for the "All hubs" item. */
const ALL = '__all_hubs__';

/**
 * The global hub filter in the app header (ADR 0020, P12-T04): "All hubs" plus
 * every hub in the caller's scope. The choice lives in `stores/hub-filter.ts`
 * (persisted per browser); every portfolio surface reads it and sends
 * `hub_id`. A persisted hub that is no longer in scope resets to "All hubs".
 */
export function HubFilterSelect({ className }: { className?: string }): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const hubsQuery = useHubs();
  const { hubId, setHubId } = useHubFilter();
  const id = React.useId();

  const options = React.useMemo(() => hubsInScope(me, hubsQuery.data), [me, hubsQuery.data]);

  React.useEffect(() => {
    if (shouldResetHub(hubId, options)) setHubId(null);
  }, [hubId, options, setHubId]);

  const value = hubId ?? ALL;
  // Explicit trigger text: while the hub list loads, a persisted id has no
  // matching item yet, and Radix would otherwise print nothing.
  const label =
    hubId === null ? 'All hubs' : (hubsQuery.data?.find((h) => h.id === hubId)?.name ?? 'Selected hub');

  return (
    <div className={cn('flex min-w-0 items-center', className)} data-testid="hub-filter">
      <Label htmlFor={id} className="sr-only">
        Hub filter
      </Label>
      <Select value={value} onValueChange={(next) => setHubId(next === ALL ? null : next)}>
        <SelectTrigger
          id={id}
          className={cn(
            'h-8 w-auto min-w-0 max-w-[8.5rem] gap-1.5 rounded-pill border-transparent bg-transparent px-s3 text-2xs font-semibold sm:max-w-44',
            'hover:bg-surface-sunken',
            value !== ALL && 'bg-primary-subtle text-primary-subtle-fg hover:bg-primary-subtle',
          )}
        >
          <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">
            <SelectValue>{label}</SelectValue>
          </span>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={ALL}>All hubs</SelectItem>
          {(options ?? []).map((h) => (
            <SelectItem key={h.id} value={h.id}>
              {h.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
