import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { seriousAxeViolations } from '@/test/axe';

import type { AnalyticsBucket, HubTypePipelineRow } from '../api/types';
import { HubTypePipelineTable } from './hub-type-pipeline-table';

const rows: HubTypePipelineRow[] = [
  { hub: 'R&D-Greece', type: 'NM', count: 3 },
  { hub: 'R&D-Greece', type: 'CO', count: 2 },
  { hub: 'PD-India', type: 'NM', count: 4 },
  { hub: 'PD-India', type: null, count: 1 },
];
// Served totals, deliberately NOT the cell sums: the table must print these.
const byHub: AnalyticsBucket[] = [
  { key: 'R&D-Greece', count: 50, share_pct: 0 },
  { key: 'PD-India', count: 60, share_pct: 0 },
];
const byType: AnalyticsBucket[] = [
  { key: 'NM', count: 70, share_pct: 0 },
  { key: 'CO', count: 80, share_pct: 0 },
  { key: 'Unmapped', count: 9, share_pct: 0 },
];

describe('HubTypePipelineTable (P17-R08)', () => {
  it('prints the served per-hub, per-type and pipeline totals, never a browser sum', () => {
    render(<HubTypePipelineTable rows={rows} byHub={byHub} byType={byType} grandTotal={999} />);
    expect(screen.getByRole('heading', { name: 'Project pipeline summary: Hub × Type' })).toBeInTheDocument();
    const greece = screen.getByRole('row', { name: /R&D-Greece/ });
    expect(greece.lastElementChild).toHaveTextContent('50');
    const total = screen.getByRole('row', { name: /^Total/ });
    expect(total).toHaveTextContent('70');
    expect(total).toHaveTextContent('80');
    expect(total.lastElementChild).toHaveTextContent('999');
    // Columns in ProjectType order, untyped last.
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Hub', 'NM', 'CO', '—', 'Total']);
  });

  it('shows a dash for totals while the analytics payload is not loaded', () => {
    render(<HubTypePipelineTable rows={rows} />);
    expect(screen.getAllByLabelText('Total not loaded').length).toBeGreaterThan(0);
  });

  it('makes every non-zero typed figure a labelled button and reports the clicked target', async () => {
    const onDrill = vi.fn();
    render(<HubTypePipelineTable rows={rows} byHub={byHub} byType={byType} grandTotal={999} onDrill={onDrill} />);
    await userEvent.click(screen.getByRole('button', { name: 'View 3 New Model projects in R&D-Greece' }));
    expect(onDrill).toHaveBeenLastCalledWith({ source: 'pipeline', hub: 'R&D-Greece', typeKey: 'NM', count: 3 }, expect.any(HTMLElement));
    await userEvent.click(screen.getByRole('button', { name: 'View all 60 projects in PD-India' }));
    expect(onDrill).toHaveBeenLastCalledWith({ source: 'pipeline', hub: 'PD-India', typeKey: null, count: 60 }, expect.any(HTMLElement));
    await userEvent.click(screen.getByRole('button', { name: 'View all 70 New Model projects' }));
    expect(onDrill).toHaveBeenLastCalledWith({ source: 'pipeline', hub: null, typeKey: 'NM', count: 70 }, expect.any(HTMLElement));
    await userEvent.click(screen.getByRole('button', { name: 'View all 999 projects' }));
    expect(onDrill).toHaveBeenLastCalledWith({ source: 'pipeline', hub: null, typeKey: null, count: 999 }, expect.any(HTMLElement));
  });

  it('never makes a zero clickable', () => {
    render(<HubTypePipelineTable rows={rows} byHub={byHub} byType={byType} grandTotal={999} onDrill={vi.fn()} />);
    const india = screen.getByRole('row', { name: /PD-India/ });
    // PD-India × CO is 0: a dot, no button.
    expect(within(india).queryByRole('button', { name: /Cost Optimization/ })).not.toBeInTheDocument();
  });

  it('P17-R09: untyped cells and the untyped column total drill down (type=Unmapped is served)', async () => {
    const onDrill = vi.fn();
    render(<HubTypePipelineTable rows={rows} byHub={byHub} byType={byType} grandTotal={999} onDrill={onDrill} />);
    expect(screen.queryByTitle('The list of untyped projects is not available yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/no project type set/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View 1 untyped project in PD-India' }));
    expect(onDrill).toHaveBeenLastCalledWith({ source: 'pipeline', hub: 'PD-India', typeKey: 'Unmapped', count: 1 }, expect.any(HTMLElement));
    await userEvent.click(screen.getByRole('button', { name: 'View all 9 untyped projects' }));
    expect(onDrill).toHaveBeenLastCalledWith({ source: 'pipeline', hub: null, typeKey: 'Unmapped', count: 9 }, expect.any(HTMLElement));
  });

  it('its horizontal scroller is a focusable named region and the table has no axe violations', async () => {
    const { container } = render(<HubTypePipelineTable rows={rows} byHub={byHub} byType={byType} grandTotal={999} onDrill={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Project pipeline by hub and project type' })).toHaveAttribute('tabindex', '0');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('shows a plain message when there is nothing in scope', () => {
    render(<HubTypePipelineTable rows={[]} />);
    expect(screen.getByText(/No projects in the pipeline/i)).toBeInTheDocument();
  });
});
