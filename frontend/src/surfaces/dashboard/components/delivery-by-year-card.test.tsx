import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { NO_HUB_SELECTION } from '@/stores/hub-filter';

vi.mock('@/lib/api/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/client')>();
  return { ...actual, apiGet: vi.fn() };
});

import * as client from '@/lib/api/client';

import type { CompletingWithinYear } from '../api/types';
import { DeliveryByYearCard } from './delivery-by-year-card';

const DATA = {
  has_active_schedule_run: true,
  delivery_by_year: {
    run_week: 47,
    base_year: 2026,
    within_year_week: 52,
    horizon_weeks: 307,
    horizon_years: 5,
    rows: [
      { kind: 'by_end_of_year', year: 2026, label: 'By end of 2026', indicative: false, p1: 2, p2: 0, p3: 0, total: 2, cum_p1: 2, cum_p2: 0, cum_p3: 0, cum_total: 2, left_out_reasons: null },
    ],
  },
  delivery_by_year_unavailable: null,
  rules_label: null,
  tail_warnings: { far_finish_count: 0, leader_overloaded_count: 0 },
} as unknown as CompletingWithinYear;

describe('DeliveryByYearCard (P53, R53-3)', () => {
  beforeEach(() => {
    vi.mocked(client.apiGet).mockReset().mockResolvedValue({
      schedule_run_version: 9,
      kind: 'by_end_of_year',
      year: 2026,
      band: 'P1',
      rows: [
        { project_id: 'a', project_name: 'Cooler A', hub: 'R&D-Greece', band: 'P1', completion_week: 40, delivery_year: 2026, far_finish: false, left_out_reason: null },
        { project_id: 'b', project_name: 'Cooler B', hub: 'PD-India', band: 'P1', completion_week: 50, delivery_year: 2026, far_finish: false, left_out_reason: null },
      ],
    });
  });

  it('a figure opens the served drill-in list with kind, year, band and the Dashboard filters', async () => {
    const user = userEvent.setup();
    renderWithProviders(<DeliveryByYearCard data={DATA} hub={NO_HUB_SELECTION} selection={{ categories: [], types: [] }} />);
    await user.click(screen.getByRole('button', { name: /^By end of 2026, P1: 2 projects/ }));
    const dialog = await screen.findByTestId('delivery-drill-dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent('By end of 2026 · P1 — 2 projects');
    await vi.waitFor(() => expect(client.apiGet).toHaveBeenCalled());
    expect(client.apiGet).toHaveBeenCalledWith(
      '/dashboard/delivery-by-year/projects',
      expect.objectContaining({ query: expect.objectContaining({ kind: 'by_end_of_year', year: 2026, band: 'P1' }) }),
    );
    // The served list has the expected count: no "data changed" note.
    await vi.waitFor(() => expect(within(dialog).queryByText('Loading')).toBeNull());
    expect(within(dialog).queryByTestId('delivery-drill-mismatch')).toBeNull();
  });
});
