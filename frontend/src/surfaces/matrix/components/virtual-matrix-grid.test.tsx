import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
  }),
}));

import { VirtualMatrixGrid, type MatrixColumn } from './virtual-matrix-grid';

interface Row {
  id: string;
  name: string;
  v: number;
}

const columns: MatrixColumn<Row>[] = [
  { id: 'name', header: 'Name', width: 200, sticky: true, cell: (r) => r.name },
  { id: 'v', header: 'Value', width: 80, align: 'right', cell: (r) => String(r.v) },
];

describe('VirtualMatrixGrid', () => {
  it('renders a sticky-header table with one row per datum and a min-width wider than the viewport', () => {
    const rows: Row[] = [
      { id: 'a', name: 'Alpha', v: 1 },
      { id: 'b', name: 'Beta', v: 2 },
    ];
    render(<VirtualMatrixGrid rows={rows} columns={columns} rowKey={(r) => r.id} caption="Grid" />);

    const table = screen.getByRole('table', { name: 'Grid' });
    expect(table).toHaveAttribute('aria-rowcount', '2');
    expect(table).toHaveStyle({ minWidth: '280px' });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // horizontal + vertical scroll live in one container, not the page body
    expect(screen.getByTestId('matrix-grid-scroll')).toHaveClass('overflow-auto');
  });
});
