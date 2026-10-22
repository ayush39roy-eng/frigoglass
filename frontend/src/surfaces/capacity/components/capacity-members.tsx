import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatInteger } from '@/lib/format';
import type { CapacityHorizon } from '../lib/pick-figures';
import { formatFigure } from '../lib/status-format';
import { cn } from '@/lib/utils';

import type { HubCapacityRow } from '../api/types';
import { hasMemberBreakdown, memberBooked, memberDemand, SELECTED_MEMBER_SR } from '../lib/members';

/**
 * P29 (ADR 0042, API_CONTRACT_P29 §2.2): the served `members` breakdown of a
 * capacity hub's row. R&D-Greece's row covers R&D-Greece's own projects plus
 * OEM-HCK and OEM-Seitek's: one capacity (Greece's counted engineers), one
 * load, one booked %.
 *
 * Display only (I9/I19): each member shows its served `project_count`, its
 * design demand for the horizon (P30: full year `design_load_weeks` or
 * `design_load_remaining_weeks`) and what the active plan booked
 * (`design_load_booked_weeks`, `booked_project_count`). Nothing is added up
 * here: the row totals are the row's own served fields (a hub-scoped caller is
 * served the full aggregate but only their members, so a sum would be wrong).
 * No per-member capacity exists, so no per-member booked % or status is shown.
 */

/**
 * The breakdown as a small table (Details dialog): Hub | Projects | Demand
 * (wks, for the horizon) | In plan (wks) | Projects in plan, one row per served member, the selected member highlighted. The
 * caption says the row's figures (capacity, booked %, gap) are the aggregate.
 */
export function MembersBreakdown({
  row,
  horizon = 'year',
  className,
}: {
  row: HubCapacityRow;
  /** P30: which served demand to show (the page's Full year / YTD toggle). */
  horizon?: CapacityHorizon;
  className?: string;
}): React.JSX.Element | null {
  if (!hasMemberBreakdown(row)) return null;
  return (
    <section
      aria-label={`${row.hub} capacity covers these hubs`}
      className={cn('space-y-s2 rounded-dash border border-dash-hairline bg-surface p-card-tight', className)}
      data-testid="members-breakdown"
    >
      <header className="space-y-0.5">
        <h4 className="label-caps text-text-muted">Hubs on this capacity</h4>
        <p className="text-2xs text-text-muted">
          {row.hub}&rsquo;s engineers do the design work of these hubs, so their projects&rsquo; design demand
          is counted in this row against one capacity. Booked %, status and gap exist for the row only.
        </p>
      </header>
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="h-auto px-2 py-1.5">
              Hub
            </TableHead>
            <TableHead scope="col" className="h-auto px-2 py-1.5 text-right">
              Projects
            </TableHead>
            <TableHead scope="col" className="h-auto px-2 py-1.5 text-right">
              {horizon === 'year' ? 'Full-year demand' : 'Remaining demand'} (wks)
            </TableHead>
            <TableHead scope="col" className="h-auto px-2 py-1.5 text-right">
              In plan (wks)
            </TableHead>
            <TableHead scope="col" className="h-auto px-2 py-1.5 text-right">
              Projects in plan
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {row.members.map((m) => {
            const selected = row.selected_member === m.hub;
            return (
              <TableRow
                key={m.hub}
                className={cn(selected && 'bg-primary-subtle/60 hover:bg-primary-subtle/60')}
                data-testid={`members-breakdown-${m.hub}`}
                data-selected={selected ? 'true' : undefined}
              >
                <TableHead scope="row" className="h-auto px-2 py-1.5 text-xs font-semibold normal-case tracking-normal text-text">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {m.hub}
                    {m.own ? (
                      <Badge tone="neutral" className="rounded-pill">
                        own
                      </Badge>
                    ) : null}
                    {selected ? (
                      <Badge tone="primary" className="rounded-pill">
                        <span aria-hidden="true">Selected</span>
                        <span className="sr-only">{SELECTED_MEMBER_SR}</span>
                      </Badge>
                    ) : null}
                  </span>
                </TableHead>
                <TableCell className="px-2 py-1.5 text-right font-mono tabular-nums" data-testid="member-projects">
                  {formatInteger(m.project_count)}
                </TableCell>
                <TableCell className="px-2 py-1.5 text-right font-mono tabular-nums" data-testid="member-design-load">
                  {formatFigure(memberDemand(m, horizon))}
                </TableCell>
                <TableCell className="px-2 py-1.5 text-right font-mono tabular-nums text-text-muted" data-testid="member-in-plan">
                  {formatFigure(memberBooked(m))}
                </TableCell>
                <TableCell className="px-2 py-1.5 text-right font-mono tabular-nums text-text-muted" data-testid="member-projects-in-plan">
                  {typeof m.booked_project_count === 'number' ? formatInteger(m.booked_project_count) : '—'}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
