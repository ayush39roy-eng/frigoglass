import * as React from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Siren } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';

import { RISK_LIST_CAP, RISK_REASON_META, type RiskRow } from '../../lib/executive';

/**
 * Risks & escalations (P28, ADR 0039 §3): a capped list of SERVED risk rows —
 * blocked projects, overdue check-ins, VIP projects not completing within the
 * year — selected and de-duplicated by `lib/executive.ts::selectRiskRows`
 * (served flags only, no new judgement). One line per row: name · hub · reason
 * chip, linking to the project exactly like the register rows
 * (`/projects/{id}`). "+N more" opens the full project register.
 */
export function RisksCard({ risks }: { risks: RiskRow[] }): React.JSX.Element {
  const headingId = React.useId();
  const shown = risks.slice(0, RISK_LIST_CAP);
  const more = risks.length - shown.length;
  return (
    <BoltCard className="flex h-full flex-col gap-s3 p-s5" role="group" aria-labelledby={headingId} data-testid="exec-risks-card">
      <div className="flex items-center justify-between gap-s2">
        <h3 id={headingId} className="flex items-center gap-1.5 label-caps text-text-subtle">
          <Siren className="size-3.5" aria-hidden="true" />
          Risks &amp; escalations
        </h3>
        <CardInfo label="How risks are selected">
          <p>
            Served facts only, in this order: projects the active run holds On hold at a stage, projects
            whose served check-in tracking is Overdue, and VIP projects whose served run outcome is not
            within the year. A project appears once (its first reason wins). The list is capped at{' '}
            {String(RISK_LIST_CAP)}; the rest are in the project register.
          </p>
        </CardInfo>
      </div>
      {shown.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-text-muted" data-testid="exec-risks-empty">
          <ShieldCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />
          No blocked, overdue or at-risk VIP projects in view.
        </p>
      ) : (
        <>
          {/* Owner round 3: a row is ONLY the full project name + hub — the
              reason moves into tiny group subheadings (rendered only when the
              group has rows), keeping the blocked → overdue → VIP order. Names
              never truncate; a long one wraps inside its own cell. */}
          {(['blocked', 'overdue', 'vip_not_in_year'] as const).map((reason) => {
            const group = shown.filter((risk) => risk.reason === reason);
            if (group.length === 0) return null;
            const meta = RISK_REASON_META[reason];
            return (
              <div key={reason} className="space-y-1" data-testid={`exec-risk-group-${reason}`}>
                {/* Owner ask 2026-10-23: no visible heading for "Overdue check-in" and
                    "VIP not in year"; the reason stays the list's accessible name. */}
                <h4
                  className={cn(
                    'label-caps text-[0.6rem] text-text-subtle',
                    (reason === 'overdue' || reason === 'vip_not_in_year') && 'sr-only',
                  )}
                  title={meta.title}
                >
                  {meta.label}
                </h4>
                <ul className="space-y-1" aria-label={meta.label}>
                  {group.map((risk) => (
                    <li
                      key={risk.projectId}
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-s2 rounded-lg border border-dash-hairline bg-dash-alt px-s3 py-1.5"
                      data-testid="exec-risk-row"
                      data-reason={risk.reason}
                    >
                      <Link
                        to={`/projects/${risk.projectId}`}
                        className="min-w-0 break-words text-xs font-semibold leading-tight text-text underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {risk.name}
                      </Link>
                      {risk.hub ? <span className="shrink-0 text-2xs text-text-muted">{risk.hub}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {more > 0 ? (
            <Link
              to="/projects"
              data-testid="exec-risks-more"
              className="self-start text-2xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
            >
              +{formatInteger(more)} more in the project register
            </Link>
          ) : null}
        </>
      )}
    </BoltCard>
  );
}
