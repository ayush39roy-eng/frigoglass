import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { editSessionHeld } from '@/test/reload-safety';
import { ROLE_MATRIX } from '@/test/roles';
import { permissionsFrom } from '@/test/session';
import { seriousAxeViolations } from '@/test/axe';

import type { ApplyPreviewResponse, CategoryTimeline, TemplateApplyResponse, WorkflowSettings } from './api/types';
import { settingsFixture, timelineFixture } from './test-fixtures';

/**
 * P52-T01: "Effort & Timeline Planning" — the Excel-style matrix tab, driven
 * through the real page and hooks with the HTTP client mocked at its edge.
 * Every write goes through an existing endpoint, and only on "Apply to App".
 */

const http = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), sendWithHeaders: vi.fn() }));
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (path: string, opts?: unknown) => http.get(path, opts),
    apiSend: (method: string, path: string, body?: unknown) => http.send(method, path, body),
    apiSendWithHeaders: (method: string, path: string, body?: unknown) => http.sendWithHeaders(method, path, body),
  };
});
const sse = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/lib/api/sse', () => ({ streamSolverProgress: (...a: unknown[]) => sse.stream(...a) }));

import { ApiError } from '@/lib/api/client';
import WorkflowSettingsPage from './WorkflowSettingsPage';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = { route: '/settings/workflow' };
const ADMIN = { roles: ['Admin' as const], permissions: ROLE_MATRIX.Admin };
const VIEWER = { roles: ['Admin' as const], permissions: permissionsFrom({ workflow_settings: 'r', workflow_templates: 'r' }) };
const DEBOUNCED = { timeout: 5_000 };

let settings: WorkflowSettings;
let timelines: CategoryTimeline[];
const never = () => new Promise<never>(() => undefined);

function serveGet(path: string, opts?: { query?: Record<string, unknown> }): Promise<unknown> {
  if (path === '/workflow-settings') return Promise.resolve(settings);
  if (path === '/workflow-settings/category-timelines') {
    return Promise.resolve(opts?.query?.workflow === 'OEM' ? [] : timelines);
  }
  if (path === '/workflow-settings/b-equivalent') return Promise.resolve([]);
  if (path === '/schedule-runs/active') return Promise.reject(new ApiError(404, 'none'));
  return never();
}

const sends = (path: string) => http.send.mock.calls.filter(([, p]) => p === path).map(([, , body]) => body as unknown);
const puts = (path: string) =>
  http.sendWithHeaders.mock.calls.filter(([, p]) => p === path).map(([, , body]) => body as unknown);

const PREVIEW: ApplyPreviewResponse = {
  categories: [{ workflow_id: 'PDD', category: 'A+', timeline: timelineFixture('A+') }],
  counts: { automatic: 0, choosable: 0, own_effort: 0, never: 0 },
  automatic: [],
  choosable: [],
  own_effort: [],
  never: [],
};
const APPLIED: TemplateApplyResponse = {
  template_change_id: 'chg-1',
  versions: [{ workflow_id: 'PDD', category: 'A+', template_version: 2 }],
  applied: { automatic: 0, selected: 0, own_effort_not_applied: 0 },
  not_applied: [],
  recalc_status: 'not_needed',
  schedule_run_id: null,
  task_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  settings = settingsFixture();
  timelines = [timelineFixture('A+')];
  http.get.mockImplementation(serveGet);
  http.send.mockImplementation((_m: string, path: string) => {
    if (path === '/workflow-templates/timeline-preview') return Promise.resolve({ ...timelineFixture('A+'), changed_step_ids: [] });
    if (path === '/workflow-templates/apply-preview') return Promise.resolve(PREVIEW);
    if (path === '/workflow-templates/apply') return Promise.resolve(APPLIED);
    return never();
  });
  http.sendWithHeaders.mockImplementation((_m: string, _p: string, body: unknown) => {
    const next = settingsFixture();
    const sent = (body as { steps?: { step_id: string; kind: string }[] }).steps ?? [];
    next.workflows[0]!.steps = next.workflows[0]!.steps.map((s) => {
      const k = sent.find((x) => x.step_id === s.step_id)?.kind;
      return k ? { ...s, kind: k as typeof s.kind } : s;
    });
    settings = next;
    return Promise.resolve({ data: next, headers: new Headers({ 'X-Schedule-Stale-Count': '12' }) });
  });
  sse.stream.mockResolvedValue({ status: 'completed' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openMatrix(session?: NonNullable<Parameters<typeof renderWithProviders>[1]>['session']) {
  const user = userEvent.setup();
  const view = renderWithProviders(<WorkflowSettingsPage />, { ...ROUTE, ...(session ? { session } : {}) });
  await screen.findByTestId('matrix-row-PDD-A+');
  return { user, view };
}

const cell = (category: string, stepId: string) =>
  within(screen.getByTestId(`cell-PDD-${category}-${stepId}`)).getByRole('textbox');
const totals = (category: string) => screen.getByTestId(`total-PDD-${category}`);

describe('P52-T01 — Effort & Timeline Planning matrix', () => {
  it('is the first tab: title, subtitle, note, step codes with full names on hover, Resource row, categories in rank order', async () => {
    await openMatrix();
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Effort & Timeline Planning' })).toBeInTheDocument();
    expect(screen.getByText(/Define effort durations \(weeks\) per step & category/)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Apply to App');
    expect(screen.getByRole('region', { name: 'Standard PDD Workflow' })).toBeInTheDocument();
    const header = screen.getByRole('columnheader', { name: /PDD-E/ });
    expect(header).toHaveAttribute('title', 'PDD-E · Design Detailing');
    expect(screen.getByRole('rowheader', { name: 'Resource' })).toBeInTheDocument();
    // Resource = kind: Design / Lab / Other (= elapsed).
    expect(screen.getByRole('combobox', { name: 'Resource — PDD-F Proof of Concept' })).toHaveTextContent('Lab');
    expect(screen.getByRole('combobox', { name: 'Resource — PDD-L Pilot' })).toHaveTextContent('Other');
    const rows = screen.getAllByTestId(/^matrix-row-PDD-/).map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual(['matrix-row-PDD-A+', 'matrix-row-PDD-A', 'matrix-row-PDD-B', 'matrix-row-PDD-C']);
  });

  it('TOTAL (W) is the sum of the template weeks with design and lab chips; editing a cell updates them and is a draft', async () => {
    const { user } = await openMatrix();
    expect(within(totals('A+')).getByTestId('total-weeks')).toHaveTextContent('44');
    expect(within(totals('A+')).getByTestId('total-design')).toHaveTextContent('D: 22 w');
    expect(within(totals('A+')).getByTestId('total-lab')).toHaveTextContent('L: 12 w');
    // Heat colouring: a coloured cell for weeks > 0, none for 0.
    expect(screen.getByTestId('cell-PDD-A+-PDD-B').getAttribute('style')).toMatch(/background-color/);
    expect(screen.getByTestId('cell-PDD-B-PDD-B').getAttribute('style') ?? '').not.toMatch(/background-color/);

    await user.clear(cell('A+', 'PDD-E'));
    await user.type(cell('A+', 'PDD-E'), '9');
    expect(within(totals('A+')).getByTestId('total-weeks')).toHaveTextContent('47');
    expect(within(totals('A+')).getByTestId('total-design')).toHaveTextContent('D: 25 w');
    expect(cell('A+', 'PDD-E')).toHaveAttribute('data-drafted', 'true');
    expect(screen.getByTestId('apply-to-app')).toHaveTextContent('Apply to App (1)');
    expect(screen.getByTestId('matrix-status')).toHaveTextContent('1 unsaved change — not applied yet.');
    // Nothing was written.
    expect(sends('/workflow-templates/apply')).toEqual([]);
    expect(http.sendWithHeaders).not.toHaveBeenCalled();
    expect(editSessionHeld()).toBe(true);
  });

  it('an out-of-range or non-numeric cell is flagged and blocks Apply to App', async () => {
    const { user } = await openMatrix();
    await user.clear(cell('A+', 'PDD-B'));
    await user.type(cell('A+', 'PDD-B'), '105');
    expect(cell('A+', 'PDD-B')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Lengths are whole weeks, from 0 to 104');
    expect(screen.getByTestId('apply-to-app')).toBeDisabled();
    await user.keyboard('{Backspace}');
    expect(cell('A+', 'PDD-B')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByTestId('apply-to-app')).toBeEnabled();
  });

  it('keyboard: arrows move between cells, Enter / Shift+Enter move down / up, Escape restores the saved value', async () => {
    const { user } = await openMatrix();
    await user.click(cell('A+', 'PDD-A'));
    await user.keyboard('{ArrowRight}');
    expect(cell('A+', 'PDD-B')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(cell('A', 'PDD-B')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(cell('B', 'PDD-B')).toHaveFocus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(cell('A', 'PDD-B')).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowLeft}');
    expect(cell('A+', 'PDD-A')).toHaveFocus();
    // Edges stay put.
    await user.keyboard('{ArrowLeft}{ArrowUp}');
    expect(cell('A+', 'PDD-A')).toHaveFocus();
    // Escape: typed value back to the saved one.
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Backspace}5');
    expect(cell('A+', 'PDD-B')).toHaveValue('5');
    await user.keyboard('{Escape}');
    expect(cell('A+', 'PDD-B')).toHaveValue('8');
    expect(cell('A+', 'PDD-B')).not.toHaveAttribute('data-drafted');
  });

  it('Resource dropdown asks for confirmation (load shift) and stays a draft; cancelling changes nothing', async () => {
    const { user } = await openMatrix();
    await user.click(screen.getByRole('combobox', { name: 'Resource — PDD-L Pilot' }));
    await user.click(await screen.findByRole('option', { name: 'Lab' }));
    let dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Change Pilot from Other to Lab?');
    expect(dialog).toHaveTextContent(/chamber platform-weeks/);
    expect(dialog).toHaveTextContent(/draft until you press Apply to App/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('combobox', { name: 'Resource — PDD-L Pilot' })).toHaveTextContent('Other');
    expect(screen.getByTestId('apply-to-app')).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: 'Resource — PDD-L Pilot' }));
    await user.click(await screen.findByRole('option', { name: 'Lab' }));
    dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Change resource' }));
    expect(screen.getByRole('combobox', { name: 'Resource — PDD-L Pilot' })).toHaveTextContent('Lab');
    expect(screen.getByTestId('resource-PDD-L')).toHaveAttribute('data-drafted', 'true');
    // L now includes Pilot's 3 weeks (template totals by the drafted kind).
    expect(within(totals('A+')).getByTestId('total-lab')).toHaveTextContent('L: 15 w');
    expect(http.sendWithHeaders).not.toHaveBeenCalled();
  });

  it('Apply to App: resources go through the steps PUT (with base), then the stale banner; no template apply when only resources changed', async () => {
    const { user } = await openMatrix();
    await user.click(screen.getByRole('combobox', { name: 'Resource — PDD-L Pilot' }));
    await user.click(await screen.findByRole('option', { name: 'Lab' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change resource' }));
    await user.click(screen.getByTestId('apply-to-app'));
    await waitFor(() => expect(puts('/workflow-settings/steps/PDD')).toHaveLength(1));
    const body = puts('/workflow-settings/steps/PDD')[0] as { steps: { step_id: string; kind: string; predecessor_ids: string[]; base?: unknown }[] };
    expect(body.steps).toHaveLength(14);
    expect(body.steps.find((s) => s.step_id === 'PDD-L')).toMatchObject({ kind: 'lab', predecessor_ids: ['PDD-K'], base: { kind: 'elapsed' } });
    expect(body.steps.find((s) => s.step_id === 'PDD-E')).toMatchObject({ kind: 'design' });
    expect(await screen.findByTestId('stale-banner')).toHaveTextContent('12 projects');
    expect(sends('/workflow-templates/apply-preview')).toEqual([]);
    await waitFor(() => expect(screen.getByTestId('apply-to-app')).toBeDisabled());
  });

  it('a refused resource save (KIND_IN_USE) is shown and the template apply does not start', async () => {
    http.sendWithHeaders.mockRejectedValue(new ApiError(422, 'bad', 'PDD-F is allowed on IN-CH-2', 'KIND_IN_USE'));
    const { user } = await openMatrix();
    await user.click(screen.getByRole('combobox', { name: 'Resource — PDD-F Proof of Concept' }));
    await user.click(await screen.findByRole('option', { name: 'Design' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change resource' }));
    await user.clear(cell('A+', 'PDD-E'));
    await user.type(cell('A+', 'PDD-E'), '7');
    await user.click(screen.getByTestId('apply-to-app'));
    expect(await screen.findByTestId('matrix-error')).toHaveTextContent(/^KIND_IN_USE:/);
    expect(sends('/workflow-templates/apply-preview')).toEqual([]);
    // Drafts are kept.
    expect(screen.getByTestId('apply-to-app')).toHaveTextContent('Apply to App (2)');
  });

  it('when Apply to App saved resources first, the apply dialog says they are saved and Cancel does not undo them', async () => {
    const { user } = await openMatrix();
    await user.click(screen.getByRole('combobox', { name: 'Resource — PDD-J Pre-Production (Pr. Pr)' }));
    await user.click(await screen.findByRole('option', { name: 'Lab' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change resource' }));
    await user.clear(cell('A+', 'PDD-E'));
    await user.type(cell('A+', 'PDD-E'), '7');
    await user.click(screen.getByTestId('apply-to-app'));
    const dialog = await screen.findByTestId('template-apply-dialog');
    // The steps PUT went first, then the apply preview.
    expect(puts('/workflow-settings/steps/PDD')).toHaveLength(1);
    expect(within(dialog).getByTestId('template-apply-notice')).toHaveTextContent(
      'Resource changes (PDD-J → Lab) are already saved. Cancel here keeps the week/gap edits as drafts; it does not undo the resource change.',
    );
    await within(dialog).findByTestId('apply-counts');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    // Week edit kept as a draft; the resource is no longer a draft (it is saved).
    expect(screen.getByTestId('apply-to-app')).toHaveTextContent('Apply to App (1)');
    expect(screen.getByTestId('resource-PDD-J')).not.toHaveAttribute('data-drafted');
    expect(screen.getByRole('combobox', { name: 'Resource — PDD-J Pre-Production (Pr. Pr)' })).toHaveTextContent('Lab');
    // A later Apply with no resource changes shows no notice.
    await user.click(screen.getByTestId('apply-to-app'));
    const again = await screen.findByTestId('template-apply-dialog');
    expect(within(again).queryByTestId('template-apply-notice')).not.toBeInTheDocument();
  });

  it('Apply to App: cell lengths and timeline gaps go as one change set through the existing apply dialog; applied drafts clear', async () => {
    const { user } = await openMatrix();
    await user.clear(cell('A+', 'PDD-E'));
    await user.type(cell('A+', 'PDD-E'), '7');
    // The per-category timeline shares the drafts: its length shows 7w; move PDD-H one week earlier (overlap).
    await user.click(await screen.findByRole('button', { name: /A\+.*Timeline preview/ }));
    const card = screen.getByTestId('timeline-A+');
    expect(within(card).getByTestId('length-PDD-E')).toHaveTextContent('7w');
    await user.click(within(card).getByRole('button', { name: 'Move PDD-H one week earlier' }));
    await waitFor(() => expect(sends('/workflow-templates/timeline-preview').length).toBeGreaterThan(0), DEBOUNCED);
    // Timeline length ± edits the same cell.
    await user.click(within(card).getByRole('button', { name: 'Lengthen PDD-B by one week' }));
    expect(cell('A+', 'PDD-B')).toHaveValue('9');

    await user.click(screen.getByTestId('apply-to-app'));
    const dialog = await screen.findByTestId('template-apply-dialog');
    expect(sends('/workflow-templates/apply-preview')).toEqual([
      {
        changes: [
          {
            workflow_id: 'PDD',
            category: 'A+',
            base_version: 1,
            steps: [
              { step_id: 'PDD-B', weeks: 9 },
              { step_id: 'PDD-E', weeks: 7 },
              { step_id: 'PDD-H', gap_weeks: -1 },
            ],
          },
        ],
      },
    ]);
    expect(await within(dialog).findByText('A+ · PDD-E length 6w → 7w')).toBeInTheDocument();
    // No resource was saved in this Apply, so no "already saved" notice.
    expect(within(dialog).queryByTestId('template-apply-notice')).not.toBeInTheDocument();
    expect(within(dialog).getByText('A+ · PDD-H gap 0w → −1w')).toBeInTheDocument();
    // Cancelling keeps the drafts.
    await within(dialog).findByTestId('apply-counts');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('apply-to-app')).toHaveTextContent('Apply to App (3)');
    expect(sends('/workflow-templates/apply')).toEqual([]);

    await user.click(screen.getByTestId('apply-to-app'));
    const again = await screen.findByTestId('template-apply-dialog');
    await within(again).findByTestId('apply-counts');
    await user.click(within(again).getByTestId('apply-confirm'));
    await waitFor(() => expect(sends('/workflow-templates/apply')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('apply-to-app')).toHaveTextContent(/^Apply to App$/));
  });

  it('drafts survive a tab switch, and closing the browser tab with drafts asks first', async () => {
    const { user } = await openMatrix();
    await user.clear(cell('A', 'PDD-E'));
    await user.type(cell('A', 'PDD-E'), '3');
    await user.click(screen.getByRole('tab', { name: 'Steps & precedence' }));
    await user.click(screen.getByRole('tab', { name: /Effort & Timeline Planning/ }));
    expect(await screen.findByTestId('apply-to-app')).toHaveTextContent('Apply to App (1)');
    expect(cell('A', 'PDD-E')).toHaveValue('3');
    const event = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    // Discard clears every draft; leaving no longer asks.
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    const later = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(later);
    });
    expect(later.defaultPrevented).toBe(false);
    expect(editSessionHeld()).toBe(false);
  });

  it('Edit Workflow opens Steps & precedence', async () => {
    const { user } = await openMatrix();
    await user.click(screen.getByRole('button', { name: 'Edit Workflow' }));
    expect(screen.getByRole('tab', { name: 'Steps & precedence' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('step-row-PDD-A')).toBeInTheDocument();
  });

  it('Admin edits weeks but reads Resources; a read-only role sees the grid as text and no Apply', async () => {
    const first = await openMatrix(ADMIN);
    expect(cell('A+', 'PDD-E')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /^Resource — / })).not.toBeInTheDocument();
    expect(screen.getByTestId('resource-PDD-L')).toHaveTextContent('Other');
    expect(screen.getByTestId('read-only-notice')).toHaveTextContent(/Resource/);
    expect(screen.getByTestId('apply-to-app')).toBeInTheDocument();
    first.view.unmount();

    await openMatrix(VIEWER);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryByTestId('apply-to-app')).not.toBeInTheDocument();
    expect(screen.getByTestId('cell-PDD-A+-PDD-E')).toHaveTextContent('6');
    expect(within(totals('A+')).getByTestId('total-weeks')).toHaveTextContent('44');
  });

  it('shows the OEM workflow card beside PDD when served', async () => {
    const s = settingsFixture();
    s.workflows.push({
      id: 'OEM',
      name: 'OEM',
      steps: s.workflows[0]!.steps.map((st) => ({
        ...st,
        step_id: st.step_id.replace('PDD', 'OEM'),
        predecessor_ids: st.predecessor_ids.map((p) => p.replace('PDD', 'OEM')),
      })),
    });
    settings = s;
    await openMatrix();
    expect(screen.getByRole('region', { name: 'OEM Workflow' })).toBeInTheDocument();
    expect(screen.getByTestId('matrix-row-OEM-A-OEM')).toBeInTheDocument();
  });

  it('has no serious axe violations with a draft on screen', async () => {
    const { user } = await openMatrix();
    await user.clear(cell('A+', 'PDD-E'));
    await user.type(cell('A+', 'PDD-E'), '7');
    expect(await seriousAxeViolations(screen.getByTestId('effort-matrix'))).toEqual([]);
  });
});

describe('P52-T01 — Chambers tab lists every lab-kind step from the served kinds', () => {
  it('shows PDD-F and PDD-H, and a step served as Lab appears', async () => {
    const s = settingsFixture();
    s.workflows[0]!.steps = s.workflows[0]!.steps.map((st) => (st.step_id === 'PDD-L' ? { ...st, kind: 'lab' } : st));
    settings = s;
    const { user } = await openMatrix();
    await user.click(screen.getByRole('tab', { name: 'Chambers' }));
    const list = screen.getByRole('list', { name: 'Lab-kind workflow steps' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'PDD-F · Proof of Concept',
      'PDD-H · Certification Testing & Compliance',
      'PDD-L · Pilot',
    ]);
  });
});
