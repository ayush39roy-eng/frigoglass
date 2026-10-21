import { formatDecimal } from '@/lib/format';

/** P19-T02: tone token per booking-status tone, for the compact status mark. */
export const STATUS_TONE_TEXT: Record<'danger' | 'warning' | 'success', string> = {
  danger: 'text-danger-subtle-fg',
  warning: 'text-warning-subtle-fg',
  success: 'text-success-subtle-fg',
};

/** Served booked % as "100.2%" (no space), or "—" when the served value is null. */
export function formatPctCompact(value: number | null): string {
  return value === null ? '—' : `${formatDecimal(value)}%`;
}
