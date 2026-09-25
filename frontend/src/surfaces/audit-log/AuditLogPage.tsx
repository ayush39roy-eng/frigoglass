import * as React from 'react';
import { ChevronLeft, ChevronRight, FilterX } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { useHubs } from '@/lib/api/reference';
import { formatInteger } from '@/lib/format';
import { SURFACES } from '@/app/nav';

import { AccessNotice } from './components/access-notice';
import { AuditLogTable, type AuditLogRow } from './components/audit-log-table';
import { useAuditLog } from './hooks/use-audit-log';
import { useDebouncedValue } from './hooks/use-debounced-value';

const AUDIT_LOG_SURFACE = SURFACES.find((s) => s.path === '/audit-log');
const ALL = '__all__';
const PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authKind(error: unknown): 'forbidden' | 'unauthorized' | null {
  if (error instanceof ApiError && error.isForbidden) return 'forbidden';
  if (error instanceof ApiError && error.isUnauthorized) return 'unauthorized';
  return null;
}

/** `<input type="date">` gives a bare `YYYY-MM-DD` — widen it to an inclusive
 *  day boundary in UTC before sending it as `occurred_from`/`occurred_to`
 *  (`AuditLogEntry.occurred_at` is `DateTime(timezone=True)`, compared with
 *  `>=`/`<=` server-side — see `backend/api/routers/audit_log.py`). */
function startOfDayUtc(dateStr: string): string {
  return `${dateStr}T00:00:00.000Z`;
}
function endOfDayUtc(dateStr: string): string {
  return `${dateStr}T23:59:59.999Z`;
}

export default function AuditLogPage(): React.JSX.Element {
  const [entityType, setEntityType] = React.useState('');
  const [entityId, setEntityId] = React.useState('');
  const [actorUserId, setActorUserId] = React.useState('');
  const [action, setAction] = React.useState('');
  const [hubId, setHubId] = React.useState<string>(ALL);
  const [occurredFrom, setOccurredFrom] = React.useState('');
  const [occurredTo, setOccurredTo] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const debouncedEntityType = useDebouncedValue(entityType.trim());
  const debouncedEntityId = useDebouncedValue(entityId.trim());
  const debouncedActorUserId = useDebouncedValue(actorUserId.trim());
  const debouncedAction = useDebouncedValue(action.trim());

  const actorUserIdValid = debouncedActorUserId === '' || UUID_RE.test(debouncedActorUserId);
  const actorFilterShown = actorUserId.trim() !== '' && !actorUserIdValid;

  const hubsQuery = useHubs();

  // Reset to the first page whenever a filter changes, so a caller never
  // lands on an out-of-range offset for the new filtered result set.
  // Deliberately NOT a `useEffect` (React's own "you might not need an
  // effect" guidance, enforced here by `react-hooks/set-state-in-effect`):
  // adjusting state in response to a prop/state change during render is the
  // endorsed pattern — compare against the previous filter key and, if it
  // changed, call `setOffset` synchronously in the render body (React bails
  // out of the in-progress render and re-renders immediately with the reset
  // value, before anything commits or paints, so this never produces a
  // stale first frame).
  const filterKey = JSON.stringify([
    debouncedEntityType,
    debouncedEntityId,
    debouncedActorUserId,
    debouncedAction,
    hubId,
    occurredFrom,
    occurredTo,
  ]);
  const [prevFilterKey, setPrevFilterKey] = React.useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    setOffset(0);
  }

  const listQuery = useAuditLog({
    entity_type: debouncedEntityType || undefined,
    entity_id: debouncedEntityId || undefined,
    actor_user_id: actorUserIdValid && debouncedActorUserId ? debouncedActorUserId : undefined,
    action: debouncedAction || undefined,
    hub_id: hubId === ALL ? undefined : hubId,
    occurred_from: occurredFrom ? startOfDayUtc(occurredFrom) : undefined,
    occurred_to: occurredTo ? endOfDayUtc(occurredTo) : undefined,
    limit: PAGE_SIZE,
    offset,
  });

  const title = AUDIT_LOG_SURFACE?.title ?? 'Audit Log';
  const description =
    AUDIT_LOG_SURFACE?.summary ??
    'Read-only, filterable view of every mutation recorded in the immutable append-only audit log.';

  const denied = authKind(listQuery.error);
  const isFiltered =
    entityType !== '' ||
    entityId !== '' ||
    actorUserId !== '' ||
    action !== '' ||
    hubId !== ALL ||
    occurredFrom !== '' ||
    occurredTo !== '';

  const hubNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubsQuery.data ?? []) map.set(h.id, h.name);
    return map;
  }, [hubsQuery.data]);

  const rows = React.useMemo<AuditLogRow[]>(
    () =>
      (listQuery.data?.items ?? []).map((entry) => ({
        ...entry,
        hubName: entry.hub_id ? (hubNameById.get(entry.hub_id) ?? null) : null,
      })),
    [listQuery.data, hubNameById],
  );

  const totalCount = listQuery.data?.total_count ?? 0;
  const rangeStart = totalCount === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, totalCount);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < totalCount;

  const handleClear = React.useCallback(() => {
    setEntityType('');
    setEntityId('');
    setActorUserId('');
    setAction('');
    setHubId(ALL);
    setOccurredFrom('');
    setOccurredTo('');
  }, []);

  return (
    <>
      <PageHeader title={title} description={description} />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Filters</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-4">
              <TextFilter label="Entity type" value={entityType} onChange={setEntityType} placeholder="Project" />
              <TextFilter label="Entity ID" value={entityId} onChange={setEntityId} placeholder="UUID" />
              <div className="flex flex-col gap-1">
                <TextFilter
                  label="Actor user ID"
                  value={actorUserId}
                  onChange={setActorUserId}
                  placeholder="UUID"
                  invalid={actorFilterShown}
                />
                {actorFilterShown ? (
                  <p className="max-w-40 text-2xs text-danger">Must be a valid UUID — ignored until then.</p>
                ) : null}
              </div>
              <TextFilter label="Action" value={action} onChange={setAction} placeholder="project.update" />
              <div className="flex flex-col gap-1">
                <Label htmlFor="audit-hub-filter" className="text-2xs text-text-muted">
                  Hub
                </Label>
                <Select value={hubId} onValueChange={setHubId}>
                  <SelectTrigger id="audit-hub-filter" className="h-8 w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All</SelectItem>
                    {(hubsQuery.data ?? []).map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="audit-from" className="text-2xs text-text-muted">
                  From
                </Label>
                <Input
                  id="audit-from"
                  type="date"
                  className="h-8 w-36"
                  value={occurredFrom}
                  onChange={(e) => setOccurredFrom(e.target.value)}
                  max={occurredTo || undefined}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="audit-to" className="text-2xs text-text-muted">
                  To
                </Label>
                <Input
                  id="audit-to"
                  type="date"
                  className="h-8 w-36"
                  value={occurredTo}
                  onChange={(e) => setOccurredTo(e.target.value)}
                  min={occurredFrom || undefined}
                />
              </div>
              {isFiltered ? (
                <Button variant="ghost" size="sm" onClick={handleClear}>
                  <FilterX />
                  Clear
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <SectionBoundary
            query={listQuery}
            title="Audit log"
            errorDescription="The audit log could not be loaded."
          >
            {() => (
              <Card>
                <CardHeader>
                  <CardTitle>Audit log</CardTitle>
                  <span className="text-2xs text-text-muted" data-numeric="">
                    {totalCount === 0
                      ? '0 entries'
                      : `${formatInteger(rangeStart)}–${formatInteger(rangeEnd)} of ${formatInteger(totalCount)}`}
                  </span>
                </CardHeader>
                <CardContent className="space-y-3">
                  {rows.length === 0 ? (
                    <EmptyState
                      title={isFiltered ? 'No audit entries match these filters' : 'No audit entries recorded yet'}
                      description={
                        isFiltered
                          ? 'Try widening or clearing the filters.'
                          : 'Every mutation across the app writes an entry here as soon as one occurs.'
                      }
                    />
                  ) : (
                    <>
                      <AuditLogTable
                        rows={rows}
                        expandedId={expandedId}
                        onToggleExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
                      />
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={!hasPrev}
                          onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                        >
                          <ChevronLeft />
                          Previous
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={!hasNext}
                          onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
                        >
                          Next
                          <ChevronRight />
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </SectionBoundary>
        </div>
      )}
    </>
  );
}

function TextFilter({
  label,
  value,
  onChange,
  placeholder,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  invalid?: boolean;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-2xs text-text-muted">
        {label}
      </Label>
      <Input
        id={id}
        className="h-8 w-40"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid ? 'true' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
