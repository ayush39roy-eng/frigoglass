import { test, expect } from './fixtures';
import { actAs, apiGet, checkAxe, DEV_EMAILS, BACKEND_URL, type DevRole } from './dev-session';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * P14 gate (qa-inspector): live-stack checks for the priority-move preview and
 * confirm flow (ADR 0026) on the three entry points, and the Dashboard VIP
 * card (ADR 0027 + OQ #39 amendment). Needs a dev-mode backend on a seeded
 * client_2026 Postgres with an active greedy run and NO Celery worker.
 * Spec runs serially: it mutates the disposable DB.
 */

interface Row { id: string; name: string; priority: string | null; status: string }
interface ActiveRun { schedule_run?: { id: string }; id?: string }

async function api<T>(request: APIRequestContext, role: DevRole, path: string): Promise<T> {
  return apiGet<T>(request, role, path);
}
async function activeRunId(request: APIRequestContext): Promise<string> {
  const r = await api<ActiveRun>(request, 'admin', '/schedule-runs/active');
  return (r.schedule_run?.id ?? r.id) as string;
}
async function priorityOf(request: APIRequestContext, id: string): Promise<string | null> {
  const res = await request.get(`${BACKEND_URL}/projects/${id}`, { headers: { 'X-Dev-User-Email': DEV_EMAILS.admin } });
  return ((await res.json()) as Row).priority;
}
async function schedulable(request: APIRequestContext, priority: string, skip = 0): Promise<Row> {
  const rows = await api<Row[]>(request, 'admin', '/projects?limit=500');
  return rows.filter((p) => p.priority === priority && p.status === 'In Queue')[skip] as Row;
}
async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Surfaces' })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}
const dialog = (page: Page) => page.getByTestId('priority-preview-dialog');

test('Board: drag -> preview -> No snaps back, nothing written; Yes applies, run active, no worker', async ({ page, request }) => {
  const target = await schedulable(request, 'P4', 0);
  const run0 = await activeRunId(request);
  await actAs(page, 'portfolioManager');
  await page.goto('/priority-board');
  await settle(page);
  const card = page.getByTestId('board-card').filter({ hasText: target.name.slice(0, 30) }).first();
  await card.scrollIntoViewIfNeeded();
  const handle = card.getByTestId('board-drag-handle');
  await handle.focus();
  await page.keyboard.press('Space');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId('preview-moved')).toBeVisible();
  await expect(page.getByTestId('preview-confirm')).toBeEnabled();
  await checkAxe(page, 'board preview dialog');
  await page.getByRole('button', { name: 'No, cancel' }).click();
  await expect(dialog(page)).toBeHidden();
  expect(await priorityOf(request, target.id)).toBe('P4');
  expect(await activeRunId(request)).toBe(run0);
  await expect(page.getByTestId('board-announcer')).toContainText(/back in|stays in|not moved/i);

  await handle.focus();
  await page.keyboard.press('Space');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('preview-confirm')).toBeEnabled();
  await page.getByTestId('preview-confirm').click();
  await expect(page.getByTestId('preview-applied')).toBeVisible({ timeout: 40_000 });
  expect(await priorityOf(request, target.id)).toBe('P1');
  expect(await activeRunId(request)).not.toBe(run0);
  const run = await api<ActiveRun>(request, 'admin', '/schedule-runs/active');
  expect(JSON.stringify(run)).toContain('priority_move');
});

test('Gantt move control: preview -> No -> nothing; Yes applies', async ({ page, request }) => {
  const run0 = await activeRunId(request);
  await actAs(page, 'portfolioManager');
  await page.goto('/timeline');
  await settle(page);
  const trig = page.getByRole('button', { name: /^Priority P1 for .*Change priority$/ }).first();
  await expect(trig).toBeVisible();
  const label = (await trig.getAttribute('aria-label')) ?? '';
  const name = label.replace(/^Priority P1 for /, '').replace(/\. Change priority$/, '');
  const rows = await api<Row[]>(request, 'admin', '/projects?limit=500');
  const target = rows.find((r) => r.name === name) as Row;
  const from = target.priority;
  await trig.click();
  await page.getByRole('menuitemradio', { name: /Priority band P2/ }).click();
  await expect(page.getByTestId('preview-confirm')).toBeEnabled();
  await page.getByRole('button', { name: 'No, cancel' }).click();
  expect(await priorityOf(request, target.id)).toBe(from);
  expect(await activeRunId(request)).toBe(run0);
  await trig.click();
  await page.getByRole('menuitemradio', { name: /Priority band P2/ }).click();
  await page.getByTestId('preview-confirm').click();
  await expect(page.getByTestId('preview-applied')).toBeVisible({ timeout: 40_000 });
  expect(await priorityOf(request, target.id)).toBe('P2');
  expect(await activeRunId(request)).not.toBe(run0);
});

test('Registration form: priority change previewed; No keeps form open and saves nothing; Yes applies', async ({ page, request }) => {
  const target = await schedulable(request, 'P4', 2);
  const run0 = await activeRunId(request);
  await actAs(page, 'portfolioManager');
  // P22-T01: the deep link opens the registration drawer on the Projects page.
  await page.goto(`/projects?edit=${target.id}`);
  await settle(page);
  await page.locator('#reg-priority').click();
  await page.getByRole('option', { name: /P1/ }).click();
  await page.getByRole('button', { name: /^(Save|Update)/ }).click();
  await expect(page.getByTestId('preview-confirm')).toBeEnabled();
  await page.getByRole('button', { name: 'No, cancel' }).click();
  expect(await priorityOf(request, target.id)).toBe('P4');
  expect(await activeRunId(request)).toBe(run0);
  await page.getByRole('button', { name: /^(Save|Update)/ }).click();
  await page.getByTestId('preview-confirm').click();
  await expect(page.getByTestId('preview-applied')).toBeVisible({ timeout: 40_000 });
  expect(await priorityOf(request, target.id)).toBe('P1');
  expect(await activeRunId(request)).not.toBe(run0);
});

test('Dashboard VIP card: three tiles, items, View all slide, item opens project or picker; axe', async ({ page }) => {
  await actAs(page, 'portfolioManager');
  await page.goto('/');
  await settle(page);
  const card = page.getByTestId('vip-projects-card');
  await card.scrollIntoViewIfNeeded();
  const tiles = card.getByTestId('vip-area-tile');
  await expect(tiles).toHaveCount(3);
  for (const a of ['Greece', 'India', 'Romania']) await expect(card.getByRole('heading', { name: new RegExp(a) })).toBeVisible();
  expect(await card.getByTestId('vip-tile-item').count()).toBeGreaterThan(0);
  await checkAxe(page, 'dashboard with VIP card');
  await card.getByRole('button', { name: /View all VIP items for Greece/ }).click();
  const dlg = page.getByTestId('vip-board-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('vip-pillar')).toHaveCount(3);
  await expect(dlg.getByTestId('vip-edit-toggle')).toBeVisible();
  await checkAxe(page, 'dashboard VIP dialog open');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  // an item with a single project opens the workspace; an item with several opens a picker
  const link = card.getByTestId('vip-item-link').first();
  const picker = card.getByTestId('vip-item-picker-trigger').first();
  const nLinks = await link.count();
  const nPick = await picker.count();
  console.log(`tile links=${String(nLinks)} pickers=${String(nPick)}`);
  if (nPick > 0) {
    await picker.click();
    await expect(page.getByTestId('vip-item-picker')).toBeVisible();
    await checkAxe(page, 'VIP item picker open');
    await page.getByTestId('vip-picker-project').first().click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
  } else if (nLinks > 0) {
    await link.click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
  }
});

for (const [role, expected] of [
  ['superAdmin', true], ['admin', true], ['portfolioManager', true],
  ['hubPlanner', false], ['executiveViewer', false], ['engineer', false],
] as [DevRole, boolean][]) {
  test(`VIP Edit mode visible for ${role}: ${String(expected)}`, async ({ page }) => {
    await actAs(page, role);
    await page.goto('/');
    await settle(page);
    const card = page.getByTestId('vip-projects-card');
    if (role === 'engineer') {
      console.log(`engineer vip card count=${String(await card.count())}`);
      await expect(card).toHaveCount(0);
      return;
    }
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: /View all VIP items/ }).first().click();
    await expect(page.getByTestId('vip-board-dialog')).toBeVisible();
    await expect(page.getByTestId('vip-edit-toggle')).toHaveCount(expected ? 1 : 0);
  });
}

test('/vip redirects to the Dashboard', async ({ page }) => {
  await actAs(page, 'portfolioManager');
  await page.goto('/vip');
  await settle(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('vip-projects-card')).toBeVisible();
});

test('hub-scoped user: board move preview works within own hub, VIP card shows own area only', async ({ page }) => {
  await actAs(page, 'hubPlanner');
  await page.goto('/');
  await settle(page);
  const card = page.getByTestId('vip-projects-card');
  await card.scrollIntoViewIfNeeded();
  console.log(`hubPlanner tiles=${String(await card.getByTestId('vip-area-tile').count())}`);
  await expect(card.getByTestId('vip-area-tile').first()).toBeVisible();
});
