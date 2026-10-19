import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { PriorityLoadChart } from './priority-load-chart';

const bars = [
  { key: 'PD-India', label: 'PD-India', split: { P1: 707, P2: 9, P3: 0, P4: 0, Queue: 0 }, load: 716, capacity: 90 },
  { key: 'R&D-Greece', label: 'R&D-Greece', split: { P1: 43, P2: 0, P3: 0, P4: 0, Queue: 0 }, load: 43, capacity: 55 },
];

describe('PriorityLoadChart (P13-T11)', () => {
  it('draws only non-zero served segments and exposes every served figure as a table', () => {
    renderWithProviders(
      <PriorityLoadChart bars={bars} ariaLabel="Design load by priority" unit="engineer-weeks" capacityLabel="Yearly capacity" />,
    );
    const india = screen.getByTestId('load-bar-PD-India');
    expect(india).toHaveTextContent('716');
    expect(within(india).getByTitle('P1 707')).toBeInTheDocument();
    expect(within(india).getByTitle('P2 9')).toBeInTheDocument();
    expect(within(india).queryByTitle('P3 0')).not.toBeInTheDocument();
    expect(within(india).getByTitle('Yearly capacity 90')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Design load by priority' });
    const row = within(table).getByRole('row', { name: /PD-India/ });
    expect(row).toHaveTextContent('707');
    expect(row).toHaveTextContent('716');
    expect(row).toHaveTextContent('90');
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(
      <PriorityLoadChart bars={bars} ariaLabel="Design load by priority" unit="engineer-weeks" capacityLabel="Yearly capacity" />,
    );
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
