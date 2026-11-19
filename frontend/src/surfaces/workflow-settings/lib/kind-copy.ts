import type { WorkflowStepKind } from '@/types/enums';

/**
 * Step-kind copy (ADR 0007), shared by Steps & precedence and the P52 "Effort &
 * Timeline Planning" Resource row: what each kind books, and the confirm text
 * for a kind change (it moves load for every project on the workflow).
 */
const KIND_BOOKS: Record<WorkflowStepKind, string> = {
  design: "the project leader's weeks (engineer load)",
  lab: 'chamber platform-weeks (lab load)',
  elapsed: 'no resource at all (calendar time only)',
};

export function kindChangeExplanation(from: WorkflowStepKind, to: WorkflowStepKind): string {
  return `This step will book ${KIND_BOOKS[to]} instead of ${KIND_BOOKS[from]} for every project on this workflow. Engineer and chamber load on RPD Capacity shifts accordingly, and chambers must allow this step before a lab kind can book. Nothing moves until the schedule is recalculated — saving marks every schedulable project stale.`;
}
