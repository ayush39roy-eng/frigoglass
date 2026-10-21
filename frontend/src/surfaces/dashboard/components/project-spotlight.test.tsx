import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import type { CompletingWithinYearRow } from '../api/types';
import { ProjectSpotlight } from './project-spotlight';

function row(
  id: string,
  overrides: Partial<CompletingWithinYearRow> = {},
): CompletingWithinYearRow {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'A+',
    priority: 'P1',
    within_year: true,
    spillover: false,
    left_out: false,
    blocked: false,
    cat_not_allowed: false,
    last_step_end_week: 40,
    type: null,
    status: 'In Development',
    not_started: false,
    ...overrides,
  };
}

describe('ProjectSpotlight', () => {
  it('renders each card from fields on the project row, verbatim', () => {
    renderWithProviders(
      <ProjectSpotlight
        rows={[
          row('a', { project_name: 'Alpha cooler refresh', last_step_end_week: 47 }),
          row('b', {
            project_name: 'Beta chest freezer',
            hub: 'PD-India',
            category: 'B',
            priority: 'Q',
            within_year: false,
            spillover: true,
            last_step_end_week: 61,
            type: null,
            status: 'In Development',
            not_started: false,
          }),
        ]}
       
      />,
    );

    expect(screen.getByRole('link', { name: /Alpha cooler refresh/ })).toHaveAttribute(
      'href',
      '/projects/a',
    );
    // The week comes straight off `last_step_end_week` — W47, not a derived countdown.
    expect(screen.getByText('W47')).toBeInTheDocument();
    expect(screen.getByText('W47 of 52 weeks')).toBeInTheDocument();
    // ADR 0024: a finish past W52 is never printed as W61 "of 78 weeks".
    expect(screen.getByText('After W52 · spillover → 2027')).toBeInTheDocument();
    expect(screen.queryByText(/W61|of 78/)).not.toBeInTheDocument();

    // The outcome chip uses the row's own flags, with the shared precedence.
    expect(screen.getByText('Within year')).toBeInTheDocument();
    expect(screen.getByText('Spillover (past W52)')).toBeInTheDocument();
  });

  it('never fabricates a remaining-time countdown or a person', () => {
    renderWithProviders(
      <ProjectSpotlight rows={[row('a', { last_step_end_week: 47 })]} />,
    );
    // No "N weeks left" style figure anywhere: 52 − 47 is arithmetic this surface
    // is not allowed to perform (Invariant I9).
    expect(screen.queryByText(/left$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/days left/i)).not.toBeInTheDocument();
    // No avatar imagery at all — OPEN_QUESTIONS #8 blocks engineer identities and
    // the app ships on-premise with no guaranteed internet egress.
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('caps the grid and hands off to the full project table instead of rendering every project', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`p${String(i)}`));
    renderWithProviders(<ProjectSpotlight rows={rows} />);

    expect(screen.getAllByRole('link', { name: /^Project p/ })).toHaveLength(6);
    expect(screen.getByText('6 of 12')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View all projects/ })).toHaveAttribute(
      'href',
      '#all-projects',
    );
  });

  it('renders "Not scheduled" rather than a zero week when the row has no finish week', () => {
    renderWithProviders(
      <ProjectSpotlight
        rows={[row('a', { within_year: false, left_out: true, last_step_end_week: null })]}
       
      />,
    );
    expect(screen.getByText('Not scheduled')).toBeInTheDocument();
    expect(screen.getByText('Spillover · unplaced')).toBeInTheDocument();
  });

  it('frames every card on the 52-week plan year (DISPLAY_HORIZON_WEEKS), not the run horizon', () => {
    renderWithProviders(
      <ProjectSpotlight rows={[row('a', { last_step_end_week: 40 })]} />,
    );
    expect(screen.getByText('W40 of 52 weeks')).toBeInTheDocument();
  });

  it('shows an empty state, not an error, when the run has no rows', () => {
    renderWithProviders(<ProjectSpotlight rows={[]} />);
    expect(screen.getByText('No projects in this run')).toBeInTheDocument();
  });

  it('keeps the hub / category / priority chips available to assistive tech', () => {
    renderWithProviders(
      <ProjectSpotlight
        rows={[row('a', { hub: 'PD-Romania', category: 'B', priority: 'P2' })]}
       
      />,
    );
    expect(
      within(document.body).getByText('Hub PD-Romania, category B, priority P2'),
    ).toBeInTheDocument();
  });
});
