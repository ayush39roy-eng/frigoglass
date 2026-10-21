import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { hubRow, totalsRow } from '../test-fixtures';
import { CapacityKpiRow } from './capacity-kpi-row';

const rows = [
  hubRow({ hub: 'PD-India', design_capacity_year: 40, design_capacity_remaining: 22, design_load_weeks: 103 }),
  hubRow({ hub: 'R&D-Greece', lab_region: 'Greece', design_capacity_year: 17, lab_capacity_year: 25, lab_load_weeks: 7 }),
];
const totals = totalsRow({
  hubs: ['PD-India', 'R&D-Greece'],
  design_capacity_year: 57,
  design_capacity_remaining: 31.5,
  design_load_weeks: 110,
  design_booked_pct_year: 192.98,
  design_booking_status_year: 'full',
  design_load_by_priority: { P1: 54, P2: 56, P3: 0, P4: 0, Queue: 0 },
});

describe('CapacityKpiRow (P19-T01)', () => {
  it('renders the four client cards with served totals, a per-hub line, the P1/P2/P3 split and booked %', () => {
    renderWithProviders(<CapacityKpiRow totals={totals} rows={rows} horizon="year" />);
    expect(screen.getByTestId('kpi-design-capacity-value')).toHaveTextContent('57');
    expect(screen.getByTestId('kpi-design-load-value')).toHaveTextContent('110');
    const cap = screen.getByRole('group', { name: 'Design capacity' });
    expect(within(cap).getByLabelText('Design capacity by hub')).toHaveTextContent('PD-India: 40 · R&D-Greece: 17');
    const load = screen.getByRole('group', { name: 'Design load' });
    expect(within(load).getByTestId('kpi-Design load-P1')).toHaveTextContent('54');
    expect(within(load).getByTestId('kpi-Design load-P2')).toHaveTextContent('56');
    expect(screen.getByTestId('kpi-design-load-booked')).toHaveTextContent('192.98 %');
    expect(screen.getByTestId('kpi-design-load-booked')).toHaveTextContent('Full');
    // lab cards are per lab region
    expect(screen.getByLabelText('Lab capacity by lab region')).toHaveTextContent('India: 186.22 · Greece: 25');
    expect(screen.getByTestId('kpi-lab-load-booked')).toHaveTextContent('266.62 %');
  });

  it('switches to the served remaining-year fields', () => {
    renderWithProviders(<CapacityKpiRow totals={totals} rows={rows} horizon="remaining" />);
    expect(screen.getByTestId('kpi-design-capacity-value')).toHaveTextContent('31.5');
    expect(screen.getByLabelText('Design capacity by hub')).toHaveTextContent('PD-India: 22');
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<CapacityKpiRow totals={totals} rows={rows} horizon="year" />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
