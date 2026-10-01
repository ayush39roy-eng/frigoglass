import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { ApiError } from '@/lib/api/client';
import { seriousAxeViolations } from '@/test/axe';

import type { WorkspaceHealth, WorkspaceResponse } from './api/types';
import { workspaceFixture } from './test-fixtures';

const api = {
  fetchWorkspace: vi.fn(),
  patchStage: vi.fn(),
  recalculate: vi.fn(),
  uploadFile: vi.fn(),
  patchFile: vi.fn(),
  createComment: vi.fn(),
  editComment: vi.fn(),
  deleteComment: vi.fn(),
  fetchActivity: vi.fn(),
  searchMentions: vi.fn(),
  downloadFile: vi.fn(),
  askAgent: vi.fn(),
};
vi.mock('./api/workspace-api', () => ({
  fetchWorkspace: (...a: unknown[]) => api.fetchWorkspace(...a),
  patchStage: (...a: unknown[]) => api.patchStage(...a),
  recalculate: (...a: unknown[]) => api.recalculate(...a),
  uploadFile: (...a: unknown[]) => api.uploadFile(...a),
  patchFile: (...a: unknown[]) => api.patchFile(...a),
  createComment: (...a: unknown[]) => api.createComment(...a),
  editComment: (...a: unknown[]) => api.editComment(...a),
  deleteComment: (...a: unknown[]) => api.deleteComment(...a),
  fetchActivity: (...a: unknown[]) => api.fetchActivity(...a),
  searchMentions: (...a: unknown[]) => api.searchMentions(...a),
  downloadFile: (...a: unknown[]) => api.downloadFile(...a),
  askAgent: (...a: unknown[]) => api.askAgent(...a),
  retryUnlessAuth: () => false,
}));
const sse = { streamSolverProgress: vi.fn() };
vi.mock('@/lib/api/sse', () => ({
  streamSolverProgress: (...a: unknown[]) => sse.streamSolverProgress(...a),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({ data: [{ id: 'hub-in', name: 'PD-India', lab_region: 'India', is_oem: false }] }),
  useCategoriesForHub: () => ({ data: undefined, options: ['A+', 'A', 'B', 'C'] }),
}));
vi.mock('@/surfaces/registration/hooks/use-registration', () => ({
  useEngineerOptions: () => ({ data: [] }),
}));

import ProjectWorkspacePage from './ProjectWorkspacePage';

function renderPage(options?: Parameters<typeof renderWithProviders>[1]) {
  return renderWithProviders(
    <Routes>
      <Route path="*" element={<ProjectWorkspacePage />} />
    </Routes>,
    options,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchWorkspace.mockResolvedValue(workspaceFixture());
  api.searchMentions.mockResolvedValue([]);
});

describe('ProjectWorkspacePage — header and health (I13)', () => {
  it.each<[WorkspaceHealth, string]>([
    ['on_track', 'On track'],
    ['at_risk', 'At risk'],
    ['off_track', 'Off track'],
    ['left_out', 'Left out'],
    ['blocked', 'Blocked'], // remediation ruling 5
    ['unscheduled', 'Not scheduled'],
  ])('renders the server health %s as "%s" (icon + label, never derived)', async (health, label) => {
    api.fetchWorkspace.mockResolvedValue(workspaceFixture({ health }));
    renderPage();
    const badge = await screen.findByTestId('health-badge');
    expect(badge).toHaveAttribute('data-health', health);
    expect(badge).toHaveTextContent(label);
  });

  it('shows name, ID, hub, category, priority; a withheld leader reads "Withheld (GDPR pending)"', async () => {
    renderPage();
    const header = await screen.findByTestId('workspace-header');
    expect(within(header).getByRole('heading', { name: 'Cooler Alpha' })).toBeInTheDocument();
    expect(header).toHaveTextContent('ID RPD-0042');
    expect(header).toHaveTextContent('PD-India');
    expect(within(header).getByTestId('leader-withheld')).toHaveTextContent('Withheld (GDPR pending)');
  });

  it('renders the roll-up bar from the server progress_pct and the completion strip from server weeks', async () => {
    renderPage();
    expect(await screen.findByTestId('progress-pct')).toHaveTextContent('37%');
    expect(screen.getByRole('progressbar', { name: /Project progress/ })).toHaveAttribute('aria-valuenow', '37');
    expect(screen.getByTestId('strip-expected')).toHaveTextContent('W48');
    expect(screen.getByTestId('strip-projected')).toHaveTextContent('W50');
    expect(screen.getByTestId('strip-slip')).toHaveTextContent('+2 wk');
    expect(screen.getByText('Expected (target)')).toBeInTheDocument();
  });

  it('a 404 renders "Project not found", not a blank page', async () => {
    api.fetchWorkspace.mockRejectedValue(new ApiError(404, 'nf'));
    renderPage();
    expect(await screen.findByText('Project not found')).toBeInTheDocument();
  });
});

describe('Progress panel — stages', () => {
  it('shows kind badges, the n/a chip for a skipped stage and the overrun chip', async () => {
    renderPage();
    const skipped = await screen.findByTestId('stage-PDD-C');
    expect(skipped).toHaveTextContent('n/a');
    expect(within(skipped).queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByTestId('overrun-PDD-B')).toHaveTextContent('+1 wk over');
  });

  it('refuses to save Blocked without a reason, then PATCHes all six fields and shows the stale banner', async () => {
    const user = userEvent.setup();
    const stale: WorkspaceResponse = workspaceFixture({
      schedule: { ...workspaceFixture().schedule, schedule_stale: true },
    });
    api.patchStage.mockResolvedValue(stale);
    renderPage();
    const row = await screen.findByTestId('stage-PDD-B');
    await user.click(within(row).getByRole('combobox', { name: 'Status — Feasibility Study (Conceptual Design)' }));
    await user.click(await screen.findByRole('option', { name: 'Blocked' }));
    expect(within(row).getByTestId('stage-errors-PDD-B')).toHaveTextContent('A blocked stage needs a reason.');
    const save = within(row).getByRole('button', { name: /Save progress/ });
    expect(save).toBeDisabled();

    await user.type(within(row).getByLabelText(/Blocked reason/), 'Waiting on supplier drawings');
    expect(save).toBeEnabled();
    await user.click(save);
    // MemoryRouter starts at "/", so the route param is '' here; the API is mocked.
    expect(api.patchStage).toHaveBeenCalledWith('', 'PDD-B', {
      status: 'Blocked',
      percent_complete: 50,
      actual_start_week: 22,
      actual_end_week: null,
      remaining_weeks_override: null,
      blocked_reason: 'Waiting on supplier drawings',
    });
    expect(await screen.findByTestId('progress-stale-banner')).toHaveTextContent('Progress updated. Schedule is now stale.');
  });

  it('Done requires an actual end week not before the start; the percent is set to 100', async () => {
    const user = userEvent.setup();
    renderPage();
    const row = await screen.findByTestId('stage-PDD-B');
    await user.click(within(row).getByRole('combobox', { name: /^Status — / }));
    await user.click(await screen.findByRole('option', { name: 'Done' }));
    expect(within(row).getByLabelText(/^Percent complete — /)).toHaveValue(100);
    expect(within(row).getByTestId('stage-errors-PDD-B')).toHaveTextContent('Actual end week is required');
    await user.type(within(row).getByLabelText(/^Actual end week — /), '21');
    expect(within(row).getByTestId('stage-errors-PDD-B')).toHaveTextContent('cannot be before the actual start');
  });

  it('a 409 RUN_IN_PROGRESS reads "A recalculation is already running"', async () => {
    const user = userEvent.setup();
    api.recalculate.mockRejectedValue(new ApiError(409, 'busy', 'run queued', 'RUN_IN_PROGRESS'));
    renderPage();
    const header = await screen.findByTestId('workspace-header');
    await user.click(within(header).getByRole('button', { name: 'Recalculate schedule' }));
    expect(await within(header).findByText(/A recalculation is already running/)).toBeInTheDocument();
    expect(sse.streamSolverProgress).not.toHaveBeenCalled();
  });

  it('a STAGE_INCONSISTENT 422 shows the readable message with the field error', async () => {
    const user = userEvent.setup();
    api.patchStage.mockRejectedValue(
      new ApiError(422, 'bad', JSON.stringify([{ loc: ['body', 'actual_start_week'], msg: 'must not be after CURRENT_WEEK', type: 'value_error' }]), 'STAGE_INCONSISTENT'),
    );
    renderPage();
    const row = await screen.findByTestId('stage-PDD-B');
    const pct = within(row).getByLabelText(/^Percent complete — /);
    await user.clear(pct);
    await user.type(pct, '60');
    await user.click(within(row).getByRole('button', { name: /Save progress/ }));
    expect(await within(row).findByText(/These progress values contradict each other. actual_start_week: must not be after CURRENT_WEEK/)).toBeInTheDocument();
  });

  it('Recalculate dispatches, follows the SSE stream and reports completion', async () => {
    const user = userEvent.setup();
    api.fetchWorkspace.mockResolvedValue(workspaceFixture({ schedule: { ...workspaceFixture().schedule, schedule_stale: true } }));
    api.recalculate.mockResolvedValue({ schedule_run_id: 'run-9', task_id: 't' });
    sse.streamSolverProgress.mockImplementation(async (_id: string, onEvent: (e: unknown) => void) => {
      onEvent({ schedule_run_id: 'run-9', status: 'running', percent: 40 });
      return { schedule_run_id: 'run-9', status: 'completed' };
    });
    renderPage();
    const banner = await screen.findByTestId('progress-stale-banner');
    await user.click(within(banner).getByRole('button', { name: 'Recalculate schedule' }));
    await waitFor(() => expect(sse.streamSolverProgress).toHaveBeenCalledWith('run-9', expect.any(Function), expect.any(AbortSignal)));
    expect((await screen.findAllByText(/Schedule recalculated — a new schedule version is active/)).length).toBeGreaterThan(0);
  });
});

describe('Files panel', () => {
  it('groups versions under the newest one; older versions stay downloadable; uploader withheld unless it is you', async () => {
    renderPage();
    const row = await screen.findByTestId('file-f-1');
    expect(screen.queryByTestId('file-f-0')).not.toBeInTheDocument();
    expect(row).toHaveTextContent('v2');
    expect(row).toHaveTextContent('Certification');
    expect(row).toHaveTextContent('Uploader withheld (GDPR pending)');
    expect(within(row).getByRole('button', { name: 'Download Certification report v2' })).toBeInTheDocument();
    const older = within(row).getByTestId('older-versions-f-1');
    expect(older).toHaveTextContent('Older versions (1)');
    expect(within(older).getByRole('button', { name: 'Download Certification report v1' })).toBeInTheDocument();
    expect(screen.getByText(/1 file · 2 versions/)).toBeInTheDocument();
  });

  it('rejects an over-50 MB file and a missing category before uploading', async () => {
    const user = userEvent.setup();
    renderPage();
    // Scoped to the upload region for speed — see the next test's note.
    const upload = within(await screen.findByTestId('file-upload'));
    const big = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    await user.upload(upload.getByLabelText('File to upload'), big);
    expect(upload.getByText('Files are limited to 50 MB.')).toHaveAttribute('role', 'alert');
    await user.click(upload.getByRole('button', { name: 'Upload' }));
    expect(upload.getByText('Choose a category.')).toBeInTheDocument();
    expect(api.uploadFile).not.toHaveBeenCalled();
  });

  // De-flaked in P9-R03. The cause was NOT userEvent typing (about 95 ms): it was
  // three whole-document `*ByLabelText` / `*ByRole` queries. Each one walks every
  // labelled control on the workspace (14 stage rows, 13 scoring dimensions, the
  // composer …), about 0.5 s apiece in jsdom and about 2.2 s per test alone, which
  // passed 10 s under full-suite CPU contention. Queries are now scoped to the
  // upload region, found by test id (a single querySelector). The timeout is unchanged.
  it('uploads a valid file and hints the next version for an existing display name', async () => {
    const user = userEvent.setup();
    api.uploadFile.mockResolvedValue({});
    renderPage();
    const upload = within(await screen.findByTestId('file-upload'));
    await user.upload(upload.getByLabelText('File to upload'), new File(['%PDF'], 'report.pdf', { type: 'application/pdf' }));
    const name = upload.getByLabelText(/^Display name/);
    await user.clear(name);
    await user.type(name, 'Certification report');
    expect(upload.getByTestId('version-hint')).toHaveTextContent('uploads v3');
    await user.selectOptions(upload.getByLabelText(/^Category/), 'Certification');
    await user.click(upload.getByRole('button', { name: 'Upload' }));
    await waitFor(() => {
      expect(api.uploadFile).toHaveBeenCalledWith(
        'p-1',
        expect.objectContaining({ display_name: 'Certification report', category: 'Certification' }),
      );
    });
  });
});

describe('Activity & comments', () => {
  it('renders Markdown as elements with script text inert, interleaves system events, withholds names', async () => {
    renderPage();
    const comments = await screen.findAllByTestId('activity-comment');
    expect(comments[0]?.querySelector('strong')).toHaveTextContent('confirmed');
    expect(comments[0]?.querySelector('script')).toBeNull();
    expect(comments[0]).toHaveTextContent('<script>alert(1)</script>');
    expect(screen.getByTestId('activity-event')).toHaveTextContent(
      'Schedule recalculated — finish moved week 49 → week 50 · Actor withheld (GDPR pending)',
    );
    // OQ#8: the caller's own comment reads "You"; anyone else's name is withheld
    expect(comments[0]).toHaveTextContent('You');
    expect(comments[1]).toHaveTextContent('Withheld (GDPR pending)');
  });

  it('edit lock: only an editable comment offers Edit; a server EDIT_LOCKED is explained', async () => {
    const user = userEvent.setup();
    api.editComment.mockRejectedValue(new ApiError(403, 'locked', 'locked', 'EDIT_LOCKED'));
    renderPage();
    const [fresh, old] = await screen.findAllByTestId('activity-comment');
    expect(within(old!).queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
    await user.click(within(fresh!).getByRole('button', { name: 'Edit comment' }));
    await user.type(within(fresh!).getByLabelText('Edit comment'), ' — updated');
    await user.click(within(fresh!).getByRole('button', { name: 'Save' }));
    expect(await within(fresh!).findByRole('alert')).toHaveTextContent('15-minute edit window has closed');
  });

  it('@mention autocomplete inserts a candidate; an empty search degrades to plain text', async () => {
    const user = userEvent.setup();
    api.searchMentions.mockImplementation(async (q: string) => (q.startsWith('ni') ? [{ user_id: 'u9', display: 'Nikos Papas' }] : []));
    api.createComment.mockResolvedValue({});
    renderPage();
    const box = await screen.findByRole('combobox', { name: 'New comment' });
    await user.type(box, 'Ping @ni');
    const option = await screen.findByRole('option', { name: 'Nikos Papas' });
    await user.click(option);
    expect(box).toHaveValue('Ping @Nikos Papas ');
    await user.type(box, 'and @zz', { skipClick: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(api.createComment).toHaveBeenCalledWith('p-1', 'Ping @Nikos Papas and @zz');
  });

  it('only the author (or an Admin) can delete', async () => {
    renderPage({ session: { user_id: 'user-other', roles: ['Hub Planner'], permissions: ROLE_MATRIX['Hub Planner'] } });
    const [mine, theirs] = await screen.findAllByTestId('activity-comment');
    expect(within(mine!).queryByRole('button', { name: 'Delete comment' })).not.toBeInTheDocument();
    expect(within(theirs!).getByRole('button', { name: 'Delete comment' })).toBeInTheDocument();
  });
});

describe('Read-only role (Engineer: project_workspace read only)', () => {
  it('shows data and a read-only notice, and no write control anywhere', async () => {
    renderPage({ session: { roles: ['Engineer'], permissions: ROLE_MATRIX.Engineer } });
    expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recalculate schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit scores|Score this project/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-upload')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'New comment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /^Status — / })).not.toBeInTheDocument();
    expect(screen.getByTestId('stage-readonly-PDD-B')).toHaveTextContent('50%');
    expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
  });

  it('a Hub Planner can edit progress and details but not scores (Matrix is read-only for the role)', async () => {
    renderPage({ session: { roles: ['Hub Planner'], permissions: ROLE_MATRIX['Hub Planner'] } });
    expect(await screen.findByRole('button', { name: 'Edit details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit scores/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('combobox', { name: /^Status — / }).length).toBeGreaterThan(0);
  });
});

describe('OQ#8 and financial visibility', () => {
  it('a non-null leader name is the caller and is labelled as such', async () => {
    api.fetchWorkspace.mockResolvedValue(workspaceFixture({ project: { ...workspaceFixture().project, leader_engineer_name: 'Sam Super' } }));
    renderPage();
    expect(await screen.findByTestId('workspace-header')).toHaveTextContent('Leader: Sam Super (you)');
  });

  it('a role without Project Registration read sees "Restricted" financials, not "—"', async () => {
    api.fetchWorkspace.mockResolvedValue(
      workspaceFixture({
        project: { ...workspaceFixture().project, customer_name: null, tcogs_eur: null, selling_price_eur: null, gross_margin_pct: null },
      }),
    );
    renderPage({ session: { roles: ['Executive Viewer'], permissions: ROLE_MATRIX['Executive Viewer'] } });
    const details = await screen.findByTestId('details-read');
    expect(within(details).getAllByText('Restricted')).toHaveLength(4);
    expect(details).toHaveTextContent('45'); // CAPEX is not withheld
  });
});

describe('Details panel', () => {
  it('shows P9 fields and scoring anchors; edit opens the shared registration form inline', async () => {
    const user = userEvent.setup();
    renderPage();
    const details = await screen.findByTestId('details-read');
    expect(details).toHaveTextContent('W48');
    expect(details).toHaveTextContent('Required');
    expect(screen.getByTestId('scoring-section')).toHaveTextContent('1 = > €500K · 5 = < €10K');
    // Scoped to the Details card: whole-document role/label queries over the full
    // workspace cost ~0.5 s each in jsdom (see the Files-panel note).
    const panel = within(screen.getByTestId('details-panel'));
    await user.click(panel.getByRole('button', { name: 'Edit details' }));
    const form = within(panel.getByRole('form', { name: 'Edit Cooler Alpha' }));
    expect(form.getByLabelText(/^Expected completion \(week\)/)).toHaveValue(48);
  });
});

describe('P9-R03 remediation', () => {
  it('the Blocked health badge uses the warning tone with a pause icon (ruling 5)', async () => {
    api.fetchWorkspace.mockResolvedValue(workspaceFixture({ health: 'blocked' }));
    renderPage();
    const badge = await screen.findByTestId('health-badge');
    expect(badge).toHaveAccessibleName(/^Health: Blocked\./);
    expect(badge.querySelector('svg.lucide-circle-pause')).not.toBeNull();
  });

  it('a null progress_pct reads "No progress recorded", never 0%, and draws no bar', async () => {
    api.fetchWorkspace.mockResolvedValue(workspaceFixture({ progress_pct: null }));
    renderPage();
    expect(await screen.findByTestId('progress-pct')).toHaveTextContent('No progress recorded');
    expect(screen.queryByRole('progressbar', { name: /Project progress/ })).not.toBeInTheDocument();
  });

  it('null derived scores show "—" and "No band" instead of crashing', async () => {
    const base = workspaceFixture();
    const score = base.priority_score;
    if (!score) throw new Error('fixture has a score');
    api.fetchWorkspace.mockResolvedValue(
      workspaceFixture({ priority_score: { ...score, weighted_score: null, normalized_pct: null, suggested_band: null } }),
    );
    renderPage();
    const section = within(await screen.findByTestId('scoring-section'));
    expect(section.getByTestId('score-weighted')).toHaveTextContent('—');
    expect(section.getByTestId('score-normalized')).toHaveTextContent('—');
    expect(section.getByTestId('score-band-none')).toHaveTextContent('No band');
  });

  it('a frozen project shows stored progress read-only with the ruling-3 message', async () => {
    const base = workspaceFixture();
    api.fetchWorkspace.mockResolvedValue(workspaceFixture({ project: { ...base.project, frozen: true } }));
    renderPage();
    expect(await screen.findByTestId('progress-frozen-notice')).toHaveTextContent(
      'Unfreeze on the Gantt to record stage progress',
    );
    expect(screen.getByTestId('progress-pct')).toHaveTextContent('37%');
    const row = within(screen.getByTestId('stage-PDD-B'));
    expect(row.queryByRole('button', { name: /Save progress/ })).not.toBeInTheDocument();
    expect(row.queryByLabelText(/^Percent complete — /)).not.toBeInTheDocument();
  });

  it('a 409 PROJECT_FROZEN on save shows the message and refetches, locking the panel', async () => {
    const user = userEvent.setup();
    api.patchStage.mockRejectedValue(new ApiError(409, 'frozen', 'Project is frozen', 'PROJECT_FROZEN'));
    renderPage();
    const row = within(await screen.findByTestId('stage-PDD-B'));
    const pct = row.getByLabelText(/^Percent complete — /);
    await user.clear(pct);
    await user.type(pct, '60');
    const base = workspaceFixture();
    api.fetchWorkspace.mockResolvedValue(workspaceFixture({ project: { ...base.project, frozen: true } }));
    await user.click(row.getByRole('button', { name: /Save progress/ }));
    expect(await screen.findByTestId('progress-frozen-notice')).toBeInTheDocument();
    expect(api.fetchWorkspace).toHaveBeenCalledTimes(2);
  });
});

describe('P9-R03 comments: length cap and rate limit', () => {
  it('counts characters against the 10,000 cap and blocks an over-long body', async () => {
    renderPage();
    const box = await screen.findByRole('combobox', { name: 'New comment' });
    expect(box).toHaveAttribute('maxLength', '10000');
    expect(screen.getByTestId('comment-counter')).toHaveTextContent('0 / 10,000 characters');
    // fireEvent bypasses maxLength, standing in for a paste that the browser did not clip.
    fireEvent.change(box, { target: { value: 'x'.repeat(10_001) } });
    expect(screen.getByTestId('comment-counter')).toHaveTextContent('10,001 / 10,000 characters');
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it('a 429 RATE_LIMITED shows "Try again in N s" from Retry-After and keeps the draft', async () => {
    const user = userEvent.setup();
    api.createComment.mockRejectedValue(new ApiError(429, 'slow down', 'Too many comments', 'RATE_LIMITED', 42));
    renderPage();
    const box = await screen.findByRole('combobox', { name: 'New comment' });
    fireEvent.change(box, { target: { value: 'Supplier update' } });
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("You're commenting too fast. Try again in 42 s.");
    expect(box).toHaveValue('Supplier update');
  });

  it('a 422 on the body (server length check) explains the 10,000-character limit', async () => {
    const user = userEvent.setup();
    api.createComment.mockRejectedValue(
      new ApiError(422, 'bad', JSON.stringify([{ loc: ['body', 'body_md'], msg: 'String should have at most 10000 characters', type: 'string_too_long' }])),
    );
    renderPage();
    const box = await screen.findByRole('combobox', { name: 'New comment' });
    fireEvent.change(box, { target: { value: 'hello' } });
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Comments are limited to 10,000 characters.');
  });
});

describe('P9-R03 axe (unit-level)', () => {
  // qa Q-F2: `<dl data-testid="details-read">` held a `div > span` sub-heading.
  it('the Details panel read view has no serious/critical axe violations', async () => {
    renderPage();
    const details = await screen.findByTestId('details-read');
    for (const dl of details.querySelectorAll('dl')) {
      for (const child of dl.children) {
        const kids = [...child.children].map((c) => c.tagName);
        expect(child.tagName === 'DIV' ? kids : [child.tagName]).toEqual(child.tagName === 'DIV' ? ['DT', 'DD'] : [expect.stringMatching(/^D[TD]$/)]);
      }
    }
    expect(await seriousAxeViolations(screen.getByTestId('details-panel'))).toEqual([]);
  });
});
