import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { CurrencyRate } from '@/lib/api/reference';

import { CurrencyToggle } from './currency-toggle';

const rates: CurrencyRate[] = [
  { id: 'r1', currency_code: 'EUR', rate_to_eur: 1, updated_by_user_id: null, updated_at: '2026-01-01T00:00:00Z' },
  { id: 'r2', currency_code: 'USD', rate_to_eur: 1.08, updated_by_user_id: null, updated_at: '2026-01-01T00:00:00Z' },
  { id: 'r3', currency_code: 'INR', rate_to_eur: 97, updated_by_user_id: null, updated_at: '2026-01-01T00:00:00Z' },
];

describe('CurrencyToggle', () => {
  it('renders all three currencies and reports the picked one via onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CurrencyToggle value="EUR" onChange={onChange} rates={rates} />);

    expect(screen.getByRole('radio', { name: 'EUR' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'USD' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'INR' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'USD' }));
    expect(onChange).toHaveBeenCalledWith('USD');
  });

  it('shows the active rate verbatim from GET /currency-rates (no client-side math)', () => {
    render(<CurrencyToggle value="USD" onChange={vi.fn()} rates={rates} />);
    // "1.08" is exactly `rates[USD].rate_to_eur` — the component never multiplies by it.
    expect(screen.getByTestId('currency-rate-caption')).toHaveTextContent('1 EUR = 1.08 USD');
  });

  it('labels EUR as the base currency', () => {
    render(<CurrencyToggle value="EUR" onChange={vi.fn()} rates={rates} />);
    expect(screen.getByTestId('currency-rate-caption')).toHaveTextContent('Base currency');
  });

  it('degrades gracefully when rates are not loaded', () => {
    render(<CurrencyToggle value="INR" onChange={vi.fn()} />);
    expect(screen.getByTestId('currency-rate-caption')).toHaveTextContent(/unavailable/i);
  });
});
