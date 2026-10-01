import type { WorkflowStepKind } from '@/types/enums';

/** Label / tone per step kind (ADR 0007) — shared by `<StepKindBadge>`, the
 *  Workflow Settings grid and the DAG diagram. */
export const STEP_KIND_META: Record<
  WorkflowStepKind,
  { label: string; short: string; description: string; className: string }
> = {
  design: {
    label: 'Design',
    short: 'Des',
    description: 'Design step — books the project leader for every week',
    className: 'bg-primary/10 text-primary-subtle-fg border-transparent',
  },
  lab: {
    label: 'Lab',
    short: 'Lab',
    description: 'Lab step — books a chamber in the project’s lab region',
    className: 'bg-accent/15 text-accent-subtle-fg border-transparent',
  },
  elapsed: {
    label: 'Elapsed',
    short: 'Elp',
    description: 'Elapsed step — books nobody, occupies calendar weeks on the critical path',
    className: 'bg-transparent text-text-muted border-border-strong border-dashed',
  },
};

