import { test, expect } from './fixtures';
import { actAs, apiGet, BACKEND_URL, checkAxe, DEV_EMAILS } from './dev-session';

/**
 * P9-R04 (qa-inspector) — live checks for the P9 remediation flows
 * (DOMAIN_RULES "Gate remediation rulings" 3 and 5, security S-02):
 * - a frozen project's Progress panel is read-only, and the stage PATCH 409s;
 * - a project frozen after page load locks its panel on the 409;
 * - a Blocked stage gives the Blocked health badge after a recalculation;
 * - the comment counter, and the 429 message when the per-user limit trips;
 * - a greedy run stores `solver_status = null`.
 *
 * Mutating: run against a freshly seeded DB with an active greedy run.
 * Uses projects from the END of the list so it does not collide with the
 * project `p9-workspace.spec.ts` picks from the front.
 */

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  frozen: boolean;
}
interface Stage {
  step_id: string;
  name: string;
  status: string;
  skipped: boolean;
  percent_complete: number;
}
interface Workspace {
  project: { id: string; name: string; frozen: boolean };
  health: string;
  schedule: { run_version: number | null };
  stages: Stage[];
}
interface RunSummary {
  version: number;
  solver_type: string;
  solver_status: string | null;
}

const SCHEDULABLE = new Set(['In Queue', 'In Development', 'Under Industrialization', 'In Buyoff']);
const headers = (email: string) => ({ 'X-Dev-User-Email': email, 'Content-Type': 'application/json' });

let frozenId = '';
let frozenName = '';
const candidates: { id: string; name: string; stage: Stage }[] = [];

test.beforeAll(async ({ request }) => {
  const projects = await apiGet<ProjectRow[]>(request, 'hubPlanner', '/projects?limit=200');
  const frozen = projects.find((p) => p.frozen);
  expect(frozen, 'the seed has a frozen project').toBeTruthy();
  frozenId = frozen?.id ?? '';
  frozenName = frozen?.name ?? '';
  for (const p of [...projects].reverse().filter((x) => SCHEDULABLE.has(x.status) && !x.frozen)) {
    const ws = await apiGet<Workspace>(request, 'hubPlanner', `/projects/${p.id}/workspace`);
    const first = ws.stages.find((s) => !s.skipped);
    if (first && first.status === 'Not Started' && ws.schedule.run_version !== null) {
      candidates.push({ id: p.id, name: ws.project.name, stage: first });
      if (candidates.length === 3) break;
    }
  }
  expect(candidates.length, 'three schedulable, unfrozen, not-started projects').toBe(3);
});

test.describe('P9-R04 remediation flows', () => {
  test('frozen project: Progress panel read-only, stage PATCH 409 PROJECT_FROZEN; axe clean', async ({
    page,
    request,
  }) => {
    const res = await request.patch(`${BACKEND_URL}/projects/${frozenId}/stages/PDD-A`, {
      headers: headers(DEV_EMAILS.hubPlanner),
      data: { percent_complete: 10 },
    });
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('PROJECT_FROZEN');

    await actAs(page, 'hubPlanner');
    await page.goto(`/projects/${frozenId}`);
    await expect(page.getByRole('heading', { level: 1, name: frozenName })).toBeVisible();
    const notice = page.getByTestId('progress-frozen-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Unfreeze on the Gantt to record stage progress');
    await expect(page.getByRole('button', { name: /^Save progress/ })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /^Status — / })).toHaveCount(0);
    await expect(page.getByTestId('progress-pct')).toBeVisible();
    await checkAxe(page, 'Workspace: frozen project, read-only Progress panel');
  });

  test('project frozen after page load: Save gets 409 and the panel locks', async ({ page, request }) => {
    const { id, name, stage } = candidates[0];
    await actAs(page, 'hubPlanner');
    await page.goto(`/projects/${id}`);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    // Editable before the freeze (Save appears only once a row is edited).
    await expect(page.getByRole('combobox', { name: `Status — ${stage.name}` })).toBeVisible();

    const freeze = await request.post(`${BACKEND_URL}/gantt/projects/${id}/freeze`, {
      headers: headers(DEV_EMAILS.superAdmin),
      data: { frozen: true, actual_start_week: 31 },
    });
    expect(freeze.status()).toBe(200);
    try {
      await page.getByRole('combobox', { name: `Status — ${stage.name}` }).click();
      await page.getByRole('option', { name: 'In Progress' }).click();
      await page.getByLabel(`Actual start week — ${stage.name}`).fill('31');
      await page.getByLabel(`Percent complete — ${stage.name}`, { exact: true }).fill('20');
      const patch = page.waitForResponse(
        (r) => r.url().includes(`/projects/${id}/stages/`) && r.request().method() === 'PATCH',
      );
      await page.getByRole('button', { name: `Save progress — ${stage.name}` }).click();
      expect((await patch).status()).toBe(409);

      await expect(page.getByTestId('progress-frozen-notice')).toBeVisible();
      await expect(page.getByRole('button', { name: /^Save progress/ })).toHaveCount(0);
      const ws = await apiGet<Workspace>(request, 'hubPlanner', `/projects/${id}/workspace`);
      expect(ws.stages.find((s) => s.step_id === stage.step_id)?.status).toBe('Not Started');
      await checkAxe(page, 'Workspace: locked after 409 PROJECT_FROZEN');
    } finally {
      await request.post(`${BACKEND_URL}/gantt/projects/${id}/freeze`, {
        headers: headers(DEV_EMAILS.superAdmin),
        data: { frozen: false },
      });
    }
  });

  test('Blocked stage -> recalculation -> Blocked health badge; greedy solver_status null; axe clean', async ({
    page,
    request,
  }) => {
    const { id, name, stage } = candidates[1];
    const patch = await request.patch(`${BACKEND_URL}/projects/${id}/stages/${stage.step_id}`, {
      headers: headers(DEV_EMAILS.hubPlanner),
      data: { status: 'Blocked', actual_start_week: 31, percent_complete: 0, blocked_reason: 'QA P9-R04 block' },
    });
    expect(patch.status()).toBe(200);

    const recalc = await request.post(`${BACKEND_URL}/schedule-runs/greedy-recalc`, {
      headers: headers(DEV_EMAILS.admin),
    });
    expect(recalc.status()).toBe(201);
    const run = ((await recalc.json()) as { schedule_run: RunSummary }).schedule_run;
    expect(run.solver_type).toBe('greedy');
    expect(run.solver_status).toBeNull();
    const active = await apiGet<RunSummary>(request, 'superAdmin', '/schedule-runs/active');
    expect(active.version).toBe(run.version);
    expect(active.solver_status).toBeNull();

    const ws = await apiGet<Workspace>(request, 'hubPlanner', `/projects/${id}/workspace`);
    expect(ws.health).toBe('blocked');

    await actAs(page, 'hubPlanner');
    await page.goto(`/projects/${id}`);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    const badge = page.getByTestId('health-badge');
    await expect(badge).toHaveAttribute('data-health', 'blocked');
    await expect(badge).toContainText('Blocked');
    await checkAxe(page, 'Workspace: Blocked health badge');
  });

  test('comment counter, then the 429 message once the per-user limit trips', async ({ page, request }) => {
    const { id, name } = candidates[2];
    await actAs(page, 'portfolioManager');
    await page.goto(`/projects/${id}`);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

    const composer = page.getByRole('combobox', { name: 'New comment' });
    const counter = page.getByTestId('comment-counter');
    await expect(counter).toHaveText('0 / 10,000 characters');
    await composer.fill('hello');
    await expect(counter).toHaveText('5 / 10,000 characters');
    await expect(composer).toHaveAttribute('aria-describedby', (await counter.getAttribute('id')) ?? '');
    await composer.fill('x'.repeat(9_500));
    await expect(counter).toHaveText('9,500 / 10,000 characters');
    await expect(counter).toHaveAttribute('aria-live', 'polite');
    await checkAxe(page, 'Workspace: comment composer near the limit');

    // Exhaust the bucket (burst 10) as the same user, directly against the API.
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const r = await request.post(`${BACKEND_URL}/projects/${id}/comments`, {
        headers: headers(DEV_EMAILS.portfolioManager),
        data: { body_md: `QA P9-R04 burst ${String(i)}` },
      });
      if (r.status() === 429) {
        limited += 1;
        expect(r.headers()['retry-after']).toMatch(/^\d+$/);
      }
    }
    expect(limited).toBeGreaterThan(0);

    await composer.fill('One more, over the limit');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'commenting too fast' })).toHaveText(
      /^You're commenting too fast\. Try again in \d+ s\.$/,
    );
    // The draft is kept after the failed submit.
    await expect(composer).toHaveValue('One more, over the limit');
    await checkAxe(page, 'Workspace: 429 rate-limit message');
  });
});
