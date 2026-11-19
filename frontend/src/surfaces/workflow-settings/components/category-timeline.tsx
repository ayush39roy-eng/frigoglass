import * as React from 'react';
import { ChevronDown, Loader2, Minus, Plus, Save, TriangleAlert, Undo2 } from 'lucide-react';

import { STEP_KIND_META } from '@/components/shared/step-kind-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { WorkflowStepKind } from '@/types/enums';

import { ApiError } from '@/lib/api/client';

import type {
  CategoryTimeline,
  LeadTimeSetting,
  TemplateChangeEntry,
  TemplateStepOverride,
  TimelineStep,
} from '../api/types';
import { useTemplateEditor, useTimelinePreview } from '../hooks/use-template-editor';
import { applyErrorMessage, TEMPLATE_COPY } from '../lib/template-copy';
import {
  canNudge,
  changeEntry,
  currentValue,
  draftOverrides,
  gapBadge,
  overrideValue,
  savedCells,
  signedWeeks,
  templateFlagNote,
  type CategoryDrafts,
  type DraftField,
  type SavedCell,
} from '../lib/template-drafts';

/**
 * Per-category timelines (P13-T16, mock-up images 14–16; editable since
 * P33-T16, ADR 0045 §1, API_CONTRACT_P33 C2 / D / Part I).
 *
 * A collapsible, hand-built mini-Gantt per category. Every start week,
 * duration, total and flag is a served field of `GET /workflow-settings/
 * category-timelines` or, while editing, of `POST /workflow-templates/
 * timeline-preview` (no capacity, FTE 1.0, one leader; computed server-side).
 * The browser only positions bars: left = start − first start, width =
 * duration, both over the served `total_weeks`.
 *
 * With `workflow_templates.write` each step row gets Move − / + (the signed
 * gap) and Length − / + (the template weeks); the values are drafts until
 * Save, which opens the apply dialog (E2 → E3). No drag.
 */

const BAR_TONE: Record<WorkflowStepKind, string> = {
  design: 'border-primary bg-primary/15 text-primary-subtle-fg',
  lab: 'border-success bg-success/15 text-success-subtle-fg',
  elapsed: 'border-dashed border-border-strong bg-surface-sunken text-text-muted',
};

const WAIT_HATCH =
  'bg-[repeating-linear-gradient(135deg,hsl(var(--color-warning)/0.55)_0_2px,transparent_2px_5px)] border border-dashed border-warning/60';

/** What the editor needs from the page; absent = read-only display. */
export interface TemplateEditing {
  /** `workflow_templates.write`. Readers see the timelines and gaps, no controls. */
  canWrite: boolean;
  /** C1 `lead_times[]`: the saved template values. */
  leadTimes: readonly LeadTimeSetting[];
  /** C1 `categories[].template_version`, by code (the apply's `base_version`). */
  versions: Readonly<Record<string, number>>;
  /** Save: opens the apply dialog with this change entry. */
  onSave: (entry: TemplateChangeEntry, summary: string[], onApplied: () => void) => void;
  /** An apply is being checked / written / followed. */
  saving: boolean;
}

export interface CategoryTimelineListProps {
  timelines: CategoryTimeline[];
  editing?: TemplateEditing | undefined;
  /** Open this category (e.g. a category just added); else the first is open. */
  openCategory?: string | null;
}

export function CategoryTimelineList({ timelines, editing, openCategory }: CategoryTimelineListProps): React.JSX.Element {
  if (timelines.length === 0) {
    return <p className="py-s6 text-center text-sm text-text-muted">No categories configured for this workflow.</p>;
  }
  const opened = openCategory && timelines.some((t) => t.category === openCategory) ? openCategory : timelines[0]?.category;
  return (
    <div className="space-y-s3">
      {timelines.map((t) =>
        editing ? (
          <EditableCategoryTimeline key={t.category} timeline={t} editing={editing} defaultOpen={t.category === opened} />
        ) : (
          <CategoryTimelinePreview key={t.category} timeline={t} defaultOpen={t.category === opened} />
        ),
      )}
      <TimelineLegend />
    </div>
  );
}

function TimelineLegend(): React.JSX.Element {
  return (
    <ul aria-label="Timeline legend" className="flex flex-wrap items-center gap-s4 pt-s1 text-2xs font-medium text-text-muted">
      {(['design', 'lab', 'elapsed'] as const).map((kind) => (
        <li key={kind} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('h-2.5 w-5 rounded-sm border-[1.5px]', BAR_TONE[kind])} />
          {STEP_KIND_META[kind].label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className={cn('h-2.5 w-5 rounded-sm', WAIT_HATCH)} />
        Wait (no work booked)
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="font-mono text-text-subtle">
          0w
        </span>
        Skipped for this category
      </li>
    </ul>
  );
}

/** Read-only card (no `workflow_templates.write`, or no editing context). */
export function CategoryTimelinePreview({
  timeline,
  defaultOpen = false,
}: {
  timeline: CategoryTimeline;
  defaultOpen?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(defaultOpen);
  const panelId = React.useId();
  return (
    <TimelineCard timeline={timeline} open={open} onToggle={() => setOpen((v) => !v)} panelId={panelId}>
      <MiniGantt timeline={timeline} />
      <TemplateNote note={timeline.note} />
    </TimelineCard>
  );
}

function TimelineCard({
  timeline,
  open,
  onToggle,
  panelId,
  badge,
  children,
}: {
  timeline: CategoryTimeline;
  open: boolean;
  onToggle: () => void;
  panelId: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const label = timeline.label && timeline.label !== timeline.category ? timeline.label : null;
  return (
    <section
      className="rounded-xl border-[1.5px] border-border bg-surface"
      aria-label={`${timeline.category} timeline preview`}
      data-testid={`timeline-${timeline.category}`}
    >
      <h3 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className={cn(
            'flex w-full flex-wrap items-center gap-x-s3 gap-y-1 rounded-xl px-s4 py-s3 text-left transition-colors',
            'hover:bg-primary-subtle/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            open && 'rounded-b-none bg-primary-subtle/30',
          )}
        >
          <ChevronDown
            aria-hidden="true"
            className={cn('size-4 shrink-0 text-text-muted transition-transform motion-reduce:transition-none', !open && '-rotate-90')}
          />
          <span className="font-display text-base font-bold text-text">{timeline.category}</span>
          {label ? <span className="text-sm text-text-muted">{label}</span> : null}
          <span className="text-sm font-medium text-text-muted">Timeline preview</span>
          <span className="text-2xs text-text-subtle" data-numeric="">
            ({formatInteger(timeline.total_weeks)}w total)
          </span>
          {badge}
          <span className="ml-auto flex items-center gap-s2 text-2xs font-semibold" data-numeric="">
            <span className="rounded-pill bg-primary/10 px-2 py-0.5 text-primary-subtle-fg">
              Design {formatInteger(timeline.design_weeks)}w
            </span>
            <span className="rounded-pill bg-success/10 px-2 py-0.5 text-success-subtle-fg">
              Lab {formatInteger(timeline.lab_weeks)}w
            </span>
          </span>
        </button>
      </h3>
      {open ? (
        <div id={panelId} className="space-y-s2 border-t border-border px-s4 py-s3">
          {children}
        </div>
      ) : null}
    </section>
  );
}

function TemplateNote({ note }: { note: string }): React.JSX.Element | null {
  if (!note) return null;
  return (
    <p className="text-2xs text-text-subtle" data-testid="template-note">
      {note}
    </p>
  );
}

// --- the editor ------------------------------------------------------------------

function EditableCategoryTimeline({
  timeline,
  editing,
  defaultOpen,
}: {
  timeline: CategoryTimeline;
  editing: TemplateEditing;
  defaultOpen: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(defaultOpen);
  const panelId = React.useId();
  const { leadTimes } = editing;
  const saved = React.useMemo(
    () => savedCells(leadTimes, timeline.workflow_id, timeline.category),
    [leadTimes, timeline.workflow_id, timeline.category],
  );
  const editor = useTemplateEditor({
    workflowId: timeline.workflow_id,
    category: timeline.category,
    saved,
    savedTimeline: timeline,
    enabled: editing.canWrite,
  });
  const draftCount = Object.keys(editor.drafts).length;
  const shown = editor.shown.timeline;

  const save = () => {
    const version = editing.versions[timeline.category] ?? timeline.template_version;
    const entry = changeEntry(timeline.workflow_id, timeline.category, version, editor.drafts);
    if (!entry) return;
    editing.onSave(entry, summaryLines(timeline.category, editor.drafts, saved), editor.discard);
  };

  const controls: RowControls | undefined = editing.canWrite
    ? {
        drafts: editor.drafts,
        saved,
        basis: editor.shown.basis,
        pending: editor.pending,
        disabled: editing.saving,
        nudge: editor.nudge,
        resetStep: editor.resetStep,
      }
    : undefined;

  return (
    <TimelineCard
      timeline={shown}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      panelId={panelId}
      badge={
        draftCount > 0 ? (
          <Badge tone="warning" data-testid={`unsaved-${timeline.category}`}>
            {draftCount} unsaved {draftCount === 1 ? 'step' : 'steps'}
          </Badge>
        ) : null
      }
    >
      <MiniGantt timeline={shown} controls={controls} />
      {editor.error ? (
        <p role="alert" className="flex items-center gap-1.5 text-2xs text-danger" data-testid="timeline-preview-error">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {previewErrorText(editor.error)}
        </p>
      ) : null}
      <TemplateNote note={shown.note} />
      {editing.canWrite ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-s2">
          <span role="status" aria-live="polite" className="mr-auto flex items-center gap-1.5 text-2xs text-text-muted">
            {editor.pending ? (
              <>
                <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {TEMPLATE_COPY.pending}
              </>
            ) : draftCount > 0 ? (
              'Drafts — not saved yet.'
            ) : null}
          </span>
          <Button type="button" variant="ghost" size="sm" disabled={draftCount === 0 || editing.saving} onClick={editor.discard}>
            <Undo2 />
            Discard
          </Button>
          <Button type="button" size="sm" disabled={draftCount === 0 || editing.saving} onClick={save}>
            <Save />
            Save {timeline.category}…
          </Button>
        </div>
      ) : null}
    </TimelineCard>
  );
}

/**
 * P52-T01: one category timeline whose drafts the caller holds (the "Effort &
 * Timeline Planning" matrix: its grid cells and these ± buttons edit the same
 * drafts). No Save / Discard here — the matrix's "Apply to App" saves every
 * drafted category through the one apply dialog.
 */
export function ControlledCategoryTimeline({
  timeline,
  drafts,
  saved,
  canWrite,
  disabled,
  defaultOpen = false,
  onNudge,
  onResetStep,
}: {
  /** The saved (served C2) timeline of this category. */
  timeline: CategoryTimeline;
  drafts: CategoryDrafts;
  saved: Readonly<Record<string, SavedCell>>;
  /** `workflow_templates.write`: ± controls and the live preview. */
  canWrite: boolean;
  disabled: boolean;
  defaultOpen?: boolean;
  onNudge: (stepId: string, field: DraftField, direction: -1 | 1) => void;
  onResetStep: (stepId: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(defaultOpen);
  const panelId = React.useId();
  const overrides = React.useMemo(() => draftOverrides(drafts), [drafts]);
  const preview = useTimelinePreview({
    workflowId: timeline.workflow_id,
    category: timeline.category,
    overrides,
    savedTimeline: timeline,
    enabled: canWrite,
  });
  const draftCount = Object.keys(drafts).length;
  const shown = preview.shown.timeline;
  const controls: RowControls | undefined = canWrite
    ? { drafts, saved, basis: preview.shown.basis, pending: preview.pending, disabled, nudge: onNudge, resetStep: onResetStep }
    : undefined;

  return (
    <TimelineCard
      timeline={shown}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      panelId={panelId}
      badge={
        draftCount > 0 ? (
          <Badge tone="warning" data-testid={`unsaved-${timeline.category}`}>
            {draftCount} unsaved {draftCount === 1 ? 'step' : 'steps'}
          </Badge>
        ) : null
      }
    >
      <MiniGantt timeline={shown} controls={controls} />
      {preview.error ? (
        <p role="alert" className="flex items-center gap-1.5 text-2xs text-danger" data-testid="timeline-preview-error">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {previewErrorText(preview.error)}
        </p>
      ) : null}
      {canWrite && preview.pending ? (
        <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-2xs text-text-muted">
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {TEMPLATE_COPY.pending}
        </p>
      ) : null}
      <TemplateNote note={shown.note} />
    </TimelineCard>
  );
}

function previewErrorText(err: Error): string {
  if (err instanceof ApiError && err.status === 429) return TEMPLATE_COPY.previewRateLimited;
  if (err instanceof ApiError && (err.status === 422 || err.isForbidden)) return applyErrorMessage(err, 'preview');
  return TEMPLATE_COPY.previewFailed;
}

/** "A · PDD-E length 6w → 7w" / "A · PDD-H gap 0w → −2w" for the apply dialog. */
function summaryLines(category: string, drafts: CategoryDrafts, saved: Readonly<Record<string, SavedCell>>): string[] {
  const lines: string[] = [];
  for (const stepId of Object.keys(drafts).sort()) {
    const d = drafts[stepId] ?? {};
    const s = saved[stepId] ?? { weeks: 0, gap_weeks: 0 };
    if (d.weeks !== undefined) lines.push(`${category} · ${stepId} length ${String(s.weeks)}w → ${String(d.weeks)}w`);
    if (d.gap_weeks !== undefined) {
      lines.push(`${category} · ${stepId} gap ${signedWeeks(s.gap_weeks)}w → ${signedWeeks(d.gap_weeks)}w`);
    }
  }
  return lines;
}

// --- the chart -------------------------------------------------------------------

interface RowControls {
  drafts: CategoryDrafts;
  saved: Readonly<Record<string, SavedCell>>;
  /** The overrides the drawn timeline was computed for. */
  basis: readonly TemplateStepOverride[];
  pending: boolean;
  disabled: boolean;
  nudge: (stepId: string, field: DraftField, direction: -1 | 1) => void;
  resetStep: (stepId: string) => void;
}

function tickEvery(span: number): number {
  if (span <= 20) return 1;
  if (span <= 40) return 2;
  return 4;
}

const GRID_READ = 'grid-cols-[5rem_3.75rem_1fr]';
const GRID_EDIT = 'grid-cols-[5rem_3.75rem_minmax(14rem,1fr)_auto]';

function MiniGantt({ timeline, controls }: { timeline: CategoryTimeline; controls?: RowControls | undefined }): React.JSX.Element {
  const steps = timeline.steps;
  // Axis origin = the first served start week; span = the served total.
  const origin = steps.length === 0 ? 0 : Math.min(...steps.map((s) => s.start_week));
  const span = Math.max(timeline.total_weeks, 1);
  const every = tickEvery(span);
  const ticks = Array.from({ length: Math.floor(span / every) + 1 }, (_, i) => i * every).filter((t) => t <= span);
  const gridBg = `repeating-linear-gradient(to right, hsl(var(--color-border) / 0.6) 0 1px, transparent 1px ${String(100 / span)}%)`;
  const grid = controls ? GRID_EDIT : GRID_READ;

  return (
    <div
      className="overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label={`${timeline.category} timeline chart`}
      aria-busy={controls?.pending ? true : undefined}
    >
      <div className={controls ? 'min-w-[52rem]' : 'min-w-[36rem]'}>
        {/* Week axis (served week numbers, from the first start). */}
        <div className={cn('grid items-end gap-s2 pb-1', grid)} aria-hidden="true">
          <span />
          <span className="text-center text-[0.625rem] font-semibold uppercase tracking-wider text-text-subtle">Gap</span>
          <div className="relative h-4">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute -translate-x-1/2 font-mono text-[0.625rem] text-text-subtle"
                style={{ left: `${String((t / span) * 100)}%` }}
              >
                W{origin + t}
              </span>
            ))}
          </div>
          {controls ? (
            <span className="flex gap-s3 text-[0.625rem] font-semibold uppercase tracking-wider text-text-subtle">
              <span className="w-[4.25rem] text-center">Move</span>
              <span className="w-[6.5rem] text-center">Length</span>
              <span className="w-7" />
            </span>
          ) : null}
        </div>
        <ol aria-label={`${timeline.category} steps`} className="space-y-1">
          {steps.map((s) => (
            <StepRow key={s.code} step={s} steps={steps} origin={origin} span={span} gridBg={gridBg} grid={grid} controls={controls} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function StepRow({
  step,
  steps,
  origin,
  span,
  gridBg,
  grid,
  controls,
}: {
  step: TimelineStep;
  steps: readonly TimelineStep[];
  origin: number;
  span: number;
  gridBg: string;
  grid: string;
  controls?: RowControls | undefined;
}): React.JSX.Element {
  const isFirst = step.predecessor_ids.length === 0;
  const gapValue = controls ? currentValue(controls.drafts, controls.saved, step.code, 'gap_weeks') : step.gap_weeks;
  const weeksValue = controls ? currentValue(controls.drafts, controls.saved, step.code, 'weeks') : step.duration_weeks;
  // Optimistic (contract D): until the reply, the clicked bar moves by the
  // drafted difference from what the drawn timeline was computed for.
  const moveDelta = controls
    ? gapValue - overrideValue(controls.basis, controls.saved, step.code, 'gap_weeks')
    : 0;
  const lengthDelta = controls
    ? weeksValue - overrideValue(controls.basis, controls.saved, step.code, 'weeks')
    : 0;
  const optimistic = moveDelta !== 0 || lengthDelta !== 0;
  const drafted = controls ? step.code in controls.drafts : false;

  const duration = Math.max(0, step.duration_weeks + lengthDelta);
  const start = step.start_week + moveDelta;
  const skipped = duration === 0;
  const left = ((start - origin) / span) * 100;
  const width = (duration / span) * 100;
  const waitWeeks = skipped || optimistic ? 0 : Math.max(0, step.effective_gap_weeks);
  const waitLeft = ((start - waitWeeks - origin) / span) * 100;

  const kind = STEP_KIND_META[step.resource_kind].label;
  const badge = gapBadge(gapValue, isFirst);
  const description = skipped
    ? `${step.code} ${step.name}: skipped (0 weeks)`
    : `${step.code} ${step.name}: ${kind.toLowerCase()}, starts W${String(step.start_week)}, ${formatInteger(step.duration_weeks)} ${step.duration_weeks === 1 ? 'week' : 'weeks'}`;
  const notes = step.flags.map((f) => ({ flag: f, text: templateFlagNote(f, step, steps) }));

  return (
    <li data-testid={`step-${step.code}`} data-drafted={drafted || undefined} data-pending={optimistic || undefined}>
      <div className={cn('grid items-center gap-s2', grid)}>
        <span className={cn('truncate font-mono text-2xs font-semibold text-text', drafted && 'text-primary')} title={step.name}>
          {step.code}
        </span>
        <span className="sr-only">
          {description}; gap: {badge.label}
          {drafted ? ' (unsaved change)' : ''}
        </span>
        <GapBadge text={badge.text} tone={badge.tone} />
        <div className="relative h-6 overflow-hidden rounded-sm" style={{ backgroundImage: gridBg }} aria-hidden="true">
          {waitWeeks > 0 ? (
            <span
              className={cn('absolute inset-y-1 rounded-sm', WAIT_HATCH)}
              style={{ left: `${String(waitLeft)}%`, width: `${String((waitWeeks / span) * 100)}%` }}
              title={`Wait ${String(waitWeeks)} ${waitWeeks === 1 ? 'week' : 'weeks'} (no work booked)`}
              data-testid={`wait-${step.code}`}
            />
          ) : null}
          {skipped ? (
            <span
              className="absolute top-1/2 -translate-y-1/2 font-mono text-[0.625rem] font-semibold text-text-subtle"
              style={{ left: `${String(left)}%` }}
              title={description}
            >
              0w
            </span>
          ) : (
            <span
              className={cn(
                'absolute inset-y-0.5 flex items-center overflow-hidden rounded-md border-[1.5px] px-1.5 text-[0.6875rem] font-semibold',
                'motion-safe:transition-[left,width] motion-safe:duration-150',
                BAR_TONE[step.resource_kind],
                optimistic && 'opacity-60 outline-dashed outline-1 outline-primary',
              )}
              style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
              title={description}
            >
              <span className="truncate">{step.name}</span>
            </span>
          )}
        </div>
        {controls ? <RowButtons step={step} isFirst={isFirst} weeks={weeksValue} drafted={drafted} controls={controls} /> : null}
      </div>
      {notes.length > 0 ? (
        <ul className={cn('grid gap-s2', grid)} aria-label={`${step.code} notes`}>
          {notes.map((n) => (
            <li
              key={n.flag}
              className={cn(
                'col-start-3 flex items-center gap-1 text-2xs',
                n.flag === 'same_leader_serialised' ? 'font-medium text-danger' : 'text-text-muted',
              )}
              data-testid={`flag-${step.code}-${n.flag}`}
            >
              {n.flag === 'same_leader_serialised' ? <TriangleAlert className="size-3 shrink-0" aria-hidden="true" /> : null}
              {n.text}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function GapBadge({ text, tone }: { text: string; tone: ReturnType<typeof gapBadge>['tone'] }): React.JSX.Element {
  return (
    <span className="flex flex-col items-center leading-none" aria-hidden="true" data-testid="gap-badge" data-tone={tone}>
      <span
        className={cn(
          'inline-flex min-w-9 items-center justify-center rounded-sm px-1 py-0.5 font-mono text-[0.6875rem] font-semibold',
          tone === 'first' && 'text-text-subtle',
          tone === 'none' && 'bg-surface-sunken text-text-muted',
          tone === 'overlap' && 'bg-danger-subtle text-danger-subtle-fg',
          tone === 'wait' && cn('text-text', WAIT_HATCH),
        )}
      >
        {text}
      </span>
      {tone === 'overlap' ? <span className="mt-0.5 text-[0.5625rem] font-bold uppercase text-danger">Overlap</span> : null}
    </span>
  );
}

function RowButtons({
  step,
  isFirst,
  weeks,
  drafted,
  controls,
}: {
  step: TimelineStep;
  isFirst: boolean;
  weeks: number;
  drafted: boolean;
  controls: RowControls;
}): React.JSX.Element {
  const { drafts, saved, disabled, nudge, resetStep } = controls;
  const id = step.code;
  const can = (field: DraftField, dir: -1 | 1) => !disabled && canNudge(drafts, saved, id, field, dir);
  return (
    <span className="flex items-center gap-s3">
      <span className="flex w-[4.25rem] items-center justify-center gap-1" role="group" aria-label={`Move ${id}`}>
        {isFirst ? (
          <span className="text-2xs text-text-subtle" title="The first step has no gap">
            —
          </span>
        ) : (
          <>
            <StepButton label={`Move ${id} one week earlier`} disabled={!can('gap_weeks', -1)} onClick={() => nudge(id, 'gap_weeks', -1)}>
              <Minus />
            </StepButton>
            <StepButton label={`Move ${id} one week later`} disabled={!can('gap_weeks', 1)} onClick={() => nudge(id, 'gap_weeks', 1)}>
              <Plus />
            </StepButton>
          </>
        )}
      </span>
      <span className="flex w-[6.5rem] items-center justify-center gap-1" role="group" aria-label={`Length of ${id}`}>
        <StepButton label={`Shorten ${id} by one week`} disabled={!can('weeks', -1)} onClick={() => nudge(id, 'weeks', -1)}>
          <Minus />
        </StepButton>
        <span className={cn('w-8 text-center font-mono text-2xs font-semibold', step.code in drafts && drafts[step.code]?.weeks !== undefined ? 'text-primary' : 'text-text')} data-numeric="" data-testid={`length-${id}`}>
          {weeks}w
        </span>
        <StepButton label={`Lengthen ${id} by one week`} disabled={!can('weeks', 1)} onClick={() => nudge(id, 'weeks', 1)}>
          <Plus />
        </StepButton>
      </span>
      <span className="flex w-7 justify-center">
        {drafted ? (
          <StepButton label={`Reset ${id} to the saved template`} disabled={disabled} onClick={() => resetStep(id)}>
            <Undo2 />
          </StepButton>
        ) : null}
      </span>
    </span>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md border border-border-strong bg-surface text-text transition-colors',
        'hover:border-primary/50 hover:bg-primary-subtle/40 hover:text-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-strong disabled:hover:bg-surface disabled:hover:text-text',
        '[&_svg]:size-3.5',
      )}
    >
      {children}
    </button>
  );
}
