import * as React from 'react';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { CardInfo } from '@/components/ui/card-info';
import { CARRY_OVER_YEAR, PLAN_YEAR } from '@/lib/domain-constants';
import { formatDecimal, formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { PipelineTotals, RegionSummary } from '../api/types';
import { pipelineRegionItems, type PipelineBucket } from '../lib/region-summary';
import { RegionChips } from './region-chips';

/**
 * Project Pipeline row (ADR 0030, client's older app):
 *   Spillover {PLAN_YEAR-1} + Newly registered {PLAN_YEAR} = Total projects.
 *
 * Owner ask 2026-10-22: the "Unregistered date" card is removed. The served
 * `unregistered_count` is still part of the total (ADR 0030), so when it is
 * non-zero the Total caption names it, and the sum on screen stays honest.
 *
 * Portfolio COMPOSITION off the live project registry (carry_over / reg_year),
 * NOT the schedule-run "Spillover (past W52)" outcome, which lives in the
 * separate "Completion outcome" panel. Every figure here is one served field of
 * `GET /dashboard/pipeline-totals` / `region-summary` (I9, I19): the browser
 * neither adds the buckets nor divides for a share.
 */

export interface PipelineRowProps {
  totals: PipelineTotals;
  /** Per-country chips; absent while loading or on error (the cards still render). */
  regionSummary?: RegionSummary | null | undefined;
}

interface CardSpec {
  bucket: PipelineBucket;
  label: string;
  count: number;
  caption: string;
  /** Top-border colour (design token). */
  rail: string;
  muted: boolean;
  big?: boolean;
}

function Glyph({ children }: { children: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="pipeline-glyph"
      className="grid select-none place-items-center font-display text-xl font-bold leading-none text-text-muted lg:text-3xl"
    >
      {children}
    </span>
  );
}

export function PipelineRow({ totals, regionSummary = null }: PipelineRowProps): React.JSX.Element {
  const share = (pct: number): string => `${formatDecimal(pct)}% of total`;
  const cards: CardSpec[] = [
    {
      bucket: 'spillover',
      label: `Spillover ${String(CARRY_OVER_YEAR)}`,
      count: totals.spillover_count,
      caption: share(totals.spillover_share_pct),
      rail: 'border-t-warning',
      muted: false,
    },
    {
      bucket: 'new',
      label: `Newly registered ${String(PLAN_YEAR)}`,
      count: totals.new_count,
      caption: share(totals.new_share_pct),
      rail: 'border-t-primary',
      muted: false,
    },
    {
      bucket: 'total',
      label: 'Total projects',
      count: totals.total_count,
      caption:
        totals.unregistered_count > 0
          ? `All statuses · incl. ${formatInteger(totals.unregistered_count)} with no registration year`
          : `All statuses · full ${String(PLAN_YEAR)} pipeline`,
      rail: 'border-t-ink',
      muted: false,
      big: true,
    },
  ];
  const glyphs = ['+', '='];

  return (
    <Card className="border-0 bg-transparent shadow-none" data-testid="pipeline-row">
      <CardHeader className="items-end border-0 px-0 pb-s3 pt-0">
        <div>
          <CardTitle className="text-h2 font-extrabold">Project pipeline</CardTitle>
          <p className="mt-0.5 text-sm font-medium text-text-muted">
            Spillover + newly registered = total projects
          </p>
        </div>
        <CardInfo label="Project pipeline source">
          <p>
            Portfolio composition off the live project registry, every project included
            (Commercialized too). Shares are computed by the server.
          </p>
          <p>
            &quot;Spillover {CARRY_OVER_YEAR}&quot; here means a project carried over from the
            prior planning year. It is NOT the schedule outcome{' '}
            <strong className="text-text">Spillover (past W52)</strong> shown in the completion
            panel, which is a property of the active schedule run.
          </p>
        </CardInfo>
      </CardHeader>
      <div className="grid gap-s1 lg:grid-cols-[1fr_auto_1fr_auto_1fr] lg:gap-s2">
        {cards.map((card, i) => (
          <React.Fragment key={card.bucket}>
            <section
              aria-label={card.label}
              data-testid={`pipeline-card-${card.bucket}`}
              className={cn(
                'flex min-w-0 flex-col gap-s1 rounded-dash border-[1.5px] border-t-4 border-dash-hairline bg-surface px-card py-s3 shadow-dashCard',
                card.rail,
              )}
            >
              <h4 className="label-caps text-text-subtle">{card.label}</h4>
              <span
                className={cn(
                  'block font-display font-extrabold tabular-nums',
                  card.big ? 'text-4xl text-ink' : 'text-3xl',
                  card.muted ? 'text-text-muted' : card.big ? '' : 'text-text',
                )}
                data-numeric=""
                data-testid={`pipeline-count-${card.bucket}`}
              >
                {formatInteger(card.count)}
              </span>
              <span className="text-xs font-medium text-text-muted" data-testid={`pipeline-caption-${card.bucket}`}>
                {card.caption}
              </span>
              {regionSummary && !(card.muted && card.count === 0) ? (
                <RegionChips
                  label={card.label}
                  items={pipelineRegionItems(regionSummary, card.bucket)}
                  className="mt-auto pt-s1"
                />
              ) : null}
            </section>
            {i < glyphs.length ? <Glyph>{glyphs[i] ?? ''}</Glyph> : null}
          </React.Fragment>
        ))}
      </div>
    </Card>
  );
}
