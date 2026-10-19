import type { WorkflowId } from '@/types/enums';

/** The B-equivalent reference category per workflow (API_CONTRACT_P13 §5). */
export function referenceCategory(workflow: WorkflowId): 'B' | 'B-OEM' {
  return workflow === 'OEM' ? 'B-OEM' : 'B';
}

const ratioFormatter = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A served 2-dp ratio, printed as served ("2.86×"); null → "—". */
export function formatRatio(ratio: number | null): string {
  return ratio === null ? '—' : `${ratioFormatter.format(ratio)}×`;
}
