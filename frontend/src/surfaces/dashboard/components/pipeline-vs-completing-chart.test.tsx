import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { PipelineVsCompletingChart } from './pipeline-vs-completing-chart';

const rows = [
  { key: 'NM' as const, pipeline_count: 36, completing_count: 14, completing_pct: 38.89 },
  // A zero bar: before P17-R08 every label after it shifted by one bar.
  { key: 'RC' as const, pipeline_count: 0, completing_count: 0, completing_pct: 0 },
  { key: 'NO' as const, pipeline_count: 56, completing_count: 30, completing_pct: 53.57 },
];

describe('PipelineVsCompletingChart (moved in P17-R08)', () => {
  it('states each served type figure verbatim', () => {
    renderWithProviders(<PipelineVsCompletingChart rows={rows} />);
    const list = screen.getByRole('list', { name: 'Pipeline vs completing by project type' });
    expect(list).toHaveTextContent('New Model: pipeline 36, completing 14 (38.89%)');
    expect(list).toHaveTextContent('New Option: pipeline 56, completing 30 (53.57%)');
  });

  it('shows an empty state and is axe-clean', async () => {
    const { container, unmount } = renderWithProviders(<PipelineVsCompletingChart rows={rows} />);
    expect(await seriousAxeViolations(container)).toEqual([]);
    unmount();
    renderWithProviders(<PipelineVsCompletingChart rows={[]} />);
    expect(screen.getByText('No pipeline projects in view.')).toBeInTheDocument();
  });
});
