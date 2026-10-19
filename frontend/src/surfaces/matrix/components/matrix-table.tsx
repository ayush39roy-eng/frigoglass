import * as React from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, Layers, Pencil } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { CategoryTag } from '@/components/ui/category-tag';
import { categoricalRankSoftBg, categoricalRankText, categoryRank } from '@/lib/categorical-palette';
import { cn } from '@/lib/utils';
import { SCORING_ANCHORS } from '@/lib/domain-constants';
import { formatCurrency, formatDecimal } from '@/lib/format';
import { PROJECT_TYPE_LABELS, type CurrencyCode } from '@/types/enums';

import { POINTS_RULE_COPY, type DimensionPoints, type PriorityMatrixRow } from '../api/types';
import { formatWeight, useScoringModel, type ScoringModelEntry } from '../scoring-model';
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

/**
 * Dimension column header with the scoring anchors as a tooltip (P9 contract
 * §8): what a 1 and a 5 mean, plus pillar and weight. A real button so the
 * tooltip is reachable by keyboard; the visible text stays the short label.
 */
function DimHeader({ dim }: { dim: ScoringModelEntry }): React.JSX.Element {
  const { key: field, short, label, pillar, weight, scaled_weight: scaled } = dim;
  const anchor = SCORING_ANCHORS[field];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="cursor-help rounded-sm underline decoration-dotted underline-offset-2"
          aria-label={`${label}: 1 = ${anchor.low}, 5 = ${anchor.high} (${pillar}, weight ${formatWeight(weight, scaled)})`}
        >
          {short}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">
        <span className="block font-semibold">{label}</span>
        <span className="block text-text-inverse/80">
          {pillar} · weight {formatWeight(weight, scaled)}
        </span>
        <span className="block text-text-inverse/80">{POINTS_RULE_COPY}</span>
        <span className="mt-1 block">
          <strong>1</strong> — {anchor.low}
        </span>
        <span className="block">
          <strong>5</strong> — {anchor.high}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

function dimCell(
  value: number | null,
  pts: DimensionPoints | undefined,
  weight: number,
): React.ReactNode {
  if (value === null) return <span className="text-text-subtle">–</span>;
  return (
    <span
      className="tnum text-text"
      data-numeric=""
      title={pts ? `${String(pts.points)} / ${String(weight)} points (${pts.scaled_points.toFixed(1)} of 100 scale)` : undefined}
    >
      {value}
      {pts ? (
        <span className="ml-1 text-2xs text-text-muted">
          {pts.points}/{weight}
        </span>
      ) : null}
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
  /** P13-T14 "Detailed view": show the 13 score-dimension columns. Default
   *  `true` (the pre-P13 grid); the Matrix page starts compact. */
  detailed?: boolean;
  /** P13-T14: per-column filter controls, keyed by column id (`project`,
   *  `hub`, `leader`, …), rendered under the headers. */
  columnFilters?: Partial<Record<string, React.ReactNode>>;
}

/** P13-T14 / ADR 0028: the API serves the leader's name. An id with no name
 *  reads "Name unavailable"; no leader reads "—". */
function leaderCell(row: PriorityMatrixRow): React.ReactNode {
  if (row.leader_name) {
    return (
      <span className="truncate text-text" title={row.leader_name}>
        {row.leader_name}
      </span>
    );
  }
  if (row.leader_engineer_id) {
    return (
      <span className="italic text-text-subtle" title="Leader name unavailable">
        Name unavailable
      </span>
    );
  }
  return (
    <span className="text-text-subtle" title="No leader assigned">
      –
    </span>
  );
}

export function MatrixTable({
  rows,
  currency,
  canEdit,
  onEdit,
  scenarioStagedProjectIds,
  detailed = true,
  columnFilters,
}: MatrixTableProps): React.JSX.Element {
  const model = useScoringModel();
  const columns = React.useMemo<MatrixColumn<PriorityMatrixRow>[]>(() => {
    const cols: MatrixColumn<PriorityMatrixRow>[] = [
      {
        // P13-T14: served rank by score within the filtered set (1-based).
        id: 'rank',
        header: 'Rank',
        width: 64,
        sticky: true,
        align: 'center',
        cell: (row) =>
          row.rank === null ? (
            <span className="text-text-subtle" title="Not scored — no rank">
              –
            </span>
          ) : (
            <span className="tnum font-semibold text-text" data-numeric="">
              {row.rank}
            </span>
          ),
      },
      {
        id: 'project',
        header: 'Project',
        width: 240,
        sticky: true,
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className={cn(
                'grid size-7 shrink-0 place-items-center rounded-full',
                row.category
                  ? cn(categoricalRankSoftBg(categoryRank(row.category)), categoricalRankText(categoryRank(row.category)))
                  : 'bg-surface-sunken text-text-muted',
              )}
            >
              <FolderKanban className="size-3.5" />
            </span>
            <Link
              to={`/projects/${row.project_id}`}
              className="truncate font-semibold text-text underline-offset-2 hover:text-primary hover:underline"
              title={`${row.project_name} — open in Project Workspace`}
            >
              {row.project_name}
            </Link>
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
        id: 'leader',
        header: 'Leader',
        width: 120,
        cell: leaderCell,
      },
      {
        id: 'status',
        header: 'Status',
        width: 160,
        cell: (row) => <ProjectStatusBadge status={row.status} />,
      },
      {
        id: 'category',
        header: 'Cat.',
        width: 76,
        align: 'center',
        cell: (row) =>
          row.category ? <CategoryTag category={row.category} /> : <span className="text-text-subtle">–</span>,
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

    for (const dim of detailed ? model.dimensions : []) {
      cols.push({
        id: `dim-${dim.key}`,
        header: <DimHeader dim={dim} />,
        width: 76,
        align: 'center',
        cell: (row) => dimCell(row[dim.key], row.dimension_points?.[dim.key], dim.weight),
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

    if (columnFilters) {
      return cols.map((c) => (columnFilters[c.id] === undefined ? c : { ...c, filter: columnFilters[c.id] }));
    }
    return cols;
  }, [currency, canEdit, onEdit, scenarioStagedProjectIds, detailed, columnFilters, model]);

  const sortedRows = React.useMemo(() => {
    return [...rows].sort((a, b) => {
      if (a.rank !== null && b.rank !== null) {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return a.project_name.localeCompare(b.project_name);
      }
      if (a.rank !== null) return -1;
      if (b.rank !== null) return 1;

      if (a.weighted_score !== null && b.weighted_score !== null) {
        if (b.weighted_score !== a.weighted_score) return b.weighted_score - a.weighted_score;
        return a.project_name.localeCompare(b.project_name);
      }
      if (a.weighted_score !== null) return -1;
      if (b.weighted_score !== null) return 1;

      return a.project_name.localeCompare(b.project_name);
    });
  }, [rows]);

  return (
    <VirtualMatrixGrid
      rows={sortedRows}
      columns={columns}
      rowKey={(row) => row.project_id}
      caption="Prioritization scoring grid"
    />
  );
}
