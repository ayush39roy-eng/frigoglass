import * as React from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { rankPositionCopy } from '@/components/shared/priority-move/move-copy';
import { usePriorityMoveHost, type PriorityMoveOutcome } from '@/components/shared/priority-move/priority-move-context';
import { PriorityMoveProvider } from '@/components/shared/priority-move/priority-move-provider';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission, useSession } from '@/stores/session';
import { hasHubSelection, useHubSelection } from '@/stores/hub-filter';
import { CountrySegmented } from '@/components/shared/hub-filter/country-segmented';
import { HubFilterChip } from '@/components/shared/hub-filter/hub-filter-chip';
import { Badge } from '@/components/ui/badge';
import {
  PROJECT_PRIORITIES,
  type ProjectCategory,
  type ProjectPriority,
  type ProjectStatus,
  type ProjectType,
} from '@/types/enums';

import { useDebouncedValue } from '@/lib/use-debounced-value';

import { useBoardLeaderFacets, usePriorityBoard, type BandRankAnchorPlacement, type PriorityBoardFilters } from './api';
import { selectionParam } from '@/lib/multi-select-filter';
import { BoardColumn } from './components/board-column';
import { BoardToolbar } from './components/board-toolbar';
import { EMPTY_TOOLBAR, SEARCH_MAX, type BoardToolbarState } from './lib/toolbar-state';
import { HubLoadStrip } from './components/hub-load-strip';
import { BoardScenarioContext } from './lib/board-scenario';
import { useBoardLayout } from './lib/board-layout';
import { BoardLayoutToggle } from './components/board-layout-toggle';
import {
  allowedTargets,
  applyOverrides,
  canRerank,
  displayPlacementForRank,
  isNoopSlot,
  lastServedIdIfFullBand,
  placementForSlot,
  positionForPlacement,
  slotForIndex,
  stepTarget,
  type BoardOverrides,
  type DisplayCard,
  type DisplayColumn,
} from './lib/board-model';

const NO_STAGED: ReadonlySet<string> = new Set();

interface PointerDrag {
  projectId: string;
  from: ProjectPriority;
  allowed: ProjectPriority[];
  /** P36: may be reordered inside `from` (served `band_rank`). */
  canRank: boolean;
}

interface KeyboardLift extends PointerDrag {
  target: ProjectPriority;
  /** P36: the 0-based index among the visible cards of `from` the card would hold (Up / Down). */
  index: number;
}

function columnName(p: ProjectPriority): string {
  return p;
}

/**
 * `/priority-board` (ADR 0018, P12-T05): every project in scope in five
 * columns, P1–P4 and Q, from `GET /priority-board` (grouped, sorted and
 * counted by the server). Dropping a card on another column is the priority
 * move — since P14 (ADR 0026) the shared preview dialog first (what would
 * change, Yes / No), then `POST /projects/{id}/priority` with the preview
 * token, exactly as the move control on every card. The drop stays pending
 * until Yes; No snaps it back.
 *
 * P36 (ADR 0050): dropping a card at another place in its OWN column is the
 * re-rank — the same preview dialog, then `POST /projects/{id}/band-rank`. The
 * drop is sent relative to a visible card (`before` the card below the drop
 * line, or `after` the last visible card), so it is well defined on a
 * filtered board. The served `band_rank` is shown as "#n"; nothing is re-sorted.
 *
 * Owner request 2026-11-17: a session that may re-rank also gets ↑ / ↓ and an
 * editable position on every card (both layouts). They send `{ to_rank }` (the
 * target position in the full band) through the same preview side panel. ↓ is
 * disabled only on a card the served data says is last in its band; otherwise a
 * position past the end is answered by the server (422 `BAD_RANK`).
 *
 * Drag is hand-built (no library): native HTML drag events for the pointer, and
 * a keyboard pick-up / arrow / drop on each card's handle, announced through a
 * live region. A drop is shown optimistically and rolled back on any error or
 * cancel; the column's served count is never recounted here (I9).
 */
export default function PriorityBoardPage(): React.JSX.Element {
  return (
    <PriorityMoveProvider>
      <PageHeader
        title="Priority board"
        description="Every project by priority. Drag a card to another column, or use its priority control, to change its priority; drag it up or down within a column to change its position, which is its scheduling order inside that priority. The timeline recalculates after either move."
        actions={
          <>
            <CountrySegmented />
            <HubFilterChip />
          </>
        }
      />
      <PriorityBoardView />
    </PriorityMoveProvider>
  );
}

/** P21-T05: the Matrix View panel's filters, shared with the scoring grid. */
export interface SharedBoardFilters {
  /** P31: multi-select; empty = all. */
  category: ProjectCategory[];
  type: ProjectType[];
  status: ProjectStatus | null;
  /** The shared project search (undebounced; debounced here like the grid). */
  search: string;
  onSearchChange: (next: string) => void;
}

export interface PriorityBoardViewProps {
  /** Given inside the Prioritization Matrix: Category / Type / Status / search come from its View panel. */
  shared?: SharedBoardFilters;
  /** Matrix Scenario mode is on. */
  scenarioActive?: boolean;
  /** Projects with a staged (uncommitted) score change in the scenario. */
  scenarioStagedIds?: ReadonlySet<string>;
  /** Inside the Matrix on wide screens: render the toolbar into this element (the View panel). */
  toolbarSlot?: HTMLElement | null;
  /** The View panel is stuck (compact): the toolbar hides its visible labels. */
  compactToolbar?: boolean;
  /** Height of the board (the Matrix passes the same offset the grid uses, so the column
   *  headers sit below the stuck View panel). Columns scroll inside it. */
  height?: string;
}

/**
 * The board itself (no page header). Since P21-T05 it is the "Priority board"
 * tab of the Prioritization Matrix (`/matrix?view=board`); the hub / country
 * filter is global and the move flow host is the caller's `PriorityMoveProvider`.
 */
export function PriorityBoardView({
  shared,
  scenarioActive = false,
  scenarioStagedIds = NO_STAGED,
  toolbarSlot = null,
  compactToolbar = false,
  height,
}: PriorityBoardViewProps = {}): React.JSX.Element {
  const hub = useHubSelection();
  // P13-T12: toolbar filters, all applied server-side; the search is debounced.
  const [ownToolbar, setOwnToolbar] = React.useState<BoardToolbarState>(EMPTY_TOOLBAR);
  const toolbar = React.useMemo<BoardToolbarState>(
    () =>
      shared
        ? {
            ...ownToolbar,
            search: shared.search,
            category: shared.category,
            type: shared.type,
            // The Matrix View panel still picks one status (not converted in this pass).
            status_: shared.status ? [shared.status] : [],
          }
        : ownToolbar,
    [shared, ownToolbar],
  );
  const setToolbar = React.useCallback(
    (next: BoardToolbarState) => {
      if (shared && next.search !== shared.search) shared.onSearchChange(next.search);
      setOwnToolbar(next);
    },
    [shared],
  );
  const debouncedSearch = useDebouncedValue(toolbar.search.trim(), 300);
  const [layout, setLayout] = useBoardLayout();
  const filters = React.useMemo<PriorityBoardFilters>(() => {
    return {
      q: debouncedSearch ? debouncedSearch.slice(0, SEARCH_MAX) : undefined,
      category: selectionParam(toolbar.category),
      type: selectionParam(toolbar.type),
      // Multi-select (owner ask 2026-11-13): repeated params.
      status_: selectionParam(toolbar.status_),
      leader_engineer_id: selectionParam(toolbar.leader),
    };
  }, [debouncedSearch, toolbar.category, toolbar.type, toolbar.status_, toolbar.leader]);
  const isFiltered = Object.values(filters).some((v) => v !== undefined);
  const query = usePriorityBoard(hub, filters);
  const canReadDashboard = usePermission('dashboard').read;
  const canReadCapacity = usePermission('capacity').read;
  const facets = useBoardLeaderFacets(hub, canReadDashboard);
  const queryClient = useQueryClient();
  const host = usePriorityMoveHost();
  const canWrite = usePermission('project_registration').write;
  const me = useSession().me;
  const instructionsId = React.useId();

  const [overrides, setOverrides] = React.useState<BoardOverrides>({});
  const [pointerDrag, setPointerDrag] = React.useState<PointerDrag | null>(null);
  const [hoverColumn, setHoverColumn] = React.useState<ProjectPriority | null>(null);
  /** P36: the drop slot under the pointer in the dragged card's own column. */
  const [hoverSlot, setHoverSlot] = React.useState<number | null>(null);
  const [lift, setLift] = React.useState<KeyboardLift | null>(null);
  const [announcement, setAnnouncement] = React.useState('');

  const busy = host?.busy ?? false;
  const dragEnabled = canWrite && host !== null && !busy;

  const columns = React.useMemo(
    () => (query.data ? applyOverrides(query.data.columns, overrides) : []),
    [query.data, overrides],
  );

  const canDragCard = React.useCallback(
    (item: DisplayCard) =>
      dragEnabled && !item.pending && (allowedTargets(item.card, item.servedPriority).length > 0 || canRerank(item.card)),
    [dragEnabled],
  );

  const columnOf = React.useCallback(
    (priority: ProjectPriority): DisplayColumn | null => columns.find((c) => c.priority === priority) ?? null,
    [columns],
  );

  const clearOverride = React.useCallback((projectId: string) => {
    setOverrides((cur) => {
      if (!(projectId in cur)) return cur;
      const next = { ...cur };
      delete next[projectId];
      return next;
    });
  }, []);

  /** A drop, from either input: show it, then hand it to the shared move flow. */
  const drop = React.useCallback(
    (item: DisplayCard, to: ProjectPriority) => {
      const { card, servedPriority: from } = item;
      if (!host || to === from || !allowedTargets(card, from).includes(to)) return;
      setOverrides((cur) => ({ ...cur, [card.project_id]: { priority: to } }));
      setAnnouncement(`${card.name} dropped on ${columnName(to)}, last in that column. Confirm the move.`);
      host.requestMove(
        { projectId: card.project_id, projectName: card.name, priority: from, status: card.status },
        to,
        {
          onSettled: (outcome) => {
            if (outcome === 'accepted') {
              // The server has the new priority; keep the card where it was
              // dropped until the refetched board shows it there.
              void queryClient
                .invalidateQueries({ queryKey: ['priority-board'] })
                .finally(() => clearOverride(card.project_id));
              setAnnouncement(`${card.name} moved to ${columnName(to)}.`);
              return;
            }
            clearOverride(card.project_id);
            setAnnouncement(
              outcome === 'rejected'
                ? `${card.name} was not moved. It is back in ${columnName(from)}.`
                : `Move cancelled. ${card.name} stays in ${columnName(from)}.`,
            );
          },
        },
      );
    },
    [clearOverride, host, queryClient],
  );

  /** P36: how a re-rank ended (drop or `to_rank`): keep the shown place until the refetch, or roll back. */
  const rankSettled = React.useCallback(
    (item: DisplayCard, where: string) =>
      (outcome: PriorityMoveOutcome): void => {
        const { card, servedPriority: band } = item;
        if (outcome === 'accepted') {
          // Keep the card where it was shown until the refetched board serves
          // its new band_rank and order.
          void queryClient
            .invalidateQueries({ queryKey: ['priority-board'] })
            .finally(() => clearOverride(card.project_id));
          setAnnouncement(`${card.name} moved to ${where}.`);
          return;
        }
        clearOverride(card.project_id);
        setAnnouncement(
          outcome === 'rejected'
            ? `${card.name} was not moved. It is back in its place in ${columnName(band)}.`
            : `Move cancelled. ${card.name} keeps its place in ${columnName(band)}.`,
        );
      },
    [clearOverride, queryClient],
  );

  /** P36: a drop inside the card's own column — show it, then the shared re-rank flow. */
  const rankDrop = React.useCallback(
    (item: DisplayCard, column: DisplayColumn, placement: BandRankAnchorPlacement) => {
      const { card, servedPriority: band } = item;
      if (!host) return;
      const position = positionForPlacement(column.cards, card.project_id, placement);
      const where = rankPositionCopy(position, columnName(band));
      setOverrides((cur) => ({ ...cur, [card.project_id]: { priority: band, placement } }));
      setAnnouncement(`${card.name} dropped at ${where}. Confirm the move.`);
      host.requestRankMove(
        { projectId: card.project_id, projectName: card.name, priority: band, status: card.status },
        placement,
        { position, fromPosition: card.band_rank, onSettled: rankSettled(item, where) },
      );
    },
    [host, rankSettled],
  );

  /**
   * Owner request 2026-11-17: ↑ / ↓ (served rank ± 1) or a typed position — the
   * same preview side panel with `{ to_rank }`. The card is shown next to the
   * visible card holding that rank now, or stays put (pending) when none is shown.
   */
  const rankTo = React.useCallback(
    (item: DisplayCard, toRank: number) => {
      const { card, servedPriority: band } = item;
      const from = card.band_rank;
      if (!host || from === null || item.pending || !Number.isSafeInteger(toRank) || toRank < 1 || toRank === from) return;
      const column = columnOf(band);
      const shown = column ? displayPlacementForRank(column.cards, card.project_id, toRank) : null;
      const where = rankPositionCopy(toRank, columnName(band));
      setLift(null);
      setOverrides((cur) => ({
        ...cur,
        [card.project_id]: shown ? { priority: band, placement: shown } : { priority: band, rankPending: true },
      }));
      setAnnouncement(`${card.name}: move to ${where}. Confirm the move.`);
      host.requestRankMove(
        { projectId: card.project_id, projectName: card.name, priority: band, status: card.status },
        { to_rank: toRank },
        { position: toRank, fromPosition: from, onSettled: rankSettled(item, where) },
      );
    },
    [columnOf, host, rankSettled],
  );

  const canRankCard = React.useCallback(
    (item: DisplayCard) => canWrite && host !== null && canRerank(item.card),
    [canWrite, host],
  );

  /** Served-data-only "last in the band": the column shows the whole band (P36-R02: no count is derived). */
  const fullBandShown = !isFiltered && !hasHubSelection(hub) && me?.hub_scope_all === true;
  const lastInBandIds = React.useMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    for (const column of query.data?.columns ?? []) {
      const id = lastServedIdIfFullBand(column, fullBandShown);
      if (id) ids.add(id);
    }
    return ids;
  }, [fullBandShown, query.data]);

  const findItem = React.useCallback(
    (projectId: string): DisplayCard | null => {
      for (const column of columns) {
        const hit = column.cards.find((c) => c.card.project_id === projectId);
        if (hit) return hit;
      }
      return null;
    },
    [columns],
  );

  // ---- pointer (native HTML drag and drop) ----
  const onPointerDragStart = React.useCallback((item: DisplayCard, event: React.DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.card.project_id);
    setLift(null);
    setPointerDrag({
      projectId: item.card.project_id,
      from: item.servedPriority,
      allowed: allowedTargets(item.card, item.servedPriority),
      canRank: canRerank(item.card),
    });
  }, []);

  const onPointerDragEnd = React.useCallback(() => {
    setPointerDrag(null);
    setHoverColumn(null);
    setHoverSlot(null);
  }, []);

  const onColumnDragOver = React.useCallback(
    (priority: ProjectPriority, event: React.DragEvent<HTMLElement>, slot: number | null) => {
      if (!pointerDrag) return;
      const home = priority === pointerDrag.from;
      if (home ? !pointerDrag.canRank : !pointerDrag.allowed.includes(priority)) return;
      event.preventDefault(); // allow the drop
      event.dataTransfer.dropEffect = 'move';
      if (hoverColumn !== priority) setHoverColumn(priority);
      if (!home) {
        if (hoverSlot !== null) setHoverSlot(null);
      } else if (slot !== null && slot !== hoverSlot) {
        setHoverSlot(slot);
      }
    },
    [hoverColumn, hoverSlot, pointerDrag],
  );

  const onColumnDragLeave = React.useCallback((priority: ProjectPriority, event: React.DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setHoverColumn((cur) => (cur === priority ? null : cur));
    setHoverSlot(null);
  }, []);

  const onColumnDrop = React.useCallback(
    (priority: ProjectPriority, event: React.DragEvent<HTMLElement>, slot: number | null) => {
      if (!pointerDrag) return;
      event.preventDefault();
      const item = findItem(pointerDrag.projectId);
      const at = slot ?? hoverSlot;
      setPointerDrag(null);
      setHoverColumn(null);
      setHoverSlot(null);
      if (!item) return;
      if (priority === pointerDrag.from) {
        const column = columnOf(priority);
        if (!pointerDrag.canRank || !column || at === null) return;
        const placement = placementForSlot(column.cards, at, item.card.project_id);
        if (placement) rankDrop(item, column, placement);
        return;
      }
      if (pointerDrag.allowed.includes(priority)) drop(item, priority);
    },
    [columnOf, drop, findItem, hoverSlot, pointerDrag, rankDrop],
  );

  // ---- keyboard (pick up with Space/Enter; Left/Right choose a column, Up/Down a position in
  // the own column (P36, D36-4); Space/Enter drops; Escape cancels) ----
  /** "position 2 in P1" for a keyboard index, from the served band_ranks (copy only). */
  const keyboardPosition = React.useCallback(
    (column: DisplayColumn, projectId: string, index: number): string => {
      const dragged = column.cards.findIndex((c) => c.card.project_id === projectId);
      const placement = index === dragged ? null : placementForSlot(column.cards, slotForIndex(index, dragged), projectId);
      const own = column.cards[dragged]?.card.band_rank ?? null;
      const position = placement ? positionForPlacement(column.cards, projectId, placement) : own;
      return rankPositionCopy(position ?? index + 1, columnName(column.priority));
    },
    [],
  );

  const onHandleKeyDown = React.useCallback(
    (item: DisplayCard, event: React.KeyboardEvent<HTMLButtonElement>) => {
      const { card, servedPriority } = item;
      const isLifted = lift?.projectId === card.project_id;
      const key = event.key;
      const home = columnOf(servedPriority);
      const dragged = home ? home.cards.findIndex((c) => c.card.project_id === card.project_id) : -1;
      if (!isLifted) {
        if (key !== ' ' && key !== 'Enter') return;
        event.preventDefault();
        const allowed = allowedTargets(card, servedPriority);
        const canRank = canRerank(card) && home !== null && dragged >= 0;
        setLift({ projectId: card.project_id, from: servedPriority, allowed, canRank, target: servedPriority, index: Math.max(dragged, 0) });
        const keys = [
          canRank ? 'the up and down arrow keys to change its position in the column' : null,
          allowed.length > 0 ? 'the left and right arrow keys to choose another column' : null,
        ].filter((k): k is string => k !== null);
        const at = canRank && home ? `, ${keyboardPosition(home, card.project_id, dragged)}` : '';
        setAnnouncement(
          `Picked up ${card.name} in ${columnName(servedPriority)}${at}. Use ${keys.join(' and ')}, Space to drop, Escape to cancel.`,
        );
        return;
      }
      if (key === 'ArrowRight' || key === 'ArrowLeft') {
        event.preventDefault();
        const direction = key === 'ArrowRight' ? 1 : -1;
        const target = stepTarget(lift.target, lift.from, lift.allowed, direction);
        setLift({ ...lift, target });
        if (target !== lift.from) {
          setAnnouncement(`Over ${columnName(target)}. It would go last there.`);
        } else {
          setAnnouncement(
            lift.canRank && home
              ? `Over ${columnName(target)}, its current column: ${keyboardPosition(home, card.project_id, lift.index)}.`
              : `Over ${columnName(target)}, its current column.`,
          );
        }
        return;
      }
      if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End') {
        event.preventDefault();
        if (!lift.canRank || !home || lift.target !== lift.from) {
          setAnnouncement(
            lift.canRank
              ? `Up and down change the position in ${columnName(lift.from)} only. Move back to that column first.`
              : `${card.name} cannot be reordered in its column.`,
          );
          return;
        }
        const last = home.cards.length - 1;
        const index =
          key === 'Home' ? 0 : key === 'End' ? last : Math.min(last, Math.max(0, lift.index + (key === 'ArrowDown' ? 1 : -1)));
        setLift({ ...lift, index });
        const where = keyboardPosition(home, card.project_id, index);
        const spoken = `${where[0]?.toUpperCase() ?? ''}${where.slice(1)}`;
        setAnnouncement(index === dragged ? `${spoken}, its current place.` : `${spoken}.`);
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        setLift(null);
        setAnnouncement(`Move cancelled. ${card.name} stays in ${columnName(servedPriority)}.`);
        return;
      }
      if (key === ' ' || key === 'Enter') {
        event.preventDefault();
        const { target, index } = lift;
        setLift(null);
        if (target !== lift.from) {
          drop(item, target);
          return;
        }
        const placement =
          lift.canRank && home && index !== dragged
            ? placementForSlot(home.cards, slotForIndex(index, dragged), card.project_id)
            : null;
        if (!placement || !home) {
          setAnnouncement(`${card.name} stays where it is in ${columnName(servedPriority)}.`);
          return;
        }
        rankDrop(item, home, placement);
      }
    },
    [columnOf, drop, keyboardPosition, lift, rankDrop],
  );

  const onHandleBlur = React.useCallback((item: DisplayCard) => {
    setLift((cur) => (cur?.projectId === item.card.project_id ? null : cur));
  }, []);

  const activeDrag = pointerDrag ?? lift;
  // The whole column is the target of a cross-column move; a move inside the
  // column is shown by the drop line instead.
  const dropTarget = pointerDrag
    ? hoverColumn !== pointerDrag.from
      ? hoverColumn
      : null
    : lift && lift.target !== lift.from
      ? lift.target
      : null;

  /** P36: the drop line's slot in the dragged card's own column, or null (no line on a no-op place). */
  const indicator = React.useMemo((): { priority: ProjectPriority; slot: number } | null => {
    const drag = pointerDrag ?? lift;
    if (!drag?.canRank) return null;
    const column = columns.find((c) => c.priority === drag.from);
    const dragged = column ? column.cards.findIndex((c) => c.card.project_id === drag.projectId) : -1;
    if (dragged < 0) return null;
    let slot: number | null = null;
    if (pointerDrag) slot = hoverColumn === pointerDrag.from ? hoverSlot : null;
    else if (lift && lift.target === lift.from) slot = slotForIndex(lift.index, dragged);
    if (slot === null || isNoopSlot(slot, dragged)) return null;
    return { priority: drag.from, slot };
  }, [columns, hoverColumn, hoverSlot, lift, pointerDrag]);

  return (
    <BoardScenarioContext.Provider value={scenarioActive ? scenarioStagedIds : NO_STAGED}>
      <p id={instructionsId} className="sr-only">
        Press Space or Enter to pick the card up. The up and down arrow keys change its position inside its column (its
        scheduling order within that priority); the left and right arrow keys choose another priority column, where it goes
        last. Space or Enter drops it, and Escape cancels. Each card also has a priority menu, move up and move down
        buttons, and a position field: type a number and press Enter.
      </p>
      <p aria-live="assertive" aria-atomic="true" className="sr-only" data-testid="board-announcer">
        {announcement}
      </p>

      {!canWrite ? (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-text-muted" role="note" data-testid="board-read-only">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          You can view the board and each project&rsquo;s position. Moving or reordering a project needs Registration write
          access.
        </p>
      ) : null}
      {query.data && query.data.run_id === null ? (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-text-muted" role="note">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          There is no active schedule run yet, so projected finish and health are not available.
        </p>
      ) : null}

      {scenarioActive ? (
        <p className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-text-muted" role="note" data-testid="board-scenario-note">
          <Badge tone="warning">Scenario</Badge>
          Cards with a staged score change are marked. Scores and bands stay as saved until the scenario is applied.
        </p>
      ) : null}
      {shared ? (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-text-muted" role="note" data-testid="board-scope-note">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          The board lists projects with a set priority whose status can be scheduled; Cancelled, Commercialized and On
          Hold projects appear in the scoring grid only.
        </p>
      ) : null}

      <HubLoadStrip hub={hub} enabled={canReadCapacity} />

      {(() => {
        const bar = (
          <BoardToolbar
            value={toolbar}
            onChange={setToolbar}
            embedded={shared !== undefined}
            inPanel={toolbarSlot !== null}
            compact={toolbarSlot !== null && compactToolbar}
            leaders={canReadDashboard && !facets.isError ? (facets.data?.leaders ?? []) : null}
            layoutToggle={<BoardLayoutToggle value={layout} onChange={setLayout} />}
          />
        );
        return toolbarSlot ? createPortal(bar, toolbarSlot) : bar;
      })()}

      {query.isPending ? (
        <div className="grid grid-cols-5 gap-3" aria-hidden="true">
          {PROJECT_PRIORITIES.map((p) => (
            <Skeleton key={p} className="h-96 w-full" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState description="The priority board could not be loaded." onRetry={() => void query.refetch()} />
      ) : columns.every((c) => c.cards.length === 0) ? (
        isFiltered ? (
          <EmptyState title="No projects match these filters" description="Clear a filter or change the search to see more projects." />
        ) : (
          <EmptyState
            title="No prioritised projects"
            description={hasHubSelection(hub) ? 'No project in this selection has a priority yet.' : 'No project in your scope has a priority yet.'}
          />
        )
      ) : (
        <div
          className="relative grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2"
          style={height ? { height } : undefined}
          data-testid="priority-board"
          data-layout={layout}
          data-fit={height ? 'true' : undefined}
        >
          {columns.map((column) => (
            <BoardColumn
              key={column.priority}
              column={column}
              layout={layout}
              fit={height !== undefined}
              canDragCard={canDragCard}
              canRankCard={canRankCard}
              rankInert={busy}
              lastInBandIds={lastInBandIds}
              onRankTo={rankTo}
              liftedId={lift?.projectId ?? null}
              isDropTarget={dropTarget === column.priority}
              acceptsDrop={activeDrag !== null && activeDrag.allowed.includes(column.priority)}
              indicatorSlot={indicator?.priority === column.priority ? indicator.slot : null}
              instructionsId={instructionsId}
              onPointerDragStart={onPointerDragStart}
              onPointerDragEnd={onPointerDragEnd}
              onHandleKeyDown={onHandleKeyDown}
              onHandleBlur={onHandleBlur}
              onColumnDragOver={onColumnDragOver}
              onColumnDragLeave={onColumnDragLeave}
              onColumnDrop={onColumnDrop}
            />
          ))}
        </div>
      )}
    </BoardScenarioContext.Provider>
  );
}
