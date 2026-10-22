import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { actAs, apiGet, BACKEND_URL, DEV_EMAILS } from './dev-session';

/**
 * P18 re-gate (qa-inspector), live against a disposable stack (seeded client_2026 --schedule).
 * Run: RPD_P18_MATCH='p18-regate\.spec\.ts' RPD_E2E_BACKEND_URL=... RPD_E2E_BASE_URL=...
 *      pnpm exec playwright test -c playwright.p18qa.config.ts
 * Covers the P18-R01..R03 remediation: Dashboard-consistent within-year, estimate "before" == Capacity,
 * touched-only headline totals and badges, caps (form and API), in-flight 429, chat unavailable and hint,
 * 390 px tables, axe, keyboard-only.
 */

const SHOTS = process.env.RPD_P18_SHOTS;
const PM = DEV_EMAILS.portfolioManager;

type Json = Record<string, unknown>;

async function post(request: APIRequestContext, path: string, body: unknown, email = PM) {
  return request.post(`${BACKEND_URL}${path}`, {
    headers: { 'X-Dev-User-Email': email, 'content-type': 'application/json' },
    data: body,
  });
}

async function openWhatIf(page: Page): Promise<void> {
  await page.goto('/planning');
  await page.getByRole('tab', { name: 'What-if planner' }).click();
  await expect(page.getByRole('heading', { name: 'Scenario builder' })).toBeVisible();
}

async function axeScan(page: Page, label: string, dark = false): Promise<string[]> {
  const res = await new AxeBuilder({ page }).analyze();
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const lines = bad.map((v) => `${v.id}(${String(v.impact)}) x${String(v.nodes.length)} ${v.nodes[0]?.target.join(' ') ?? ''}`);
  console.log(`AXE ${dark ? 'dark' : 'light'} ${label}: ${String(bad.length)} serious/critical`, lines.join(' || '));
  return lines;
}

async function addProjectLine(page: Page, n: number, hub: string, category: string, count: string): Promise<void> {
  await page.getByRole('button', { name: 'Add project line' }).click();
  const g = page.getByRole('group', { name: new RegExp(`Added projects, line ${String(n)}`) });
  await g.getByLabel('Hub').selectOption(hub);
  await g.getByLabel('Category').selectOption(category);
  await g.getByLabel('Count').fill(count);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('rpd-theme', 'light'));
  await actAs(page, 'portfolioManager');
});

test('API: zero simulate within-year equals Dashboard; estimate before equals Capacity (both bases)', async ({ request }) => {
  const dash = await apiGet<{ within_year_count: number }>(request, 'portfolioManager', '/dashboard/completing-within-year');
  const sim = (await (await post(request, '/whatif/simulate', { scenario: {} })).json()) as { diff: Record<string, number> };
  console.log('dashboard within_year_count', dash.within_year_count, 'simulate diff', sim.diff.within_year_before, '->', sim.diff.within_year_after);
  expect(sim.diff.within_year_before).toBe(dash.within_year_count);
  expect(sim.diff.within_year_after).toBe(dash.within_year_count);

  const hubLoad = await apiGet<{ rows: Json[] }>(request, 'portfolioManager', '/capacity/hub-load');
  let compared = 0;
  let maxDiff = 0;
  for (const basis of ['year', 'remaining'] as const) {
    const est = (await (await post(request, '/whatif/estimate', { scenario: {}, basis })).json()) as {
      design: { hub: string; booked_pct_before: number | null }[];
      lab: { lab_region: string; booked_pct_before: number | null }[];
    };
    for (const d of est.design) {
      const row = hubLoad.rows.find((r) => r.hub === d.hub)!;
      const cap = row[`design_booked_pct_${basis}`] as number;
      maxDiff = Math.max(maxDiff, Math.abs((d.booked_pct_before ?? 0) - cap));
      expect(d.booked_pct_before, `${basis} design ${d.hub}`).toBeCloseTo(cap, 1);
      compared++;
    }
    for (const l of est.lab) {
      const row = hubLoad.rows.find((r) => r.lab_region === l.lab_region)!;
      const cap = row[`lab_booked_pct_${basis}`] as number;
      maxDiff = Math.max(maxDiff, Math.abs((l.booked_pct_before ?? 0) - cap));
      expect(l.booked_pct_before, `${basis} lab ${l.lab_region}`).toBeCloseTo(cap, 1);
      compared++;
    }
  }
  console.log('estimate before vs hub-load: compared', compared, 'figures, max abs diff', maxDiff);
});

test('API: +10 A at R&D-India headline = touched only; oversize scenarios are 422 (all endpoints); ask without key is 503', async ({ request }) => {
  const est = (await (await post(request, '/whatif/estimate', {
    scenario: { add_projects: [{ hub: 'R&D-India', category: 'A', count: 10 }] },
  })).json()) as Json;
  console.log('estimate +10 A R&D-India', JSON.stringify({ t: est.touched_hubs, l: est.touched_lab_regions, d: est.min_extra_designers_total, c: est.min_extra_chambers_total, dw: est.extra_design_weeks_total, lw: est.extra_lab_weeks_total }));
  expect(est.touched_hubs).toEqual(['R&D-India']);
  expect(est.touched_lab_regions).toEqual(['India']);
  // Final gate (P21–P26): the figures depend on the seed. The pre-P24 seed gave 0 designers / 3 chambers; the real
  // roster (ADR 0035, R&D-India booked ~150 %) needs designers too. Check the shape and that the totals equal the
  // per-hub / per-region rows instead of pinning seed figures.
  const dTot = est.min_extra_designers_total as number;
  const cTot = est.min_extra_chambers_total as number;
  expect(Number.isInteger(dTot) && dTot >= 0).toBe(true);
  expect(Number.isInteger(cTot) && cTot >= 0).toBe(true);
  // Headline totals are over the touched hubs / regions only (P18-R01).
  const sumOf = (xs: unknown, k: string, key: string, touched: unknown): number | null =>
    Array.isArray(xs)
      ? (xs as Json[]).filter((r) => (touched as string[]).includes(r[key] as string)).reduce((a, r) => a + Number(r[k] ?? 0), 0)
      : null;
  const dRows = sumOf(est.design, 'min_extra_designers', 'hub', est.touched_hubs);
  const cRows = sumOf(est.lab, 'min_extra_chambers', 'lab_region', est.touched_lab_regions);
  console.log('designer rows sum', dRows, 'chamber rows sum', cRows);
  if (dRows !== null) expect(dRows).toBe(dTot);
  if (cRows !== null) expect(cRows).toBe(cTot);

  const proj = (n: number) => ({ hub: 'PD-India', category: 'C', count: n });
  const oversize: [string, Json][] = [
    ['201 projects (100+101)', { add_projects: [proj(100), proj(101)] }],
    ['51 designers', { add_engineers: [{ hub: 'PD-India', count: 26 }, { hub: 'PD-Romania', count: 25 }] }],
    ['21 chambers', { add_chambers: [{ lab_region: 'India', count: 11 }, { lab_region: 'Greece', count: 10 }] }],
    ['51 removed designers', { remove_engineer_counts: [{ hub: 'PD-India', count: 26 }, { hub: 'PD-Romania', count: 25 }] }],
    ['per-line 501 projects', { add_projects: [proj(501)] }],
  ];
  for (const ep of ['estimate', 'simulate', 'solve']) {
    for (const [label, scenario] of oversize) {
      const res = await post(request, `/whatif/${ep}`, { scenario });
      const body = await res.text();
      console.log(`422 check ${ep} ${label}: ${String(res.status())} ${body.slice(0, 90)}`);
      expect(res.status(), `${ep} ${label}`).toBe(422);
    }
  }
  // exactly at the cap is accepted
  const ok = await post(request, '/whatif/estimate', { scenario: { add_projects: [proj(100), proj(100)] } });
  expect(ok.status()).toBe(200);

  const ask = await post(request, '/whatif/ask', { question: 'what if we add 5 projects?' });
  console.log('/whatif/ask without key', ask.status(), await ask.text());
  expect(ask.status()).toBe(503);
});

test('UI 1440: simulate zero 107 -> 107 = Dashboard; touched labelling and headline; no overflow', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dash = await apiGet<{ within_year_count: number }>(request, 'portfolioManager', '/dashboard/completing-within-year');
  // The form refuses an empty scenario by design ('Add at least one change'), so the zero scenario is sent by
  // rewriting the body of a one-line request; the response is the real server answer rendered by the real UI.
  await page.route('**/whatif/*', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    const body = JSON.parse(req.postData() ?? '{}') as Json;
    if (process.env.RPD_KEEP_SCENARIO) return route.continue();
    body.scenario = {};
    return route.continue({ postData: JSON.stringify(body) });
  });
  await openWhatIf(page);
  await addProjectLine(page, 1, 'PD-India', 'C', '1');
  await page.getByRole('button', { name: 'Simulate' }).click();
  const wy = page.getByTestId('sim-within-year');
  await expect(wy).toContainText(`${String(dash.within_year_count)} → ${String(dash.within_year_count)}`);
  console.log('UI simulate zero:', (await wy.innerText()).replace(/\s+/g, ' '));
  await expect(page.getByTestId('sim-outcomes-note')).toBeVisible();

  // Dashboard in the same session shows the same figure
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Global RPD Dashboard' })).toBeVisible();
  await expect(page.locator('body')).toContainText(String(dash.within_year_count));

  await openWhatIf(page);
  await addProjectLine(page, 1, 'PD-India', 'C', '1');
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByTestId('whatif-estimate')).toBeVisible();
  await expect(page.getByTestId('est-touched-none')).toBeVisible();
  await expect(page.getByTestId('est-designers')).toContainText('0');
  // estimate before vs Capacity, UI vs API for the first design row
  const hubLoad = await apiGet<{ rows: Json[] }>(request, 'portfolioManager', '/capacity/hub-load');
  const rows = page.getByTestId('est-design-row');
  const n = await rows.count();
  let matched = 0;
  for (let i = 0; i < n; i++) {
    const txt = (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
    const hub = (await rows.nth(i).locator('td, th').first().innerText()).split('\n')[0]!.trim();
    const cap = hubLoad.rows.find((r) => r.hub === hub);
    if (!cap) continue;
    const m = /(\d+(?:\.\d+)?) %/.exec(txt);
    expect(Number(m?.[1]), `design row ${hub} booked % (UI) vs Capacity`).toBeCloseTo(cap.design_booked_pct_year as number, 1);
    matched++;
  }
  console.log('UI estimate zero: design rows matched to Capacity booked %:', matched, 'of', n);
  // Every design row the UI shows matched the Capacity figure (6 hubs before P24; OEM-Seltek has no engineers in
  // the real roster, ADR 0035, so the count follows the served rows).
  expect(n).toBeGreaterThan(0);
  expect(matched).toBe(n);

  // +10 PDD/A at R&D-India (real scenario from here on: stop rewriting)
  await page.unroute('**/whatif/*');
  await page.getByRole('group', { name: /Added projects, line 1/ }).getByLabel('Hub').selectOption('R&D-India');
  await page.getByRole('group', { name: /Added projects, line 1/ }).getByLabel('Category').selectOption('A');
  await page.getByRole('group', { name: /Added projects, line 1/ }).getByLabel('Count').fill('10');
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByTestId('est-touched-list')).toContainText('Hubs: R&D-India. Lab regions: India.');
  // Final gate: compare the UI headline with the served estimate for the same scenario (seed-independent).
  const served = (await (await post(request, '/whatif/estimate', {
    scenario: { add_projects: [{ hub: 'R&D-India', category: 'A', count: 10 }] },
  })).json()) as Json;
  await expect(page.getByTestId('est-designers')).toContainText(String(served.min_extra_designers_total));
  await expect(page.getByTestId('est-chambers')).toContainText(String(served.min_extra_chambers_total));
  console.log('UI headline designers:', (await page.getByTestId('est-designers').innerText()).replace(/\s+/g, ' '),
    '| chambers:', (await page.getByTestId('est-chambers').innerText()).replace(/\s+/g, ' '));
  const first = page.getByTestId('est-design-row').first();
  await expect(first).toContainText('R&D-India');
  await expect(first).toHaveAttribute('data-touched', 'true');
  await expect(first.getByTestId('est-touched-mark')).toBeVisible();
  const flags = await page.getByTestId('est-design-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-touched')));
  const labFlags = await page.getByTestId('est-lab-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-touched')));
  console.log('design rows touched flags (display order)', flags.join(','), '| lab', labFlags.join(','));
  expect(flags).toEqual(['true', ...Array<string>(flags.length - 1).fill('false')]);
  expect(labFlags).toEqual(['true', ...Array<string>(labFlags.length - 1).fill('false')]);
  await expect(page.getByTestId('est-touched-mark')).toHaveCount(2);
  await shot(page, 'regate-estimate-1440');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});

test('UI: oversized scenario is blocked in the form before submit', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/whatif/')) posts.push(r.url()); });
  await openWhatIf(page);
  await addProjectLine(page, 1, 'PD-India', 'C', '120');
  await page.getByRole('button', { name: 'Add project line' }).click();
  const g2 = page.getByRole('group', { name: /Added projects, line 2/ });
  await g2.getByLabel('Hub').selectOption('PD-Romania');
  await g2.getByLabel('Category').selectOption('C');
  await g2.getByLabel('Count').fill('100');
  const cap = page.getByTestId('whatif-cap-projects');
  await expect(cap).toContainText('over the limit');
  console.log('over-cap text:', (await cap.innerText()).replace(/\s+/g, ' '));
  for (const name of ['Estimate', 'Simulate', 'Find fewest additions']) {
    await expect(page.getByRole('button', { name })).toBeDisabled();
  }
  await page.getByRole('button', { name: 'Estimate' }).click({ force: true, trial: false }).catch(() => undefined);
  await page.waitForTimeout(400);
  console.log('POSTs after forced click on disabled Estimate:', posts.length);
  expect(posts).toHaveLength(0);
  await shot(page, 'regate-overcap-1440');
  const bad = await axeScan(page, 'over-cap message 1440');
  expect(bad).toEqual([]);
  // fix it
  await g2.getByLabel('Count').fill('80');
  await expect(page.getByRole('button', { name: 'Estimate' })).toBeEnabled();
});

test('UI: double-click Run sends one request; a concurrent heavy job gives 429 with countdown, then recovers', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sims: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/whatif/simulate')) sims.push(r.url()); });
  await openWhatIf(page);
  await addProjectLine(page, 1, 'PD-India', 'C', '25');
  await page.getByRole('button', { name: 'Simulate' }).dblclick();
  await expect(page.getByTestId('whatif-simulate')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  console.log('simulate POSTs after dblclick:', sims.length);
  expect(sims).toHaveLength(1);

  // second case: another heavy job of the SAME user is in flight (solve of 25 PDD/C P1 ~ 4 s)
  // P19/P20 gate: after ADR 0032 a 25-project solve ends in ~0.7 s, so the
  // 300 ms window raced; 80 projects take ~1.4 s on the disposable stack.
  const heavy = post(request, '/whatif/solve', {
    scenario: { add_projects: [{ hub: 'PD-India', category: 'C', count: 80, priority: 'P1' }] },
  });
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Estimate' }).click();
  const err = page.getByTestId('whatif-error');
  await expect(err).toBeVisible({ timeout: 10_000 });
  const text = (await err.innerText()).replace(/\s+/g, ' ');
  console.log('429 notice:', text);
  await expect(err).toContainText(/still running|try again/i);
  await shot(page, 'regate-429-1440');
  const bad = await axeScan(page, '429 notice 1440');
  expect(bad).toEqual([]);
  const res = await heavy;
  console.log('heavy solve status', res.status());
  expect(res.status()).toBe(200);
  // after the heavy job ends the retry works
  const retry = err.getByRole('button', { name: /Retry/ });
  if (await retry.count()) await expect(retry).toBeEnabled({ timeout: 8_000 });
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByTestId('whatif-estimate')).toBeVisible({ timeout: 20_000 });
});

test('UI: chat hint visible; no key gives 503 and the fixed message; axe light for every state at 1440 and 390', async ({ page }) => {
  const results: Record<string, string[]> = {};
  for (const w of [1440, 390] as const) {
    await page.setViewportSize({ width: w, height: w === 390 ? 900 : 1000 });
    await openWhatIf(page);
    const hint = page.getByTestId('chat-egress-hint');
    await expect(hint).toBeVisible();
    console.log(`chat hint @${String(w)}:`, (await hint.innerText()).replace(/\s+/g, ' '));
    await expect(hint).toContainText(/Do not type names/);
    await addProjectLine(page, 1, 'R&D-India', 'A', '10');
    await page.getByRole('button', { name: 'Estimate' }).click();
    await expect(page.getByTestId('whatif-estimate')).toBeVisible();
    results[`estimate ${String(w)}`] = await axeScan(page, `estimate ${String(w)}`);
    await shot(page, `regate-estimate-${String(w)}`);
    await page.getByRole('button', { name: 'Simulate' }).click();
    await expect(page.getByTestId('whatif-simulate')).toBeVisible();
    results[`simulate ${String(w)}`] = await axeScan(page, `simulate ${String(w)}`);
    await page.getByRole('button', { name: 'Find fewest additions' }).click();
    await expect(page.getByTestId('whatif-solve')).toBeVisible({ timeout: 30_000 });
    results[`solve ${String(w)}`] = await axeScan(page, `solve ${String(w)}`);
    // chat without key
    const q = page.getByLabel('Your question');
    await q.fill('If we add 5 A projects in R&D-India, what happens?');
    await page.getByRole('button', { name: 'Ask' }).click();
    const un = page.getByTestId('chat-unavailable');
    await expect(un).toBeVisible({ timeout: 15_000 });
    await expect(un).toContainText('Chat is not configured; use the forms.');
    console.log(`chat unavailable @${String(w)}:`, (await un.innerText()).replace(/\s+/g, ' '));
    results[`chat-unavailable ${String(w)}`] = await axeScan(page, `chat-unavailable ${String(w)}`);
    await shot(page, `regate-chat-unavailable-${String(w)}`);
    // over-cap
    await page.getByRole('group', { name: /Added projects, line 1/ }).getByLabel('Count').fill('250');
    await expect(page.getByTestId('whatif-cap-projects')).toContainText('over the limit');
    results[`over-cap ${String(w)}`] = await axeScan(page, `over-cap ${String(w)}`);
  }
  // Dashboard
  for (const w of [1440, 390] as const) {
    await page.setViewportSize({ width: w, height: 1000 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Global RPD Dashboard' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);
    results[`dashboard ${String(w)}`] = await axeScan(page, `dashboard ${String(w)}`);
  }
  const all = Object.entries(results).flatMap(([k, v]) => v.map((x) => `${k}: ${x}`));
  expect(all).toEqual([]);
});

test('UI 390: What-if tables scroll horizontally, no page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1400 });
  await openWhatIf(page);
  await addProjectLine(page, 1, 'R&D-India', 'A', '10');
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByTestId('whatif-estimate')).toBeVisible();
  await page.getByRole('button', { name: 'Simulate' }).click();
  await expect(page.getByTestId('whatif-simulate')).toBeVisible();
  const regions = page.getByRole('region').filter({ has: page.locator('table') });
  const n = await regions.count();
  const info: string[] = [];
  let scrollable = 0;
  for (let i = 0; i < n; i++) {
    const r = regions.nth(i);
    const m = await r.evaluate((el) => ({
      label: el.getAttribute('aria-label') ?? '', tab: el.getAttribute('tabindex'),
      sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX,
    }));
    info.push(`${m.label}: ${String(m.sw)}/${String(m.cw)} overflow-x=${m.ox} tabindex=${String(m.tab)}`);
    if (m.sw > m.cw) {
      scrollable++;
      expect(['auto', 'scroll']).toContain(m.ox);
      expect(m.tab, `${m.label} keyboard reachable`).toBe('0');
      const moved = await r.evaluate((el) => { el.scrollLeft = el.scrollWidth; return el.scrollLeft; });
      expect(moved, `${m.label} scrolls`).toBeGreaterThan(0);
      expect(m.label.length, 'has accessible label').toBeGreaterThan(0);
    }
  }
  console.log('390 table regions:', n, '\n' + info.join('\n'));
  expect(scrollable).toBeGreaterThanOrEqual(2);
  const ov = await page.evaluate(() => {
    const d = document.documentElement;
    const offenders: string[] = [];
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1) {
        // skip anything inside a horizontally scrollable container
        let p = el.parentElement; let inScroller = false;
        while (p) { const ox = getComputedStyle(p).overflowX; if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden') && p.clientWidth <= window.innerWidth) { inScroller = true; break; } p = p.parentElement; }
        if (!inScroller) offenders.push(`${el.tagName}.${String((el as HTMLElement).className).slice(0, 40)}`);
      }
    });
    return { doc: d.scrollWidth - d.clientWidth, body: document.body.scrollWidth - document.body.clientWidth, offenders: offenders.slice(0, 5) };
  });
  console.log('390 overflow', JSON.stringify(ov));
  expect(ov.doc).toBe(0);
  expect(ov.offenders).toEqual([]);
  await shot(page, 'regate-whatif-390-tall');
});

test('keyboard only: tab order, visible focus, Run via Enter on the What-if tab', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/whatif/')) posts.push(r.url().split('/whatif/')[1] ?? ''); });
  await page.goto('/planning');
  await expect(page.getByRole('tab', { name: 'What-if planner' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  const stops: { name: string; visible: boolean; y: number }[] = [];
  async function describeFocus() {
    return page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const shadow = cs.boxShadow !== 'none' && cs.boxShadow !== '';
      const label = el.getAttribute('aria-label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null) ?? el.textContent ?? '';
      const r = el.getBoundingClientRect();
      return { name: `${el.tagName.toLowerCase()}[${el.getAttribute('role') ?? ''}] ${label.trim().slice(0, 40)}`, visible: outline || shadow, y: Math.round(r.top) };
    });
  }
  async function tabUntil(pred: (n: string) => boolean, max = 80): Promise<boolean> {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      const d = await describeFocus();
      if (d) { stops.push(d); if (pred(d.name)) return true; }
    }
    return false;
  }
  // The page tabs are one roving-tabindex tab stop (WAI-ARIA tabs): Tab reaches the tablist, arrows move within it.
  const reachedTabs = await tabUntil((n) => /\[tab\]/.test(n), 60);
  console.log('tab presses before the page tablist (sidebar + header, no skip link):', stops.length);
  expect(reachedTabs).toBe(true);
  let onWhatIf = false;
  for (let i = 0; i < 6 && !onWhatIf; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300); // Radix roving focus moves focus in a timeout
    const d = await describeFocus();
    if (d) { stops.push(d); onWhatIf = /What-if planner/.test(d.name); }
  }
  console.log('tablist stops:', stops.slice(-6).map((x) => x.name).join(' > '));
  expect(onWhatIf).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Scenario builder' })).toBeVisible();
  expect(await tabUntil((n) => /Add project line/.test(n))).toBe(true);
  await page.keyboard.press('Enter');
  const group = page.getByRole('group', { name: /Added projects, line 1/ });
  await expect(group).toBeVisible();
  expect(await tabUntil((n) => /^select/.test(n) && /Hub/.test(n))).toBe(true);
  await page.keyboard.type('R&D-I');
  expect(await tabUntil((n) => /Count/.test(n))).toBe(true);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('10');
  // Hub select got the typed value; category defaults may need A
  const hubVal = await group.getByLabel('Hub').inputValue();
  console.log('keyboard-selected hub:', hubVal);
  expect(hubVal).toBe('R&D-India');
  expect(await tabUntil((n) => /Estimate/.test(n))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('whatif-estimate')).toBeVisible({ timeout: 20_000 });
  expect(await tabUntil((n) => /Simulate/.test(n), 40)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('whatif-simulate')).toBeVisible({ timeout: 30_000 });
  console.log('tab stops:', stops.map((s) => `${s.name}${s.visible ? '' : ' [NO FOCUS RING]'}`).join(' > '));
  console.log('whatif POSTs by keyboard:', posts.join(','));
  const hidden = stops.filter((s) => !s.visible);
  expect(hidden.map((s) => s.name), 'stops without a visible focus indicator').toEqual([]);
  expect(posts).toEqual(expect.arrayContaining(['estimate', 'simulate']));
  // the scroll regions of the result tables are focusable and ringed
  const regionFocus = await page.getByRole('region', { name: /Design capacity by hub/ }).count();
  console.log('design capacity region present:', regionFocus);
});

test.describe('dark (report only)', () => {
  test('axe dark on Dashboard and What-if', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('rpd-theme', 'dark'));
    for (const w of [1440, 390] as const) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Global RPD Dashboard' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1200);
      await axeScan(page, `dashboard ${String(w)}`, true);
      await openWhatIf(page);
      await addProjectLine(page, 1, 'R&D-India', 'A', '10');
      await page.getByRole('button', { name: 'Estimate' }).click();
      await expect(page.getByTestId('whatif-estimate')).toBeVisible();
      await axeScan(page, `what-if estimate ${String(w)}`, true);
    }
  });
});
