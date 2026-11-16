import * as React from 'react';
import { Link } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FolderKanban, FolderOpen, Lock, Pencil, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { CategoryTag } from '@/components/ui/category-tag';
import { Checkbox } from '@/components/ui/checkbox';
import { EntityCell } from '@/components/ui/table-cells';
import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { CharterCell } from '@/components/shared/charter-fields';
import { CHARTER_FIELDS } from '@/components/shared/charter-fields-meta';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { VipToggle } from '@/components/shared/vip-toggle';
import { categoricalRankSoftBg, categoricalRankText, categoryRank } from '@/lib/categorical-palette';
import { formatInteger, formatPlanWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PROJECT_TYPE_LABELS } from '@/types/enums';

import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import type { EngineerOption } from '@/surfaces/registration/api/engineers-api';

import { registerRowErrorText, type RegisterEditError } from '../api/register-edits';
import { clampWidth } from '../lib/column-prefs';
import { HIDEABLE_COLUMNS } from '../lib/columns';
import {
  endBeforeStart,
  fieldChanged,
  valuesFor,
  type EditableField,
  type RegisterDrafts,
  type RegisterValues,
} from '../lib/register-edit';
import { statusMismatchExpected } from '../lib/status-mismatch';
import { isVipProject } from '../lib/vip-order';
import {
  EffortInput,
  EffortValue,
  LeaderSelect,
  StatusMismatchMark,
  StatusSelect,
  UnassignedFlag,
  WeekDateInput,
  WeekValue,
} from './register-edit-cells';

/**
 * P22-T01: the Projects page list view. Row-virtualized (TanStack Virtual,
 * CLAUDE.md: any list over 100 rows; 236 projects is the baseline). Every cell
 * prints one served field of `GET /dashboard/projects` (I9). `#` is the row's
 * position in the shown order (VIP first, ADR 0040), a display ordinal only.
 * The star before the name is the VIP pin (`VipToggle`).
 *
 * P35-T02: the register columns (actual start / end, design / lab time) and,
 * with `edit`, the inline Edit mode: status, design resource, actual dates
 * and design / lab time become inputs over a draft; rows the caller cannot
 * write stay read-only. P35-T08: tick boxes for the bulk bar, the
 * "Unassigned ⚠" flag, per-user hidden columns and dragged widths.
 */

/** The register's Edit mode, owned by the page. */
export interface RegisterGridEdit {
  drafts: RegisterDrafts;
  isWritable: (row: ProjectFilterRow) => boolean;
  onField: <F extends EditableField>(row: ProjectFilterRow, field: F, value: RegisterValues[F]) => void;
  leaderOptions: (row: ProjectFilterRow) => { options: EngineerOption[] | undefined; loading: boolean };
  /** Server errors of the last refused Save, by project id. */
  rowErrors: Readonly<Record<string, readonly RegisterEditError[]>>;
  selected: ReadonlySet<string>;
  onToggleSelect: (projectId: string, on: boolean) => void;
  /** Tick / untick every writable shown row. */
  onToggleAll: (on: boolean) => void;
  allSelected: boolean | 'indeterminate';
}

export interface ProjectsTableProps {
  rows: ProjectFilterRow[];
  /** Show "Edit registration" (Registration write; the server still decides). */
  canEdit: boolean;
  onEdit: (row: ProjectFilterRow, trigger: HTMLElement) => void;
  /** The project to highlight (just created or updated). */
  highlightId: string | null;
  highlightLabel?: string;
  maxHeight?: number;
  /** P24-T02: show the optional read-only workbook columns (ADR 0035). */
  showCharter?: boolean;
  /** ADR 0040: show the VIP pin toggle (Registration write; the server still decides). */
  canPinVip?: boolean;
  /** P35-T02: the inline edit session; absent in read mode. */
  edit?: RegisterGridEdit | undefined;
  /** P35-T08: hidden optional column ids and resized widths (px). */
  hiddenColumns?: readonly string[];
  columnWidths?: Readonly<Record<string, number>>;
  onColumnWidth?: (columnId: string, px: number) => void;
}

const HIDEABLE_IDS = new Set(HIDEABLE_COLUMNS.map((c) => c.id));

interface Column {
  id: string;
  header: string;
  /** Minimum width in rem; with `fr` the column also takes a share of the rest. */
  min: number;
  fr?: number;
  align?: 'left' | 'right' | 'center';
  /** Width can be dragged (every column but the tick box). */
  resizable?: boolean;
  /** Edit mode edits this column: its header carries a pencil cue. */
  editable?: boolean;
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
const ROOT_PX = 16;
const KEY_STEP_PX = 16;

/** Which cell a server error code points at (the row always lists it too). */
const ERROR_CELL: Record<string, readonly EditableField[]> = {
  ACTUAL_END_BEFORE_START: ['actual_end_week'],
  EFFORT_SPLIT_REJECTED: ['design_effort_weeks', 'lab_effort_weeks'],
  NULL_NOT_ALLOWED: ['status'],
  DRAFT_RETIRED: ['status'],
  STATUS_DRAFT_SUBMIT_ONLY: ['status'],
};

function errorOn(errors: readonly RegisterEditError[] | undefined, field: EditableField): boolean {
  return (errors ?? []).some((e) => ERROR_CELL[e.code]?.includes(field));
}

function ResizeHandle({
  header,
  width,
  onLive,
  onCommit,
}: {
  header: string;
  width: number | undefined;
  onLive: (px: number | null) => void;
  onCommit: (px: number) => void;
}): React.JSX.Element {
  const drag = React.useRef<{ startX: number; startW: number; last: number } | null>(null);
  const measure = (el: HTMLElement): number => el.parentElement?.getBoundingClientRect().width ?? width ?? 96;
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${header} column`}
      aria-valuenow={Math.round(width ?? 0)}
      aria-valuemin={48}
      aria-valuemax={640}
      tabIndex={0}
      title="Drag to resize; arrow keys adjust"
      data-testid="column-resize"
      className="absolute -right-1.5 top-0 z-10 h-full w-2.5 cursor-col-resize touch-none rounded-sm hover:bg-ink-fg/30 focus-visible:bg-ink-fg/40 focus-visible:outline-none"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const startW = measure(e.currentTarget);
        drag.current = { startX: e.clientX, startW, last: startW };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = clampWidth(d.startW + e.clientX - d.startX);
        onLive(d.last);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        onLive(null);
        if (d && d.last !== d.startW) onCommit(d.last);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const base = width ?? measure(e.currentTarget);
        onCommit(clampWidth(base + (e.key === 'ArrowRight' ? KEY_STEP_PX : -KEY_STEP_PX)));
      }}
    />
  );
}

export function ProjectsTable({
  rows,
  canEdit,
  onEdit,
  highlightId,
  highlightLabel = 'Saved',
  maxHeight = 640,
  showCharter = false,
  canPinVip = false,
  edit,
  hiddenColumns = [],
  columnWidths = {},
  onColumnWidth,
}: ProjectsTableProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [liveWidth, setLiveWidth] = React.useState<{ id: string; px: number } | null>(null);
  const editing = edit !== undefined;

  const columns = React.useMemo<Column[]>(() => {
    const editable = (row: ProjectFilterRow): boolean => edit !== undefined && edit.isWritable(row);
    const all: Column[] = [
      ...(edit
        ? [
            {
              id: 'select',
              header: 'Select',
              min: 2,
              align: 'center' as const,
              cell: (row: ProjectFilterRow) =>
                edit.isWritable(row) ? (
                  <Checkbox
                    checked={edit.selected.has(row.project_id)}
                    onCheckedChange={(on) => edit.onToggleSelect(row.project_id, on === true)}
                    aria-label={`Select ${row.project_name}`}
                    data-testid="row-select"
                  />
                ) : (
                  <span title="You cannot edit this project" data-testid="row-readonly">
                    <Lock className="size-3.5 text-text-subtle" aria-hidden="true" />
                    <span className="sr-only">Read-only: you cannot edit {row.project_name}</span>
                  </span>
                ),
            },
          ]
        : []),
      {
        id: 'ordinal',
        header: '#',
        min: 2.5,
        align: 'right',
        resizable: true,
        cell: (_row, index) => (
          <span className="text-xs font-semibold tabular-nums text-text-subtle" data-numeric="">
            {formatInteger(index + 1)}
          </span>
        ),
      },
      {
        id: 'project',
        header: 'Project',
        min: 12,
        fr: 2.2,
        resizable: true,
        cell: (row) => {
          const rank = row.category ? categoryRank(row.category) : 9;
          const errors = edit?.rowErrors[row.project_id];
          return (
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <VipToggle
                  projectId={row.project_id}
                  projectName={row.project_name}
                  isVip={isVipProject(row)}
                  canPin={canPinVip}
                />
                <EntityCell
                  icon={FolderKanban}
                  iconClassName={cn(categoricalRankSoftBg(rank), categoricalRankText(rank))}
                  title={row.project_name}
                  titleAttr={`${row.project_name} — open in Project Workspace`}
                  to={`/projects/${row.project_id}`}
                  subtitle={row.external_code ?? undefined}
                />
                {row.project_id === highlightId ? (
                  <Badge tone="primary" data-testid="row-highlight-badge">
                    {highlightLabel}
                  </Badge>
                ) : null}
              </span>
              {errors && errors.length > 0 ? (
                <span className="flex flex-col text-2xs font-semibold text-danger" data-testid="row-error">
                  {errors.map((e) => (
                    <span key={`${e.code}:${e.message}`} className="flex items-start gap-1">
                      <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden="true" />
                      {registerRowErrorText(e)}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: 'hub',
        header: 'Hub',
        min: 7,
        fr: 0.9,
        resizable: true,
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
        min: 3.5,
        align: 'center',
        resizable: true,
        cell: (row) => (row.category ? <CategoryTag category={row.category} /> : DASH),
      },
      {
        id: 'type',
        header: 'Type',
        min: 3.25,
        align: 'center',
        resizable: true,
        cell: (row) =>
          row.type ? (
            <span className="text-xs font-bold text-text" title={PROJECT_TYPE_LABELS[row.type]}>
              {row.type}
            </span>
          ) : (
            DASH
          ),
      },
      // P24-T02 (ADR 0035): the served charter fields, verbatim, when asked for.
      ...(showCharter
        ? CHARTER_FIELDS.map<Column>(({ key, short }) => ({
            id: `charter-${key}`,
            header: short,
            min: 6.5,
            fr: 0.9,
            resizable: true,
            cell: (row) => <CharterCell value={row[key]} />,
          }))
        : []),
      {
        id: 'status',
        editable: true,
        header: 'Status',
        min: editing ? 10.5 : 7.5,
        fr: 1,
        resizable: true,
        cell: (row) => {
          // A Draft row leaves Draft through Submit in Edit registration (ADR 0034).
          // P35-T08b: the served mismatch flag; an edited status is compared with
          // the served `expected_status` (lib/status-mismatch.ts).
          if (!editable(row) || row.status === 'Draft' || !edit) {
            return (
              <StatusMismatchMark expected={statusMismatchExpected(row, row.status)}>
                <ProjectStatusBadge status={row.status} />
              </StatusMismatchMark>
            );
          }
          const status = valuesFor(edit.drafts, row).status;
          return (
            <StatusSelect
              value={status}
              served={row.status}
              changed={fieldChanged(edit.drafts, row, 'status')}
              label={row.project_name}
              invalid={errorOn(edit.rowErrors[row.project_id], 'status')}
              mismatchExpected={statusMismatchExpected(row, status)}
              onChange={(next) => edit.onField(row, 'status', next)}
            />
          );
        },
      },
      {
        id: 'leader',
        editable: true,
        header: 'Leader',
        min: editing ? 10 : 6.5,
        fr: 0.8,
        resizable: true,
        // ADR 0028: names are served; the fallback is only for an id with no name.
        cell: (row) => {
          if (editable(row) && edit) {
            const leader = edit.leaderOptions(row);
            const value = valuesFor(edit.drafts, row).leader_engineer_id;
            return (
              <span className="flex min-w-0 flex-col gap-0.5">
                <LeaderSelect
                  value={value}
                  servedId={row.leader_engineer_id}
                  servedName={row.leader_name}
                  options={leader.options}
                  loading={leader.loading}
                  changed={fieldChanged(edit.drafts, row, 'leader_engineer_id')}
                  label={row.project_name}
                  onChange={(next) => edit.onField(row, 'leader_engineer_id', next)}
                />
                {value === null ? <UnassignedFlag /> : null}
              </span>
            );
          }
          return row.leader_name ? (
            <span className="truncate text-xs font-medium text-text">{row.leader_name}</span>
          ) : row.leader_engineer_id ? (
            <span className="text-xs italic text-text-subtle" title="Leader name unavailable">
              Name unavailable
            </span>
          ) : (
            <UnassignedFlag leftOut={row.outcome === 'LEFT_OUT'} />
          );
        },
      },
      {
        id: 'actual-start',
        editable: true,
        header: 'Actual start',
        min: editing ? 11 : 5.5,
        align: editing ? 'left' : 'center',
        resizable: true,
        cell: (row) => {
          if (!editable(row) || !edit) return <WeekValue week={row.actual_start_week} />;
          return (
            <WeekDateInput
              week={valuesFor(edit.drafts, row).actual_start_week}
              changed={fieldChanged(edit.drafts, row, 'actual_start_week')}
              label={`Actual start of ${row.project_name}`}
              warning={null}
              onChange={(next) => edit.onField(row, 'actual_start_week', next)}
            />
          );
        },
      },
      {
        id: 'actual-end',
        editable: true,
        header: 'Actual end',
        min: editing ? 11 : 5.5,
        align: editing ? 'left' : 'center',
        resizable: true,
        cell: (row) => {
          if (!editable(row) || !edit) return <WeekValue week={row.actual_end_week} />;
          const values = valuesFor(edit.drafts, row);
          return (
            <WeekDateInput
              week={values.actual_end_week}
              changed={fieldChanged(edit.drafts, row, 'actual_end_week')}
              label={`Actual end of ${row.project_name}`}
              warning={endBeforeStart(values) ? 'End is before start' : null}
              invalid={errorOn(edit.rowErrors[row.project_id], 'actual_end_week')}
              onChange={(next) => edit.onField(row, 'actual_end_week', next)}
            />
          );
        },
      },
      {
        id: 'design-time',
        editable: true,
        header: 'Design time',
        min: editing ? 8 : 5.5,
        align: 'center',
        resizable: true,
        cell: (row) => {
          if (!editable(row) || !edit) {
            return <EffortValue figure={row.design_effort_weeks} calculated={row.design_weeks_calculated} />;
          }
          return (
            <EffortInput
              figure={valuesFor(edit.drafts, row).design_effort_weeks}
              calculated={row.design_weeks_calculated}
              changed={fieldChanged(edit.drafts, row, 'design_effort_weeks')}
              label={`Design time of ${row.project_name}`}
              invalid={errorOn(edit.rowErrors[row.project_id], 'design_effort_weeks')}
              onChange={(next) => edit.onField(row, 'design_effort_weeks', next)}
            />
          );
        },
      },
      {
        id: 'lab-time',
        editable: true,
        header: 'Lab time',
        min: editing ? 8 : 5.5,
        align: 'center',
        resizable: true,
        cell: (row) => {
          if (!editable(row) || !edit) {
            return <EffortValue figure={row.lab_effort_weeks} calculated={row.lab_weeks_calculated} />;
          }
          return (
            <EffortInput
              figure={valuesFor(edit.drafts, row).lab_effort_weeks}
              calculated={row.lab_weeks_calculated}
              changed={fieldChanged(edit.drafts, row, 'lab_effort_weeks')}
              label={`Lab time of ${row.project_name}`}
              invalid={errorOn(edit.rowErrors[row.project_id], 'lab_effort_weeks')}
              onChange={(next) => edit.onField(row, 'lab_effort_weeks', next)}
            />
          );
        },
      },
      {
        id: 'end-week',
        header: 'End wk',
        min: 4.75,
        align: 'center',
        resizable: true,
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
        min: 7.5,
        fr: 1.1,
        resizable: true,
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
        min: 5.5,
        align: 'center',
        resizable: true,
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
        min: canEdit && !editing ? 8.5 : 4.75,
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
            {/* Edit registration (the drawer) is hidden while the grid is being edited. */}
            {canEdit && !editing ? (
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
    ];
    return all.filter((c) => !(HIDEABLE_IDS.has(c.id) && hiddenColumns.includes(c.id)));
  }, [canEdit, onEdit, highlightId, highlightLabel, showCharter, canPinVip, edit, editing, hiddenColumns]);

  const widthOf = (col: Column): number | undefined =>
    liveWidth?.id === col.id ? liveWidth.px : col.resizable ? columnWidths[col.id] : undefined;
  const gridTemplate = columns
    .map((c) => {
      const px = widthOf(c);
      if (px !== undefined) return `${String(px)}px`;
      return c.fr ? `minmax(${String(c.min)}rem, ${String(c.fr)}fr)` : `${String(c.min)}rem`;
    })
    .join(' ');
  // Display sizing only: the sum of the column minimums, the 0.5 rem gaps and the 2 rem row padding.
  const minWidthRem =
    columns.reduce((sum, c) => {
      const px = widthOf(c);
      return sum + (px !== undefined ? px / ROOT_PX : c.min);
    }, 0) +
    0.5 * (columns.length - 1) +
    2;

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
      <div
        role="table"
        aria-label="Projects"
        aria-rowcount={rows.length + 1}
        data-editing={editing ? '' : undefined}
        style={{ minWidth: `${String(minWidthRem)}rem` }}
      >
        <div role="rowgroup">
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-10 grid items-center gap-2 border-b-[1.5px] border-transparent bg-ink px-4 py-3 text-2xs font-bold uppercase tracking-wider text-ink-fg"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {columns.map((col) => (
              <div
                key={col.id}
                role="columnheader"
                // The resize handle inside has its own name; the header keeps just its title.
                aria-label={col.header}
                className={cn('relative flex min-w-0 items-center', ALIGN[col.align ?? 'left'])}
                data-column={col.id}
              >
                {col.id === 'select' && edit ? (
                  <Checkbox
                    checked={edit.allSelected}
                    onCheckedChange={(on) => edit.onToggleAll(on === true)}
                    aria-label="Select every editable row shown"
                    className="border-ink-fg/70"
                    data-testid="select-all"
                  />
                ) : (
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate">{col.header}</span>
                    {/* Owner 2026-11-17: in Edit mode, the columns that can be edited say so. */}
                    {editing && col.editable ? (
                      <Pencil className="size-3 shrink-0 opacity-80" aria-hidden="true" data-testid="editable-column-cue" />
                    ) : null}
                  </span>
                )}
                {col.resizable && onColumnWidth ? (
                  <ResizeHandle
                    header={col.header}
                    width={widthOf(col)}
                    onLive={(px) => setLiveWidth(px === null ? null : { id: col.id, px })}
                    onCommit={(px) => onColumnWidth(col.id, px)}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            const highlighted = row.project_id === highlightId;
            const hasError = (edit?.rowErrors[row.project_id]?.length ?? 0) > 0;
            const readOnly = edit !== undefined && !edit.isWritable(row);
            return (
              <div
                key={row.project_id}
                role="row"
                aria-rowindex={item.index + 2}
                data-index={item.index}
                data-highlighted={highlighted ? '' : undefined}
                data-readonly={readOnly ? '' : undefined}
                data-row-error={hasError ? '' : undefined}
                data-testid="projects-row"
                ref={virtualizer.measureElement}
                className={cn(
                  'grid items-center gap-2 border-b border-border/70 px-4 py-3 text-sm transition-colors last:border-0',
                  hasError
                    ? 'bg-danger-subtle/50 ring-2 ring-inset ring-danger/60'
                    : highlighted
                      ? 'bg-primary-subtle ring-2 ring-inset ring-primary/60'
                      : readOnly
                        ? 'bg-surface-sunken/60'
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
