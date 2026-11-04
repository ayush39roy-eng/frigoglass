import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { useImportPlan } from '../import-store';
import type { ImportSimulateRequest } from '../import-types';
import { PARSE_RESPONSE, SIMULATE_RESPONSE } from '../test-fixtures';
import ImportPlanView from './import-plan-view';

type Handler = (url: string, init: RequestInit) => Response;
let handler: Handler;
const calls: { url: string; init: RequestInit }[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function simulateBodies(): ImportSimulateRequest[] {
  return calls
    .filter((c) => c.url.endsWith('/whatif/import/simulate'))
    .map((c) => JSON.parse(String(c.init.body)) as ImportSimulateRequest);
}

const xlsx = () =>
  new File(['PK\u0003\u0004synthetic'], 'synthetic-plan.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

beforeEach(() => {
  useImportPlan.getState().reset();
  calls.length = 0;
  handler = (url) => {
    if (url.endsWith('/whatif/import/parse')) return json(PARSE_RESPONSE);
    if (url.endsWith('/whatif/import/simulate')) return json(SIMULATE_RESPONSE);
    return json({ detail: 'not found' }, 404);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return Promise.resolve(handler(url, init));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function uploadAndParse(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText('Choose a file'), xlsx());
  await user.click(screen.getByRole('button', { name: 'Parse file' }));
  await screen.findByTestId('import-review');
}

describe('Import plan (Excel)', () => {
  it('upload → review → results → Gantt drop re-simulates with the edit (mocked fetch, axe on each step)', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ImportPlanView />);
    expect(screen.getByRole('heading', { name: 'Import plan (Excel)' })).toBeInTheDocument();
    expect(screen.getByTestId('import-format-help')).toHaveTextContent('Recommended Design Engineer');
    expect(await seriousAxeViolations(container)).toEqual([]);

    // --- upload
    await uploadAndParse(user);
    const parseCall = calls.find((c) => c.url.endsWith('/whatif/import/parse'));
    expect(parseCall?.init.method).toBe('POST');
    expect(parseCall?.init.body).toBeInstanceOf(FormData);
    expect((parseCall?.init.body as FormData).get('file')).toBeInstanceOf(File);

    // --- review
    expect(screen.getByTestId('import-counts')).toHaveTextContent('Matched to plan');
    expect(screen.getByTestId('import-engineer-banner')).toHaveTextContent(
      '1 project has no engineer — choose one or keep auto-assign',
    );
    expect(screen.getByTestId('import-replaces')).toHaveTextContent('replaces: Old Cooler 750');
    const reviewRows = screen.getAllByTestId('import-review-row');
    expect(reviewRows).toHaveLength(3);
    expect(reviewRows[1]).toHaveAttribute('data-flagged', 'true');
    const hints = screen.getAllByTestId('import-priority-hint').map((h) => h.textContent);
    expect(hints).toEqual(['rank 3', 'default', 'from plan']);
    expect(await seriousAxeViolations(container)).toEqual([]);

    // Engineer picker: own hub first, then the others.
    const picker = screen.getByRole('combobox', {
      name: 'Engineer for Synthetic Freezer 300',
    });
    const groups = within(picker).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('label'))).toEqual(['PD-India designers', 'Other hubs']);
    await user.selectOptions(picker, 'eng-2');
    expect(screen.queryByTestId('import-engineer-banner')).not.toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole('combobox', {
        name: 'Priority for Synthetic OEM Chest',
      }),
      'P1',
    );
    expect(screen.getAllByTestId('import-priority-hint')[2]).toHaveTextContent('edited');
    // A blank new-designer name blocks Compute.
    const newName = screen.getByRole('textbox', {
      name: 'New designer name for Synthetic OEM Chest',
    });
    await user.clear(newName);
    expect(screen.getByRole('button', { name: 'Compute plan' })).toBeDisabled();
    await user.type(newName, 'Maria');
    await user.selectOptions(screen.getByLabelText('Mode'), 'file_only');
    await user.selectOptions(screen.getByLabelText('Mode'), 'merge');

    // --- compute
    console.log(
      'DBG',
      screen.queryByTestId('import-compute-hint')?.textContent,
      (
        screen.getByRole('button', {
          name: 'Compute plan',
        }) as HTMLButtonElement
      ).disabled,
      screen.queryAllByRole('alert').map((a) => a.textContent),
    );
    await user.click(screen.getByRole('button', { name: 'Compute plan' }));
    console.log(
      'DBG2',
      screen.queryAllByRole('alert').map((a) => a.textContent),
      calls.map((c) => c.url),
    );
    await screen.findByTestId('import-results');
    const first = simulateBodies()[0];
    expect(first?.mode).toBe('merge');
    expect(first?.plan_year_end_week).toBe(104);
    expect(first?.expand_multi).toBe(false);
    expect(first?.rows.map((r) => r.leader)).toEqual([
      { kind: 'existing', engineer_id: 'eng-1', name: 'Nikos' },
      { kind: 'existing', engineer_id: 'eng-2', name: 'Lokesh' },
      { kind: 'new', name: 'Maria' },
    ]);
    expect(first?.rows[2]?.priority).toBe('P1');
    expect(first?.edits).toEqual([]);

    // --- overview
    expect(screen.getByTestId('import-kpi-total')).toHaveTextContent('Projects scheduled237');
    expect(screen.getByTestId('import-kpi-total')).toHaveTextContent(
      '3 not scheduled (commercialized / cancelled / on hold)',
    );
    expect(screen.getByTestId('import-kpi-within')).toHaveTextContent('Finish in 2027');
    expect(screen.getByTestId('import-kpi-before')).toHaveTextContent('160');
    expect(screen.getByTestId('import-kpi-after')).toHaveTextContent('158');
    expect(screen.getAllByLabelText('Newly slipping')[0]).toHaveTextContent('Existing Plan Project');
    expect(await seriousAxeViolations(container)).toEqual([]);

    // --- Gantt
    await user.click(screen.getByRole('tab', { name: 'Gantt' }));
    const axis = await screen.findByTestId('import-gantt-axis');
    expect(axis).toHaveTextContent("W42 '26");
    expect(axis).toHaveTextContent("W1 '27");
    expect(axis).toHaveTextContent('End of 2027');
    expect(screen.getAllByTestId('import-gantt-project')).toHaveLength(3);
    expect(screen.getAllByTestId('import-gantt-summary-bar').length).toBeGreaterThan(0);
    expect(screen.getByTestId('import-gantt-unplaced')).toHaveTextContent('Not placed');
    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    // Done-before-import steps (A–C) are not drawn: 11 step rows for the file project.
    const fileSteps = screen.getAllByTestId('import-gantt-step').filter((r) => r.getAttribute('data-ref') === 'row-5');
    expect(fileSteps).toHaveLength(11);
    expect(fileSteps[0]).toHaveAttribute('data-step-id', 'PDD-D');
    expect(await seriousAxeViolations(container)).toEqual([]);

    // Drag PDD-E two weeks left, onto PDD-D (Design Freeze): parallel with a 2-week overlap.
    const rowE = fileSteps.find((r) => r.getAttribute('data-step-id') === 'PDD-E');
    if (!rowE) throw new Error('row E');
    const body = within(rowE).getByTestId('import-drag-body');
    fireEvent.pointerDown(body, { pointerId: 1, button: 0, clientX: 300 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 268 });
    expect(within(rowE).getByTestId('import-drag-label')).toHaveTextContent(
      'Parallel with Design Freeze · 2 wk overlap · same designer — will start when they are free',
    );
    fireEvent.pointerUp(body, { pointerId: 1, button: 0, clientX: 268 });
    expect(useImportPlan.getState().edits['row-5|PDD-E']).toEqual({
      project_ref: 'row-5',
      step_id: 'PDD-E',
      duration_weeks: 2,
      start_not_before_week: 44,
      overlap_weeks: 2,
    });
    await waitFor(() => expect(simulateBodies()).toHaveLength(2));
    expect(simulateBodies()[1]?.edits).toEqual([
      {
        project_ref: 'row-5',
        step_id: 'PDD-E',
        duration_weeks: 2,
        start_not_before_week: 44,
        overlap_weeks: 2,
      },
    ]);

    // Undo → re-simulates without the edit.
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(simulateBodies()).toHaveLength(3));
    expect(simulateBodies()[2]?.edits).toEqual([]);

    // --- capacity
    await user.click(screen.getByRole('tab', { name: 'Capacity' }));
    const cap = await screen.findByTestId('import-capacity');
    expect(within(cap).getAllByLabelText('Design capacity by hub')[0]).toHaveTextContent('75.18');
    expect(cap.querySelector('[data-booking-status="full"]')).not.toBeNull();
    expect(within(cap).getAllByLabelText('Designers')[0]).toHaveTextContent('Antonis');
    expect(await seriousAxeViolations(container)).toEqual([]);

    // --- projects (sortable)
    await user.click(screen.getByRole('tab', { name: 'Projects' }));
    const table = await screen.findByTestId('import-projects');
    const names = () =>
      within(table)
        .getAllByTestId('import-project-row')
        .map((r) => r.querySelector('td')?.textContent);
    expect(names()).toEqual(['Synthetic Cooler 750', 'Synthetic Freezer 300', 'Existing Plan Project']);
    await user.click(within(table).getByRole('button', { name: /Finish/ }));
    expect(names()).toEqual(['Synthetic Cooler 750', 'Existing Plan Project', 'Synthetic Freezer 300']);
    expect(within(table).getByText('auto')).toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);

    // --- back to review keeps the row edits
    await user.click(screen.getByRole('button', { name: 'Back to review' }));
    expect(
      screen.getByRole('combobox', {
        name: 'Engineer for Synthetic Freezer 300',
      }),
    ).toHaveValue('eng-2');
  });

  it('a Gantt edit then Reset all edits re-simulates with no edits; quick drops are coalesced', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportPlanView />);
    await uploadAndParse(user);
    await user.click(screen.getByRole('button', { name: 'Compute plan' }));
    await screen.findByTestId('import-results');
    const st = useImportPlan.getState();
    st.applyEdit('plan-1', 'PDD-F', { duration_weeks: 5 }, {});
    useImportPlan.getState().applyEdit('plan-1', 'PDD-G', { duration_weeks: 6 }, {});
    await waitFor(() => expect(simulateBodies()).toHaveLength(2));
    expect(simulateBodies()[1]?.edits.map((e) => e.step_id)).toEqual(['PDD-F', 'PDD-G']);
    await user.click(screen.getByRole('tab', { name: 'Gantt' }));
    await user.click(await screen.findByRole('button', { name: 'Reset all edits (2)' }));
    await waitFor(() => expect(simulateBodies()).toHaveLength(3));
    expect(simulateBodies()[2]?.edits).toEqual([]);
  });

  it.each([
    [413, { detail: 'too big', code: 'FILE_TOO_LARGE' }, 'larger than 5 MB'],
    [
      422,
      {
        detail: 'No header row with "Project description"',
        code: 'IMPORT_FORMAT',
      },
      'not in the expected format. No header row',
    ],
    [429, { detail: 'slow down', code: 'RATE_LIMITED' }, 'Too many requests'],
    [503, { detail: 'late', code: 'WHATIF_TIMEOUT' }, 'took too long'],
  ])('parse %i is shown inline', async (status, body, text) => {
    handler = () => json(body, status, status === 429 ? { 'Retry-After': '5' } : {});
    const user = userEvent.setup();
    renderWithProviders(<ImportPlanView />);
    await user.upload(screen.getByLabelText('Choose a file'), xlsx());
    await user.click(screen.getByRole('button', { name: 'Parse file' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('rejects a non-xlsx or oversized file before sending anything', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithProviders(<ImportPlanView />);
    await user.upload(screen.getByLabelText('Choose a file'), new File(['x'], 'plan.csv', { type: 'text/csv' }));
    expect(screen.getByTestId('import-file-error')).toHaveTextContent('.xlsx');
    expect(screen.getByRole('button', { name: 'Parse file' })).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  it('a simulate 422 INVALID_IMPORT stays on Review with the message', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportPlanView />);
    await uploadAndParse(user);
    handler = () => json({ detail: 'unknown engineer id eng-404', code: 'INVALID_IMPORT' }, 422);
    await user.click(screen.getByRole('button', { name: 'Compute plan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not use these rows. unknown engineer id eng-404.',
    );
    expect(screen.getByTestId('import-review')).toBeInTheDocument();
  });

  it('a response that does not match the contract is reported, not rendered', async () => {
    handler = () => json({ rows: 'nope' });
    const user = userEvent.setup();
    renderWithProviders(<ImportPlanView />);
    await user.upload(screen.getByLabelText('Choose a file'), xlsx());
    await user.click(screen.getByRole('button', { name: 'Parse file' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected format');
  });
});
