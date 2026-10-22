import { test, expect } from './fixtures';
import { actAs, apiGet, checkAxe } from './dev-session';
import type { Page } from '@playwright/test';

/** P17 gate (qa-inspector): Dashboard pipeline row (spillover + new + unregistered = total) and five status cards, live. */
const SHOT = process.env.RPD_P17_SHOTS ?? '.';

interface Totals { spillover_count: number; new_count: number; unregistered_count: number; total_count: number; spillover_share_pct: number; new_share_pct: number; unregistered_share_pct: number }
interface Status { in_development: number; under_industrialization: number; in_queue: number; commercialized_count: number; on_hold_count: number; other_statuses_count: number; total_count: number; in_development_share_pct: number; under_industrialization_share_pct: number; in_queue_share_pct: number; commercialized_share_pct: number; on_hold_share_pct: number; other_statuses_share_pct: number }

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Global RPD Dashboard' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('pipeline-count-total')).toBeVisible();
  await expect(page.getByTestId('status-count-in-development')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
}

const num = (s: string): number => Number(s.replace(/[^\d.]/g, ''));

async function readAndCompare(page: Page, request: Parameters<typeof apiGet>[0], q: string, label: string): Promise<void> {
  const t = await apiGet<Totals>(request, 'admin', `/dashboard/pipeline-totals${q}`);
  const s = await apiGet<Status>(request, 'admin', `/dashboard/status-overview${q}`);
  const ui = async (id: string): Promise<number> => num(await page.getByTestId(id).innerText());
  const cap = async (id: string): Promise<string> => page.getByTestId(id).innerText();
  // 2026-10-22 (owner ask): the "Unregistered" card is gone; the served count stays inside the total and the
  // Total caption names it when > 0. So the row shows Spillover + New = Total whenever unregistered is 0.
  const p = { sp: await ui('pipeline-count-spillover'), nw: await ui('pipeline-count-new'), tot: await ui('pipeline-count-total') };
  console.log(label, 'pipeline UI', JSON.stringify(p), 'API', t.spillover_count, t.new_count, t.unregistered_count, t.total_count);
  await expect(page.getByTestId('pipeline-count-unregistered')).toHaveCount(0);
  expect([p.sp, p.nw, p.tot]).toEqual([t.spillover_count, t.new_count, t.total_count]);
  expect(p.sp + p.nw + t.unregistered_count).toBe(p.tot);
  if (t.unregistered_count > 0) expect(await cap('pipeline-caption-total')).toContain(String(t.unregistered_count));
  expect(num(await cap('pipeline-caption-new'))).toBe(t.new_share_pct);
  expect(num(await cap('pipeline-caption-spillover'))).toBe(t.spillover_share_pct);
  const ids = ['in-development', 'under-industrialization', 'in-queue', 'commercialized', 'on-hold'];
  const api = [s.in_development, s.under_industrialization, s.in_queue, s.commercialized_count, s.on_hold_count];
  const pct = [s.in_development_share_pct, s.under_industrialization_share_pct, s.in_queue_share_pct, s.commercialized_share_pct, s.on_hold_share_pct];
  const cards: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const c = await ui(`status-count-${ids[i]}`);
    cards.push(c);
    expect(c, `${label} ${ids[i]}`).toBe(api[i]);
    expect(num(await cap(`status-caption-${ids[i]}`)), `${label} ${ids[i]} pct`).toBe(pct[i]);
  }
  const other = num((await cap('status-other')).split(':')[1]?.split('(')[0] ?? 'NaN');
  console.log(label, 'cards UI', JSON.stringify(cards), 'other', other, 'API other', s.other_statuses_count, 'total', s.total_count);
  expect(other).toBe(s.other_statuses_count);
  expect(cards.reduce((a, b) => a + b, 0) + other).toBe(p.tot);
  expect(s.total_count).toBe(t.total_count);
}

test('Dashboard live numbers reconcile, unfiltered and under country filters', async ({ page, request }) => {
  await actAs(page, 'admin');
  await page.goto('/');
  await settle(page);
  await readAndCompare(page, request, '', 'all');
  for (const c of ['India', 'Romania', 'Greece']) {
    await page.getByTestId('country-segmented').getByRole('radio', { name: c }).click();
    await page.waitForTimeout(1200);
    await page.waitForLoadState('networkidle');
    await readAndCompare(page, request, `?region=${c}`, c);
  }
  await page.getByTestId('country-segmented').getByRole('radio', { name: 'All' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await readAndCompare(page, request, '', 'all-again');
});

test('Region chips show served counts on pipeline and status cards', async ({ page, request }) => {
  await actAs(page, 'admin');
  await page.goto('/');
  await settle(page);
  const rs = await apiGet<{ regions: { region: string; newly_registered_count: number; newly_registered_share_pct: number; status_counts: Record<string, number>; status_share_pct: Record<string, number> }[] }>(request, 'admin', '/dashboard/region-summary');
  const txt = (await page.getByTestId('pipeline-card-new').innerText()).replace(/\s+/g, ' ');
  const st = (await page.getByTestId('status-card-on-hold').innerText()).replace(/\s+/g, ' ');
  console.log('new card', txt, '| on-hold card', st);
  for (const r of rs.regions) {
    expect(txt).toContain(String(r.newly_registered_count));
    expect(st).toContain(String(r.status_counts['On Hold'] ?? 0));
  }
});

test('Axe light + dark, screenshots 1440 and 390', async ({ page }) => {
  await actAs(page, 'admin');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await settle(page);
  await checkAxe(page, 'dashboard p17 light');
  await page.screenshot({ path: `${SHOT}/dash-1440-light.png`, fullPage: true });
  await page.getByTestId('pipeline-row').screenshot({ path: `${SHOT}/pipeline-1440.png` });
  await page.getByTestId('status-overview').screenshot({ path: `${SHOT}/status-1440.png` });
  await page.getByRole('radio', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.waitForTimeout(800);
  await checkAxe(page, 'dashboard p17 dark');
  await page.screenshot({ path: `${SHOT}/dash-1440-dark.png`, fullPage: true });
  await page.getByRole('radio', { name: 'Light theme' }).click();
  await page.waitForTimeout(500);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(800);
  await checkAxe(page, 'dashboard p17 light 390');
  await page.screenshot({ path: `${SHOT}/dash-390-light.png`, fullPage: true });
  await page.getByTestId('pipeline-row').screenshot({ path: `${SHOT}/pipeline-390.png` });
  await page.getByTestId('status-overview').screenshot({ path: `${SHOT}/status-390.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('horizontal overflow at 390:', overflow);
});
