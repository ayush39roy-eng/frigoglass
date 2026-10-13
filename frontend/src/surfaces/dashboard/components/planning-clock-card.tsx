import * as React from 'react';
import { motion } from 'framer-motion';
import { CalendarClock } from 'lucide-react';

import { CURRENT_WEEK, DISPLAY_HORIZON_WEEKS, SPILLOVER_YEAR, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatWeek } from '@/lib/format';
import { useMotionTokens } from '@/lib/motion';

/**
 * Planning clock (Bold Blocks, 2026-10-01) — the dark INK feature card. Shows
 * where the planning week sits in the 52-week plan year (ADR 0024: the UI
 * presents W1–W52 only; work past W52 is spillover into the next year). Every
 * number is a DOMAIN_RULES constant
 * (`lib/domain-constants.ts`), never the wall clock.
 */
export function PlanningClockCard(): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const remaining = Math.max(0, WITHIN_YEAR_WEEK - CURRENT_WEEK);
  const yearPct = Math.min(100, (CURRENT_WEEK / WITHIN_YEAR_WEEK) * 100);
  const nowPct = Math.min(100, (CURRENT_WEEK / DISPLAY_HORIZON_WEEKS) * 100);

  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-dash border-[1.5px] border-transparent p-card text-ink-fg shadow-ink"
      style={{ backgroundImage: 'var(--gradient-ink)' }}
      role="group"
      aria-label="Planning clock"
    >
      <span
        aria-hidden="true"
        className="bg-dots pointer-events-none absolute inset-0 text-white/[0.07] [mask-image:linear-gradient(to_bottom_left,black,transparent_70%)]"
      />
      <div className="relative flex items-center justify-between">
        <span className="grid size-10 place-items-center rounded-xl bg-ink-fg/10 ring-1 ring-ink-fg/20">
          <CalendarClock className="size-5" aria-hidden="true" />
        </span>
        <span className="rounded-pill bg-pop px-2.5 py-1 text-2xs font-bold text-pop-fg" data-numeric="">
          {remaining} wks left
        </span>
      </div>

      <p className="relative mt-s4 text-sm font-semibold text-ink-fg/70">Planning week</p>
      <p className="relative font-display text-display tabular-nums" data-numeric="">
        {formatWeek(CURRENT_WEEK)}
        <span className="ml-s2 text-lg font-bold text-ink-fg/50">/ {formatWeek(WITHIN_YEAR_WEEK)}</span>
      </p>

      {/* Year progress — W1 → W52 */}
      <div className="relative mt-s4 h-3 overflow-hidden rounded-full bg-ink-fg/15">
        <motion.span
          className="bg-hatch absolute inset-y-0 left-0 origin-left rounded-full bg-primary"
          style={{ width: `${String(yearPct)}%` }}
          {...(reduced
            ? {}
            : { initial: { scaleX: 0 }, animate: { scaleX: 1 }, transition: { duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.2 } })}
        />
      </div>
      <p className="relative mt-s2 text-xs font-medium text-ink-fg/70">
        {Math.round(yearPct)}% of the planning year elapsed
      </p>

      {/* Year strip — where "now" falls in the 52-week plan year; the year ends at
          the W52 cut-off and anything later is spillover. */}
      <div className="relative mt-s4 border-t-[1.5px] border-ink-fg/15 pt-s3">
        <div className="relative h-1.5 rounded-full bg-ink-fg/15">
          <span className="absolute inset-y-0 left-0 rounded-full bg-ink-fg/40" style={{ width: `${String(nowPct)}%` }} />
          <span
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-pop ring-2 ring-ink"
            style={{ left: `${String(nowPct)}%` }}
            aria-hidden="true"
          />
        </div>
        <div className="mt-s2 flex justify-between text-2xs font-semibold text-ink-fg/60" data-numeric="">
          <span>W1</span>
          <span>Cut-off {formatWeek(WITHIN_YEAR_WEEK)}</span>
          <span>Spillover → {SPILLOVER_YEAR}</span>
        </div>
      </div>
    </div>
  );
}
