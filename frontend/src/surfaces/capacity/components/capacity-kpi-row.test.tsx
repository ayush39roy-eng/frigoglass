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
  design_load_remaining_weeks: 64,
  design_load_booked_weeks: 88,
  design_booked_pct_year: 192.98,
  design_booking_status_year: 'full',
  design_load_by_priority: { P1: 54, P2: 56, P3: 0, P4: 0, Queue: 0 },
});

describe('CapacityKpiRow (P19-T01)', () => {
  it('renders the four client cards with served totals, a per-hub line, the P1/P2/P3 split and booked %', () => {
    renderWithProviders(<CapacityKpiRow totals={totals} rows={rows} view={{ horizon: 'year', unit: 'weeks' }} />);
    expect(screen.getByTestId('kpi-design-capacity-value')).toHaveTextContent('57');
    expect(screen.getByTestId('kpi-design-load-value')).toHaveTextContent('110');
    const cap = screen.getByRole('group', { name: 'Design capacity' });
    expect(within(cap).getByLabelText('Design capacity by hub')).toHaveTextContent('PD-India: 40 · R&D-Greece: 17');
    const load = screen.getByRole('group', { name: 'Design demand' });
    expect(within(load).getByTestId('kpi-design-load-qualifier')).toHaveTextContent('full year');
    expect(within(load).getByTestId('kpi-Design demand-P1')).toHaveTextContent('54');
    expect(within(load).getByTestId('kpi-Design demand-P2')).toHaveTextContent('56');
    // P30: the run-booked weeks, served, no %
    expect(within(load).getByTestId('kpi-Design demand-in-plan')).toHaveTextContent('Booked in plan: 88 wks');
    expect(screen.getByTestId('kpi-design-load-booked')).toHaveTextContent('192.98 %');
    expect(screen.getByTestId('kpi-design-load-booked')).toHaveTextContent('Full');
    // lab cards are per lab region
    expect(screen.getByLabelText('Lab capacity by lab region')).toHaveTextContent('India: 186.22 · Greece: 25');
    expect(screen.getByTestId('kpi-lab-load-booked')).toHaveTextContent('266.62 %');
  });

  it('switches to the served remaining-year fields: remaining demand, no full-year split (P30)', () => {
    renderWithProviders(<CapacityKpiRow totals={totals} rows={rows} view={{ horizon: 'remaining', unit: 'weeks' }} />);
    expect(screen.getByTestId('kpi-design-capacity-value')).toHaveTextContent('31.5');
    expect(screen.getByLabelText('Design capacity by hub')).toHaveTextContent('PD-India: 22');
    expect(screen.getByTestId('kpi-design-load-value')).toHaveTextContent('64');
    expect(screen.getByTestId('kpi-design-load-qualifier')).toHaveTextContent('remaining');
    expect(screen.getByLabelText('Design demand by hub')).toHaveTextContent('PD-India: 436');
    expect(screen.queryByTestId('kpi-Design demand-P1')).not.toBeInTheDocument();
    expect(screen.getByTestId('kpi-Design demand-in-plan')).toHaveTextContent('88 wks');
  });

  it('P19-T05: Days shows the served day totals and per-hub / per-region day figures; splits labelled wks; booked % unchanged', () => {
    renderWithProviders(<CapacityKpiRow totals={totals} rows={rows} view={{ horizon: 'year', unit: 'days' }} />);
    expect(screen.getByTestId('kpi-design-capacity-value')).toHaveTextContent('1,515.72');
    expect(screen.getByTestId('kpi-design-load-value')).toHaveTextContent('3,522');
    expect(screen.getByTestId('kpi-lab-capacity-value')).toHaveTextContent('1,117.32');
    expect(screen.getByTestId('kpi-lab-load-value')).toHaveTextContent('2,979');
    expect(screen.getByRole('group', { name: 'Design capacity' })).toHaveTextContent('days');
    expect(screen.getByRole('group', { name: 'Design capacity' })).not.toHaveTextContent('wks');
    expect(screen.getByLabelText('Design capacity by hub')).toHaveTextContent('PD-India: 1,515.72');
    expect(screen.getByLabelText('Lab demand by lab region')).toHaveTextContent('India: 2,979');
    // the per-priority split is served in weeks only and says so
    expect(screen.getByTestId('kpi-Design demand-P1')).toHaveTextContent('54');
    expect(screen.getByTestId('kpi-Design demand-split-unit')).toHaveTextContent('(wks)');
    expect(screen.getByTestId('kpi-design-load-booked')).toHaveTextContent('192.98 %');
  });

  it('P19-T05: Days + YTD shows the served remaining day capacity', () => {
    renderWithProviders(<CapacityKpiRow totals={totals} rows={rows} view={{ horizon: 'remaining', unit: 'days' }} />);
    expect(screen.getByTestId('kpi-design-capacity-value')).toHaveTextContent('1,078.5');
    expect(screen.getByTestId('kpi-lab-capacity-value')).toHaveTextContent('795');
    // P30: the remaining day demand (served: remaining demand × weekdays)
    expect(screen.getByTestId('kpi-design-load-value')).toHaveTextContent('2,616');
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<CapacityKpiRow totals={totals} rows={rows} view={{ horizon: 'year', unit: 'weeks' }} />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
