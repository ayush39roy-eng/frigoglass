import { NOT_APPLICABLE_FILTER_VALUE, NOT_APPLICABLE_LABEL } from '@/lib/priority-applicability';

/** Served breakdown bucket key → label ("unknown" is the backend's key for a missing value, P32-R05;
 *  P57 (ADR 0067): a served "not applicable" priority key reads "Not applicable"). */
export function bucketLabel(key: string): string {
  if (key === 'unknown') return 'Unknown';
  if (key === NOT_APPLICABLE_FILTER_VALUE) return NOT_APPLICABLE_LABEL;
  return key;
}
