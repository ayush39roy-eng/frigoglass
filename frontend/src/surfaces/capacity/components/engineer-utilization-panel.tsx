import * as React from 'react';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { ApiError } from '@/lib/api/client';

import { useEngineerUtilization } from '../hooks/use-capacity';
import { EngineerUtilizationHeatmap } from './engineer-utilization-heatmap';

/**
 * Engineers x weeks (ADR 0028, P15). Own endpoint, own query: a 403 here
 * (e.g. no CAPACITY read) shows an in-card notice rather than failing the page.
 */
export function EngineerUtilizationPanel(): React.JSX.Element {
  const query = useEngineerUtilization();

  if (query.isError && query.error instanceof ApiError && query.error.isForbidden) {
    return (
      <BoltCard>
        <CardHeader>
          <CardTitle>Engineers × weeks</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="No access to engineer utilization"
            description="Your role cannot view per-engineer utilization for this scope."
            className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
          />
        </CardContent>
      </BoltCard>
    );
  }

  return (
    <SectionBoundary
      query={query}
      title="Engineers × weeks"
      errorDescription="Per-engineer utilization could not be loaded."
    >
      {(data) => (
        <BoltCard>
          <CardHeader>
            <CardTitle>Engineers × weeks</CardTitle>
          </CardHeader>
          <CardContent>
            {data.engineers.length === 0 ? (
              <EmptyState
                title="No engineers in scope"
                description="There are no engineers for the selected hub or country, or no schedule has been computed yet."
                className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
              />
            ) : (
              <EngineerUtilizationHeatmap data={data} />
            )}
          </CardContent>
        </BoltCard>
      )}
    </SectionBoundary>
  );
}
