import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { actAs, apiGet, BACKEND_URL, checkAxe, DEV_EMAILS, type DevRole } from './dev-session';

/**
 * P33-T20 gate (qa-inspector): category template editing, apply, "+ Add
 * category", read-only per-project timing (ADR 0045-0048,
 * docs/API_CONTRACT_P33.md), end-to-end against a disposable real backend at
 * alembic head. Axe (serious/critical) on every P33 surface:
 *   - Workflow Settings timeline editor (saved, with drafts + flags)
 *   - the apply dialog (lists collapsed / expanded, "Apply to all")
 *   - the add-category dialog (empty, error state)
 *   - read-only Timeline (/timeline) (the Workflow "Project step timing" tab was
 *     removed at the owner's request, 2026-11-16)
 *
 * Mutates the disposable gate DB only.
 */

test.describe.configure({ mode: 'default' });

const TEMPLATES = '/settings/workflow?tab=templates';

interface LeadTime { workflow_id: string; category: string; step_id: string; weeks: number; gap_weeks: number }
interface Settings { lead_times: LeadTime[]; categories: { code: string; rank: number; template_version: number }[] }
interface Cat { code: string; rank: number; workflow_id: string }
interface GStep { step_id: string; step_name?: string; skipped: boolean; gap_weeks: number; plan_weeks: number; own_effort: boolean }
interface GRow { project_id: string; project_name: string; external_code: string | null; category: string; frozen: boolean; steps: GStep[] }

async function api(request: APIRequestContext, role: DevRole, method: string, path: string, data?: unknown) {
  return request.fetch(`${BACKEND_URL}${path}`, {
    method,
    headers: { 'X-Dev-User-Email': DEV_EMAILS[role], 'Content-Type': 'application/json' },
    data: data === undefined ? undefined : JSON.stringify(data),
  });
}

async function setup(page: Page, role: DevRole, width = 1440): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width, height: 900 });
  await actAs(page, role);
}

async function openTimelines(page: Page): Promise<void> {
  await page.goto(TEMPLATES);
  await expect(page.getByRole('heading', { name: 'Workflow Settings', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Timeline previews' }).click();
  await expect(page.getByRole('tab', { name: 'Timeline previews' })).toHaveAttribute('aria-selected', 'true');
}

async function openCard(page: Page, code: string): Promise<Locator> {
  const card = page.getByTestId(`timeline-${code}`);
  await expect(card).toBeVisible();
  const toggle = card.locator('button[aria-expanded]').first();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return card;
}

async function settled(card: Locator): Promise<void> {
  await expect(card.locator('[data-pending="true"]')).toHaveCount(0, { timeout: 20_000 });
}

test('timeline editor: Length / Move redraw from the server, flags, axe (Super Admin)', async ({ page }) => {
  await setup(page, 'superAdmin');
  const previews: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/workflow-templates/timeline-preview')) previews.push(r.postData() ?? ''); });
  await openTimelines(page);
  const card = await openCard(page, 'A+');
  await checkAxe(page, 'P33 timeline editor: saved A+');

  const before = await card.getByTestId('length-PDD-E').innerText();
  await card.getByRole('button', { name: 'Lengthen PDD-E by one week' }).click();
  await settled(card);
  expect(Number.parseInt(await card.getByTestId('length-PDD-E').innerText(), 10)).toBe(Number.parseInt(before, 10) + 1);
  // Two Move-earlier clicks -> a -2 overlap of design on design -> same-leader flag from the server.
  await card.getByRole('button', { name: 'Move PDD-E one week earlier' }).click();
  await card.getByRole('button', { name: 'Move PDD-E one week earlier' }).click();
  await settled(card);
  await expect(card.getByTestId('step-PDD-E').getByTestId('gap-badge')).toContainText('2w');
  await expect(card.getByTestId('flag-PDD-E-same_leader_serialised')).toBeVisible();
  await expect(card.getByTestId('unsaved-A+')).toContainText('1 unsaved step');
  expect(previews.length, 'preview requests sent').toBeGreaterThan(0);
  // first step has no Move control
  await expect(card.getByRole('button', { name: 'Move PDD-A one week earlier' })).toHaveCount(0);
  await checkAxe(page, 'P33 timeline editor: A+ with drafts + same-leader flag');

  // keyboard operation: focus Lengthen and press Enter
  await card.getByRole('button', { name: 'Lengthen PDD-F by one week' }).focus();
  await page.keyboard.press('Enter');
  await expect(card.getByTestId('unsaved-A+')).toContainText('2 unsaved steps');
  await card.getByRole('button', { name: 'Discard' }).click();
  await expect(card.getByTestId('unsaved-A+')).toHaveCount(0);
  await expect(card.getByTestId('length-PDD-E')).toHaveText(before);
});

test('apply: C PDD-K wait +3 through the dialog to all not-reached, run follows, Gantt shows the wait (Super Admin)', async ({ page, request }) => {
  await setup(page, 'superAdmin');
  const s0 = await apiGet<Settings>(request, 'superAdmin', '/workflow-settings');
  const k0 = s0.lead_times.find((l) => l.category === 'C' && /PDD-K$/.test(l.step_id));
  expect(k0, 'C PDD-K template row').toBeTruthy();
  const v0 = s0.categories.find((c) => c.code === 'C')!.template_version;

  await openTimelines(page);
  const card = await openCard(page, 'C');
  for (let i = 0; i < 3; i++) await card.getByRole('button', { name: 'Move PDD-K one week later' }).click();
  await settled(card);
  await expect(card.getByTestId('wait-PDD-K')).toBeVisible();
  await checkAxe(page, 'P33 timeline editor: C with a 3-week wait');
  await card.getByRole('button', { name: /^Save C/ }).click();

  const dialog = page.getByTestId('template-apply-dialog');
  await expect(dialog.getByTestId('apply-counts')).toBeVisible();
  await checkAxe(page, 'P33 apply dialog: initial (sections collapsed)');
  for (const id of ['apply-automatic', 'apply-own-effort', 'apply-never']) {
    const show = dialog.getByTestId(id).getByRole('button', { name: /^Show \d+ projects?$/ });
    if ((await show.count()) > 0) await show.first().click();
  }
  const choose = dialog.getByTestId('apply-choosable');
  if ((await choose.count()) > 0) {
    await expect(choose.getByRole('radio', { name: /Choose projects/ })).toBeChecked();
    await checkAxe(page, 'P33 apply dialog: lists expanded, Choose projects');
    await choose.getByRole('radio', { name: /Apply to all/ }).check();
  }
  await checkAxe(page, 'P33 apply dialog: Apply to all');
  await dialog.getByTestId('apply-confirm').click();

  const panel = page.getByTestId('template-apply-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText(/Template saved/);
  await checkAxe(page, 'P33 apply result panel');
  await expect(panel).toContainText(/Timeline recalculated|recalculat/i, { timeout: 120_000 });

  const s1 = await apiGet<Settings>(request, 'superAdmin', '/workflow-settings');
  const k1 = s1.lead_times.find((l) => l.category === 'C' && /PDD-K$/.test(l.step_id))!;
  expect(k1.gap_weeks).toBe(k0!.gap_weeks + 3);
  expect(k1.weeks).toBe(k0!.weeks);
  expect(s1.categories.find((c) => c.code === 'C')!.template_version).toBe(v0 + 1);

  // A C project whose K is live now carries the wait; the Timeline shows it read-only.
  const g = await apiGet<{ rows: GRow[] }>(request, 'superAdmin', '/gantt?limit=500');
  const target = g.rows.find((r) => r.category === 'C' && !r.frozen
    && r.steps.some((s) => /PDD-K$/.test(s.step_id) && !s.skipped && s.gap_weeks === k1.gap_weeks));
  expect(target, 'a C project with a live K and gap 3').toBeTruthy();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/timeline');
    await expect(page.getByRole('heading', { name: 'Project Execution Timeline', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByPlaceholder('Project name or code').fill(target!.external_code ?? target!.project_name.slice(0, 30));
    await page.waitForTimeout(800);
    // keyboard path (as the P19 gate): at 390 the floating filter panel covers the rows for a pointer
    const expandBtn = page.getByRole('button', { name: `Expand steps for ${target!.project_name}` }).first();
    await expandBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('gantt-step-row').first()).toBeVisible();
    await page.waitForTimeout(500);
    if (width === 1440) await expect(page.getByTestId('step-gap-chip').filter({ hasText: `wait ${String(k1.gap_weeks)} wk` }).first()).toBeAttached();
    expect(await page.getByTestId('step-drag-handle').count(), `no drag handle at ${String(width)}`).toBe(0);
    expect(await page.getByRole('button', { name: /^Edit timing for / }).count(), `no Edit timing at ${String(width)}`).toBe(0);
    await checkAxe(page, `P33 Timeline read-only, wait chip, ${String(width)}`);
  }
});

test('+ Add category: errors per field, B2 after B copies B, timeline opens, B1 serves rank 4 (Super Admin)', async ({ page, request }) => {
  await setup(page, 'superAdmin');
  await openTimelines(page);
  await page.getByRole('button', { name: 'Add category' }).first().click();
  const dialog = page.getByTestId('add-category-dialog');
  await expect(dialog).toBeVisible();
  await checkAxe(page, 'P33 add-category dialog: empty');

  // Duplicate code -> CATEGORY_EXISTS under Code
  await dialog.getByLabel('Code').fill('b');
  await dialog.getByLabel('Copy the template from').selectOption('B');
  await dialog.getByTestId('add-category-position').selectOption('B');
  await dialog.getByRole('button', { name: 'Add category' }).click();
  await expect(dialog.getByLabel('Code')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByRole('alert').first()).toBeVisible();
  await checkAxe(page, 'P33 add-category dialog: CATEGORY_EXISTS error');

  await dialog.getByLabel('Code').fill('B2');
  await dialog.getByLabel('Name (optional)').fill('Light refresh');
  await dialog.getByRole('button', { name: 'Add category' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  const card = page.getByTestId('timeline-B2');
  await expect(card).toBeVisible();
  await expect(card.locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'true');
  await checkAxe(page, 'P33 timeline editor: new B2 open');

  const cats = await apiGet<Cat[]>(request, 'superAdmin', '/reference/categories');
  const codes = [...cats].sort((a, b) => a.rank - b.rank).map((c) => c.code);
  expect(codes.indexOf('B2')).toBe(codes.indexOf('B') + 1);
  const s = await apiGet<Settings>(request, 'superAdmin', '/workflow-settings');
  const rowsB = s.lead_times.filter((l) => l.category === 'B').map((l) => `${l.step_id}:${String(l.weeks)}:${String(l.gap_weeks)}`).sort();
  const rowsB2 = s.lead_times.filter((l) => l.category === 'B2').map((l) => `${l.step_id}:${String(l.weeks)}:${String(l.gap_weeks)}`).sort();
  expect(rowsB2).toEqual(rowsB);
});

test('RBAC: Admin edits templates; Executive Viewer / PM have no editor; server enforces; retired endpoints 410', async ({ page, request }) => {
  await setup(page, 'admin');
  await openTimelines(page);
  await expect(page.getByRole('button', { name: 'Lengthen PDD-E by one week' }).first()).toBeVisible();
  await checkAxe(page, 'P33 timeline editor: Admin');

  for (const role of ['executiveViewer', 'portfolioManager'] as const) {
    const p2 = await page.context().newPage();
    await setup(p2, role);
    await p2.goto(TEMPLATES);
    await p2.waitForTimeout(1500);
    expect(await p2.getByRole('button', { name: /^Lengthen / }).count(), `${role} has no Lengthen`).toBe(0);
    expect(await p2.getByRole('button', { name: 'Add category' }).count(), `${role} has no Add category`).toBe(0);
    await p2.close();
  }

  const s = await apiGet<Settings>(request, 'superAdmin', '/workflow-settings');
  const v = s.categories.find((c) => c.code === 'A')!.template_version;
  const change = { changes: [{ workflow_id: 'PDD', category: 'A', base_version: v, steps: [{ step_id: 'PDD-E', weeks: 9 }] }], selection: { mode: 'none' } };
  for (const role of ['portfolioManager', 'hubPlanner', 'engineer', 'executiveViewer', 'auditor'] as const) {
    expect((await api(request, role, 'POST', '/workflow-templates/apply', change)).status(), `${role} apply`).toBe(403);
    expect((await api(request, role, 'POST', '/workflow-templates/categories', { code: 'ZZ', workflow_id: 'PDD', copy_from: 'B', insert_after: 'B' })).status(), `${role} add`).toBe(403);
  }
  const anyProject = (await apiGet<{ rows: GRow[] }>(request, 'superAdmin', '/gantt?limit=50')).rows.find((r) => r.steps.length > 0)!;
  expect((await api(request, 'admin', 'PATCH', `/projects/${anyProject.project_id}/steps/${anyProject.steps[0]!.step_id}/timing`, { duration_override_weeks: 3 })).status()).toBe(410);
  expect((await api(request, 'superAdmin', 'PUT', '/workflow-settings/lead-times', { lead_times: [] })).status()).toBe(410);
  // Anonymous 401 is covered by backend tests outside dev mode; this stack runs RPD_DEV_MODE (no header = seeded Admin).
});
