import * as React from 'react';

import { formatInteger } from '@/lib/format';

import { drillLabel, type ProjectDrill } from '../drilldown';
import { useDrill } from '../drill-store';

/**
 * "Finishes per quarter" (P32-R07): the shared horizontal bar look (`components/ui/bar-chart`)
 * with every bar a button that lists the projects finishing in that quarter. The bar width is
 * the drawing of the served `count`; the number printed is the served `count`.
 */
export function QuarterBars({
  bars,
  ariaLabel,
}: {
  bars: readonly { key: string; label: string; drill: ProjectDrill }[];
  ariaLabel: string;
}): React.JSX.Element {
  const open = useDrill((s) => s.open);
  const axisMax = Math.max(1, ...bars.map((b) => b.drill.figure));
  return (
    <ul className="flex flex-col gap-s2" aria-label={ariaLabel} data-testid="import-quarter-bars">
      {bars.map((b, index) => (
        <li key={b.key}>
          <button
            type="button"
            className="group grid w-full cursor-pointer grid-cols-[6rem_1fr_auto] items-center gap-s3 rounded-xl px-s3 py-1.5 text-left transition-colors duration-fast hover:bg-primary-subtle/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-haspopup="dialog"
            aria-label={drillLabel(b.drill)}
            onClick={(e) => open(b.drill, e.currentTarget)}
            data-testid={`import-quarter-${b.key}`}
          >
            <span className="truncate text-body font-semibold text-text group-hover:underline">{b.label}</span>
            <span className="h-3.5 overflow-hidden rounded-pill bg-surface-sunken" aria-hidden="true">
              <span
                className="block h-full origin-left animate-grow-x rounded-pill bg-chart-1 motion-reduce:animate-none"
                style={{ width: `${String(Math.round((b.drill.figure / axisMax) * 100))}%`, animationDelay: `${String(index * 70)}ms` }}
              />
            </span>
            <span className="w-14 text-right font-display text-base font-extrabold tabular-nums text-text" data-numeric="">
              {formatInteger(b.drill.figure)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
