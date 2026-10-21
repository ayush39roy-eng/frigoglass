import { Link } from 'react-router-dom';
import { FolderKanban, FolderOpen, Pencil } from 'lucide-react';

import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { CharterCell } from '@/components/shared/charter-fields';
import { CHARTER_FIELDS } from '@/components/shared/charter-fields-meta';
import { NoLeaderLabel } from '@/components/shared/no-leader-label';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { CategoryTag } from '@/components/ui/category-tag';
import { EntityCell } from '@/components/ui/table-cells';
import { categoricalRankSoftBg, categoricalRankText, categoryRank } from '@/lib/categorical-palette';
import { formatInteger, formatPlanWeek } from '@/lib/format';
import { registrationEditHref } from '@/lib/registration-links';
import { cn } from '@/lib/utils';
import { PROJECT_TYPE_LABELS } from '@/types/enums';

import type { ProjectFilterRow } from '../api/types';
import type { VirtualColumn } from './virtual-data-table';

/**
 * Columns of the Dashboard's "All registered projects" register (ADR 0025 §5,
 * contract §4): #, Hub, Cat, Type, Status, Project, Leader, End wk, Current
 * step, Priority, Actions. Every cell prints one served field of
 * `GET /dashboard/projects` (I9). `#` is the row's position in the served
 * order, a display ordinal only. P24-T02 (ADR 0035): Plant, Requesting
 * department and Product type are served read-only and shown as optional
 * columns (`showCharter`). There is no Delete here.
 */

export type RegisterRow = ProjectFilterRow & { ordinal: number };

const DASH = <span className="text-text-subtle">—</span>;

const ACTION_LINK =
  'inline-flex h-7 items-center gap-1 rounded-pill border-[1.5px] px-2 text-2xs font-semibold transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5';

export function registerColumns({
  canEdit,
  showCharter = false,
}: {
  canEdit: boolean;
  showCharter?: boolean;
}): VirtualColumn<RegisterRow>[] {
  return [
    {
      id: 'ordinal',
      header: '#',
      width: '2.5rem',
      align: 'right',
      cell: (row) => (
        <span className="text-xs font-semibold tabular-nums text-text-subtle" data-numeric="">
          {formatInteger(row.ordinal)}
        </span>
      ),
    },
    {
      id: 'hub',
      header: 'Hub',
      width: 'minmax(7.5rem, 0.9fr)',
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-1.5" title={row.region ? `${row.hub} · ${row.region}` : row.hub}>
          {row.region ? <CountryFlag region={row.region} /> : null}
          <span className="truncate text-xs font-semibold text-text">{row.hub}</span>
        </span>
      ),
    },
    {
      id: 'category',
      header: 'Cat',
      width: '3.75rem',
      align: 'center',
      cell: (row) => (row.category ? <CategoryTag category={row.category} /> : DASH),
    },
    {
      id: 'type',
      header: 'Type',
      width: '3.5rem',
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
      width: 'minmax(8.5rem, 1fr)',
      cell: (row) => <ProjectStatusBadge status={row.status} />,
    },
    {
      id: 'project',
      header: 'Project',
      width: 'minmax(13rem, 2.2fr)',
      cell: (row) => {
        const rank = row.category ? categoryRank(row.category) : 9;
        return (
          <EntityCell
            icon={FolderKanban}
            iconClassName={cn(categoricalRankSoftBg(rank), categoricalRankText(rank))}
            title={row.project_name}
            titleAttr={`${row.project_name} — open in Project Workspace`}
            to={`/projects/${row.project_id}`}
            subtitle={row.external_code ?? undefined}
          />
        );
      },
    },
    {
      id: 'leader',
      header: 'Leader',
      width: 'minmax(6.5rem, 0.8fr)',
      // ADR 0028: names are served; the fallback is only for an id with no name.
      cell: (row) =>
        row.leader_name ? (
          <span className="truncate text-xs font-medium text-text">{row.leader_name}</span>
        ) : row.leader_engineer_id ? (
          <span className="text-xs italic text-text-subtle" title="Leader name unavailable">
            Name unavailable
          </span>
        ) : (
          <NoLeaderLabel leftOut={row.outcome === 'LEFT_OUT'} className="text-xs" />
        ),
    },
    // P24-T02 (ADR 0035): the served charter fields, verbatim, when asked for.
    ...(showCharter
      ? CHARTER_FIELDS.map<VirtualColumn<RegisterRow>>(({ key, short }) => ({
          id: `charter-${key}`,
          header: short,
          width: 'minmax(6.5rem, 0.9fr)',
          cell: (row) => <CharterCell value={row[key]} />,
        }))
      : []),
    {
      id: 'end-week',
      header: 'End wk',
      width: '5.5rem',
      align: 'center',
      // ADR 0024: a finish past W52 prints as "After W52"; the week is served.
      cell: (row) =>
        row.end_week !== null && row.end_week !== undefined ? (
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
      width: 'minmax(9rem, 1.2fr)',
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
      width: '6rem',
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
      width: canEdit ? '8.5rem' : '5rem',
      align: 'right',
      cell: (row) => (
        <span className="inline-flex items-center gap-1">
          <Link
            to={`/projects/${row.project_id}`}
            aria-label={`Open ${row.project_name}`}
            className={cn(ACTION_LINK, 'border-dash-hairline bg-surface text-text hover:bg-surface-sunken')}
          >
            <FolderOpen aria-hidden="true" />
            Open
          </Link>
          {canEdit ? (
            <Link
              to={registrationEditHref(row.project_id)}
              aria-label={`Edit ${row.project_name}`}
              className={cn(
                ACTION_LINK,
                'border-primary/30 bg-primary-subtle text-primary-subtle-fg hover:bg-primary-subtle/70',
              )}
            >
              <Pencil aria-hidden="true" />
              Edit
            </Link>
          ) : null}
        </span>
      ),
    },
  ];
}
