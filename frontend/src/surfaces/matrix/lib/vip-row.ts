import type { PriorityMatrixRow } from '../api/types';

/** Served VIP pin (`projects.is_vip`, ADR 0027); absent from an older API reads as not VIP. */
export function isVipRow(row: PriorityMatrixRow): boolean {
  return (row as Partial<PriorityMatrixRow>).is_vip === true;
}
