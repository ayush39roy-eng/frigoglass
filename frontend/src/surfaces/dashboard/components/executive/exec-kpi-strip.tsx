import * as React from 'react';
import { Link } from 'react-router-dom';
import { CalendarCheck, CalendarClock, CircleOff, CirclePause, FolderKanban, Info, Star } from 'lucide-react';

import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatInteger } from '@/lib/format';
import type { VipArea, VipBoardResponse } from '@/lib/api/vip';

import type { CompletingWithinYear, ProjectFilterRow } from '../../api/types';
import { vipHighlightedTotal, type KpiBucket } from '../../lib/executive';
import { outcomeTotal, withinYearSharePct } from '../../lib/outcome';
import { VipBoardDialog } from '../vip/vip-board-dialog';
import { ExecKpiTile } from './exec-kpi-tile';
import { KpiProjectsDialog } from './kpi-projects-dialog';

/**
 * Executive summary KPI strip (P28, ADR 0039 §3 + addenda): six IDENTICAL
 * fixed-size tiles (equal grid columns, `ExecKpiTile`'s fixed frame), every
 * figure a served field shown verbatim — except the two established Detailed
 * derivations: "Scheduled" = `outcomeTotal` (the Detailed header's sum) and
 * the within-year badge = `withinYearSharePct`. VIP = the served per-area
 * `vip_project_count`s summed (`vipHighlightedTotal`; pinned projects, ADR 0040).
 *
 * Click-through (owner addendum): each run tile opens a dialog with exactly
 * the rows behind its number (`KpiProjectsDialog`, served flags only); the VIP
 * tile opens the EXISTING VIP board dialog — directly when one area is in
 * scope, via a small area picker when several are. With no active schedule run
 * the strip falls back to the pipeline total (not clickable) + VIP + a short
 * notice, and the run tiles are hidden.
 */
export function ExecKpiStrip({
  data,
  pipelineTotal,
  vipBoard,
  vipProjects = null,
  canEditVip = false,
}: {
  data: CompletingWithinYear;
  /** Served `PipelineTotals.total_count`; null while unresolved. */
  pipelineTotal: number | null;
  /** The served VIP board (null while unresolved) — count tile + dialog. */
  vipBoard: VipBoardResponse | null;
  /** ADR 0040 (owner ask 2026-10-23): the register rows the server serves with
   *  `is_vip` true, i.e. the pinned VIP projects; null while unresolved. The
   *  tile counts them and lists them; the board stays one click away. */
  vipProjects?: ProjectFilterRow[] | null;
  /** MATRIX write — the VIP dialog's edit mode (same rule as the VIP card). */
  canEditVip?: boolean;
}): React.JSX.Element {
  const [openBucket, setOpenBucket] = React.useState<KpiBucket | null>(null);
  const [vipPicker, setVipPicker] = React.useState(false);
  const [openVipArea, setOpenVipArea] = React.useState<VipArea | null>(null);
  /** The tile that opened the projects dialog — focus returns to it on close. */
  const openerRef = React.useRef<HTMLElement | null>(null);
  // Event handler (never runs during render): remembers which tile opened the
  // dialog so focus can return to it on close.
  const openFromTile = React.useCallback((bucket: KpiBucket, tile: HTMLButtonElement) => {
    openerRef.current = tile;
    setOpenBucket(bucket);
  }, []);

  const vipCount = vipProjects !== null ? vipProjects.length : vipHighlightedTotal(vipBoard);
  const areas = vipBoard?.areas ?? [];
  const [vipList, setVipList] = React.useState(false);
  const openBoard = (): void => {
    if (areas.length === 0) return;
    if (areas.length === 1) setOpenVipArea(areas[0]?.area ?? null);
    else setVipPicker(true);
  };
  const openVip = (): void => {
    if (vipProjects !== null) setVipList(true);
    else openBoard();
  };
  const vipDialogArea = areas.find((a) => a.area === openVipArea) ?? null;

  const vipTile = (
    <ExecKpiTile
      label="VIP"
      value={vipCount ?? '—'}
      icon={Star}
      tone="primary"
      testId="exec-kpi-vip-tile"
      {...(vipProjects !== null || areas.length > 0
        ? { onOpen: openVip, openLabel: `VIP: list the VIP projects${vipCount === null ? '' : ` (${formatInteger(vipCount)})`}` }
        : {})}
    />
  );

  const vipDialogs = (
    <>
      {/* The pinned VIP projects, each a link to its Workspace; the board one click away. */}
      <Dialog open={vipList} onOpenChange={setVipList}>
        <DialogContent className="max-w-lg motion-reduce:animate-none" data-testid="exec-vip-projects">
          <DialogHeader>
            <DialogTitle>VIP projects{vipProjects ? ` — ${formatInteger(vipProjects.length)}` : ''}</DialogTitle>
            <DialogDescription>Pinned VIP projects; they schedule first (ADR 0040).</DialogDescription>
          </DialogHeader>
          {vipProjects && vipProjects.length > 0 ? (
            <ul className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
              {vipProjects.map((p) => (
                <li key={p.project_id} className="flex items-center gap-s2 rounded-lg border border-dash-hairline bg-dash-alt px-s3 py-1.5">
                  <Star className="size-3.5 shrink-0 fill-current text-accent" aria-hidden="true" />
                  <Link
                    to={`/projects/${p.project_id}`}
                    className="min-w-0 flex-1 truncate text-sm font-semibold text-text hover:text-primary hover:underline"
                    title={p.project_name}
                  >
                    {p.project_name}
                  </Link>
                  <span className="shrink-0 text-2xs text-text-muted">{p.hub}</span>
                  {p.priority ? <span className="shrink-0 text-2xs font-semibold text-text-muted">{p.priority}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-text-muted">No project is pinned VIP. Pin one with the star in the Matrix or on Projects.</p>
          )}
          {areas.length > 0 ? (
            <button
              type="button"
              className="self-start text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setVipList(false);
                openBoard();
              }}
              data-testid="exec-vip-open-board"
            >
              Open the VIP board
            </button>
          ) : null}
        </DialogContent>
      </Dialog>
      {/* Several areas: pick one, then the existing per-area board dialog. */}
      <Dialog open={vipPicker} onOpenChange={setVipPicker}>
        <DialogContent className="max-w-sm motion-reduce:animate-none" data-testid="exec-vip-picker">
          <DialogHeader>
            <DialogTitle>VIP board</DialogTitle>
            <DialogDescription>The VIP board is per country — pick one.</DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-2">
            {areas.map((a) => (
              <li key={a.area}>
                <button
                  type="button"
                  className="flex w-full items-center gap-s2 rounded-lg border border-dash-hairline bg-dash-alt px-s3 py-2 text-left text-sm font-semibold text-text hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setVipPicker(false);
                    setOpenVipArea(a.area);
                  }}
                  data-testid="exec-vip-picker-area"
                >
                  <CountryFlag region={a.area} />
                  <span className="min-w-0 flex-1">{a.label}</span>
                  <span className="text-2xs font-medium tabular-nums text-text-muted" data-numeric="">
                    {typeof (a as Partial<typeof a>).vip_project_count === 'number' ? formatInteger(a.vip_project_count) : '–'} VIP
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      <VipBoardDialog
        area={vipDialogArea}
        pillars={vipBoard?.pillars ?? []}
        canEdit={canEditVip}
        onClose={() => setOpenVipArea(null)}
      />
    </>
  );

  if (!data.has_active_schedule_run) {
    return (
      <section aria-label="Executive summary" data-testid="exec-kpi-strip" className="space-y-s2">
        <div className="grid grid-cols-2 gap-gutter sm:grid-cols-3 xl:grid-cols-6">
          {/* Not clickable: without a run there is no row set behind it. */}
          <div data-testid="exec-kpi-pipeline" className="min-w-0">
            <ExecKpiTile label="Pipeline projects" value={pipelineTotal ?? '—'} icon={FolderKanban} variant="feature" testId="exec-kpi-pipeline-tile" />
          </div>
          <div data-testid="exec-kpi-vip" className="min-w-0 [&>*]:w-full">
            {vipTile}
          </div>
        </div>
        <p data-testid="exec-no-run-notice" className="flex items-center gap-1.5 text-2xs font-medium text-text-muted">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          No schedule has been computed yet — run figures are hidden.
        </p>
        {vipDialogs}
      </section>
    );
  }

  const open = (bucket: KpiBucket) => (tile: HTMLButtonElement) => { openFromTile(bucket, tile); };
  const openLabel = (label: string, count: number): string =>
    `${label}: open the ${formatInteger(count)} ${count === 1 ? 'project' : 'projects'} behind this figure`;

  return (
    <section aria-label="Executive summary" data-testid="exec-kpi-strip">
      <div className="grid grid-cols-2 gap-gutter sm:grid-cols-3 xl:grid-cols-6">
        <div data-testid="exec-kpi-scheduled" className="min-w-0">
          <ExecKpiTile
            label="Scheduled"
            value={outcomeTotal(data)}
            icon={FolderKanban}
            {...(pipelineTotal !== null ? { badge: `of ${formatInteger(pipelineTotal)}` } : {})}
            onOpen={open('scheduled')}
            openLabel={openLabel('Scheduled', outcomeTotal(data))}
            testId="exec-kpi-scheduled-tile"
          />
        </div>
        <div data-testid="exec-kpi-within-year" className="min-w-0">
          <ExecKpiTile
            label="Within year"
            value={data.within_year_count}
            icon={CalendarCheck}
            variant="feature"
            badge={`${String(withinYearSharePct(data))}%`}
            badgeTone="pop"
            onOpen={open('within_year')}
            openLabel={openLabel('Within year', data.within_year_count)}
            testId="exec-kpi-within-year-tile"
          />
        </div>
        <div data-testid="exec-kpi-spillover" className="min-w-0">
          <ExecKpiTile
            label="Spillover"
            value={data.spillover_count}
            icon={CalendarClock}
            tone="warning"
            onOpen={open('spillover')}
            openLabel={openLabel('Spillover', data.spillover_count)}
            testId="exec-kpi-spillover-tile"
          />
        </div>
        <div data-testid="exec-kpi-left-out" className="min-w-0">
          <ExecKpiTile
            label="Left out"
            value={data.left_out_count}
            icon={CircleOff}
            tone="warning"
            onOpen={open('left_out')}
            openLabel={openLabel('Left out', data.left_out_count)}
            testId="exec-kpi-left-out-tile"
          />
        </div>
        <div data-testid="exec-kpi-blocked" className="min-w-0">
          <ExecKpiTile
            label="On hold"
            value={data.blocked_count}
            icon={CirclePause}
            variant="ink"
            onOpen={open('blocked')}
            openLabel={openLabel('On hold', data.blocked_count)}
            testId="exec-kpi-blocked-tile"
          />
        </div>
        <div data-testid="exec-kpi-vip" className="min-w-0">
          {vipTile}
        </div>
      </div>
      <KpiProjectsDialog
        bucket={openBucket}
        rows={data.rows}
        onClose={() => setOpenBucket(null)}
        returnFocusTo={openerRef}
      />
      {vipDialogs}
    </section>
  );
}
