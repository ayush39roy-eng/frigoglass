import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { useImportPlan } from '../import-store';
import type { ImportParseResponse, ImportRow } from '../import-types';
import { PARSE_RESPONSE, ROWS } from '../test-fixtures';
import { ReviewStep } from './review-step';

const idle = { pending: false, error: null, token: 0 };

function withRows(rows: ImportRow[]): ImportParseResponse {
  return { ...PARSE_RESPONSE, rows };
}

describe('Review step', () => {
  beforeEach(() => useImportPlan.getState().reset());

  it('On Hold rows are not mapped: a collapsed greyed group, Include disabled until the status changes', async () => {
    const onHold: ImportRow = {
      ...ROWS[1]!,
      key: 'row-9',
      file_row: 9,
      name: 'Paused Cooler',
      status: 'On Hold',
      status_raw: 'ON HOLD',
      include: false,
    };
    // The server counts every row with no engineer (On Hold included): 2. Only 1 will be scheduled.
    const parsed = {
      ...withRows([...ROWS, onHold]),
      counts: { ...PARSE_RESPONSE.counts, auto_assign: 2 },
    };
    useImportPlan.getState().setParsed(parsed);
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <ReviewStep parsed={parsed} simulation={idle} onCompute={() => {}} onRetry={() => {}} />,
    );

    expect(screen.getByTestId('import-not-mapped-banner')).toHaveTextContent('1 On Hold project not mapped');
    // Tile and banner use one definition (rows to schedule with no engineer); the served file count is the hint.
    expect(screen.getByTestId('import-auto-tile')).toHaveTextContent('Auto-assign1');
    expect(screen.getByTestId('import-auto-tile')).toHaveTextContent(
      '(2 in the file, incl. rows not mapped or excluded)',
    );
    expect(screen.getByTestId('import-engineer-banner')).toHaveTextContent('1 project has no engineer');
    const group = screen.getByTestId('import-not-mapped');
    expect(group).not.toHaveAttribute('open');
    expect(within(group).getByText('Not mapped (On Hold) — 1')).toBeInTheDocument();
    // Not in the main table.
    expect(within(screen.getByRole('table', { name: 'Rows of the file' })).queryByText('Paused Cooler')).toBeNull();
    const include = within(group).getByRole('checkbox', {
      name: 'Include Paused Cooler',
    });
    expect(include).toBeDisabled();
    expect(include).not.toBeChecked();
    expect(await seriousAxeViolations(container)).toEqual([]);

    await user.selectOptions(within(group).getByRole('combobox', { name: 'Status for Paused Cooler' }), 'In Queue');
    expect(screen.queryByTestId('import-not-mapped')).toBeNull();
    const row = useImportPlan.getState().rows.find((r) => r.key === 'row-9');
    expect(row).toMatchObject({ status: 'In Queue', include: true });
    expect(screen.getByRole('checkbox', { name: 'Include Paused Cooler' })).toBeEnabled();

    // Back to On Hold excludes it again.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status for Paused Cooler' }), 'On Hold');
    expect(useImportPlan.getState().rows.find((r) => r.key === 'row-9')?.include).toBe(false);
  });

  it('"Show only rows with issues" filters the table; the issue list groups by severity', async () => {
    const parsed = withRows(ROWS);
    useImportPlan.getState().setParsed(parsed);
    const user = userEvent.setup();
    renderWithProviders(<ReviewStep parsed={parsed} simulation={idle} onCompute={() => {}} onRetry={() => {}} />);
    const issues = screen.getByTestId('import-issues');
    expect(within(issues).getAllByTestId('import-issue')).toHaveLength(2); // warnings first
    await user.click(within(issues).getByRole('button', { name: /^Info/ }));
    expect(
      within(issues)
        .getAllByTestId('import-issue')
        .map((i) => i.textContent),
    ).toEqual([
      'Row 7 (Synthetic OEM Chest): C+ is scheduled as C. CATEGORY_MAPPED',
      'Row 5 (Synthetic Cooler 750): Matched to Old Cooler 750 by name. MATCHED',
    ]);
    const noIssue: ImportRow = {
      ...ROWS[1]!,
      key: 'row-8',
      file_row: 8,
      name: 'Clean Row',
    };
    useImportPlan.getState().updateRow('row-6', useImportPlan.getState().rows[1]!);
    useImportPlan.setState((s) => ({ rows: [...s.rows, noIssue] }));
    expect(await screen.findByText('Clean Row')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Show only rows with issues' }));
    expect(screen.queryByText('Clean Row')).toBeNull();
  });

  it('P32-R03: a "×n projects" chip on rows of n ≥ 2 (none for blank / 1); hidden when the option is off', async () => {
    const rows = [{ ...ROWS[0]!, num_projects: 5 }, { ...ROWS[1]!, num_projects: null }, ROWS[2]!];
    const parsed = withRows(rows);
    useImportPlan.getState().setParsed(parsed);
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <ReviewStep parsed={parsed} simulation={idle} onCompute={() => {}} onRetry={() => {}} />,
    );
    const chips = screen.getAllByTestId('import-copies');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('×5 projects');
    expect(chips[0]).toHaveAttribute('title', 'This row becomes 5 projects: Synthetic Cooler 750 (1/5) … (5/5)');
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.click(
      screen.getByRole('checkbox', {
        name: "Count the 'Num of Projects' column as separate projects (on by default)",
      }),
    );
    expect(screen.queryByTestId('import-copies')).toBeNull();
  });

  it('P32-R03: "Projects to schedule" shows the served count, else the display-only sum', async () => {
    const rows = [{ ...ROWS[0]!, num_projects: 5 }, { ...ROWS[1]!, num_projects: null }, ROWS[2]!];
    const served = {
      ...withRows(rows),
      counts: { ...PARSE_RESPONSE.counts, projects_after_expansion: 42 },
    };
    useImportPlan.getState().setParsed(served);
    const user = userEvent.setup();
    const view = renderWithProviders(
      <ReviewStep parsed={served} simulation={idle} onCompute={() => {}} onRetry={() => {}} />,
    );
    const tile = () => screen.getByTestId('import-projects-tile');
    expect(tile()).toHaveTextContent('Projects to schedule42');
    // Toggling the option off: the served figure no longer describes the request.
    await user.click(
      screen.getByRole('checkbox', {
        name: "Count the 'Num of Projects' column as separate projects (on by default)",
      }),
    );
    expect(tile()).toHaveTextContent('Projects to schedule3');
    view.unmount();

    // No served field (older backend): Σ max(1, num_projects) over included rows = 5 + 1 + 1.
    useImportPlan.getState().reset();
    const plain = withRows(rows);
    useImportPlan.getState().setParsed(plain);
    renderWithProviders(<ReviewStep parsed={plain} simulation={idle} onCompute={() => {}} onRetry={() => {}} />);
    expect(tile()).toHaveTextContent('Projects to schedule7');
  });

  it('virtualizes over 100 rows (only a window of rows is in the DOM)', () => {
    const many = Array.from({ length: 150 }, (_, i): ImportRow => ({
      ...ROWS[1]!,
      key: `row-${String(i + 10)}`,
      file_row: i + 10,
      name: `Bulk ${String(i)}`,
    }));
    const parsed = withRows(many);
    useImportPlan.getState().setParsed(parsed);
    renderWithProviders(<ReviewStep parsed={parsed} simulation={idle} onCompute={() => {}} onRetry={() => {}} />);
    const table = screen.getByRole('table', { name: 'Rows of the file' });
    expect(table.querySelector('tbody')).toHaveAttribute('data-virtualized', 'true');
    expect(within(table).queryAllByTestId('import-review-row').length).toBeLessThan(150);
  });
});
