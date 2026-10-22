import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
} from 'recharts';
import { useQueryClient } from '@tanstack/react-query';
import { GitCompareArrows, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { useScenarioStore } from '@/stores/scenario';

import {
  COMPARE_MAX,
  COMPARE_MIN,
  SCORE_RANGE_HELP_COPY,
  type DimensionKey,
  type DimensionScore,
  type DimensionScoreMap,
  type PriorityCompareProject,
  type PriorityMatrixRow,
  type PriorityScoreRead,
} from '../api/types';
import { usePriorityCompare, usePriorityEditRows, useUpdatePriorityScore } from '../hooks/use-matrix';
import { useCompareSelection, type CompareItem } from '../lib/compare-selection';
import { groupByPillar } from '../lib/pillars';
import { formatOutOf100, formatPoints, rowMissingLabels } from '../lib/row-scores';
import { previewScore } from '../lib/score-preview';
import { useScoringModel } from '../scoring-model';
import { SuggestedBandChip } from '@/components/shared/suggested-band-chip';
import { liveRequestValuesFromRow, scoresMapSchema, toRequestBody } from './score-edit-schema';
import { IncompleteScoreMarker } from '@/components/shared/incomplete-score-marker';

/**
 * P21 Compare: a sticky "Compare (n)" bar for the 2–5 selected projects and a
 * dialog with a radar of the served dimension scores (one colour per project, with
 * a legend that toggles series) and a dimension × project table. Every figure
 * is from `GET /priorities/compare`; the table only marks each row's highest
 * served value.
 *
 * P21-T04: users who may edit scores (the edit dialog's rule: Matrix write and
 * no 403 seen) get a 0–5 menu in each cell. Saving is EXPLICIT, per project
 * ("Save changes (n)" + "Discard"), never autosave: each save is an audited
 * `PUT /priorities/{id}` with the edit dialog's body shape (P26: `{scores,
 * hard_gates}` with only the edited dimensions; "–" sends null and clears a
 * score; the project's current hard gates), through the same mutation. While a project has
 * unsaved edits its points and score out of 100 are shown as a labelled
 * PREVIEW; the authoritative figures are re-read from the server after the save
 * (compare, grid rows, distribution). In Scenario mode the same button stages
 * the change in the scenario store instead, exactly as the edit dialog does.
 */

/** Distinct categorical hues (design tokens), one per compared project. */
const SERIES = ['--dash-cat-1', '--dash-cat-2', '--dash-cat-4', '--dash-cat-5', '--dash-cat-6'] as const;
const seriesColor = (i: number) => `hsl(var(${SERIES[i % SERIES.length] ?? '--dash-cat-1'}))`;
const SCORE_OPTIONS = [0, 1, 2, 3, 4, 5] as const;
const HELP_ID = 'compare-score-help';

// --- Bar ------------------------------------------------------------------------

export function CompareBar({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const items = useCompareSelection((s) => s.items);
  const capHit = useCompareSelection((s) => s.capHit);
  const remove = useCompareSelection((s) => s.remove);
  const clear = useCompareSelection((s) => s.clear);
  if (items.length === 0) return null;
  const n = items.length;
  const ready = n >= COMPARE_MIN;

  return (
    <div
      className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-dash border-[1.5px] border-primary/40 bg-surface px-3 py-2 shadow-pop"
      role="region"
      aria-label="Compare selection"
      data-testid="compare-bar"
    >
      <GitCompareArrows className="size-4 text-primary" aria-hidden="true" />
      <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5" aria-label="Selected projects">
        {items.map((it) => (
          <li
            key={it.id}
            className="inline-flex max-w-[14rem] items-center gap-1 rounded border border-border bg-surface-sunken py-0.5 pl-2 pr-0.5 text-2xs text-text"
          >
            <span className="truncate" title={`${it.name} (${it.hub})`}>
              {it.name}
            </span>
            <button
              type="button"
              onClick={() => remove(it.id)}
              className="rounded-sm p-0.5 text-text-muted hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Remove ${it.name} from compare`}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <p className="text-2xs text-text-muted" role="status" data-testid="compare-message">
        {capHit
          ? `Up to ${String(COMPARE_MAX)} projects can be compared. Remove one to add another.`
          : ready
            ? `${String(n)} of ${String(COMPARE_MAX)} selected`
            : `Select at least ${String(COMPARE_MIN)} projects to compare`}
      </p>
      <Button variant="secondary" size="sm" onClick={clear}>
        Clear
      </Button>
      <Button size="sm" onClick={onOpen} disabled={!ready}>
        Compare ({n})
      </Button>
    </div>
  );
}

// --- Dialog -----------------------------------------------------------------------

type Edits = Record<string, DimensionScoreMap>;
type SaveStatus =
  | { kind: 'saving' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; message: string };

export interface CompareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The edit dialog's rule: Matrix write permission and no 403 seen. */
  canEdit?: boolean;
  /** Matrix Scenario mode: edits are staged, not saved. */
  scenarioActive?: boolean;
  /** Called (on close) when a save answered 403, so the page downgrades like the edit dialog does. */
  onForbidden?: () => void;
}

export function CompareDialog({
  open,
  onOpenChange,
  canEdit = false,
  scenarioActive = false,
  onForbidden,
}: CompareDialogProps): React.JSX.Element {
  const items = useCompareSelection((s) => s.items);
  const ids = React.useMemo(() => items.map((i) => i.id), [items]);
  const query = usePriorityCompare(ids, open && ids.length >= COMPARE_MIN);
  const [edits, setEdits] = React.useState<Edits>({});
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [forbidden, setForbidden] = React.useState(false);

  const dirty = Object.values(edits).some((e) => Object.keys(e).length > 0);

  const close = () => {
    setEdits({});
    setConfirmOpen(false);
    if (forbidden) {
      setForbidden(false);
      onForbidden?.();
    }
    onOpenChange(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (dirty) setConfirmOpen(true);
    else close();
  };

  const data = query.data;
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[calc(100vw-1rem)] max-w-5xl overflow-y-auto p-4 sm:p-5">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Compare projects ({items.length})
            {scenarioActive ? (
              <Badge tone="warning" data-testid="compare-scenario-badge">
                Scenario
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            The dimension scores (0–5) with their points, and the score out of 100. All figures are served by the
            API; the highest value in each row is marked.
            {canEdit
              ? scenarioActive
                ? ' Changes you stage here go into the scenario; nothing is saved until you apply it.'
                : ' Change a score with its menu, then save each project. Each save is recorded in the audit log.'
              : null}
          </DialogDescription>
        </DialogHeader>
        {data ? (
          <>
            {query.isError ? (
              <p role="alert" className="text-xs text-danger">
                The comparison could not be refreshed; the figures below may be out of date.
              </p>
            ) : null}
            <CompareBody
              projects={orderLike(data.projects, items)}
              canEdit={canEdit && !forbidden}
              forbidden={forbidden}
              scenarioActive={scenarioActive}
              edits={edits}
              setEdits={setEdits}
              onForbidden={() => setForbidden(true)}
              loadRows={open && canEdit}
            />
          </>
        ) : query.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading comparison">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <p role="alert" className="text-xs text-danger">
            {compareErrorText(query.error)}
          </p>
        )}
        <UnsavedEditsDialog open={confirmOpen} onKeepEditing={() => setConfirmOpen(false)} onDiscard={close} />
      </DialogContent>
    </Dialog>
  );
}

/** The close guard: keep editing (default focus) or discard every unsaved Compare edit. */
function UnsavedEditsDialog({
  open,
  onKeepEditing,
  onDiscard,
}: {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeepEditing();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-slate-950/30" />
        <DialogPrimitive.Content
          role="alertdialog"
          data-testid="compare-discard-dialog"
          className="fixed left-1/2 top-1/2 z-[60] grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-border bg-surface p-5 shadow-lg"
        >
          <DialogPrimitive.Title className="text-base font-semibold text-text">Discard unsaved score changes?</DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-sm text-text-muted">
            Some scores in the comparison are changed but not saved. Closing now loses them.
          </DialogPrimitive.Description>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={onKeepEditing}>
              Keep editing
            </Button>
            <Button type="button" variant="danger" size="sm" onClick={onDiscard}>
              Discard changes
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** API_CONTRACT_P21 §5 error codes, in words. */
function compareErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'COMPARE_PROJECT_UNAVAILABLE' || error.isForbidden) {
      return 'One of the selected projects is no longer available to you. Remove it and try again.';
    }
    if (error.code === 'COMPARE_COUNT') return `Select ${String(COMPARE_MIN)} to ${String(COMPARE_MAX)} projects to compare.`;
    if (error.code === 'COMPARE_DUPLICATE') return 'A project was selected twice. Clear the selection and try again.';
  }
  return 'The comparison could not be loaded. Close and try again.';
}

/** A save error in words; 403 and 422 keep the edits (the caller never clears them on error). */
function saveErrorText(error: unknown, scenario: boolean): string {
  if (error instanceof ApiError && error.isForbidden) {
    return 'Your role cannot edit prioritization scores. Your changes are kept; close the dialog to discard them.';
  }
  if (error instanceof ApiError && error.status === 422) {
    return `The server rejected these scores: ${error.detail ?? 'check each score is a whole number from 0 to 5'}.`;
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'This project is no longer available to you. Your changes are kept.';
  }
  return scenario ? 'The change could not be staged. Please try again.' : 'The scores could not be saved. Please try again.';
}

/** Keep the selection order (display only). */
function orderLike(projects: PriorityCompareProject[], items: CompareItem[]): PriorityCompareProject[] {
  const pos = new Map(items.map((it, i) => [it.id, i]));
  return [...projects].sort((a, b) => (pos.get(a.project_id) ?? 99) - (pos.get(b.project_id) ?? 99));
}

interface DimRow {
  key: DimensionKey;
  label: string;
  pillar: string;
  cells: (DimensionScore | undefined)[];
}

/** One row per served ACTIVE dimension (display order, grouped by pillar in
 *  order of first appearance), from the first project that carries any. */
function dimensionRows(projects: PriorityCompareProject[]): DimRow[] {
  const first = projects.find((p) => p.dimension_scores.length > 0);
  if (!first) return [];
  return groupByPillar(first.dimension_scores)
    .flatMap((g) => g.items)
    .map((d) => ({
      key: d.key,
      label: d.label,
      pillar: d.pillar,
      cells: projects.map((p) => p.dimension_scores.find((x) => x.key === d.key)),
    }));
}

/** Indices holding the row's highest served value (ties all marked; none when all null). */
function highest(values: (number | null | undefined)[]): Set<number> {
  let best: number | null = null;
  for (const v of values) if (v !== null && v !== undefined && (best === null || v > best)) best = v;
  const out = new Set<number>();
  if (best === null) return out;
  values.forEach((v, i) => {
    if (v === best) out.add(i);
  });
  return out;
}

interface CompareBodyProps {
  projects: PriorityCompareProject[];
  canEdit: boolean;
  forbidden: boolean;
  scenarioActive: boolean;
  edits: Edits;
  setEdits: React.Dispatch<React.SetStateAction<Edits>>;
  onForbidden: () => void;
  loadRows: boolean;
}

function CompareBody({
  projects,
  canEdit,
  forbidden,
  scenarioActive,
  edits,
  setEdits,
  onForbidden,
  loadRows,
}: CompareBodyProps): React.JSX.Element {
  const reduced = usePrefersReducedMotion();
  const model = useScoringModel();
  const queryClient = useQueryClient();
  const updateScore = useUpdatePriorityScore();
  const pending = useScenarioStore((s) => s.pending);
  const stageEdit = useScenarioStore((s) => s.stageEdit);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = React.useState<Record<string, SaveStatus | undefined>>({});
  const editable = canEdit || forbidden; // after a 403 the menus stay so the edits remain visible
  const rowQueries = usePriorityEditRows(
    projects.map((p) => p.project_id),
    loadRows,
  );
  const liveRows = new Map<string, PriorityMatrixRow>();
  projects.forEach((p, i) => {
    const r = rowQueries[i]?.data;
    if (r) liveRows.set(p.project_id, r);
  });

  const rows = dimensionRows(projects);
  const pillars = [...new Set(rows.map((r) => r.pillar))];
  const radarData = rows.map((r) => {
    const d: Record<string, string | number | null> = { dim: r.label };
    r.cells.forEach((c, i) => {
      const p = projects[i];
      if (p) d[p.project_id] = c?.score ?? null;
    });
    return d;
  });
  const scoreTop = highest(projects.map((p) => p.normalized_pct));

  /** The value a cell starts from: the staged scenario value in Scenario mode, else the served score. */
  const baseOf = (p: PriorityCompareProject, key: DimensionKey): number | null => {
    const staged = scenarioActive ? pending[p.project_id] : undefined;
    if (staged && Object.prototype.hasOwnProperty.call(staged.next.scores, key)) return staged.next.scores[key] ?? null;
    return p.dimension_scores.find((d) => d.key === key)?.score ?? null;
  };
  const isEdited = (p: PriorityCompareProject, key: DimensionKey): boolean =>
    Object.prototype.hasOwnProperty.call(edits[p.project_id] ?? {}, key);
  const valueOf = (p: PriorityCompareProject, key: DimensionKey): number | null =>
    isEdited(p, key) ? (edits[p.project_id]?.[key] ?? null) : baseOf(p, key);
  const dirtyCount = (id: string) => Object.keys(edits[id] ?? {}).length;
  const isStaged = (id: string) => scenarioActive && pending[id] !== undefined;

  const setCell = (p: PriorityCompareProject, key: DimensionKey, value: number | null) => {
    const base = baseOf(p, key);
    setEdits((prev) => {
      const cur = { ...(prev[p.project_id] ?? {}) };
      if (value === base) delete cur[key];
      else cur[key] = value;
      return { ...prev, [p.project_id]: cur };
    });
    setStatus((prev) => ({ ...prev, [p.project_id]: undefined }));
  };

  const discard = (id: string) => {
    setEdits((prev) => ({ ...prev, [id]: {} }));
    setStatus((prev) => ({ ...prev, [id]: undefined }));
  };

  const previewOf = (p: PriorityCompareProject) => {
    if (dirtyCount(p.project_id) === 0 && !isStaged(p.project_id)) return null;
    return previewScore(
      p.dimension_scores.map((d) => ({ score: valueOf(p, d.key), weight: d.weight })),
      model.total_weight,
    );
  };

  const save = async (p: PriorityCompareProject) => {
    const id = p.project_id;
    const row = liveRows.get(id);
    if (!row || dirtyCount(id) === 0) return;
    // P26: only the edited dimensions are sent (omitted keys keep their value; null clears).
    const parsed = scoresMapSchema.safeParse(edits[id] ?? {});
    if (!parsed.success) {
      setStatus((prev) => ({ ...prev, [id]: { kind: 'error', message: 'Each score must be a whole number from 0 to 5, or not scored.' } }));
      return;
    }
    const staged = scenarioActive ? pending[id] : undefined;
    const body = toRequestBody(parsed.data, staged ? staged.next.hard_gates : row.hard_gates);

    if (scenarioActive) {
      const live = liveRequestValuesFromRow(row);
      stageEdit({
        projectId: id,
        projectName: p.project_name,
        hub: p.hub,
        liveValues: live,
        liveHasScore: row.has_score,
        next: { scores: { ...(staged?.next.scores ?? live.scores), ...body.scores }, hard_gates: body.hard_gates },
        labels: Object.fromEntries(p.dimension_scores.map((d) => [d.key, d.label])),
      });
      setEdits((prev) => ({ ...prev, [id]: {} }));
      setStatus((prev) => ({
        ...prev,
        [id]: { kind: 'done', message: 'Staged in the scenario. Nothing is saved until you apply the scenario.' },
      }));
      return;
    }

    setStatus((prev) => ({ ...prev, [id]: { kind: 'saving' } }));
    try {
      const saved = (await updateScore.mutateAsync({ projectId: id, body })) as PriorityScoreRead | undefined;
      // The mutation re-reads every `priority-matrix` query (grid, distribution, rows,
      // compare); wait for compare so the served figures replace the preview in one step.
      await queryClient.invalidateQueries({ queryKey: ['priority-matrix', 'compare'] });
      setEdits((prev) => ({ ...prev, [id]: {} }));
      const served =
        saved && typeof saved.normalized_pct === 'number'
          ? ` The server's score is ${formatOutOf100(saved.normalized_pct)}${saved.suggested_band ? `, band ${saved.suggested_band}` : ''}.`
          : '';
      setStatus((prev) => ({ ...prev, [id]: { kind: 'done', message: `Saved.${served}` } }));
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) onForbidden();
      setStatus((prev) => ({ ...prev, [id]: { kind: 'error', message: saveErrorText(err, false) } }));
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="compare-body">
      <ul className="flex flex-wrap gap-1.5" aria-label="Legend — choose a project to show or hide it on the chart">
        {projects.map((p, i) => {
          const off = hidden.has(p.project_id);
          return (
            <li key={p.project_id}>
              <button
                type="button"
                aria-pressed={!off}
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(p.project_id)) next.delete(p.project_id);
                    else next.add(p.project_id);
                    return next;
                  })
                }
                className={cn(
                  'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-2xs text-text',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  off ? 'border-dashed border-border text-text-muted line-through' : 'border-border-strong',
                )}
              >
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(i) }} aria-hidden="true" />
                <span className="font-semibold">{p.project_name}</span>
                <span className="text-text-muted">{p.hub}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <figure
        className="h-72 w-full sm:h-80"
        aria-label={`Radar of the ${String(rows.length)} served dimension scores (0–5) per project; the table below has the same figures`}
        data-testid="compare-radar"
      >
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={radarData} outerRadius="72%">
            <PolarGrid stroke="hsl(var(--color-border))" />
            <PolarAngleAxis dataKey="dim" tick={{ fill: 'hsl(var(--color-text-muted))', fontSize: 10 }} />
            <PolarRadiusAxis domain={[0, 5]} tickCount={6} tick={{ fontSize: 9 }} angle={90} />
            {projects.map((p, i) =>
              hidden.has(p.project_id) ? null : (
                <Radar
                  key={p.project_id}
                  name={p.project_name}
                  dataKey={p.project_id}
                  stroke={seriesColor(i)}
                  fill={seriesColor(i)}
                  fillOpacity={0.12}
                  strokeWidth={2}
                  isAnimationActive={!reduced}
                />
              ),
            )}
            <ChartTooltip
              contentStyle={{
                background: 'hsl(var(--color-surface))',
                border: '1.5px solid hsl(var(--color-border))',
                borderRadius: 12,
                fontSize: 12,
              }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </figure>

      {editable ? (
        <p className="text-2xs text-text-muted" id={HELP_ID} data-testid="compare-edit-help">
          Scores 0–5: {SCORE_RANGE_HELP_COPY}; “– Not scored” clears a score (it then counts 0 and the score is
          incomplete). Only edited cells are sent. Edited cells are marked; figures marked “preview” are provisional
          until the server has saved them. The chart and the highest-value marks show saved figures only.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded border border-border" role="region" aria-label="Comparison table" tabIndex={0}>
        <table
          className={cn('w-full border-collapse text-xs', editable ? 'min-w-[40rem]' : 'min-w-[36rem]')}
          data-testid="compare-table"
        >
          <caption className="sr-only">Dimension scores and points per project; the highest in each row is marked</caption>
          <thead className="bg-surface-sunken">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-[1] bg-surface-sunken px-2 py-2 text-left text-2xs font-bold uppercase tracking-wider text-text-subtle"
              >
                Dimension
              </th>
              {projects.map((p, i) => (
                <th key={p.project_id} scope="col" className="px-2 py-2 text-right text-xs font-semibold text-text">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: seriesColor(i) }} aria-hidden="true" />
                    {p.project_name}
                  </span>
                  {p.has_score ? null : <span className="block text-2xs font-normal text-text-muted">Not scored</span>}
                  {isStaged(p.project_id) ? (
                    <span className="block text-2xs font-normal text-warning-subtle-fg">Staged in scenario</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          {pillars.map((pillar) => (
            <tbody key={pillar}>
              <tr className="bg-primary-subtle/40">
                <th
                  scope="colgroup"
                  colSpan={projects.length + 1}
                  className="px-2 py-1 text-left text-2xs font-bold uppercase tracking-wider text-text"
                >
                  {pillar}
                </th>
              </tr>
              {rows
                .filter((r) => r.pillar === pillar)
                .map((r) => {
                  const top = highest(r.cells.map((c) => c?.points ?? c?.score));
                  return (
                    <tr key={r.key} className="border-b border-border/60" data-testid="compare-row">
                      <th scope="row" className="sticky left-0 z-[1] bg-surface px-2 py-1.5 text-left font-medium text-text">
                        {r.label}
                      </th>
                      {r.cells.map((c, i) => {
                        const p = projects[i];
                        if (!p) return null;
                        if (!editable) return <CompareCell key={p.project_id} cell={c} top={top.has(i)} />;
                        const preview = previewOf(p);
                        const dimIndex = p.dimension_scores.findIndex((d) => d.key === r.key);
                        return (
                          <EditableCell
                            key={p.project_id}
                            label={r.label}
                            project={p.project_name}
                            cell={c}
                            top={top.has(i)}
                            value={valueOf(p, r.key)}
                            dirty={isEdited(p, r.key)}
                            previewPoints={preview && dimIndex >= 0 ? (preview.points[dimIndex] ?? null) : undefined}
                            disabled={!canEdit || status[p.project_id]?.kind === 'saving'}
                            onChange={(v) => setCell(p, r.key, v)}
                          />
                        );
                      })}
                    </tr>
                  );
                })}
            </tbody>
          ))}
          <tfoot>
            <tr className="border-t-2 border-border-strong" data-testid="compare-total-row">
              <th scope="row" className="sticky left-0 z-[1] bg-surface px-2 py-2 text-left font-semibold text-text">
                Score /100 and band
              </th>
              {projects.map((p, i) => {
                const preview = editable ? previewOf(p) : null;
                return (
                  <td
                    key={p.project_id}
                    className={cn('px-2 py-2 text-right', scoreTop.has(i) && 'bg-primary-subtle font-bold')}
                  >
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {!p.has_score || p.normalized_pct === null ? (
                        <span className="text-2xs text-text-muted">Not scored</span>
                      ) : (
                        <>
                          <span className="tnum text-text" data-numeric="" data-testid="compare-served-score">
                            {formatOutOf100(p.normalized_pct)}
                          </span>
                          <BandChip project={p} />
                          <IncompleteScoreMarker missingLabels={rowMissingLabels(p)} compact />
                        </>
                      )}
                      {scoreTop.has(i) ? <span className="sr-only">(highest)</span> : null}
                    </span>
                    {preview ? (
                      <span
                        className="mt-1 flex items-center justify-end gap-1 text-2xs font-normal text-text"
                        data-testid="compare-preview-score"
                      >
                        <Badge tone="warning">{isStaged(p.project_id) && dirtyCount(p.project_id) === 0 ? 'scenario preview' : 'preview'}</Badge>
                        <span className="tnum" data-numeric="">
                          {preview.outOf100 === null ? 'not scored' : formatOutOf100(preview.outOf100)}
                        </span>
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
            {editable ? (
              <tr data-testid="compare-actions-row">
                <th scope="row" className="sticky left-0 z-[1] bg-surface px-2 py-2 text-left align-top font-semibold text-text">
                  {scenarioActive ? 'Stage in scenario' : 'Save'}
                </th>
                {projects.map((p) => (
                  <ProjectActions
                    key={p.project_id}
                    project={p}
                    count={dirtyCount(p.project_id)}
                    scenario={scenarioActive}
                    blockedReason={
                      forbidden
                        ? 'forbidden'
                        : !liveRows.has(p.project_id)
                          ? rowQueries[projects.indexOf(p)]?.isError
                            ? 'The current score could not be loaded, so it cannot be saved here.'
                            : 'loading'
                          : null
                    }
                    status={status[p.project_id]}
                    onSave={() => void save(p)}
                    onDiscard={() => discard(p.project_id)}
                  />
                ))}
              </tr>
            ) : null}
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function ProjectActions({
  project,
  count,
  scenario,
  blockedReason,
  status,
  onSave,
  onDiscard,
}: {
  project: PriorityCompareProject;
  count: number;
  scenario: boolean;
  /** Why Save cannot run now: 'forbidden', 'loading', a sentence, or null. */
  blockedReason: string | null;
  status: SaveStatus | undefined;
  onSave: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  const saving = status?.kind === 'saving';
  const saveBlocked = count === 0 || saving || blockedReason !== null;
  const verb = scenario ? 'Stage changes' : 'Save changes';
  // aria-disabled (not `disabled`) so focus is never dropped when the save completes.
  return (
    <td className="px-2 py-2 text-right align-top" data-testid={`compare-actions-${project.project_id}`}>
      <div className="flex flex-col items-end gap-1.5">
        <Button
          type="button"
          size="sm"
          aria-disabled={saveBlocked}
          aria-label={`${saving ? 'Saving…' : `${verb} (${String(count)})`} for ${project.project_name}`}
          className={cn(saveBlocked && 'cursor-not-allowed opacity-50 hover:shadow-card')}
          onClick={() => {
            if (!saveBlocked) onSave();
          }}
        >
          {saving ? 'Saving…' : `${verb} (${String(count)})`}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-disabled={count === 0 || saving}
          aria-label={`Discard changes for ${project.project_name}`}
          className={cn((count === 0 || saving) && 'cursor-not-allowed opacity-50')}
          onClick={() => {
            if (count > 0 && !saving) onDiscard();
          }}
        >
          Discard
        </Button>
        {count > 0 && blockedReason !== null && blockedReason !== 'forbidden' && blockedReason !== 'loading' ? (
          <span className="max-w-[12rem] text-2xs text-text-muted">{blockedReason}</span>
        ) : null}
        {status?.kind === 'error' ? (
          <span role="alert" className="max-w-[14rem] text-2xs text-danger" data-testid="compare-save-error">
            {status.message}
          </span>
        ) : null}
        <span role="status" className="max-w-[14rem] text-2xs text-text-muted" data-testid="compare-save-status">
          {status?.kind === 'done' ? status.message : ''}
        </span>
      </div>
    </td>
  );
}

/** P25: the served suggested band (promoted by capacity fill when `capacity_fill`), same chip as the grid. */
function BandChip({ project }: { project: PriorityCompareProject }): React.JSX.Element {
  if (project.suggested_band === null) return <span className="text-2xs text-text-muted">Unscored</span>;
  return (
    <SuggestedBandChip
      band={project.suggested_band}
      capacityFill={project.capacity_fill}
      reason={project.capacity_fill_reason}
      scoreBand={project.score_band}
    />
  );
}

function EditableCell({
  label,
  project,
  cell,
  top,
  value,
  dirty,
  previewPoints,
  disabled,
  onChange,
}: {
  label: string;
  project: string;
  cell: DimensionScore | undefined;
  top: boolean;
  value: number | null;
  dirty: boolean;
  /** Provisional points while the project has unsaved / staged edits; undefined = show served points. */
  previewPoints: number | null | undefined;
  disabled: boolean;
  onChange: (value: number | null) => void;
}): React.JSX.Element {
  const maxPoints = cell?.max_points ?? null;
  const points = previewPoints !== undefined ? previewPoints : (cell?.points ?? null);
  return (
    <td
      className={cn('px-2 py-1.5 text-right', dirty ? 'bg-warning-subtle' : top && 'bg-primary-subtle font-bold')}
      data-highest={top || undefined}
      data-dirty={dirty || undefined}
    >
      <span className="inline-flex items-center justify-end gap-1.5">
        {dirty ? (
          <span className="text-2xs font-semibold text-warning-subtle-fg" aria-hidden="true">
            edited
          </span>
        ) : null}
        <select
          aria-label={`${label} score for ${project}`}
          aria-describedby={HELP_ID}
          value={value === null ? '' : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          className={cn(
            'h-7 w-[4.5rem] rounded border bg-surface px-1 text-xs text-text tnum',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-60',
            dirty ? 'border-warning font-semibold' : 'border-border-strong',
          )}
          data-testid="compare-score-select"
        >
          <option value="">– Not scored</option>
          {SCORE_OPTIONS.map((n) => (
            <option key={n} value={String(n)}>
              {n}
            </option>
          ))}
        </select>
        {points !== null && maxPoints !== null ? (
          <span
            className={cn('tnum text-2xs font-normal', previewPoints !== undefined ? 'italic text-text' : 'text-text-muted')}
            data-numeric=""
          >
            {formatPoints(points, maxPoints)}
            {previewPoints !== undefined ? <span className="sr-only"> (preview)</span> : null}
          </span>
        ) : null}
      </span>
      {dirty ? <span className="sr-only">Edited, not saved.</span> : null}
      {top ? <span className="sr-only">(highest)</span> : null}
    </td>
  );
}

function CompareCell({ cell, top }: { cell: DimensionScore | undefined; top: boolean }): React.JSX.Element {
  if (!cell || cell.score === null) {
    return <td className="px-2 py-1.5 text-right text-text-subtle">–</td>;
  }
  return (
    <td className={cn('px-2 py-1.5 text-right', top && 'bg-primary-subtle font-bold')} data-highest={top || undefined}>
      <span className="tnum text-text" data-numeric="">
        {cell.score}
      </span>
      {cell.points !== null ? (
        <span className="tnum ml-1.5 text-2xs font-normal text-text-muted" data-numeric="">
          {formatPoints(cell.points, cell.max_points)}
        </span>
      ) : null}
      {top ? <span className="sr-only">(highest)</span> : null}
    </td>
  );
}
