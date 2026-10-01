import { readFileSync } from 'node:fs';

import { test, expect } from './fixtures';
import { actAs, apiGet, checkAxe } from './dev-session';

/**
 * P9-T05 (qa-inspector) — Project Workspace (`/projects/:id`, Surface #7)
 * end-to-end against the live stack: stage PATCH -> stale banner ->
 * Recalculate (greedy via Celery + SSE) -> new active run; file upload +
 * download round trip (MinIO); comment create + edit; axe.
 *
 * Mutating and order-dependent: run once against a freshly seeded DB.
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
}
interface Workspace {
  project: { id: string; name: string };
  schedule: { run_version: number | null; schedule_stale: boolean };
  stages: Stage[];
}
interface Gantt {
  schedule_run_version: number | null;
}

const SCHEDULABLE = new Set(['In Queue', 'In Development', 'Under Industrialization', 'In Buyoff']);


let projectId = '';
let projectName = '';
let stageName = '';

test.beforeAll(async ({ request }) => {
  const projects = await apiGet<ProjectRow[]>(request, 'hubPlanner', '/projects?limit=200');
  // P9-R04: skip frozen projects. Ruling 3 makes their Progress panel
  // read-only, and gantt.spec.ts freezes one earlier in the same run.
  for (const p of projects.filter((x) => SCHEDULABLE.has(x.status) && !x.frozen)) {
    const ws = await apiGet<Workspace>(request, 'hubPlanner', `/projects/${p.id}/workspace`);
    const first = ws.stages.find((s) => !s.skipped);
    if (first && first.status === 'Not Started' && ws.schedule.run_version !== null) {
      projectId = p.id;
      projectName = ws.project.name;
      stageName = first.name;
      break;
    }
  }
  expect(projectId, 'a schedulable project with a Not Started first stage').not.toBe('');
});

test.describe('Project Workspace (P9 / P8 absorbed)', () => {
  test('renders header, health, progress, files and activity; axe clean', async ({ page }) => {
    await actAs(page, 'hubPlanner');
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Workflow stages' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recalculate schedule' }).first()).toBeVisible();
    await checkAxe(page, 'Workspace: initial render');
  });

  test('stage PATCH -> stale banner -> Recalculate -> new active run', async ({
    page,
    request,
  }) => {
    const before = await apiGet<Gantt>(request, 'superAdmin', '/gantt');
    await actAs(page, 'hubPlanner');
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();

    await page.getByRole('combobox', { name: `Status — ${stageName}` }).click();
    await page.getByRole('option', { name: 'In Progress' }).click();
    await page.getByLabel(`Actual start week — ${stageName}`).fill('30');
    await page.getByLabel(`Percent complete — ${stageName}`, { exact: true }).fill('50');
    await page.getByRole('button', { name: `Save progress — ${stageName}` }).click();

    const banner = page.getByText('Progress updated. Schedule is now stale.');
    await expect(banner).toBeVisible();
    const afterPatch = await apiGet<Workspace>(request, 'hubPlanner', `/projects/${projectId}/workspace`);
    expect(afterPatch.schedule.schedule_stale).toBe(true);
    // A progress edit never triggers a solve (ADR 0006).
    expect((await apiGet<Gantt>(request, 'superAdmin', '/gantt')).schedule_run_version).toBe(
      before.schedule_run_version,
    );

    await checkAxe(page, 'Workspace: after stage PATCH (stale banner)');

    await page.getByRole('button', { name: 'Recalculate schedule' }).first().click();
    await expect(banner).toBeHidden({ timeout: 90_000 });

    const after = await apiGet<Gantt>(request, 'superAdmin', '/gantt');
    expect(after.schedule_run_version).toBe((before.schedule_run_version ?? 0) + 1);
    const ws = await apiGet<Workspace>(request, 'hubPlanner', `/projects/${projectId}/workspace`);
    expect(ws.schedule.schedule_stale).toBe(false);
    expect(ws.schedule.run_version).toBe(after.schedule_run_version);
    expect(ws.stages.find((s) => s.name === stageName)?.status).toBe('In Progress');
  });

  test('file upload and download round trip', async ({ page }) => {
    await actAs(page, 'hubPlanner');
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();

    const body = Buffer.from('%PDF-1.4\n% qa-inspector P9-T05 fixture\n1 0 obj<<>>endobj\n%%EOF\n');
    await page.getByLabel('File to upload').setInputFiles({
      name: 'qa-p9t05-report.pdf',
      mimeType: 'application/pdf',
      buffer: body,
    });
    await page.locator('#ws-file-name').fill('QA P9-T05 report');
    const category = page.locator('#ws-file-category');
    const firstCategory = await category.locator('option').nth(1).getAttribute('value');
    await category.selectOption(firstCategory ?? '');
    await page.getByRole('button', { name: 'Upload', exact: true }).click();

    const downloadBtn = page.getByRole('button', { name: 'Download QA P9-T05 report v1' });
    await expect(downloadBtn).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent('download'), downloadBtn.click()]);
    const path = await download.path();
    expect(readFileSync(path).equals(body)).toBe(true);

    await checkAxe(page, 'Workspace: after file upload');
  });

  test('comment create and edit', async ({ page }) => {
    await actAs(page, 'hubPlanner');
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();

    const text = `QA gate comment ${String(Date.now())} with **bold** and <b>raw html</b>`;
    await page.getByRole('combobox', { name: 'New comment' }).fill(text);
    await page.getByRole('button', { name: 'Comment', exact: true }).click();

    const feed = page.getByRole('list', { name: 'Activity feed, newest first' });
    await expect(feed.getByText('raw html', { exact: false }).first()).toBeVisible();
    // Raw HTML is shown as literal text, never parsed into an element.
    await expect(feed.locator('b', { hasText: 'raw html' })).toHaveCount(0);
    await expect(feed.locator('strong', { hasText: 'bold' }).first()).toBeVisible();

    await feed.getByRole('button', { name: 'Edit comment' }).first().click();
    const editor = page.getByRole('combobox', { name: 'Edit comment' });
    await editor.fill('Edited by the QA gate');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(feed.getByText('Edited by the QA gate')).toBeVisible();

    await checkAxe(page, 'Workspace: after comment edit');
  });
});
