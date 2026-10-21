import * as React from 'react';
import { CircleCheck, Info } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { formatPlanWeek } from '@/lib/format';

import type { SolveResponse } from '../../api/whatif-types';
import { SimulateView } from './simulate-view';
import {
  Callout,
  FigureTile,
  ProjectRowsTable,
  ScopeNote,
  SectionHeading,
  WorkingsDisclosure,
} from './result-parts';
import { int } from './figures';

const UNATTAINABLE_COLUMNS = [
  { header: 'Project', cell: (r: SolveResponse['unattainable_projects'][number]) => <span className="font-medium">{r.name}</span> },
  { header: 'Hub', cell: (r: SolveResponse['unattainable_projects'][number]) => r.hub },
  { header: 'Category', cell: (r: SolveResponse['unattainable_projects'][number]) => r.category ?? '—' },
  {
    header: 'Earliest possible finish',
    cell: (r: SolveResponse['unattainable_projects'][number]) =>
      r.unconstrained_end_week === null ? '—' : formatPlanWeek(r.unconstrained_end_week),
  },
];

/**
 * Fewest additions (`POST /whatif/solve`). Reads `met`, `met_attainable`,
 * `capped`, `exact` and `runs_used` exactly as served. A project that can never
 * finish this year (critical path too long, OQ #47) is a property of the lead
 * time, not a failed recommendation, so it is shown as such: separately, with
 * the server's `semantics` sentence, and `met_attainable` read as a clear result.
 */
export function SolveView({ data }: { data: SolveResponse }): React.JSX.Element {
  const hasUnattainable = data.unattainable_projects.length > 0 || data.unattainable_project_ids.length > 0;
  const designers = data.additions.designers;
  const chambers = data.additions.chambers;
  const nothingToAdd = data.additions.total === 0;
  return (
    <div className="space-y-s4" data-testid="whatif-solve">
      <ScopeNote scope={data.scope} />

      {/* Headline: what to add. */}
      <div className="grid gap-s3 sm:grid-cols-3">
        <FigureTile
          label="Designers to add"
          value={int(designers.reduce((a, d) => a + d.count, 0))}
          hint={
            designers.length === 0
              ? 'None'
              : designers.map((d) => `${int(d.count)} in ${d.hub}`).join(', ')
          }
          testId="solve-designers"
        />
        <FigureTile
          label="Chambers to add"
          value={int(chambers.reduce((a, c) => a + c.count, 0))}
          hint={
            chambers.length === 0
              ? 'None'
              : chambers.map((c) => `${int(c.count)} in ${c.lab_region}`).join(', ')
          }
          testId="solve-chambers"
        />
        <FigureTile label="Total additions" value={int(data.additions.total)} testId="solve-total" />
      </div>

      {/* Outcome of the search, in plain words. */}
      {data.met ? (
        <Callout tone="success" title="Target met" testId="solve-outcome" role="status">
          <p>
            <CircleCheck className="mr-1 inline size-3.5" aria-hidden="true" />
            {nothingToAdd
              ? 'Every project of the target already finishes inside the planning year. Nothing needs adding.'
              : 'With these additions every project of the target finishes inside the planning year.'}
          </p>
        </Callout>
      ) : data.met_attainable ? (
        <Callout
          tone="primary"
          title="Everything that capacity can help finishes inside the year"
          testId="solve-outcome"
          role="status"
        >
          <p>
            {nothingToAdd
              ? 'No additions are needed for the projects capacity can help.'
              : 'With these additions, every project that capacity can still help finishes inside the planning year.'}{' '}
            The projects listed below cannot finish this year whatever is added. That is a property of their lead
            times, not a shortfall in this recommendation.
          </p>
        </Callout>
      ) : (
        <Callout
          tone="warning"
          title="The search did not reach the target within its limits"
          testId="solve-outcome"
          role="status"
        >
          <p>
            {int(data.unmet_project_ids.length)} project{data.unmet_project_ids.length === 1 ? '' : 's'} still
            miss{data.unmet_project_ids.length === 1 ? 'es' : ''} the year with the additions shown. The additions are
            the best found within the search limits.
          </p>
        </Callout>
      )}

      {/* Honest search status. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="solve-honesty">
        <Badge tone={data.exact ? 'success' : 'warning'} data-testid="solve-exact">
          {data.exact ? 'Proven minimum' : 'Smallest found (assumes more capacity never hurts)'}
        </Badge>
        <Badge tone={data.capped ? 'warning' : 'neutral'} data-testid="solve-capped">
          {data.capped ? 'Search stopped at its run limit' : 'Search finished within its run limit'}
        </Badge>
        <span className="text-2xs text-text-muted" data-testid="solve-runs">
          Used {int(data.runs_used)} of {int(data.run_cap)} scheduler runs
        </span>
        {data.searched_designer_hubs.length + data.searched_chamber_regions.length > 0 ? (
          <span className="text-2xs text-text-muted">
            Searched designers in {data.searched_designer_hubs.join(', ') || 'no hub'}; chambers in{' '}
            {data.searched_chamber_regions.join(', ') || 'no region'}.
          </span>
        ) : null}
      </div>
      {data.capped ? (
        <p className="text-2xs text-text-muted">
          The run limit ended the search early, so a smaller combination might exist. Treat the additions as an upper
          bound.
        </p>
      ) : null}
      {!data.exact && !data.capped ? (
        <p className="text-2xs text-text-muted" data-testid="solve-not-proven">
          Not every smaller combination was simulated, so a smaller one may exist. The additions are the smallest the
          search found.
        </p>
      ) : null}

      {/* OQ #47: cannot finish whatever is added. */}
      {hasUnattainable ? (
        <section
          className="space-y-s2 rounded-md border-2 border-warning/50 bg-warning-subtle/40 p-s4"
          aria-labelledby="solve-unattainable-heading"
          data-testid="solve-unattainable"
        >
          <h4 id="solve-unattainable-heading" className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <Info className="size-4 text-warning" aria-hidden="true" />
            Cannot finish within the year whatever you add (critical path too long) ({int(data.unattainable_project_ids.length)})
          </h4>
          <p className="text-xs text-text-muted" data-testid="solve-semantics">
            {data.semantics}
          </p>
          {data.unattainable_projects.length > 0 ? (
            <ProjectRowsTable
              rows={data.unattainable_projects}
              columns={UNATTAINABLE_COLUMNS}
              rowKey={(r) => r.project_id}
              label="Projects that cannot finish within the year"
            />
          ) : (
            <p className="text-xs text-text-muted">
              {int(data.unattainable_project_ids.length)} project(s) outside your scope are affected.
            </p>
          )}
        </section>
      ) : (
        <p className="text-2xs text-text-muted" data-testid="solve-semantics">
          {data.semantics}
        </p>
      )}

      {data.achieved ? (
        <details className="group rounded-md border border-border" data-testid="solve-achieved">
          <summary className="cursor-pointer rounded-md px-s3 py-s2 text-xs font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Result with these additions applied
          </summary>
          <div className="p-s3">
            <SectionHeading>Simulated with the additions</SectionHeading>
            <div className="mt-s2">
              <SimulateView data={data.achieved} compact />
            </div>
          </div>
        </details>
      ) : null}

      <WorkingsDisclosure lines={data.workings} />
    </div>
  );
}
