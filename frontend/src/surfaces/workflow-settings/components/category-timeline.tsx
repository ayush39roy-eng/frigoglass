import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { STEP_KIND_META } from '@/components/shared/step-kind-meta';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { WorkflowStepKind } from '@/types/enums';

import type { CategoryTimeline, TimelineStep } from '../api/types';

/**
 * Per-category timeline previews (P13-T16, mock-up images 14–16).
 *
 * A collapsible, hand-built mini-Gantt per category. Every start week,
 * duration and total is a served field of `GET /workflow-settings/
 * category-timelines` (earliest start over the DAG, no capacity, computed
 * server-side). The browser only positions bars: left = start − first start,
 * width = duration, both over the served `total_weeks`.
 */

const BAR_TONE: Record<WorkflowStepKind, string> = {
  design: 'border-primary bg-primary/15 text-primary-subtle-fg',
  lab: 'border-success bg-success/15 text-success-subtle-fg',
  elapsed: 'border-dashed border-border-strong bg-surface-sunken text-text-muted',
};

export interface CategoryTimelineListProps {
  timelines: CategoryTimeline[];
}

export function CategoryTimelineList({ timelines }: CategoryTimelineListProps): React.JSX.Element {
  if (timelines.length === 0) {
    return <p className="py-s6 text-center text-sm text-text-muted">No categories configured for this workflow.</p>;
  }
  return (
    <div className="space-y-s3">
      {timelines.map((t, i) => (
        <CategoryTimelinePreview key={t.category} timeline={t} defaultOpen={i === 0} />
      ))}
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
        <span aria-hidden="true" className="font-mono text-text-subtle">
          0w
        </span>
        Skipped for this category
      </li>
    </ul>
  );
}

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
          onClick={() => setOpen((v) => !v)}
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
          <span className="text-sm font-medium text-text-muted">Timeline preview</span>
          <span className="text-2xs text-text-subtle" data-numeric="">
            ({formatInteger(timeline.total_weeks)}w total)
          </span>
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
        <div id={panelId} className="border-t border-border px-s4 py-s3">
          <MiniGantt timeline={timeline} />
        </div>
      ) : null}
    </section>
  );
}

function tickEvery(span: number): number {
  if (span <= 20) return 1;
  if (span <= 40) return 2;
  return 4;
}

function MiniGantt({ timeline }: { timeline: CategoryTimeline }): React.JSX.Element {
  const steps = timeline.steps;
  // Axis origin = the first served start week; span = the served total.
  const origin = steps.length === 0 ? 0 : Math.min(...steps.map((s) => s.start_week));
  const span = Math.max(timeline.total_weeks, 1);
  const every = tickEvery(span);
  const ticks = Array.from({ length: Math.floor(span / every) + 1 }, (_, i) => i * every).filter((t) => t <= span);
  const gridBg = `repeating-linear-gradient(to right, hsl(var(--color-border) / 0.6) 0 1px, transparent 1px ${String(100 / span)}%)`;

  return (
    <div
      className="overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label={`${timeline.category} timeline chart`}
    >
      <div className="min-w-[36rem]">
        {/* Week axis (served week numbers, from the first start). */}
        <div className="grid grid-cols-[6rem_1fr] items-end gap-s2 pb-1" aria-hidden="true">
          <span />
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
        </div>
        <ol aria-label={`${timeline.category} steps`} className="space-y-1">
          {steps.map((s) => (
            <StepRow key={s.code} step={s} origin={origin} span={span} gridBg={gridBg} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function StepRow({
  step,
  origin,
  span,
  gridBg,
}: {
  step: TimelineStep;
  origin: number;
  span: number;
  gridBg: string;
}): React.JSX.Element {
  const skipped = step.duration_weeks === 0;
  const left = ((step.start_week - origin) / span) * 100;
  const width = (step.duration_weeks / span) * 100;
  const kind = STEP_KIND_META[step.resource_kind].label;
  const description = skipped
    ? `${step.code} ${step.name}: skipped (0 weeks)`
    : `${step.code} ${step.name}: ${kind.toLowerCase()}, starts W${String(step.start_week)}, ${formatInteger(step.duration_weeks)} ${step.duration_weeks === 1 ? 'week' : 'weeks'}`;

  return (
    <li className="grid grid-cols-[6rem_1fr] items-center gap-s2" data-testid={`step-${step.code}`}>
      <span className="truncate font-mono text-2xs font-semibold text-text" title={step.name}>
        {step.code}
      </span>
      <span className="sr-only">{description}</span>
      <div className="relative h-6 rounded-sm" style={{ backgroundImage: gridBg }} aria-hidden="true">
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
              BAR_TONE[step.resource_kind],
            )}
            style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
            title={description}
          >
            <span className="truncate">{step.name}</span>
          </span>
        )}
      </div>
    </li>
  );
}
