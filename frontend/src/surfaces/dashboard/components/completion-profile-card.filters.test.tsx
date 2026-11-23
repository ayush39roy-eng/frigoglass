import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { CompletingWithinYearRow } from '../api/types';
import { CompletionProfileCard } from './completion-profile-card';
import { servedCompleting, servedRow } from '@/surfaces/dashboard/test-fixtures';

/**
 * Owner request 2026-11-16: Hub / Project type / Category multi-selects on the
 * Completion profile card filter the card's own served rows; bars, the month's
 * weeks and the project list all use the same kept rows.
 */

function row(id: string, overrides: Partial<CompletingWithinYearRow> = {}): CompletingWithinYearRow {
  return servedRow({
    priority_applicable: true,
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
    last_step_end_week: 10,
    type: 'NM',
    status: 'In Development',
    not_started: false,
    ...overrides,
  });
}

// W10 / W11 → March 2026; W30 / W31 → July 2026.
const data = servedCompleting({
  has_active_schedule_run: true,
  schedule_run_version: 3,
  within_year_count: 4,
  spillover_count: 1,
  left_out_count: 0,
  blocked_count: 0,
  priority_delivery: [],
  regions: [],
  rows: [
    row('a', { hub: 'R&D-Greece', type: 'NM', category: 'A+', last_step_end_week: 10 }),
    row('b', { hub: 'PD-India', type: 'CO', category: 'A', last_step_end_week: 11 }),
    row('c', { hub: 'PD-India', type: 'NM', category: 'B', last_step_end_week: 30 }),
    row('d', { hub: 'OEM-HCK', type: null, category: null, last_step_end_week: 31 }),
    // Spillover: not plotted, so its hub is not offered.
    row('s', { hub: 'PD-Romania', within_year: false, spillover: true, last_step_end_week: 60 }),
  ],
});

function months(): HTMLElement {
  return screen.getByRole('list', { name: 'Within-year projects completed per month' });
}

async function pick(user: ReturnType<typeof userEvent.setup>, field: string, option: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: field }));
  const listbox = await screen.findByRole('listbox', { name: field });
  await user.click(within(listbox).getByRole('option', { name: option }));
  await user.keyboard('{Escape}');
}

describe('CompletionProfileCard filters', () => {
  it('offers only hubs, types and categories present in the plotted rows, in canonical / rank order', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompletionProfileCard data={data} />);
    const group = screen.getByRole('group', { name: 'Completion profile filters' });
    expect(within(group).getByRole('button', { name: 'Hub' })).toHaveTextContent('All hubs');

    await user.click(screen.getByRole('button', { name: 'Hub' }));
    let list = await screen.findByRole('listbox', { name: 'Hub' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All hubs',
      'R&D-Greece',
      'PD-India',
      'OEM-HCK',
    ]);
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Project type' }));
    list = await screen.findByRole('listbox', { name: 'Project type' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All types',
      'New Model',
      'Cost Optimization',
      'Unmapped',
    ]);
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Category' }));
    list = await screen.findByRole('listbox', { name: 'Category' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All categories',
      'A+',
      'A',
      'B',
      'Unmapped',
    ]);
  });

  it('filters by hub, with a count badge and a "Filtered: N of M" note', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompletionProfileCard data={data} />);
    expect(screen.queryByTestId('completion-profile-filtered-note')).not.toBeInTheDocument();
    expect(within(months()).getByRole('button', { name: 'March: 2' })).toBeEnabled();

    await pick(user, 'Hub', 'PD-India');
    expect(within(months()).getByRole('button', { name: 'March: 1' })).toBeEnabled();
    expect(within(months()).getByRole('button', { name: 'July: 1' })).toBeEnabled();
    expect(screen.getByTestId('cp-filter-hub-badge')).toHaveTextContent('1');
    expect(screen.getByTestId('completion-profile-filtered-note')).toHaveTextContent('Filtered: 2 of 4 projects');
  });

  it('filters by project type and by category (Unmapped = no value)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompletionProfileCard data={data} />);
    await pick(user, 'Project type', 'New Model');
    expect(within(months()).getByRole('button', { name: 'March: 1' })).toBeEnabled();
    expect(within(months()).getByRole('button', { name: 'July: 1' })).toBeEnabled();
    expect(screen.getByTestId('completion-profile-filtered-note')).toHaveTextContent('Filtered: 2 of 4 projects');

    await user.click(screen.getByRole('button', { name: /Clear/ }));
    await pick(user, 'Category', 'Unmapped');
    expect(within(months()).getByRole('button', { name: 'March: 0' })).toBeDisabled();
    expect(within(months()).getByRole('button', { name: 'July: 1' })).toBeEnabled();
    expect(screen.getByTestId('cp-filter-category-badge')).toHaveTextContent('1');
  });

  it('ORs values within a dimension and ANDs across dimensions', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompletionProfileCard data={data} />);
    await pick(user, 'Hub', 'PD-India');
    await pick(user, 'Hub', 'R&D-Greece');
    expect(screen.getByTestId('cp-filter-hub-badge')).toHaveTextContent('2');
    expect(within(months()).getByRole('button', { name: 'March: 2' })).toBeEnabled();
    expect(within(months()).getByRole('button', { name: 'July: 1' })).toBeEnabled();

    await pick(user, 'Project type', 'New Model');
    expect(within(months()).getByRole('button', { name: 'March: 1' })).toBeEnabled();
    expect(within(months()).getByRole('button', { name: 'July: 1' })).toBeEnabled();

    await pick(user, 'Category', 'B');
    expect(within(months()).getByRole('button', { name: 'March: 0' })).toBeDisabled();
    expect(within(months()).getByRole('button', { name: 'July: 1' })).toBeEnabled();
    expect(screen.getByTestId('completion-profile-filtered-note')).toHaveTextContent('Filtered: 1 of 4 projects');
  });

  it('the month drill-down (heading, weeks, project list) uses the filtered rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompletionProfileCard data={data} />);
    await pick(user, 'Hub', 'PD-India');
    await user.click(within(months()).getByRole('button', { name: 'March: 1' }));

    expect(screen.getByRole('heading', { name: /March 2026\s*1 project/ })).toBeInTheDocument();
    const weeks = screen.getByRole('list', { name: 'Within-year projects completed per week in March' });
    expect(within(weeks).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'W10: 0',
      'W11: 1',
      'W12: 0',
      'W13: 0',
    ]);
    const projects = screen.getByRole('list', { name: 'Projects completing in March' });
    expect(within(projects).getAllByRole('link').map((l) => l.textContent)).toEqual(['Project b']);

    // Widening the filter while drilled in updates the same month.
    await pick(user, 'Hub', 'R&D-Greece');
    expect(screen.getByRole('heading', { name: /March 2026\s*2 projects/ })).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Projects completing in March' }))
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Project a', 'Project b']);
  });

  it('Clear resets every dimension', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompletionProfileCard data={data} />);
    await pick(user, 'Hub', 'PD-India');
    await pick(user, 'Category', 'A');
    expect(within(months()).getByRole('button', { name: 'March: 1' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Clear completion profile filters' }));
    expect(screen.queryByTestId('completion-profile-filtered-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cp-filter-hub-badge')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hub' })).toHaveTextContent('All hubs');
    expect(within(months()).getByRole('button', { name: 'March: 2' })).toBeEnabled();
  });

  it('shows an empty state when nothing matches, with a Clear action', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompletionProfileCard data={data} />);
    await pick(user, 'Hub', 'R&D-Greece');
    await pick(user, 'Project type', 'Cost Optimization');
    expect(screen.getByText('No projects match these filters')).toBeInTheDocument();
    expect(screen.queryByTestId('completion-profile-monthly')).not.toBeInTheDocument();
    expect(screen.getByTestId('completion-profile-filtered-note')).toHaveTextContent('Filtered: 0 of 4 projects');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByTestId('completion-profile-monthly')).toBeInTheDocument();
  });

  it('reads the selection from the URL and ignores values not offered', () => {
    renderWithProviders(<CompletionProfileCard data={data} />, {
      route: '/?cp_hub=PD-India&cp_hub=PD-Romania&cp_type=Bogus',
    });
    expect(screen.getByRole('button', { name: 'Hub' })).toHaveTextContent('PD-India');
    expect(screen.getByRole('button', { name: 'Project type' })).toHaveTextContent('All types');
    expect(screen.getByTestId('completion-profile-filtered-note')).toHaveTextContent('Filtered: 2 of 4 projects');
  });

  it('hides the filters when the run has no within-year finish', () => {
    renderWithProviders(<CompletionProfileCard data={{ ...data, rows: [data.rows[4]!] }} />);
    expect(screen.getByText('No finishes by W52')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Completion profile filters' })).not.toBeInTheDocument();
  });

  it('has no serious axe violations with filters active, and the dropdown is keyboard operable', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<CompletionProfileCard data={data} />);
    screen.getByRole('button', { name: 'Hub' }).focus();
    await user.keyboard('{ArrowDown}');
    const list = await screen.findByRole('listbox', { name: 'Hub' });
    // Focus starts on "All hubs" (checked); move to R&D-Greece and toggle it.
    await user.keyboard('{ArrowDown}');
    await user.keyboard(' ');
    expect(within(list).getByRole('option', { name: 'R&D-Greece' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Hub' })).toHaveFocus();
    expect(screen.getByTestId('completion-profile-filtered-note')).toHaveTextContent('Filtered: 1 of 4 projects');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
