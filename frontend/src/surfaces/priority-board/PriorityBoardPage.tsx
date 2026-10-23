import * as React from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { usePriorityMoveHost } from '@/components/shared/priority-move/priority-move-context';
import { PriorityMoveProvider } from '@/components/shared/priority-move/priority-move-provider';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermission } from '@/stores/session';
import { useHubFilter } from '@/stores/hub-filter';
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

import { useBoardLeaderFacets, usePriorityBoard, type PriorityBoardFilters } from './api';
import { selectionParam } from '@/lib/multi-select-filter';
import { BoardColumn } from './components/board-column';
import { BoardToolbar } from './components/board-toolbar';
import { ALL, EMPTY_TOOLBAR, SEARCH_MAX, type BoardToolbarState } from './lib/toolbar-state';
import { HubLoadStrip } from './components/hub-load-strip';
import { BoardScenarioContext } from './lib/board-scenario';
import { useBoardLayout } from './lib/board-layout';
import { BoardLayoutToggle } from './components/board-layout-toggle';
import { allowedTargets, applyOverrides, stepTarget, type BoardOverrides, type DisplayCard } from './lib/board-model';

const NO_STAGED: ReadonlySet<string> = new Set();

interface PointerDrag {
  projectId: string;
  from: ProjectPriority;
  allowed: ProjectPriority[];
}

interface KeyboardLift extends PointerDrag {
  target: ProjectPriority;
}

function columnName(p: ProjectPriority): string {
  return p === 'Q' ? 'Q (queue)' : p;
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
        description="Every project by priority. Drag a card, or use its priority control, to move it. The timeline recalculates as for any priority move."
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
  const { hubId, region } = useHubFilter();
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
            status_: shared.status ?? ALL,
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
    const pick = (v: string) => (v === ALL ? undefined : v);
    return {
      q: debouncedSearch ? debouncedSearch.slice(0, SEARCH_MAX) : undefined,
      category: selectionParam(toolbar.category),
      type: selectionParam(toolbar.type),
      status_: pick(toolbar.status_),
      leader_engineer_id: pick(toolbar.leader),
    };
  }, [debouncedSearch, toolbar.category, toolbar.type, toolbar.status_, toolbar.leader]);
  const isFiltered = Object.values(filters).some((v) => v !== undefined);
  const query = usePriorityBoard(hubId, region, filters);
  const canReadDashboard = usePermission('dashboard').read;
  const canReadCapacity = usePermission('capacity').read;
  const facets = useBoardLeaderFacets(hubId, region, canReadDashboard);
  const queryClient = useQueryClient();
  const host = usePriorityMoveHost();
  const canWrite = usePermission('project_registration').write;
  const instructionsId = React.useId();

  const [overrides, setOverrides] = React.useState<BoardOverrides>({});
  const [pointerDrag, setPointerDrag] = React.useState<PointerDrag | null>(null);
  const [hoverColumn, setHoverColumn] = React.useState<ProjectPriority | null>(null);
  const [lift, setLift] = React.useState<KeyboardLift | null>(null);
  const [announcement, setAnnouncement] = React.useState('');

  const busy = host?.busy ?? false;
  const dragEnabled = canWrite && host !== null && !busy;

  const columns = React.useMemo(
    () => (query.data ? applyOverrides(query.data.columns, overrides) : []),
    [query.data, overrides],
  );

  const canDragCard = React.useCallback(
    (item: DisplayCard) => dragEnabled && !item.pending && allowedTargets(item.card, item.servedPriority).length > 0,
    [dragEnabled],
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
      setOverrides((cur) => ({ ...cur, [card.project_id]: to }));
      setAnnouncement(`${card.name} dropped on ${columnName(to)}. Confirm the move.`);
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
    });
  }, []);

  const onPointerDragEnd = React.useCallback(() => {
    setPointerDrag(null);
    setHoverColumn(null);
  }, []);

  const onColumnDragOver = React.useCallback(
    (priority: ProjectPriority, event: React.DragEvent<HTMLElement>) => {
      if (!pointerDrag || !pointerDrag.allowed.includes(priority)) return;
      event.preventDefault(); // allow the drop
      event.dataTransfer.dropEffect = 'move';
      if (hoverColumn !== priority) setHoverColumn(priority);
    },
    [hoverColumn, pointerDrag],
  );

  const onColumnDragLeave = React.useCallback((priority: ProjectPriority, event: React.DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setHoverColumn((cur) => (cur === priority ? null : cur));
  }, []);

  const onColumnDrop = React.useCallback(
    (priority: ProjectPriority, event: React.DragEvent<HTMLElement>) => {
      if (!pointerDrag) return;
      event.preventDefault();
      const item = findItem(pointerDrag.projectId);
      setPointerDrag(null);
      setHoverColumn(null);
      if (item && pointerDrag.allowed.includes(priority)) drop(item, priority);
    },
    [drop, findItem, pointerDrag],
  );

  // ---- keyboard (pick up with Space/Enter, arrows choose a column, Space/Enter drops, Escape cancels) ----
  const onHandleKeyDown = React.useCallback(
    (item: DisplayCard, event: React.KeyboardEvent<HTMLButtonElement>) => {
      const { card, servedPriority } = item;
      const isLifted = lift?.projectId === card.project_id;
      const key = event.key;
      if (!isLifted) {
        if (key !== ' ' && key !== 'Enter') return;
        event.preventDefault();
        const allowed = allowedTargets(card, servedPriority);
        setLift({ projectId: card.project_id, from: servedPriority, allowed, target: servedPriority });
        setAnnouncement(
          `Picked up ${card.name} in ${columnName(servedPriority)}. Use the left and right arrow keys to choose a column, Space to drop, Escape to cancel.`,
        );
        return;
      }
      if (key === 'ArrowRight' || key === 'ArrowLeft' || key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        const direction = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
        const target = stepTarget(lift.target, lift.from, lift.allowed, direction);
        setLift({ ...lift, target });
        setAnnouncement(target === lift.from ? `Over ${columnName(target)}, its current column.` : `Over ${columnName(target)}.`);
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
        const target = lift.target;
        setLift(null);
        if (target === lift.from) {
          setAnnouncement(`${card.name} stays in ${columnName(servedPriority)}.`);
          return;
        }
        drop(item, target);
      }
    },
    [drop, lift],
  );

  const onHandleBlur = React.useCallback((item: DisplayCard) => {
    setLift((cur) => (cur?.projectId === item.card.project_id ? null : cur));
  }, []);

  const activeDrag = pointerDrag ?? lift;
  const dropTarget = pointerDrag ? hoverColumn : lift && lift.target !== lift.from ? lift.target : null;

  return (
    <BoardScenarioContext.Provider value={scenarioActive ? scenarioStagedIds : NO_STAGED}>
      <p id={instructionsId} className="sr-only">
        Press Space or Enter to pick the card up, the left and right arrow keys to choose a priority column, Space or Enter
        to drop it there, and Escape to cancel. Each card also has a priority menu.
      </p>
      <p aria-live="assertive" aria-atomic="true" className="sr-only" data-testid="board-announcer">
        {announcement}
      </p>

      {!canWrite ? (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-text-muted" role="note" data-testid="board-read-only">
          <Info className="size-3.5 shrink-0" aria-hidden="true" />
          You can view the board. Moving a project&rsquo;s priority needs Registration write access.
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

      <HubLoadStrip hubId={hubId} region={region} enabled={canReadCapacity} />

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
            description={hubId || region ? 'No project in this selection has a priority yet.' : 'No project in your scope has a priority yet.'}
          />
        )
      ) : (
        <div
          className="grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2"
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
              liftedId={lift?.projectId ?? null}
              isDropTarget={dropTarget === column.priority}
              acceptsDrop={activeDrag !== null && activeDrag.allowed.includes(column.priority)}
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
