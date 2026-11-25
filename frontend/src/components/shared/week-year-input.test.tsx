import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import axe from 'axe-core';
import * as React from 'react';

import { renderWithProviders } from '@/test/render';
import { seedSession } from '@/test/session';

import { ResolvedWeekHint, WeekYearInput } from './week-year-input';

/**
 * P62-T07 (qa-inspector gate): `WeekYearInput` (P62-F1) on its own. The wire
 * value is the ABSOLUTE plan week (ADR 0063: 2027 W5 = 57 with base year 2026);
 * an out-of-range week is emitted as NaN, never wrapped into another year.
 * Axe here counts EVERY impact level (minor / moderate too), not only the
 * serious / critical filter of `@/test/axe`.
 */
async function allAxeViolations(node: Element): Promise<string[]> {
  const result = await axe.run(node, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    resultTypes: ['violations'],
  });
  return result.violations.map((v) => `${v.id} (${v.impact ?? 'unknown'})`);
}

function Harness({ initial, onChange }: { initial: number | null; onChange: (v: number | null) => void }) {
  const [value, setValue] = React.useState<number | null>(initial);
  return (
    <WeekYearInput
      id="actual-start"
      label="Actual start"
      aria="Actual start week — Proof of Concept"
      value={value}
      invalid={value !== null && Number.isNaN(value)}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('WeekYearInput (P62-F1, gate P62-T07)', () => {
  beforeEach(() => seedSession({}));
  afterEach(() => seedSession(null));

  it('shows a served absolute week as week-of-year + year, with the resolved label', () => {
    renderWithProviders(<Harness initial={57} onChange={vi.fn()} />);
    expect(screen.getByRole('spinbutton', { name: 'Actual start week — Proof of Concept' })).toHaveValue(5);
    expect(screen.getByRole('combobox', { name: 'Year for actual start week — Proof of Concept' })).toHaveValue('2027');
    expect(screen.getByTestId('actual-start-resolved')).toHaveTextContent("W5 '27");
  });

  it('converts week + year to the absolute week; changing the year moves by 52', () => {
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={null} onChange={onChange} />);
    const week = screen.getByRole('spinbutton', { name: 'Actual start week — Proof of Concept' });
    fireEvent.change(week, { target: { value: '40' } });
    expect(onChange).toHaveBeenLastCalledWith(40);
    fireEvent.change(screen.getByRole('combobox', { name: /Year for actual start week/ }), { target: { value: '2027' } });
    expect(onChange).toHaveBeenLastCalledWith(92);
    expect(screen.getByTestId('actual-start-resolved')).toHaveTextContent("W40 '27");
  });

  it.each(['0', '53', '1.5'])('week %s is emitted as NaN (refused), not wrapped into another year', (raw) => {
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={null} onChange={onChange} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Actual start week — Proof of Concept' }), {
      target: { value: raw },
    });
    expect(Number.isNaN(onChange.mock.lastCall?.[0])).toBe(true);
  });

  it('clearing the field emits null', () => {
    const onChange = vi.fn();
    renderWithProviders(<Harness initial={10} onChange={onChange} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Actual start week — Proof of Concept' }), {
      target: { value: '' },
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('before /me resolves it falls back to the plain absolute week field', () => {
    seedSession(null);
    renderWithProviders(<Harness initial={57} onChange={vi.fn()} />, { session: null });
    expect(screen.getByRole('spinbutton', { name: 'Actual start week — Proof of Concept' })).toHaveValue(57);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('ResolvedWeekHint reads an absolute week back with its year; nothing for blank / non-week', () => {
    const { rerender } = renderWithProviders(<ResolvedWeekHint raw={57} />);
    expect(screen.getByTestId('resolved-week')).toHaveTextContent("= W5 '27");
    rerender(<ResolvedWeekHint raw="" />);
    expect(screen.queryByTestId('resolved-week')).toBeNull();
    rerender(<ResolvedWeekHint raw="0" />);
    expect(screen.queryByTestId('resolved-week')).toBeNull();
  });

  it('axe (all impacts): valid, empty, invalid and disabled states', async () => {
    const { container } = renderWithProviders(
      <div>
        <Harness initial={57} onChange={vi.fn()} />
        <WeekYearInput id="empty" label="Actual end" aria="Actual end week — PoC" value={null} onChange={vi.fn()} />
        <WeekYearInput id="bad" label="Bad" aria="Bad week — PoC" value={Number.NaN} invalid onChange={vi.fn()} />
        <WeekYearInput id="off" label="Off" aria="Off week — PoC" value={20} disabled onChange={vi.fn()} />
      </div>,
    );
    expect(await allAxeViolations(container)).toEqual([]);
  });
});
