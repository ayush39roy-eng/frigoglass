import * as React from 'react';
import { HardHat, Pencil, Trash2 } from 'lucide-react';

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
import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { formatDecimal, formatInteger } from '@/lib/format';
import { HUB_NAMES, type LabRegion } from '@/types/enums';

import type { EngineerRead } from '../api/types';
import { groupRows } from '../lib/group-rows';

/**
 * Plain (non-virtualized) table — engineer rows number in the tens per hub in
 * the real dataset, nowhere near CLAUDE.md's "virtualize any list over 100
 * rows" threshold (that's the 236-project baseline the Matrix/Gantt/
 * Registration lists are built for).
 */
export type EngineerTableRow = EngineerRead & { hubName: string; hubRegion?: LabRegion | undefined };

/**
 * P13-T17 (mock-up image 13): rows are grouped under a header per hub
 * (canonical hub order) — display grouping only; no per-hub figure is derived.
 */
export interface EngineerTableProps {
  rows: EngineerTableRow[];
  canEdit: boolean;
  onEdit: (row: EngineerRead) => void;
  onDelete: (row: EngineerRead) => void;
}

export function EngineerTable({ rows, canEdit, onEdit, onDelete }: EngineerTableProps): React.JSX.Element {
  const groups = React.useMemo(() => groupRows(rows, (r) => r.hubName, HUB_NAMES), [rows]);
  const columns = canEdit ? 4 : 3;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="text-right">FTE</TableHead>
          <TableHead>Allowed categories</TableHead>
          {canEdit ? <TableHead className="w-24 text-right">Actions</TableHead> : null}
        </TableRow>
      </TableHeader>
      {groups.map((group) => {
        const region = group.rows[0]?.hubRegion;
        return (
      <TableBody key={group.key} data-testid={`engineer-group-${group.key}`}>
        <tr className="border-t-[1.5px] border-border bg-primary-subtle/40">
          <th scope="rowgroup" colSpan={columns} className="px-4 py-2 text-left">
            <span className="flex items-center gap-2">
              {region ? <CountryFlag region={region} /> : null}
              <span className="font-display text-sm font-bold text-primary-subtle-fg">{group.key} Hub</span>
              <span className="text-2xs font-medium text-text-muted" data-numeric="">
                {formatInteger(group.rows.length)} {group.rows.length === 1 ? 'engineer' : 'engineers'}
              </span>
            </span>
          </th>
        </tr>
        {group.rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <span className="flex items-center gap-3">
                <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-subtle text-primary-subtle-fg">
                  <HardHat className="size-[18px]" />
                </span>
                <span className="font-semibold text-text">{row.name}</span>
              </span>
            </TableCell>
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
        );
      })}
    </Table>
  );
}
