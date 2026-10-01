import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import type { CompletingWithinYear } from '../api/types';
import { DeliveryGaugeCard } from './delivery-gauge-card';

function payload(overrides: Partial<CompletingWithinYear> = {}): CompletingWithinYear {
  return {
    has_active_schedule_run: true,
    schedule_run_version: 4,
    within_year_count: 9,
    spillover_count: 4,
    left_out_count: 2,
    blocked_count: 1,
    rows: [],
    ...overrides,
  };
}

describe('DeliveryGaugeCard', () => {
  it('reads all four outcome counts off the endpoint payload, never re-deriving them', () => {
    renderWithProviders(<DeliveryGaugeCard data={payload()} />);

    // 9 within year of 9 + 4 + 2 + 1 = 16 in the run.
    expect(screen.getByText('Within year')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('In the run')).toBeInTheDocument();
    expect(screen.getByText('16')).toBeInTheDocument();
  });

  it('states the share as an accessible label on the gauge, not just as colour', () => {
    renderWithProviders(<DeliveryGaugeCard data={payload()} />);
    // 9 / 16 = 56.25% → 56%.
    expect(screen.getByRole('img', { name: '56% delivered within the year' })).toBeInTheDocument();
    expect(screen.getByText('56%')).toBeInTheDocument();
    expect(screen.getByText('delivered by W52')).toBeInTheDocument();
  });

  it('counts a blocked project in the denominator — the four buckets are exclusive', () => {
    // P9-F02 made `blocked` win outright over the other three flags, so all four
    // counts sum to the run's project total with no double-counting.
    renderWithProviders(
      <DeliveryGaugeCard
        data={payload({ within_year_count: 1, spillover_count: 0, left_out_count: 0, blocked_count: 1 })}
      />,
    );
    expect(screen.getByRole('img', { name: '50% delivered within the year' })).toBeInTheDocument();
  });

  it('shows 0%, not NaN, when the run placed no projects at all', () => {
    renderWithProviders(
      <DeliveryGaugeCard
        data={payload({ within_year_count: 0, spillover_count: 0, left_out_count: 0, blocked_count: 0 })}
      />,
    );
    expect(screen.getByRole('img', { name: '0% delivered within the year' })).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('exposes the ratio definition behind a named, keyboard-reachable affordance', () => {
    renderWithProviders(<DeliveryGaugeCard data={payload()} />);
    expect(
      screen.getByRole('button', { name: 'How the delivery rate is read' }),
    ).toBeInTheDocument();
    // Closed by default — the prose is not shouted as body copy (client text cleanup).
    expect(screen.queryByText(/nothing is re-scheduled in your browser/i)).not.toBeInTheDocument();
  });

  it('shows no engineer, owner or avatar anywhere (OPEN_QUESTIONS #8)', () => {
    renderWithProviders(<DeliveryGaugeCard data={payload()} />);
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});
