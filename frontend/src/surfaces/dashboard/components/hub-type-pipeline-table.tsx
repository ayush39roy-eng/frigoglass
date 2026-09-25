import * as React from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatInteger } from '@/lib/format';
import { PROJECT_TYPE_LABELS, type ProjectType } from '@/types/enums';

import type { HubTypePipelineRow } from '../api/types';

/**
 * Hub × type pipeline summary table (PROJECT_AND_STACK.md §2). Pivoted from the
 * flat `[{hub, type, count}]` rows the API returns. Portfolio composition — not a
 * schedule outcome. A Hub Planner only sees rows for their own hub(s) (the API
 * hub-scopes the query).
 */

const UNTYPED = '—';

export interface HubTypePipelineTableProps {
  rows: HubTypePipelineRow[];
}

export function HubTypePipelineTable({ rows }: HubTypePipelineTableProps): React.JSX.Element {
  const { hubs, typeColumns, cell, rowTotals, colTotals, grandTotal } = React.useMemo(() => {
    const hubSet = new Set<string>();
    const typeSet = new Set<string>();
    const cellMap = new Map<string, number>();
    const rowT = new Map<string, number>();
    const colT = new Map<string, number>();
    let grand = 0;

    for (const r of rows) {
      const typeKey = r.type ?? UNTYPED;
      hubSet.add(r.hub);
      typeSet.add(typeKey);
      cellMap.set(`${r.hub}::${typeKey}`, (cellMap.get(`${r.hub}::${typeKey}`) ?? 0) + r.count);
      rowT.set(r.hub, (rowT.get(r.hub) ?? 0) + r.count);
      colT.set(typeKey, (colT.get(typeKey) ?? 0) + r.count);
      grand += r.count;
    }

    const orderedTypes = [...typeSet].sort((a, b) => {
      if (a === UNTYPED) return 1;
      if (b === UNTYPED) return -1;
      return a.localeCompare(b);
    });

    return {
      hubs: [...hubSet].sort((a, b) => a.localeCompare(b)),
      typeColumns: orderedTypes,
      cell: (hub: string, type: string) => cellMap.get(`${hub}::${type}`) ?? 0,
      rowTotals: rowT,
      colTotals: colT,
      grandTotal: grand,
    };
  }, [rows]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hub × type pipeline</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">
            No projects in the pipeline for your hub scope.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hub</TableHead>
                {typeColumns.map((type) => (
                  <TableHead key={type} className="text-right">
                    {type === UNTYPED
                      ? 'Untyped'
                      : (PROJECT_TYPE_LABELS[type as ProjectType] ?? type)}
                  </TableHead>
                ))}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hubs.map((hub) => (
                <TableRow key={hub}>
                  <TableCell className="font-medium text-text">{hub}</TableCell>
                  {typeColumns.map((type) => {
                    const value = cell(hub, type);
                    return (
                      <TableCell
                        key={type}
                        className="text-right tnum text-text-muted"
                        data-numeric=""
                      >
                        {value === 0 ? (
                          <span className="text-text-subtle">·</span>
                        ) : (
                          formatInteger(value)
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right tnum font-semibold text-text" data-numeric="">
                    {formatInteger(rowTotals.get(hub) ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="border-t-2 border-border-strong">
                <TableCell className="font-semibold text-text">Total</TableCell>
                {typeColumns.map((type) => (
                  <TableCell
                    key={type}
                    className="text-right tnum font-semibold text-text"
                    data-numeric=""
                  >
                    {formatInteger(colTotals.get(type) ?? 0)}
                  </TableCell>
                ))}
                <TableCell className="text-right tnum font-semibold text-text" data-numeric="">
                  {formatInteger(grandTotal)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
