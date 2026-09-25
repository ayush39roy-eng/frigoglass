import * as React from 'react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { CurrencyRate } from '@/lib/api/reference';
import { CURRENCY_CODES, type CurrencyCode } from '@/types/enums';

/**
 * Cross-surface currency selector (EUR / USD / INR), per `docs/DOMAIN_RULES.md`
 * "Currency". The Prioritization Matrix uses it now; the Gantt and Project
 * Registration reuse it later — hence `components/shared/`.
 *
 * **Zero browser-side currency math.** Changing the selection is expected to
 * re-fetch the surface's data with a `?currency=…` query param; the API returns
 * amounts already converted server-side. This is the money analogue of the
 * Invariant I9 "no client recompute" rule. The `rates` passed in here are shown
 * *verbatim* (via `GET /currency-rates`) so a converted figure on screen is
 * auditable — this component never multiplies anything by a rate.
 */

export interface CurrencyToggleProps {
  value: CurrencyCode;
  onChange: (next: CurrencyCode) => void;
  /** From `GET /currency-rates` (`useCurrencyRates`). Optional — the control
   *  still works without it; the rate caption just reads "rate unavailable". */
  rates?: CurrencyRate[] | undefined;
  disabled?: boolean;
  className?: string;
  /** Accessible label for the group. */
  label?: string;
}

function rateCaption(value: CurrencyCode, rates: CurrencyRate[] | undefined): string {
  if (value === 'EUR') return 'Base currency — 1 EUR = 1 EUR.';
  const row = rates?.find((r) => r.currency_code === value);
  if (!row) return 'Active conversion rate unavailable.';
  // Display only: `rate_to_eur` is rendered as-is, not used in any calculation.
  return `Active rate: 1 EUR = ${formatDecimal(row.rate_to_eur)} ${value} (server-applied).`;
}

export function CurrencyToggle({
  value,
  onChange,
  rates,
  disabled = false,
  className,
  label = 'Display currency',
}: CurrencyToggleProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-2xs font-medium text-text-muted">{label}</span>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          // Radix emits "" when the active item is re-clicked; ignore it so a
          // currency is always selected.
          if (next && (CURRENCY_CODES as readonly string[]).includes(next)) {
            onChange(next as CurrencyCode);
          }
        }}
        disabled={disabled}
        aria-label={label}
        size="sm"
      >
        {CURRENCY_CODES.map((code) => (
          <ToggleGroupItem key={code} value={code} aria-label={code}>
            {code}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <span className="text-2xs text-text-subtle" data-testid="currency-rate-caption">
        {rateCaption(value, rates)}
      </span>
    </div>
  );
}
