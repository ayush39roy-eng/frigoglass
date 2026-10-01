import * as React from 'react';
import { CheckCircle2, FlaskConical, Hammer, ListChecks } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatInteger } from '@/lib/format';

import type { StatusOverview } from '../api/types';
import { CardInfo } from '@/components/ui/card-info';
import { StatCard } from './stat-card';

/**
 * Status overview cards (PROJECT_AND_STACK.md §2): In Buyoff / Under
 * Industrialization / In Development / In Queue. Portfolio *composition* off the
 * live Project table — not a schedule outcome, so Invariant I9 does not apply
 * (see the backend `dashboard.py` module docstring).
 */

export interface StatusOverviewCardsProps {
  data: StatusOverview;
}

export function StatusOverviewCards({ data }: StatusOverviewCardsProps): React.JSX.Element {
  const otherTotal = Object.values(data.other_counts).reduce((sum, n) => sum + n, 0);
  const otherEntries = Object.entries(data.other_counts).filter(([, count]) => count > 0);

  return (
    /* Section, not a card — the four StatCards are the cards. See the note in
     * within-year-panel.tsx: nesting a card inside a card puts white on white and
     * costs the tiles the lift that makes them read as objects. */
    <Card className="border-0 bg-transparent shadow-none">
      <CardHeader className="items-end border-0 px-0 pt-0">
        <div>
          <CardTitle className="text-h1 font-extrabold">Status overview</CardTitle>
          <p className="mt-1 text-sm font-medium text-text-muted">
            Where every registered project sits in its workflow today
          </p>
        </div>
        <CardInfo label="Status overview source">
          <p>
            Portfolio composition off the live project registry — a project&apos;s workflow status,
            not a schedule outcome, so Invariant I9 does not apply to these four figures.
          </p>
          <p>
            Four statuses get their own card. Every remaining status (Draft, Commercialized, On
            Hold) is listed as a chip beside them rather than a fifth, sixth and seventh card.
          </p>
        </CardInfo>
      </CardHeader>
      <CardContent className="space-y-s3 px-0 pb-0">
        <div className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="In Buyoff" value={data.in_buyoff} variant="ink" icon={CheckCircle2} caption="Final sign-off stage" />
          <StatCard
            label="Under Industrialization"
            value={data.under_industrialization}
            tone="success"
            icon={Hammer}
            caption="Moving into production"
          />
          <StatCard
            label="In Development"
            value={data.in_development}
            tone="primary"
            icon={FlaskConical}
            caption="Active engineering work"
          />
          <StatCard
            label="In Queue"
            value={data.in_queue}
            tone="warning"
            icon={ListChecks}
            caption="Waiting for capacity"
          />
        </div>
        {/* Client text cleanup, 2026-10-01: this was a loose caption reading
            "Not shown as cards (Draft / Commercialized / On Hold): Draft: 3 · …".
            The sentence moved into the header's info popover; the FIGURES stay on
            screen as chips inside their own bordered box, so every remaining status
            count is still visible and still "part of something". */}
        {otherTotal > 0 ? (
          <div className="flex flex-wrap items-center gap-s2 rounded-dash border-[1.5px] border-dash-hairline bg-surface px-s4 py-s3 shadow-dashCard">
            <span className="label-caps text-text-subtle">Other statuses</span>
            {otherEntries.map(([status, count]) => (
              <span
                key={status}
                className="inline-flex items-center rounded-pill border-[1.5px] border-dash-hairline bg-dash-alt px-2.5 py-1 text-2xs font-bold text-text"
                data-numeric=""
              >
                {status}: {formatInteger(count)}
              </span>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
