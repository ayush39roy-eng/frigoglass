import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test/render';
import { autoReloadAllowed, editSessionHeld } from '@/test/reload-safety';
import { ROLE_MATRIX } from '@/test/roles';
import { permissionsFrom } from '@/test/session';
import { seriousAxeViolations } from '@/test/axe';
import { ROLE_NAMES } from '@/types/enums';

import type {
  ApplyPreviewResponse,
  CategoryTimeline,
  TemplateApplyResponse,
  WorkflowSettings,
} from './api/types';
import { settingsFixture, timelineFixture } from './test-fixtures';

/**
 * P33-T16 / T17 / T18 (ADR 0045, 0047; API_CONTRACT_P33 B2, C, D, E, Part I):
 * the category timeline editor, the apply dialog and "+ Add category", driven
 * through the real page and hooks with the HTTP client mocked at its edge.
 */

const http = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (path: string, opts?: unknown) => http.get(path, opts),
    apiSend: (method: string, path: string, body?: unknown) => http.send(method, path, body),
  };
});
const sse = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/lib/api/sse', () => ({ streamSolverProgress: (...a: unknown[]) => sse.stream(...a) }));

import { ApiError } from '@/lib/api/client';
import WorkflowSettingsPage from './WorkflowSettingsPage';

vi.setConfig({ testTimeout: 30_000 });

const TEMPLATES = { route: '/settings/workflow' };
/**
 * The preview is debounced on a real 150 ms timer; under a loaded full run the
 * default 1 s `waitFor` window can close before the request goes out. Timing
 * headroom only — the assertions are unchanged.
 */
const DEBOUNCED = { timeout: 5_000 };
const ADMIN = { roles: ['Admin' as const], permissions: ROLE_MATRIX.Admin };
/** Reads the templates, writes nothing (no role has this today; the gating must still hold). */
const VIEWER = { roles: ['Admin' as const], permissions: permissionsFrom({ workflow_settings: 'r', workflow_templates: 'r' }) };

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

beforeEach(() => {
  vi.clearAllMocks();
  settings = settingsFixture();
  timelines = [timelineFixture('A+')];
  http.get.mockImplementation(serveGet);
  http.send.mockImplementation(() => never());
  sse.stream.mockResolvedValue({ status: 'completed' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openTimelines(user: ReturnType<typeof userEvent.setup>, session?: Parameters<typeof renderWithProviders>[1]) {
  const view = renderWithProviders(<WorkflowSettingsPage />, { ...TEMPLATES, ...session });
  await user.click(await screen.findByRole('tab', { name: 'Timeline previews' }));
  await screen.findByTestId('timeline-A+');
  return view;
}

const card = () => screen.getByTestId('timeline-A+');

// --- P33-T16: the editor ---------------------------------------------------------

describe('P33-T16 — category timeline editor', () => {
  it('each click changes the preview request (debounced) and the timeline redraws from the response', async () => {
    const user = userEvent.setup();
    let reply: (t: CategoryTimeline) => void = () => undefined;
    http.send.mockImplementation((_m: string, path: string) =>
      path === '/workflow-templates/timeline-preview'
        ? new Promise((resolve) => {
            reply = (t) => resolve({ ...t, changed_step_ids: ['PDD-E'] });
          })
        : never(),
    );
    await openTimelines(user);
    await user.click(screen.getByRole('button', { name: 'Lengthen PDD-E by one week' }));
    expect(within(card()).getByTestId('length-PDD-E')).toHaveTextContent('7w');
    // Pending until the reply: the clicked bar is drawn optimistically, the status says so.
    expect(within(card()).getByTestId('step-PDD-E')).toHaveAttribute('data-pending', 'true');
    await waitFor(
      () =>
        expect(sends('/workflow-templates/timeline-preview')).toEqual([
          { workflow_id: 'PDD', category: 'A+', steps: [{ step_id: 'PDD-E', weeks: 7 }] },
        ]),
      DEBOUNCED,
    );
    expect(within(card()).getByRole('status')).toHaveTextContent('Updating the preview');

    act(() =>
      reply(
        timelineFixture('A+', { 'PDD-E': { duration_weeks: 7 } }, { total_weeks: 45, design_weeks: 23 }),
      ),
    );
    await waitFor(() => expect(within(card()).getByRole('button', { name: /A\+.*Timeline preview/ })).toHaveTextContent('(45w total)'));
    expect(within(card()).getByRole('button', { name: /A\+.*Timeline preview/ })).toHaveTextContent('Design 23w');
    expect(within(card()).getByTestId('step-PDD-E')).not.toHaveAttribute('data-pending');
    expect(within(card()).getByTestId('step-PDD-E')).toHaveTextContent('7 weeks');
    expect(within(card()).getByTestId('unsaved-A+')).toHaveTextContent('1 unsaved step');

    // Two Move − clicks quickly: ONE request (debounced) carrying both values.
    // Both clicks land in the same act, so no debounce timer can fire between
    // them. (Two awaited `user.click`s were flaky under a loaded full run: when
    // more than PREVIEW_DEBOUNCE_MS passed between them, the debounce rightly
    // sent a gap −1 request first and `sends[1]` was not −2.)
    const moveEarlier = screen.getByRole('button', { name: 'Move PDD-E one week earlier' });
    act(() => {
      fireEvent.click(moveEarlier);
      fireEvent.click(moveEarlier);
    });
    await waitFor(() => expect(sends('/workflow-templates/timeline-preview')).toHaveLength(2), DEBOUNCED);
    expect(sends('/workflow-templates/timeline-preview')[1]).toEqual({
      workflow_id: 'PDD',
      category: 'A+',
      steps: [{ step_id: 'PDD-E', weeks: 7, gap_weeks: -2 }],
    });
    act(() =>
      reply(
        timelineFixture('A+', {
          'PDD-E': { duration_weeks: 7, gap_weeks: -2, effective_gap_weeks: 0, flags: ['same_leader_serialised'] },
        }),
      ),
    );
    const note = await within(card()).findByTestId('flag-PDD-E-same_leader_serialised');
    expect(note).toHaveTextContent('Overlap — same leader, runs back-to-back');
    const badge = within(within(card()).getByTestId('step-PDD-E')).getByTestId('gap-badge');
    expect(badge).toHaveTextContent('−2w');
    expect(badge).toHaveTextContent('Overlap');
  });

  it('the first step has no Move; every other step has Move and Length with accessible names', async () => {
    const user = userEvent.setup();
    await openTimelines(user);
    const first = within(card()).getByTestId('step-PDD-A');
    expect(within(first).queryByRole('button', { name: /Move PDD-A/ })).not.toBeInTheDocument();
    expect(within(first).getByTestId('gap-badge')).toHaveTextContent('—');
    expect(within(first).getByRole('button', { name: 'Shorten PDD-A by one week' })).toBeInTheDocument();
    for (const name of ['Move PDD-N one week earlier', 'Move PDD-N one week later', 'Shorten PDD-N by one week', 'Lengthen PDD-N by one week']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('clamps at the range ends: length 0 and gap +104 disable the button', async () => {
    const user = userEvent.setup();
    settings.lead_times = settings.lead_times.map((lt) => (lt.step_id === 'PDD-B' ? { ...lt, gap_weeks: 104 } : lt));
    await openTimelines(user);
    expect(screen.getByRole('button', { name: 'Move PDD-B one week later' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move PDD-B one week earlier' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Shorten PDD-A by one week' }));
    expect(within(card()).getByTestId('length-PDD-A')).toHaveTextContent('0w');
    expect(screen.getByRole('button', { name: 'Shorten PDD-A by one week' })).toBeDisabled();
  });

  it('renders the served flags, the hatched wait and the template note', async () => {
    const user = userEvent.setup();
    timelines = [
      timelineFixture('A+', {
        'PDD-F': { gap_weeks: -9, effective_gap_weeks: -1, flags: ['anchor_clamped'] },
        'PDD-G': { gap_weeks: 3, effective_gap_weeks: 3 },
        'PDD-C': { duration_weeks: 0, flags: ['gap_ignored_zero_length'] },
      }),
    ];
    await openTimelines(user);
    expect(within(card()).getByTestId('flag-PDD-F-anchor_clamped')).toHaveTextContent('Can’t start before PDD-E starts');
    expect(within(card()).getByTestId('flag-PDD-C-gap_ignored_zero_length')).toHaveTextContent('0-week step: gap ignored');
    expect(within(card()).getByTestId('wait-PDD-G')).toBeInTheDocument();
    expect(within(card()).getByTestId('template-note')).toHaveTextContent('Real projects also wait for engineers and chambers.');
  });

  it('Discard and the per-row reset drop drafts; keyboard Enter / Space operate the buttons', async () => {
    const user = userEvent.setup();
    await openTimelines(user);
    const lengthen = screen.getByRole('button', { name: 'Lengthen PDD-E by one week' });
    lengthen.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(within(card()).getByTestId('length-PDD-E')).toHaveTextContent('8w');
    await user.click(screen.getByRole('button', { name: 'Reset PDD-E to the saved template' }));
    expect(within(card()).getByTestId('length-PDD-E')).toHaveTextContent('6w');
    expect(within(card()).queryByTestId('unsaved-A+')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move PDD-H one week later' }));
    await user.click(within(card()).getByRole('button', { name: 'Discard' }));
    expect(within(within(card()).getByTestId('step-PDD-H')).getByTestId('gap-badge')).toHaveTextContent('0w');
  });

  it('P49-R01 (Q49-1a): unsaved timeline drafts hold an auto reload until discarded', async () => {
    const user = userEvent.setup();
    await openTimelines(user);
    expect(editSessionHeld()).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Lengthen PDD-E by one week' }));
    expect(editSessionHeld()).toBe(true);
    expect(autoReloadAllowed()).toBe(false);
    await user.click(within(card()).getByRole('button', { name: 'Discard' }));
    expect(editSessionHeld()).toBe(false);
    expect(autoReloadAllowed()).toBe(true);
  });

  it('a viewer sees the timeline and gaps read-only, a notice, and never calls the preview', async () => {
    const user = userEvent.setup();
    await openTimelines(user, { session: VIEWER });
    expect(within(card()).getByTestId('step-PDD-E')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lengthen|Move PDD|Shorten/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save A\+/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add category' })).not.toBeInTheDocument();
    expect(screen.getByTestId('read-only-notice')).toHaveTextContent('Changing the category templates');
    expect(http.send).not.toHaveBeenCalled();
  });

  it('role matrix: only Admin and Super Admin get the editor; Admin keeps Steps & precedence read-only', async () => {
    for (const role of ROLE_NAMES) {
      const user = userEvent.setup();
      const { unmount } = renderWithProviders(<WorkflowSettingsPage />, {
        ...TEMPLATES,
        session: { roles: [role], permissions: ROLE_MATRIX[role] },
      });
      const canEdit = role === 'Admin' || role === 'Super Admin';
      if (canEdit) {
        // Steps & precedence (P52-T01: no longer the default tab): Super Admin edits, Admin reads.
        await user.click(await screen.findByRole('tab', { name: 'Steps & precedence' }));
        await screen.findByTestId('step-row-PDD-A');
        const notice = screen.queryByTestId('read-only-notice');
        if (role === 'Admin') expect(notice).toHaveTextContent('Super Admin only');
        else expect(notice).not.toBeInTheDocument();
        await user.click(await screen.findByRole('tab', { name: 'Timeline previews' }));
        await screen.findByTestId('timeline-A+');
        expect(screen.getByRole('button', { name: 'Lengthen PDD-E by one week' })).toBeInTheDocument();
        expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
        await user.click(screen.getByRole('tab', { name: 'Hub calendars' }));
        if (role === 'Admin') expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
      } else {
        expect(screen.queryByRole('tab', { name: 'Timeline previews' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Lengthen PDD/ })).not.toBeInTheDocument();
      }
      unmount();
    }
  });

  it('has no serious axe violations with drafts and flags on screen', async () => {
    const user = userEvent.setup();
    timelines = [timelineFixture('A+', { 'PDD-E': { flags: ['same_leader_serialised'], gap_weeks: -1 }, 'PDD-G': { gap_weeks: 2, effective_gap_weeks: 2 } })];
    await openTimelines(user);
    await user.click(screen.getByRole('button', { name: 'Lengthen PDD-B by one week' }));
    expect(await seriousAxeViolations(card())).toEqual([]);
  });
});

// --- P33-T17: the apply dialog ---------------------------------------------------

const P = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  project_id: id,
  name,
  hub: 'R&D-Greece',
  status: 'In Queue',
  steps: [{ step_id: 'PDD-E', eff_before: 6, eff_after: 7, gap_before: 0, gap_after: 0, flags: [] }],
  ...extra,
});

function previewFixture(over: Partial<ApplyPreviewResponse> = {}): ApplyPreviewResponse {
  return {
    categories: [{ workflow_id: 'PDD', category: 'A+', timeline: timelineFixture('A+') }],
    counts: { automatic: 2, choosable: 2, own_effort: 1, never: 1 },
    automatic: [
      P('p-1', 'Alpha cooler', {
        steps: [
          { step_id: 'PDD-E', eff_before: 6, eff_after: 7, gap_before: 0, gap_after: 0, flags: [] },
          { step_id: 'PDD-C', eff_before: 0, eff_after: 1, gap_before: 0, gap_after: 0, flags: ['revived'] },
          { step_id: 'PDD-L', eff_before: 3, eff_after: 0, gap_before: 0, gap_after: 0, flags: ['skipped_now'] },
          { step_id: 'PDD-G', eff_before: 0, eff_after: 0, gap_before: 0, gap_after: 2, flags: ['gap_ignored_skipped'] },
          { step_id: 'PDD-H', eff_before: 0, eff_after: 0, gap_before: 0, gap_after: 0, flags: ['cert_off_no_effect'] },
        ],
      }),
      P('p-5', 'Epsilon', {
        steps: [{ step_id: 'PDD-E', eff_before: 4, eff_after: 4, gap_before: 0, gap_after: -2, flags: ['own_effort_length_not_applied'] }],
      }),
    ] as unknown as ApplyPreviewResponse['automatic'],
    choosable: [
      P('p-2', 'Beta freezer', { status: 'In Development', current_stage: { step_id: 'PDD-D', name: 'Final Technical Brief & Project Kick-off', status: 'In Progress' } }),
      P('p-3', 'Gamma chiller', { hub: 'PD-India', status: 'In Development', current_stage: { step_id: 'PDD-B', name: 'Feasibility Study', status: 'Blocked' } }),
    ] as unknown as ApplyPreviewResponse['choosable'],
    own_effort: [
      { project_id: 'p-4', name: 'Delta display', hub: 'R&D-Greece', status: 'In Queue', step_ids: ['PDD-E'], kinds: ['design'], reason: 'own_effort_length_not_applied' },
    ],
    never: [{ project_id: 'p-9', name: 'Omega', hub: 'R&D-Greece', reason: 'frozen', step_ids: ['PDD-E'] }],
    ...over,
  };
}

const APPLIED: TemplateApplyResponse = {
  template_change_id: 'chg-1',
  versions: [{ workflow_id: 'PDD', category: 'A+', template_version: 2 }],
  applied: { automatic: 2, selected: 0, own_effort_not_applied: 1 },
  not_applied: [],
  recalc_status: 'not_needed',
  schedule_run_id: null,
  task_id: null,
};

function serveApply(apply: () => Promise<unknown>, preview: () => Promise<unknown> = () => Promise.resolve(previewFixture())) {
  http.send.mockImplementation((_m: string, path: string, body: unknown) => {
    if (path === '/workflow-templates/timeline-preview') {
      return Promise.resolve({ ...timelineFixture('A+'), changed_step_ids: Object.keys(body ?? {}) });
    }
    if (path === '/workflow-templates/apply-preview') return preview();
    if (path === '/workflow-templates/apply') return apply();
    return never();
  });
}

async function draftAndSave(user: ReturnType<typeof userEvent.setup>, session?: Parameters<typeof renderWithProviders>[1]) {
  await openTimelines(user, session);
  await user.click(screen.getByRole('button', { name: 'Lengthen PDD-E by one week' }));
  await user.click(within(card()).getByRole('button', { name: 'Save A+…' }));
  return screen.findByTestId('template-apply-dialog');
}

describe('P33-T17 — apply dialog', () => {
  it('Save asks apply-preview with base_version and lists the four sections; default applies to none of the started projects', async () => {
    const user = userEvent.setup();
    serveApply(() => Promise.resolve(APPLIED));
    const dialog = await draftAndSave(user);
    expect(sends('/workflow-templates/apply-preview')).toEqual([
      { changes: [{ workflow_id: 'PDD', category: 'A+', base_version: 1, steps: [{ step_id: 'PDD-E', weeks: 7 }] }] },
    ]);
    await within(dialog).findByTestId('apply-counts');
    expect(within(dialog).getByText('A+ · PDD-E length 6w → 7w')).toBeInTheDocument();
    expect(within(dialog).getByTestId('apply-automatic')).toHaveTextContent('Updated automatically (2)');
    expect(within(dialog).getByTestId('apply-choosable')).toHaveTextContent('Choose (2)');
    expect(within(dialog).getByTestId('apply-own-effort')).toHaveTextContent('Uses its own weeks — length not changed (1)');
    expect(within(dialog).getByTestId('apply-never')).toHaveTextContent('Not changed (1)');
    await user.click(within(dialog).getByTestId('apply-confirm'));
    await waitFor(() => expect(sends('/workflow-templates/apply')).toHaveLength(1));
    expect(sends('/workflow-templates/apply')[0]).toEqual({
      changes: [{ workflow_id: 'PDD', category: 'A+', base_version: 1, steps: [{ step_id: 'PDD-E', weeks: 7 }] }],
      selection: { mode: 'none', project_ids: [] },
    });
    const panel = await screen.findByTestId('template-apply-panel');
    expect(panel).toHaveTextContent('Applied to 2 projects automatically.');
    expect(panel).toHaveTextContent('1 project use their own weeks — length not changed.');
    expect(panel).toHaveTextContent('did not need recalculating');
    // Drafts are cleared once applied.
    expect(within(card()).queryByTestId('unsaved-A+')).not.toBeInTheDocument();
  });

  it('"Apply to all" sends all_not_reached; a queued run is followed to "Timeline recalculated"', async () => {
    const user = userEvent.setup();
    serveApply(() => Promise.resolve({ ...APPLIED, recalc_status: 'queued', schedule_run_id: 'run-7', applied: { automatic: 2, selected: 2, own_effort_not_applied: 1 } }));
    const dialog = await draftAndSave(user);
    await user.click(await within(dialog).findByRole('radio', { name: /Apply to all 2 projects that have not reached these stages/ }));
    expect(within(dialog).getByTestId('apply-footer-summary')).toHaveTextContent('Changes 2 projects automatically and 2 projects you chose.');
    await user.click(within(dialog).getByTestId('apply-confirm'));
    await waitFor(() => expect(sends('/workflow-templates/apply')[0]).toMatchObject({ selection: { mode: 'all_not_reached', project_ids: [] } }));
    const panel = await screen.findByTestId('template-apply-panel');
    await waitFor(() => expect(panel).toHaveAttribute('data-kind', 'updated'));
    expect(sse.stream).toHaveBeenCalledWith('run-7', expect.any(Function), expect.anything());
    expect(panel).toHaveTextContent('Timeline recalculated');
    expect(panel).toHaveTextContent('and 2 projects you chose');
  });

  it('"Choose projects": search, tick one, sends selected; the race summary names a project that started meanwhile', async () => {
    const user = userEvent.setup();
    serveApply(() =>
      Promise.resolve({
        ...APPLIED,
        recalc_status: 'deferred',
        not_applied: [{ project_id: 'p-3', reason: 'reached_stage' }],
      }),
    );
    const dialog = await draftAndSave(user);
    const choose = await within(dialog).findByTestId('apply-choosable');
    expect(within(choose).getByRole('radio', { name: /Choose projects/ })).toBeChecked();
    expect(within(choose).getByText(/Now at PDD-D Final Technical Brief & Project Kick-off \(In Progress\)/)).toBeInTheDocument();
    expect(within(choose).getByText(/Now at PDD-B Feasibility Study \(On Hold\)/)).toBeInTheDocument();
    await user.type(within(choose).getByRole('searchbox', { name: 'Search projects to choose' }), 'india');
    expect(within(choose).queryByRole('checkbox', { name: 'Apply to Beta freezer' })).not.toBeInTheDocument();
    await user.click(within(choose).getByRole('checkbox', { name: 'Apply to Gamma chiller' }));
    expect(within(choose).getByText('(1 chosen)')).toBeInTheDocument();
    await user.click(within(dialog).getByTestId('apply-confirm'));
    await waitFor(() => expect(sends('/workflow-templates/apply')[0]).toMatchObject({ selection: { mode: 'selected', project_ids: ['p-3'] } }));
    const panel = await screen.findByTestId('template-apply-panel');
    expect(within(panel).getByTestId('template-apply-not-applied')).toHaveTextContent('Gamma chiller started this step meanwhile — not changed');
    // Manual recalculation (2026-11-24): a deferred apply ran nothing; no follow-up is promised.
    expect(panel).toHaveTextContent('Press Recalculate once you are done editing to update the timeline.');
    expect(panel).not.toHaveTextContent('updates automatically');
  });

  it('shows the own-effort section, the never reasons and every step flag as a note', async () => {
    const user = userEvent.setup();
    serveApply(() => Promise.resolve(APPLIED));
    const dialog = await draftAndSave(user);
    const own = await within(dialog).findByTestId('apply-own-effort');
    await user.click(within(own).getByRole('button', { name: 'Show 1 project' }));
    expect(own).toHaveTextContent('Delta display');
    expect(own).toHaveTextContent('PDD-E: uses its own weeks — length not changed');
    const never = within(dialog).getByTestId('apply-never');
    await user.click(within(never).getByRole('button', { name: 'Show 1 project' }));
    expect(never).toHaveTextContent('Omega');
    expect(never).toHaveTextContent('Frozen');
    const auto = within(dialog).getByTestId('apply-automatic');
    await user.click(within(auto).getByRole('button', { name: 'Show 2 projects' }));
    expect(within(auto).getByTestId('apply-flag-revived')).toHaveTextContent('was skipped, now runs');
    expect(within(auto).getByTestId('apply-flag-skipped_now')).toHaveTextContent('now skipped (0 weeks)');
    expect(within(auto).getByTestId('apply-flag-gap_ignored_skipped')).toHaveTextContent('gap has no effect');
    expect(within(auto).getByTestId('apply-flag-cert_off_no_effect')).toHaveTextContent('certification testing is off');
    expect(within(auto).getByTestId('apply-flag-own_effort_length_not_applied')).toHaveTextContent('uses its own weeks');
    expect(auto).toHaveTextContent('PDD-E6w → 7w');
    expect(auto).toHaveTextContent('gap 0w → −2w');
    expect(await seriousAxeViolations(dialog)).toEqual([]);
  });

  it('409 TEMPLATE_CHANGED reloads the template and explains; nothing is applied', async () => {
    const user = userEvent.setup();
    serveApply(() => Promise.reject(new ApiError(409, 'conflict', '{"message":"x"}', 'TEMPLATE_CHANGED')));
    const dialog = await draftAndSave(user);
    const settingsReads = http.get.mock.calls.filter(([p]) => p === '/workflow-settings').length;
    await user.click(await within(dialog).findByTestId('apply-confirm'));
    expect(await within(dialog).findByTestId('template-apply-error')).toHaveTextContent('Someone saved this category meanwhile');
    expect(within(dialog).queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    await waitFor(() => expect(http.get.mock.calls.filter(([p]) => p === '/workflow-settings').length).toBeGreaterThan(settingsReads));
    expect(screen.queryByTestId('template-apply-panel')).not.toBeInTheDocument();
  });

  it('a 409 on the apply-preview itself is explained the same way', async () => {
    const user = userEvent.setup();
    serveApply(
      () => never(),
      () => Promise.reject(new ApiError(409, 'conflict', undefined, 'TEMPLATE_CHANGED')),
    );
    const dialog = await draftAndSave(user);
    expect(await within(dialog).findByTestId('template-apply-error')).toHaveTextContent('Someone saved this category meanwhile');
  });

  it('429 says how long to wait; Back returns to the lists and a second Apply goes through', async () => {
    const user = userEvent.setup();
    let calls = 0;
    serveApply(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new ApiError(429, 'slow', undefined, 'RATE_LIMITED', 7)) : Promise.resolve(APPLIED);
    });
    const dialog = await draftAndSave(user);
    await user.click(await within(dialog).findByTestId('apply-confirm'));
    expect(await within(dialog).findByTestId('template-apply-error')).toHaveTextContent('wait 7 s and try again. Nothing was saved.');
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    await user.click(within(dialog).getByTestId('apply-confirm'));
    expect(await screen.findByTestId('template-apply-panel')).toHaveTextContent('Template saved');
  });

  it('an Admin (not Super Admin) can apply', async () => {
    const user = userEvent.setup();
    serveApply(() => Promise.resolve(APPLIED));
    const dialog = await draftAndSave(user, { session: ADMIN });
    await user.click(await within(dialog).findByTestId('apply-confirm'));
    expect(await screen.findByTestId('template-apply-panel')).toHaveTextContent('Template saved');
    expect(sends('/workflow-templates/apply')).toHaveLength(1);
  });

  it('the Lead times tab is editable for workflow_templates.write and saves through the same flow', async () => {
    const user = userEvent.setup();
    serveApply(() => Promise.resolve(APPLIED));
    renderWithProviders(<WorkflowSettingsPage />, { ...TEMPLATES, session: ADMIN });
    await user.click(await screen.findByRole('tab', { name: 'Lead times' }));
    expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
    const cell = within(screen.getByTestId('lead-row-A+')).getByLabelText('PDD A+ PDD-B weeks');
    await user.clear(cell);
    await user.type(cell, '6');
    await user.click(screen.getByRole('button', { name: 'Save 1 change…' }));
    const dialog = await screen.findByTestId('template-apply-dialog');
    expect(sends('/workflow-templates/apply-preview')).toEqual([
      { changes: [{ workflow_id: 'PDD', category: 'A+', base_version: 1, steps: [{ step_id: 'PDD-B', weeks: 6 }] }] },
    ]);
    expect(within(dialog).getByText('A+ · PDD-B length 8w → 6w')).toBeInTheDocument();
    await user.click(await within(dialog).findByTestId('apply-confirm'));
    await waitFor(() => expect(sends('/workflow-templates/apply')).toHaveLength(1));
  });

  it('the Lead times tab is read-only without workflow_templates.write', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowSettingsPage />, { ...TEMPLATES, session: VIEWER });
    await user.click(await screen.findByRole('tab', { name: 'Lead times' }));
    expect(screen.queryByLabelText('PDD A+ PDD-B weeks')).not.toBeInTheDocument();
    expect(screen.getByTestId('read-only-notice')).toHaveTextContent('Changing the category templates');
  });
});

// --- P33-T18: + Add category -----------------------------------------------------

describe('P33-T18 — add category', () => {
  async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await openTimelines(user, { session: ADMIN });
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    return screen.findByTestId('add-category-dialog');
  }

  it('"+ Add category" is a standard-size primary button in the tab header (owner 2026-11-16)', async () => {
    const user = userEvent.setup();
    await openTimelines(user, { session: ADMIN });
    const button = screen.getByRole('button', { name: 'Add category' });
    expect(button).toHaveClass('bg-primary', 'h-9');
    expect(button).not.toHaveClass('h-8');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('lists the position in rank order and copy-from within the chosen workflow', async () => {
    const user = userEvent.setup();
    const dialog = await openAdd(user);
    const position = within(dialog).getByRole('combobox', { name: 'Place in the scheduling order' });
    expect(within(position).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'First (before A+)',
      'After A+',
      'After A',
      'After B',
      'After C',
      'After A-OEM',
      'After B-OEM',
      'After C-OEM',
    ]);
    const copy = within(dialog).getByRole('combobox', { name: 'Copy the template from' });
    expect(within(copy).getAllByRole('option').map((o) => o.textContent)).toEqual(['A+', 'A', 'B', 'C']);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Workflow' }), 'OEM');
    expect(within(copy).getAllByRole('option').map((o) => o.textContent)).toEqual(['A-OEM', 'B-OEM', 'C-OEM']);
    expect(await seriousAxeViolations(dialog)).toEqual([]);
  });

  it.each([
    ['BAD_CATEGORY_CODE', 422, 'Code', 'is reserved'],
    ['CATEGORY_EXISTS', 409, 'Code', 'already exists'],
    ['BAD_COPY_SOURCE', 422, 'Copy the template from', 'same workflow'],
    ['BAD_POSITION', 422, 'Place in the scheduling order', 'no longer exists'],
  ])('%s is shown next to its field', async (code, status, field, text) => {
    const user = userEvent.setup();
    http.send.mockImplementation((_m: string, path: string) =>
      path === '/workflow-templates/categories' ? Promise.reject(new ApiError(status, 'no', 'x', code)) : never(),
    );
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Code'), 'OEM');
    await user.click(within(dialog).getByRole('button', { name: 'Add category' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(text);
    const input = within(dialog).getByLabelText(field);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('a 429 and an empty code are explained; nothing is sent for an empty code', async () => {
    const user = userEvent.setup();
    http.send.mockImplementation((_m: string, path: string) =>
      path === '/workflow-templates/categories' ? Promise.reject(new ApiError(429, 'slow', undefined, 'RATE_LIMITED', 9)) : never(),
    );
    const dialog = await openAdd(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add category' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter a code.');
    expect(sends('/workflow-templates/categories')).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Code'), 'B2');
    await user.click(within(dialog).getByRole('button', { name: 'Add category' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('wait 9 s');
  });

  it('on success: sends the B2 body, refreshes categories and settings, opens the new timeline', async () => {
    const user = userEvent.setup();
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const b2 = { code: 'B2', label: 'Light refresh', workflow_id: 'PDD' as const, rank: 4 };
    http.send.mockImplementation((_m: string, path: string) => {
      if (path !== '/workflow-templates/categories') return never();
      timelines = [timelineFixture('A+'), timelineFixture('B2', {}, { label: 'Light refresh', rank: 4 })];
      return Promise.resolve({ category: b2, categories: [b2], template_rows: 14, engineers_extended: 3 });
    });
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Code'), ' B2 ');
    await user.type(within(dialog).getByLabelText('Name (optional)'), 'Light refresh');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Copy the template from' }), 'B');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Place in the scheduling order' }), 'B');
    await user.click(within(dialog).getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(screen.queryByTestId('add-category-dialog')).not.toBeInTheDocument());
    expect(sends('/workflow-templates/categories')).toEqual([
      { code: 'B2', label: 'Light refresh', workflow_id: 'PDD', copy_from: 'B', insert_after: 'B' },
    ]);
    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify((f as { queryKey?: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(['reference', 'categories']));
    expect(keys).toContain(JSON.stringify(['workflow-settings']));
    const opened = await screen.findByTestId('timeline-B2');
    expect(within(opened).getByRole('button', { name: /B2.*Timeline preview/ })).toHaveAttribute('aria-expanded', 'true');
  });
});
