import * as React from 'react';
import { Check, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';
import type { CurrencyRate } from '@/lib/api/reference';
import { formatDecimal } from '@/lib/format';
import type { CurrencyCode } from '@/types/enums';

import { useUpdateCurrencyRate } from '../hooks/use-matrix';

/**
 * P13-T14 (API_CONTRACT_P13 §7; mock-up "1 EUR = [x]"): the editable FX rate
 * for the selected currency. Saving PUTs the new `rate_to_eur`; the Matrix
 * then re-reads its rows, converted server-side with the new rate. The rate is
 * never applied in the browser, and no value is logged.
 */
export function FxRateEditor({
  currency,
  rates,
}: {
  currency: Exclude<CurrencyCode, 'EUR'>;
  rates: CurrencyRate[] | undefined;
}): React.JSX.Element {
  const current = rates?.find((r) => r.currency_code === currency);
  // Remount (fresh draft) whenever the currency or the served rate changes.
  return (
    <FxRateForm
      key={`${currency}:${current ? String(current.rate_to_eur) : 'none'}`}
      currency={currency}
      current={current}
    />
  );
}

function FxRateForm({
  currency,
  current,
}: {
  currency: Exclude<CurrencyCode, 'EUR'>;
  current: CurrencyRate | undefined;
}): React.JSX.Element {
  const id = React.useId();
  const [draft, setDraft] = React.useState<string>(current ? String(current.rate_to_eur) : '');
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const mutation = useUpdateCurrencyRate();

  const parsed = Number(draft);
  const valid = draft.trim() !== '' && Number.isFinite(parsed) && parsed > 0;
  const changed = current !== undefined && valid && parsed !== current.rate_to_eur;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!changed) return;
    setError(null);
    setSaved(false);
    try {
      await mutation.mutateAsync({ code: currency, rateToEur: parsed });
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.isForbidden
          ? 'Only an Admin can change exchange rates.'
          : 'The rate could not be saved. Please try again.',
      );
    }
  }

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => void handleSubmit(e)}
      aria-label={`Exchange rate for ${currency}`}
      data-testid="fx-rate-editor"
    >
      <label htmlFor={id} className="text-2xs font-medium text-text-muted">
        Exchange rate (Admin)
      </label>
      <div className="flex items-center gap-1.5 text-xs text-text">
        <span className="tnum whitespace-nowrap">1 EUR =</span>
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={draft}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            setSaved(false);
          }}
          aria-invalid={draft.trim() !== '' && !valid}
          aria-describedby={`${id}-hint`}
          className="tnum h-8 w-24 text-xs"
          disabled={current === undefined}
        />
        <span>{currency}</span>
        <Button type="submit" size="sm" variant="secondary" disabled={!changed || mutation.isPending}>
          {mutation.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
          Save rate
        </Button>
      </div>
      <span id={`${id}-hint`} className="text-2xs text-text-subtle" role={error ? 'alert' : 'status'}>
        {error ??
          (saved
            ? 'Rate saved — figures re-read from the server.'
            : current
              ? `Active: ${formatDecimal(current.rate_to_eur)} ${currency}. Converted server-side.`
              : 'Active rate unavailable.')}
      </span>
    </form>
  );
}
