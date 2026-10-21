import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

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

  it('P21-T03: marks the scroll region once scrolled sideways (frozen-block shadow) and the frozen edge cell', () => {
    const rows: Row[] = [{ id: 'a', name: 'Alpha', v: 1 }];
    render(<VirtualMatrixGrid rows={rows} columns={columns} rowKey={(r) => r.id} caption="Grid" />);
    const scroll = screen.getByTestId('matrix-grid-scroll');
    expect(scroll).toHaveAttribute('data-scrolled-x', 'false');
    scroll.scrollLeft = 120;
    fireEvent.scroll(scroll);
    expect(scroll).toHaveAttribute('data-scrolled-x', 'true');
    scroll.scrollLeft = 0;
    fireEvent.scroll(scroll);
    expect(scroll).toHaveAttribute('data-scrolled-x', 'false');
    // The sticky header cell and the body cell of the last frozen column carry the edge.
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveClass('mg-frozen-edge', 'mg-cell-sticky');
    expect(screen.getByText('Alpha').closest('[role="cell"]')).toHaveClass('mg-frozen-edge');
  });
});
