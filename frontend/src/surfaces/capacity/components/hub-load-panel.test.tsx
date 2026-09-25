import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import type { HubCapacitySummary } from '../api/types';
import { HubLoadPanel } from './hub-load-panel';

vi.mock('./hub-load-chart', () => ({ HubLoadChart: () => <div data-testid="hub-load-chart" /> }));

function rowFor(hub: string): HTMLElement {
  const cell = screen.getByRole('cell', { name: hub });
  const tr = cell.closest('tr');
  if (!tr) throw new Error(`no row for ${hub}`);
  return tr;
}

const withRun: HubCapacitySummary = {
  has_active_schedule_run: true,
  schedule_run_version: 8,
  remaining_weeks: 47,
  rows: [
    {
      hub: 'R&D-Greece',
      design_load_weeks: 200,
      design_capacity_weeks: 94.5,
      lab_load_units: 12.5,
      lab_capacity_units: 47,
    },
    {
      hub: 'PD-India',
      design_load_weeks: 50,
      design_capacity_weeks: 189,
      lab_load_units: 8,
      lab_capacity_units: 40,
    },
  ],
};

describe('HubLoadPanel', () => {
  it('renders the I6/I7 load figures and the reporting-capacity figures verbatim', () => {
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    const greece = rowFor('R&D-Greece');
    expect(within(greece).getByText('200')).toBeInTheDocument();
    expect(within(greece).getByText('94.5')).toBeInTheDocument();
    expect(within(greece).getByText('12.5')).toBeInTheDocument();
    expect(within(greece).getByText('47')).toBeInTheDocument();
  });

  it('flags a hub whose scheduled load exceeds the reporting-capacity estimate (icon + text, not colour alone)', () => {
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    const greece = rowFor('R&D-Greece');
    // design: load 200 > capacity 94.5
    expect(within(greece).getAllByText(/Load > reporting capacity/i).length).toBeGreaterThan(0);
    const india = rowFor('PD-India');
    expect(within(india).getAllByText(/Within reporting capacity/i).length).toBe(2);
  });

  it('names the active schedule run the load numbers come from', () => {
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    expect(screen.getByTestId('schedule-run-provenance')).toHaveTextContent(/active schedule run\s+v8/i);
  });

  it('shows a non-error empty state when no schedule run is active', () => {
    renderWithProviders(
      <HubLoadPanel
        data={{
          has_active_schedule_run: false,
          schedule_run_version: null,
          remaining_weeks: 47,
          rows: [],
        }}
        activeRun={null}
      />,
    );
    expect(screen.getByText('No schedule computed yet')).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-run-provenance')).not.toBeInTheDocument();
  });
});
