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
import { PROJECT_TYPE_LABELS } from '@/types/enums';
import { Checkbox } from '@/components/ui/checkbox';

import { POINTS_RULE_COPY, type PriorityMatrixRow } from '../api/types';
import { sortByPillar } from '../lib/pillars';
import { formatPoints, rowDimension } from '../lib/row-scores';
import { scoreIntensity } from '../lib/score-chip';
import { formatWeight, useScoringModel, type ScoringModelEntry } from '../scoring-model';
import { ScoreCell } from './score-cell';
import { VirtualMatrixGrid, type MatrixBox, type MatrixColumn } from './virtual-matrix-grid';

const IDENTITY_BOX: MatrixBox = { id: 'identity', kind: 'identity' };
const INFO_BOX: MatrixBox = { id: 'info', kind: 'info' };
const SCORE_BOX: MatrixBox = { id: 'score', kind: 'score' };
const ACTIONS_BOX: MatrixBox = { id: 'actions', kind: 'actions' };

/**
 * Column definitions + rendering for the 236-row scoring grid.
 *
 * P21 (owner request): the financial columns are gone from the grid (they stay
 * in the edit dialog and the exports). The grid shows the 13 rubric scores,
 * grouped under pillar header bands, and a final "Score /100" column. Every
 * figure is a served field rendered verbatim (I9).
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
          className="cursor-help whitespace-normal break-words rounded-sm text-center leading-tight underline decoration-dotted underline-offset-2"
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
          <strong>0</strong> — no contribution (no points)
        </span>
        <span className="block">
          <strong>1</strong> — {anchor.low}
        </span>
        <span className="block">
          <strong>5</strong> — {anchor.high}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** One rubric cell: the served score 0–5, its served points on hover and for
 *  screen readers, and visibly in Detailed view. Nothing is computed. */
function DimCell({
  row,
  dim,
  showPoints,
}: {
  row: PriorityMatrixRow;
  dim: ScoringModelEntry;
  showPoints: boolean;
}): React.JSX.Element {
  const cell = rowDimension(row, dim.key, dim.weight);
  if (cell.score === null) {
    return (
      <span className="text-text-muted" title={`${dim.label}: not scored`}>
        –<span className="sr-only">{`${dim.label}: not scored`}</span>
      </span>
    );
  }
  const pts = cell.points !== null && cell.maxPoints !== null ? formatPoints(cell.points, cell.maxPoints) : null;
  // Served scaled-to-100 points (`dimension_points[key].scaled_points`), when present.
  const scaled = row.dimension_points?.[dim.key]?.scaled_points;
  const scaledText = scaled === undefined ? '' : ` (${scaled.toFixed(2)} of 100)`;
  const summary = `${dim.label}: ${String(cell.score)} of 5${pts ? `, ${pts}${scaledText}` : ''}`;
  return (
    <span className="flex flex-col items-center gap-0.5 leading-tight" title={summary} data-testid={`dim-${dim.key}`}>
      <span
        className="mg-chip tnum"
        data-numeric=""
        data-intensity={scoreIntensity(cell.score)}
        data-testid="score-chip"
        aria-hidden="true"
      >
        {cell.score}
      </span>
      {showPoints && pts ? (
        <span className="tnum text-2xs text-text-muted" aria-hidden="true">
          {pts}
        </span>
      ) : null}
      <span className="sr-only">{summary}</span>
    </span>
  );
}

export interface MatrixTableProps {
  rows: PriorityMatrixRow[];
  canEdit: boolean;
  onEdit: (row: PriorityMatrixRow) => void;
  /** Project IDs with a genuinely-changed (non-no-op) staged scenario edit
   *  (P5-T01) — purely a visual "staged, not yet live" indicator next to the
   *  edit affordance. `undefined`/empty outside scenario mode. */
  scenarioStagedProjectIds?: ReadonlySet<string> | undefined;
  /** "Detailed view" (P21): adds Leader, Type and Committed and shows each
   *  dimension's served points under its score. The Matrix page starts compact. */
  detailed?: boolean;
  /** P13-T14: per-column filter controls, keyed by column id (`project`,
   *  `hub`, `leader`, …), rendered under the headers. */
  columnFilters?: Partial<Record<string, React.ReactNode>>;
  /** P21 Compare: selected project ids and the toggle. Omitted = no checkbox column. */
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (row: PriorityMatrixRow) => void;
  /** Max height of the grid's scroll region (CSS length). */
  maxHeight?: number | string;
  /** Narrow viewport: slimmer frozen columns. */
  narrow?: boolean;
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
  canEdit,
  onEdit,
  scenarioStagedProjectIds,
  detailed = true,
  columnFilters,
  selectedIds,
  onToggleSelect,
  maxHeight,
  narrow = false,
}: MatrixTableProps): React.JSX.Element {
  const model = useScoringModel();
  const columns = React.useMemo<MatrixColumn<PriorityMatrixRow>[]>(() => {
    const cols: MatrixColumn<PriorityMatrixRow>[] = [];
    if (selectedIds && onToggleSelect) {
      cols.push({
        id: 'select',
        header: <span className="sr-only">Select to compare</span>,
        width: narrow ? 32 : 40,
        sticky: true,
        align: 'center',
        headerClassName: 'px-1',
        cellClassName: 'px-1',
        box: IDENTITY_BOX,
        cell: (row) => (
          <Checkbox
            checked={selectedIds.has(row.project_id)}
            onCheckedChange={() => onToggleSelect(row)}
            aria-label={`Select ${row.project_name} to compare`}
            data-testid="compare-checkbox"
          />
        ),
      });
    }
    cols.push(
      {
        id: 'project',
        header: 'Project',
        width: narrow ? 116 : 232,
        box: IDENTITY_BOX,
        sticky: true,
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className={cn(
                'hidden size-7 shrink-0 place-items-center rounded-full sm:grid',
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
        width: narrow ? 80 : 104,
        // Project and Hub are frozen; on a narrow screen only Project is, or
        // nothing would be left to scroll (the frozen edge carries the rule).
        sticky: !narrow,
        box: IDENTITY_BOX,
        cell: (row) => <span className="truncate text-text-muted">{row.hub}</span>,
      },
      {
        // P13-T14: served rank by score within the filtered set (1-based).
        id: 'rank',
        header: 'Rank',
        width: 64,
        align: 'center',
        box: INFO_BOX,
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
    );
    if (detailed) {
      cols.push({ id: 'leader', header: 'Leader', width: 120, box: INFO_BOX, cell: leaderCell });
    }
    cols.push(
      {
        id: 'status',
        header: 'Status',
        width: 156,
        box: INFO_BOX,
        cell: (row) => <ProjectStatusBadge status={row.status} />,
      },
      {
        id: 'category',
        header: 'Cat.',
        width: 64,
        align: 'center',
        box: INFO_BOX,
        cell: (row) =>
          row.category ? <CategoryTag category={row.category} /> : <span className="text-text-subtle">–</span>,
      },
    );
    if (detailed) {
      cols.push(
        {
          id: 'type',
          header: 'Type',
          width: 60,
          align: 'center',
          box: INFO_BOX,
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
          box: INFO_BOX,
          cell: (row) =>
            row.set_priority ? (
              <PriorityBandPill priority={row.set_priority} />
            ) : (
              <span className="text-text-subtle">–</span>
            ),
        },
      );
    }

    // P21: the 13 rubric columns, grouped under pillar header bands. P21-T03:
    // each pillar is one box; every second pillar carries a faint tint.
    const pillars: string[] = [];
    for (const dim of sortByPillar(model.dimensions)) {
      if (!pillars.includes(dim.pillar)) pillars.push(dim.pillar);
      const pillarIndex = pillars.indexOf(dim.pillar);
      cols.push({
        box: { id: `pillar-${dim.pillar}`, kind: 'pillar', tint: pillarIndex % 2 === 1 },
        id: `dim-${dim.key}`,
        header: <DimHeader dim={dim} />,
        group: dim.pillar,
        width: detailed ? 72 : 58,
        align: 'center',
        headerClassName: 'px-1 normal-case tracking-normal text-text-muted',
        cellClassName: 'px-1',
        cell: (row) => <DimCell row={row} dim={dim} showPoints={detailed} />,
      });
    }

    cols.push({
      id: 'score',
      header: 'Score /100',
      width: 168,
      box: SCORE_BOX,
      headerClassName: 'text-text',
      cell: (row) => <ScoreCell row={row} />,
    });

    if (canEdit) {
      cols.push({
        id: 'actions',
        header: 'Edit',
        width: 80,
        align: 'center',
        box: ACTIONS_BOX,
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
  }, [canEdit, onEdit, scenarioStagedProjectIds, detailed, columnFilters, model, selectedIds, onToggleSelect, narrow]);

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
      regionLabel="Scoring grid table (scrolls horizontally; project and hub stay frozen)"
      maxHeight={maxHeight}
      isRowSelected={selectedIds ? (row) => selectedIds.has(row.project_id) : undefined}
    />
  );
}
