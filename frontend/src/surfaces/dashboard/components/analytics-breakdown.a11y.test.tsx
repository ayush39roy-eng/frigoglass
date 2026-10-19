import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { DashboardAnalytics } from '../api/types';
import { AnalyticsBreakdown } from './analytics-breakdown';

/**
 * P13-R01 (QA-P13-1): in jsdom `ResponsiveContainer` measures 0x0 and renders no SVG, so the
 * main suite's axe scan cannot see the charts. Here it is swapped for a fixed-size passthrough
 * so the real Recharts surfaces render, and nothing inside an aria-hidden figure may be
 * reachable by Tab (axe `aria-hidden-focus`).
 */
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
      React.cloneElement(children, { width: 480, height: 280 }),
  };
});

const DATA: DashboardAnalytics = {
  by_type: [
    { key: 'CO', count: 89, share_pct: 37.71 },
    { key: 'Unmapped', count: 3, share_pct: 1.27 },
  ],
  by_category: [
    { key: 'B', count: 162, share_pct: 68.64 },
    { key: 'A+', count: 7, share_pct: 2.97 },
  ],
  by_hub: [{ key: 'PD-India', count: 180, share_pct: 76.27 }],
  by_reg_year: [{ key: '2026', count: 160, share_pct: 67.8 }],
  completing_hub_type: [
    { hub: 'PD-India', type: 'CO', pipeline_count: 82, completing_count: 7, completing_pct: 8.54 },
  ],
  completing_by_type: [{ key: 'CO', pipeline_count: 89, completing_count: 10, completing_pct: 11.24 }],
  completing_by_hub: [{ key: 'PD-India', pipeline_count: 180, completing_count: 14, completing_pct: 7.78 }],
  has_active_schedule_run: true,
};

describe('AnalyticsBreakdown charts (P13-R01, QA-P13-1)', () => {
  it('renders the chart SVGs with nothing tabbable inside the aria-hidden figures', async () => {
    const { container } = renderWithProviders(<AnalyticsBreakdown data={DATA} pipelineTotal={236} />);
    const figures = Array.from(container.querySelectorAll('figure[aria-hidden="true"]'));
    expect(figures.length).toBeGreaterThan(0);
    // The real surfaces rendered (otherwise this test would be vacuous).
    expect(figures.every((f) => f.querySelector('svg') !== null)).toBe(true);
    for (const f of figures) {
      const tabbable = Array.from(f.querySelectorAll('[tabindex]')).filter(
        (el) => Number(el.getAttribute('tabindex')) >= 0,
      );
      expect(tabbable).toEqual([]);
    }
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
