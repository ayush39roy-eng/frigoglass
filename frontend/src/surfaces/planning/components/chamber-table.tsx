import * as React from 'react';
import { Pencil, Thermometer, Trash2 } from 'lucide-react';

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
import { LAB_REGIONS, type LabRegion } from '@/types/enums';

import type { ChamberRead } from '../api/types';
import { groupRows } from '../lib/group-rows';

/** Plain (non-virtualized) table — same rationale as `engineer-table.tsx`:
 *  chamber counts per lab region are nowhere near the 100-row threshold. */
export interface ChamberTableProps {
  rows: ChamberRead[];
  canEdit: boolean;
  onEdit: (row: ChamberRead) => void;
  onDelete: (row: ChamberRead) => void;
}

/** P13-T17 (mock-up image 13): rows are grouped under a header per lab region
 *  (Greece, India, Romania) — display grouping only; no per-region figure is
 *  derived. */
export function ChamberTable({ rows, canEdit, onEdit, onDelete }: ChamberTableProps): React.JSX.Element {
  const groups = React.useMemo(() => groupRows(rows, (r) => r.lab_region, LAB_REGIONS), [rows]);
  const columns = canEdit ? 9 : 8;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Code</TableHead>
          <TableHead className="text-right">Max concurrent</TableHead>
          <TableHead className="text-right">Platforms</TableHead>
          <TableHead className="text-right">Efficiency</TableHead>
          <TableHead className="text-right" title="Maintenance / breakdown / calibration, weeks per year">
            Downtime (M/B/C)
          </TableHead>
          <TableHead className="text-right">Working wks</TableHead>
          <TableHead className="text-right">Efficient lab wks</TableHead>
          <TableHead>Allowed stages</TableHead>
          {canEdit ? <TableHead className="w-24 text-right">Actions</TableHead> : null}
        </TableRow>
      </TableHeader>
      {groups.map((group) => (
      <TableBody key={group.key} data-testid={`chamber-group-${group.key}`}>
        <tr className="border-t-[1.5px] border-border bg-success-subtle/50">
          <th scope="rowgroup" colSpan={columns} className="px-4 py-2 text-left">
            <span className="flex items-center gap-2">
              {(LAB_REGIONS as readonly string[]).includes(group.key) ? (
                <CountryFlag region={group.key as LabRegion} />
              ) : null}
              <span className="font-display text-sm font-bold text-success-subtle-fg">{group.key} labs</span>
              <span className="text-2xs font-medium text-text-muted" data-numeric="">
                {formatInteger(group.rows.length)} {group.rows.length === 1 ? 'chamber' : 'chambers'}
              </span>
            </span>
          </th>
        </tr>
        {group.rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <span className="flex items-center gap-3">
                <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-success-subtle text-success-subtle-fg">
                  <Thermometer className="size-[18px]" />
                </span>
                <span className="font-semibold text-text">{row.code}</span>
              </span>
            </TableCell>
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
              {formatDecimal(row.maintenance_weeks)} / {formatDecimal(row.breakdown_weeks)} /{' '}
              {formatDecimal(row.calibration_weeks)}
            </TableCell>
            <TableCell className="text-right tnum" data-numeric="">
              {formatDecimal(row.working_weeks_per_chamber)}
            </TableCell>
            <TableCell className="text-right tnum" data-numeric="">
              {formatDecimal(row.efficient_lab_weeks)}
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
      ))}
    </Table>
  );
}
