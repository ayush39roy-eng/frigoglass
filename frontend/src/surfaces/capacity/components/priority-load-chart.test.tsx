import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { PriorityLoadChart } from './priority-load-chart';

const bars = [
  { key: 'PD-India', label: 'PD-India', split: { P1: 707, P2: 9, P3: 0, P4: 0, Queue: 0 }, splitTotal: 716, load: 716, capacity: 90 },
  { key: 'R&D-Greece', label: 'R&D-Greece', split: { P1: 43, P2: 0, P3: 0, P4: 0, Queue: 0 }, splitTotal: 43, load: 43, capacity: 55 },
];

describe('PriorityLoadChart (P13-T11)', () => {
  it('draws only non-zero served segments and exposes every served figure as a table', () => {
    renderWithProviders(
      <PriorityLoadChart bars={bars} ariaLabel="Design load by priority" unit="engineer-weeks" unitShort="wks" splitUnit="wks" capacityLabel="Yearly capacity" />,
    );
    const india = screen.getByTestId('load-bar-PD-India');
    expect(india).toHaveTextContent('716');
    expect(within(india).getByTitle('P1 707 wks')).toBeInTheDocument();
    expect(within(india).getByTitle('P2 9 wks')).toBeInTheDocument();
    expect(within(india).queryByTitle('P3 0 wks')).not.toBeInTheDocument();
    expect(within(india).getByTitle('Yearly capacity 90 wks')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: /^Design load by priority/ });
    const row = within(table).getByRole('row', { name: /PD-India/ });
    expect(row).toHaveTextContent('707');
    expect(row).toHaveTextContent('716');
    expect(row).toHaveTextContent('90');
  });

  it('P19-T05: in days, value labels and the axis say "days", splits stay weeks, and an absent day figure shows "—"', () => {
    const dayBars = [
      { ...bars[0]!, load: 4296, capacity: 540 },
      { ...bars[1]!, load: null, capacity: null },
    ];
    renderWithProviders(
      <PriorityLoadChart bars={dayBars} ariaLabel="Design load by priority" unit="engineer-days" unitShort="days" splitUnit="wks" capacityLabel="Yearly capacity" />,
    );
    expect(screen.getByTestId('priority-load-chart-axis')).toHaveTextContent('engineer-days');
    expect(screen.getByTestId('load-bar-value-PD-India')).toHaveTextContent('4,296days');
    expect(within(screen.getByTestId('load-bar-PD-India')).getByTitle('Yearly capacity 540 days')).toBeInTheDocument();
    // the split is served in weeks only and says so
    expect(within(screen.getByTestId('load-bar-PD-India')).getByTitle('P1 707 wks')).toBeInTheDocument();
    expect(screen.getByTestId('load-bar-value-R&D-Greece')).toHaveTextContent('—');
    const table = screen.getByRole('table', { name: /load and capacity in engineer-days, priority split in wks/ });
    expect(within(table).getByRole('columnheader', { name: 'Load (days)' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'P1 (wks)' })).toBeInTheDocument();
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(
      <PriorityLoadChart bars={bars} ariaLabel="Design load by priority" unit="engineer-weeks" unitShort="wks" splitUnit="wks" capacityLabel="Yearly capacity" />,
    );
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
