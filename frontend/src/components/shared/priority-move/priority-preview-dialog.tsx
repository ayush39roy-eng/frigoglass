import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowRight, CircleCheck, EyeOff, Info, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type {
  PriorityPreviewChange,
  PriorityPreviewMoved,
  PriorityPreviewSummary,
} from '@/lib/api/priority-move';
import { formatInteger, formatPlanWeek } from '@/lib/format';
import { cn } from '@/lib/utils';

import { PriorityBandPill } from '../priority-band-pill';
import { MOVE_COPY, previewNotNeededCopy } from './move-copy';
import type { MoveFlowState } from './use-priority-move-flow';

/**
 * The priority-move preview dialog (P14, ADR 0026 §5). Every move entry point
 * opens it first: the Priority board drop, the move control on the Gantt row
 * and the Workspace header, and the Registration / Workspace edit form.
 *
 *   loading  → the in-process greedy preview is running (nothing written)
 *   preview  → the moved project's finish before → after, the served counts,
 *              the hidden count, and the affected-projects table; Yes / No
 *   applying → the confirm with the preview token is in flight
 *   applied  → the same summary from the confirm response (the run is active)
 *   error    → hard gate / timeout / any other refusal; nothing was written
 *
 * Every number is a served field of the preview or confirm response (I9). The
 * browser compares nothing but two served booleans of the same row to choose
 * a chip ("Within year → Past W52") and to emphasise a pushed-out row.
 */

type DialogFlow = Extract<MoveFlowState, { kind: 'previewing' | 'preview' | 'applying' | 'applied' | 'previewError' }>;

function isDialogFlow(flow: MoveFlowState): flow is DialogFlow {
  return (
    flow.kind === 'previewing' ||
    flow.kind === 'preview' ||
    flow.kind === 'applying' ||
    flow.kind === 'applied' ||
    flow.kind === 'previewError'
  );
}

/** Above this many rows the table body is virtualized (CLAUDE.md: any list over 100). */
const VIRTUALIZE_OVER = 100;
const ROW_HEIGHT = 44;

function week(value: number | null): string {
  return value === null ? '—' : formatPlanWeek(value);
}

function WeekMove({ before, after }: { before: number | null; after: number | null }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs font-semibold tabular-nums text-text" data-numeric="">
      {week(before)}
      <ArrowRight className="size-3 text-text-muted" aria-hidden="true" />
      <span className="sr-only">to</span>
      {week(after)}
    </span>
  );
}

function yearLabel(value: boolean | null): string {
  return value === null ? 'Not scheduled' : value ? 'Within year' : 'Past W52';
}

function YearChip({ value }: { value: boolean | null }): React.JSX.Element {
  return (
    <Badge tone={value === null ? 'neutral' : value ? 'success' : 'warning'} className="whitespace-nowrap rounded-pill">
      {yearLabel(value)}
    </Badge>
  );
}

/** The served within-year pair: one chip when equal, "before → after" when not. */
function YearChange({ before, after }: { before: boolean | null; after: boolean | null }): React.JSX.Element {
  if (before === after) return <YearChip value={after} />;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <YearChip value={before} />
      <ArrowRight className="size-3 text-text-muted" aria-hidden="true" />
      <span className="sr-only">to</span>
      <YearChip value={after} />
    </span>
  );
}

/** A served flag that flips (left out, on hold): printed only when the two differ. */
function FlagFlip({ before, after, label }: { before: boolean | null; after: boolean | null; label: string }): React.JSX.Element | null {
  if (before === after || after === null) return null;
  return (
    <Badge tone="outline" className="whitespace-nowrap rounded-pill">
      {after ? label : `No longer ${label.toLowerCase()}`}
    </Badge>
  );
}

function isPushedOut(row: PriorityPreviewChange): boolean {
  return row.within_year_before === true && row.within_year_after === false;
}

function MovedProject({ name, moved }: { name: string; moved: PriorityPreviewMoved }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-surface-raised p-3" data-testid="preview-moved">
      <p className="text-2xs font-bold uppercase tracking-wider text-text-subtle">This project</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 truncate text-sm font-semibold text-text" title={name}>
          {name}
        </span>
        <span className="text-xs text-text-muted">
          Finish <WeekMove before={moved.end_week_before} after={moved.end_week_after} />
        </span>
        <YearChange before={moved.within_year_before} after={moved.within_year_after} />
        <FlagFlip before={moved.left_out_before} after={moved.left_out_after} label="Left out" />
      </div>
    </div>
  );
}

const COUNT_FIELDS: { key: keyof PriorityPreviewSummary; label: string }[] = [
  { key: 'affected', label: 'Affected' },
  { key: 'delayed', label: 'Delayed' },
  { key: 'earlier', label: 'Earlier' },
  { key: 'pushed_out_of_year', label: 'Pushed out of year' },
  { key: 'pulled_into_year', label: 'Pulled into year' },
];

function SummaryCounts({ summary }: { summary: PriorityPreviewSummary }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Other projects" data-testid="preview-summary">
      {COUNT_FIELDS.map(({ key, label }) => {
        const value = summary[key];
        const alarm = key === 'pushed_out_of_year' && value > 0;
        return (
          <div
            key={key}
            className={cn(
              'rounded-md border px-2.5 py-2',
              alarm ? 'border-danger/40 bg-danger-subtle text-danger-subtle-fg' : 'border-border bg-surface',
            )}
            data-testid={`preview-count-${key}`}
          >
            <dt className={cn('text-2xs font-semibold', alarm ? 'text-danger-subtle-fg' : 'text-text-muted')}>{label}</dt>
            <dd className="text-lg font-bold tabular-nums" data-numeric="">
              {formatInteger(value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function ChangeCells({ row }: { row: PriorityPreviewChange }): React.JSX.Element {
  const pushed = isPushedOut(row);
  return (
    <>
      <TableCell className="max-w-[16rem] py-2 text-xs font-semibold text-text">
        <span className="block truncate" title={row.name}>
          {row.name}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap py-2 text-xs text-text-muted">{row.hub}</TableCell>
      <TableCell className="py-2">{row.priority ? <PriorityBandPill priority={row.priority} /> : '—'}</TableCell>
      <TableCell className="py-2">
        <WeekMove before={row.end_week_before} after={row.end_week_after} />
      </TableCell>
      <TableCell className="py-2">
        <span className="flex flex-wrap items-center gap-1">
          {pushed ? (
            <Badge tone="danger" className="whitespace-nowrap rounded-pill font-semibold" data-testid="pushed-out-chip">
              <TriangleAlert aria-hidden="true" />
              Pushed out of year
            </Badge>
          ) : (
            <YearChange before={row.within_year_before} after={row.within_year_after} />
          )}
          <FlagFlip before={row.left_out_before} after={row.left_out_after} label="Left out" />
          <FlagFlip before={row.blocked_before} after={row.blocked_after} label="On hold" />
        </span>
      </TableCell>
    </>
  );
}

function rowClass(row: PriorityPreviewChange): string {
  return isPushedOut(row) ? 'bg-danger-subtle/60 hover:bg-danger-subtle' : '';
}

function ChangesHead(): React.JSX.Element {
  return (
    <TableHeader>
      <TableRow>
        <TableHead className="h-9">Project</TableHead>
        <TableHead className="h-9">Hub</TableHead>
        <TableHead className="h-9">Priority</TableHead>
        <TableHead className="h-9">End week</TableHead>
        <TableHead className="h-9">Within year</TableHead>
      </TableRow>
    </TableHeader>
  );
}

function PlainChangesBody({ rows }: { rows: PriorityPreviewChange[] }): React.JSX.Element {
  return (
    <TableBody>
      {rows.map((row) => (
        <TableRow key={row.project_id} className={rowClass(row)} data-testid="preview-change-row" data-pushed-out={isPushedOut(row) || undefined}>
          <ChangeCells row={row} />
        </TableRow>
      ))}
    </TableBody>
  );
}

/** Over 100 rows: only the visible rows are mounted, with spacer rows above and below. */
function VirtualChangesBody({
  rows,
  scrollElement,
}: {
  rows: PriorityPreviewChange[];
  scrollElement: () => HTMLElement | null;
}): React.JSX.Element {
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the mandated virtualizer (see eslint.config.js).
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    initialRect: { width: 720, height: 320 },
  });
  const items = virtualizer.getVirtualItems();
  const top = items[0]?.start ?? 0;
  const bottom = virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0);
  return (
    <TableBody data-virtualized="true">
      {top > 0 ? (
        <tr aria-hidden="true">
          <td colSpan={5} style={{ height: top, padding: 0 }} />
        </tr>
      ) : null}
      {items.map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        return (
          <TableRow
            key={row.project_id}
            className={rowClass(row)}
            style={{ height: ROW_HEIGHT }}
            data-testid="preview-change-row"
            data-pushed-out={isPushedOut(row) || undefined}
          >
            <ChangeCells row={row} />
          </TableRow>
        );
      })}
      {bottom > 0 ? (
        <tr aria-hidden="true">
          <td colSpan={5} style={{ height: bottom, padding: 0 }} />
        </tr>
      ) : null}
    </TableBody>
  );
}

function AffectedTable({ rows, label }: { rows: PriorityPreviewChange[]; label: string }): React.JSX.Element {
  const tableRef = React.useRef<HTMLTableElement>(null);
  const scrollElement = React.useCallback(() => tableRef.current?.parentElement ?? null, []);
  return (
    // The Table's own wrapper is the scroller; cap its height here.
    <div className="rounded-md border border-border [&>div]:max-h-80" data-testid="preview-changes">
      <Table ref={tableRef} stickyHeader scrollLabel={label} aria-label={label}>
        <ChangesHead />
        {rows.length > VIRTUALIZE_OVER ? (
          <VirtualChangesBody rows={rows} scrollElement={scrollElement} />
        ) : (
          <PlainChangesBody rows={rows} />
        )}
      </Table>
    </div>
  );
}

function HiddenCount({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-text-muted" data-testid="preview-hidden-count">
      <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
      {`+${formatInteger(count)} more affected in hubs outside your scope`}
    </p>
  );
}

function Impact({
  projectName,
  moved,
  summary,
  changes,
  hiddenCount,
  mode,
}: {
  projectName: string;
  moved: PriorityPreviewMoved | null | undefined;
  summary: PriorityPreviewSummary | null | undefined;
  changes: PriorityPreviewChange[] | undefined;
  hiddenCount: number | undefined;
  mode: 'preview' | 'applied';
}): React.JSX.Element {
  const rows = changes ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {moved ? <MovedProject name={projectName} moved={moved} /> : null}
      {summary ? <SummaryCounts summary={summary} /> : null}
      <HiddenCount count={hiddenCount ?? 0} />
      {rows.length > 0 ? (
        <AffectedTable rows={rows} label={mode === 'preview' ? 'Projects this move would change' : 'Projects this move changed'} />
      ) : (
        <p className="text-xs text-text-muted">{mode === 'preview' ? MOVE_COPY.previewNoOthers : MOVE_COPY.appliedNoOthers}</p>
      )}
    </div>
  );
}

function Loading(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" role="status" aria-busy="true" data-testid="preview-loading">
      <p className="flex items-center gap-2 text-xs text-text-muted">
        <span className="size-2 shrink-0 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden="true" />
        {MOVE_COPY.previewLoading}
      </p>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function Body({ flow }: { flow: DialogFlow }): React.JSX.Element {
  if (flow.kind === 'previewing') return <Loading />;
  if (flow.kind === 'previewError') {
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-text" data-testid="preview-error">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
        {flow.body}
      </p>
    );
  }
  if (flow.kind === 'applied') {
    const r = flow.result;
    return (
      <div className="flex flex-col gap-3" data-testid="preview-applied">
        <p role="status" className="flex items-center gap-2 text-sm font-semibold text-text">
          <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
          Priority moved and the timeline recalculated.
        </p>
        <Impact
          projectName={flow.target.projectName}
          moved={r.moved}
          summary={r.summary}
          changes={r.changes}
          hiddenCount={r.hidden_count}
          mode="applied"
        />
      </div>
    );
  }
  const { preview } = flow;
  return (
    <div className="flex flex-col gap-3">
      {flow.refreshed ? (
        <p role="status" className="flex items-start gap-2 rounded-md bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-fg" data-testid="preview-refreshed">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {MOVE_COPY.previewRefreshed}
        </p>
      ) : null}
      {preview.result === 'not_needed' ? (
        <p className="text-sm text-text" data-testid="preview-not-needed">
          {previewNotNeededCopy(flow.target.status)}
        </p>
      ) : (
        <>
          {preview.baseline_run_id === null ? <p className="text-xs text-text-muted">{MOVE_COPY.previewNoBaseline}</p> : null}
          {preview.note ? <p className="text-xs text-text-muted">{preview.note}</p> : null}
          <Impact
            projectName={flow.target.projectName}
            moved={preview.moved}
            summary={preview.summary}
            changes={preview.changes}
            hiddenCount={preview.hidden_count}
            mode="preview"
          />
        </>
      )}
    </div>
  );
}

function title(flow: DialogFlow): string {
  if (flow.kind === 'applied') return `Moved to ${flow.next}`;
  if (flow.kind === 'previewError') return 'Priority not changed';
  return `Move to ${flow.next}?`;
}

function description(flow: DialogFlow): string {
  const from = flow.target.priority ?? 'no priority';
  if (flow.kind === 'applied') return `${flow.target.projectName} moved from ${from} to ${flow.next}. The new timeline is active.`;
  if (flow.kind === 'previewError') return `${flow.target.projectName} stays ${from}.`;
  return `${flow.target.projectName} moves from ${from} to ${flow.next}. ${MOVE_COPY.previewIntro}`;
}

export function PriorityPreviewDialog({
  flow,
  onConfirm,
  onCancel,
}: {
  flow: MoveFlowState;
  onConfirm: () => void;
  /** No / Escape / Close. The flow ignores it while the confirm is in flight. */
  onCancel: () => void;
}): React.JSX.Element {
  const open = isDialogFlow(flow);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const deciding = flow.kind === 'previewing' || flow.kind === 'preview' || flow.kind === 'applying';
  const applying = flow.kind === 'applying';
  // The decision buttons unmount once the move settles: keep focus inside the
  // dialog by moving it to Done (the only action left).
  const settled = flow.kind === 'applied' || flow.kind === 'previewError';
  React.useEffect(() => {
    if (settled) closeRef.current?.focus();
  }, [settled]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        className="flex max-h-[min(44rem,calc(100vh-2rem))] max-w-3xl flex-col motion-reduce:animate-none"
        data-testid="priority-preview-dialog"
        data-kind={flow.kind}
        aria-busy={flow.kind === 'previewing' || applying}
        // The safe choice gets focus first: "No, cancel" (or Done once settled).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (cancelRef.current ?? closeRef.current)?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (applying) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (applying) event.preventDefault();
        }}
      >
        {open ? (
          <>
            <DialogHeader className="pr-6">
              <DialogTitle>{title(flow)}</DialogTitle>
              <DialogDescription>{description(flow)}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto">
              <Body flow={flow} />
            </div>
            <DialogFooter>
              {deciding ? (
                <>
                  <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel} disabled={applying}>
                    No, cancel
                  </Button>
                  <Button type="button" onClick={onConfirm} disabled={flow.kind !== 'preview'} data-testid="preview-confirm">
                    {applying ? 'Applying…' : 'Yes, apply'}
                  </Button>
                </>
              ) : (
                <Button ref={closeRef} type="button" onClick={onCancel}>
                  Done
                </Button>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
