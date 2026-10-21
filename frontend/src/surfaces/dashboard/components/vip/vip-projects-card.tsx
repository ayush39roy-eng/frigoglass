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
 * P17-R06: the tiles stack in ONE column inside a scroll region (focusable,
 * labelled) and each VIP item carries its served status tag.
 *
 * P17-R08: squeezed into a slim column beside the Project pipeline row (above
 * the fold at 1440x900). Each country is one compact block: flag + name +
 * View all on one line, the served counts inline, then the VIP item names.
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
      <CardHeader className="px-s3 pb-1.5 pt-s2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Star className="size-4 text-text-muted" aria-hidden="true" />
            VIP projects
          </CardTitle>
          <CardDescription className="sr-only">The client's VIP list per country.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className={cn('px-s3 pb-s2 pt-0', fill && 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col')}>
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
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-label="VIP areas">
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

function Count({
  label,
  title,
  value,
  testId,
  alarm = false,
}: {
  label: string;
  /** Full wording when `label` is shortened for the slim column. */
  title?: string;
  value: number;
  testId: string;
  alarm?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-0.5" data-testid={testId} title={title}>
      {/* dt first (valid <dl>), shown after the number via `order`. */}
      <dt className="order-2 text-text-muted">
        {title ? <span className="sr-only">{title}</span> : null}
        <span aria-hidden={title ? true : undefined}>{label}</span>
      </dt>
      <dd className={alarm && value > 0 ? 'order-1 font-bold tabular-nums text-danger' : 'order-1 font-bold tabular-nums text-text'} data-numeric="">
        {formatInteger(value)}
      </dd>
    </div>
  );
}

/** P17-R08: VIP item names shown per country in the slim column; the rest
 *  are one click away in the existing slide dialog ("+N more"). */
const TILE_ITEM_LIMIT = 1;

function AreaTile({ area, onViewAll }: { area: VipBoardArea; onViewAll: () => void }): React.JSX.Element {
  const headingId = React.useId();
  const hubs = area.hubs.join(' · ');
  const shown = area.vip_items.slice(0, TILE_ITEM_LIMIT);
  const more = area.vip_items.length - shown.length;
  return (
    <li
      className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-surface-raised px-2.5 py-1.5"
      aria-labelledby={headingId}
      data-testid="vip-area-tile"
      data-area={area.area}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <h3 id={headingId} className="flex min-w-0 items-center gap-1.5 text-sm font-bold text-text" title={hubs}>
          <CountryFlag region={area.area} />
          {area.label}
        </h3>
        <p className="sr-only">{hubs}</p>
        <dl className="flex flex-wrap gap-x-1.5 text-2xs">
          <Count label="VIP" value={area.highlighted_count} testId="vip-count-highlighted" />
          <Count label="risk" title="High risk" value={area.high_risk_count} testId="vip-count-high-risk" alarm />
          <Count label="linked" title="Linked projects" value={area.linked_project_count} testId="vip-count-linked" />
        </dl>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="ml-auto size-7 shrink-0"
          onClick={onViewAll}
          aria-label={`View all VIP items for ${area.label}`}
          title={`View all VIP items for ${area.label}`}
        >
          <LayoutGrid aria-hidden="true" />
        </Button>
      </div>
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-2xs text-text" aria-label={`${area.label} VIP items`}>
          {shown.map((ref, i) => {
            const item = findItem(area.items, ref.id);
            const last = i === shown.length - 1;
            const tag = item?.status_tag ? STATUS_TAG_META[item.status_tag] : null;
            return (
              <li key={ref.id} className="flex min-w-0 items-baseline gap-1.5" data-testid="vip-tile-item">
                <Star className="size-3 shrink-0 self-center text-text-muted" aria-hidden="true" />
                <span className="min-w-0 truncate">
                  {item ? <VipItemLink item={item} className="font-medium" /> : <span>{ref.title}</span>}
                </span>
                {tag ? (
                  <Badge tone={tag.tone} className="shrink-0 rounded-pill px-1.5 py-0 text-2xs" data-testid="vip-tile-status">
                    {tag.label}
                  </Badge>
                ) : null}
                {last && more > 0 ? (
                  <button
                    type="button"
                    className="ml-auto shrink-0 rounded text-2xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={onViewAll}
                    aria-label={`Show all ${String(area.vip_items.length)} VIP items for ${area.label}`}
                  >
                    +{formatInteger(more)} more
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-2xs text-text-muted">No VIP item yet.</p>
      )}
    </li>
  );
}
