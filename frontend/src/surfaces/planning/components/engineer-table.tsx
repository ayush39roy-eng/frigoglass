import * as React from 'react';
import { Pencil, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDecimal } from '@/lib/format';

import type { EngineerRead } from '../api/types';

/**
 * Plain (non-virtualized) table — engineer rows number in the tens per hub in
 * the real dataset, nowhere near CLAUDE.md's "virtualize any list over 100
 * rows" threshold (that's the 236-project baseline the Matrix/Gantt/
 * Registration lists are built for).
 */
export interface EngineerTableProps {
  rows: (EngineerRead & { hubName: string })[];
  canEdit: boolean;
  onEdit: (row: EngineerRead) => void;
  onDelete: (row: EngineerRead) => void;
}

export function EngineerTable({ rows, canEdit, onEdit, onDelete }: EngineerTableProps): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Hub</TableHead>
          <TableHead className="text-right">FTE</TableHead>
          <TableHead>Allowed categories</TableHead>
          {canEdit ? <TableHead className="w-24 text-right">Actions</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium text-text">{row.name}</TableCell>
            <TableCell>{row.hubName}</TableCell>
            <TableCell className="text-right tnum" data-numeric="">
              {formatDecimal(row.fte)}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {row.allowed_categories.length === 0 ? (
                  <span className="text-2xs text-text-subtle">None set</span>
                ) : (
                  row.allowed_categories.map((c) => (
                    <Badge key={c} tone="outline">
                      {c}
                    </Badge>
                  ))
                )}
              </div>
            </TableCell>
            {canEdit ? (
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${row.name}`}
                    onClick={() => onEdit(row)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${row.name}`}
                    onClick={() => onDelete(row)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
