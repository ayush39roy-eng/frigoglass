import { test, expect } from './fixtures';
import { actAs, apiGet, checkAxe, DEV_EMAILS, BACKEND_URL } from './dev-session';
import type { Page } from '@playwright/test';

/** P15 gate (qa-inspector): Capacity Engineers x Weeks heatmap, leader names, axe. Read-only against the stack. */

interface Cell { week: number; booked: number; capacity: number; utilization_pct: number }
interface Eng { id: string; name: string; hub: string; weeks: Cell[]; total_booked: number; utilization_pct: number }
interface Util { engineers: Eng[]; current_week: number }

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickEngineers(engineers: Eng[]): Eng[] {
  const byId = new Map<string, Eng>();
  const add = (e: Eng | undefined): void => {
    if (e) byId.set(e.id, e);
  };
  for (const hub of new Set(engineers.map((e) => e.hub))) add(engineers.find((e) => e.hub === hub));
  const byUtil = [...engineers].sort((a, b) => b.utilization_pct - a.utilization_pct);
  add(byUtil[0]);
  add(byUtil.at(-1));
  add(engineers.at(-1));
  return [...byId.values()];
}

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Surfaces' })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

test('Capacity heatmap: renders, matches API, keyboard + non-colour cues, axe', async ({ page, request }) => {
  const util = await apiGet<Util>(request, 'admin', '/capacity/engineer-utilization');
  await actAs(page, 'portfolioManager');
  await page.goto('/capacity');
  await settle(page);
  await page.getByRole('button', { name: 'Show engineer utilization' }).click();
  const table = page.getByRole('table', { name: 'Engineer utilization by week' });
  await table.scrollIntoViewIfNeeded();
  await expect(table).toBeVisible();
  const rows = page.getByTestId('engineer-row');
  expect(await rows.count()).toBe(util.engineers.length);
  await expect(page.getByTestId('engineer-util-legend')).toBeVisible();
  // Spot check, 3 weeks each: aria-label carries the API percent and band.
  // P24-T02: picked by role, not by index (the real roster has 23 engineers,
  // and that number will change): the first served engineer of every hub, the
  // most and the least utilized, and the last row. Deduplicated by id.
  const picks = pickEngineers(util.engineers);
  expect(picks.length).toBeGreaterThan(0);
  let checked = 0;
  for (const e of picks) {
    // Exact name match (a substring filter could pick e.g. "Rahul-Contractual" for "Rahul").
    const row = rows.filter({ has: page.getByRole('cell', { name: new RegExp(`^${esc(e.name)}, W`) }) }).first();
    for (const w of [1, util.current_week, 52]) {
      const c = e.weeks.find((x) => x.week === w)!;
      const cell = row.getByRole('cell', { name: new RegExp(`^${esc(e.name)}, W0*${String(w)}:`) }).first();
      const label = (await cell.getAttribute('aria-label')) ?? '';
      const m = label.match(/: ([\d.,]+)% \(([\d.,]+) of ([\d.,]+)\)/);
      expect(m, label).not.toBeNull();
      expect(Number(m![1]!.replace(/,/g, ''))).toBeCloseTo(c.utilization_pct, 0);
      expect(Number(m![2])).toBeCloseTo(c.booked, 1);
      const band = await cell.getAttribute('data-band');
      const exp = c.capacity <= 0 ? 'none' : c.utilization_pct > 100 ? 'over' : c.utilization_pct >= 70 ? 'well' : 'under';
      expect(band, `${e.name} W${String(w)}`).toBe(exp);
      // colour-independent cue: visible numeric text for any cell with capacity
      if (c.capacity > 0) expect((await cell.innerText()).trim()).toMatch(/^\d+/);
      if (exp === 'over') expect(await cell.getAttribute('class')).toContain('ring-');
      checked += 1;
    }
  }
  console.log(`spot-checked cells: ${String(checked)}`);
  await expect(page.locator('[aria-current="date"]').first()).toBeVisible();
  // keyboard: region is focusable and scrolls with arrow keys
  const region = page.getByRole('region', { name: 'Engineer utilization by week, scrollable' });
  await region.focus();
  await expect(region).toBeFocused();
  console.log(`region sw/cw ${JSON.stringify(await region.evaluate((el) => [el.scrollWidth, el.clientWidth, el.scrollHeight, el.clientHeight]))}`);
  const before = await region.evaluate((el) => el.scrollLeft);
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);
  const after = await region.evaluate((el) => el.scrollLeft);
  console.log(`scrollLeft ${String(before)} -> ${String(after)}`);
  expect(after).toBeGreaterThan(before);
  // keyboard tab order reaches the region from the preceding controls
  await checkAxe(page, 'capacity with engineer heatmap');
});

test('Leader names on Dashboard register, Gantt, Matrix, Workspace; none withheld', async ({ page, request }) => {
  const reg = await apiGet<{ rows: { project_id: string; leader_name: string | null; project_name: string }[] }>(request, 'admin', '/dashboard/projects?limit=200');
  const withLeader = reg.rows.filter((r) => r.leader_name);
  expect(withLeader.length).toBeGreaterThan(100);
  await actAs(page, 'portfolioManager');
  for (const [path, label] of [['/', 'register'], ['/timeline', 'gantt'], ['/matrix', 'matrix']] as const) {
    await page.goto(path);
    await settle(page);
    const body = await page.locator('body').innerText();
    expect(body, label).not.toContain('Withheld');
    expect(body, label).not.toContain('Name unavailable');
    const names = new Set(withLeader.map((r) => r.leader_name!));
    const found = [...names].filter((n) => body.includes(n));
    console.log(`${label}: leader names visible ${String(found.length)} e.g. ${found.slice(0, 3).join(', ')}`);
    expect(found.length, label).toBeGreaterThan(0);
    await checkAxe(page, `${label} surface`);
  }
  const p = withLeader[0]!;
  await page.goto(`/projects/${p.project_id}`);
  await settle(page);
  const body = await page.locator('body').innerText();
  expect(body).toContain(p.leader_name!);
  expect(body).not.toContain('Withheld');
  await checkAxe(page, 'workspace');
});

test('Dashboard axe (full page)', async ({ page }) => {
  await actAs(page, 'portfolioManager');
  await page.goto('/');
  await settle(page);
  await checkAxe(page, 'dashboard full');
});

test('Engineer role: no capacity heatmap access', async ({ request }) => {
  const res = await request.get(`${BACKEND_URL}/capacity/engineer-utilization`, { headers: { 'X-Dev-User-Email': DEV_EMAILS.engineer } });
  expect(res.status()).toBe(403);
});
