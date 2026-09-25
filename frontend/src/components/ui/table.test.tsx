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
});
