import * as React from 'react';
import { Layers, Pencil } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { formatCurrency, formatDecimal } from '@/lib/format';
import { PROJECT_TYPE_LABELS, type CurrencyCode } from '@/types/enums';

import { DIMENSIONS, type PriorityMatrixRow } from '../api/types';
import { ScoreCell } from './score-cell';
import { VirtualMatrixGrid, type MatrixColumn } from './virtual-matrix-grid';

/**
 * Column definitions + rendering for the 236-row scoring grid.
 *
 * Every financial figure below is `row.<field>` rendered verbatim — the values
 * arrive ALREADY converted to `currency` from `GET /priorities?currency=…`.
 * There is no multiplication or division by any rate anywhere in this file
 * (Invariant I9 analogue for money). `gross_margin_pct` is never converted.
 */

function DimHeader({ short, label, pillar, weight }: (typeof DIMENSIONS)[number]): React.JSX.Element {
  return (
    <abbr title={`${label} · ${pillar} · weight ${String(weight)}`} className="no-underline">
      {short}
    </abbr>
  );
}

function dimCell(value: number | null): React.ReactNode {
  return value === null ? (
    <span className="text-text-subtle">–</span>
  ) : (
    <span className="tnum text-text" data-numeric="">
      {value}
    </span>
  );
}

export interface MatrixTableProps {
  rows: PriorityMatrixRow[];
  currency: CurrencyCode;
  canEdit: boolean;
  onEdit: (row: PriorityMatrixRow) => void;
  /** Project IDs with a genuinely-changed (non-no-op) staged scenario edit
   *  (P5-T01) — purely a visual "staged, not yet live" indicator next to the
   *  edit affordance. `undefined`/empty outside scenario mode. */
  scenarioStagedProjectIds?: ReadonlySet<string> | undefined;
}

export function MatrixTable({
  rows,
  currency,
  canEdit,
  onEdit,
  scenarioStagedProjectIds,
}: MatrixTableProps): React.JSX.Element {
  const columns = React.useMemo<MatrixColumn<PriorityMatrixRow>[]>(() => {
    const cols: MatrixColumn<PriorityMatrixRow>[] = [
      {
        id: 'project',
        header: 'Project',
        width: 200,
        sticky: true,
        cell: (row) => (
          <span className="truncate font-medium text-text" title={row.project_name}>
            {row.project_name}
          </span>
        ),
      },
      {
        id: 'hub',
        header: 'Hub',
        width: 104,
        cell: (row) => <span className="truncate text-text-muted">{row.hub}</span>,
      },
      {
        id: 'category',
        header: 'Cat.',
        width: 56,
        align: 'center',
        cell: (row) =>
          row.category ? <Badge tone="outline">{row.category}</Badge> : <span className="text-text-subtle">–</span>,
      },
      {
        id: 'type',
        header: 'Type',
        width: 64,
        align: 'center',
        cell: (row) =>
          row.type ? (
            <abbr title={PROJECT_TYPE_LABELS[row.type]} className="no-underline text-text-muted">
              {row.type}
            </abbr>
          ) : (
            <span className="text-text-subtle">–</span>
          ),
      },
      {
        id: 'set_priority',
        header: 'Committed',
        width: 92,
        align: 'center',
        cell: (row) =>
          row.set_priority ? (
            <PriorityBandPill priority={row.set_priority} />
          ) : (
            <span className="text-text-subtle">–</span>
          ),
      },
      {
        id: 'score',
        header: 'Score / computed band',
        width: 230,
        cell: (row) => <ScoreCell row={row} />,
      },
    ];

    for (const dim of DIMENSIONS) {
      cols.push({
        id: `dim-${dim.field}`,
        header: <DimHeader {...dim} />,
        width: 60,
        align: 'center',
        cell: (row) => dimCell(row[dim.field]),
      });
    }

    cols.push(
      {
        id: 'capex',
        header: `CAPEX (k ${currency})`,
        width: 112,
        align: 'right',
        cell: (row) =>
          row.capex_keur === null ? (
            <span className="text-text-subtle">–</span>
          ) : (
            <span className="tnum text-text" data-numeric="">
              {formatDecimal(row.capex_keur)}
            </span>
          ),
      },
      {
        id: 'rm_savings',
        header: `RM sav. (k ${currency})`,
        width: 116,
        align: 'right',
        cell: (row) =>
          row.rm_savings_keur === null ? (
            <span className="text-text-subtle">–</span>
          ) : (
            <span className="tnum text-text" data-numeric="">
              {formatDecimal(row.rm_savings_keur)}
            </span>
          ),
      },
      {
        id: 'tcogs',
        header: `TCOGS (${currency})`,
        width: 116,
        align: 'right',
        cell: (row) =>
          row.tcogs_eur === null ? (
            <span className="text-text-subtle">–</span>
          ) : (
            <span className="tnum text-text" data-numeric="">
              {formatCurrency(row.tcogs_eur, currency, { compact: true })}
            </span>
          ),
      },
      {
        id: 'selling_price',
        header: `Selling price (${currency})`,
        width: 128,
        align: 'right',
        cell: (row) =>
          row.selling_price_eur === null ? (
            <span className="text-text-subtle">–</span>
          ) : (
            <span className="tnum text-text" data-numeric="">
              {formatCurrency(row.selling_price_eur, currency, { compact: true })}
            </span>
          ),
      },
      {
        id: 'gross_margin',
        header: 'Gross margin %',
        width: 108,
        align: 'right',
        cell: (row) =>
          row.gross_margin_pct === null ? (
            <span className="text-text-subtle">–</span>
          ) : (
            <span className="tnum text-text" data-numeric="" title="Never currency-converted">
              {formatDecimal(row.gross_margin_pct)}%
            </span>
          ),
      },
    );

    if (canEdit) {
      cols.push({
        id: 'actions',
        header: 'Edit',
        width: 96,
        align: 'center',
        cell: (row) => (
          <div className="flex items-center gap-1">
            {scenarioStagedProjectIds?.has(row.project_id) ? (
              <Badge tone="primary" title="Staged in the current scenario — not yet applied">
                <Layers aria-hidden="true" />
              </Badge>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit(row)}
              aria-label={`Edit prioritization score for ${row.project_name}`}
            >
              <Pencil />
            </Button>
          </div>
        ),
      });
    }

    return cols;
  }, [currency, canEdit, onEdit, scenarioStagedProjectIds]);

  return (
    <VirtualMatrixGrid
      rows={rows}
      columns={columns}
      rowKey={(row) => row.project_id}
      caption="Prioritization scoring grid"
    />
  );
}
