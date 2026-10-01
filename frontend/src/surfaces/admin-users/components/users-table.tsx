import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link2, Pencil } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { UserRead } from '../api/types';
import { hubScopeLabel } from '../lib/user-helpers';

/**
 * Row-virtualized users table (TanStack Virtual — CLAUDE.md: virtualize any
 * list over 100 rows; a Frigoglass tenant can easily exceed that). Every cell
 * renders a `UserRead` field verbatim; the hub-scope label is an id→name
 * display join against already-fetched reference data.
 */
export interface UsersTableProps {
  rows: UserRead[];
  hubNameById: ReadonlyMap<string, string>;
  canWrite: boolean;
  /** Whether the CALLER may edit this particular user (Admin cannot touch
   *  Admin / Super Admin accounts — ADR 0010 §1). */
  canManage: (user: UserRead) => boolean;
  onEdit: (user: UserRead) => void;
  maxHeight?: number;
}

export function UsersTable({
  rows,
  hubNameById,
  canWrite,
  canManage,
  onEdit,
  maxHeight = 560,
}: UsersTableProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 10,
  });
  const items = virtualizer.getVirtualItems();

  return (
    <div className="overflow-hidden rounded-dash border-[1.5px] border-border bg-surface">
      <div ref={scrollRef} className="overflow-auto scrollbar-thin" style={{ maxHeight }} data-testid="users-table-scroll">
        <div role="table" aria-label="Users" aria-rowcount={rows.length}>
          <div
            role="row"
            className="sticky top-0 z-10 flex gap-3 border-b-[1.5px] border-border bg-surface-sunken px-5 py-3 text-2xs font-bold uppercase tracking-wider text-text-subtle"
          >
            <div role="columnheader" className="min-w-0 flex-[2]">
              Email
            </div>
            <div role="columnheader" className="min-w-0 flex-[2]">
              Name
            </div>
            <div role="columnheader" className="min-w-0 flex-[3]">
              Roles
            </div>
            <div role="columnheader" className="min-w-0 flex-[2]">
              Hub scope
            </div>
            <div role="columnheader" className="w-20 shrink-0">
              Active
            </div>
            <div role="columnheader" className="w-16 shrink-0">
              OIDC
            </div>
            {canWrite ? <div role="columnheader" className="w-10 shrink-0" /> : null}
          </div>

          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              const manageable = canManage(row);
              return (
                <div
                  key={row.id}
                  role="row"
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  data-testid="user-row"
                  className={cn(
                    'absolute left-0 top-0 flex w-full items-center gap-3 border-b border-border/70 px-5 py-3 text-sm transition-colors last:border-0 hover:bg-primary-subtle/40',
                    !row.is_active && 'text-text-muted',
                  )}
                  style={{ transform: `translateY(${String(item.start)}px)` }}
                >
                  <div role="cell" className="flex min-w-0 flex-[2] items-center gap-3" title={row.email}>
                    <span
                      aria-hidden="true"
                      className={cn(
                        'grid size-9 shrink-0 place-items-center rounded-full text-2xs font-bold',
                        row.roles.includes('Super Admin') || row.roles.includes('Admin')
                          ? 'bg-ink text-ink-fg'
                          : 'bg-primary-subtle text-primary-subtle-fg',
                      )}
                    >
                      {initials(row.full_name || row.email)}
                    </span>
                    <span className="truncate font-semibold text-text">{row.email}</span>
                  </div>
                  <div role="cell" className="min-w-0 flex-[2] truncate" title={row.full_name}>
                    {row.full_name}
                  </div>
                  <div role="cell" className="flex min-w-0 flex-[3] flex-wrap gap-1">
                    {row.roles.length === 0 ? (
                      <span className="text-text-subtle">No roles</span>
                    ) : (
                      row.roles.map((r) => (
                        <Badge key={r} tone={r === 'Super Admin' ? 'primary' : r === 'Admin' ? 'outline' : 'neutral'}>
                          {r}
                        </Badge>
                      ))
                    )}
                  </div>
                  <div role="cell" className="min-w-0 flex-[2] truncate" title={hubScopeLabel(row, hubNameById)}>
                    {hubScopeLabel(row, hubNameById)}
                  </div>
                  <div role="cell" className="w-20 shrink-0">
                    {row.is_active ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="neutral">Inactive</Badge>
                    )}
                  </div>
                  <div role="cell" className="w-16 shrink-0">
                    {row.oidc_linked ? (
                      <Badge tone="outline" title="Linked to the organisation's identity provider">
                        <Link2 aria-hidden="true" />
                        SSO
                      </Badge>
                    ) : (
                      <span className="text-2xs text-text-subtle">—</span>
                    )}
                  </div>
                  {canWrite ? (
                    <div role="cell" className="flex w-10 shrink-0 justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 rounded-full"
                        disabled={!manageable}
                        title={
                          manageable
                            ? undefined
                            : 'Only a Super Admin can change an Admin or Super Admin account'
                        }
                        onClick={() => onEdit(row)}
                        aria-label={`Edit ${row.email}`}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s.@]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase() || '?';
}
