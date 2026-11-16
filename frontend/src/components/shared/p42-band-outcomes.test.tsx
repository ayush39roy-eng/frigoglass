import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { PRIORITY_LABELS } from '@/types/enums';

import { PriorityBandPill } from './priority-band-pill';
import { PRIORITY_BAND_TITLE, priorityBandName } from './priority-band-meta';
import { BandOutcomeChip, ProjectedFinishChip } from './project-outcome-chips';
import { BAND_OUTCOME_META, nonCountingOutcome, servedNonCountingOutcome } from './schedule-outcome-meta';

/**
 * P42-T04 (ADR 0056): band labels (R42-1) and the two outcomes that do not
 * count toward the year (R42-3 / R42-4). Every chip prints the SERVED
 * `outcome_label`; the browser composes no copy and derives no bucket.
 */

describe('P42 band labels (R42-1)', () => {
  it('mirrors the served labels', () => {
    expect(PRIORITY_LABELS).toEqual({
      P1: 'Must do this year',
      P2: 'Good to have this year',
      P3: 'In queue',
      P4: 'Miscellaneous',
      Q: 'Unprioritised',
    });
  });

  it('names a band "P1 · Must do this year", and Q as "Q"', () => {
    expect(priorityBandName('P1')).toBe('P1 · Must do this year');
    expect(priorityBandName('P3')).toBe('P3 · In queue');
    expect(priorityBandName('P4')).toBe('P4 · Miscellaneous');
    expect(priorityBandName('Q')).toBe('Q');
    // A payload's own served label wins over the static mirror.
    expect(priorityBandName('P2', 'Served label')).toBe('P2 · Served label');
    expect(priorityBandName('Q', 'Unprioritised')).toBe('Q');
  });

  it('puts the band label in the priority pill tooltip; the pill text stays the code', () => {
    renderWithProviders(<PriorityBandPill priority="P2" />);
    const pill = screen.getByTitle(PRIORITY_BAND_TITLE.P2);
    expect(pill).toHaveTextContent(/^P2$/);
    expect(PRIORITY_BAND_TITLE.P2).toBe('Priority band P2 — Good to have this year');
    expect(PRIORITY_BAND_TITLE.Q).toBe('Priority band Q — Unprioritised');
  });
});

describe('P42 outcome chips (R42-3 / R42-4)', () => {
  it('prints the served queued text verbatim', () => {
    renderWithProviders(<BandOutcomeChip outcome="QUEUED" label="Queued — fits by W40" />);
    const chip = screen.getByTestId('band-outcome-chip');
    expect(chip).toHaveTextContent('Queued — fits by W40');
    expect(chip).toHaveAttribute('data-outcome', 'QUEUED');
    expect(chip).toHaveAttribute('title', BAND_OUTCOME_META.QUEUED.description);
  });

  it('prints "Not scheduled (P4)" for a P4 / Q that is never planned', () => {
    renderWithProviders(<BandOutcomeChip outcome="NOT_SCHEDULED_PRIORITY" label="Not scheduled (P4)" />);
    expect(screen.getByTestId('band-outcome-chip')).toHaveTextContent('Not scheduled (P4)');
  });

  it('falls back to the short name only when no label is served', () => {
    renderWithProviders(<BandOutcomeChip outcome="QUEUED" label={null} />);
    expect(screen.getByTestId('band-outcome-chip')).toHaveTextContent(/^Queued$/);
  });

  it('a queued project is never "Past W52 → spillover" on the finish chip', () => {
    renderWithProviders(
      <ProjectedFinishChip projectedEndWeek={60} withinYear={false} outcome="QUEUED" outcomeLabel="Queued — after W52" />,
    );
    expect(screen.queryByTestId('finish-chip')).toBeNull();
    expect(screen.getByTestId('band-outcome-chip')).toHaveTextContent('Queued — after W52');
    expect(screen.queryByText(/Past W52/)).toBeNull();
  });

  it('a counting project keeps the pre-P42 finish chip', () => {
    renderWithProviders(<ProjectedFinishChip projectedEndWeek={40} withinYear outcome={null} />);
    expect(screen.getByTestId('finish-chip')).toHaveTextContent('Within year');
    expect(screen.queryByTestId('band-outcome-chip')).toBeNull();
  });

  it('reads the non-counting bucket from the stored flags only', () => {
    expect(servedNonCountingOutcome({ counts_toward_year: false, not_scheduled_priority: true })).toBe('NOT_SCHEDULED_PRIORITY');
    expect(servedNonCountingOutcome({ counts_toward_year: false, not_scheduled_priority: false })).toBe('QUEUED');
    expect(servedNonCountingOutcome({ counts_toward_year: true, not_scheduled_priority: false })).toBeNull();
    // Not in the active run: no judgement.
    expect(servedNonCountingOutcome({ counts_toward_year: null, not_scheduled_priority: null })).toBeNull();
    expect(servedNonCountingOutcome({})).toBeNull();
  });

  it('narrows a served bucket to the two non-counting outcomes', () => {
    expect(nonCountingOutcome('QUEUED')).toBe('QUEUED');
    expect(nonCountingOutcome('NOT_SCHEDULED_PRIORITY')).toBe('NOT_SCHEDULED_PRIORITY');
    expect(nonCountingOutcome('LEFT_OUT')).toBeNull();
    expect(nonCountingOutcome(null)).toBeNull();
    expect(nonCountingOutcome(undefined)).toBeNull();
  });

  it('has no serious or critical axe violations', async () => {
    const { container } = renderWithProviders(
      <div>
        <BandOutcomeChip outcome="QUEUED" label="Queued — no slot" />
        <BandOutcomeChip outcome="NOT_SCHEDULED_PRIORITY" label="Not scheduled (P4)" />
        <PriorityBandPill priority="Q" />
      </div>,
    );
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
