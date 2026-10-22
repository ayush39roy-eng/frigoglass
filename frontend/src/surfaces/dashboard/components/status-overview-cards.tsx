import * as React from 'react';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { CardInfo } from '@/components/ui/card-info';
import { formatDecimal, formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ProjectStatus } from '@/types/enums';

import type { RegionSummary, StatusOverview } from '../api/types';
import { statusRegionItems } from '../lib/region-summary';
import { RegionChips } from './region-chips';

/**
 * Status overview, five cards (ADR 0030, P17-T04; client's older app):
 * In Development / Under Industrialization / Commercialized / In Queue / On Hold (owner ask
 * 2026-10-22: In Queue sits just before On Hold),
 * plus an "Other statuses: n" remainder (every other status, today Cancelled)
 * so the five cards and the remainder reconcile with the total. P23-T01: the
 * copy names no status that is not served; the breakdown lists only the
 * served `other_statuses_counts` entries above zero.
 *
 * Portfolio COMPOSITION off the live project table, not a schedule outcome (I9
 * does not apply). Every count, percentage and bar width is one served field of
 * `GET /dashboard/status-overview` / `region-summary` (I19): nothing is summed
 * or divided in the browser.
 */

interface CardSpec {
  status: ProjectStatus;
  testId: string;
  label: string;
  count: number;
  sharePct: number;
  /** Top border + bar colour (design token). */
  rail: string;
  bar: string;
  number: string;
}

export interface StatusOverviewCardsProps {
  data: StatusOverview;
  /** Per-country chips under each card; absent while loading or on error. */
  regionSummary?: RegionSummary | null | undefined;
}

export function StatusOverviewCards({ data, regionSummary = null }: StatusOverviewCardsProps): React.JSX.Element {
  const cards: CardSpec[] = [
    {
      status: 'In Development',
      testId: 'in-development',
      label: 'In Development',
      count: data.in_development,
      sharePct: data.in_development_share_pct,
      rail: 'border-t-success',
      bar: 'bg-success',
      number: 'text-success-subtle-fg',
    },
    {
      status: 'Under Industrialization',
      testId: 'under-industrialization',
      label: 'Under Industrialization',
      count: data.under_industrialization,
      sharePct: data.under_industrialization_share_pct,
      rail: 'border-t-primary',
      bar: 'bg-primary',
      number: 'text-primary',
    },
    {
      status: 'Commercialized',
      testId: 'commercialized',
      label: 'Commercialized',
      count: data.commercialized_count,
      sharePct: data.commercialized_share_pct,
      rail: 'border-t-success',
      bar: 'bg-success',
      number: 'text-success-subtle-fg',
    },
    {
      status: 'In Queue',
      testId: 'in-queue',
      label: 'In Queue',
      count: data.in_queue,
      sharePct: data.in_queue_share_pct,
      rail: 'border-t-border-strong',
      bar: 'bg-border-strong',
      number: 'text-text-muted',
    },
    {
      status: 'On Hold',
      testId: 'on-hold',
      label: 'On Hold (project)',
      count: data.on_hold_count,
      sharePct: data.on_hold_share_pct,
      rail: 'border-t-danger',
      bar: 'bg-danger',
      number: 'text-danger-subtle-fg',
    },
  ];
  const otherEntries = Object.entries(data.other_statuses_counts).filter(([, n]) => n > 0);

  return (
    <Card className="border-0 bg-transparent shadow-none" data-testid="status-overview">
      <CardHeader className="items-end border-0 px-0 pt-0">
        <div>
          <CardTitle className="text-h1 font-extrabold">Status overview</CardTitle>
          <p className="mt-1 text-sm font-medium text-text-muted">
            Where every project sits in its workflow today
          </p>
        </div>
        <CardInfo label="Status overview source">
          <p>
            Portfolio composition off the live project registry, every project included. A
            project&apos;s workflow status, not a schedule outcome, so Invariant I9 does not apply.
            Percentages and bar widths are computed by the server.
          </p>
          <p>
            The five cards plus &quot;Other statuses&quot;
            {otherEntries.length > 0 ? ` (${otherEntries.map(([status]) => status).join(', ')})` : ''} add
            up to the total.
          </p>
          <p>
            <strong className="text-text">On Hold (project)</strong> is the project status: the
            whole project is paused and out of the plan. It is not the &ldquo;On Hold at a
            stage&rdquo; card under Completing within the year, where a project stays in the plan
            and waits at a stage.
          </p>
        </CardInfo>
      </CardHeader>
      <div className="grid gap-s3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {cards.map((card) => (
          <section
            key={card.status}
            aria-label={card.label}
            data-testid={`status-card-${card.testId}`}
            className={cn(
              'flex min-w-0 flex-col gap-s2 overflow-hidden rounded-dash border-[1.5px] border-t-4 border-dash-hairline bg-surface p-card shadow-dashCard',
              card.rail,
            )}
          >
            <h4 className="label-caps text-text-subtle">{card.label}</h4>
            <span
              className={cn('block font-display text-4xl font-extrabold tabular-nums', card.number)}
              data-numeric=""
              data-testid={`status-count-${card.testId}`}
            >
              {formatInteger(card.count)}
            </span>
            <span className="text-xs font-medium text-text-muted" data-testid={`status-caption-${card.testId}`}>
              {formatDecimal(card.sharePct)}% of total
            </span>
            {regionSummary ? (
              <RegionChips label={card.label} items={statusRegionItems(regionSummary, card.status)} className="pt-s1" />
            ) : null}
            <div
              role="progressbar"
              aria-label={`${card.label} share of total`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={card.sharePct}
              aria-valuetext={`${formatDecimal(card.sharePct)}% of total`}
              className="mt-auto h-1.5 w-full overflow-hidden rounded-pill bg-dash-alt"
            >
              <div
                className={cn('h-full rounded-pill', card.bar)}
                style={{ width: `${String(card.sharePct)}%` }}
                data-testid={`status-bar-${card.testId}`}
              />
            </div>
          </section>
        ))}
      </div>
      <div
        className="mt-s2 flex items-center gap-1 text-xs font-medium text-text-muted"
        data-testid="status-other"
        data-numeric=""
      >
        <span>
          Other statuses: {formatInteger(data.other_statuses_count)}
          {data.other_statuses_count > 0 ? ` (${formatDecimal(data.other_statuses_share_pct)}% of total)` : ''}
        </span>
        <CardInfo label="Other statuses breakdown">
          <p>Statuses with no card of their own:</p>
          {otherEntries.length > 0 ? (
            <ul className="mt-1 list-disc pl-4">
              {otherEntries.map(([status, n]) => (
                <li key={status}>
                  {status}: {formatInteger(n)}
                </li>
              ))}
            </ul>
          ) : (
            <p>None right now.</p>
          )}
        </CardInfo>
      </div>
    </Card>
  );
}
