import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { UseQueryResult } from '@tanstack/react-query';

import type { CompletingWithinYear, DashboardAnalytics, PipelineTotals, StatusOverview } from '../../api/types';

/**
 * P28 axe gate for the Executive view (ADR 0039 "axe clean"), the
 * `analytics-breakdown.a11y.test.tsx` pattern: in jsdom `ResponsiveContainer`
 * measures 0×0 and renders no SVG, so it is swapped for a fixed-size
 * passthrough so the REAL Recharts surfaces render, and nothing inside an
 * aria-hidden figure may be reachable by Tab (axe aria-hidden-focus).
 */
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
      React.cloneElement(children, { width: 320, height: 160 }),
  };
});

const vipHook = { useVipBoard: vi.fn() };
vi.mock('@/lib/api/vip', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/vip')>('@/lib/api/vip');
  return { ...actual, useVipBoard: (...a: unknown[]) => vipHook.useVipBoard(...a) };
});
const dashHooks = { useDashboardProjects: vi.fn() };
vi.mock('../../hooks/use-dashboard', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/use-dashboard')>('../../hooks/use-dashboard');
  return { ...actual, useDashboardProjects: (...a: unknown[]) => dashHooks.useDashboardProjects(...a) };
});

import { ExecutiveView } from './executive-view';

function ready<T>(data: T): UseQueryResult<T, Error> {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() } as unknown as UseQueryResult<T, Error>;
}

const withinYear: CompletingWithinYear = {
  has_active_schedule_run: true,
  schedule_run_version: 4,
  within_year_count: 41,
  spillover_count: 42,
  left_out_count: 126,
  blocked_count: 18,
  priority_delivery: [
    {
      priority: 'P1',
      total: 34,
      within_year: 12,
      in_flight_total: 20,
      in_flight_within_year: 9,
      not_started_total: 8,
      not_started_within_year: 3,
      delivered_total: 2,
      delivered_within_year: 0,
      other_total: 4,
      within_year_share_pct: 35.29,
      in_flight_within_year_share_pct: 45,
      not_started_within_year_share_pct: 37.5,
      in_flight_share_pct: 58.82,
      not_started_share_pct: 23.53,
      delivered_share_pct: 5.88,
      other_share_pct: 11.76,
    },
  ],
  rows: [
    {
      project_id: 'p-b1',
      project_name: 'Blocked Cooler',
      hub: 'PD-India',
      category: null,
      priority: 'P1',
      within_year: false,
      spillover: false,
      left_out: false,
      blocked: true,
      cat_not_allowed: false,
      last_step_end_week: null,
      type: null,
      status: 'In Development',
      not_started: false,
    },
    {
      project_id: 'p-w1',
      project_name: 'Landing Cooler',
      hub: 'PD-India',
      category: null,
      priority: 'P2',
      within_year: true,
      spillover: false,
      left_out: false,
      blocked: false,
      cat_not_allowed: false,
      last_step_end_week: 33,
      type: null,
      status: 'In Development',
      not_started: false,
    },
  ],
};

const totals: PipelineTotals = {
  spillover_count: 17,
  new_count: 236,
  unregistered_count: 0,
  total_count: 253,
  spillover_share_pct: 6.72,
  new_share_pct: 93.28,
  unregistered_share_pct: 0,
};

const status: StatusOverview = {
  in_buyoff: 0,
  under_industrialization: 24,
  in_development: 83,
  in_queue: 85,
  other_counts: {},
  commercialized_count: 17,
  on_hold_count: 15,
  total_count: 253,
  in_development_share_pct: 32.81,
  under_industrialization_share_pct: 9.49,
  in_queue_share_pct: 33.6,
  commercialized_share_pct: 6.72,
  on_hold_share_pct: 5.93,
  other_statuses_count: 29,
  other_statuses_counts: { Cancelled: 29 },
  other_statuses_share_pct: 11.46,
};

const analytics: DashboardAnalytics = {
  by_type: [
    { key: 'CO', count: 89, share_pct: 37.71 },
    { key: 'RC', count: 63, share_pct: 26.69 },
  ],
  by_category: [
    { key: 'A+', count: 50, share_pct: 21.19 },
    { key: 'B', count: 102, share_pct: 43.22 },
  ],
  by_hub: [],
  by_reg_year: [],
  completing_hub_type: [],
  completing_by_type: [],
  completing_by_hub: [{ key: 'PD-India', pipeline_count: 180, completing_count: 14, completing_pct: 7.78 }],
  has_active_schedule_run: true,
};

describe('ExecutiveView a11y (P28)', () => {
  it('renders every section and is axe-clean with nothing tabbable inside aria-hidden figures', async () => {
    vipHook.useVipBoard.mockReturnValue(ready({ run_id: 'r', pillars: [], areas: [] }));
    dashHooks.useDashboardProjects.mockReturnValue(ready({ total_count: 0, rows: [] }));

    const { container } = renderWithProviders(
      <ExecutiveView
        withinYear={ready(withinYear)}
        pipelineTotals={ready(totals)}
        statusOverview={ready(status)}
        analytics={ready(analytics)}
        activeRun={null}
        hubId={null}
        region={null}
        selection={{
          categories: ['A+'],
          types: [],
          setCategories: vi.fn(),
          setTypes: vi.fn(),
          clear: vi.fn(),
          active: true,
        }}
        breakdowns={{
          type: { analytics: ready(analytics), totals: ready(totals) },
          category: { analytics: ready(analytics), totals: ready(totals) },
        }}
      />,
    );

    // The lazy chart panels resolve.
    expect(await screen.findByTestId('exec-pipeline-donut')).toBeInTheDocument();
    expect(await screen.findByTestId('exec-status-donut')).toBeInTheDocument();
    expect(await screen.findByTestId('exec-priority-delivery')).toBeInTheDocument();
    // P31: the type and category donuts (with a category selected, so slices dim).
    expect(await screen.findByTestId('exec-type-donut')).toBeInTheDocument();
    expect(await screen.findByTestId('exec-category-donut')).toBeInTheDocument();
    expect(screen.getByTestId('exec-kpi-strip')).toBeInTheDocument();
    expect(screen.getByTestId('exec-risks-card')).toBeInTheDocument();
    expect(screen.getByTestId('exec-upcoming-card')).toBeInTheDocument();
    // Session fixture current_week 31 → W33 is inside the 8-week window.
    expect(screen.getAllByTestId('exec-upcoming-row')).toHaveLength(1);
    expect(screen.getByTestId('exec-provenance')).toBeInTheDocument();

    // P13-R01: aria-hidden chart figures must hold nothing tabbable.
    for (const figure of Array.from(container.querySelectorAll('figure[aria-hidden="true"]'))) {
      const tabbable = Array.from(figure.querySelectorAll('[tabindex]')).filter(
        (el) => Number(el.getAttribute('tabindex')) >= 0,
      );
      expect(tabbable).toEqual([]);
    }

    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('P31: the register rows behind Risks are requested with the Dashboard selection', async () => {
    vipHook.useVipBoard.mockReturnValue(ready({ run_id: 'r', pillars: [], areas: [] }));
    dashHooks.useDashboardProjects.mockReturnValue(ready({ total_count: 0, rows: [] }));
    renderWithProviders(
      <ExecutiveView
        withinYear={ready(withinYear)}
        pipelineTotals={ready(totals)}
        statusOverview={ready(status)}
        analytics={ready(analytics)}
        activeRun={null}
        hubId="h1"
        region={null}
        selection={{
          categories: ['A+', 'A'],
          types: ['NM'],
          setCategories: vi.fn(),
          setTypes: vi.fn(),
          clear: vi.fn(),
          active: true,
        }}
        breakdowns={{
          type: { analytics: ready(analytics), totals: ready(totals) },
          category: { analytics: ready(analytics), totals: ready(totals) },
        }}
      />,
    );
    expect(await screen.findByTestId('exec-type-donut')).toBeInTheDocument();
    expect(dashHooks.useDashboardProjects).toHaveBeenLastCalledWith({
      hub_id: 'h1',
      region: undefined,
      category: ['A+', 'A'],
      type: ['NM'],
    });
  });
});
