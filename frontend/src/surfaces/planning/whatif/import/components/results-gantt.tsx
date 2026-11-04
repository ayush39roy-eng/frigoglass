import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  PencilLine,
  RotateCcw,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react';

import { StepKindBadge } from '@/components/shared/step-kind-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { barGeometry, weekEndToX, weekToX, type WeekScale } from '@/surfaces/gantt/lib/gantt-coordinates';
import type { OverlapStep } from '@/surfaces/gantt/lib/step-overlap';

import type { WhatIfOutcome } from '../../../api/whatif-types';
import { NativeSelect } from '../../components/form-controls';
import { OUTCOME_LABEL, OUTCOME_ORDER, OUTCOME_TONE } from '../../components/outcome-meta';
import { editKey } from '../import-rows';
import { useImportPlan } from '../import-store';
import type { ImportResultProject, ImportResultStep, ImportSimulateResponse, ImportStepMeta } from '../import-types';
import { axisTicks, longWeekLabel, planYearOf, shortWeekLabel, weekOrDash } from '../week-labels';
import { importScale, type DropEdit } from '../gantt-geometry';
import { StepDragHandles } from './step-drag';
import { ImportStepTimingDialog, type TimingDialogTarget } from './step-timing-dialog';

const LEFT_PX = 300;
const PROJECT_H = 40;
const STEP_H = 30;
const AXIS_H = 34;
/** Rows are virtualized over 100 (CLAUDE.md); below that every row is drawn. */
const VIRTUALIZE_OVER = 100;

type GRow =
  | { kind: 'project'; key: string; p: ImportResultProject }
  | {
      kind: 'step';
      key: string;
      p: ImportResultProject;
      s: ImportResultStep;
      meta: ImportStepMeta | undefined;
    };

function visibleBar(start: number | null, end: number | null, scale: WeekScale) {
  if (start === null || end === null || end < scale.originWeek) return null;
  return barGeometry(Math.max(start, scale.originWeek), end, scale);
}

function stepFill(kind: ImportResultStep['kind']): {
  fill: string;
  stroke: string;
} {
  if (kind === 'lab') return { fill: 'hsl(var(--color-accent))', stroke: 'none' };
  if (kind === 'elapsed')
    return {
      fill: 'hsl(var(--color-gantt-planned) / 0.12)',
      stroke: 'hsl(var(--color-gantt-planned))',
    };
  return { fill: 'hsl(var(--color-primary))', stroke: 'none' };
}

function YearEndLine({ x, height }: { x: number; height: number }): React.JSX.Element {
  return (
    <line
      x1={x}
      x2={x}
      y1={0}
      y2={height}
      stroke="hsl(var(--color-gantt-marker-year))"
      strokeWidth={1.5}
      strokeDasharray="4 3"
    />
  );
}

export function ResultsGantt({
  result,
  pending,
}: {
  result: ImportSimulateResponse;
  pending: boolean;
}): React.JSX.Element {
  const edits = useImportPlan((s) => s.edits);
  const undoDepth = useImportPlan((s) => s.undoStack.length);
  const applyEdit = useImportPlan((s) => s.applyEdit);
  const undoEdit = useImportPlan((s) => s.undoEdit);
  const resetEdits = useImportPlan((s) => s.resetEdits);

  const [source, setSource] = React.useState<'all' | 'file' | 'plan'>('all');
  const [hub, setHub] = React.useState('all');
  const [outcome, setOutcome] = React.useState<'all' | WhatIfOutcome>('all');
  const [search, setSearch] = React.useState('');
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = React.useState<TimingDialogTarget | null>(null);

  const base = result.base_year;
  const scale = React.useMemo(() => importScale(result), [result]);
  const metaById = React.useMemo(() => new Map(result.steps_meta.map((m) => [m.step_id, m])), [result.steps_meta]);
  const hubs = React.useMemo(() => [...new Set(result.projects.map((p) => p.hub))].sort(), [result.projects]);
  const editCount = Object.keys(edits).length;
  const yearEndX = weekEndToX(result.plan_year_end_week, scale);
  const planYear = planYearOf(result.plan_year_end_week, base);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return result.projects.filter(
      (p) =>
        (source === 'all' || p.source === source) &&
        (hub === 'all' || p.hub === hub) &&
        (outcome === 'all' || p.outcome === outcome) &&
        (q === '' || p.name.toLowerCase().includes(q)),
    );
  }, [result.projects, source, hub, outcome, search]);

  const rows: GRow[] = React.useMemo(() => {
    const out: GRow[] = [];
    for (const p of filtered) {
      out.push({ kind: 'project', key: `p:${p.ref}`, p });
      if (!expanded.has(p.ref)) continue;
      for (const s of [...p.steps].sort((a, b) => a.sequence_order - b.sequence_order)) {
        if (s.done_before_import) continue;
        out.push({
          kind: 'step',
          key: `s:${p.ref}:${s.step_id}`,
          p,
          s,
          meta: metaById.get(s.step_id),
        });
      }
    }
    return out;
  }, [filtered, expanded, metaById]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALIZE_OVER;
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the mandated virtualizer.
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'project' ? PROJECT_H : STEP_H),
    overscan: 10,
    initialRect: { width: 1200, height: 560 },
  });
  // Row heights depend on the row kind; re-measure when the row list changes.
  React.useEffect(() => {
    virtualizer.measure();
  }, [rows, virtualizer]);

  const toggle = (ref: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  const siblingsOf = (p: ImportResultProject): OverlapStep[] =>
    p.steps.map((s) => {
      const m = metaById.get(s.step_id);
      return {
        stepId: s.step_id,
        startWeek: s.start_week,
        endWeek: s.end_week,
        skipped: s.skipped || s.done_before_import,
        predecessorIds: m?.predecessor_ids ?? [],
        overlapWeeks: s.overlap_weeks,
        name: m?.name ?? s.step_id,
        kind: s.kind,
      };
    });

  const baseOf = (s: ImportResultStep) => ({
    duration_weeks: s.duration_override_weeks,
    start_not_before_week: s.start_not_before_week,
    overlap_weeks: s.overlap_weeks,
  });
  const drop = (p: ImportResultProject, s: ImportResultStep) => (edit: DropEdit) =>
    applyEdit(p.ref, s.step_id, edit, baseOf(s));

  const ticks = React.useMemo(
    () => axisTicks(scale.originWeek, scale.originWeek + scale.horizonWeeks - 1, base),
    [scale, base],
  );
  const plain = React.useMemo(() => {
    let y = 0;
    return rows.map((r, index) => {
      const start = y;
      y += r.kind === 'project' ? PROJECT_H : STEP_H;
      return { index, start, end: y };
    });
  }, [rows]);
  const items = virtual ? virtualizer.getVirtualItems() : plain;
  const totalH = virtual ? virtualizer.getTotalSize() : (plain.at(-1)?.end ?? 0);
  const totalW = LEFT_PX + scale.totalWidthPx;

  return (
    <div className="space-y-s3" data-testid="import-gantt">
      <div className="flex flex-wrap items-end gap-s3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="ig-source" className="text-2xs text-text-muted">
            Source
          </Label>
          <NativeSelect
            id="ig-source"
            className="w-36"
            value={source}
            onChange={(e) => setSource(e.target.value as typeof source)}
          >
            <option value="all">All projects</option>
            <option value="file">From the file</option>
            <option value="plan">Current plan</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ig-hub" className="text-2xs text-text-muted">
            Hub
          </Label>
          <NativeSelect id="ig-hub" className="w-36" value={hub} onChange={(e) => setHub(e.target.value)}>
            <option value="all">All hubs</option>
            {hubs.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ig-outcome" className="text-2xs text-text-muted">
            Outcome
          </Label>
          <NativeSelect
            id="ig-outcome"
            className="w-40"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as typeof outcome)}
          >
            <option value="all">All outcomes</option>
            {OUTCOME_ORDER.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="ig-search" className="text-2xs text-text-muted">
            Search
          </Label>
          <Input
            id="ig-search"
            className="h-8 w-48"
            value={search}
            placeholder="Project name"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-s2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setExpanded(new Set(filtered.map((p) => p.ref)))}
          >
            <ChevronsUpDown />
            Expand all
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setExpanded(new Set())}>
            <ChevronsDownUp />
            Collapse all
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={undoDepth === 0} onClick={undoEdit}>
            <Undo2 />
            Undo
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={editCount === 0} onClick={resetEdits}>
            <RotateCcw />
            Reset all edits{editCount > 0 ? ` (${String(editCount)})` : ''}
          </Button>
        </div>
        <span
          className="ml-auto inline-flex min-h-6 items-center gap-1.5 text-xs text-text-muted"
          role="status"
          aria-live="polite"
          data-testid="import-recomputing"
        >
          {pending ? (
            <>
              <Spinner className="size-3.5" label="Recomputing" />
              Recomputing…
            </>
          ) : null}
        </span>
      </div>
      <p className="text-2xs text-text-muted">
        Drag a step bar to move it, drag its right edge to change its length, or drop it onto the step above to run the
        two in parallel (capacity still applies). Every drop recomputes the What-if; nothing is saved. The dashed line
        is the end of {String(planYear)}.
      </p>

      {filtered.length === 0 ? (
        <p className="text-xs text-text-muted">No project matches these filters.</p>
      ) : (
        <div
          ref={scrollRef}
          className={cn(
            'relative h-[560px] overflow-auto rounded-md border border-border bg-surface',
            pending && 'opacity-80',
          )}
          role="region"
          aria-label="What-if Gantt (scrollable)"
          tabIndex={0}
          data-testid="import-gantt-scroll"
        >
          <div
            style={{
              width: totalW,
              height: AXIS_H + totalH,
              position: 'relative',
            }}
          >
            {/* Axis */}
            <div
              className="sticky top-0 z-20 flex border-b border-border bg-surface-raised"
              style={{ height: AXIS_H, width: totalW }}
            >
              <div
                className="sticky left-0 z-30 flex items-end bg-surface-raised px-s3 pb-1 text-2xs font-semibold uppercase tracking-wide text-text-muted"
                style={{ width: LEFT_PX, minWidth: LEFT_PX }}
              >
                Project / step
              </div>
              <svg width={scale.totalWidthPx} height={AXIS_H} aria-hidden="true" data-testid="import-gantt-axis">
                {ticks.map((t) => (
                  <g key={t.week}>
                    <line
                      x1={weekToX(t.week, scale)}
                      x2={weekToX(t.week, scale)}
                      y1={t.yearStart ? 0 : AXIS_H - 8}
                      y2={AXIS_H}
                      stroke="hsl(var(--color-gantt-grid-strong))"
                    />
                    <text
                      x={weekToX(t.week, scale) + 3}
                      y={AXIS_H - 10}
                      fontSize={10}
                      fill="hsl(var(--color-text-muted))"
                      fontWeight={t.yearStart ? 700 : 400}
                    >
                      {t.label}
                    </text>
                  </g>
                ))}
                <YearEndLine x={yearEndX} height={AXIS_H} />
                <text
                  x={Math.max(2, yearEndX - 4)}
                  y={10}
                  fontSize={9}
                  textAnchor="end"
                  fill="hsl(var(--color-text-muted))"
                >
                  {`End of ${String(planYear)}`}
                </text>
              </svg>
            </div>

            {items.map((v) => {
              const row = rows[v.index];
              if (!row) return null;
              const h = row.kind === 'project' ? PROJECT_H : STEP_H;
              return (
                <div
                  key={row.key}
                  className={cn(
                    'absolute left-0 flex border-b border-border/60',
                    row.kind === 'step' && 'bg-surface-sunken/30',
                  )}
                  style={{ top: AXIS_H + v.start, height: h, width: totalW }}
                  data-testid={row.kind === 'project' ? 'import-gantt-project' : 'import-gantt-step'}
                  data-ref={row.p.ref}
                  data-step-id={row.kind === 'step' ? row.s.step_id : undefined}
                >
                  <div
                    className="sticky left-0 z-10 flex items-center border-r border-border bg-surface"
                    style={{ width: LEFT_PX, minWidth: LEFT_PX }}
                  >
                    {row.kind === 'project' ? (
                      <ProjectLeft
                        p={row.p}
                        open={expanded.has(row.p.ref)}
                        onToggle={() => toggle(row.p.ref)}
                        base={base}
                        metaById={metaById}
                      />
                    ) : (
                      <StepLeft
                        p={row.p}
                        s={row.s}
                        meta={row.meta}
                        edited={edits[editKey(row.p.ref, row.s.step_id)] !== undefined}
                        onEdit={() => {
                          const e = edits[editKey(row.p.ref, row.s.step_id)];
                          setDialog({
                            ref: row.p.ref,
                            stepId: row.s.step_id,
                            title: `${row.meta?.name ?? row.s.step_id} — ${row.p.name}`,
                            editable: row.s.editable,
                            hasPredecessors: (row.meta?.predecessor_ids.length ?? 0) > 0,
                            current: e ?? baseOf(row.s),
                          });
                        }}
                      />
                    )}
                  </div>
                  <div className="relative" style={{ width: scale.totalWidthPx, height: h }}>
                    <svg width={scale.totalWidthPx} height={h} className="absolute inset-0">
                      <YearEndLine x={yearEndX} height={h} />
                      {row.kind === 'project' ? (
                        <ProjectBar p={row.p} scale={scale} h={h} base={base} />
                      ) : (
                        <StepBar p={row.p} s={row.s} meta={row.meta} scale={scale} h={h} base={base} />
                      )}
                    </svg>
                    {row.kind === 'step' ? (
                      <StepDragHandles
                        step={row.s}
                        stepName={row.meta?.name ?? row.s.step_id}
                        siblings={siblingsOf(row.p)}
                        scale={scale}
                        rowHeight={h}
                        frontier={result.current_week}
                        baseYear={base}
                        disabled={false}
                        onDrop={drop(row.p, row.s)}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ImportStepTimingDialog
        target={dialog}
        baseYear={base}
        currentWeek={result.current_week}
        horizonWeeks={result.horizon_weeks}
        onClose={() => setDialog(null)}
        onSave={(edit) => {
          if (dialog) {
            const p = result.projects.find((x) => x.ref === dialog.ref);
            const s = p?.steps.find((x) => x.step_id === dialog.stepId);
            applyEdit(dialog.ref, dialog.stepId, edit, s ? baseOf(s) : {});
          }
          setDialog(null);
        }}
      />
    </div>
  );
}

function doneBeforeImport(p: ImportResultProject, metaById: Map<string, ImportStepMeta>): string[] {
  return p.steps.filter((s) => s.done_before_import).map((s) => metaById.get(s.step_id)?.name ?? s.step_id);
}

function ProjectLeft({
  p,
  open,
  onToggle,
  base,
  metaById,
}: {
  p: ImportResultProject;
  open: boolean;
  onToggle: () => void;
  base: number;
  metaById: Map<string, ImportStepMeta>;
}): React.JSX.Element {
  const done = doneBeforeImport(p, metaById);
  return (
    <button
      type="button"
      className="flex h-full w-full min-w-0 items-center gap-1.5 px-s2 text-left hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-expanded={open}
      aria-label={`${p.name}: ${open ? 'collapse' : 'expand'} steps`}
      onClick={onToggle}
      title={done.length > 0 ? `Done before the import: ${done.join(', ')}` : p.name}
    >
      {open ? (
        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-text">{p.name}</span>
        <span className="flex min-w-0 items-center gap-1 text-2xs text-text-muted">
          <span className="truncate">{`${p.hub} · ${p.priority} · ${p.leader_name ?? 'no leader'}`}</span>
          {p.source === 'file' ? <Badge tone="primary">file</Badge> : null}
          <Badge tone={OUTCOME_TONE[p.outcome]}>{OUTCOME_LABEL[p.outcome]}</Badge>
          <span className="sr-only">{`Finish ${weekOrDash(p.finish_week, base)}`}</span>
        </span>
      </span>
    </button>
  );
}

function StepLeft({
  p,
  s,
  meta,
  edited,
  onEdit,
}: {
  p: ImportResultProject;
  s: ImportResultStep;
  meta: ImportStepMeta | undefined;
  edited: boolean;
  onEdit: () => void;
}): React.JSX.Element {
  const name = meta?.name ?? s.step_id;
  const resource = s.kind === 'lab' ? s.chamber_code : s.kind === 'design' ? s.engineer_name : null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-s6 pr-s2" data-skipped={s.skipped || undefined}>
      <StepKindBadge kind={s.kind} compact />
      <span className="min-w-0 flex-1">
        <span
          className={cn('block truncate text-2xs', s.skipped ? 'text-text-muted line-through' : 'text-text')}
          title={name}
        >
          {`${String(s.sequence_order)}. ${name}`}
          {s.skipped ? <span className="sr-only"> (skipped)</span> : null}
        </span>
        {resource ? <span className="block truncate text-[0.625rem] text-text-muted">{resource}</span> : null}
      </span>
      {edited ? (
        <span
          className="inline-flex items-center gap-0.5 rounded-sm bg-primary-subtle px-1 text-[0.625rem] font-semibold leading-4 text-primary-subtle-fg"
          data-testid="import-step-edited"
        >
          <PencilLine className="size-2.5" aria-hidden="true" />
          edited
        </span>
      ) : null}
      {s.editable !== 'none' && !s.skipped ? (
        <button
          type="button"
          className="shrink-0 rounded-sm p-0.5 text-text-muted hover:bg-surface-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Edit timing for ${name} (${p.name})`}
          title="Edit timing"
          onClick={onEdit}
        >
          <SlidersHorizontal className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function ProjectBar({
  p,
  scale,
  h,
  base,
}: {
  p: ImportResultProject;
  scale: WeekScale;
  h: number;
  base: number;
}): React.JSX.Element | null {
  const geom = visibleBar(p.start_week, p.end_week, scale);
  if (!geom) {
    if (p.outcome !== 'left_out' && p.outcome !== 'data_error' && p.outcome !== 'blocked' && p.outcome !== 'excluded')
      return null;
    return (
      <text
        x={6}
        y={h / 2}
        dominantBaseline="central"
        fontSize={10}
        fontWeight={600}
        fill="hsl(var(--color-warning-subtle-fg))"
        data-testid="import-gantt-unplaced"
      >
        {OUTCOME_LABEL[p.outcome]}
      </text>
    );
  }
  const barH = 16;
  const y = (h - barH) / 2;
  const title = `${p.name}: ${p.start_week !== null ? longWeekLabel(p.start_week, base) : '—'} to ${p.end_week !== null ? longWeekLabel(p.end_week, base) : '—'} · ${OUTCOME_LABEL[p.outcome]}`;
  return (
    <g data-testid="import-gantt-summary-bar">
      <title>{title}</title>
      <rect x={geom.x} y={y} width={geom.width} height={barH} rx={barH / 2} fill="hsl(var(--color-gantt-planned))" />
      {geom.continuesPastEnd ? (
        <path
          d={`M ${String(geom.x + geom.width - 8)} ${String(y - 2)} L ${String(geom.x + geom.width)} ${String(y + barH / 2)} L ${String(geom.x + geom.width - 8)} ${String(y + barH + 2)} Z`}
          fill="hsl(var(--color-gantt-marker-year))"
          data-testid="import-gantt-continues"
        />
      ) : null}
      {geom.width >= 110 && p.start_week !== null && p.end_week !== null ? (
        <text
          x={geom.x + 8}
          y={y + barH / 2}
          dominantBaseline="central"
          fontSize={10}
          fontWeight={700}
          fill="white"
          pointerEvents="none"
        >
          {`${shortWeekLabel(p.start_week, base)} – ${shortWeekLabel(p.end_week, base)}`}
        </text>
      ) : null}
    </g>
  );
}

function StepBar({
  p,
  s,
  meta,
  scale,
  h,
  base,
}: {
  p: ImportResultProject;
  s: ImportResultStep;
  meta: ImportStepMeta | undefined;
  scale: WeekScale;
  h: number;
  base: number;
}): React.JSX.Element | null {
  if (s.skipped) return null;
  const geom = visibleBar(s.start_week, s.end_week, scale);
  if (!geom) return null;
  const barH = 12;
  const y = (h - barH) / 2;
  const { fill, stroke } = stepFill(s.kind);
  const who = s.engineer_name ?? s.chamber_code;
  const title = `${meta?.name ?? s.step_id} (${p.name}): ${s.start_week !== null ? longWeekLabel(s.start_week, base) : '—'} to ${
    s.end_week !== null ? longWeekLabel(s.end_week, base) : '—'
  }${s.duration_weeks !== null ? ` · ${String(s.duration_weeks)} wks` : ''}${who ? ` · ${who}` : ''}${s.overlap_weeks ? ` · ${String(s.overlap_weeks)} wk overlap` : ''} · ${s.status}`;
  return (
    <g data-testid="import-gantt-step-bar" data-kind={s.kind}>
      <title>{title}</title>
      <rect
        x={geom.x}
        y={y}
        width={geom.width}
        height={barH}
        rx={barH / 2}
        fill={fill}
        stroke={stroke}
        strokeWidth={stroke === 'none' ? 0 : 1.5}
      />
    </g>
  );
}
