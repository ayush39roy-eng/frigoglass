import * as React from 'react';

import { barGeometry, stepDragResult, type WeekScale } from '@/surfaces/gantt/lib/gantt-coordinates';
import type { OverlapStep } from '@/surfaces/gantt/lib/step-overlap';

import type { ImportResultStep } from '../import-types';
import { moveDrop, type DropEdit } from '../gantt-geometry';

/**
 * Pointer drag on one What-if step bar (ADR 0043 + ADR 0019 gestures, as the live Gantt):
 * - body (only `editable === "move_resize"`): move → earliest start; dropped onto the
 *   work above it → overlap (`overlapForDrop`, clamped to the predecessor's start);
 * - right edge (`move_resize` / `resize`): duration in weeks.
 * The drop only records an edit; the bar's new place is the server's next answer.
 * Mouse / touch only; the keyboard path is the row's "Edit timing" dialog.
 */

interface Drag {
  mode: 'move' | 'resize';
  pointerId: number;
  startX: number;
  dx: number;
}

export function StepDragHandles({
  step,
  stepName,
  siblings,
  scale,
  rowHeight,
  frontier,
  baseYear,
  disabled,
  onDrop,
}: {
  step: ImportResultStep;
  stepName: string;
  siblings: readonly OverlapStep[];
  scale: WeekScale;
  rowHeight: number;
  frontier: number;
  baseYear: number;
  disabled: boolean;
  onDrop: (edit: DropEdit) => void;
}): React.JSX.Element | null {
  const [drag, setDrag] = React.useState<Drag | null>(null);

  React.useEffect(() => {
    if (!drag) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrag(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag]);

  if (step.editable === 'none' || step.start_week === null || step.end_week === null) return null;
  const visStart = Math.max(step.start_week, scale.originWeek);
  const geom = barGeometry(visStart, step.end_week, scale);
  if (!geom) return null;
  const origin = {
    startWeek: step.start_week,
    endWeek: step.end_week,
    durationWeeks: step.duration_weeks ?? step.end_week - step.start_week + 1,
    fte: null,
  };

  const begin = (mode: Drag['mode']) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || disabled) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ mode, pointerId: e.pointerId, startX: e.clientX, dx: 0 });
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const x = e.clientX;
    const id = e.pointerId;
    setDrag((d) => (d && d.pointerId === id ? { ...d, dx: x - d.startX } : d));
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag;
    if (!d || d.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setDrag(null);
    const dx = e.clientX - d.startX;
    if (d.mode === 'move') {
      const r = moveDrop(step, siblings, dx, scale, frontier, baseYear);
      if (r.edit) onDrop(r.edit);
    } else {
      const r = stepDragResult('resize', origin, dx, scale);
      if (r.request && 'duration_override_weeks' in r.request)
        onDrop({ duration_weeks: r.request.duration_override_weeks });
    }
  };

  let ghost: { start: number; end: number; label: string } | null = null;
  if (drag && drag.dx !== 0) {
    if (drag.mode === 'move') {
      const r = moveDrop(step, siblings, drag.dx, scale, frontier, baseYear);
      ghost = {
        start: r.ghostStart,
        end: r.ghostStart + (step.end_week - step.start_week),
        label: r.label,
      };
    } else {
      const r = stepDragResult('resize', origin, drag.dx, scale);
      ghost = {
        start: r.ghost.startWeek,
        end: r.ghost.endWeek,
        label: `${String(r.workWeeks ?? origin.durationWeeks)} wks`,
      };
    }
  }
  const ghostGeom = ghost ? barGeometry(Math.max(ghost.start, scale.originWeek), ghost.end, scale) : null;
  const BODY_H = 14;
  const top = (rowHeight - BODY_H) / 2;
  const handlers = {
    onPointerMove: move,
    onPointerUp: up,
    onPointerCancel: () => setDrag(null),
  };
  const canMove = step.editable === 'move_resize';

  return (
    <div
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      data-testid="import-drag-overlay"
      data-step-id={step.step_id}
    >
      {ghostGeom && ghost ? (
        <>
          <div
            className="absolute rounded-pill border-[1.5px] border-dashed border-primary bg-primary/20"
            style={{
              left: ghostGeom.x,
              width: ghostGeom.width,
              top,
              height: BODY_H,
            }}
          />
          <span
            className="absolute z-20 whitespace-nowrap rounded bg-text px-1.5 py-0.5 text-2xs font-semibold text-surface shadow-card"
            style={{
              left: ghostGeom.x + ghostGeom.width + 6,
              top: Math.max(0, top - 2),
            }}
            data-testid="import-drag-label"
          >
            {ghost.label}
          </span>
        </>
      ) : null}
      {canMove ? (
        <div
          className="pointer-events-auto absolute cursor-grab active:cursor-grabbing"
          style={{
            left: geom.x,
            width: Math.max(0, geom.width - 8),
            top,
            height: BODY_H,
          }}
          title={`Drag to move ${stepName}; drop onto the step above to run in parallel`}
          data-testid="import-drag-body"
          onPointerDown={begin('move')}
          {...handlers}
        />
      ) : null}
      <div
        className="pointer-events-auto absolute cursor-ew-resize"
        style={{
          left: geom.x + geom.width - 8,
          width: 10,
          top,
          height: BODY_H,
        }}
        title={`Drag to change the length of ${stepName}`}
        data-testid="import-drag-resize"
        onPointerDown={begin('resize')}
        {...handlers}
      />
    </div>
  );
}
