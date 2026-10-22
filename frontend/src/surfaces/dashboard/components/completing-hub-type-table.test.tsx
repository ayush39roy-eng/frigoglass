import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { CompletingHubTypeTable } from './completing-hub-type-table';

const cells = [
  { hub: 'PD-India' as const, type: 'CO' as const, pipeline_count: 82, completing_count: 7, completing_pct: 8.54 },
  { hub: 'R&D-Greece' as const, type: 'NM' as const, pipeline_count: 5, completing_count: 1, completing_pct: 20 },
];
const byType = [
  { key: 'NM' as const, pipeline_count: 5, completing_count: 1, completing_pct: 20 },
  // Deliberately NOT the sum of the cells: the Total row must show the served figure.
  { key: 'CO' as const, pipeline_count: 89, completing_count: 10, completing_pct: 11.24 },
];

describe('CompletingHubTypeTable (P13-T10)', () => {
  it('shows each served cell and the served per-type Total row verbatim', () => {
    renderWithProviders(<CompletingHubTypeTable cells={cells} byType={byType} />);
    const table = screen.getByRole('table', { name: /completing within the year/i });
    const india = within(table).getByRole('row', { name: /PD-India/ });
    expect(india).toHaveTextContent('7 8.54%');
    // No served cell → a dash, not a computed zero.
    expect(india).toHaveTextContent('–');
    const total = within(table).getByRole('row', { name: /Total/ });
    expect(total).toHaveTextContent('1 20%');
    expect(total).toHaveTextContent('10 11.24%');
    // Without served per-hub totals there is no Total column.
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Hub', 'NM', 'CO']);
  });

  it('adds the served per-hub Total column (never a row sum) and leaves the unserved corner empty', () => {
    const byHub = [
      // Deliberately not the row's cell sum.
      { key: 'PD-India' as const, pipeline_count: 180, completing_count: 14, completing_pct: 7.78 },
    ];
    renderWithProviders(<CompletingHubTypeTable cells={cells} byType={byType} byHub={byHub} />);
    const table = screen.getByRole('table', { name: /completing within the year/i });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Hub',
      'NM',
      'CO',
      'Total',
    ]);
    expect(within(table).getByRole('row', { name: /PD-India/ })).toHaveTextContent('14 7.78%');
    // A hub the server lists no total for (pipeline 0) shows a dash.
    const greece = within(table).getByRole('row', { name: /R&D-Greece/ });
    expect(greece.lastElementChild).toHaveTextContent('–');
    expect(within(table).getByLabelText('No grand total served')).toBeInTheDocument();
  });

  it('captions that the cross-tab counts every project (its total equals the within-year KPI)', () => {
    renderWithProviders(<CompletingHubTypeTable cells={cells} byType={byType} />);
    expect(screen.getByText(/Counts every project in the pipeline/)).toBeInTheDocument();
  });

  it('shows an empty state when the server sends no cells', () => {
    renderWithProviders(<CompletingHubTypeTable cells={[]} byType={[]} />);
    expect(screen.getByText('No pipeline projects in view.')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(<CompletingHubTypeTable cells={cells} byType={byType} />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('its horizontal scroller is a keyboard-focusable named region (P13-R01)', () => {
    renderWithProviders(<CompletingHubTypeTable cells={cells} byType={byType} />);
    const region = screen.getByRole('region', { name: /Projects completing within the year, by hub and project type/ });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table'));
  });

  it('P17-R08: corner shows the served within-year count, and figures open their project list', async () => {
    const onDrill = vi.fn();
    const byHub = [{ key: 'PD-India' as const, pipeline_count: 180, completing_count: 14, completing_pct: 7.78 }];
    renderWithProviders(
      <CompletingHubTypeTable cells={cells} byType={byType} byHub={byHub} grandTotal={107} onDrill={onDrill} />,
    );
    expect(screen.queryByLabelText('No grand total served')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View 7 Cost Optimization projects in PD-India completing within the year' }));
    expect(onDrill).toHaveBeenLastCalledWith({ source: 'completing', hub: 'PD-India', typeKey: 'CO', count: 7 }, expect.any(HTMLElement));
    await userEvent.click(screen.getByRole('button', { name: 'View all 14 projects in PD-India completing within the year' }));
    expect(onDrill).toHaveBeenLastCalledWith({ source: 'completing', hub: 'PD-India', typeKey: null, count: 14 }, expect.any(HTMLElement));
    await userEvent.click(screen.getByRole('button', { name: 'View all 10 Cost Optimization projects completing within the year' }));
    await userEvent.click(screen.getByRole('button', { name: 'View all 107 projects completing within the year' }));
    expect(onDrill).toHaveBeenLastCalledWith({ source: 'completing', hub: null, typeKey: null, count: 107 }, expect.any(HTMLElement));
  });

  it('P17-R08: a zero count is not clickable', () => {
    renderWithProviders(
      <CompletingHubTypeTable
        cells={[{ hub: 'PD-India', type: 'NM', pipeline_count: 4, completing_count: 0, completing_pct: 0 }]}
        byType={[{ key: 'NM', pipeline_count: 4, completing_count: 0, completing_pct: 0 }]}
        onDrill={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('drill-cell')).not.toBeInTheDocument();
  });
});
