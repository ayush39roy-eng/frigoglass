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
import { formatDecimal, formatInteger } from '@/lib/format';

import type { ChamberRead } from '../api/types';

/** Plain (non-virtualized) table — same rationale as `engineer-table.tsx`:
 *  chamber counts per lab region are nowhere near the 100-row threshold. */
export interface ChamberTableProps {
  rows: ChamberRead[];
  canEdit: boolean;
  onEdit: (row: ChamberRead) => void;
  onDelete: (row: ChamberRead) => void;
}

export function ChamberTable({ rows, canEdit, onEdit, onDelete }: ChamberTableProps): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Code</TableHead>
          <TableHead>Lab region</TableHead>
          <TableHead className="text-right">Max concurrent</TableHead>
          <TableHead className="text-right">Platforms</TableHead>
          <TableHead className="text-right">Efficiency</TableHead>
          <TableHead className="text-right">Weeks/chamber</TableHead>
          <TableHead>Allowed stages</TableHead>
          {canEdit ? <TableHead className="w-24 text-right">Actions</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium text-text">{row.code}</TableCell>
            <TableCell>{row.lab_region}</TableCell>
            <TableCell className="text-right tnum" data-numeric="">
              {formatInteger(row.max_concurrent)}
            </TableCell>
            <TableCell className="text-right tnum" data-numeric="">
              {formatInteger(row.platforms)}
            </TableCell>
            <TableCell className="text-right tnum" data-numeric="">
              {formatDecimal(row.efficiency)}
            </TableCell>
            <TableCell className="text-right tnum" data-numeric="">
              {formatDecimal(row.weeks_per_chamber)}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {row.allowed_stages.length === 0 ? (
                  <span className="text-2xs text-text-subtle">None set</span>
                ) : (
                  row.allowed_stages.map((s) => (
                    <Badge key={s} tone="outline">
                      {s}
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
                    aria-label={`Edit ${row.code}`}
                    onClick={() => onEdit(row)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${row.code}`}
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
