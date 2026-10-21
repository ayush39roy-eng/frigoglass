import * as React from 'react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';

import {
  CURRENCY_NAMES,
  MATRIX_CURRENCY_CODES,
  type CurrencyOption,
  type MatrixCurrencyCode,
} from '../api/types';

/**
 * P21 "Display currency" control for the Matrix: EUR, USD, INR, EGP, ZAR, IDR,
 * each labelled "EGP · Egyptian pound". The SERVED list decides which are
 * usable: `configured=false` keeps the option focusable but inert, with the
 * reason as a tooltip and description. Choosing a currency only changes the
 * `?currency=` query param; every converted figure is converted server-side and
 * `rate_to_eur` is shown verbatim, never applied here.
 */

export const RATE_NOT_SET_COPY = 'Rate not set — an Admin can set it';

function optionsFor(served: CurrencyOption[] | undefined): CurrencyOption[] {
  if (served && served.length > 0) return served;
  // Nothing served yet (loading or failed): EUR only is known to be usable.
  return MATRIX_CURRENCY_CODES.map((code) => ({
    currency_code: code,
    name: CURRENCY_NAMES[code],
    rate_to_eur: code === 'EUR' ? 1 : null,
    configured: code === 'EUR',
  }));
}

function rateCaption(value: MatrixCurrencyCode, option: CurrencyOption | undefined): string {
  if (value === 'EUR') return 'Base currency — 1 EUR = 1 EUR.';
  if (!option || option.rate_to_eur === null) return 'Active conversion rate unavailable.';
  return `Active rate: 1 EUR = ${formatDecimal(option.rate_to_eur)} ${value} (server-applied).`;
}

export interface MatrixCurrencyControlProps {
  value: MatrixCurrencyCode;
  onChange: (next: MatrixCurrencyCode) => void;
  currencies: CurrencyOption[] | undefined;
  /** Compact (stuck panel): codes only, no caption. Names stay in the accessible label. */
  compact?: boolean;
  className?: string;
}

export function MatrixCurrencyControl({
  value,
  onChange,
  currencies,
  compact = false,
  className,
}: MatrixCurrencyControlProps): React.JSX.Element {
  const labelId = React.useId();
  const reasonId = React.useId();
  const options = optionsFor(currencies);
  const selected = options.find((o) => o.currency_code === value);

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span id={labelId} className={cn('text-2xs font-medium text-text-muted', compact && 'sr-only')}>
        Display currency
      </span>
      <span id={reasonId} className="sr-only">
        {RATE_NOT_SET_COPY}
      </span>
      <ToggleGroup
        type="single"
        size="sm"
        value={value}
        aria-labelledby={labelId}
        // Wraps so six options fit: each item carries its own border.
        className="flex-wrap justify-start gap-1 divide-x-0 overflow-visible rounded-none border-0"
        onValueChange={(next) => {
          // Radix emits "" when the active item is re-clicked: keep a selection.
          const option = options.find((o) => o.currency_code === next);
          if (option?.configured) onChange(option.currency_code);
        }}
      >
        {options.map((o) => {
          const label = `${o.currency_code} · ${o.name}`;
          const item = (
            <ToggleGroupItem
              key={o.currency_code}
              value={o.currency_code}
              aria-label={label}
              aria-disabled={o.configured ? undefined : true}
              aria-describedby={o.configured ? undefined : reasonId}
              data-testid={`currency-option-${o.currency_code}`}
              className={cn(
                'whitespace-nowrap rounded border border-border-strong',
                !o.configured && 'cursor-not-allowed opacity-55 hover:bg-transparent',
              )}
            >
              {compact ? o.currency_code : label}
            </ToggleGroupItem>
          );
          if (o.configured) return item;
          return (
            <Tooltip key={o.currency_code}>
              <TooltipTrigger asChild>{item}</TooltipTrigger>
              <TooltipContent>{RATE_NOT_SET_COPY}</TooltipContent>
            </Tooltip>
          );
        })}
      </ToggleGroup>
      {compact ? null : (
        <span className="text-2xs text-text-subtle" data-testid="currency-rate-caption">
          {rateCaption(value, selected)}
        </span>
      )}
    </div>
  );
}
