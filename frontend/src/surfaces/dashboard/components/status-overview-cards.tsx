import * as React from 'react';
import { CheckCircle2, FlaskConical, Hammer, ListChecks } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatInteger } from '@/lib/format';

import type { StatusOverview } from '../api/types';
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
  const otherBreakdown = Object.entries(data.other_counts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}: ${formatInteger(count)}`)
    .join(' · ');

  return (
    /* Section, not a card — the four StatCards are the cards. See the note in
     * within-year-panel.tsx: nesting a card inside a card puts white on white and
     * costs the tiles the lift that makes them read as objects. */
    <Card className="border-0 bg-transparent shadow-none">
      <CardHeader className="border-0 px-0">
        <CardTitle className="text-h1">Status overview</CardTitle>
      </CardHeader>
      <CardContent className="space-y-s3 px-0 pb-0">
        <div className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="In Buyoff" value={data.in_buyoff} tone="primary" icon={CheckCircle2} />
          <StatCard
            label="Under Industrialization"
            value={data.under_industrialization}
            tone="neutral"
            icon={Hammer}
          />
          <StatCard
            label="In Development"
            value={data.in_development}
            tone="neutral"
            icon={FlaskConical}
          />
          <StatCard label="In Queue" value={data.in_queue} tone="neutral" icon={ListChecks} />
        </div>
        {otherTotal > 0 ? (
          <p className="text-2xs text-text-muted">
            Not shown as cards (Draft / Commercialized / On Hold): {otherBreakdown}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
