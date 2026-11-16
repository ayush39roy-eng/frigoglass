import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { useHubFilterStore } from '@/stores/hub-filter';
import type { ClassBreakdown, HubCapacitySummary } from './api/types';
import { classRow, greeceRow, SUMMARY_P11, totalsRow, PRIORITY_BUCKET_LABELS } from './test-fixtures';

/**
 * P29-T03 (ADR 0042, API_CONTRACT_P29 §2.3): the OEM hub-filter behaviour on
 * the Capacity page. The SERVER resolves a member hub to the Greece row; the
 * page sends the selected `hub_id` unchanged, renders what is served (never
 * hides the Greece row because its `hub` differs from the selected hub) and
 * highlights the served `selected_member`. Plus the engineer heatmap's
 * "Not in capacity roster" marker.
 */
const hooks = {
  useHubLoadVsCapacity: vi.fn(),
  useClassBreakdown: vi.fn(),
  useActiveScheduleRun: vi.fn(),
  useEngineerUtilization: vi.fn(),
};

vi.mock('./hooks/use-capacity', () => ({
  useHubLoadVsCapacity: (...a: unknown[]) => hooks.useHubLoadVsCapacity(...a),
  useClassBreakdown: (...a: unknown[]) => hooks.useClassBreakdown(...a),
  useActiveScheduleRun: () => hooks.useActiveScheduleRun(),
  useEngineerUtilization: () => hooks.useEngineerUtilization(),
}));

import CapacityPage from './CapacityPage';

function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}

const classBreakdown: ClassBreakdown = {
  has_active_schedule_run: true,
  priority_bucket_labels: PRIORITY_BUCKET_LABELS,
  schedule_run_version: 9,
  rows: [classRow({ category: 'B-OEM', deliverable_count: 4, left_out_count: 1, total_count: 5 })],
};

/** The response to `hub_id = OEM-HCK`: the Greece row only, figures unchanged. */
const oemFiltered: HubCapacitySummary = {
  has_active_schedule_run: true,
  schedule_run_version: 9,
  ...SUMMARY_P11,
  totals: totalsRow({ hubs: ['R&D-Greece'], lab_regions: ['Greece'], design_load_weeks: 131 }),
  remaining_weeks: 10,
  rows: [greeceRow({ selected_member: 'OEM-HCK' })],
};

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.getState().setSelection([], []);
  hooks.useActiveScheduleRun.mockReturnValue(ready(null));
  hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
});

describe('CapacityPage — OEM hub filter (P29, ADR 0042 §4)', () => {
  it('sends the OEM hub id as is and shows the served Greece row with OEM-HCK highlighted', () => {
    useHubFilterStore.getState().setSelection(['hub-oem-hck'], []);
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(oemFiltered));
    hooks.useEngineerUtilization.mockReturnValue(ready({ week_range: [1, 1], current_week: 1, engineers: [] }));
    renderWithProviders(<CapacityPage />);
    expect(hooks.useHubLoadVsCapacity).toHaveBeenLastCalledWith({ hub: { hubIds: ['hub-oem-hck'], regions: [] } });
    // Table: the Greece row, its breakdown open, OEM-HCK highlighted.
    const greece = screen.getByTestId('hub-summary-row-R&D-Greece');
    expect(within(greece).getByTestId('design-load')).toHaveTextContent('131');
    expect(screen.getByTestId('hub-summary-member-OEM-HCK')).toHaveAttribute('data-selected', 'true');
    // Booked tile: Greece's served booked %, naming the filtered member.
    expect(within(screen.getByTestId('booked-design-R&D-Greece')).getByText('105%')).toBeInTheDocument();
    expect(screen.getByTestId('booked-selected-R&D-Greece')).toHaveTextContent('Filtered on OEM-HCK');
  });

  it('an out-of-scope hub id is served as no rows: the page shows the empty state, nothing widened', () => {
    useHubFilterStore.getState().setSelection(['hub-out-of-scope'], []);
    hooks.useHubLoadVsCapacity.mockReturnValue(ready({ ...oemFiltered, rows: [] }));
    hooks.useEngineerUtilization.mockReturnValue(ready({ week_range: [1, 1], current_week: 1, engineers: [] }));
    renderWithProviders(<CapacityPage />);
    expect(screen.getByText('No hubs in scope')).toBeInTheDocument();
    expect(screen.queryByTestId('hub-booking-strip')).toBeNull();
  });
});

// Owner ask 2026-11-13: the engineer utilization section is removed from the
// Capacity page, so the roster-marker test that went through it is gone. The
// heatmap component is no longer rendered anywhere (its own tests remain).
