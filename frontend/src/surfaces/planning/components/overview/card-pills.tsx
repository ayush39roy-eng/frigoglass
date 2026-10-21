import * as React from 'react';

import { formatAmount } from '../../lib/figures';

/** The "<weeks> wks" and "<days> days" pills of a hub / lab-region card header.
 *  Both are served fields of the selected basis; "—" when not served. */
export function CardPills({ weeks, days, label }: { weeks: number | null; days: number | null; label: string }): React.JSX.Element {
  return (
    <ul className="flex items-center gap-1" aria-label={label}>
      <li className="whitespace-nowrap rounded-pill border border-border bg-surface px-2 py-0.5 font-mono text-2xs font-semibold text-text tnum" data-numeric="">
        {formatAmount(weeks, 'weeks')} wks
      </li>
      <li className="whitespace-nowrap rounded-pill border border-border bg-surface px-2 py-0.5 font-mono text-2xs font-semibold text-text tnum" data-numeric="">
        {formatAmount(days, 'days')} days
      </li>
    </ul>
  );
}
