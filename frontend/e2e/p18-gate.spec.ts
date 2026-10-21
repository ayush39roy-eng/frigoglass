import { test, expect } from './fixtures';
import { actAs, apiGet, checkAxe } from './dev-session';
import type { Page } from '@playwright/test';

/**
 * P17-R + P18 gate (qa-inspector), live against a disposable stack: the Dashboard
 * "Delivery by priority" card vs `priority_delivery`, and the What-if tab vs /whatif/*.
 * Run with playwright.p18qa.config.ts (needs RPD_E2E_BACKEND_URL for the API).
 */
const SHOT = process.env.RPD_P18_SHOTS ?? '.';

interface Band {
  priority: string; total: number; within_year: number;
  in_flight_total: number; in_flight_within_year: number;
  not_started_total: number; not_started_within_year: number;
  delivered_total: number; other_total: number;
  in_flight_within_year_share_pct: number;
}
interface Cwy { priority_delivery: Band[] }

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Global RPD Dashboard' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Delivery by priority band')).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(900);
}

async function compareCard(page: Page, bands: Band[], label: string): Promise<void> {
  const shown = bands.filter((b) => b.total > 0);
  const items = page.getByLabel('Delivery by priority band').getByRole('listitem');
  await expect(items, label).toHaveCount(shown.length);
  for (let i = 0; i < shown.length; i++) {
    const b = shown[i]!;
    expect(b.in_flight_total + b.not_started_total + b.delivered_total + b.other_total, `${label} ${b.priority} API parts sum`).toBe(b.total);
    const item = items.nth(i);
    const aria = (await item.getAttribute('aria-label')) ?? '';
    expect(aria, `${label} ${b.priority}`).toBe(
      `${b.priority}: in flight ${b.in_flight_within_year} of ${b.in_flight_total}, not started ${b.not_started_within_year} of ${b.not_started_total}, ${b.total} projects`,
    );
    const txt = (await item.innerText()).replace(/\s+/g, ' ');
    expect(txt).toContain(`${b.total} projects`);
    expect(txt).toContain(b.in_flight_total > 0 ? `${String(Math.round(b.in_flight_within_year_share_pct))}%` : '–');
    if (b.delivered_total > 0) expect(txt).toContain(`Already delivered: ${b.delivered_total}`);
    else expect(txt).not.toContain('Already delivered');
    if (b.other_total > 0) expect(txt).toContain(`Not in plan: ${b.other_total}`);
    else expect(txt).not.toContain('Not in plan');
    console.log(label, b.priority, 'UI ok:', aria, '| delivered', b.delivered_total, 'other', b.other_total);
  }
}

test('Delivery by priority card equals priority_delivery, unfiltered / country / hub', async ({ page, request }) => {
  await actAs(page, 'admin');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await settle(page);
  let api = await apiGet<Cwy>(request, 'admin', '/dashboard/completing-within-year');
  await compareCard(page, api.priority_delivery, 'all');
  const allTotal = api.priority_delivery.reduce((a, b) => a + b.total, 0);
  const perCountry: Record<string, number> = {};
  for (const c of ['India', 'Romania', 'Greece']) {
    await page.getByTestId('country-segmented').getByRole('radio', { name: c }).click();
    await page.waitForTimeout(1200);
    await page.waitForLoadState('networkidle');
    api = await apiGet<Cwy>(request, 'admin', `/dashboard/completing-within-year?region=${c}`);
    await compareCard(page, api.priority_delivery, c);
    perCountry[c] = api.priority_delivery.reduce((a, b) => a + b.total, 0);
  }
  console.log('band totals: all', allTotal, 'per country', JSON.stringify(perCountry));
  expect(Object.values(perCountry).reduce((a, b) => a + b, 0)).toBe(allTotal);
  await page.getByTestId('country-segmented').getByRole('radio', { name: 'All' }).click();
  await page.waitForTimeout(1000);
  // hub filter
  const hubs = await apiGet<{ id: string; name: string }[]>(request, 'admin', '/hubs');
  await page.getByRole('combobox', { name: 'Hub filter' }).click();
  await page.getByRole('option', { name: 'PD-India' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);
  const hub = hubs.find((h) => h.name === 'PD-India')!;
  api = await apiGet<Cwy>(request, 'admin', `/dashboard/completing-within-year?hub_id=${hub.id}`);
  await compareCard(page, api.priority_delivery, 'PD-India');
  // header chip / pipeline total vs band total under the hub filter
  console.log('PD-India band total', api.priority_delivery.reduce((a, b) => a + b.total, 0));
});

test('Dashboard axe + screenshots (Delivery card)', async ({ page }) => {
  await actAs(page, 'admin');
  await page.addInitScript(() => window.localStorage.setItem('rpd-theme', 'light'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await settle(page);
  const card = page.locator('section', { has: page.getByLabel('Delivery by priority band') }).last();
  await checkAxe(page, 'dashboard light 1440');
  await page.getByLabel('Delivery by priority band').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT}/dash-full-1440.png`, fullPage: true });
  const box = page.locator('div,section,article').filter({ has: page.getByTestId('priority-delivery-note') }).last();
  await box.screenshot({ path: `${SHOT}/delivery-1440.png` });
  void card;
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(800);
  await checkAxe(page, 'dashboard light 390');
  await page.getByTestId('priority-delivery-note').scrollIntoViewIfNeeded();
  await box.screenshot({ path: `${SHOT}/delivery-390.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('dashboard horizontal overflow at 390:', overflow);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('radio', { name: 'Dark theme' }).click();
  await page.waitForTimeout(800);
  await checkAxe(page, 'dashboard DARK report-only');
});

interface Est {
  extra_design_weeks_total: number; extra_lab_weeks_total: number;
  min_extra_designers_total: number; min_extra_chambers_total: number;
  design: { hub: string; added_projects: number; booked_pct_after: number }[];
}

test('What-if tab live: estimate matches API, chat shows not-configured, axe + screenshots', async ({ page, request }) => {
  await actAs(page, 'portfolioManager');
  await page.addInitScript(() => window.localStorage.setItem('rpd-theme', 'light'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/planning');
  await page.getByRole('tab', { name: 'What-if planner' }).click();
  await expect(page.getByRole('heading', { name: 'Scenario builder' })).toBeVisible();
  await page.getByRole('button', { name: 'Add project line' }).click();
  const g = page.getByRole('group', { name: /Added projects, line 1/ });
  await g.getByLabel('Hub').selectOption('PD-Romania');
  await g.getByLabel('Count').fill('10');
  // category defaults are UI-owned; set A explicitly
  await g.getByLabel('Category').selectOption('A');
  const apiRes = await request.post(`${process.env.RPD_E2E_BACKEND_URL ?? 'http://localhost:8092'}/whatif/estimate`, {
    headers: { 'X-Dev-User-Email': 'alice.pm@example.com' },
    data: { scenario: { add_projects: [{ hub: 'PD-Romania', category: 'A', count: 10 }] }, basis: 'year' },
  });
  expect(apiRes.status()).toBe(200);
  const est = (await apiRes.json()) as Est;
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByTestId('whatif-estimate')).toBeVisible({ timeout: 15_000 });
  const designers = (await page.getByTestId('est-designers').innerText()).replace(/\s+/g, ' ');
  console.log('UI designers:', designers, '| API', est.min_extra_designers_total, 'chambers', est.min_extra_chambers_total);
  expect(designers).toContain(String(est.min_extra_designers_total));
  const row = (await page.getByTestId('est-design-row').filter({ hasText: 'PD-Romania' }).innerText()).replace(/\s+/g, ' ');
  console.log('UI design row:', row);
  expect(row).toContain(`${String(est.design.find((d) => d.added_projects > 0)!.booked_pct_after)} %`);
  expect(est.extra_design_weeks_total).toBe(180);
  expect(est.extra_lab_weeks_total).toBe(100);
  await page.getByText('How this was calculated').first().click();
  await checkAxe(page, 'whatif estimate light 1440');
  await page.screenshot({ path: `${SHOT}/whatif-1440.png`, fullPage: true });
  await page.getByTestId('whatif-planner').screenshot({ path: `${SHOT}/whatif-1440-el.png` });
  // simulate
  await page.getByRole('button', { name: 'Simulate' }).click();
  await expect(page.getByTestId('sim-within-year')).toBeVisible({ timeout: 60_000 });
  console.log('UI sim:', (await page.getByTestId('sim-within-year').innerText()).replace(/\s+/g, ' '));
  await checkAxe(page, 'whatif simulate light 1440');
  // chat: no key -> 503 -> not configured
  await page.getByLabel('Your question').fill('what if we add 10 PDD A projects in Romania?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByTestId('chat-unavailable')).toContainText('Chat is not configured; use the forms.', { timeout: 15_000 });
  await expect(page.getByLabel('Your question')).toHaveCount(0);
  await checkAxe(page, 'whatif chat-unavailable light');
  await page.getByTestId('whatif-planner').screenshot({ path: `${SHOT}/whatif-1440-chat503.png` });
  // 390 px
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(800);
  await checkAxe(page, 'whatif light 390');
  await page.screenshot({ path: `${SHOT}/whatif-390.png`, fullPage: true });
  await page.getByTestId('whatif-planner').screenshot({ path: `${SHOT}/whatif-390-el.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('what-if horizontal overflow at 390:', overflow);
  expect(overflow).toBeLessThanOrEqual(0);
  // dark: report only
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { window.localStorage.setItem('rpd-theme', 'dark'); });
  await page.reload();
  await page.getByRole('tab', { name: 'What-if planner' }).click();
  await page.getByRole('button', { name: 'Add project line' }).click();
  await page.getByRole('group', { name: /Added projects, line 1/ }).getByLabel('Hub').selectOption('PD-Romania');
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByTestId('whatif-estimate')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await checkAxe(page, 'whatif DARK report-only');
});
