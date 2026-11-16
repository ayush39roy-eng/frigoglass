import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { CompletingWithinYear } from '../api/types';
import { DeliveryGaugeCard } from './delivery-gauge-card';
import { servedCompleting } from '@/surfaces/dashboard/test-fixtures';

function payload(overrides: Partial<CompletingWithinYear> = {}): CompletingWithinYear {
  return servedCompleting({
    has_active_schedule_run: true,
    schedule_run_version: 4,
    within_year_count: 9,
    spillover_count: 4,
    left_out_count: 2,
    blocked_count: 1,
    priority_delivery: [],
    regions: [
      { region: 'Greece', within_year_count: 6, spillover_count: 2, left_out_count: 1, blocked_count: 1 , queued_count: 0, not_scheduled_priority_count: 0},
      { region: 'India', within_year_count: 3, spillover_count: 2, left_out_count: 1, blocked_count: 0 , queued_count: 0, not_scheduled_priority_count: 0},
      { region: 'Romania', within_year_count: 0, spillover_count: 0, left_out_count: 0, blocked_count: 0 , queued_count: 0, not_scheduled_priority_count: 0},
    ],
    rows: [],
    ...overrides,
  });
}

describe('DeliveryGaugeCard', () => {
  it('reads all four outcome counts off the endpoint payload, never re-deriving them', () => {
    renderWithProviders(<DeliveryGaugeCard data={payload()} />);

    // 9 within year; 16 counted this year (the served counting_outcome_count, P42).
    expect(screen.getByText('Within year')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('Counted this year')).toBeInTheDocument();
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

  describe('per-country breakdown (owner ask 2026-11-16)', () => {
    it('lists Greece, India and Romania in served order with the same share formula per country', () => {
      renderWithProviders(<DeliveryGaugeCard data={payload()} />);
      const list = screen.getByRole('list', { name: 'Delivery rate by country' });
      const items = within(list).getAllByRole('listitem');
      expect(items.map((li) => li.getAttribute('data-testid'))).toEqual([
        'delivery-region-Greece',
        'delivery-region-India',
        'delivery-region-Romania',
      ]);
      // Greece 6 of 6+2+1+1 = 10 → 60%; India 3 of 6 → 50%. Whole numbers.
      expect(within(items[0]!).getByText('60%')).toBeInTheDocument();
      expect(within(items[0]!).getByText('6 / 10')).toBeInTheDocument();
      expect(within(items[1]!).getByText('50%')).toBeInTheDocument();
      expect(within(items[1]!).getByText('3 / 6')).toBeInTheDocument();
      expect(screen.getByText('India: 50% delivered, 3 of 6 within the year')).toBeInTheDocument();
      // The overall gauge is unchanged.
      expect(screen.getByRole('img', { name: '56% delivered within the year' })).toBeInTheDocument();
    });

    it('shows "—", never 0%, for a country with no project in the run', () => {
      renderWithProviders(<DeliveryGaugeCard data={payload()} />);
      const romania = screen.getByTestId('delivery-region-Romania');
      expect(within(romania).getAllByText('—')).toHaveLength(2);
      expect(within(romania).queryByText('0%')).not.toBeInTheDocument();
      expect(within(romania).getByText('Romania: no projects in the run')).toBeInTheDocument();
    });

    it('keeps all three rows under a one-country filter, the others at "—" (region-chip behaviour)', () => {
      renderWithProviders(
        <DeliveryGaugeCard
          data={payload({
            within_year_count: 3,
            spillover_count: 2,
            left_out_count: 1,
            blocked_count: 0,
            regions: [
              { region: 'Greece', within_year_count: 0, spillover_count: 0, left_out_count: 0, blocked_count: 0 , queued_count: 0, not_scheduled_priority_count: 0},
              { region: 'India', within_year_count: 3, spillover_count: 2, left_out_count: 1, blocked_count: 0 , queued_count: 0, not_scheduled_priority_count: 0},
              { region: 'Romania', within_year_count: 0, spillover_count: 0, left_out_count: 0, blocked_count: 0 , queued_count: 0, not_scheduled_priority_count: 0},
            ],
          })}
        />,
      );
      expect(within(screen.getByTestId('delivery-region-India')).getByText('50%')).toBeInTheDocument();
      expect(within(screen.getByTestId('delivery-region-Greece')).getAllByText('—')).toHaveLength(2);
      expect(within(screen.getByTestId('delivery-region-Romania')).getAllByText('—')).toHaveLength(2);
    });

    it('says OEM projects are counted under Greece, on the Greece row and in a note', () => {
      renderWithProviders(<DeliveryGaugeCard data={payload()} />);
      expect(within(screen.getByTestId('delivery-region-Greece')).getByText('incl. OEM')).toBeInTheDocument();
      expect(screen.getByText('Greece (including OEM): 60% delivered, 6 of 10 within the year')).toBeInTheDocument();
      expect(screen.getByTestId('delivery-oem-note')).toHaveTextContent('OEM projects are counted under Greece.');
      expect(within(screen.getByTestId('delivery-region-India')).queryByText('incl. OEM')).not.toBeInTheDocument();
    });

    it('renders on the compact (Executive) variant too', () => {
      renderWithProviders(<DeliveryGaugeCard data={payload()} compact />);
      const gauge = screen.getByTestId('exec-delivery-gauge');
      expect(within(gauge).getByRole('list', { name: 'Delivery rate by country' })).toBeInTheDocument();
      expect(within(gauge).getByTestId('delivery-oem-note')).toBeInTheDocument();
    });

    it('still renders the overall gauge when a backend predates the regions field', () => {
      const legacy = payload() as Partial<CompletingWithinYear>;
      delete legacy.regions;
      renderWithProviders(<DeliveryGaugeCard data={legacy as CompletingWithinYear} />);
      expect(screen.getByRole('img', { name: '56% delivered within the year' })).toBeInTheDocument();
      expect(screen.queryByTestId('delivery-region-breakdown')).not.toBeInTheDocument();
    });

    it('is axe-clean with the breakdown, in both variants', async () => {
      const full = renderWithProviders(<DeliveryGaugeCard data={payload()} />);
      expect(await seriousAxeViolations(full.container)).toEqual([]);
      full.unmount();
      const compact = renderWithProviders(<DeliveryGaugeCard data={payload()} compact />);
      expect(await seriousAxeViolations(compact.container)).toEqual([]);
    });
  });
});
