import * as React from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, History, Layers, Star, Tag, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ProjectPriorityPill } from '@/components/shared/priority-band-pill';
import { calculatedBandText } from '@/components/shared/suggested-band-chip';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { CategoryTag } from '@/components/ui/category-tag';
import { categoricalRankSoftBg, categoricalRankText, categoryRank } from '@/lib/categorical-palette';
import { cn } from '@/lib/utils';
import { scoringAnchor } from '@/lib/domain-constants';
import { HARD_GATE_REASONS, PROJECT_TYPE_LABELS, type HardGateReason } from '@/types/enums';
import { Checkbox } from '@/components/ui/checkbox';
import { useSetProjectVip } from '@/lib/api/vip';
import { ApiError } from '@/lib/api/client';
import { formatTimestamp } from '@/lib/format';

import { POINTS_RULE_COPY, type DimensionScoreValue, type LastScoreVersion, type PriorityMatrixRow } from '../api/types';
import { gateChanged, scoreChanged, valuesFor, type GridDrafts } from '../lib/grid-edit';
import { rowLastScoreVersion } from '../lib/matrix-rows';
import { GateCheckbox, GateHeader, GateMark, ScoreInput } from './grid-edit-cells';
import { groupByPillar } from '../lib/pillars';
import { isVipRow } from '../lib/vip-row';
import { dimensionColumnWidth, pillarTinted, widenForBand } from '../lib/grid-boxes';
import { formatPoints, rowBand, rowDimension } from '../lib/row-scores';
import { scoreIntensity } from '../lib/score-chip';
import { useScoringModel } from '../scoring-model';
import { formatWeight, layoutDimensions, type ScoringModelEntry } from '../lib/scoring-model-core';
import { ScoreCell } from './score-cell';
import { VirtualMatrixGrid, type MatrixBox, type MatrixColumn } from './virtual-matrix-grid';

const IDENTITY_BOX: MatrixBox = { id: 'identity', kind: 'identity' };
const INFO_BOX: MatrixBox = { id: 'info', kind: 'info' };
const SCORE_BOX: MatrixBox = { id: 'score', kind: 'score' };
const GATES_BOX: MatrixBox = { id: 'gates', kind: 'gates' };
/** How long a row that moved (VIP pin) stays highlighted. */
const FLASH_MS = 2500;

/**
 * Column definitions + rendering for the 236-row scoring grid.
 *
 * P21 (owner request): the financial columns are gone from the grid (they stay
 * in the edit dialog and the exports). The grid shows the rubric scores,
 * grouped under pillar header bands, and a final "Score /100" column. Every
 * figure is a served field rendered verbatim (I9).
 *
 * P26 (ADR 0037): the rubric is data. The dimension columns are the ACTIVE
 * dimensions of the served table (`GET /priorities/dimensions`, display order;
 * before it arrives, the first row's `dimension_scores`), grouped into pillar
 * boxes in order of first appearance. Any number of dimensions and any pillar
 * name work; nothing is keyed to a fixed list.
 */

/**
 * Dimension column header: the served label (wrapped, at most three lines) and
 * a tooltip with pillar, weight and, where the deck describes the dimension,
 * what a 1 and a 5 mean. A real button so the tooltip is reachable by keyboard.
 */
function DimHeader({ dim }: { dim: ScoringModelEntry }): React.JSX.Element {
  const { key, label, pillar, weight, scaled_weight: scaled } = dim;
  const anchor = scoringAnchor(key);
  const anchorText = anchor ? `: 1 = ${anchor.low}, 5 = ${anchor.high}` : '';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="mg-dim-head cursor-help rounded-sm text-center leading-tight underline decoration-dotted underline-offset-2"
          aria-label={`${label}${anchorText} (${pillar}, weight ${formatWeight(weight, scaled)})`}
          data-testid={`dim-head-${key}`}
        >
          {label}
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
        {anchor ? (
          <>
            <span className="block">
              <strong>1</strong> — {anchor.low}
            </span>
            <span className="block">
              <strong>5</strong> — {anchor.high}
            </span>
          </>
        ) : null}
        <span className="block text-text-inverse/80">– — not scored (counts 0 points; the score is incomplete)</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** One rubric cell: the served score 0–5, its served points on hover and for
 *  screen readers, and visibly in Detailed view. A missing score (null on an
 *  active dimension, P26) is an empty "–" chip. Nothing is computed. */
function DimCell({
  row,
  dim,
  showPoints,
}: {
  row: PriorityMatrixRow;
  dim: ScoringModelEntry;
  showPoints: boolean;
}): React.JSX.Element {
  const cell = rowDimension(row, dim.key);
  // P27 (ADR 0038): pre-filled by a Registration tag (served `tag_dimension_keys`).
  // A hint only — the cell is edited through the same dialog as any other.
  // Absent from a pre-P27 API (an older backend still running): no tag hint,
  // rather than a crash of the whole Matrix route.
  const tagKeys = (row as Partial<PriorityMatrixRow>).tag_dimension_keys ?? [];
  const fromRegistration = tagKeys.includes(dim.key);
  const regText = fromRegistration ? ' (from registration; still editable)' : '';
  if (cell.score === null) {
    // An unscored project has no chips at all; a scored one shows its gaps as empty chips.
    const text =
      (row.has_score ? `${dim.label}: not scored (0 points; incomplete)` : `${dim.label}: not scored`) + regText;
    return (
      <span className="flex flex-col items-center" title={text} data-testid={`dim-${dim.key}`}>
        {row.has_score ? (
          <span className="mg-chip" data-empty="true" data-testid="score-chip-empty" aria-hidden="true">
            –
          </span>
        ) : (
          <span className="text-text-muted" aria-hidden="true">
            –
          </span>
        )}
        <span className="sr-only">{text}</span>
      </span>
    );
  }
  const pts = cell.points !== null && cell.maxPoints !== null ? formatPoints(cell.points, cell.maxPoints) : null;
  // Owner ask 2026-11-16: no "(N of 100)" scaled figure, only the points.
  const summary = `${dim.label}: ${String(cell.score)} of 5${pts ? `, ${pts}` : ''}${regText}`;
  return (
    <span className="flex flex-col items-center gap-0.5 leading-tight" title={summary} data-testid={`dim-${dim.key}`}>
      <span
        className="mg-chip tnum relative"
        data-numeric=""
        data-intensity={scoreIntensity(cell.score)}
        data-from-registration={fromRegistration || undefined}
        data-testid="score-chip"
        aria-hidden="true"
      >
        {cell.score}
        {fromRegistration ? (
          <Tag className="mg-chip-reg" data-testid="from-registration-mark" aria-hidden="true" />
        ) : null}
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

/** P34-T02 (D34-1): the grid's inline edit session, owned by the page. */

/** P59: the served calculated band as the Committed pill's hover text. */
function matrixCalculatedBand(row: PriorityMatrixRow): string | null {
  const band = rowBand(row);
  if (band === null || band === 'Unscored') return null;
  return calculatedBandText(band, { capacityFill: row.capacity_fill, scoreBand: row.score_band });
}

export interface MatrixGridEdit {
  drafts: GridDrafts;
  /** The base a draft is compared to: the served row, or in scenario mode the
   *  row with its staged edit applied. */
  baseRow: (row: PriorityMatrixRow) => PriorityMatrixRow;
  onScore: (row: PriorityMatrixRow, key: string, value: DimensionScoreValue) => void;
  onGate: (row: PriorityMatrixRow, gate: HardGateReason, on: boolean) => void;
}

export interface MatrixTableProps {
  /** Rows in display order (the page sorts once: VIP first, then served rank). */
  rows: PriorityMatrixRow[];
  /** Project IDs with a genuinely-changed (non-no-op) staged scenario edit
   *  (P5-T01), marked next to the project name. `undefined` outside scenario mode. */
  scenarioStagedProjectIds?: ReadonlySet<string> | undefined;
  /** "Detailed view" (P21): adds Leader, Type and Committed and shows each
   *  dimension's served points under its score. The Matrix page starts compact. */
  detailed?: boolean;
  /** P13-T14: per-column filter controls, keyed by column id (`project`,
   *  `hub`, `leader`, …), rendered under the headers. Pass stable elements. */
  columnFilters?: Partial<Record<string, React.ReactNode>>;
  /** P21 Compare: selected project ids and the toggle. Omitted = no checkbox column. */
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (row: PriorityMatrixRow) => void;
  /** Max height of the grid's scroll region (CSS length). */
  maxHeight?: number | string;
  /** Narrow viewport: slimmer frozen columns. */
  narrow?: boolean;
  /** Offer the VIP star toggle (the server still authorises each pin). */
  canPinVip?: boolean;
  /** P34-T02: edit mode (score inputs and gate checkboxes); omitted = read only. */
  edit?: MatrixGridEdit | undefined;
  /** P34 (D34-4): open Version history at a version (the "changed" marker). */
  onOpenVersion?: ((version: number) => void) | undefined;
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

/**
 * Owner ask 2026-10-22: make a project VIP from the Matrix. A star before the
 * name toggles `PUT /projects/{id}/vip`; the server authorises (Project
 * Registration write, hub admin grant) and audits it. Read-only sessions see
 * the star as an indicator only. P34-T02: the mutation lives in the table (a
 * row may scroll out of the virtual window while it runs) and is optimistic.
 */
function VipToggle({
  row,
  canPin,
  pending,
  onToggle,
}: {
  row: PriorityMatrixRow;
  canPin: boolean;
  pending: boolean;
  onToggle: (row: PriorityMatrixRow) => void;
}): React.JSX.Element | null {
  const vip = isVipRow(row);
  if (!canPin && !vip) return null;
  if (!canPin) {
    return (
      <span className="grid size-6 shrink-0 place-items-center text-accent" title="VIP project" data-testid="vip-mark">
        <Star className="size-3.5 fill-current" aria-hidden="true" />
        <span className="sr-only">VIP</span>
      </span>
    );
  }
  const label = vip ? `Remove VIP from ${row.project_name}` : `Make ${row.project_name} VIP`;
  return (
    <button
      type="button"
      aria-pressed={vip}
      aria-label={label}
      aria-busy={pending || undefined}
      title={label}
      disabled={pending}
      onClick={() => onToggle(row)}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none',
        vip ? 'text-accent hover:bg-accent/12' : 'text-text-subtle hover:bg-surface-sunken hover:text-accent',
      )}
      data-testid="vip-toggle"
    >
      <Star className={cn('size-3.5', vip && 'fill-current')} aria-hidden="true" />
    </button>
  );
}

/** P34 (D34-4): "changed in version N" marker; opens Version history at N. */
function ChangedMarker({
  last,
  onOpen,
}: {
  last: LastScoreVersion;
  onOpen?: ((version: number) => void) | undefined;
}): React.JSX.Element {
  const text = [`Changed in version ${String(last.version)}`, formatTimestamp(last.created_at), last.applied_by_name]
    .filter((p): p is string => p !== null && p !== '')
    .join(' · ');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onOpen?.(last.version)}
          aria-label={`${text}. Open in version history`}
          className="grid size-5 shrink-0 place-items-center rounded-full text-text-muted hover:bg-surface-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="score-changed-marker"
        >
          <History className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

function vipErrorText(name: string, err: unknown): string {
  if (err instanceof ApiError && err.isForbidden) {
    return `The VIP pin of ${name} was refused: you need edit rights on this project (Project Registration, its hub). The star is back as it was.`;
  }
  return `The VIP pin of ${name} could not be saved. The star is back as it was; please try again.`;
}

export const MatrixTable = React.memo(function MatrixTable({
  canPinVip = false,
  rows,
  scenarioStagedProjectIds,
  detailed = true,
  columnFilters,
  selectedIds,
  onToggleSelect,
  maxHeight,
  narrow = false,
  edit,
  onOpenVersion,
}: MatrixTableProps): React.JSX.Element {
  // P34-T02 VIP: one mutation for the table, per-project pending, an error line,
  // and the moved row kept in view and highlighted for a moment.
  const { mutate: setVip } = useSetProjectVip();
  const [vipPending, setVipPending] = React.useState<ReadonlySet<string>>(() => new Set());
  const [vipError, setVipError] = React.useState<string | null>(null);
  const [flashKey, setFlashKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (flashKey === null) return undefined;
    const t = window.setTimeout(() => setFlashKey(null), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [flashKey]);
  const toggleVip = React.useCallback(
    (row: PriorityMatrixRow) => {
      const id = row.project_id;
      setVipError(null);
      setFlashKey(id);
      setVipPending((prev) => new Set(prev).add(id));
      setVip(
        { projectId: id, isVip: !isVipRow(row) },
        {
          onError: (err) => setVipError(vipErrorText(row.project_name, err)),
          onSettled: () =>
            setVipPending((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            }),
        },
      );
    },
    [setVip],
  );

  const model = useScoringModel();
  const dims = React.useMemo(() => layoutDimensions(model, rows), [model, rows]);
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
        cell: (row) => {
          const last = rowLastScoreVersion(row);
          return (
          <span className="flex min-w-0 items-center gap-1.5">
            <VipToggle row={row} canPin={canPinVip} pending={vipPending.has(row.project_id)} onToggle={toggleVip} />
            <span
              aria-hidden="true"
              className={cn(
                'hidden size-6 shrink-0 place-items-center rounded-full sm:grid',
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
            {last ? <ChangedMarker last={last} onOpen={onOpenVersion} /> : null}
            {scenarioStagedProjectIds?.has(row.project_id) ? (
              <Badge tone="primary" title="Staged in the current scenario — not yet applied" data-testid="scenario-staged-mark">
                <Layers aria-hidden="true" />
                <span className="sr-only">Staged in the current scenario</span>
              </Badge>
            ) : null}
          </span>
          );
        },
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
          // P57 (ADR 0067): Commercialized / Cancelled read "N/A".
          // P59 (owner 2026-11-23): the score's calculated band is this pill's hover text.
          cell: (row) => (
            <span data-testid="matrix-set-priority">
              <ProjectPriorityPill
                status={row.status}
                priorityApplicable={row.priority_applicable}
                priority={row.set_priority}
                short
                hint={matrixCalculatedBand(row)}
                fallback={<span className="text-text-subtle">–</span>}
              />
            </span>
          ),
        },
      );
    }

    // P21 / P26: one column per ACTIVE dimension, grouped under pillar header
    // bands (first appearance). P21-T03: each pillar is one box; every second
    // pillar carries a faint tint.
    groupByPillar(dims).forEach((group, pillarIndex) => {
      const widths = widenForBand(
        group.items.map((d) => dimensionColumnWidth(d.label, detailed ? 76 : 64)),
        group.pillar,
      );
      group.items.forEach((dim, i) => {
        cols.push({
          box: { id: `pillar-${group.pillar}`, kind: 'pillar', tint: pillarTinted(pillarIndex) },
          id: `dim-${dim.key}`,
          header: <DimHeader dim={dim} />,
          group: group.pillar,
          width: widths[i] ?? 64,
          align: 'center',
          headerClassName: 'px-1 normal-case tracking-normal text-text-muted',
          cellClassName: 'px-1',
          cell: edit
            ? (row) => {
                const base = edit.baseRow(row);
                return (
                  <ScoreInput
                    value={valuesFor(edit.drafts, base).scores[dim.key] ?? null}
                    changed={scoreChanged(edit.drafts, base, dim.key)}
                    label={`${dim.label} for ${row.project_name}`}
                    onChange={(v) => edit.onScore(row, dim.key, v)}
                  />
                );
              }
            : (row) => <DimCell row={row} dim={dim} showPoints={detailed} />,
        });
      });
    });

    // P34-T02: one narrow column per hard gate, in its own "Hard gates" group:
    // a check mark (served `hard_gates`) outside edit mode, a checkbox in it.
    for (const gate of HARD_GATE_REASONS) {
      cols.push({
        box: GATES_BOX,
        id: `gate-${gate}`,
        header: <GateHeader gate={gate} />,
        group: 'Hard gates',
        width: 72,
        align: 'center',
        headerClassName: 'px-1 normal-case tracking-normal text-text-muted',
        cellClassName: 'px-1',
        cell: edit
          ? (row) => {
              const base = edit.baseRow(row);
              return (
                <GateCheckbox
                  checked={valuesFor(edit.drafts, base).hard_gates.includes(gate)}
                  changed={gateChanged(edit.drafts, base, gate)}
                  label={`${gate} for ${row.project_name}`}
                  onChange={(on) => edit.onGate(row, gate, on)}
                />
              );
            }
          : (row) => <GateMark on={row.hard_gates.includes(gate)} label={`${gate} for ${row.project_name}`} />,
      });
    }

    cols.push({
      id: 'score',
      header: 'Score /100',
      width: 168,
      box: SCORE_BOX,
      headerClassName: 'text-text',
      // P59: with the Committed column shown, the calculated band is its hover
      // text only; the compact view (no Committed column) keeps the chip.
      cell: (row) => <ScoreCell row={row} dense showBand={!detailed} />,
    });

    if (columnFilters) {
      return cols.map((c) => (columnFilters[c.id] === undefined ? c : { ...c, filter: columnFilters[c.id] }));
    }
    return cols;
  }, [
    scenarioStagedProjectIds,
    detailed,
    columnFilters,
    dims,
    selectedIds,
    onToggleSelect,
    narrow,
    canPinVip,
    vipPending,
    toggleVip,
    edit,
    onOpenVersion,
  ]);

  const isRowChanged = React.useMemo(
    () => (edit ? (row: PriorityMatrixRow) => edit.drafts[row.project_id] !== undefined : undefined),
    [edit],
  );

  return (
    <div className="flex flex-col gap-2">
      {vipError ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded border border-danger/40 bg-danger-subtle px-3 py-2 text-xs text-text"
          data-testid="vip-error"
        >
          <span className="min-w-0 flex-1">{vipError}</span>
          <button
            type="button"
            onClick={() => setVipError(null)}
            aria-label="Dismiss"
            className="grid size-5 place-items-center rounded-full hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </p>
      ) : null}
      <VirtualMatrixGrid
        rows={rows}
        columns={columns}
        rowKey={(row) => row.project_id}
        caption="Prioritization scoring grid"
        regionLabel="Scoring grid table (scrolls horizontally; project and hub stay frozen)"
        maxHeight={maxHeight}
        isRowSelected={selectedIds ? (row) => selectedIds.has(row.project_id) : undefined}
        flashRowKey={flashKey}
        isRowChanged={isRowChanged}
      />
    </div>
  );
});
