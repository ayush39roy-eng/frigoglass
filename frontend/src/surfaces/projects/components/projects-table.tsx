import * as React from 'react';
import { Link } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FolderKanban, FolderOpen, Pencil } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { CategoryTag } from '@/components/ui/category-tag';
import { EntityCell } from '@/components/ui/table-cells';
import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { VipBadge } from '@/components/shared/vip-badge';
import { categoricalRankSoftBg, categoricalRankText, categoryRank } from '@/lib/categorical-palette';
import { formatInteger, formatPlanWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PROJECT_TYPE_LABELS } from '@/types/enums';

import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';

/**
 * P22-T01: the Projects page list view. Row-virtualized (TanStack Virtual,
 * CLAUDE.md: any list over 100 rows; 236 projects is the baseline). Every cell
 * prints one served field of `GET /dashboard/projects` (I9). `#` is the row's
 * position in the served order, a display ordinal only.
 *
 * Its own small table rather than the Dashboard's `VirtualDataTable` because
 * the merged page needs two things that one does not do: the "Edit
 * registration" action opens the drawer in place (a button, so focus returns
 * to it), and a just-saved row is highlighted and scrolled into view.
 */

export interface ProjectsTableProps {
  rows: ProjectFilterRow[];
  /** Show "Edit registration" (Registration write; the server still decides). */
  canEdit: boolean;
  onEdit: (row: ProjectFilterRow, trigger: HTMLElement) => void;
  /** The project to highlight (just created or updated). */
  highlightId: string | null;
  highlightLabel?: string;
  maxHeight?: number;
}

interface Column {
  id: string;
  header: string;
  width: string;
  align?: 'left' | 'right' | 'center';
  cell: (row: ProjectFilterRow, index: number) => React.ReactNode;
}

const ALIGN: Record<NonNullable<Column['align']>, string> = {
  left: 'justify-start text-left',
  right: 'justify-end text-right',
  center: 'justify-center text-center',
};

const DASH = <span className="text-text-subtle">—</span>;

const ACTION =
  'inline-flex h-7 items-center gap-1 rounded-pill border-[1.5px] px-2 text-2xs font-semibold transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5';

const ROW_HEIGHT = 60;

export function ProjectsTable({
  rows,
  canEdit,
  onEdit,
  highlightId,
  highlightLabel = 'Saved',
  maxHeight = 640,
}: ProjectsTableProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const columns = React.useMemo<Column[]>(
    () => [
      {
        id: 'ordinal',
        header: '#',
        width: '2.5rem',
        align: 'right',
        cell: (_row, index) => (
          <span className="text-xs font-semibold tabular-nums text-text-subtle" data-numeric="">
            {formatInteger(index + 1)}
          </span>
        ),
      },
      {
        id: 'project',
        header: 'Project',
        width: 'minmax(12rem, 2.2fr)',
        cell: (row) => {
          const rank = row.category ? categoryRank(row.category) : 9;
          return (
            <span className="flex min-w-0 items-center gap-2">
              <EntityCell
                icon={FolderKanban}
                iconClassName={cn(categoricalRankSoftBg(rank), categoricalRankText(rank))}
                title={row.project_name}
                titleAttr={`${row.project_name} — open in Project Workspace`}
                to={`/projects/${row.project_id}`}
                subtitle={row.external_code ?? undefined}
              />
              {row.is_vip ? <VipBadge /> : null}
              {row.project_id === highlightId ? (
                <Badge tone="primary" data-testid="row-highlight-badge">
                  {highlightLabel}
                </Badge>
              ) : null}
            </span>
          );
        },
      },
      {
        id: 'hub',
        header: 'Hub',
        width: 'minmax(7rem, 0.9fr)',
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-1.5" title={`${row.hub} · ${row.region}`}>
            <CountryFlag region={row.region} />
            <span className="truncate text-xs font-semibold text-text">{row.hub}</span>
          </span>
        ),
      },
      {
        id: 'category',
        header: 'Cat',
        width: '3.5rem',
        align: 'center',
        cell: (row) => (row.category ? <CategoryTag category={row.category} /> : DASH),
      },
      {
        id: 'type',
        header: 'Type',
        width: '3.25rem',
        align: 'center',
        cell: (row) =>
          row.type ? (
            <span className="text-xs font-bold text-text" title={PROJECT_TYPE_LABELS[row.type]}>
              {row.type}
            </span>
          ) : (
            DASH
          ),
      },
      {
        id: 'status',
        header: 'Status',
        width: 'minmax(7.5rem, 1fr)',
        cell: (row) => <ProjectStatusBadge status={row.status} />,
      },
      {
        id: 'leader',
        header: 'Leader',
        width: 'minmax(6rem, 0.8fr)',
        // ADR 0028: names are served; the fallback is only for an id with no name.
        cell: (row) =>
          row.leader_name ? (
            <span className="truncate text-xs font-medium text-text">{row.leader_name}</span>
          ) : row.leader_engineer_id ? (
            <span className="text-xs italic text-text-subtle" title="Leader name unavailable">
              Name unavailable
            </span>
          ) : (
            DASH
          ),
      },
      {
        id: 'end-week',
        header: 'End wk',
        width: '4.75rem',
        align: 'center',
        // ADR 0024: a finish past W52 prints as "After W52"; the week is served.
        cell: (row) =>
          row.end_week !== null ? (
            <span className="text-xs font-semibold tabular-nums text-text" data-numeric="">
              {formatPlanWeek(row.end_week)}
            </span>
          ) : (
            DASH
          ),
      },
      {
        id: 'current-step',
        header: 'Current step',
        width: 'minmax(7.5rem, 1.1fr)',
        cell: (row) =>
          row.current_step_code ? (
            <span className="min-w-0" title={row.current_step_name ?? row.current_step_code}>
              <span className="block truncate text-xs font-semibold text-text">{row.current_step_code}</span>
              {row.current_step_name ? (
                <span className="block truncate text-2xs text-text-subtle">{row.current_step_name}</span>
              ) : null}
            </span>
          ) : (
            DASH
          ),
      },
      {
        id: 'priority',
        header: 'Priority',
        width: '5.5rem',
        align: 'center',
        cell: (row) =>
          row.priority || row.priority_rank ? (
            <span className="inline-flex items-center gap-1">
              {row.priority ? <PriorityBandPill priority={row.priority} /> : null}
              {row.priority_rank ? (
                <span
                  className="text-2xs font-semibold tabular-nums text-text-subtle"
                  title="Rank by score within the filtered set"
                  data-numeric=""
                >
                  #{formatInteger(row.priority_rank)}
                </span>
              ) : null}
            </span>
          ) : (
            DASH
          ),
      },
      {
        id: 'actions',
        header: 'Actions',
        width: canEdit ? '8.5rem' : '4.75rem',
        align: 'right',
        cell: (row) => (
          <span className="inline-flex items-center gap-1">
            <Link
              to={`/projects/${row.project_id}`}
              aria-label={`Open ${row.project_name}`}
              className={cn(ACTION, 'border-dash-hairline bg-surface text-text hover:bg-surface-sunken')}
            >
              <FolderOpen aria-hidden="true" />
              Open
            </Link>
            {canEdit ? (
              <button
                type="button"
                // Visible "Edit" is the start of the accessible name (label in name).
                aria-label={`Edit registration of ${row.project_name}`}
                title="Edit registration"
                onClick={(event) => onEdit(row, event.currentTarget)}
                className={cn(ACTION, 'border-primary/30 bg-primary-subtle text-primary-subtle-fg hover:bg-primary-subtle/70')}
              >
                <Pencil aria-hidden="true" />
                Edit
              </button>
            ) : null}
          </span>
        ),
      },
    ],
    [canEdit, onEdit, highlightId, highlightLabel],
  );

  const gridTemplate = columns.map((c) => c.width).join(' ');

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Bring a just-saved row into view (instant: no smooth scrolling to respect
  // reduced motion without a second code path).
  const highlightIndex = highlightId === null ? -1 : rows.findIndex((r) => r.project_id === highlightId);
  React.useEffect(() => {
    if (highlightIndex >= 0) virtualizer.scrollToIndex(highlightIndex, { align: 'center' });
  }, [highlightIndex, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      className="overflow-auto scrollbar-thin rounded-lg border border-border"
      style={{ maxHeight }}
      data-testid="projects-table-scroll"
      tabIndex={0}
      aria-label="Projects list, scrollable"
      role="region"
    >
      <div role="table" aria-label="Projects" aria-rowcount={rows.length + 1} className="min-w-[75rem]">
        <div role="rowgroup">
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-10 grid items-center gap-2 border-b-[1.5px] border-transparent bg-ink px-4 py-3 text-2xs font-bold uppercase tracking-wider text-ink-fg"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {columns.map((col) => (
              <div key={col.id} role="columnheader" className={cn('flex items-center', ALIGN[col.align ?? 'left'])}>
                {col.header}
              </div>
            ))}
          </div>
        </div>

        <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            const highlighted = row.project_id === highlightId;
            return (
              <div
                key={row.project_id}
                role="row"
                aria-rowindex={item.index + 2}
                data-index={item.index}
                data-highlighted={highlighted ? '' : undefined}
                ref={virtualizer.measureElement}
                className={cn(
                  'grid items-center gap-2 border-b border-border/70 px-4 py-3 text-sm transition-colors last:border-0',
                  highlighted
                    ? 'bg-primary-subtle ring-2 ring-inset ring-primary/60'
                    : 'hover:bg-primary-subtle/40',
                )}
                style={{
                  gridTemplateColumns: gridTemplate,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${String(item.start)}px)`,
                }}
              >
                {columns.map((col) => (
                  <div key={col.id} role="cell" className={cn('flex min-w-0 items-center', ALIGN[col.align ?? 'left'])}>
                    {col.cell(row, item.index)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
