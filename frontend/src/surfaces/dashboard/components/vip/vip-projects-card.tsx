import * as React from 'react';
import { LayoutGrid, Star } from 'lucide-react';

import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { useVipBoard, type VipArea, type VipBoardArea } from '@/lib/api/vip';
import { formatInteger } from '@/lib/format';
import { useHubFilterParams } from '@/stores/hub-filter';
import { usePermission } from '@/stores/session';
import { cn } from '@/lib/utils';

import { VipBoardDialog } from './vip-board-dialog';
import { Badge } from '@/components/ui/badge';
import { VipItemLink } from './vip-item-link';
import { findItem, STATUS_TAG_META } from './vip-meta';

/**
 * Dashboard "VIP projects" (P14, ADR 0027 §6 as amended for OQ #39). One tile
 * per area in scope — Greece, India, Romania — with the country flag, the
 * area's hubs, the served counts, and the area's VIP (highlighted) items by
 * name. Clicking a VIP item opens its project (one → Workspace, several → a
 * picker). "View all" opens the slide-layout pop-up. Every count and project
 * fact is served by `GET /vip-board` (I9); the global hub / country filter is
 * sent and keyed.
 *
 * P17-R06: the card now sits in the narrow side column beside the Hub x Type
 * pipeline summary, so the tiles stack in ONE column inside a scroll region
 * (focusable, labelled) and each VIP item carries its served status tag.
 */
export function VipProjectsCard({ fill = false }: { fill?: boolean } = {}): React.JSX.Element {
  const params = useHubFilterParams();
  const query = useVipBoard(params);
  const canEdit = usePermission('matrix').write;
  const [openArea, setOpenArea] = React.useState<VipArea | null>(null);
  const area = query.data?.areas.find((a) => a.area === openArea) ?? null;

  return (
    <Card
      data-testid="vip-projects-card"
      className={fill ? 'xl:absolute xl:inset-0 xl:flex xl:flex-col xl:overflow-hidden' : undefined}
    >
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Star className="size-4 text-text-muted" aria-hidden="true" />
            VIP projects
          </CardTitle>
          <CardDescription>The client's VIP list per country.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className={fill ? 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col' : undefined}>
        {query.isPending ? (
          <div className="grid gap-3" aria-busy="true">
            <span className="sr-only">Loading VIP projects…</span>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : query.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
            {apiErrorMessage(query.error, 'The VIP board could not be loaded.')}
            <Button type="button" size="sm" variant="secondary" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : query.data.areas.length === 0 ? (
          <p className="text-xs text-text-muted">No VIP area in the current hub or country filter.</p>
        ) : (
          <div
            className={cn(
              'max-h-[34rem] overflow-y-auto pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              fill && 'xl:max-h-none xl:min-h-0 xl:flex-1',
            )}
            tabIndex={0}
            role="region"
            aria-label="VIP projects by country"
          >
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-3" aria-label="VIP areas">
              {query.data.areas.map((a) => (
                <AreaTile key={a.area} area={a} onViewAll={() => setOpenArea(a.area)} />
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      <VipBoardDialog area={area} pillars={query.data?.pillars ?? []} canEdit={canEdit} onClose={() => setOpenArea(null)} />
    </Card>
  );
}

function Count({ label, value, testId, alarm = false }: { label: string; value: number; testId: string; alarm?: boolean }) {
  return (
    <div className="flex flex-col" data-testid={testId}>
      <dt className="text-2xs font-semibold text-text-muted">{label}</dt>
      <dd className={alarm && value > 0 ? 'text-base font-bold tabular-nums text-danger' : 'text-base font-bold tabular-nums text-text'} data-numeric="">
        {formatInteger(value)}
      </dd>
    </div>
  );
}

function AreaTile({ area, onViewAll }: { area: VipBoardArea; onViewAll: () => void }): React.JSX.Element {
  const headingId = React.useId();
  return (
    <li
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface-raised p-3"
      aria-labelledby={headingId}
      data-testid="vip-area-tile"
      data-area={area.area}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="flex items-center gap-2 text-sm font-bold text-text">
            <CountryFlag region={area.area} />
            {area.label}
          </h3>
          <p className="text-2xs text-text-muted">{area.hubs.join(' · ')}</p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={onViewAll} aria-label={`View all VIP items for ${area.label}`}>
          <LayoutGrid aria-hidden="true" />
          View all
        </Button>
      </div>
      <dl className="grid grid-cols-3 gap-2 [&>*]:min-w-0 [&_dt]:break-words">
        <Count label="VIP" value={area.highlighted_count} testId="vip-count-highlighted" />
        <Count label="High risk" value={area.high_risk_count} testId="vip-count-high-risk" alarm />
        <Count label="Linked projects" value={area.linked_project_count} testId="vip-count-linked" />
      </dl>
      {area.vip_items.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-border pt-2 text-xs text-text" aria-label={`${area.label} VIP items`}>
          {area.vip_items.map((ref) => {
            const item = findItem(area.items, ref.id);
            const tag = item?.status_tag ? STATUS_TAG_META[item.status_tag] : null;
            return (
              <li key={ref.id} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 [overflow-wrap:anywhere]" data-testid="vip-tile-item">
                <Star className="size-3 shrink-0 self-center text-text-muted" aria-hidden="true" />
                {item ? <VipItemLink item={item} className="font-medium" /> : <span>{ref.title}</span>}
                {tag ? (
                  <Badge tone={tag.tone} className="rounded-pill text-2xs" data-testid="vip-tile-status">
                    {tag.label}
                  </Badge>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="border-t border-border pt-2 text-xs text-text-muted">No VIP item yet.</p>
      )}
    </li>
  );
}
