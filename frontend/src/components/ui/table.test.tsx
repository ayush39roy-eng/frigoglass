import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

describe('Table', () => {
  it('renders header and body rows', () => {
    render(
      <Table stickyHeader>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Priority</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>26-00201</TableCell>
            <TableCell>P1</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('columnheader', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '26-00201' })).toBeInTheDocument();
  });

  it('scrollLabel opts the scroll wrapper into a focusable named region (P13-R01)', () => {
    const { rerender } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    rerender(
      <Table scrollLabel="Hub utilization matrix">
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const region = screen.getByRole('region', { name: 'Hub utilization matrix' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table'));
  });
});
