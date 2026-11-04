import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { buildSimulateRequest } from '../import-rows';
import { useImportPlan } from '../import-store';
import type { ImportParseIssue, ImportParseResponse, ImportRow } from '../import-types';
import { applyScenarioRules, emptyRules } from '../scenario-rules';
import { PARSE_RESPONSE, ROWS } from '../test-fixtures';
import { ReviewStep } from './review-step';

/** P32-R06 (priorities workbook): a "Running" row, a budget line, derived statuses, new info codes. */

const idle = { pending: false, error: null, token: 0 };

const running: ImportRow = {
  ...ROWS[1]!,
  key: 'row-3',
  file_row: 3,
  name: 'Running Cooler',
  category: 'A+',
  lead_time_label: 'A+',
  rank: 0,
  priority: 'P1',
  priority_source: 'running',
  status: 'In Development',
  status_raw: null,
};
const budget: ImportRow = {
  ...ROWS[1]!,
  key: 'row-40',
  file_row: 40,
  name: 'Provision for certification',
  priority_source: 'default',
  include: false,
};

const info = (row_key: string | null, code: string, message: string): ImportParseIssue => ({
  row_key,
  file_row: row_key === null ? null : Number(row_key.split('-')[1]),
  field: null,
  severity: 'info',
  code,
  message,
});

const PARSED: ImportParseResponse = {
  ...PARSE_RESPONSE,
  rows: [running, ...ROWS, budget],
  issues: [
    ...PARSE_RESPONSE.issues,
    info(null, 'STATUS_NOT_IN_FILE', 'The sheet has no Status column; statuses are derived.'),
    info('row-3', 'STATUS_FROM_RUNNING', 'PRIORITY Running: In Development.'),
    info('row-3', 'HUB_MAPPED', 'Rom/Frigo is scheduled as PD-Romania.'),
    info('row-5', 'STATUS_FROM_PLAN', 'Status from the plan project.'),
    info('row-6', 'STATUS_FROM_SPILLOVER', 'Spillover = Yes: In Development.'),
    info('row-6', 'HUB_FROM_PLAN', 'Hub from the plan project.'),
    info('row-7', 'CATEGORY_FROM_PLAN', 'Category from the plan project.'),
    info('row-7', 'STAGE_FROM_PLAN', 'Stage from the plan project.'),
    info('row-40', 'NOT_A_PROJECT', 'Looks like a budget line; not mapped.'),
  ],
  counts: { ...PARSE_RESPONSE.counts, rows: 5, derived_status: 3, not_a_project: 1 },
};

describe('Review — P32-R06', () => {
  beforeEach(() => useImportPlan.getState().reset());

  it('running hint, budget lines in their own group (Include enabled), derived-status line, new info codes', async () => {
    useImportPlan.getState().setParsed(PARSED);
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <ReviewStep parsed={PARSED} simulation={idle} onCompute={() => {}} onRetry={() => {}} />,
    );

    // 1. "running" priority source.
    const hints = screen.getAllByTestId('import-priority-hint');
    expect(hints[0]).toHaveTextContent('running — schedules first');
    expect(hints[0]).toHaveAttribute('title', 'Running — schedules first');
    expect(
      screen.getByRole('combobox', { name: 'Priority for Running Cooler' }),
    ).toHaveAttribute('aria-describedby', 'prio-hint-row-3');

    // 2. Budget line: banner, own collapsed group, not in the main table, Include enabled.
    expect(screen.getByTestId('import-not-a-project-banner')).toHaveTextContent(
      '1 row looks like budget lines — not mapped',
    );
    expect(screen.getByTestId('import-derived-status')).toHaveTextContent(
      'Status derived for 3 rows (the file has no Status column)',
    );
    const main = screen.getByRole('table', { name: 'Rows of the file' });
    expect(within(main).queryByText('Provision for certification')).toBeNull();
    const group = screen.getByTestId('import-not-a-project');
    expect(within(group).getByText('Not a project — 1')).toBeInTheDocument();
    const include = within(group).getByRole('checkbox', { name: 'Include Provision for certification' });
    expect(include).toBeEnabled();
    expect(include).not.toBeChecked();
    expect(screen.queryByTestId('import-not-mapped')).toBeNull();
    await user.click(include);
    expect(useImportPlan.getState().rows.find((r) => r.key === 'row-40')?.include).toBe(true);
    // It stays in its group (no jump) and is now sent.
    expect(within(screen.getByTestId('import-not-a-project')).getByText('Provision for certification')).toBeInTheDocument();
    const st = useImportPlan.getState();
    expect(buildSimulateRequest(st.rows, st.options, st.edits).rows.find((r) => r.key === 'row-40')?.include).toBe(true);

    // 3. The new info codes render, a file-level one with no row.
    const issues = screen.getByTestId('import-issues');
    await user.click(within(issues).getByRole('button', { name: /^Info/ }));
    const texts = within(issues)
      .getAllByTestId('import-issue')
      .map((i) => i.textContent ?? '');
    for (const code of [
      'STATUS_NOT_IN_FILE',
      'STATUS_FROM_RUNNING',
      'STATUS_FROM_PLAN',
      'STATUS_FROM_SPILLOVER',
      'HUB_MAPPED',
      'HUB_FROM_PLAN',
      'CATEGORY_FROM_PLAN',
      'STAGE_FROM_PLAN',
      'NOT_A_PROJECT',
    ]) {
      expect(texts.some((t) => t.endsWith(code))).toBe(true);
    }
    expect(texts.find((t) => t.endsWith('STATUS_NOT_IN_FILE'))).toBe(
      'The sheet has no Status column; statuses are derived. STATUS_NOT_IN_FILE',
    );
    expect(texts.find((t) => t.endsWith('STATUS_FROM_RUNNING'))).toContain('Row 3 (Running Cooler)');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('no derived statuses and no budget lines: no line, no banner, no group', () => {
    useImportPlan.getState().setParsed(PARSE_RESPONSE);
    renderWithProviders(<ReviewStep parsed={PARSE_RESPONSE} simulation={idle} onCompute={() => {}} onRetry={() => {}} />);
    expect(screen.queryByTestId('import-derived-status')).toBeNull();
    expect(screen.queryByTestId('import-not-a-project-banner')).toBeNull();
    expect(screen.queryByTestId('import-not-a-project')).toBeNull();
  });

  it('builder ordering: the running row (rank 0) is kept before rank 1', () => {
    const ranked = (key: string, rank: number, source: ImportRow['priority_source']): ImportRow => ({
      ...running,
      key,
      file_row: Number(key.split('-')[1]),
      rank,
      priority_source: source,
    });
    // File order puts the running row last; it must still win the single A+ slot.
    const rows = [ranked('row-1', 1, 'rank'), ranked('row-2', 2, 'rank'), ranked('row-9', 0, 'running')];
    const out = applyScenarioRules(rows, { ...emptyRules('merge'), caps: [{ category: 'A+', max: 1 }] });
    expect(out.filter((r) => r.include).map((r) => r.key)).toEqual(['row-9']);
    const two = applyScenarioRules(rows, { ...emptyRules('merge'), caps: [{ category: 'A+', max: 2 }] });
    expect(two.filter((r) => r.include).map((r) => r.key)).toEqual(['row-1', 'row-9']);
  });
});
