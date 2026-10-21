import { formatDecimal, formatInteger } from '@/lib/format';

/** Display formatting only: the value is the server's field, never derived here. */
export function num(value: number): string {
  return formatDecimal(value);
}
export function int(value: number): string {
  return formatInteger(value);
}
