import { describe, expect, it } from 'vitest';

import {
  formatBookedPct,
  formatCurrency,
  formatDecimal,
  formatFactor,
  formatInteger,
  formatPercent,
  formatWeek,
} from './format';

describe('format helpers (display only — no business math, CLAUDE.md)', () => {
  it('formats a currency amount the API already converted', () => {
    expect(formatCurrency(1234, 'EUR')).toContain('1,234');
  });

  it('formats a compact currency amount', () => {
    expect(formatCurrency(1_500_000, 'USD', { compact: true })).toBe('US$2m');
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

  it('formats an already-computed fractional figure as a whole number', () => {
    expect(formatDecimal(9.4)).toBe('9');
    expect(formatDecimal(18.895)).toBe('19');
    expect(formatDecimal(42)).toBe('42');
    expect(formatDecimal(1834.4)).toBe('1,834');
  });

  it('formats a booked % as a whole number', () => {
    expect(formatBookedPct(265.07)).toBe('265 %');
  });

  it('keeps up to 2 decimals for FTE, chamber efficiency and ratios (formatFactor)', () => {
    expect(formatFactor(0.5)).toBe('0.5');
    expect(formatFactor(0.63)).toBe('0.63');
    expect(formatFactor(16.333)).toBe('16.33');
    expect(formatFactor(2)).toBe('2');
  });
});
