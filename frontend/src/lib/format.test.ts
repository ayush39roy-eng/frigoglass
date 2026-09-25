import { describe, expect, it } from 'vitest';

import { formatCurrency, formatDecimal, formatInteger, formatPercent, formatWeek } from './format';

describe('format helpers (display only — no business math, CLAUDE.md)', () => {
  it('formats a currency amount the API already converted', () => {
    expect(formatCurrency(1234, 'EUR')).toContain('1,234');
  });

  it('formats a compact currency amount', () => {
    expect(formatCurrency(1_500_000, 'USD', { compact: true })).toMatch(/1\.5/);
  });

  it('formats a 0-100 API percentage', () => {
    expect(formatPercent(70)).toBe('70%');
  });

  it('formats an integer with thousands separators', () => {
    expect(formatInteger(1234)).toBe('1,234');
  });

  it('formats a 1-indexed horizon week number', () => {
    expect(formatWeek(52)).toBe('W52');
  });

  it('formats an already-computed fractional figure to at most 2 decimals', () => {
    expect(formatDecimal(9.4)).toBe('9.4');
    expect(formatDecimal(18.895)).toBe('18.9');
    expect(formatDecimal(42)).toBe('42');
  });
});
