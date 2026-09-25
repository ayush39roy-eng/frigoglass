import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 40,
        size: 40,
      })),
    measureElement: () => undefined,
  }),
}));

import { VirtualDataTable, type VirtualColumn } from './virtual-data-table';

interface Row {
  id: string;
  name: string;
  n: number;
}

const columns: VirtualColumn<Row>[] = [
  { id: 'name', header: 'Name', width: '1fr', cell: (r) => r.name },
  { id: 'n', header: 'Count', width: '4rem', align: 'right', cell: (r) => String(r.n) },
];

describe('VirtualDataTable', () => {
  it('renders a header row and one row per datum via the virtualizer', () => {
    const rows: Row[] = [
      { id: 'a', name: 'Alpha', n: 1 },
      { id: 'b', name: 'Beta', n: 2 },
    ];
    render(
      <VirtualDataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        caption="Test table"
      />,
    );
    expect(screen.getByRole('table', { name: 'Test table' })).toHaveAttribute('aria-rowcount', '2');
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });
});
