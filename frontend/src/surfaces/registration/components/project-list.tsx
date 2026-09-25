import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { cn } from '@/lib/utils';
import { PROJECT_TYPE_LABELS } from '@/types/enums';

import { HardGatePanel } from './hard-gate-panel';
import type { ProjectListItem } from '../api/types';
import type { ProjectStatus } from '@/types/enums';

/**
 * Row-virtualized project list (TanStack Virtual — CLAUDE.md: "Virtualize
 * any list over 100 rows … 236 projects × 14 steps is the baseline"). Every
 * cell renders a `ProjectListItem` field verbatim; `hubName`/`leaderName` are
 * an id→label join against already-fetched reference data (hubs, engineers),
 * never a computed business value (Invariant I9 is about derived numbers/
 * scores/schedule outcomes, not id→name display joins — the same kind of join
 * the Gantt does for hub names).
 */

export interface ProjectRow extends ProjectListItem {
  hubName: string;
  leaderName: string | null;
}

export interface ProjectListProps {
  rows: ProjectRow[];
  expandedId: string | null;
  onToggleExpand: (projectId: string) => void;
  onEdit: (row: ProjectRow) => void;
  onSubmit: (projectId: string, targetStatus: ProjectStatus) => Promise<unknown>;
  canEdit: boolean;
  estimateRowHeight?: number;
  maxHeight?: number;
}

export function ProjectList({
  rows,
  expandedId,
  onToggleExpand,
  onEdit,
  onSubmit,
  canEdit,
  estimateRowHeight = 44,
  maxHeight = 560,
}: ProjectListProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row && expandedId === row.id ? estimateRowHeight + 140 : estimateRowHeight;
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
        data-testid="project-list-scroll"
      >
        <div role="table" aria-label="Projects" aria-rowcount={rows.length}>
          <div
            role="row"
            className="sticky top-0 z-10 flex border-b border-border bg-surface-sunken px-2 py-2 text-2xs font-semibold text-text-muted"
          >
            <div role="columnheader" className="w-6 shrink-0" />
            <div role="columnheader" className="min-w-0 flex-[2]">
              Project
            </div>
            <div role="columnheader" className="w-32 shrink-0">
              Hub
            </div>
            <div role="columnheader" className="w-16 shrink-0">
              Cat.
            </div>
            <div role="columnheader" className="w-20 shrink-0">
              Type
            </div>
            <div role="columnheader" className="w-40 shrink-0">
              Status
            </div>
            <div role="columnheader" className="w-16 shrink-0">
              Priority
            </div>
            <div role="columnheader" className="w-10 shrink-0" />
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
                  <div
                    role="row"
                    className="flex items-center px-2 py-2 hover:bg-surface-raised"
                  >
                    <div role="cell" className="flex w-6 shrink-0 items-center justify-center">
                      <button
                        type="button"
                        className="flex items-center justify-center text-text-muted"
                        onClick={() => onToggleExpand(row.id)}
                        aria-expanded={expanded}
                        aria-label={expanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
                      >
                        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      </button>
                    </div>
                    <div role="cell" className="min-w-0 flex-[2] truncate font-medium text-text" title={row.name}>
                      {row.name}
                      {row.frozen ? (
                        <Badge tone="outline" className="ml-1.5 align-middle">
                          Frozen
                        </Badge>
                      ) : null}
                    </div>
                    <div role="cell" className="w-32 shrink-0 truncate text-text-muted" title={row.hubName}>
                      {row.hubName}
                    </div>
                    <div role="cell" className="w-16 shrink-0 text-text-muted">
                      {row.category ?? '—'}
                    </div>
                    <div role="cell" className="w-20 shrink-0 text-text-muted">
                      {row.type ? PROJECT_TYPE_LABELS[row.type] : '—'}
                    </div>
                    <div role="cell" className="w-40 shrink-0">
                      <ProjectStatusBadge status={row.status} />
                    </div>
                    <div role="cell" className="w-16 shrink-0 text-text-muted">
                      {row.priority ?? '—'}
                    </div>
                    <div role="cell" className="flex w-10 shrink-0 justify-end">
                      {canEdit ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          onClick={() => onEdit(row)}
                          aria-label={`Edit ${row.name}`}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {expanded ? (
                    <div className={cn('space-y-2 border-t border-border bg-surface px-8 py-3')}>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs text-text-muted sm:grid-cols-4">
                        <Detail label="Leader" value={row.leaderName ?? 'Unassigned'} />
                        <Detail label="Actual start week" value={row.actual_start_week?.toString() ?? '—'} />
                        <Detail label="Delay (weeks)" value={row.delay_weeks.toString()} />
                        <Detail label="Reg. year" value={row.reg_year?.toString() ?? '—'} />
                        <Detail label="Carried over" value={row.carry_over ? 'Yes' : 'No'} />
                        <Detail label="External code" value={row.external_code ?? '—'} />
                      </dl>
                      {row.status === 'Draft' ? (
                        <HardGatePanel project={row} onSubmit={onSubmit} />
                      ) : null}
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

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="font-medium text-text-subtle">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
