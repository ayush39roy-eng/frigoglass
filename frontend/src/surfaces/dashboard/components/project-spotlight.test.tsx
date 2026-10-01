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
          }),
        ]}
        horizonWeeks={78}
      />,
    );

    expect(screen.getByRole('link', { name: /Alpha cooler refresh/ })).toHaveAttribute(
      'href',
      '/projects/a',
    );
    // The week comes straight off `last_step_end_week` — W47, not a derived countdown.
    expect(screen.getByText('W47')).toBeInTheDocument();
    expect(screen.getByText('W47 of 78 weeks')).toBeInTheDocument();
    expect(screen.getByText('W61 of 78 weeks')).toBeInTheDocument();

    // The outcome chip uses the row's own flags, with the shared precedence.
    expect(screen.getByText('Within year')).toBeInTheDocument();
    expect(screen.getByText('Spillover')).toBeInTheDocument();
  });

  it('never fabricates a remaining-time countdown or a person', () => {
    renderWithProviders(
      <ProjectSpotlight rows={[row('a', { last_step_end_week: 47 })]} horizonWeeks={78} />,
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
    renderWithProviders(<ProjectSpotlight rows={rows} horizonWeeks={78} />);

    expect(screen.getAllByRole('link', { name: /^Project p/ })).toHaveLength(6);
    expect(screen.getByText('6 of 12')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View all projects/ })).toHaveAttribute(
      'href',
      '#project-breakdown',
    );
  });

  it('renders "Not scheduled" rather than a zero week when the row has no finish week', () => {
    renderWithProviders(
      <ProjectSpotlight
        rows={[row('a', { within_year: false, left_out: true, last_step_end_week: null })]}
        horizonWeeks={78}
      />,
    );
    expect(screen.getByText('Not scheduled')).toBeInTheDocument();
    expect(screen.getByText('Left out')).toBeInTheDocument();
  });

  it('falls back to the DOMAIN_RULES horizon constant when the active run has not loaded', () => {
    renderWithProviders(
      <ProjectSpotlight rows={[row('a', { last_step_end_week: 40 })]} horizonWeeks={null} />,
    );
    expect(screen.getByText('W40 of 78 weeks')).toBeInTheDocument();
  });

  it('shows an empty state, not an error, when the run has no rows', () => {
    renderWithProviders(<ProjectSpotlight rows={[]} horizonWeeks={78} />);
    expect(screen.getByText('No projects in this run')).toBeInTheDocument();
  });

  it('keeps the hub / category / priority chips available to assistive tech', () => {
    renderWithProviders(
      <ProjectSpotlight
        rows={[row('a', { hub: 'PD-Romania', category: 'B', priority: 'P2' })]}
        horizonWeeks={78}
      />,
    );
    expect(
      within(document.body).getByText('Hub PD-Romania, category B, priority P2'),
    ).toBeInTheDocument();
  });
});
