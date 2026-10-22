import { appendFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, CDPSession, Page, Request } from '@playwright/test';

import { test, expect } from './fixtures';
import { actAs, apiGet, BACKEND_URL, DEV_EMAILS, type DevRole } from './dev-session';

/**
 * P19 + P20 (+P17-R05..R09) gate (qa-inspector), live against a DISPOSABLE stack
 * (own Postgres/Redis/uvicorn/vite preview, client_2026 --schedule, W42).
 * Run: RPD_P19_MATCH='p19-gate\.spec\.ts' npx playwright test -c playwright.p19qa.config.ts
 *   RPD_P19_SHOTS  screenshot dir   RPD_P19_AXE  jsonl axe log
 * MUTATES the DB (one FTE edit + revert, one FTE set to 0.5 + greedy recalc, one
 * step-timing PATCH): never point it at a shared database.
 */

const SHOTS = process.env.RPD_P19_SHOTS;
const AXE_OUT = process.env.RPD_P19_AXE;
const WIDTHS = [1440, 1280, 390] as const;

test.describe.configure({ mode: 'serial' });

async function setup(page: Page, role: DevRole, width = 1440, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('rpd-theme', t), theme);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width, height: 900 });
  await actAs(page, role);
}

async function axe(page: Page, label: string, gate = true): Promise<string[]> {
  const res = await new AxeBuilder({ page }).analyze();
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const lines = bad.map((v) => `${v.id}(${String(v.impact)}) x${String(v.nodes.length)} ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  console.log(`AXE ${label}: ${String(bad.length)}`, lines.join(' || '));
  if (AXE_OUT) appendFileSync(AXE_OUT, `${JSON.stringify({ label, gate, lines, sample: bad.map((v) => v.nodes[0]?.failureSummary?.split('\n').slice(0, 2).join(' ')) })}\n`);
  if (gate) expect.soft(lines, label).toEqual([]);
  return lines;
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(d.scrollWidth - d.clientWidth, document.body.scrollWidth - document.body.clientWidth);
  });
}

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

async function api<T>(request: APIRequestContext, role: DevRole, path: string): Promise<T> {
  return apiGet<T>(request, role, path);
}

function num(text: string | null): number {
  const m = /-?[\d,]+(?:\.\d+)?/.exec(text ?? '');
  return m ? Number(m[0].replace(/,/g, '')) : Number.NaN;
}

async function settle(page: Page, ms = 700): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(ms);
}

/* ------------------------------------------------------------------ Dashboard */

test('Dashboard: section order, pipeline + slim VIP, Hub × Type side by side, register last', async ({ page }) => {
  await setup(page, 'portfolioManager');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Global RPD Dashboard' })).toBeVisible();
  await expect(page.getByTestId('all-projects-register')).toBeVisible({ timeout: 20_000 });
  await settle(page, 1200);
  const heads = await page.evaluate(() => [...document.querySelectorAll('h2, h3')].map((h) => (h.textContent ?? '').trim()));
  const at = (t: string) => heads.findIndex((h) => h === t);
  const order = [
    'Project pipeline', 'VIP projects', 'Status overview', 'Completing within the year',
    'Project pipeline summary: Hub × Type', 'Completing within year: Hub × Type', 'Pipeline vs completing',
    'Delivery by priority', 'All registered projects',
  ];
  const idx = order.map(at);
  console.log('heading order idx', JSON.stringify(Object.fromEntries(order.map((o, i) => [o, idx[i]]))));
  for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
  for (let i = 1; i < idx.length; i++) expect(idx[i]!, `${order[i]!} after ${order[i - 1]!}`).toBeGreaterThan(idx[i - 1]!);
  expect(heads.at(-1), 'register is the last section').toBe('All registered projects');

  const pipe = (await page.getByTestId('pipeline-row').boundingBox())!;
  const vip = (await page.getByTestId('vip-projects-card').boundingBox())!;
  console.log('pipeline', JSON.stringify(pipe), 'vip', JSON.stringify(vip));
  expect(vip.x).toBeGreaterThan(pipe.x + pipe.width - 5);
  expect(Math.abs(vip.y - pipe.y)).toBeLessThan(80);
  expect(vip.width).toBeLessThan(pipe.width);
  const t1 = (await page.getByTestId('hub-type-pipeline-table').boundingBox())!;
  const t2 = (await page.getByTestId('completing-hub-type-table').boundingBox())!;
  console.log('hub-type tables', JSON.stringify(t1), JSON.stringify(t2));
  expect(Math.abs(t1.y - t2.y)).toBeLessThan(60);
  expect(t2.x).toBeGreaterThan(t1.x + t1.width - 5);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, 'dash-1440-full');
});

test('Dashboard: every Hub × Type figure opens exactly its projects (incl. untyped "—")', async ({ page }) => {
  test.setTimeout(400_000);
  await setup(page, 'portfolioManager');
  await page.goto('/');
  await expect(page.getByTestId('completing-hub-type-table')).toBeVisible({ timeout: 20_000 });
  await settle(page, 1000);
  const cells = page.getByTestId('drill-cell');
  const n = await cells.count();
  console.log('drill cells', n);
  expect(n).toBeGreaterThan(20);
  const results: string[] = [];
  let untyped = 0;
  for (let i = 0; i < n; i++) {
    const cell = cells.nth(i);
    await cell.scrollIntoViewIfNeeded();
    const label = (await cell.getAttribute('aria-label')) ?? '';
    const expected = num(label);
    if (/untyped/i.test(label)) untyped += 1;
    await cell.click();
    const dlg = page.getByTestId('hub-type-drilldown');
    await expect(dlg.getByTestId('drilldown-count')).toHaveAttribute('data-count', String(expected), { timeout: 15_000 });
    await expect(dlg.getByTestId('drilldown-mismatch')).toHaveCount(0);
    if (i === 0 || /untyped/i.test(label)) {
      if (i === 0 || untyped === 1) await axe(page, `dashboard drilldown "${label}"`);
    }
    await page.keyboard.press('Escape');
    await expect(cell).toBeFocused();
    results.push(`${label} = ${String(expected)}`);
  }
  console.log('drilldowns ok', results.length, 'untyped', untyped, '\n ', results.join('\n  '));
  expect(untyped, 'untyped (—) figures are clickable').toBeGreaterThan(0);
});

test('Dashboard: Delivery by priority has no "0 of 0"; the two On Hold figures are labelled', async ({ page, request }) => {
  await setup(page, 'portfolioManager');
  await page.goto('/');
  const card = page.getByTestId('priority-delivery-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await settle(page);
  const txt = (await card.innerText()).replace(/\s+/g, ' ');
  console.log('delivery card:', txt.slice(0, 600));
  expect(txt).not.toMatch(/\b0 of 0\b/);
  expect(txt).not.toMatch(/ – /);
  const cwy = await api<{ priority_delivery: { priority: string; total: number; within_year: number }[] }>(request, 'portfolioManager', '/dashboard/completing-within-year');
  for (const b of cwy.priority_delivery.filter((x) => x.total > 0)) {
    await expect(page.getByTestId(`priority-band-${b.priority}`)).toContainText(`${String(b.within_year)} of ${String(b.total)} finishing this year`);
    const segs = await page.getByTestId(`priority-band-${b.priority}`).locator('[data-segment]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-count'))));
    expect(segs.reduce((a, c) => a + c, 0)).toBe(b.total);
  }
  for (const b of cwy.priority_delivery.filter((x) => x.total === 0)) await expect(page.getByTestId(`priority-band-${b.priority}`)).toHaveCount(0);

  const so = await api<{ on_hold_count: number }>(request, 'portfolioManager', '/dashboard/status-overview');
  await expect(page.getByText('On Hold at a stage', { exact: true }).first()).toBeVisible();
  const note = page.getByTestId('paused-projects-note');
  if (so.on_hold_count > 0) {
    await expect(note).toContainText(`${String(so.on_hold_count)} project`);
    await expect(note).toContainText('paused (status On Hold)');
  }
  await expect(page.getByTestId('status-card-on-hold')).toContainText(String(so.on_hold_count));
  console.log('on_hold_count', so.on_hold_count, 'note:', await note.innerText().catch(() => '(none)'));
});

/* ------------------------------------------------------------------ Capacity */

interface HubLoad {
  totals: Record<string, unknown> & {
    design_load_weeks: number; design_capacity_year: number; design_capacity_remaining: number;
    lab_load_weeks: number; lab_capacity_year: number; lab_capacity_remaining: number;
    design_booked_pct_year: number; design_booked_pct_remaining: number;
    design_capacity_days: { year: number; remaining: number }; design_load_days: { year: number; remaining: number };
    lab_capacity_days: { year: number; remaining: number }; lab_load_days: { year: number; remaining: number };
  };
  rows: { hub: string }[];
}
interface HubRow {
  hub: string; lab_region: string;
  design_capacity_year: number; design_capacity_remaining: number; design_load_weeks: number;
  design_booked_pct_year: number; design_booked_pct_remaining: number;
  lab_capacity_year: number; lab_capacity_remaining: number; lab_load_weeks: number;
  lab_booked_pct_year: number; lab_booked_pct_remaining: number;
  capacity_days: { year: number; remaining: number }; load_days: { year: number; remaining: number };
  lab_capacity_days: { year: number; remaining: number }; lab_load_days: { year: number; remaining: number };
}

test('Capacity: KPI cards, seven class cards first, two charts, hub tiles only, grouped table + Details, engineer section only (P19-T07)', async ({ page }) => {
  await setup(page, 'portfolioManager');
  const reqs: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/capacity')) reqs.push(new URL(r.url()).pathname); });
  await page.goto('/capacity');
  await expect(page.getByTestId('capacity-kpi-row')).toBeVisible({ timeout: 20_000 });
  await settle(page, 1000);
  for (const k of ['design-capacity', 'design-load', 'lab-capacity', 'lab-load']) await expect(page.getByTestId(`kpi-${k}`)).toBeVisible();
  const classCards = await page.getByTestId('class-cards').locator('[data-testid^="class-card-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(classCards).toEqual(['class-card-A+', 'class-card-A', 'class-card-B', 'class-card-C', 'class-card-A-OEM', 'class-card-B-OEM', 'class-card-C-OEM']);
  const y = async (tid: string) => (await page.getByTestId(tid).first().boundingBox())!.y;
  const ys = {
    kpi: await y('capacity-kpi-row'), classes: await y('class-cards'), charts: await y('load-capacity-charts'),
    tiles: await y('hub-booking-strip'), table: await y('hub-summary-table'), engineers: await y('section-engineers'),
  };
  console.log('capacity y', JSON.stringify(ys));
  expect(ys.kpi).toBeLessThan(ys.classes);
  expect(ys.classes).toBeLessThan(ys.charts);
  expect(ys.charts).toBeLessThan(ys.tiles);
  expect(ys.tiles).toBeLessThan(ys.table);
  expect(ys.table).toBeLessThan(ys.engineers);
  await expect(page.getByRole('heading', { name: 'Design Demand vs Capacity by Hub' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lab Demand vs Capacity by Lab Region' })).toBeVisible();
  const tiles = await page.getByTestId('booked-tiles').locator('[data-testid^="booked-hub-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(tiles).toHaveLength(6);
  const strip = (await page.getByTestId('hub-booking-strip').innerText());
  expect(strip).not.toMatch(/Europe/);
  expect(strip).not.toMatch(/India area|India \(area\)/);
  expect(await page.locator('main').getByText('Europe').count(), 'no Europe label on Capacity').toBe(0);
  // P19-T06: booked tiles in one labelled box per hub family (R&D 3, PD 2, OEM 1), no family total.
  const fam = async (k: string) => page.getByTestId(`booked-family-${k}`).locator('[data-testid^="booked-hub-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  const famBoxes = await page.getByTestId('booked-families').locator('[data-testid^="booked-family-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  console.log('booked family boxes', JSON.stringify(famBoxes), JSON.stringify(await fam('rd')), JSON.stringify(await fam('pd')), JSON.stringify(await fam('oem')));
  expect(famBoxes).toEqual(['booked-family-rd', 'booked-family-pd', 'booked-family-oem']);
  expect((await fam('rd')).every((t) => t!.startsWith('booked-hub-R&D-'))).toBe(true);
  expect((await fam('pd')).every((t) => t!.startsWith('booked-hub-PD-'))).toBe(true);
  expect((await fam('oem')).every((t) => t!.startsWith('booked-hub-OEM-'))).toBe(true);
  expect((await fam('rd')).length + (await fam('pd')).length + (await fam('oem')).length).toBe(6);
  for (const k of ['rd', 'pd', 'oem']) await expect(page.getByTestId(`booked-family-${k}`).getByRole('heading').first()).toBeVisible();
  // P19-T06 merged table: family row groups, lab figures once per lab region, the other rows marked shared.
  const groups = await page.getByTestId('hub-summary-table').locator('[data-testid^="hub-summary-family-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(groups).toEqual(['hub-summary-family-rd', 'hub-summary-family-pd', 'hub-summary-family-oem']);
  await expect(page.getByRole('heading', { name: 'Load vs. capacity by hub' })).toBeVisible();
  expect(await page.getByTestId('hub-summary-table').getByTestId('lab-load').count()).toBe(3);
  expect(await page.getByTestId('hub-summary-table').getByTestId('lab-shared').count()).toBe(3);
  await page.getByTestId('toggle-priority-split').click();
  await expect(page.getByTestId('toggle-priority-split')).toHaveAttribute('aria-expanded', 'true');
  await axe(page, 'capacity merged table split open 1440');
  await page.getByTestId('toggle-priority-split').click();
  // P19-T06 merged the hub matrix into the table; P19-T07 removed the class chart and the chamber matrix.
  await expect(page.getByTestId('hub-utilization-matrix')).toHaveCount(0);
  await expect(page.getByTestId('class-chart-section')).toHaveCount(0);
  await expect(page.getByTestId('section-chambers')).toHaveCount(0);
  const disclosures = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '').filter((t) => /^(Show|Hide) /.test(t) && /chart|utilization/.test(t)));
  expect(disclosures).toEqual(['Show engineer utilization']);
  expect(reqs.filter((p) => /engineer-utilization|utilization-matrix|chamber/.test(p)), 'lazy sections not fetched').toEqual([]);
  // Details dialog
  await page.getByRole('button', { name: 'Details for PD-India' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('How this is calculated');
  await axe(page, 'capacity details dialog 1440');
  await shot(page, 'cap-details-1440', false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Details for PD-India' })).toBeFocused();
  await page.getByRole('button', { name: 'Show engineer utilization' }).click();
  await expect(page.getByRole('button', { name: 'Hide engineer utilization' })).toBeVisible();
  expect(reqs.filter((p) => /utilization-matrix|chamber/.test(p)), 'chamber matrix never requested').toEqual([]);
  console.log('capacity requests', JSON.stringify([...new Set(reqs)]));
});

test('Capacity: Weeks/Days × YTD/Full year, every combination equals the API', async ({ page, request }) => {
  await setup(page, 'portfolioManager');
  await page.goto('/capacity');
  await expect(page.getByTestId('capacity-kpi-row')).toBeVisible({ timeout: 20_000 });
  await settle(page);
  const hl = await api<HubLoad>(request, 'portfolioManager', '/capacity/hub-load');
  const t = hl.totals;
  const toolbar = page.getByTestId('capacity-toolbar');
  const combos: { unit: 'Weeks' | 'Days'; horizon: 'Full year' | 'YTD 2026'; exp: number[]; pct: number }[] = [
    { unit: 'Weeks', horizon: 'Full year', exp: [t.design_capacity_year, t.design_load_weeks, t.lab_capacity_year, t.lab_load_weeks], pct: t.design_booked_pct_year },
    { unit: 'Weeks', horizon: 'YTD 2026', exp: [t.design_capacity_remaining, t.design_load_weeks, t.lab_capacity_remaining, t.lab_load_weeks], pct: t.design_booked_pct_remaining },
    { unit: 'Days', horizon: 'YTD 2026', exp: [t.design_capacity_days.remaining, t.design_load_days.remaining, t.lab_capacity_days.remaining, t.lab_load_days.remaining], pct: t.design_booked_pct_remaining },
    { unit: 'Days', horizon: 'Full year', exp: [t.design_capacity_days.year, t.design_load_days.year, t.lab_capacity_days.year, t.lab_load_days.year], pct: t.design_booked_pct_year },
  ];
  for (const c of combos) {
    await toolbar.getByRole('radio', { name: c.unit, exact: true }).click();
    await toolbar.getByRole('radio', { name: c.horizon, exact: true }).click();
    await page.waitForTimeout(400);
    await expect(toolbar.getByRole('radio', { name: c.unit, exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(toolbar.getByRole('radio', { name: c.horizon, exact: true })).toHaveAttribute('aria-checked', 'true');
    const kpi = await Promise.all(['design-capacity', 'design-load', 'lab-capacity', 'lab-load'].map(async (k) => num(await page.getByTestId(`kpi-${k}-value`).innerText())));
    const tbl = await Promise.all(['total-design-capacity', 'total-design-load', 'total-lab-capacity', 'total-lab-load'].map(async (k) => num(await page.getByTestId(k).innerText())));
    const booked = num(await page.getByTestId('kpi-design-load-booked').innerText());
    console.log(`${c.unit}/${c.horizon}: kpi ${JSON.stringify(kpi)} table ${JSON.stringify(tbl)} api ${JSON.stringify(c.exp)} booked ${String(booked)} api ${String(c.pct)}`);
    for (let i = 0; i < 4; i++) {
      expect(kpi[i]!, `${c.unit}/${c.horizon} KPI ${String(i)}`).toBeCloseTo(c.exp[i]!, 1);
      expect(tbl[i]!, `${c.unit}/${c.horizon} table ${String(i)}`).toBeCloseTo(c.exp[i]!, 1);
    }
    expect(booked).toBeCloseTo(c.pct, 1);
    // Every merged-table hub row equals the served row for this unit/horizon (lab once per region).
    const days = c.unit === 'Days';
    const hk: 'year' | 'remaining' = c.horizon === 'Full year' ? 'year' : 'remaining';
    let checked = 0;
    for (const r of hl.rows as unknown as HubRow[]) {
      const tr = page.getByTestId(`hub-summary-row-${r.hub}`);
      const dCap = days ? r.capacity_days[hk] : hk === 'year' ? r.design_capacity_year : r.design_capacity_remaining;
      const dLoad = days ? r.load_days[hk] : r.design_load_weeks;
      const dPct = hk === 'year' ? r.design_booked_pct_year : r.design_booked_pct_remaining;
      expect(num(await tr.getByTestId('design-capacity').innerText()), `${r.hub} design cap ${c.unit}/${c.horizon}`).toBeCloseTo(dCap, 1);
      expect(num(await tr.getByTestId('design-load').first().innerText()), `${r.hub} design load`).toBeCloseTo(dLoad, 1);
      // Final gate: a hub with no engineers (OEM-Seitek in the real roster, ADR 0035) has no capacity, so its
      // booked % is served null and shown without a number.
      if (dPct === null) expect(await tr.getByTestId('design-booked').innerText(), `${r.hub} design booked (null)`).not.toMatch(/\d/);
      else expect(num(await tr.getByTestId('design-booked').innerText()), `${r.hub} design booked`).toBeCloseTo(dPct, 1);
      if (await tr.getByTestId('lab-capacity').count()) {
        const lCap = days ? r.lab_capacity_days[hk] : hk === 'year' ? r.lab_capacity_year : r.lab_capacity_remaining;
        const lLoad = days ? r.lab_load_days[hk] : r.lab_load_weeks;
        const lPct = hk === 'year' ? r.lab_booked_pct_year : r.lab_booked_pct_remaining;
        expect(num(await tr.getByTestId('lab-capacity').innerText()), `${r.hub} lab cap`).toBeCloseTo(lCap, 1);
        expect(num(await tr.getByTestId('lab-load').first().innerText()), `${r.hub} lab load`).toBeCloseTo(lLoad, 1);
        expect(num(await tr.getByTestId('lab-booked').innerText()), `${r.hub} lab booked`).toBeCloseTo(lPct, 1);
      } else {
        await expect(tr.getByTestId('lab-shared')).toContainText(`shared ${r.lab_region} lab region`);
      }
      checked += 1;
    }
    expect(checked).toBe(6);
    await axe(page, `capacity ${c.unit}/${c.horizon} 1440`);
    await shot(page, `cap-${c.unit}-${c.horizon.replace(/\s/g, '')}-1440`, false);
  }
});

/* --------------------------------------------------------- Capacity Planning */

interface Summary {
  design: { hubs: { hub: string; engineer_count: number; fte_total: number; capacity_weeks: { year: number; remaining: number }; share_pct: { year: number; remaining: number } }[]; total: Record<string, unknown> };
  lab: { regions: { lab_region: string; capacity_weeks: { year: number; remaining: number } }[]; total: Record<string, unknown> };
}

test('Capacity Planning (Frank Admin): totals = API, hub and lab cards with chips, lazy Resource load, filters, Dept enabled, What-if', async ({ page, request }) => {
  test.setTimeout(240_000);
  await setup(page, 'admin');
  const rl: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname === '/api/planning/resource-load') rl.push(u.search); });
  await page.goto('/planning');
  await expect(page.getByTestId('hub-card-PD-India')).toBeVisible({ timeout: 20_000 });
  await settle(page, 1000);
  const sum = await api<Summary>(request, 'admin', '/planning/capacity-summary');
  console.log('summary totals', JSON.stringify(sum.design.total), JSON.stringify(sum.lab.total));
  const heads = await page.getByTestId('total-headline').allInnerTexts();
  console.log('total headlines', JSON.stringify(heads));
  const dt = sum.design.total as { capacity_weeks: { remaining: number } };
  const lt = sum.lab.total as { capacity_weeks: { remaining: number } };
  expect(num(heads[0]!)).toBeCloseTo(dt.capacity_weeks.remaining, 1);
  expect(num(heads[1]!)).toBeCloseTo(lt.capacity_weeks.remaining, 1);
  for (const h of sum.design.hubs) {
    const card = page.getByTestId(`hub-card-${h.hub}`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('share')).toContainText(`${String(h.share_pct.remaining)}%`);
    expect(await card.locator('[data-testid^="engineer-row-"]').count(), h.hub).toBe(h.engineer_count);
  }
  for (const r of sum.lab.regions) await expect(page.getByTestId(`lab-card-${r.lab_region}`)).toBeVisible();
  expect(await page.getByRole('button', { name: /^Allow category / }).count()).toBeGreaterThan(50);
  expect(await page.getByRole('button', { name: /^Allow stage / }).count()).toBeGreaterThan(5);
  expect(await page.getByRole('spinbutton', { name: /^FTE for / }).count()).toBe(sum.design.hubs.reduce((a, h) => a + h.engineer_count, 0));

  // Lazy: nothing fetched until the section scrolls into view.
  expect(rl, 'resource-load before scroll').toEqual([]);
  const section = page.getByTestId('resource-load');
  await section.scrollIntoViewIfNeeded();
  await expect.poll(() => rl.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  console.log('resource-load first query', rl[0]);
  await settle(page, 800);
  const dept = section.getByRole('button', { name: /^Dept filter/ });
  // P24-T02: the department options are served now (`requesting_department_available`), so Dept is enabled.
  await expect(dept).not.toHaveAttribute('aria-disabled', 'true');
  // Filter: Type → first option; request carries project_type; UI totals = API with the same filter.
  const before = rl.length;
  await section.getByRole('button', { name: /^Type filter/ }).click();
  const firstOpt = page.getByRole('checkbox').first();
  const optLabel = await page.locator(`label[for="${(await firstOpt.getAttribute('id')) ?? ''}"]`).innerText();
  await firstOpt.click();
  await page.keyboard.press('Escape');
  await expect.poll(() => rl.length, { timeout: 10_000 }).toBeGreaterThan(before);
  await settle(page, 800);
  const q = rl.at(-1)!;
  console.log('filtered query', q, 'option', optLabel);
  expect(q).toMatch(/project_type=/);
  const filtered = await api<{ engineers: unknown[]; totals: Record<string, unknown> }>(request, 'admin', `/planning/resource-load${q}`);
  console.log('filtered totals', JSON.stringify(filtered.totals).slice(0, 400));
  await shot(page, 'planning-resource-load-filtered-1440', false);

  // What-if tab still works (estimate).
  await page.getByRole('tab', { name: 'What-if planner' }).click();
  await expect(page.getByRole('heading', { name: 'Scenario builder' })).toBeVisible();
  await page.getByRole('button', { name: 'Add project line' }).click();
  const g = page.getByRole('group', { name: /Added projects, line 1/ });
  await g.getByLabel('Hub').selectOption('PD-India');
  await g.getByLabel('Category').selectOption('C');
  await g.getByLabel('Count').fill('3');
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByTestId('whatif-estimate')).toBeVisible({ timeout: 30_000 });
  await axe(page, 'planning what-if estimate 1440');
});

test('Capacity Planning: inline FTE edit as Frank Admin, revert, audit rows', async ({ page, request }) => {
  await setup(page, 'admin');
  const patches: { url: string; body: unknown }[] = [];
  page.on('request', (r: Request) => { if (r.method() === 'PATCH' && r.url().includes('/api/engineers/')) patches.push({ url: new URL(r.url()).pathname, body: r.postDataJSON() }); });
  await page.goto('/planning');
  const card = page.getByTestId('hub-card-R&D-Greece');
  await expect(card).toBeVisible({ timeout: 20_000 });
  // Final gate: R&D-Greece has 3 engineers in the real roster (ADR 0035); edit the first one.
  const input = card.getByRole('spinbutton', { name: /^FTE for / }).first();
  const name = ((await input.getAttribute('aria-label')) ?? '').replace('FTE for ', '');
  const original = await input.inputValue();
  const engId = ((await card.locator('[data-testid^="engineer-row-"]').first().getAttribute('data-testid')) ?? '').replace('engineer-row-', '');
  const target = original === '0.9' ? '0.8' : '0.9';
  await input.fill(target);
  await input.press('Enter');
  await expect.poll(() => patches.length).toBe(1);
  await expect.poll(async () => (await api<{ fte: number | string }>(request, 'admin', `/engineers/${engId}`)).fte.toString()).toMatch(new RegExp(`^${target}0?$`));
  await settle(page, 600);
  const capAfter = await card.getByTestId(`engineer-row-${engId}`).innerText();
  console.log('after edit row:', capAfter.replace(/\s+/g, ' ').slice(0, 120));
  await input.fill(original);
  await input.press('Enter');
  await expect.poll(() => patches.length).toBe(2);
  await expect.poll(async () => Number((await api<{ fte: number | string }>(request, 'admin', `/engineers/${engId}`)).fte)).toBe(Number(original));
  console.log('patches', JSON.stringify(patches));
  expect(patches[0]!.body).toEqual({ fte: Number(target) });
  expect(patches[1]!.body).toEqual({ fte: Number(original) });
  const audit = await api<{ items: { action: string; entity_type: string; entity_id: string; actor_user_id: string; before_state: unknown; after_state: unknown }[] }>(
    request, 'admin', `/audit-log?entity_id=${engId}&limit=10`,
  );
  const rows = audit.items.filter((a) => a.entity_id === engId);
  console.log('audit rows for', name, JSON.stringify(rows.slice(0, 3)));
  expect(rows.length).toBeGreaterThanOrEqual(2);
  const me = await api<{ user_id: string }>(request, 'admin', '/me');
  expect(rows[0]!.actor_user_id).toBe(me.user_id);
  expect(JSON.stringify(rows[0]!.after_state)).toContain(original.replace(/0+$/, ''));
  expect(JSON.stringify(rows[1]!.after_state)).toContain(target);
});

test('Capacity Planning after P19-R01 strict schemas: chamber Platforms / Efficiency, stage + category chips save (200) with audit rows', async ({ page, request }) => {
  test.setTimeout(180_000);
  await setup(page, 'admin');
  const sent: { url: string; body: unknown; status: number }[] = [];
  page.on('response', async (res) => {
    const rq = res.request();
    if (rq.method() === 'PATCH' && /\/api\/(chambers|engineers)\//.test(rq.url())) sent.push({ url: new URL(rq.url()).pathname, body: rq.postDataJSON(), status: res.status() });
  });
  await page.goto('/planning');
  const lab = page.getByTestId('lab-card-Greece');
  await expect(lab).toBeVisible({ timeout: 20_000 });
  await settle(page, 600);
  const row = lab.locator('[data-testid^="chamber-row-"]').first();
  const chId = ((await row.getAttribute('data-testid')) ?? '').replace('chamber-row-', '');
  const before = await api<{ code: string; platforms: number; efficiency: number | string; allowed_stages: string[] }>(request, 'admin', `/chambers/${chId}`);
  console.log('chamber before', JSON.stringify(before));
  const plat = row.getByRole('spinbutton', { name: /^Platforms for / });
  const eff = row.getByRole('spinbutton', { name: /^Efficiency for / });
  const n = () => sent.length;
  const commit = async (input: ReturnType<typeof row.getByRole>, v: string) => { const k = n(); await input.fill(v); await input.press('Enter'); await expect.poll(n, { timeout: 10_000 }).toBe(k + 1); await settle(page, 300); };
  await commit(plat, String(before.platforms + 1));
  await commit(plat, String(before.platforms));
  const effNew = Number(before.efficiency) === 0.9 ? '0.85' : '0.9';
  await commit(eff, effNew);
  await commit(eff, String(Number(before.efficiency)));
  // One stage chip off and on again.
  const chip = row.getByRole('button', { name: /^Allow stage / }).first();
  const pressed0 = await chip.getAttribute('aria-pressed');
  let k = n(); await chip.click(); await expect.poll(n, { timeout: 10_000 }).toBe(k + 1); await settle(page, 400);
  k = n(); await chip.click(); await expect.poll(n, { timeout: 10_000 }).toBe(k + 1); await settle(page, 400);
  await expect(chip).toHaveAttribute('aria-pressed', pressed0 ?? 'false');
  // One engineer category chip off and on again (enum list items, Strict(False)).
  const card = page.getByTestId('hub-card-R&D-Greece');
  const engRow = card.locator('[data-testid^="engineer-row-"]').first();
  const engId = ((await engRow.getAttribute('data-testid')) ?? '').replace('engineer-row-', '');
  const cat = engRow.getByRole('button', { name: /^Allow category / }).first();
  const catPressed = await cat.getAttribute('aria-pressed');
  k = n(); await cat.click(); await expect.poll(n, { timeout: 10_000 }).toBe(k + 1); await settle(page, 400);
  k = n(); await cat.click(); await expect.poll(n, { timeout: 10_000 }).toBe(k + 1); await settle(page, 400);
  await expect(cat).toHaveAttribute('aria-pressed', catPressed ?? 'false');
  console.log('PATCHes', JSON.stringify(sent));
  expect(sent.map((x) => x.status), 'every PATCH 200').toEqual(sent.map(() => 200));
  expect(sent[0]!.body).toEqual({ platforms: before.platforms + 1 });
  expect(sent[2]!.body).toEqual({ efficiency: Number(effNew) });
  for (const x of sent) for (const v of Object.values(x.body as Record<string, unknown>)) expect(typeof v === 'string', `no string-number in ${JSON.stringify(x.body)}`).toBe(false);
  const after = await api<{ platforms: number; efficiency: number | string; allowed_stages: string[] }>(request, 'admin', `/chambers/${chId}`);
  expect(after.platforms).toBe(before.platforms);
  expect(Number(after.efficiency)).toBe(Number(before.efficiency));
  expect([...after.allowed_stages].sort()).toEqual([...before.allowed_stages].sort());
  const audit = await api<{ items: { action: string; entity_id: string }[] }>(request, 'admin', `/audit-log?entity_id=${chId}&limit=20`);
  const chRows = audit.items.filter((a) => a.entity_id === chId);
  const engAudit = await api<{ items: { action: string; entity_id: string }[] }>(request, 'admin', `/audit-log?entity_id=${engId}&limit=20`);
  console.log('chamber audit actions', JSON.stringify(chRows.map((a) => a.action)), 'engineer audit actions', JSON.stringify(engAudit.items.map((a) => a.action)));
  expect(chRows.length).toBeGreaterThanOrEqual(6);
  expect(engAudit.items.filter((a) => a.entity_id === engId).length).toBeGreaterThanOrEqual(2);
  await axe(page, 'planning after chamber edits 1440');
});

test('Capacity Planning roles: PM read-only, Executive Viewer no access, Hub Planner own hub only', async ({ browser, request }) => {
  // Portfolio Manager: read-only.
  const pm = await browser.newPage();
  await setup(pm, 'portfolioManager');
  await pm.goto('/planning');
  await expect(pm.getByTestId('hub-card-PD-India')).toBeVisible({ timeout: 20_000 });
  await expect(pm.getByTestId('read-only-notice')).toBeVisible();
  expect(await pm.getByRole('spinbutton').count()).toBe(0);
  expect(await pm.getByRole('button', { name: /^Allow / }).count()).toBe(0);
  expect(await pm.getByRole('button', { name: /^(Edit|Delete|Add engineer to) / }).count()).toBe(0);
  await pm.close();

  // Executive Viewer: no Capacity Planning read (P19-T03 role matrix) -> 403 and no nav entry.
  const ev = await browser.newPage();
  await setup(ev, 'executiveViewer');
  const r = await request.get(`${BACKEND_URL}/planning/capacity-summary`, { headers: { 'X-Dev-User-Email': DEV_EMAILS.executiveViewer } });
  console.log('exec /planning/capacity-summary', r.status());
  expect(r.status()).toBe(403);
  await ev.goto('/planning');
  await settle(ev, 800);
  expect(await ev.getByRole('spinbutton').count()).toBe(0);
  expect(await ev.getByRole('button', { name: /^Allow / }).count()).toBe(0);
  expect(await ev.getByTestId('hub-card-PD-India').count()).toBe(0);
  const evText = (await ev.locator('body').innerText()).replace(/\s+/g, ' ');
  console.log('exec /planning shows:', evText.slice(0, 300));
  await shot(ev, 'planning-exec-1440', false);
  await ev.close();

  // Hub Planner (PD-India): only own hub; lab region India only.
  const hp = await browser.newPage();
  await setup(hp, 'hubPlanner');
  await hp.goto('/planning');
  await expect(hp.getByTestId('hub-card-PD-India')).toBeVisible({ timeout: 20_000 });
  await settle(hp, 800);
  const hubCards = await hp.locator('[data-testid^="hub-card-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  const labCards = await hp.locator('[data-testid^="lab-card-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  console.log('hub planner cards', JSON.stringify(hubCards), JSON.stringify(labCards));
  expect(hubCards).toEqual(['hub-card-PD-India']);
  expect(labCards).toEqual(['lab-card-India']);
  const s = await api<Summary>(request, 'hubPlanner', '/planning/capacity-summary');
  expect(s.design.hubs.map((h) => h.hub)).toEqual(['PD-India']);
  await hp.getByTestId('resource-load').scrollIntoViewIfNeeded();
  await settle(hp, 1200);
  const rlText = await hp.getByTestId('resource-load').innerText();
  for (const other of ['(R&D-Greece)', '(R&D-India)', '(PD-Romania)', '(OEM-HCK)', '(OEM-Seitek)']) expect(rlText).not.toContain(other);
  await hp.close();
});

/* ----------------------------------------------------------------- Workspace */

test('Workspace: health of a part-time-led on-time project is not At Risk', async ({ page, request }) => {
  await setup(page, 'portfolioManager');
  const engineers = await api<{ id: string; fte: number | string }[]>(request, 'admin', '/engineers?limit=500');
  const fte = new Map(engineers.map((e) => [e.id, Number(e.fte)]));
  const gantt = await api<{ rows: { project_id: string; project_name: string; leader_engineer_id: string | null; projected_end_week: number | null; blocked: boolean; steps: { kind: string; status: string }[] }[] }>(request, 'admin', '/gantt?limit=500');
  const cands = gantt.rows.filter((r) => r.projected_end_week !== null && r.projected_end_week <= 52 && !r.blocked && (fte.get(r.leader_engineer_id ?? '') ?? 1) < 1);
  const withInProgress = cands.filter((r) => r.steps.some((s) => s.kind === 'design' && s.status === 'In Progress'));
  console.log('part-time-led within-year projects', cands.length, 'with a design step In Progress', withInProgress.length);
  expect(cands.length).toBeGreaterThan(0);
  const picks = [...withInProgress.slice(0, 2), ...cands.slice(0, 1)];
  for (const p of picks) {
    const ws = await api<{ health: string }>(request, 'portfolioManager', `/projects/${p.project_id}/workspace`);
    await page.goto(`/projects/${p.project_id}`);
    const badge = page.getByTestId('health-badge').first();
    await expect(badge).toBeVisible({ timeout: 20_000 });
    const h = await badge.getAttribute('data-health');
    console.log(p.project_name.slice(0, 40), 'leader fte', fte.get(p.leader_engineer_id ?? ''), 'W', p.projected_end_week, 'api', ws.health, 'ui', h);
    expect(h).toBe(ws.health);
    expect(h).not.toBe('at_risk');
  }
  await shot(page, 'workspace-parttime-1440', false);
});

/* ----------------------------------------------------- Axe + overflow sweep */

for (const width of WIDTHS) {
  test(`axe light + overflow at ${String(width)}: Dashboard, Capacity, Planning Overview + Resource load`, async ({ page }) => {
    test.setTimeout(240_000);
    await setup(page, 'admin', width);
    await page.goto('/');
    await expect(page.getByTestId('all-projects-register')).toBeVisible({ timeout: 25_000 });
    await settle(page, 1200);
    await axe(page, `dashboard light ${String(width)}`);
    expect(await overflow(page), `dashboard overflow ${String(width)}`).toBeLessThanOrEqual(0);
    await shot(page, `dash-${String(width)}`);

    await page.goto('/capacity');
    await expect(page.getByTestId('hub-summary-table')).toBeVisible({ timeout: 20_000 });
    await settle(page, 1000);
    await axe(page, `capacity light ${String(width)}`);
    expect(await overflow(page), `capacity overflow ${String(width)}`).toBeLessThanOrEqual(0);
    await shot(page, `cap-${String(width)}`);
    await page.getByTestId('capacity-toolbar').getByRole('radio', { name: 'Days', exact: true }).click();
    await page.getByTestId('capacity-toolbar').getByRole('radio', { name: 'YTD 2026', exact: true }).click();
    await settle(page, 500);
    await axe(page, `capacity light days/ytd ${String(width)}`);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await page.goto('/planning');
    await expect(page.getByTestId('hub-card-PD-India')).toBeVisible({ timeout: 20_000 });
    await settle(page, 800);
    await axe(page, `planning overview light ${String(width)}`);
    expect(await overflow(page), `planning overflow ${String(width)}`).toBeLessThanOrEqual(0);
    await shot(page, `planning-${String(width)}`);
    await page.getByTestId('resource-load').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('resource-load').locator('[data-testid^="load-row-"]').first()).toBeVisible({ timeout: 20_000 });
    await settle(page, 800);
    await axe(page, `planning resource load light ${String(width)}`);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.getByTestId('resource-load').screenshot({ path: SHOTS ? `${SHOTS}/resource-load-${String(width)}.png` : undefined });
  });
}

test('axe DARK (report only): Dashboard, Capacity, Planning at 1440 and 390', async ({ page }) => {
  test.setTimeout(240_000);
  for (const width of [1440, 390]) {
    await setup(page, 'admin', width, 'dark');
    await page.goto('/');
    await expect(page.getByTestId('all-projects-register')).toBeVisible({ timeout: 25_000 });
    await settle(page, 1200);
    await axe(page, `dashboard DARK ${String(width)}`, false);
    await shot(page, `dark-dash-${String(width)}`, false);
    await page.goto('/capacity');
    await expect(page.getByTestId('hub-summary-table')).toBeVisible({ timeout: 20_000 });
    await settle(page, 800);
    await axe(page, `capacity DARK ${String(width)}`, false);
    await page.goto('/planning');
    await expect(page.getByTestId('hub-card-PD-India')).toBeVisible({ timeout: 20_000 });
    await settle(page, 800);
    await axe(page, `planning DARK ${String(width)}`, false);
    await page.getByTestId('resource-load').scrollIntoViewIfNeeded();
    await settle(page, 1500);
    await axe(page, `planning resource load DARK ${String(width)}`, false);
    await shot(page, `dark-planning-${String(width)}`, false);
  }
});

/* ---------------------------------------------------------------------- Gantt */

async function openProject(page: Page, proj: { project_name: string; external_code: string | null }): Promise<void> {
  await page.goto('/timeline');
  await expect(page.getByRole('heading', { name: 'Project Execution Timeline', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByPlaceholder('Project name or code').fill(proj.external_code ?? proj.project_name.slice(0, 30));
  await settle(page, 600);
  const expandBtn = page.getByRole('button', { name: `Expand steps for ${proj.project_name}` }).first();
  await expandBtn.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('gantt-step-row').first()).toBeVisible();
  await settle(page, 500);
}

/** Visible timeline in client px: the scroll viewport minus both sticky columns. */
async function timelineVisible(page: Page): Promise<{ left: number; right: number }> {
  return page.getByTestId('gantt-scroll').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const lh = el.querySelector('[data-testid="gantt-left-header"]')?.getBoundingClientRect().width ?? 0;
    const sh = el.querySelector('[data-testid="gantt-status-header"]')?.getBoundingClientRect().width ?? 0;
    return { left: r.left + lh, right: r.left + el.clientWidth - sh };
  });
}

async function bringHandle(page: Page, handle: ReturnType<Page['getByTestId']>, targetX: number): Promise<void> {
  const b = (await handle.boundingBox())!;
  await page.getByTestId('gantt-scroll').evaluate((el, dx) => { el.scrollLeft += dx; }, b.x + b.width / 2 - targetX);
  await page.waitForTimeout(300);
}

async function hitTest(page: Page, x: number, y: number, sel: string): Promise<{ ok: boolean; desc: string }> {
  return page.evaluate(([px, py, s]) => {
    const el = document.elementFromPoint(Number(px), Number(py));
    if (!el) return { ok: false, desc: 'none' };
    return { ok: !!el.closest(String(s)), desc: `${el.tagName}.${String(el.getAttribute('data-testid'))} sticky=${String(!!el.closest('.sticky'))}` };
  }, [x, y, sel] as const);
}

async function expectLabelInside(page: Page, what: string): Promise<void> {
  const vis = await timelineVisible(page);
  const lb = (await page.getByTestId('step-drag-label').boundingBox())!;
  const side = await page.getByTestId('step-drag-label').getAttribute('data-side');
  const wrapped = await page.getByTestId('step-drag-label').getAttribute('data-wrapped');
  console.log(`label ${what}: x ${lb.x.toFixed(1)}..${(lb.x + lb.width).toFixed(1)} visible ${vis.left.toFixed(1)}..${vis.right.toFixed(1)} side ${String(side)} wrapped ${String(wrapped)}`);
  expect(lb.x, `${what}: label left inside timeline`).toBeGreaterThanOrEqual(vis.left - 1);
  expect(lb.x + lb.width, `${what}: label right inside timeline`).toBeLessThanOrEqual(vis.right + 1);
}

async function touchStart(page: Page, x: number, y: number): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  return cdp;
}
async function touchMove(cdp: CDPSession, x: number, y: number, dx: number): Promise<void> {
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 8, y }] });
}
async function touchEnd(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function effectiveOpacity(loc: ReturnType<Page['locator']>): Promise<number> {
  return loc.evaluate((el) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  });
}


interface GStep {
  step_id: string; step_name: string; kind: string; status: string; skipped: boolean;
  duration_weeks: number | null; planned_start_week: number | null; planned_end_week: number | null;
  timing_editable: string; span_fte: number | null; assigned_engineer_name: string | null;
}
interface GRow { project_id: string; project_name: string; external_code: string | null; hub: string; leader_engineer_id: string | null; frozen: boolean; steps: GStep[] }

test('Gantt: Executive Viewer gets span_fte null everywhere and no drag handles', async ({ page, request }) => {
  const g = await api<{ rows: GRow[] }>(request, 'executiveViewer', '/gantt?limit=500');
  const steps = g.rows.flatMap((r) => r.steps);
  const nonNull = steps.filter((s) => s.span_fte !== null).length;
  console.log('exec gantt rows', g.rows.length, 'steps', steps.length, 'non-null span_fte', nonNull);
  expect(nonNull).toBe(0);
  await setup(page, 'executiveViewer');
  await page.goto('/timeline');
  await expect(page.getByRole('heading', { name: 'Project Execution Timeline', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Expand all' }).click();
  await settle(page, 800);
  expect(await page.getByTestId('gantt-step-row').count()).toBeGreaterThan(0);
  expect(await page.getByTestId('step-drag-handle').count()).toBe(0);
  expect(await page.getByRole('button', { name: /^Edit timing for / }).count()).toBe(0);
});

test('Gantt QA-P19-1 re-check: project with skipped LAB steps expanded, axe 0 at 1440 / 1280 / 390, during a drag, and in the narrow details dialog', async ({ page, request }) => {
  test.setTimeout(300_000);
  const g = await api<{ rows: GRow[] }>(request, 'hubPlanner', '/gantt?limit=500');
  const cands = g.rows.filter((r) => !r.frozen
    && r.steps.filter((s) => s.kind === 'lab' && s.skipped).length >= 2
    && r.steps.some((s) => !s.skipped && s.timing_editable !== 'none' && s.planned_start_week !== null && (s.planned_end_week ?? 99) <= 70));
  console.log('projects with >=2 skipped LAB steps and an editable step', cands.length);
  expect(cands.length).toBeGreaterThan(0);
  const proj = cands[0]!;
  const step = proj.steps.find((s) => !s.skipped && s.timing_editable !== 'none' && s.planned_start_week !== null && (s.planned_end_week ?? 99) <= 70)!;
  console.log('target', proj.project_name, 'skipped lab', proj.steps.filter((s) => s.kind === 'lab' && s.skipped).map((s) => s.step_name).join(' | '), 'drag step', step.step_name, step.kind);
  for (const width of WIDTHS) {
    await setup(page, 'hubPlanner', width);
    await openProject(page, proj);
    const skipped = page.locator('[data-testid="gantt-step-row"] [data-skipped]');
    const nSkipped = await skipped.count();
    expect(nSkipped).toBeGreaterThan(0);
    let labBadges = 0;
    for (let i = 0; i < nSkipped; i++) {
      const badge = skipped.nth(i).locator(':scope > *').first();
      const txt = (await badge.innerText()).trim();
      const op = await effectiveOpacity(badge);
      if (/lab/i.test(txt)) labBadges += 1;
      expect(op, `skipped badge "${txt}" opacity ${String(width)}`).toBe(1);
    }
    console.log(`${String(width)}: skipped rows ${String(nSkipped)}, skipped LAB badges ${String(labBadges)}`);
    expect(labBadges).toBeGreaterThanOrEqual(1);
    await axe(page, `gantt skipped-LAB expanded light ${String(width)}`);
    await shot(page, `gantt-skipped-${String(width)}`, false);
    expect(await overflow(page), `gantt overflow ${String(width)}`).toBeLessThanOrEqual(0);

    // During a drag (mouse wide, touch narrow), then cancel with Escape.
    const handle = page.locator(`[data-testid="step-drag-handle"][title*="${step.step_name}"]`).first();
    await handle.scrollIntoViewIfNeeded();
    const vis = await timelineVisible(page);
    await bringHandle(page, handle, vis.left + Math.min(40, (vis.right - vis.left) / 4));
    const hb = (await handle.boundingBox())!;
    const sx = hb.x + hb.width / 2;
    const sy = hb.y + hb.height / 2;
    expect((await hitTest(page, sx, sy, '[data-testid="step-drag-handle"]')).ok, `handle reachable ${String(width)}`).toBe(true);
    let touch: CDPSession | null = null;
    if (width === 390) { touch = await touchStart(page, sx, sy); await touchMove(touch, sx, sy, 40); }
    else { await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 40, sy, { steps: 6 }); }
    await expect(page.getByTestId('step-drag-label')).toBeVisible();
    await expectLabelInside(page, `skipped-project drag ${String(width)}`);
    await axe(page, `gantt skipped-LAB during drag light ${String(width)}`);
    await shot(page, `gantt-skipped-drag-${String(width)}`, false);
    await page.keyboard.press('Escape');
    if (touch) await touchEnd(touch); else await page.mouse.up();
    await expect(page.getByTestId('step-drag-label')).toHaveCount(0);

    if (width === 390) {
      // Narrow: status lives in the project-details dialog. Real pointer click (hit-test), axe, focus return.
      const details = page.getByTestId('gantt-row-details').first();
      await details.scrollIntoViewIfNeeded();
      const db = (await details.boundingBox())!;
      const hit = await hitTest(page, db.x + db.width / 2, db.y + db.height / 2, '[data-testid="gantt-row-details"]');
      expect(hit.ok, `details button reachable: ${hit.desc}`).toBe(true);
      await details.click();
      const dlg = page.getByTestId('gantt-project-details');
      await expect(dlg).toBeVisible();
      const db2 = (await dlg.boundingBox())!;
      expect(db2.x).toBeGreaterThanOrEqual(0);
      expect(db2.x + db2.width).toBeLessThanOrEqual(390);
      console.log('details dialog:', (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 300));
      await axe(page, 'gantt project-details dialog light 390');
      await shot(page, 'gantt-details-390', false);
      await page.keyboard.press('Escape');
      await expect(dlg).toBeHidden();
      // QA-P19-3, fixed in P19-R03: focus returns to the Details button (WCAG 2.4.3). Hard assertion (final gate).
      await expect(details).toBeFocused();
      // The expand chevron is reachable by pointer too.
      const chev = page.getByRole('button', { name: `Collapse steps for ${proj.project_name}` }).first();
      const cb = (await chev.boundingBox())!;
      expect((await hitTest(page, cb.x + cb.width / 2, cb.y + cb.height / 2, 'button')).ok).toBe(true);
    }
  }
});

test('Gantt O1 re-check: drag label near W52 stays inside the visible timeline at 1440 and 1280', async ({ page, request }) => {
  test.setTimeout(240_000);
  const g = await api<{ rows: GRow[] }>(request, 'hubPlanner', '/gantt?limit=500');
  const cands = g.rows.flatMap((r) => r.steps.map((s) => ({ r, s })))
    .filter(({ r, s }) => !r.frozen && !s.skipped && s.timing_editable !== 'none' && (s.planned_end_week ?? 0) >= 49 && (s.planned_end_week ?? 99) <= 52)
    .sort((a, b) => (b.s.planned_end_week ?? 0) - (a.s.planned_end_week ?? 0));
  console.log('editable steps ending W49..W52', cands.length);
  expect(cands.length).toBeGreaterThan(0);
  const { r: proj, s: step } = cands[0]!;
  console.log('target', proj.project_name.slice(0, 50), step.step_name, step.kind, `W${String(step.planned_start_week)}-W${String(step.planned_end_week)}`, 'span_fte', step.span_fte);
  for (const width of [1440, 1280]) {
    await setup(page, 'hubPlanner', width);
    await openProject(page, proj);
    const handle = page.locator(`[data-testid="step-drag-handle"][title*="${step.step_name}"]`).first();
    await handle.scrollIntoViewIfNeeded();
    let measured = 0;
    for (const [where, dxWeeks] of [['right edge', 2], ['right edge +4', 4], ['mid', 3]] as const) {
      const vis = await timelineVisible(page);
      await bringHandle(page, handle, where === 'mid' ? (vis.left + vis.right) / 2 : vis.right - 30);
      const hb = (await handle.boundingBox())!;
      const vis2 = await timelineVisible(page);
      const centre = await hitTest(page, hb.x + hb.width / 2, hb.y + hb.height / 2, '[data-testid="step-drag-handle"]');
      // Grab the part of the handle that is not under the sticky status column.
      const sx = (hb.x + Math.min(hb.x + hb.width, vis2.right - 1)) / 2;
      const sy = hb.y + hb.height / 2;
      const grab = await hitTest(page, sx, sy, '[data-testid="step-drag-handle"]');
      console.log(`${String(width)} ${where}: handle x ${hb.x.toFixed(1)}..${(hb.x + hb.width).toFixed(1)} visible right ${vis2.right.toFixed(1)}; centre hit ${centre.desc} ok=${String(centre.ok)}; grab hit ${grab.desc} ok=${String(grab.ok)}`);
      expect(grab.ok, `handle grabbable near W52 at ${String(width)}`).toBe(true);
      const weekPx = num(await page.locator('[aria-valuetext$="pixels per week"]').first().getAttribute('aria-valuetext'));
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + weekPx * dxWeeks, sy, { steps: 6 });
      await page.waitForTimeout(200);
      if (!(await page.getByTestId('step-drag-label').isVisible())) {
        // A drag that changes no work week sends nothing and draws no ghost (by design).
        console.log(`${String(width)} ${where}: no label (no-op drag)`);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        continue;
      }
      measured += 1;
      const lt = (await page.getByTestId('step-drag-label').innerText()).replace(/\s+/g, ' ');
      console.log(`${String(width)} ${where}: "${lt}"`);
      // ADR 0032 consistency: "C wks on the calendar[, to WE] · W wks of work at f FTE" must have C = ceil(W / f),
      // and the ", to WE" suffix (P19-R03) appears exactly when the span runs past W52, with E = start + C - 1.
      // QA-P19-4 fixed in P19-R03: hard assertions (final gate).
      const m = /^(\d+) wks on the calendar(?:, to W(\d+))? · (\d+) wks of work at ([\d.]+) FTE/.exec(lt);
      if (m) {
        const want = Math.ceil(Math.round((Number(m[3]) * 100) / Number(m[4])) / 100);
        expect(Number(m[1]), `QA-P19-4 calendar weeks for "${lt}"`).toBe(want);
        const end = step.planned_start_week! + want - 1;
        if (end > 52) expect(m[2], `past-W52 suffix for "${lt}"`).toBe(String(end));
        else expect(m[2], `no suffix inside the axis for "${lt}"`).toBeUndefined();
      }
      await expectLabelInside(page, `W52 ${where} ${String(width)}`);
      if (where === 'right edge') {
        await axe(page, `gantt W52 drag light ${String(width)}`);
        await shot(page, `gantt-w52-${String(width)}`, false);
      }
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.waitForTimeout(300);
    }
    expect(measured, `labels measured near W52 at ${String(width)}`).toBeGreaterThanOrEqual(2);
  }
});

test('Gantt: Bob HubPlanner on a 0.5 FTE design step: drag label calendar vs work, PATCH sends work weeks; axe with tooltip and dialog', async ({ page, request }) => {
  test.setTimeout(300_000);
  const H = (email: string) => ({ 'X-Dev-User-Email': email, 'content-type': 'application/json' });
  // Disposable-DB setup: one PD-India leader to 0.5 FTE, then a synchronous greedy run.
  const before = await api<{ rows: GRow[] }>(request, 'hubPlanner', '/gantt?limit=500');
  const lead = before.rows.find((r) => r.hub === 'PD-India' && !r.frozen && r.steps.some((s) => s.kind === 'design' && s.timing_editable === 'move_resize' && (s.duration_weeks ?? 0) >= 4 && s.span_fte !== null))!;
  const engId = lead.leader_engineer_id!;
  const originalFte = Number((await api<{ fte: number | string }>(request, 'admin', `/engineers/${engId}`)).fte);
  console.log('leader', engId, 'original fte', originalFte);
  const p1 =await request.patch(`${BACKEND_URL}/engineers/${engId}`, { headers: H(DEV_EMAILS.admin), data: { fte: 0.5 } });
  expect(p1.status()).toBe(200);
  const rc = await request.post(`${BACKEND_URL}/schedule-runs/greedy-recalc`, { headers: H(DEV_EMAILS.admin) });
  console.log('recalc', rc.status(), (await rc.text()).slice(0, 200));
  expect(rc.status()).toBe(201);

  const g = await api<{ rows: GRow[] }>(request, 'hubPlanner', '/gantt?limit=500');
  const cands = g.rows.flatMap((r) => r.steps.map((s) => ({ r, s })))
    .filter(({ r, s }) => s.span_fte === 0.5 && s.kind === 'design' && (s.timing_editable === 'move_resize' || s.timing_editable === 'resize') && (s.planned_end_week ?? 99) <= 50 && !r.frozen)
    .sort((a, b) => (b.s.duration_weeks ?? 0) - (a.s.duration_weeks ?? 0));
  for (const c of cands) console.log('  cand', c.r.project_name.slice(0, 40), c.s.step_id, c.s.status, c.s.timing_editable, c.s.duration_weeks, c.s.planned_start_week, c.s.planned_end_week);
  console.log('0.5 FTE editable design steps', cands.length);
  expect(cands.length).toBeGreaterThan(0);
  const { r: proj, s: step } = cands[0]!;
  const span = step.planned_end_week! - step.planned_start_week! + 1;
  console.log('target', proj.project_name.slice(0, 50), proj.external_code, step.step_id, step.step_name, `W${String(step.planned_start_week)}-W${String(step.planned_end_week)}`, 'work', step.duration_weeks, 'span', span);
  if (step.status === 'Not Started') expect(span).toBe(Math.ceil(step.duration_weeks! / 0.5));

  const patches: unknown[] = [];
  page.on('request', (rq) => { if (rq.method() === 'PATCH' && rq.url().includes('/timing')) patches.push(rq.postDataJSON()); });
  let curSpan = span;
  let curStart = step.planned_start_week!;
  for (const width of [1440, 390, 1280]) {
    await setup(page, 'hubPlanner', width);
    await openProject(page, proj);
    // Timing dialog (keyboard path, all widths).
    const editBtn = page.getByRole('button', { name: `Edit timing for ${step.step_name} (${proj.project_name})` });
    await editBtn.focus();
    await page.keyboard.press('Enter');
    const dlg = page.getByTestId('step-timing-dialog');
    await expect(dlg).toBeVisible();
    const note = await dlg.getByTestId('step-timing-weeks-note').innerText();
    console.log(`dialog note ${String(width)}:`, note.replace(/\s+/g, ' '));
    expect(note).toContain('at 0.5 FTE');
    await expect(dlg.getByLabel(/Work \(weeks\)/)).toBeVisible();
    await axe(page, `gantt timing dialog light ${String(width)}`);
    await shot(page, `gantt-dialog-${String(width)}`, false);
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();

    const row = page.getByTestId('gantt-step-row').filter({ has: page.locator(`[data-testid="step-drag-handle"][title*="${step.step_name}"]`) }).first();
    const handle = row.getByTestId('step-drag-handle');
    await handle.scrollIntoViewIfNeeded();
    const vis = await timelineVisible(page);
    if (width === 390) {
      // QA-P19-2: narrow layout, the timeline is usable.
      await expect(page.getByTestId('gantt-scroll')).toHaveAttribute('data-layout', 'narrow');
      await expect(page.getByTestId('gantt-status-header')).toHaveCount(0);
      const leftW = (await page.getByTestId('gantt-left-header').boundingBox())!.width;
      console.log('390 layout: name column', leftW, 'visible timeline', JSON.stringify(vis));
      expect(leftW).toBeLessThanOrEqual(124);
      expect(vis.right - vis.left, 'visible timeline px at 390').toBeGreaterThanOrEqual(100);
      expect(await overflow(page), 'gantt overflow 390').toBeLessThanOrEqual(0);
    }
    await bringHandle(page, handle, width === 390 ? vis.left + 16 : vis.left + (vis.right - vis.left) / 3);
    const hb = (await handle.boundingBox())!;
    const sx = hb.x + hb.width / 2;
    const sy = hb.y + hb.height / 2;
    // Real hit-test (QA-P19-2): the point under the handle's centre is the handle, not a sticky column.
    const hit = await hitTest(page, sx, sy, '[data-testid="step-drag-handle"]');
    console.log(`${String(width)}: handle hit-test ->`, hit.desc, 'handle w', hb.width);
    expect(hit.ok, `handle hit-test ${String(width)}: ${hit.desc}`).toBe(true);
    if (width === 390) expect(hb.width).toBeGreaterThanOrEqual(19);
    const weekPx = num(await page.locator('[aria-valuetext$="pixels per week"]').first().getAttribute('aria-valuetext'));
    expect(weekPx).toBeGreaterThanOrEqual(16);
    const cal = curSpan + 2;
    const work = Math.max(1, Math.min(104, Math.floor(cal * 0.5)));
    const calWeeks = Math.ceil(work / 0.5);
    const calEnd = curStart + calWeeks - 1;
    const expectLabel = `${String(calWeeks)} wks on the calendar${calEnd > 52 ? `, to W${String(calEnd)}` : ''} · ${String(work)} wks of work at 0.5 FTE`;
    const label = page.getByTestId('step-drag-label');
    let touch: CDPSession | null = null;
    if (width === 390) {
      touch = await touchStart(page, sx, sy);
      await touchMove(touch, sx, sy, weekPx * 2);
    } else {
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + weekPx, sy, { steps: 4 });
      await page.mouse.move(sx + weekPx * 2, sy, { steps: 4 });
    }
    await expect(label).toBeVisible();
    const lt = (await label.innerText()).replace(/\s+/g, ' ');
    console.log(`drag label ${String(width)}: "${lt}" expected "${expectLabel}" weekPx ${weekPx.toFixed(1)}`);
    // QA-P19-4 fixed in P19-R03: the calendar figure is ceil(work / FTE), with ", to WE" past W52. Hard (final gate).
    expect(lt, `drag label ${String(width)}`).toBe(expectLabel);
    await expectLabelInside(page, `drag ${String(width)}`);
    await axe(page, `gantt drag tooltip light ${String(width)}`);
    await shot(page, `gantt-drag-${String(width)}`, false);
    expect(await overflow(page), `gantt overflow ${String(width)}`).toBeLessThanOrEqual(0);
    if (width === 1440) {
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.waitForTimeout(500);
      expect(patches, 'Escape cancels: nothing sent').toEqual([]);
      continue;
    }
    const k = patches.length;
    if (touch) await touchEnd(touch);
    else await page.mouse.up();
    await expect.poll(() => patches.length, { timeout: 10_000 }).toBe(k + 1);
    console.log(`PATCH body ${String(width)} (${touch ? 'touch' : 'mouse'})`, JSON.stringify(patches[k]));
    expect(patches[k]).toEqual({ duration_override_weeks: work });
    // The step-timing recalc runs on the solver worker (greedy, ~7 s here): wait for the new plan.
    const read = async () => (await api<{ rows: GRow[] }>(request, 'hubPlanner', `/gantt?limit=500`)).rows.find((x) => x.project_id === proj.project_id)!.steps.find((x) => x.step_id === step.step_id)!;
    await expect.poll(async () => { const c = await read(); return c.status !== 'Not Started' || c.planned_end_week! - c.planned_start_week! + 1 === Math.ceil(work / 0.5); }, { timeout: 60_000, intervals: [1000] }).toBe(true);
    const cur = await read();
    const stored = (cur as unknown as { duration_override_weeks: number | null }).duration_override_weeks;
    curSpan = cur.planned_end_week! - cur.planned_start_week! + 1;
    curStart = cur.planned_start_week!;
    console.log('stored override', stored, 'span_fte', cur.span_fte, 'new plan', cur.planned_start_week, cur.planned_end_week, 'span', curSpan);
    expect(stored).toBe(work);
    if (cur.status === 'Not Started') expect(curSpan).toBe(Math.ceil(work / 0.5));
  }
  // Restore the FTE (disposable DB anyway).
  if (originalFte !== 0.5) await request.patch(`${BACKEND_URL}/engineers/${engId}`, { headers: H(DEV_EMAILS.admin), data: { fte: originalFte } });
});
