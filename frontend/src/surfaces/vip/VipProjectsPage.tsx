import * as React from 'react';
import { Info, TriangleAlert } from 'lucide-react';

import { SURFACES } from '@/app/nav';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatInteger } from '@/lib/format';
import { useHubFilter } from '@/stores/hub-filter';
import { usePermission } from '@/stores/session';

import { useSetVip, useVipProjects, VIP_LIMIT_DEFAULT, type VipHub, type VipProject, type VipYear } from './api';
import { VipCard } from './components/vip-card';

const SURFACE = SURFACES.find((s) => s.path === '/vip');
const LIMIT_OPTIONS = [10, 15] as const;

function HubSection({
  hub,
  limit,
  canPin,
  pin,
}: {
  hub: VipHub;
  limit: number;
  canPin: boolean;
  pin: { busyId: string | null; error: { projectId: string; error: unknown } | null; toggle: (p: VipProject) => void };
}): React.JSX.Element {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3" data-testid="vip-hub" data-hub-id={hub.hub_id}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="font-display text-lg font-bold text-text">
          {hub.hub}
        </h2>
        <p className="text-2xs text-text-muted">
          <span className="font-mono font-semibold tabular-nums text-text" data-numeric="">
            {formatInteger(hub.pinned_count)}
          </span>{' '}
          pinned
        </p>
      </header>
      {hub.over_limit ? (
        <p
          role="note"
          className="flex items-start gap-1.5 rounded-control bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-fg"
          data-testid="vip-over-limit"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          More projects are pinned ({formatInteger(hub.pinned_count)}) than the list limit of {formatInteger(limit)}. Every
          pinned project is shown; unpin some to make room for the automatic ranking.
        </p>
      ) : null}
      <ol className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3" aria-label={`${hub.hub} VIP projects, ranked`}>
        {hub.projects.map((project) => (
          <li key={project.project_id}>
            <VipCard
              project={project}
              canPin={canPin}
              pinBusy={pin.busyId === project.project_id}
              pinError={pin.error?.projectId === project.project_id ? pin.error.error : null}
              onTogglePin={pin.toggle}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * `/vip` (ADR 0022, P12-T05): the critical 10–15 projects per hub for the plan
 * year (W1–52) or the next (W53–78), from `GET /vip-projects`. Pinned projects
 * come first, then the automatic fill — selected and ranked by the server. A
 * planner with Registration write can pin or unpin (`PUT /projects/{id}/vip`);
 * a pin never recalculates the schedule.
 */
export default function VipProjectsPage(): React.JSX.Element {
  const { hubId } = useHubFilter();
  const [year, setYear] = React.useState<VipYear>('plan');
  const [limit, setLimit] = React.useState<number>(VIP_LIMIT_DEFAULT);
  const query = useVipProjects({ year, hubId, limit });
  const canPin = usePermission('project_registration').write;
  const setVip = useSetVip();
  const [pinError, setPinError] = React.useState<{ projectId: string; error: unknown } | null>(null);
  const yearId = React.useId();
  const limitId = React.useId();

  const toggle = React.useCallback(
    (project: VipProject) => {
      setPinError(null);
      setVip.mutate(
        { projectId: project.project_id, isVip: project.selection !== 'pinned' },
        { onError: (error) => setPinError({ projectId: project.project_id, error }) },
      );
    },
    [setVip],
  );
  const busyId = setVip.isPending ? (setVip.variables?.projectId ?? null) : null;

  const range = query.data?.week_range;
  const title = SURFACE?.title ?? 'VIP Projects';

  return (
    <>
      <PageHeader
        title={title}
        description="The critical projects per hub: pinned projects first, then the highest priority and score. Pinning never changes the schedule."
        actions={
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={yearId} className="text-2xs text-text-muted">
                Year
              </Label>
              <ToggleGroup
                id={yearId}
                type="single"
                size="sm"
                value={year}
                onValueChange={(next) => {
                  if (next === 'plan' || next === 'next') setYear(next);
                }}
              >
                <ToggleGroupItem value="plan" aria-label="Plan year, weeks 1 to 52">
                  Plan year
                </ToggleGroupItem>
                <ToggleGroupItem value="next" aria-label="Next year, weeks 53 to 78">
                  Next year
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={limitId} className="text-2xs text-text-muted">
                List size
              </Label>
              <ToggleGroup
                id={limitId}
                type="single"
                size="sm"
                value={String(limit)}
                onValueChange={(next) => {
                  const n = Number(next);
                  if ((LIMIT_OPTIONS as readonly number[]).includes(n)) setLimit(n);
                }}
              >
                {LIMIT_OPTIONS.map((n) => (
                  <ToggleGroupItem key={n} value={String(n)} aria-label={`Top ${String(n)} per hub`}>
                    Top {n}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
        }
      />

      {range ? (
        <p className="-mt-s4 mb-s4 text-xs text-text-muted" data-testid="vip-week-range">
          Weeks {range[0]}–{range[1]} of the horizon. A project is in this year when any of its scheduled weeks fall in
          it.
        </p>
      ) : null}
      {query.data && query.data.run_id === null ? (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-text-muted" role="note">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          There is no active schedule run yet, so projected finish, health and progress are not available.
        </p>
      ) : null}

      {query.isPending ? (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3" aria-hidden="true">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : query.isError ? (
        <ErrorState description="The VIP projects could not be loaded." onRetry={() => void query.refetch()} />
      ) : query.data.hubs.length === 0 ? (
        <EmptyState
          title="No VIP projects"
          description={
            year === 'plan'
              ? 'No project in scope is scheduled in the plan year.'
              : 'No project in scope is scheduled in the next year.'
          }
        />
      ) : (
        <div className="space-y-s6">
          {query.data.hubs.map((hub) => (
            <HubSection
              key={hub.hub_id}
              hub={hub}
              limit={query.data.limit}
              canPin={canPin}
              pin={{ busyId, error: pinError, toggle }}
            />
          ))}
        </div>
      )}
    </>
  );
}
