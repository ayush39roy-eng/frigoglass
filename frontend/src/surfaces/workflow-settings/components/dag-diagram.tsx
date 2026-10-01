import * as React from 'react';

import { STEP_KIND_META } from '@/components/shared/step-kind-meta';
import type { WorkflowStepKind } from '@/types/enums';

import { topologicalLevels, type DagStep } from '../lib/dag';

/**
 * Small inline precedence diagram, hand-built SVG: one node per step placed by
 * its longest-path level (x) and stacked within a level (y), one arrow per
 * predecessor edge. Under the strict chain it is a straight line; steps the
 * client has allowed to run in parallel appear stacked in one column.
 *
 * Node letter + a `<title>` per node/edge carry the meaning; fill by kind is a
 * secondary cue. The whole figure has an accessible summary.
 */
export interface DagDiagramProps {
  steps: ReadonlyArray<DagStep & { kind: WorkflowStepKind; name: string }>;
  workflowName: string;
}

const NODE_R = 11;
const COL_W = 44;
const ROW_H = 36;
const PAD = 16;

const KIND_FILL: Record<WorkflowStepKind, string> = {
  design: 'hsl(var(--color-primary))',
  lab: 'hsl(var(--color-accent))',
  elapsed: 'hsl(var(--color-surface))',
};
const KIND_TEXT: Record<WorkflowStepKind, string> = {
  design: 'hsl(var(--color-primary-fg))',
  lab: 'hsl(var(--color-primary-fg))',
  elapsed: 'hsl(var(--color-text))',
};

export function DagDiagram({ steps, workflowName }: DagDiagramProps): React.JSX.Element {
  const levels = topologicalLevels(steps);
  // Position: x from level, y from index within that level (sequence order).
  const ordered = [...steps].sort((a, b) => a.sequence_order - b.sequence_order);
  const perLevel = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const s of ordered) {
    const level = levels.get(s.step_id) ?? 0;
    const idx = perLevel.get(level) ?? 0;
    perLevel.set(level, idx + 1);
    pos.set(s.step_id, { x: PAD + NODE_R + level * COL_W, y: PAD + NODE_R + idx * ROW_H });
  }
  const maxLevel = Math.max(0, ...levels.values());
  const maxRows = Math.max(1, ...perLevel.values());
  const width = PAD * 2 + NODE_R * 2 + maxLevel * COL_W;
  const height = PAD * 2 + NODE_R * 2 + (maxRows - 1) * ROW_H;
  const markerId = React.useId();

  const parallelColumns = [...perLevel.values()].filter((n) => n > 1).length;
  const summary =
    parallelColumns === 0
      ? `${workflowName}: strict sequence, ${String(steps.length)} steps, nothing runs in parallel.`
      : `${workflowName}: ${String(steps.length)} steps; ${String(parallelColumns)} ${parallelColumns === 1 ? 'stage' : 'stages'} with steps running in parallel.`;

  return (
    <figure className="overflow-x-auto rounded-control border border-border bg-surface-sunken p-2" data-testid="dag-diagram">
      <svg width={width} height={height} role="img" aria-label={summary} className="block">
        <title>{summary}</title>
        <defs>
          <marker id={markerId} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 Z" fill="hsl(var(--color-text-muted))" />
          </marker>
        </defs>
        {ordered.map((s) =>
          s.predecessor_ids.map((pred) => {
            const from = pos.get(pred);
            const to = pos.get(s.step_id);
            if (!from || !to) return null;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const len = Math.hypot(dx, dy) || 1;
            const x1 = from.x + (dx / len) * NODE_R;
            const y1 = from.y + (dy / len) * NODE_R;
            const x2 = to.x - (dx / len) * (NODE_R + 1);
            const y2 = to.y - (dy / len) * (NODE_R + 1);
            return (
              <line
                key={`${pred}->${s.step_id}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="hsl(var(--color-text-muted))"
                strokeWidth={1.25}
                markerEnd={`url(#${markerId})`}
                data-edge={`${pred}->${s.step_id}`}
              >
                <title>{`${pred.slice(-1)} → ${s.step_id.slice(-1)}`}</title>
              </line>
            );
          }),
        )}
        {ordered.map((s) => {
          const p = pos.get(s.step_id);
          if (!p) return null;
          return (
            <g key={s.step_id} data-node={s.step_id}>
              <title>{`${s.step_id.slice(-1)} · ${s.name} · ${STEP_KIND_META[s.kind].label}`}</title>
              <circle
                cx={p.x}
                cy={p.y}
                r={NODE_R}
                fill={KIND_FILL[s.kind]}
                stroke={s.kind === 'elapsed' ? 'hsl(var(--color-border-strong))' : 'none'}
                strokeWidth={1.5}
                strokeDasharray={s.kind === 'elapsed' ? '3 2' : undefined}
              />
              <text
                x={p.x}
                y={p.y + 3.5}
                fontSize={10}
                fontWeight={600}
                textAnchor="middle"
                fill={KIND_TEXT[s.kind]}
              >
                {s.step_id.slice(-1)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}
