import * as React from 'react';

import { cn } from '@/lib/utils';

import {
  barGeometry,
  stepDragResult,
  type StepDragMode,
  type StepDragOrigin,
  type WeekScale,
} from '../../lib/gantt-coordinates';
import { placeDragLabel } from '../../lib/gantt-layout';
import { stepDragLabel, WORK_WEEKS_HELP } from '../../lib/step-weeks-copy';
import { useStepTimingHost, type StepTimingTarget } from './step-timing-context';

/**
 * Pointer drag on one step bar (ADR 0019 §3), drawn as an HTML layer over the
 * row's SVG bar:
 * - the bar body (only when `timing_editable === "move_resize"`) moves the bar
 *   and requests `start_not_before_week`;
 * - the right-edge handle (`"move_resize"` or `"resize"`) requests
 *   `duration_override_weeks`, a WORK figure (ADR 0032). The handle moves the
 *   CALENDAR edge; with a served FTE the dragged calendar width is turned into
 *   the largest work that fits it (`stepDragResult`), without one the mapping
 *   is 1:1 (`StepTimingTarget.spanFte`);
 * - `"none"` renders nothing at all.
 *
 * Snaps to whole weeks, shows a ghost bar with a week label while dragging,
 * Escape cancels, and a drop that changes nothing sends nothing. The ghost
 * stays at the drop position while the PATCH is in flight and is removed when
 * it settles: on an error the served bar simply remains (roll back). Where the
 * bar finally lands is the next run's decision, not this layer's.
 *
 * Mouse/touch only: the keyboard path is the row's "Edit timing" dialog, so
 * these targets are hidden from assistive tech and never take focus.
 */

const HANDLE_PX = 8;
/** Wider right-edge hit area on the narrow (phone) layout, for a fingertip. */
const HANDLE_PX_TOUCH = 20;
const BODY_H = 14;
const LABEL_GAP = 6;

/** The visible timeline area in CLIENT px: the scroll viewport minus the sticky columns. */
export type TimelineViewport = () => { left: number; right: number } | null;

interface DragState {
  mode: StepDragMode;
  pointerId: number;
  startX: number;
  dx: number;
}

export function StepDragOverlay({
  target,
  scale,
  rowHeight,
  viewport,
  touch = false,
}: {
  target: StepTimingTarget;
  scale: WeekScale;
  rowHeight: number;
  /** P19-R02: keeps the drag label inside the visible timeline (flips near the right edge). */
  viewport?: TimelineViewport;
  /** P19-R02: narrow layout, a wider right-edge handle for touch. */
  touch?: boolean;
}): React.JSX.Element | null {
  const host = useStepTimingHost();
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const labelRef = React.useRef<HTMLSpanElement>(null);

  // P19-R02 (gate O1): place the live label after layout, before paint. The
  // label's `left` is owned here (not by React's style prop), so a re-render
  // never snaps it back under the sticky status column.
  React.useLayoutEffect(() => {
    const label = labelRef.current;
    const overlay = overlayRef.current;
    if (!label || !overlay) return;
    const anchorX = Number(label.dataset.anchor ?? '0');
    const vp = viewport?.() ?? null;
    const o = overlay.getBoundingClientRect();
    const visibleLeft = vp ? vp.left - o.left : 0;
    const visibleRight = vp ? vp.right - o.left : 0;
    // A label wider than the whole visible timeline (a phone) wraps to fit it
    // instead of being clipped; the dragged row is raised above its neighbours.
    label.style.whiteSpace = '';
    label.style.maxWidth = '';
    const room = visibleRight - visibleLeft - 4;
    if (room > 0 && label.offsetWidth > room) {
      label.style.whiteSpace = 'normal';
      label.style.maxWidth = `${String(room)}px`;
      label.dataset.wrapped = 'true';
    } else {
      delete label.dataset.wrapped;
    }
    const placement = placeDragLabel({
      anchorX,
      labelWidth: label.offsetWidth,
      gap: LABEL_GAP,
      visibleLeft,
      visibleRight,
    });
    label.style.left = `${String(placement.left)}px`;
    label.dataset.side = placement.side;
  });

  const cancel = React.useCallback(() => setDrag(null), []);

  // Escape cancels a drag in progress (the pointer may be anywhere).
  React.useEffect(() => {
    if (!drag) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag, cancel]);

  const { plannedStartWeek: start, plannedEndWeek: end } = target;
  if (!host || target.timingEditable === 'none' || start === null || end === null) return null;
  const origin: StepDragOrigin = {
    startWeek: start,
    endWeek: end,
    durationWeeks: target.durationWeeks ?? end - start + 1,
    fte: target.spanFte,
  };
  const geom = barGeometry(start, end, scale);
  if (!geom) return null;

  const canMove = target.timingEditable === 'move_resize';
  const handlePx = touch ? HANDLE_PX_TOUCH : HANDLE_PX;
  const top = (rowHeight - BODY_H) / 2;

  const begin = (mode: StepDragMode) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || host.busy) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ mode, pointerId: e.pointerId, startX: e.clientX, dx: 0 });
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const x = e.clientX;
    const id = e.pointerId;
    setDrag((cur) => (cur && cur.pointerId === id ? { ...cur, dx: x - cur.startX } : cur));
  };
  const end_ = (e: React.PointerEvent<HTMLDivElement>) => {
    const cur = drag;
    if (!cur || cur.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDrag(null);
    const result = stepDragResult(cur.mode, origin, e.clientX - cur.startX, scale);
    if (result.request) host.submit(target, result.request, result.ghost);
  };

  const live = drag ? stepDragResult(drag.mode, origin, drag.dx, scale) : null;
  const pending =
    host.pending && host.pending.projectId === target.projectId && host.pending.stepId === target.stepId
      ? host.pending
      : null;
  const ghost = live && live.request
    ? {
        ...live.ghost,
        label: stepDragLabel(drag?.mode ?? 'move', live.ghost, {
          kind: target.kind,
          workWeeks: live.workWeeks,
          fte: target.spanFte,
        }),
      }
    : pending
    ? { startWeek: pending.startWeek, endWeek: pending.endWeek, label: 'Saving…' }
    : null;
  const ghostGeom = ghost ? barGeometry(ghost.startWeek, ghost.endWeek, scale) : null;

  const handlers = { onPointerMove: move, onPointerUp: end_, onPointerCancel: cancel };

  return (
    <div
      ref={overlayRef}
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      data-testid="step-drag-overlay"
      data-editable={target.timingEditable}
      data-dragging={ghost ? 'true' : undefined}
    >
      {ghostGeom && ghost ? (
        <>
          <div
            className="absolute rounded-pill border-[1.5px] border-dashed border-primary bg-primary/20 motion-safe:transition-[left,width] motion-safe:duration-fast"
            style={{ left: ghostGeom.x, width: ghostGeom.width, top: top - 1, height: BODY_H + 2 }}
            data-testid="step-drag-ghost"
          />
          <span
            ref={labelRef}
            className="absolute z-[1] w-max whitespace-nowrap rounded-sm bg-text px-1.5 text-[0.625rem] font-semibold leading-4 text-surface tabular-nums shadow-pop"
            style={{ top: (rowHeight - 16) / 2 }}
            data-anchor={ghostGeom.x + ghostGeom.width}
            data-testid="step-drag-label"
          >
            {ghost.label}
          </span>
        </>
      ) : null}
      {canMove ? (
        <div
          className={cn(
            'pointer-events-auto absolute touch-none rounded-pill',
            host.busy ? 'cursor-not-allowed' : drag ? 'cursor-grabbing' : 'cursor-grab',
          )}
          style={{ left: geom.x, width: Math.max(0, geom.width - handlePx / 2), top, height: BODY_H }}
          data-testid="step-drag-body"
          title={`Drag to set the earliest start of ${target.stepName}`}
          onPointerDown={begin('move')}
          {...handlers}
        />
      ) : null}
      <div
        className={cn(
          'group/handle pointer-events-auto absolute flex touch-none items-center justify-center',
          host.busy ? 'cursor-not-allowed' : 'cursor-ew-resize',
        )}
        style={{ left: geom.x + geom.width - handlePx / 2, width: handlePx, top: top - 2, height: BODY_H + 4 }}
        data-testid="step-drag-handle"
        title={`Drag to change the duration of ${target.stepName}. ${target.kind === 'design' ? WORK_WEEKS_HELP : 'Lab and elapsed steps are not stretched by FTE.'}`}
        onPointerDown={begin('resize')}
        {...handlers}
      >
        <span className="h-full w-1 rounded-pill bg-primary/0 transition-colors group-hover/handle:bg-primary/70" />
      </div>
    </div>
  );
}
