import { describe, expect, it } from 'vitest';

import { redactFinancialFields } from './redact';

describe('redactFinancialFields', () => {
  it('redacts every known financial/PII field name at the top level', () => {
    const input = {
      name: 'X',
      tcogs_eur: 12345.67,
      selling_price_eur: 99999.99,
      gross_margin_pct: 42.5,
      customer_name: 'Coca-Cola HBC',
    };
    expect(redactFinancialFields(input)).toEqual({
      name: 'X',
      tcogs_eur: '<redacted>',
      selling_price_eur: '<redacted>',
      gross_margin_pct: '<redacted>',
      customer_name: '<redacted>',
    });
  });

  it('redacts nested occurrences (defense-in-depth for a nested payload shape)', () => {
    const input = { project: { customer_name: 'Real Customer', hub: 'R&D-Greece' } };
    expect(redactFinancialFields(input)).toEqual({
      project: { customer_name: '<redacted>', hub: 'R&D-Greece' },
    });
  });

  it('redacts inside arrays', () => {
    const input = [{ tcogs_eur: 1 }, { tcogs_eur: 2 }];
    expect(redactFinancialFields(input)).toEqual([
      { tcogs_eur: '<redacted>' },
      { tcogs_eur: '<redacted>' },
    ]);
  });

  it('leaves an already-redacted value (the normal case) unchanged', () => {
    const input = { customer_name: '<redacted>' };
    expect(redactFinancialFields(input)).toEqual({ customer_name: '<redacted>' });
  });

  it('passes through null/primitive values untouched', () => {
    expect(redactFinancialFields(null)).toBeNull();
    expect(redactFinancialFields('project.create')).toBe('project.create');
    expect(redactFinancialFields(42)).toBe(42);
  });
});
