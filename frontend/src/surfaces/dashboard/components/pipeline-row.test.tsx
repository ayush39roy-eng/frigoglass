import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { CARRY_OVER_YEAR, PLAN_YEAR } from '@/lib/domain-constants';
import { renderWithProviders } from '@/test/render';

import type { PipelineTotals, RegionSummary } from '../api/types';
import { PipelineRow } from './pipeline-row';

/** ADR 0030: every figure and share is served; nothing is computed in the browser (I19). */

const TOTALS: PipelineTotals = {
  spillover_count: 76,
  new_count: 160,
  unregistered_count: 3,
  total_count: 239,
  spillover_share_pct: 31.8,
  new_share_pct: 66.95,
  unregistered_share_pct: 1.26,
};

function row(region: 'Greece' | 'India' | 'Romania', n: number, sp: number, nw: number, un: number) {
  return {
    region,
    total_count: n,
    share_pct: 33.33,
    spillover_count: sp,
    newly_registered_count: nw,
    unregistered_count: un,
    spillover_share_pct: 11.11,
    newly_registered_share_pct: 22.22,
    unregistered_share_pct: 50,
    status_counts: {},
    status_share_pct: {},
  } as const;
}

const SUMMARY: RegionSummary = {
  total_count: 239,
  regions: [row('Greece', 80, 8, 70, 2), row('India', 100, 60, 40, 0), row('Romania', 59, 8, 50, 1)],
};

describe('PipelineRow', () => {
  it('renders four cards with served counts and "of total" shares', () => {
    renderWithProviders(<PipelineRow totals={TOTALS} regionSummary={SUMMARY} />);
    expect(screen.getByTestId('pipeline-count-spillover')).toHaveTextContent('76');
    expect(screen.getByTestId('pipeline-count-new')).toHaveTextContent('160');
    expect(screen.getByTestId('pipeline-count-unregistered')).toHaveTextContent('3');
    expect(screen.getByTestId('pipeline-count-total')).toHaveTextContent('239');
    expect(screen.getByTestId('pipeline-caption-spillover')).toHaveTextContent('31.8% of total');
    expect(screen.getByTestId('pipeline-caption-new')).toHaveTextContent('66.95% of total');
    expect(screen.getByTestId('pipeline-caption-unregistered')).toHaveTextContent('1.26% of total');
    expect(screen.getByTestId('pipeline-caption-total')).toHaveTextContent(`All statuses · full ${String(PLAN_YEAR)} pipeline`);
  });

  it('labels the years from the domain constants and reads as an equation', () => {
    renderWithProviders(<PipelineRow totals={TOTALS} />);
    expect(screen.getByRole('region', { name: `Spillover ${String(CARRY_OVER_YEAR)}` })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: `Newly registered ${String(PLAN_YEAR)}` })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Unregistered date' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Total projects' })).toBeInTheDocument();
    const glyphs = screen.getAllByTestId('pipeline-glyph').map((g) => g.textContent);
    expect(glyphs).toEqual(['+', '+', '=']);
    // decorative; kept visible when the cards stack so the equation still reads
    for (const g of screen.getAllByTestId('pipeline-glyph')) {
      expect(g).toHaveAttribute('aria-hidden', 'true');
      expect(g.className).not.toContain('hidden');
    }
  });

  it('shows per-country chips (Greece, India, Romania) from the served rows', () => {
    renderWithProviders(<PipelineRow totals={TOTALS} regionSummary={SUMMARY} />);
    const spill = screen.getByRole('list', { name: `Spillover ${String(CARRY_OVER_YEAR)} by country` });
    const items = within(spill).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Greece:8(11.11%)');
    expect(items[1]).toHaveTextContent('India:60');
    expect(items[2]).toHaveTextContent('Romania:8');
    expect(screen.getByRole('list', { name: 'Total projects by country' })).toHaveTextContent('Greece:80(33.33%)');
  });

  it('keeps the Unregistered card at 0, muted, with no chips', () => {
    renderWithProviders(
      <PipelineRow
        totals={{ ...TOTALS, unregistered_count: 0, unregistered_share_pct: 0, total_count: 236 }}
        regionSummary={SUMMARY}
      />,
    );
    expect(screen.getByTestId('pipeline-count-unregistered')).toHaveTextContent('0');
    expect(screen.getByTestId('pipeline-count-unregistered').className).toContain('text-text-muted');
    expect(screen.getByTestId('pipeline-caption-unregistered')).toHaveTextContent('No registration year set');
    expect(screen.queryByRole('list', { name: 'Unregistered date by country' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('pipeline-glyph')).toHaveLength(3);
  });

  it('renders without chips while the region summary is absent', () => {
    renderWithProviders(<PipelineRow totals={TOTALS} regionSummary={null} />);
    expect(screen.queryByTestId('region-chips')).not.toBeInTheDocument();
    expect(screen.getByTestId('pipeline-count-total')).toHaveTextContent('239');
  });

  it('keeps composition spillover distinct from the schedule outcome in its info text', () => {
    renderWithProviders(<PipelineRow totals={TOTALS} />);
    expect(screen.getByRole('button', { name: 'Project pipeline source' })).toBeInTheDocument();
  });
});
