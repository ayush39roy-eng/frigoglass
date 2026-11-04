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
    const parsed = { ...withRows([...ROWS, onHold]), counts: { ...PARSE_RESPONSE.counts, auto_assign: 2 } };
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
    const include = within(group).getByRole('checkbox', { name: 'Include Paused Cooler' });
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
    const noIssue: ImportRow = { ...ROWS[1]!, key: 'row-8', file_row: 8, name: 'Clean Row' };
    useImportPlan.getState().updateRow('row-6', useImportPlan.getState().rows[1]!);
    useImportPlan.setState((s) => ({ rows: [...s.rows, noIssue] }));
    expect(await screen.findByText('Clean Row')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Show only rows with issues' }));
    expect(screen.queryByText('Clean Row')).toBeNull();
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
