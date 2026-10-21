import * as React from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDecimal, formatInteger } from '@/lib/format';

import type { HubP1Fill, PriorityCapacityFill } from '../api/types';

/**
 * P25 (ADR 0036): the per-hub P1 capacity fill, from `GET /priorities/capacity-fill`
 * (hub-scoped by the server). Each hub shows its served remaining-year design
 * capacity, the base P1 load (projects scoring 70+), the load after the fill and
 * how many projects were promoted. Every number is a served field; bar lengths
 * are only a visual scale of those figures (I9).
 */
export const CAPACITY_FILL_EXPLAINER =
  'Projects scoring 70+ are P1. If a hub still has design capacity this year, the next-highest scores are promoted until it is full.';

export function CapacityFillPanel({
  data,
  isPending,
  isError,
}: {
  data: PriorityCapacityFill | undefined;
  isPending: boolean;
  isError: boolean;
}): React.JSX.Element {
  return (
    <Card data-testid="capacity-fill-panel">
      <CardHeader className="flex-wrap">
        <CardTitle>P1 capacity fill</CardTitle>
        <span className="text-2xs text-text-muted">
          Design weeks this year, per hub
          {data?.schedule_run_version != null ? ` · run v${String(data.schedule_run_version)}` : ''}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-2xs text-text-muted" data-testid="capacity-fill-explainer">
          {CAPACITY_FILL_EXPLAINER}
        </p>
        {data === undefined ? (
          isPending ? (
            <Skeleton className="h-24 w-full" aria-label="Loading capacity fill" />
          ) : (
            <p className="text-2xs text-text-muted">{isError ? 'The capacity fill could not be loaded.' : 'No data.'}</p>
          )
        ) : !data.has_active_schedule_run ? (
          <p className="text-xs text-text" role="note" data-testid="capacity-fill-off">
            No active schedule run — capacity fill is off
          </p>
        ) : data.hubs.length === 0 ? (
          <p className="text-2xs text-text-muted">No hub in this selection.</p>
        ) : (
          <>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="P1 capacity fill per hub">
              {data.hubs.map((h) => (
                <HubFillRow key={h.hub} fill={h} />
              ))}
            </ul>
            <Legend />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${String(Math.min(100, (part / whole) * 100))}%`;
}

function HubFillRow({ fill }: { fill: HubP1Fill }): React.JSX.Element {
  // Visual scale only: the largest served figure spans the track.
  const scale = Math.max(fill.capacity_weeks, fill.filled_load_weeks, fill.base_load_weeks);
  const over = fill.base_load_weeks > fill.capacity_weeks;
  return (
    <li className="flex flex-col gap-1.5 rounded border border-border bg-surface px-3 py-2" data-testid={`capacity-fill-${fill.hub}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-text">{fill.hub}</span>
        <span className="tnum text-2xs text-text" data-numeric="" data-testid="capacity-fill-promoted">
          {formatInteger(fill.promoted_count)} promoted
        </span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-pill bg-surface-sunken" aria-hidden="true">
        {/* Filled load (base + promoted), hatched; the base P1 load solid on top. */}
        <span
          className="absolute inset-y-0 left-0 bg-band-p1/45 bg-[repeating-linear-gradient(135deg,hsl(var(--color-band-p1))_0_2px,transparent_2px_5px)]"
          style={{ width: pct(fill.filled_load_weeks, scale) }}
        />
        <span className="absolute inset-y-0 left-0 bg-band-p1" style={{ width: pct(fill.base_load_weeks, scale) }} />
        {/* Capacity marker. */}
        <span
          className="absolute inset-y-0 w-0.5 bg-text"
          style={{ left: `calc(${pct(fill.capacity_weeks, scale)} - 1px)` }}
        />
      </div>
      <p className="tnum text-2xs text-text-muted" data-numeric="" data-testid="capacity-fill-figures">
        P1 load {formatDecimal(fill.base_load_weeks)} → {formatDecimal(fill.filled_load_weeks)} of{' '}
        {formatDecimal(fill.capacity_weeks)} wks
        {over ? <span className="ml-1 font-semibold text-danger">· over capacity</span> : null}
      </p>
    </li>
  );
}

function Legend(): React.JSX.Element {
  return (
    <p className="flex flex-wrap items-center gap-3 text-2xs text-text-muted" aria-hidden="true">
      <span className="inline-flex items-center gap-1">
        <span className="size-2.5 rounded-sm bg-band-p1" /> Base P1 load (score 70+)
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="size-2.5 rounded-sm bg-band-p1/45 bg-[repeating-linear-gradient(135deg,hsl(var(--color-band-p1))_0_2px,transparent_2px_5px)]" />{' '}
        After capacity fill
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="h-2.5 w-0.5 bg-text" /> Capacity
      </span>
    </p>
  );
}
