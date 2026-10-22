import * as React from 'react';
import { Split } from 'lucide-react';
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';
import { formatInteger } from '@/lib/format';
import { useMotionTokens } from '@/lib/motion';

import type { CompletingByTypeRow } from '../api/types';
import { formatServedPct, typeCode, typeLabel } from '../lib/analytics';

/**
 * "Pipeline vs completing" (P13-T10; moved out of `analytics-breakdown.tsx` in
 * P17-R08 so it sits in the Hub × Type row next to the two tables). Per project
 * type: the served pipeline count and the served completing count + share
 * (`/dashboard/analytics.completing_by_type`). Lazy-loaded by the page: it is a
 * Recharts consumer. Bars are the library's drawing of served counts; the
 * sr-only list states them verbatim (I9).
 */

interface PvcDatum {
  key: string;
  code: string;
  name: string;
  pipeline: number;
  completing: number;
  pct: number;
  /** Bar label text, read by `LabelList` from each bar's own datum. (P17-R08:
   *  the old `label` callback indexed into this array with Recharts' `index`,
   *  which counts drawn rects only, so every label after a zero bar shifted.)
   *  Counts only: at a third of the row "11 (30.56%)" ran into the next bar, so
   *  the served share is drawn under the type code instead (`TypeTick`). */
  pipelineLabel: string;
  completingLabel: string;
}

const LABEL_STYLE = { fontSize: 9, fontWeight: 700, fill: 'hsl(var(--color-text-muted))' } as const;

/** X-axis tick: the type code, and under it the served completing share. */
function TypeTick({
  x,
  y,
  payload,
  data,
}: {
  x?: number;
  y?: number;
  payload?: { value: string; index: number };
  data: PvcDatum[];
}): React.JSX.Element | null {
  if (x === undefined || y === undefined || payload === undefined) return null;
  const d = data[payload.index];
  return (
    <g transform={`translate(${x},${y})`}>
      <text dy={10} textAnchor="middle" fontSize={11} fontWeight={600} fill="hsl(var(--color-text-subtle))">
        {payload.value}
      </text>
      {d !== undefined && d.pipeline > 0 ? (
        <text dy={23} textAnchor="middle" fontSize={9} fontWeight={700} fill="hsl(var(--color-success))">
          {formatServedPct(d.pct)}
        </text>
      ) : null}
    </g>
  );
}

function PvcTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: PvcDatum }>;
}): React.JSX.Element | null {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  return (
    <div className="rounded-xl border-[1.5px] border-border bg-surface px-s3 py-s2 text-xs shadow-pop">
      <p className="font-bold text-text">{d.name}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-text-muted" data-numeric="">
        <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
        Pipeline {formatInteger(d.pipeline)}
      </p>
      <p className="flex items-center gap-1.5 text-text-muted" data-numeric="">
        <span className="size-2 rounded-full bg-success" aria-hidden="true" />
        Completing {formatInteger(d.completing)} ({formatServedPct(d.pct)})
      </p>
    </div>
  );
}

export function PipelineVsCompletingChart({ rows }: { rows: CompletingByTypeRow[] }): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const data = React.useMemo<PvcDatum[]>(
    () =>
      rows.map((r) => ({
        key: r.key,
        code: typeCode(r.key),
        name: typeLabel(r.key),
        pipeline: r.pipeline_count,
        completing: r.completing_count,
        pct: r.completing_pct,
        pipelineLabel: formatInteger(r.pipeline_count),
        completingLabel: formatInteger(r.completing_count),
      })),
    [rows],
  );
  return (
    <BoltCard className="flex h-full flex-col gap-s4 p-card">
      <div className="flex items-start justify-between gap-s3">
        <div className="flex items-center gap-s3">
          <span className="hidden size-10 shrink-0 place-items-center rounded-xl sm:grid bg-primary-subtle text-primary-subtle-fg">
            <Split className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-display text-lg font-bold leading-tight tracking-tight text-text">Pipeline vs completing</h3>
            <p className="text-xs font-medium text-text-subtle">Per project type, in the active run</p>
          </div>
        </div>
        <CardInfo label="About pipeline vs completing">
          <p>
            For each project type: the pipeline count and how many of those projects the active
            schedule run completes within the year, with the served completing share under the type.
          </p>
        </CardInfo>
      </div>
      <div className="flex flex-wrap items-center gap-s3 text-2xs font-semibold text-text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-primary" aria-hidden="true" />
          Pipeline
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-success" aria-hidden="true" />
          Completing (share under each type)
        </span>
      </div>
      {data.length === 0 ? (
        <p className="py-s6 text-center text-sm text-text-muted">No pipeline projects in view.</p>
      ) : (
        <>
          <figure aria-hidden="true" className="h-64 w-full flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <RechartsBarChart accessibilityLayer={false} data={data} barGap={3} margin={{ top: 24, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="hsl(var(--color-border))" />
                <XAxis
                  dataKey="code"
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  height={34}
                  tick={<TypeTick data={data} />}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: 'hsl(var(--color-text-subtle))' }}
                />
                <Tooltip content={<PvcTooltip />} cursor={{ fill: 'hsl(var(--color-surface-sunken))' }} />
                <Bar
                  dataKey="pipeline"
                  fill="hsl(var(--color-primary))"
                  radius={[6, 6, 0, 0]}
                  maxBarSize={30}
                  isAnimationActive={!reduced}
                >
                  <LabelList dataKey="pipelineLabel" position="top" offset={6} {...LABEL_STYLE} />
                </Bar>
                <Bar
                  dataKey="completing"
                  fill="hsl(var(--color-success))"
                  radius={[6, 6, 0, 0]}
                  maxBarSize={30}
                  isAnimationActive={!reduced}
                >
                  <LabelList dataKey="completingLabel" position="top" offset={6} {...LABEL_STYLE} />
                </Bar>
              </RechartsBarChart>
            </ResponsiveContainer>
          </figure>
          <ul aria-label="Pipeline vs completing by project type" className="sr-only">
            {data.map((d) => (
              <li key={d.key}>
                {d.name}: pipeline {formatInteger(d.pipeline)}, completing {formatInteger(d.completing)} (
                {formatServedPct(d.pct)})
              </li>
            ))}
          </ul>
        </>
      )}
    </BoltCard>
  );
}

