import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { ApiError } from '@/lib/api/client';
import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { HubCapacitySummary } from '@/surfaces/capacity/api/types';
import { areaRow, SUMMARY_P11 } from '@/surfaces/capacity/test-fixtures';

const hook = { useHubLoadVsCapacity: vi.fn() };
vi.mock('@/surfaces/capacity/hooks/use-capacity', () => ({
  useHubLoadVsCapacity: () => hook.useHubLoadVsCapacity(),
}));

import { CapacityBookedCard } from './capacity-booked-card';

function ready(data: HubCapacitySummary) {
  return { data, isPending: false, isError: false, error: null };
}

const summary: HubCapacitySummary = {
  has_active_schedule_run: true,
  schedule_run_version: 9,
  remaining_weeks: 47,
  rows: [],
  ...SUMMARY_P11,
  areas: [
    areaRow({ design_booked_pct_year: 90, design_booking_status_year: 'near_full', lab_booked_pct_year: 50, lab_booking_status_year: 'available' }),
    areaRow({
      area: 'India',
      hubs: ['R&D-India', 'PD-India'],
      lab_regions: ['India'],
      design_booked_pct_year: 131.2,
      design_booking_status_year: 'full',
      lab_booked_pct_year: null,
      lab_booking_status_year: 'full',
    }),
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('CapacityBookedCard (ADR 0016)', () => {
  it('renders "Europe — Design 90 % · Lab 50 %" with served chips, per area', () => {
    hook.useHubLoadVsCapacity.mockReturnValue(ready(summary));
    renderWithProviders(<CapacityBookedCard />);
    expect(screen.getByRole('heading', { name: 'Capacity booked' })).toBeInTheDocument();
    expect(screen.getAllByTestId('capacity-booked-area')).toHaveLength(2);
    const euDesign = screen.getByTestId('dash-booked-Europe-design');
    expect(euDesign).toHaveTextContent('90 %');
    expect(within(euDesign).getByText('Near full')).toBeInTheDocument();
    const euLab = screen.getByTestId('dash-booked-Europe-lab');
    expect(euLab).toHaveTextContent('50 %');
    expect(within(euLab).getByText('Available')).toBeInTheDocument();
  });

  it('prints over-100 % and null % as served, with the served Full chip', () => {
    hook.useHubLoadVsCapacity.mockReturnValue(ready(summary));
    renderWithProviders(<CapacityBookedCard />);
    const inDesign = screen.getByTestId('dash-booked-India-design');
    expect(inDesign).toHaveTextContent('131.2 %');
    expect(within(inDesign).getByText('Full')).toBeInTheDocument();
    const inLab = screen.getByTestId('dash-booked-India-lab');
    expect(inLab).toHaveTextContent('—');
    expect(within(inLab).getByText('Full')).toBeInTheDocument();
  });

  it('renders nothing on a read error, with no active run, or with no area in scope', () => {
    hook.useHubLoadVsCapacity.mockReturnValue({ data: undefined, isPending: false, isError: true, error: new ApiError(403, 'forbidden') });
    const { unmount } = renderWithProviders(<CapacityBookedCard />);
    expect(screen.queryByTestId('capacity-booked-card')).not.toBeInTheDocument();
    unmount();
    hook.useHubLoadVsCapacity.mockReturnValue(ready({ ...summary, has_active_schedule_run: false }));
    const second = renderWithProviders(<CapacityBookedCard />);
    expect(screen.queryByTestId('capacity-booked-card')).not.toBeInTheDocument();
    second.unmount();
    hook.useHubLoadVsCapacity.mockReturnValue(ready({ ...summary, areas: [] }));
    renderWithProviders(<CapacityBookedCard />);
    expect(screen.queryByTestId('capacity-booked-card')).not.toBeInTheDocument();
  });

  it('has no serious/critical axe violations', async () => {
    hook.useHubLoadVsCapacity.mockReturnValue(ready(summary));
    const { container } = renderWithProviders(<CapacityBookedCard />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
