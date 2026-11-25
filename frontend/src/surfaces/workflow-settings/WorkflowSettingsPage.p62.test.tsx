import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { seriousAxeViolations } from '@/test/axe';

import type { ApplyPreviewResponse, CategoryTimeline, TemplateApplyResponse, WorkflowSettings } from './api/types';
import { settingsFixture, timelineFixture } from './test-fixtures';

/**
 * P62-T05 (ADR 0071, API_CONTRACT_P62 §4 / §8): room weeks on the Workflow
 * page — the matrix hint and L total, and the Room control on a timeline,
 * saved through the one apply (E2 preview body carries `lab_hold_weeks`).
 * Same mocked-at-the-edge setup as the P52 test.
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

async function openMatrix() {
  const user = userEvent.setup();
  const view = renderWithProviders(<WorkflowSettingsPage />, { ...ROUTE, session: ADMIN });
  await screen.findByTestId('matrix-row-PDD-A+');
  return { user, view };
}

const totals = (category: string) => screen.getByTestId(`total-PDD-${category}`);

/** PDD-J as a lab step holding its last week in A+ (the P62 default), served on C1 and C2. */
function withRoomOnJ(): void {
  settings.workflows[0]!.steps = settings.workflows[0]!.steps.map((s) => (s.step_id === 'PDD-J' ? { ...s, kind: 'lab' } : s));
  settings.lead_times = settings.lead_times.map((lt) => (lt.step_id === 'PDD-J' ? { ...lt, lab_hold_weeks: 1 } : lt));
  timelines = [
    timelineFixture(
      'A+',
      { 'PDD-J': { resource_kind: 'lab', lab_hold_weeks: 1, room_weeks: 1, room_start_week: 36 } },
      { lab_weeks: 13, lab_length_weeks: 13 },
    ),
  ];
}

describe('P62-T05 — room weeks on the Workflow page', () => {
  it('matrix: a lab cell with room weeks says so; L counts room weeks (F 6 + H 6 + J room 1)', async () => {
    withRoomOnJ();
    await openMatrix();
    expect(screen.getByTestId('room-PDD-A+-PDD-J')).toHaveTextContent('Room booked for the last 1 of 1 weeks');
    expect(screen.queryByTestId('room-PDD-A+-PDD-F')).not.toBeInTheDocument();
    expect(within(totals('A+')).getByTestId('total-lab')).toHaveTextContent('L: 13 w');
  });

  it('Room − on a timeline is a draft; Apply to App sends lab_hold_weeks through the one apply', async () => {
    withRoomOnJ();
    const { user, view } = await openMatrix();
    const card = screen.getByTestId('matrix-card-PDD');
    await user.click(await within(card).findByRole('button', { name: /A\+\s*Timeline preview/ }));
    const fRoom = await within(card).findByRole('group', { name: 'Room weeks of PDD-F' });
    await user.click(within(fRoom).getByRole('button', { name: 'One room week fewer for PDD-F' }));
    expect(within(fRoom).getByTestId('room-value-PDD-F')).toHaveTextContent('5w');
    expect(screen.getByTestId('apply-to-app')).toHaveTextContent('Apply to App (1)');
    // J: Full is offered (saved 1), and the help text says what a set value means.
    expect(within(card).getByTestId('flag-PDD-J-room-set')).toHaveTextContent('Room weeks set: length from the template');
    await user.click(within(card).getByRole('button', { name: 'Room weeks of PDD-J: Full (the whole length)' }));
    expect(screen.getByTestId('apply-to-app')).toHaveTextContent('Apply to App (2)');
    expect(await seriousAxeViolations(view.container)).toEqual([]);

    await user.click(screen.getByTestId('apply-to-app'));
    await waitFor(() => expect(sends('/workflow-templates/apply-preview')).toHaveLength(1));
    expect(sends('/workflow-templates/apply-preview')[0]).toEqual({
      changes: [
        {
          workflow_id: 'PDD',
          category: 'A+',
          base_version: 1,
          steps: [
            { step_id: 'PDD-F', lab_hold_weeks: 5 },
            { step_id: 'PDD-J', lab_hold_weeks: 'full' },
          ],
        },
      ],
    });
    const dialog = await screen.findByTestId('template-apply-dialog');
    expect(within(dialog).getByRole('list', { name: 'Changes to save' })).toHaveTextContent('A+ · PDD-F room weeks Full → 5w');
    expect(within(dialog).getByRole('list', { name: 'Changes to save' })).toHaveTextContent('A+ · PDD-J room weeks 1w → Full');
  });
});
