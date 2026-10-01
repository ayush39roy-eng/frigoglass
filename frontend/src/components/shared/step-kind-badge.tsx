import * as React from 'react';

import { cn } from '@/lib/utils';
import type { WorkflowStepKind } from '@/types/enums';

import { STEP_KIND_META } from './step-kind-meta';

/**
 * The three step kinds (ADR 0007): what a step BOOKS. Tone + text, never
 * colour alone. Shared by the Gantt's step rows (compact) and the Workflow
 * Settings step list (full label).
 *
 *   design  — books the project leader          (brand blue tint)
 *   lab     — books a chamber                    (teal tint)
 *   elapsed — books nothing, occupies calendar   (neutral outline)
 */
export function StepKindBadge({
  kind,
  compact = false,
  className,
}: {
  kind: WorkflowStepKind;
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  const meta = STEP_KIND_META[kind];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-sm border px-1 text-[0.625rem] font-semibold uppercase leading-4',
        meta.className,
        className,
      )}
      title={meta.description}
      data-kind={kind}
    >
      {compact ? meta.short : meta.label}
    </span>
  );
}
