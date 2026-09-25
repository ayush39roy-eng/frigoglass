import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatTimestamp } from '@/lib/format';

import { redactFinancialFields } from './redact';
import type { AuditLogEntry } from '../api/types';

/**
 * Row-virtualized audit-log table (TanStack Virtual — CLAUDE.md: "Virtualize
 * any list over 100 rows"; this table is unboundedly growing, the single
 * biggest list in the app over time). Structurally the same pattern as
 * `surfaces/registration/components/project-list.tsx`: a flex-row list with
 * a per-row expand panel (here: the before/after diff), not the grid-based
 * `VirtualDataTable` (which has no room for variable-height expand content).
 *
 * Every cell renders an `AuditLogEntry` field verbatim, or an id→name join
 * against already-fetched reference data (`hubName`) — never a computed
 * business value (Invariant I9 is about derived numbers/scores/schedule
 * outcomes, not id→name display joins, the same reasoning `ProjectList`
 * documents for its own `hubName`/`leaderName` joins).
 */

export interface AuditLogRow extends AuditLogEntry {
  hubName: string | null;
}

export interface AuditLogTableProps {
  rows: AuditLogRow[];
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  estimateRowHeight?: number;
  maxHeight?: number;
}

/** First 8 hex chars of a UUID, for compact display — the full value is
 *  still in the `title` attribute for anyone who needs to copy/verify it. */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function actionTone(action: string): 'danger' | 'success' | 'warning' | 'neutral' {
  if (action.endsWith('.delete') || action.endsWith('.cancel')) return 'danger';
  if (action.endsWith('.create')) return 'success';
  if (action.endsWith('.freeze') || action.endsWith('.unfreeze') || action.endsWith('.apply'))
    return 'warning';
  return 'neutral';
}

export function AuditLogTable({
  rows,
  expandedId,
  onToggleExpand,
  estimateRowHeight = 44,
  maxHeight = 560,
}: AuditLogTableProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row && expandedId === row.id ? estimateRowHeight + 220 : estimateRowHeight;
    },
    overscan: 10,
  });

  // Expanding/collapsing a row changes its own measured size — re-measure.
  React.useEffect(() => {
    virtualizer.measure();
  }, [expandedId, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div
        ref={scrollRef}
        className="overflow-auto scrollbar-thin"
        style={{ maxHeight }}
        data-testid="audit-log-scroll"
      >
        <div role="table" aria-label="Audit log entries" aria-rowcount={rows.length}>
          <div
            role="row"
            className="sticky top-0 z-10 flex border-b border-border bg-surface-sunken px-2 py-2 text-2xs font-semibold text-text-muted"
          >
            <div role="columnheader" className="w-6 shrink-0" />
            <div role="columnheader" className="w-40 shrink-0">
              Occurred at
            </div>
            <div role="columnheader" className="w-24 shrink-0">
              Actor
            </div>
            <div role="columnheader" className="min-w-0 flex-1">
              Action
            </div>
            <div role="columnheader" className="min-w-0 flex-[1.5]">
              Entity
            </div>
            <div role="columnheader" className="w-32 shrink-0">
              Hub
            </div>
          </div>

          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              const expanded = expandedId === row.id;
              return (
                <div
                  key={row.id}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute left-0 top-0 w-full border-b border-border text-xs last:border-0"
                  style={{ transform: `translateY(${String(item.start)}px)` }}
                >
                  <div role="row" className="flex items-center px-2 py-2 hover:bg-surface-raised">
                    <div role="cell" className="flex w-6 shrink-0 items-center justify-center">
                      <button
                        type="button"
                        className="flex items-center justify-center text-text-muted"
                        onClick={() => onToggleExpand(row.id)}
                        aria-expanded={expanded}
                        aria-label={expanded ? `Collapse entry ${row.id}` : `Expand entry ${row.id}`}
                      >
                        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      </button>
                    </div>
                    <div role="cell" className="w-40 shrink-0 truncate text-text" data-numeric="">
                      {formatTimestamp(row.occurred_at)}
                    </div>
                    <div
                      role="cell"
                      className="w-24 shrink-0 truncate font-mono text-text-muted"
                      title={row.actor_user_id ?? undefined}
                    >
                      {row.actor_user_id ? shortId(row.actor_user_id) : 'System'}
                    </div>
                    <div role="cell" className="min-w-0 flex-1">
                      <Badge tone={actionTone(row.action)}>{row.action}</Badge>
                    </div>
                    <div role="cell" className="min-w-0 flex-[1.5] truncate" title={row.entity_id}>
                      <span className="text-text-muted">{row.entity_type}</span>{' '}
                      <span className="font-mono text-text">{shortId(row.entity_id)}</span>
                    </div>
                    <div role="cell" className="w-32 shrink-0 truncate text-text-muted">
                      {row.hubName ?? (row.hub_id ? shortId(row.hub_id) : '—')}
                    </div>
                  </div>

                  {expanded ? <AuditLogRowDetail row={row} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function AuditLogRowDetail({ row }: { row: AuditLogRow }): React.JSX.Element {
  const before = React.useMemo(() => redactFinancialFields(row.before_state), [row.before_state]);
  const after = React.useMemo(() => redactFinancialFields(row.after_state), [row.after_state]);

  return (
    <div className={cn('space-y-3 border-t border-border bg-surface px-8 py-3')}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs text-text-muted sm:grid-cols-4">
        <Detail label="Actor user ID" value={row.actor_user_id ?? 'System'} />
        <Detail label="Request ID" value={row.request_id ?? '—'} />
        <Detail label="IP address" value={row.ip_address ?? '—'} />
        <Detail label="Notes" value={row.notes ?? '—'} />
      </dl>
      <div className="grid gap-3 sm:grid-cols-2">
        <JsonPanel label="Before" value={before} />
        <JsonPanel label="After" value={after} />
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="font-medium text-text-subtle">{label}</dt>
      <dd className="truncate" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Renders a redacted JSONB snapshot as plain, escaped text (`<pre>{...}</pre>`
 * — React text children are always escaped; this is NOT
 * `dangerouslySetInnerHTML`, which CLAUDE.md forbids outright). `null` means
 * "not recorded for this action" (e.g. a pure create has no `before_state`),
 * not an error.
 */
function JsonPanel({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded border border-border bg-surface-sunken p-2">
      <p className="mb-1 text-2xs font-semibold text-text-muted">{label}</p>
      {value === null ? (
        <p className="text-2xs text-text-subtle">Not recorded</p>
      ) : (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-2xs text-text">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}
