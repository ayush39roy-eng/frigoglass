import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { HubTypePipelineRow } from '../api/types';
import { HubTypePipelineChart } from './hub-type-pipeline-chart';

const rows: HubTypePipelineRow[] = [
  { hub: 'R&D-Greece', type: 'NM', count: 3 },
  { hub: 'R&D-Greece', type: 'CO', count: 2 },
  { hub: 'PD-India', type: 'NM', count: 4 },
  { hub: 'PD-India', type: null, count: 1 },
];

describe('HubTypePipelineChart', () => {
  it('renders nothing for an empty response rather than an empty chart shell', () => {
    const { container } = render(<HubTypePipelineChart rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('exposes an accessible sr-only summary with the exact same grouped counts the bars draw', () => {
    render(<HubTypePipelineChart rows={rows} />);
    expect(screen.getByText('Project count per hub, split by project type')).toBeInTheDocument();

    // "New Model" / "Cost Optimization" — the human-readable labels, not the
    // raw 'NM'/'CO' enum codes — and the exact same per-hub totals
    // `HubTypePipelineTable`'s own pivot table states (5 for both hubs here).
    expect(
      screen.getByText(/R&D-Greece: New Model 3, Cost Optimization 2, — 0, total 5/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/PD-India: New Model 4, Cost Optimization 0, — 1, total 5/),
    ).toBeInTheDocument();
  });
});
