import * as React from 'react';
import { motion } from 'framer-motion';
import { Gauge } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { formatInteger } from '@/lib/format';
import { useCountUp } from '@/lib/use-count-up';
import { useMotionTokens } from '@/lib/motion';

import type { CompletingWithinYear } from '../api/types';
import { CardInfo } from '@/components/ui/card-info';

/**
 * Delivery-rate gauge (Bold Blocks, 2026-10-01) — the segmented half-ring from
 * the client's Boltshift reference. It shows the within-year count as a share of
 * every project the active run placed into one of its four mutually exclusive
 * buckets (within year / spillover / left out / blocked). Every input is a count
 * read straight off `GET /dashboard/completing-within-year` (Invariant I9); the
 * share is presentation of those counts, the same ratio the Pipeline donut
 * already prints beside each slice.
 */

const SEGMENTS = 18;
const R = 92;
const CX = 120;
const CY = 112;

export interface DeliveryGaugeCardProps {
  data: CompletingWithinYear;
}

export function DeliveryGaugeCard({ data }: DeliveryGaugeCardProps): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const total = data.within_year_count + data.spillover_count + data.left_out_count + data.blocked_count;
  const share = total > 0 ? data.within_year_count / total : 0;
  const pct = Math.round(share * 100);
  const lit = Math.round(share * SEGMENTS);
  const shownPct = useCountUp(pct);

  return (
    <BoltCard className="flex flex-col p-card">
      <div className="flex items-start justify-between gap-s3">
        <div className="flex items-center gap-s3">
          <span className="grid size-10 place-items-center rounded-xl bg-primary-subtle text-primary-subtle-fg">
            <Gauge className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-display text-h2 font-bold tracking-tight text-text">Delivery rate</h3>
            <p className="text-xs font-medium text-text-subtle">Within-year share of the run</p>
          </div>
        </div>
        <CardInfo label="How the delivery rate is read">
          <p>
            Within-year projects divided by every project the active schedule run placed in one of
            its four outcomes (within year, spillover, left out, blocked). The counts come straight
            from the run; nothing is re-scheduled in your browser.
          </p>
        </CardInfo>
      </div>

      <div className="relative mx-auto mt-s2 w-full max-w-[17rem]">
        <svg viewBox="0 0 240 132" className="w-full" role="img" aria-label={`${String(pct)}% delivered within the year`}>
          {Array.from({ length: SEGMENTS }, (_, i) => {
            // Spread segments across 180° → 0° (left to right along the top arc).
            const angle = 180 - (i + 0.5) * (180 / SEGMENTS);
            const rad = (angle * Math.PI) / 180;
            const x = CX + R * Math.cos(rad);
            const y = CY - R * Math.sin(rad);
            const on = i < lit;
            const fill = on
              ? `hsl(var(--color-primary) / ${String(1 - (i / SEGMENTS) * 0.45)})`
              : 'hsl(var(--color-surface-sunken))';
            return (
              <motion.rect
                key={i}
                x={x - 7}
                y={y - 15}
                width={14}
                height={30}
                rx={6}
                fill={fill}
                transform={`rotate(${String(90 - angle)} ${String(x)} ${String(y)})`}
                {...(reduced
                  ? {}
                  : {
                      initial: { opacity: 0 },
                      animate: { opacity: 1 },
                      transition: { delay: 0.15 + i * 0.035, duration: 0.25 },
                    })}
              />
            );
          })}
        </svg>
        <div className="absolute inset-x-0 bottom-0 text-center">
          <span className="block font-display text-display tabular-nums text-text" data-numeric="">
            {shownPct}%
          </span>
          <span className="text-xs font-semibold text-text-subtle">delivered by W52</span>
        </div>
      </div>

      <div className="mt-s4 grid grid-cols-2 gap-s3">
        <MiniTile label="Within year" value={data.within_year_count} accent />
        <MiniTile label="In the run" value={total} />
      </div>
    </BoltCard>
  );
}

function MiniTile({ label, value, accent = false }: { label: string; value: number; accent?: boolean }): React.JSX.Element {
  return (
    <div className="rounded-2xl border-[1.5px] border-dash-hairline bg-dash-alt px-s4 py-s3">
      <p className="text-xs font-semibold text-text-muted">{label}</p>
      <p className="mt-1 flex items-baseline gap-s2">
        <span className="font-display text-2xl font-extrabold tabular-nums text-text" data-numeric="">
          {formatInteger(value)}
        </span>
        {accent ? <span className="size-2 rounded-full bg-pop" aria-hidden="true" /> : null}
      </p>
    </div>
  );
}
