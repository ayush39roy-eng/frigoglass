import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import type { HubTypePipelineRow } from '../api/types';
import { HubTypePipelineTable } from './hub-type-pipeline-table';

const rows: HubTypePipelineRow[] = [
  { hub: 'R&D-Greece', type: 'NM', count: 3 },
  { hub: 'R&D-Greece', type: 'CO', count: 2 },
  { hub: 'PD-India', type: 'NM', count: 4 },
  { hub: 'PD-India', type: null, count: 1 },
];

describe('HubTypePipelineTable', () => {
  it('pivots the flat rows and totals them without recomputing anything else', () => {
    render(<HubTypePipelineTable rows={rows} />);

    const greeceRow = screen.getByRole('row', { name: /R&D-Greece/ });
    // NM 3, CO 2, Untyped 0, total 5
    expect(within(greeceRow).getByText('5')).toBeInTheDocument();

    const indiaRow = screen.getByRole('row', { name: /PD-India/ });
    expect(within(indiaRow).getByText('4')).toBeInTheDocument();

    const totalRow = screen.getByRole('row', { name: /^Total/ });
    // grand total 3+2+4+1 = 10
    expect(within(totalRow).getByText('10')).toBeInTheDocument();
  });

  it('shows a plain message when there is nothing in scope', () => {
    render(<HubTypePipelineTable rows={[]} />);
    expect(screen.getByText(/No projects in the pipeline/i)).toBeInTheDocument();
  });
});
