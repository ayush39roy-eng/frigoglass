import * as React from 'react';
import { HardHat, Thermometer } from 'lucide-react';

import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { CapacityBasis, CapacitySummary } from '../../api/types';
import { BASIS_LABEL, formatAmount, formatPlain, pick, type CapacityUnit } from '../../lib/figures';

/**
 * The two total cards (P19-T04, the client's "TOTAL DESIGN CAPACITY — YTD 2026:
 * 114 Wks ≈ 572 Man-Days"). Headline in the selected unit, the other unit as
 * the "≈" line. Every figure is a served `capacity-summary` total; "—" while
 * missing (older API or still loading).
 */
export function CapacityTotalCards({
  summary,
  basis,
  unit,
}: {
  summary: CapacitySummary | undefined;
  basis: CapacityBasis;
  unit: CapacityUnit;
}): React.JSX.Element {
  const design = summary?.design.total;
  const lab = summary?.lab.total;
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="capacity-totals">
      <TotalCard
        tone="primary"
        icon={<HardHat className="size-5" />}
        title={`Total design capacity — ${BASIS_LABEL[basis]}`}
        weeks={pick(design?.capacity_weeks, basis)}
        days={pick(design?.capacity_days, basis)}
        unit={unit}
        daysNoun="man-days"
        detail={
          design
            ? `${formatInteger(design.engineer_count)} engineers · ${formatPlain(design.fte_total)} FTE`
            : null
        }
      />
      <TotalCard
        tone="success"
        icon={<Thermometer className="size-5" />}
        title={`Total lab capacity — ${BASIS_LABEL[basis]}`}
        weeks={pick(lab?.capacity_weeks, basis)}
        days={pick(lab?.capacity_days, basis)}
        unit={unit}
        daysNoun="lab-days"
        detail={lab ? `${formatInteger(lab.chamber_count)} chambers` : null}
      />
    </div>
  );
}

function TotalCard({
  tone,
  icon,
  title,
  weeks,
  days,
  unit,
  daysNoun,
  detail,
}: {
  tone: 'primary' | 'success';
  icon: React.ReactNode;
  title: string;
  weeks: number | null;
  days: number | null;
  unit: CapacityUnit;
  daysNoun: string;
  detail: string | null;
}): React.JSX.Element {
  const headline = unit === 'weeks' ? formatAmount(weeks, 'weeks') : formatAmount(days, 'days');
  const headlineUnit = unit === 'weeks' ? 'wks' : daysNoun;
  const other = unit === 'weeks' ? `≈ ${formatAmount(days, 'days')} ${daysNoun}` : `≈ ${formatAmount(weeks, 'weeks')} weeks`;
  return (
    <section
      aria-label={title}
      className={cn(
        'flex items-start gap-3 rounded-card border border-border border-t-4 bg-surface px-4 py-3 shadow-sm',
        tone === 'primary' ? 'border-t-primary' : 'border-t-success',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-full',
          tone === 'primary' ? 'bg-primary-subtle text-primary-subtle-fg' : 'bg-success-subtle text-success-subtle-fg',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="text-2xs font-bold uppercase tracking-wide text-text-muted">{title}</h3>
        <p
          className={cn(
            'font-display text-2xl font-bold tnum',
            tone === 'primary' ? 'text-primary-subtle-fg' : 'text-success-subtle-fg',
          )}
          data-numeric=""
          data-testid="total-headline"
        >
          {headline} <span className="text-sm font-semibold">{headlineUnit}</span>
        </p>
        <p className="text-2xs text-text-muted tnum" data-numeric="">
          {other}
          {detail ? ` · ${detail}` : null}
        </p>
      </div>
    </section>
  );
}
