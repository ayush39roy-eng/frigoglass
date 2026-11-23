import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, FolderKanban, FolderOpen, Lock, Pencil, TriangleAlert } from 'lucide-react';

import { WeekText } from '@/components/shared/week-text';
import { Badge } from '@/components/ui/badge';
import { CategoryTag } from '@/components/ui/category-tag';
import { Checkbox } from '@/components/ui/checkbox';
import { EntityCell } from '@/components/ui/table-cells';
import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { ProjectPriorityPill } from '@/components/shared/priority-band-pill';
import { PriorityMoveControl } from '@/components/shared/priority-move/priority-move-control';
import { usePriorityMoveHost } from '@/components/shared/priority-move/priority-move-context';
import { CharterCell } from '@/components/shared/charter-fields';
import { CHARTER_FIELDS } from '@/components/shared/charter-fields-meta';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { VipToggle } from '@/components/shared/vip-toggle';
import { categoricalRankSoftBg, categoricalRankText, categoryRank } from '@/lib/categorical-palette';
import type { Hub } from '@/lib/api/reference';
import { formatInteger } from '@/lib/format';
import { rowPriorityNotApplicable } from '@/lib/priority-applicability';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { PROJECT_TYPE_LABELS } from '@/types/enums';

import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import type { EngineerOption } from '@/surfaces/registration/api/engineers-api';
import { EditableBandRank } from '@/surfaces/registration/components/band-rank-field';

import {
  fetchRegisterSteps,
  registerRowErrorText,
  type RegisterEditError,
  type RegisterStep,
} from '../api/register-edits';
import { nextRankSort, sortByBandRank, type RankSort } from '../lib/band-rank';
import { clampWidth } from '../lib/column-prefs';
import { HIDEABLE_COLUMNS } from '../lib/columns';
import { endBeforeStart, type EditableField, type RegisterValues } from '../lib/register-edit';
import { currentStepMove } from '../lib/register-popup';
import { statusMismatchExpected } from '../lib/status-mismatch';
import { isVipProject } from '../lib/vip-order';
import {
  CHANGED,
  CurrentStepSelect,
  EffortInput,
  EffortValue,
  HubSelect,
  LabTestingToggle,
  LeaderSelect,
  StatusMismatchMark,
  StatusSelect,
  UnassignedFlag,
  WeekDateInput,
  WeekValue,
} from './register-edit-cells';
import { StepChips, type StepChipState } from './step-chips';

/**
 * P22-T01: the Projects page list view. Row-virtualized (TanStack Virtual,
 * CLAUDE.md: any list over 100 rows; 236 projects is the baseline). Every cell
 * prints one served field of `GET /dashboard/projects` (I9). `#` is the row's
 * position in the shown order (VIP first, ADR 0040), a display ordinal only.
 * The star before the name is the VIP pin (`VipToggle`).
 *
 * P35-T02: the register columns (actual start / end, design / lab time).
 * P35-T08: tick boxes for the bulk bar, the "Unassigned ⚠" flag, per-user
 * hidden columns and dragged widths.
 *
 * P44-T01 (owner 2026-11-18): each row's "Edit" puts THAT row in inline edit
 * (status, hub, leader, actual dates, design / lab time with "Needs lab
 * testing", current step, and the priority through its preview dialog); the
 * button becomes "Done", which leaves the row's edit and keeps its draft until
 * the page's one Save. Several rows may be in edit at once; rows not in edit
 * stay read-only and show an unsaved draft marked as changed. The "Steps
 * (click to exclude)" column shows the step chips (toggled in edit); the
 * registration's identity / financial fields stay in the project folder.
 */

/** What a row in edit needs beyond the list row (served reads, by the page). */
export interface RegisterRowExtras {
  /** Served "Needs lab testing" (`GET /projects/{id}`); null while unknown. */
  certification: boolean | null;
  /** Served frozen flag: the current step cannot change (contract §2.2). */
  frozen: boolean;
  /** Served steps (`GET /projects/{id}/register-steps`) for the current-step pick. */
  steps: readonly RegisterStep[] | undefined;
  stepsPending: boolean;
  stepsError: boolean;
  /** The draft hub uses the other workflow: the steps change on Save. */
  workflowChange: boolean;
}

/** The register's inline edit session, owned by the page. */
export interface RegisterGridEdit {
  /** Some row is in edit or has unsaved changes (tick boxes, wider cells). */
  active: boolean;
  isWritable: (row: ProjectFilterRow) => boolean;
  /** The row is in inline edit (its "Edit" was pressed, not yet "Done"). */
  isEditing: (row: ProjectFilterRow) => boolean;
  /** The row has unsaved changes. */
  hasDraft: (row: ProjectFilterRow) => boolean;
  onToggleEdit: (row: ProjectFilterRow, on: boolean) => void;
  /** The draft over the served values. */
  values: (row: ProjectFilterRow) => RegisterValues;
  changed: (row: ProjectFilterRow, field: EditableField) => boolean;
  onField: <F extends EditableField>(row: ProjectFilterRow, field: F, value: RegisterValues[F]) => void;
  /** The design resources of the row's (draft) hub. */
  leaderOptions: (row: ProjectFilterRow) => { options: EngineerOption[] | undefined; loading: boolean };
  /** The hubs the caller may move a project to (in scope); `allHubs` labels them. */
  hubs: readonly Hub[];
  allHubs: readonly Hub[];
  extras: (row: ProjectFilterRow) => RegisterRowExtras;
  /** The row draft's exclusion flags (only the steps it changed). */
  draftExclusions: (row: ProjectFilterRow) => Readonly<Record<string, boolean>>;
  /** Flip one step's exclusion in the row's draft. */
  onToggleStep: (row: ProjectFilterRow, stepCode: string) => void;
  /** Why a chip of a row in edit cannot be toggled (the popup's locks), or null. */
  stepLock: (row: ProjectFilterRow, step: RegisterStep) => string | null;
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
  /** Show the row "Edit" toggle (Registration write; the server still decides). */
  canEdit: boolean;
  /** The project to highlight (just created or updated). */
  highlightId: string | null;
  highlightLabel?: string;
  maxHeight?: number;
  /** P24-T02: show the optional read-only workbook columns (ADR 0035). */
  showCharter?: boolean;
  /** ADR 0040: show the VIP pin toggle (Registration write; the server still decides). */
  canPinVip?: boolean;
  /** P44-T01: the inline edit session; absent for a read-only role. */
  edit?: RegisterGridEdit | undefined;
  /** P44-T01: the caller may read `GET /projects/{id}/register-steps`, so the
   *  Steps column shows the chips of every rendered (visible) row. */
  canReadSteps?: boolean;
  /** P44-T01: scroll this row into view and focus its first editable cell
   *  (the `?edit=<id>` deep link); `nonce` repeats a request for the same row. */
  focusRequest?: { id: string; nonce: number } | null;
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
  /** A row in edit edits this column: its header carries a pencil cue. */
  editable?: boolean;
  /** P54: the header is a sort toggle (display order of served fields only). */
  sort?: { state: RankSort; onToggle: () => void };
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
  EFFORT_NEEDS_A_STEP: ['design_effort_weeks', 'lab_effort_weeks'],
  NULL_NOT_ALLOWED: ['status'],
  DRAFT_RETIRED: ['status'],
  STATUS_DRAFT_SUBMIT_ONLY: ['status'],
  UNKNOWN_HUB: ['hub_id'],
  WORKFLOW_CHANGE_WITH_PROGRESS: ['hub_id'],
  UNKNOWN_STEP: ['current_step_code'],
  STEP_NOT_APPLICABLE: ['current_step_code'],
  INCONSISTENT_PROGRESS: ['current_step_code'],
};

function errorOn(errors: readonly RegisterEditError[] | undefined, field: EditableField): boolean {
  return (errors ?? []).some((e) => ERROR_CELL[e.code]?.includes(field));
}

/** A read-only value of a row NOT in edit whose draft changed it: marked
 *  like a changed cell until Save or Cancel. */
function Pending({ on, children }: { on: boolean; children: React.ReactNode }): React.JSX.Element {
  if (!on) return <>{children}</>;
  return (
    <span className={cn('inline-flex min-w-0 items-center p-0.5', CHANGED)} data-pending="" title="Unsaved change">
      {children}
      <span className="sr-only"> (unsaved change)</span>
    </span>
  );
}

/** Row error codes that concern the step exclusions this Save changed. */
const STEP_ERROR_CODES = new Set([
  'STEP_DONE',
  'STEP_NOT_APPLICABLE',
  'UNKNOWN_STEP',
  'PROJECT_FROZEN',
  'PROJECT_CLOSED',
  'EFFORT_NEEDS_A_STEP',
  'NO_STEPS_LEFT',
]);

/**
 * P44-T01 (owner 2026-11-18): the old tool's "Steps (click to exclude)" cell.
 * Its own component so it can read `GET /projects/{id}/register-steps` through
 * the query cache: only rows the virtualizer renders (the visible window plus
 * overscan) mount it, so the list never fetches every project's steps at once.
 * In a row's edit a chip toggles the exclusion into the row's draft (saved by
 * the page's one batch, key `step_exclusions`); outside edit it is a display.
 */
function StepsCell({
  row,
  edit,
  inEdit,
  enabled,
}: {
  row: ProjectFilterRow;
  edit: RegisterGridEdit | undefined;
  inEdit: boolean;
  enabled: boolean;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: queryKeys.projectRegisterSteps(row.project_id),
    queryFn: ({ signal }) => fetchRegisterSteps(row.project_id, { signal }),
    enabled: enabled || inEdit,
    retry: false,
    staleTime: 30_000,
  });
  if (!enabled && !inEdit) return DASH;
  if (query.isPending) {
    return (
      <span className="block h-[2.875rem] w-full animate-pulse rounded bg-surface-sunken motion-reduce:animate-none" aria-busy="true">
        <span className="sr-only">Loading steps</span>
      </span>
    );
  }
  if (query.isError) return <span className="text-2xs text-text-muted">Steps not available</span>;
  const drafted = edit?.draftExclusions(row) ?? {};
  const current = edit ? edit.values(row).current_step_code : row.current_step_code;
  const stepError = (edit?.rowErrors[row.project_id] ?? []).some((e) => STEP_ERROR_CODES.has(e.code));
  const chips: StepChipState[] = query.data.steps.map((step) => {
    const excluded = drafted[step.step_code] ?? step.step_excluded;
    const changed = excluded !== step.step_excluded;
    return {
      step,
      excluded,
      changed,
      current: current === step.step_code,
      lockedReason: inEdit && edit ? edit.stepLock(row, step) : null,
      invalid: stepError && changed,
    };
  });
  return (
    <StepChips
      compact
      readOnly={!inEdit || !edit}
      chips={chips}
      label={`Steps of ${row.project_name}`}
      invalid={stepError}
      onToggle={(code) => edit?.onToggleStep(row, code)}
    />
  );
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
  rows: servedRows,
  canEdit,
  highlightId,
  highlightLabel = 'Saved',
  maxHeight = 640,
  showCharter = false,
  canPinVip = false,
  edit,
  canReadSteps = false,
  focusRequest = null,
  hiddenColumns = [],
  columnWidths = {},
  onColumnWidth,
}: ProjectsTableProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  // P54 (ADR 0064 R2): the Rank header sorts the served rows by priority then
  // served band rank (the scheduling order); off = the server's own sort.
  const [rankSort, setRankSort] = React.useState<RankSort>('none');
  const rows = React.useMemo(() => sortByBandRank(servedRows, rankSort), [servedRows, rankSort]);
  const moveHost = usePriorityMoveHost();
  const [liveWidth, setLiveWidth] = React.useState<{ id: string; px: number } | null>(null);
  const active = edit?.active ?? false;
  /** Where focus goes once the row has re-rendered: its first editable cell
   *  (Edit pressed) or back to its toggle (Done / Escape). */
  const pendingFocus = React.useRef<{ id: string; to: 'first' | 'toggle' } | null>(null);

  const toggleEdit = React.useCallback(
    (row: ProjectFilterRow, on: boolean) => {
      if (!edit) return;
      pendingFocus.current = { id: row.project_id, to: on ? 'first' : 'toggle' };
      edit.onToggleEdit(row, on);
    },
    [edit],
  );

  const columns = React.useMemo<Column[]>(() => {
    const inEdit = (row: ProjectFilterRow): boolean => edit !== undefined && edit.isWritable(row) && edit.isEditing(row);
    /** A row not in edit whose draft changed `field`. */
    const pending = (row: ProjectFilterRow, field: EditableField): boolean =>
      edit !== undefined && !inEdit(row) && edit.changed(row, field);
    const all: Column[] = [
      ...(edit && active
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
                ) : null,
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
          const editing = inEdit(row);
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
                {!editing && edit?.hasDraft(row) ? (
                  <Badge tone="warning" data-testid="row-unsaved-badge">
                    Unsaved
                  </Badge>
                ) : null}
              </span>
              {editing ? (
                // The registration's identity / financial fields and Draft submit
                // do not fit a row: they stay in the project folder's Edit.
                <Link
                  to={`/projects/${row.project_id}`}
                  className="w-fit text-2xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title="Name, code, category, type, financials and Draft submit are edited in the project folder"
                  data-testid="row-folder-hint"
                >
                  More fields in the project folder
                </Link>
              ) : null}
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
        editable: true,
        header: 'Hub',
        min: active ? 10 : 7,
        fr: 0.9,
        resizable: true,
        cell: (row) => {
          if (edit && inEdit(row)) {
            const values = edit.values(row);
            return (
              <HubSelect
                value={values.hub_id}
                hubs={edit.hubs}
                allHubs={edit.allHubs}
                changed={edit.changed(row, 'hub_id')}
                label={row.project_name}
                invalid={errorOn(edit.rowErrors[row.project_id], 'hub_id')}
                note={edit.extras(row).workflowChange ? 'Other workflow: the steps change on Save' : null}
                onChange={(next) => edit.onField(row, 'hub_id', next)}
              />
            );
          }
          if (edit && pending(row, 'hub_id')) {
            const id = edit.values(row).hub_id;
            const hub = edit.allHubs.find((h) => h.id === id);
            return (
              <Pending on>
                <span className="truncate text-xs font-semibold text-text">{hub?.name ?? row.hub}</span>
              </Pending>
            );
          }
          return (
            <span className="flex min-w-0 items-center gap-1.5" title={`${row.hub} · ${row.region}`}>
              <CountryFlag region={row.region} />
              <span className="truncate text-xs font-semibold text-text">{row.hub}</span>
            </span>
          );
        },
      },
      {
        id: 'category',
        header: 'Cat',
        min: 3.5,
        align: 'center',
        resizable: true,
        cell: (row) => {
          // P59: a category staged from the bulk bar shows as an unsaved change.
          const category = edit ? edit.values(row).category : row.category;
          return (
            <Pending on={edit !== undefined && edit.changed(row, 'category')}>
              {category ? <CategoryTag category={category} /> : DASH}
            </Pending>
          );
        },
      },
      {
        id: 'type',
        header: 'Type',
        min: 3.25,
        align: 'center',
        resizable: true,
        cell: (row) => {
          const type = edit ? edit.values(row).project_type : row.type;
          return (
            <Pending on={edit !== undefined && edit.changed(row, 'project_type')}>
              {type ? (
                <span className="text-xs font-bold text-text" title={PROJECT_TYPE_LABELS[type]}>
                  {type}
                </span>
              ) : (
                DASH
              )}
            </Pending>
          );
        },
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
        min: active ? 10.5 : 7.5,
        fr: 1,
        resizable: true,
        cell: (row) => {
          // A Draft row leaves Draft through Submit in the folder's Edit (ADR 0034).
          // P35-T08b: the served mismatch flag; an edited status is compared with
          // the served `expected_status` (lib/status-mismatch.ts).
          if (!edit || !inEdit(row) || row.status === 'Draft') {
            const status = edit ? edit.values(row).status : row.status;
            return (
              <Pending on={pending(row, 'status')}>
                <StatusMismatchMark expected={statusMismatchExpected(row, status)}>
                  <ProjectStatusBadge status={status} />
                </StatusMismatchMark>
              </Pending>
            );
          }
          const status = edit.values(row).status;
          return (
            <StatusSelect
              value={status}
              served={row.status}
              changed={edit.changed(row, 'status')}
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
        min: active ? 10 : 6.5,
        fr: 0.8,
        resizable: true,
        // ADR 0028: names are served; the fallback is only for an id with no name.
        cell: (row) => {
          if (edit && inEdit(row)) {
            const leader = edit.leaderOptions(row);
            const value = edit.values(row).leader_engineer_id;
            return (
              <span className="flex min-w-0 flex-col gap-0.5">
                <LeaderSelect
                  value={value}
                  servedId={row.leader_engineer_id}
                  servedName={row.leader_name}
                  options={leader.options}
                  loading={leader.loading}
                  changed={edit.changed(row, 'leader_engineer_id')}
                  label={row.project_name}
                  onChange={(next) => edit.onField(row, 'leader_engineer_id', next)}
                />
                {value === null ? <UnassignedFlag /> : null}
              </span>
            );
          }
          if (edit && pending(row, 'leader_engineer_id')) {
            const id = edit.values(row).leader_engineer_id;
            const name = id === null ? null : (edit.leaderOptions(row).options?.find((e) => e.id === id)?.name ?? 'Changed');
            return name === null ? (
              <Pending on>
                <UnassignedFlag />
              </Pending>
            ) : (
              <Pending on>
                <span className="truncate text-xs font-medium text-text">{name}</span>
              </Pending>
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
        min: active ? 11 : 5.5,
        align: active ? 'left' : 'center',
        resizable: true,
        cell: (row) => {
          if (!edit) return <WeekValue week={row.actual_start_week} />;
          if (!inEdit(row)) {
            return (
              <Pending on={pending(row, 'actual_start_week')}>
                <WeekValue week={edit.values(row).actual_start_week} />
              </Pending>
            );
          }
          return (
            <WeekDateInput
              week={edit.values(row).actual_start_week}
              changed={edit.changed(row, 'actual_start_week')}
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
        min: active ? 11 : 5.5,
        align: active ? 'left' : 'center',
        resizable: true,
        cell: (row) => {
          if (!edit) return <WeekValue week={row.actual_end_week} />;
          const values = edit.values(row);
          if (!inEdit(row)) {
            return (
              <Pending on={pending(row, 'actual_end_week')}>
                <WeekValue week={values.actual_end_week} />
              </Pending>
            );
          }
          return (
            <WeekDateInput
              week={values.actual_end_week}
              changed={edit.changed(row, 'actual_end_week')}
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
        min: active ? 8 : 5.5,
        align: 'center',
        resizable: true,
        cell: (row) => {
          if (!edit) return <EffortValue figure={row.design_effort_weeks} calculated={row.design_weeks_calculated} />;
          if (!inEdit(row)) {
            return (
              <Pending on={pending(row, 'design_effort_weeks')}>
                <EffortValue figure={edit.values(row).design_effort_weeks} calculated={row.design_weeks_calculated} />
              </Pending>
            );
          }
          return (
            <EffortInput
              figure={edit.values(row).design_effort_weeks}
              calculated={row.design_weeks_calculated}
              changed={edit.changed(row, 'design_effort_weeks')}
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
        min: active ? 9.5 : 5.5,
        align: 'center',
        resizable: true,
        cell: (row) => {
          if (!edit) return <EffortValue figure={row.lab_effort_weeks} calculated={row.lab_weeks_calculated} />;
          if (!inEdit(row)) {
            return (
              <Pending on={pending(row, 'lab_effort_weeks') || pending(row, 'certification_testing_required')}>
                <EffortValue figure={edit.values(row).lab_effort_weeks} calculated={row.lab_weeks_calculated} />
              </Pending>
            );
          }
          const values = edit.values(row);
          return (
            <span className="flex min-w-0 flex-col items-center gap-0.5">
              <EffortInput
                figure={values.lab_effort_weeks}
                calculated={row.lab_weeks_calculated}
                changed={edit.changed(row, 'lab_effort_weeks')}
                label={`Lab time of ${row.project_name}`}
                invalid={errorOn(edit.rowErrors[row.project_id], 'lab_effort_weeks')}
                onChange={(next) => edit.onField(row, 'lab_effort_weeks', next)}
              />
              <LabTestingToggle
                checked={values.certification_testing_required}
                changed={edit.changed(row, 'certification_testing_required')}
                label={row.project_name}
                onChange={(next) => edit.onField(row, 'certification_testing_required', next)}
              />
            </span>
          );
        },
      },
      {
        id: 'end-week',
        header: 'End wk',
        min: 4.75,
        align: 'center',
        resizable: true,
        // Owner rule 2026-11-18: a finish past W52 prints as its next-year week (W5 '27); the week is served.
        cell: (row) =>
          row.end_week !== null ? (
            <span className="text-xs font-semibold tabular-nums text-text" data-numeric="">
              <WeekText week={row.end_week} />
            </span>
          ) : (
            DASH
          ),
      },
      {
        id: 'current-step',
        editable: true,
        header: 'Current step',
        min: active ? 10 : 7.5,
        fr: 1.1,
        resizable: true,
        cell: (row) => {
          if (edit && inEdit(row)) {
            const extras = edit.extras(row);
            const value = edit.values(row).current_step_code;
            const lock = extras.workflowChange
              ? 'Save the hub first'
              : extras.frozen
                ? 'Frozen: the steps cannot change'
                : null;
            return (
              <CurrentStepSelect
                value={value}
                served={row.current_step_code}
                steps={extras.steps}
                excluded={edit.draftExclusions(row)}
                pending={extras.stepsPending}
                unavailable={extras.stepsError}
                lockReason={lock}
                move={extras.steps ? currentStepMove(extras.steps, row.current_step_code, value) : null}
                changed={edit.changed(row, 'current_step_code')}
                label={row.project_name}
                invalid={errorOn(edit.rowErrors[row.project_id], 'current_step_code')}
                onChange={(next) => edit.onField(row, 'current_step_code', next)}
              />
            );
          }
          if (edit && pending(row, 'current_step_code')) {
            return (
              <Pending on>
                <span className="truncate text-xs font-semibold text-text">{edit.values(row).current_step_code}</span>
              </Pending>
            );
          }
          return row.current_step_code ? (
            <span className="min-w-0" title={row.current_step_name ?? row.current_step_code}>
              <span className="block truncate text-xs font-semibold text-text">{row.current_step_code}</span>
              {row.current_step_name ? (
                <span className="block truncate text-2xs text-text-subtle">{row.current_step_name}</span>
              ) : null}
            </span>
          ) : (
            DASH
          );
        },
      },
      {
        id: 'steps',
        editable: true,
        header: 'Steps (click to exclude)',
        min: 11,
        fr: 0.8,
        resizable: true,
        cell: (row) => <StepsCell row={row} edit={edit} inEdit={inEdit(row)} enabled={canReadSteps} />,
      },
      {
        id: 'priority',
        editable: true,
        header: 'Priority',
        min: active ? 6.5 : 5.5,
        align: 'center',
        resizable: true,
        cell: (row) => {
          const rank = row.priority_rank ? (
            <span
              className="text-2xs font-semibold tabular-nums text-text-subtle"
              title="Rank by score within the filtered set"
              data-numeric=""
            >
              #{formatInteger(row.priority_rank)}
            </span>
          ) : null;
          // P59: a priority staged from the bulk bar is part of the draft and
          // goes with Save (one batch); it shows as an unsaved change.
          if (edit !== undefined && edit.changed(row, 'priority')) {
            return (
              <span className="inline-flex items-center gap-1" data-testid="register-priority-staged">
                <Pending on>
                  <ProjectPriorityPill status={row.status} priorityApplicable={row.priority_applicable} priority={edit.values(row).priority} short />
                </Pending>
              </span>
            );
          }
          // A priority move is not part of the row's draft: it previews and
          // applies on its own (ADR 0015 / 0026), through the page's move host.
          if (inEdit(row)) {
            return (
              <span className="inline-flex items-center gap-1">
                <PriorityMoveControl
                  projectId={row.project_id}
                  projectName={row.project_name}
                  priority={row.priority}
                  status={row.status}
                />
                {rank}
              </span>
            );
          }
          // P57 (ADR 0067): Commercialized / Cancelled read "Not applicable".
          return row.priority || row.priority_rank || rowPriorityNotApplicable(row) ? (
            <span className="inline-flex items-center gap-1">
              <ProjectPriorityPill status={row.status} priorityApplicable={row.priority_applicable} priority={row.priority} short />
              {rank}
            </span>
          ) : (
            DASH
          );
        },
      },
      {
        // P54 (ADR 0064 R2): served band + rank, "P1 · 3"; editable like the board.
        id: 'rank',
        header: 'Rank',
        min: 5.5,
        align: 'center',
        resizable: true,
        sort: { state: rankSort, onToggle: () => setRankSort(nextRankSort) },
        cell: (row) => {
          const rank = row.band_rank ?? null;
          // P57 (ADR 0067): no band, so no rank, for Commercialized / Cancelled.
          if (row.priority === null || rank === null || rowPriorityNotApplicable(row)) return DASH;
          const canMove = canEdit && moveHost !== null && (edit === undefined || edit.isWritable(row));
          return (
            <span className="inline-flex items-center gap-1 text-xs font-semibold tabular-nums text-text" data-testid="rank-cell" data-numeric="">
              {canMove ? (
                <>
                  <span>{row.priority} ·</span>
                  <EditableBandRank
                    host={moveHost}
                    canMove
                    projectId={row.project_id}
                    projectName={row.project_name}
                    status={row.status}
                    band={row.priority}
                    rank={rank}
                    dense
                  />
                </>
              ) : (
                <span title={row.band_size ? `Position ${String(rank)} of ${String(row.band_size)} in ${row.priority}` : undefined}>
                  {row.priority} · {rank}
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: 'actions',
        header: 'Actions',
        min: canEdit ? 8.5 : 4.75,
        align: 'right',
        cell: (row) => {
          const writable = edit !== undefined && edit.isWritable(row);
          const editing = writable && edit.isEditing(row);
          return (
            <span className="inline-flex items-center gap-1">
              <Link
                to={`/projects/${row.project_id}`}
                aria-label={`Open ${row.project_name}`}
                className={cn(ACTION, 'border-dash-hairline bg-surface text-text hover:bg-surface-sunken')}
              >
                <FolderOpen aria-hidden="true" />
                Open
              </Link>
              {canEdit && writable ? (
                <button
                  type="button"
                  aria-pressed={editing}
                  // Visible "Edit" / "Done" starts the accessible name (label in name).
                  aria-label={editing ? `Done editing ${row.project_name}` : `Edit ${row.project_name}`}
                  title={editing ? 'Done: leave this row (changes are kept until Save)' : 'Edit this row in the list'}
                  onClick={() => toggleEdit(row, !editing)}
                  className={cn(
                    ACTION,
                    editing
                      ? 'border-primary bg-primary text-primary-fg hover:bg-primary/90'
                      : 'border-primary/30 bg-primary-subtle text-primary-subtle-fg hover:bg-primary-subtle/70',
                  )}
                  data-testid="row-edit-toggle"
                >
                  {editing ? <Check aria-hidden="true" /> : <Pencil aria-hidden="true" />}
                  {editing ? 'Done' : 'Edit'}
                </button>
              ) : canEdit ? (
                <span title="You cannot edit this project" data-testid="row-readonly">
                  <Lock className="size-3.5 text-text-subtle" aria-hidden="true" />
                  <span className="sr-only">Read-only: you cannot edit {row.project_name}</span>
                </span>
              ) : null}
            </span>
          );
        },
      },
    ];
    return all.filter((c) => !(HIDEABLE_IDS.has(c.id) && hiddenColumns.includes(c.id)));
  }, [canEdit, highlightId, highlightLabel, showCharter, canPinVip, edit, active, hiddenColumns, toggleEdit, canReadSteps, rankSort, moveHost]);

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

  // P44-T01: the deep link's row: scroll to it, then focus its first editable cell.
  const focusIndex = focusRequest === null ? -1 : rows.findIndex((r) => r.project_id === focusRequest.id);
  React.useEffect(() => {
    if (focusRequest === null || focusIndex < 0) return;
    pendingFocus.current = { id: focusRequest.id, to: 'first' };
    virtualizer.scrollToIndex(focusIndex, { align: 'center' });
  }, [focusRequest, focusIndex, virtualizer]);

  // Move focus once the row has rendered in its new state (it may only render
  // after the scroll above, so this runs after every render until it lands).
  React.useEffect(() => {
    const want = pendingFocus.current;
    const root = scrollRef.current;
    if (!want || !root) return;
    const rowEl = [...root.querySelectorAll<HTMLElement>('[data-project-id]')].find(
      (el) => el.dataset.projectId === want.id,
    );
    if (!rowEl) return;
    const toggle = rowEl.querySelector<HTMLElement>('[data-testid="row-edit-toggle"]');
    if (want.to === 'first') {
      const first = [...rowEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        '[data-edit-cell] select, [data-edit-cell] input',
      )].find((el) => !el.disabled);
      if (!first) return; // not in edit yet (the deep link's row renders first)
      pendingFocus.current = null;
      first.focus();
      return;
    }
    pendingFocus.current = null;
    toggle?.focus();
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      className="overflow-auto scrollbar-thin rounded-lg border border-border"
      // P44-R01: the table is its own vertical scroll box, so its sticky header row stays
      // in view. Capped to the viewport (less the shell padding and app header) so the box
      // never runs below the fold, where the page would scroll instead and take the header with it.
      style={{ maxHeight: `min(${String(maxHeight)}px, calc(100dvh - var(--app-header-h) - 6rem))` }}
      data-testid="projects-table-scroll"
      tabIndex={0}
      aria-label="Projects list, scrollable"
      role="region"
    >
      <div
        role="table"
        aria-label="Projects"
        aria-rowcount={rows.length + 1}
        data-editing={active ? '' : undefined}
        style={{ minWidth: `${String(minWidthRem)}rem` }}
      >
        <div role="rowgroup">
          <div
            role="row"
            aria-rowindex={1}
            data-testid="projects-table-header"
            className="sticky top-0 z-10 grid items-center gap-2 border-b-[1.5px] border-transparent bg-ink px-4 py-3 text-2xs font-bold uppercase tracking-wider text-ink-fg"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {columns.map((col) => (
              <div
                key={col.id}
                role="columnheader"
                // The resize handle inside has its own name; the header keeps just its title.
                aria-label={col.header}
                aria-sort={col.sort ? (col.sort.state === 'asc' ? 'ascending' : col.sort.state === 'desc' ? 'descending' : 'none') : undefined}
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
                ) : col.sort ? (
                  <button
                    type="button"
                    onClick={col.sort.onToggle}
                    className="flex min-w-0 items-center gap-1 rounded-sm uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="Sort by priority, then rank inside the band (the scheduling order)"
                    data-testid={`sort-${col.id}`}
                  >
                    <span className="truncate">{col.header}</span>
                    {col.sort.state === 'asc' ? (
                      <ArrowUp className="size-3 shrink-0" aria-hidden="true" />
                    ) : col.sort.state === 'desc' ? (
                      <ArrowDown className="size-3 shrink-0" aria-hidden="true" />
                    ) : (
                      <ArrowUpDown className="size-3 shrink-0 opacity-70" aria-hidden="true" />
                    )}
                  </button>
                ) : (
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate">{col.header}</span>
                    {/* Owner 2026-11-17: while rows are edited, the columns that can be edited say so. */}
                    {active && col.editable ? (
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
            const writable = edit !== undefined && edit.isWritable(row);
            const readOnly = edit !== undefined && active && !writable;
            const rowEditing = writable && edit.isEditing(row);
            return (
              <div
                key={row.project_id}
                role="row"
                aria-rowindex={item.index + 2}
                data-index={item.index}
                data-project-id={row.project_id}
                data-highlighted={highlighted ? '' : undefined}
                data-readonly={readOnly ? '' : undefined}
                data-row-editing={rowEditing ? '' : undefined}
                data-row-error={hasError ? '' : undefined}
                data-testid="projects-row"
                ref={virtualizer.measureElement}
                // Escape inside the row (not inside a portalled menu or dialog) leaves its edit.
                onKeyDown={
                  rowEditing
                    ? (event) => {
                        if (event.key !== 'Escape' || event.defaultPrevented) return;
                        if (!event.currentTarget.contains(event.target as Node)) return;
                        event.preventDefault();
                        toggleEdit(row, false);
                      }
                    : undefined
                }
                className={cn(
                  'grid items-center gap-2 border-b border-border/70 px-4 py-3 text-sm transition-colors last:border-0',
                  hasError
                    ? 'bg-danger-subtle/50 ring-2 ring-inset ring-danger/60'
                    : highlighted
                      ? 'bg-primary-subtle ring-2 ring-inset ring-primary/60'
                      : rowEditing
                        ? 'bg-primary-subtle/30 ring-2 ring-inset ring-primary/40'
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
                  <div
                    key={col.id}
                    role="cell"
                    className={cn('flex min-w-0 items-center', ALIGN[col.align ?? 'left'])}
                    data-edit-cell={rowEditing && col.editable ? '' : undefined}
                  >
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
