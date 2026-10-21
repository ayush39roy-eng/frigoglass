import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { PlanningPage } from './pages/planning.page';

/**
 * P19-T04: Capacity Planning Overview (client parity) and Resource load
 * analytics, with every `/api/**` call mocked (the P19-T03 fields are not on
 * the shared dev API until it restarts). Run:
 *   pnpm exec playwright test -c playwright.p19planning.config.ts
 * Screenshots go to $P19_SHOTS when set. Names are synthetic.
 */

const KEYS = [
  'dashboard', 'capacity', 'matrix', 'gantt', 'project_workspace', 'project_registration',
  'capacity_planning', 'workflow_settings', 'audit_log', 'user_role_admin',
];

type Role = 'pm' | 'admin';

function me(role: Role): unknown {
  return {
    user_id: 'u1',
    email: role === 'pm' ? 'alice.pm@example.com' : 'frank.admin@example.com',
    full_name: role === 'pm' ? 'Alice PortfolioManager' : 'Frank Admin',
    roles: [role === 'pm' ? 'Portfolio Manager' : 'Admin'],
    hub_scope_all: true,
    hub_ids: [],
    engineer_id: null,
    permissions: Object.fromEntries(KEYS.map((k) => [k, { read: true, write: role === 'admin' }])),
    dev_mode: false,
    is_delegate_manager: false,
    current_week: 42,
    weeks_left_in_year: 10,
  };
}

const HUBS = [
  { id: 'h-grc', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
  { id: 'h-rdi', name: 'R&D-India', lab_region: 'India', is_oem: false },
  { id: 'h-pdi', name: 'PD-India', lab_region: 'India', is_oem: false },
  { id: 'h-pdr', name: 'PD-Romania', lab_region: 'Romania', is_oem: false },
  { id: 'h-hck', name: 'OEM-HCK', lab_region: 'Greece', is_oem: true },
  { id: 'h-sel', name: 'OEM-Seltek', lab_region: 'Greece', is_oem: true },
];
const WPW: Record<string, number> = { Greece: 5, India: 6, Romania: 5 };
const NAMES = [
  'Aris', 'Nikos', 'Eleni', 'Kostas', 'Lokesh', 'Priya', 'Rahul', 'Sanjay', 'Anita', 'Vikram',
  'Deepak', 'Meera', 'Ioana', 'Mihai', 'Andrei', 'Elena', 'Radu', 'Sofia', 'Yannis', 'Dimitra', 'Arjun', 'Kavya',
];
const r2 = (n: number) => Math.round(n * 100) / 100;

const ENGINEERS = NAMES.map((name, i) => {
  const hub = HUBS[i % HUBS.length]!;
  const fte = [1, 0.8, 0.5, 1, 0.6][i % 5]!;
  const wks = r2(44 * fte);
  const rem = r2(9.3 * fte);
  const d = WPW[hub.lab_region]!;
  return {
    id: `e${String(i)}`, name, hub_id: hub.id, fte,
    allowed_categories: hub.is_oem ? ['OEM', 'A-OEM', 'B-OEM'] : (['A+', 'A', 'B', 'C'].slice(0, 2 + (i % 3)) as string[]),
    user_id: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    weekdays_per_week: d,
    capacity_weeks: { year: wks, remaining: rem },
    capacity_days: { year: r2(wks * d), remaining: r2(rem * d) },
  };
});

const CH_SPEC: [string, 'Greece' | 'India' | 'Romania', number, number, string[]][] = [
  ['GR-CH1', 'Greece', 1, 0.21, ['PDD-F', 'PDD-H', 'OEM-E', 'OEM-H']],
  ['GR-CH2', 'Greece', 2, 0.18, ['PDD-F', 'OEM-E']],
  ['IN-CH1', 'India', 1, 1, ['PDD-F', 'PDD-H']],
  ['IN-CH2', 'India', 4, 0.9, ['PDD-F']],
  ['IN-CH3', 'India', 2, 0.9, ['PDD-F', 'PDD-H']],
  ['IN-CH4', 'India', 1, 0.75, []],
  ['RO-CH1', 'Romania', 1, 0.08, ['PDD-F', 'PDD-H']],
  ['RO-CH2', 'Romania', 4, 0.07, ['PDD-F']],
  ['RO-CH3', 'Romania', 2, 0.07, ['PDD-F', 'PDD-H']],
  ['RO-CH4', 'Romania', 1, 0.08, ['PDD-F', 'PDD-H']],
];
const CHAMBERS = CH_SPEC.map(([code, region, platforms, efficiency, stages], i) => {
  const ww = region === 'India' ? 45.83 : region === 'Greece' ? 38.6 : 43.4;
  const wks = r2(ww * platforms * efficiency);
  const rem = r2(wks * 10 / 52);
  const d = WPW[region]!;
  return {
    id: `c${String(i)}`, code, lab_region: region, max_concurrent: platforms, platforms, efficiency,
    maintenance_weeks: 2, breakdown_weeks: 0, calibration_weeks: 1, working_weeks_per_chamber: ww,
    efficient_lab_weeks: wks, allowed_stages: stages, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    weekdays_per_week: d, working_weeks: ww,
    capacity_weeks: { year: wks, remaining: rem },
    capacity_days: { year: r2(wks * d), remaining: r2(rem * d) },
  };
});

function sumPair(rows: { capacity_weeks: { year: number; remaining: number } }[], key: 'capacity_weeks'): { year: number; remaining: number };
function sumPair(rows: { capacity_days: { year: number; remaining: number } }[], key: 'capacity_days'): { year: number; remaining: number };
function sumPair(rows: Record<string, { year: number; remaining: number }>[], key: string) {
  return { year: r2(rows.reduce((s, r) => s + r[key]!.year, 0)), remaining: r2(rows.reduce((s, r) => s + r[key]!.remaining, 0)) };
}

function summary(): unknown {
  const dt = sumPair(ENGINEERS, 'capacity_weeks');
  const hubs = HUBS.map((h) => {
    const rows = ENGINEERS.filter((e) => e.hub_id === h.id);
    const w = sumPair(rows, 'capacity_weeks');
    return {
      hub: h.name, engineer_count: rows.length, fte_total: r2(rows.reduce((s, e) => s + e.fte, 0)),
      weekdays_per_week: WPW[h.lab_region], capacity_weeks: w, capacity_days: sumPair(rows, 'capacity_days'),
      share_pct: { year: r2((w.year / dt.year) * 100), remaining: r2((w.remaining / dt.remaining) * 100) },
    };
  });
  const lt = sumPair(CHAMBERS, 'capacity_weeks');
  const regions = (['Greece', 'India', 'Romania'] as const).map((region) => {
    const rows = CHAMBERS.filter((c) => c.lab_region === region);
    const w = sumPair(rows, 'capacity_weeks');
    return {
      lab_region: region, chamber_count: rows.length, weekdays_per_week: WPW[region],
      capacity_weeks: w, capacity_days: sumPair(rows, 'capacity_days'),
      share_pct: { year: r2((w.year / lt.year) * 100), remaining: r2((w.remaining / lt.remaining) * 100) },
    };
  });
  return {
    current_week: 42,
    design: { hubs, total: { engineer_count: ENGINEERS.length, fte_total: r2(ENGINEERS.reduce((s, e) => s + e.fte, 0)), capacity_weeks: dt, capacity_days: sumPair(ENGINEERS, 'capacity_days') } },
    lab: { regions, total: { chamber_count: CHAMBERS.length, capacity_weeks: lt, capacity_days: sumPair(CHAMBERS, 'capacity_days') } },
  };
}

function resourceLoad(basis: 'year' | 'remaining'): unknown {
  const engineers = ENGINEERS.map((e, i) => {
    const cap = e.capacity_weeks[basis];
    const load = r2(cap * [0.4, 0.9, 1.25, 0.7, 1.05][i % 5]!);
    const hub = HUBS.find((h) => h.id === e.hub_id)!;
    return {
      engineer_id: e.id, name: e.name, hub: hub.name, weekdays_per_week: e.weekdays_per_week, capacity_weeks: cap, load_weeks: load,
      utilization_pct: r2((load / cap) * 100), capacity_days: e.capacity_days[basis], load_days: r2(load * e.weekdays_per_week),
    };
  });
  const chambers = CHAMBERS.map((c, i) => {
    const cap = c.capacity_weeks[basis];
    const load = r2(cap * [0.5, 1.1, 0.8][i % 3]!);
    return {
      chamber_id: c.id, code: c.code, lab_region: c.lab_region, weekdays_per_week: c.weekdays_per_week, capacity_weeks: cap, load_weeks: load,
      utilization_pct: cap > 0 ? r2((load / cap) * 100) : null, capacity_days: c.capacity_days[basis], load_days: r2(load * c.weekdays_per_week),
    };
  });
  const tot = (rows: { capacity_weeks: number; load_weeks: number; capacity_days: number; load_days: number }[]) => {
    const cw = r2(rows.reduce((s, r) => s + r.capacity_weeks, 0));
    const lw = r2(rows.reduce((s, r) => s + r.load_weeks, 0));
    return { capacity_weeks: cw, load_weeks: lw, utilization_pct: r2((lw / cw) * 100), capacity_days: r2(rows.reduce((s, r) => s + r.capacity_days, 0)), load_days: r2(rows.reduce((s, r) => s + r.load_days, 0)) };
  };
  return {
    has_active_schedule_run: true, schedule_run_version: 12, current_week: 42, basis,
    engineers, chambers, totals: { engineers: tot(engineers), chambers: tot(chambers) },
    filters_applied: { hub_id: null, region: null, project_type: [], project_status: [], requesting_department: [], category: [], engineer_id: [], basis },
  };
}

const OPTIONS = {
  hubs: HUBS.map((h) => h.name), lab_regions: ['Greece', 'India', 'Romania'],
  project_types: ['NM', 'CO', 'RC', 'NO', 'IMP'], project_statuses: ['In Buyoff', 'In Development', 'In Queue'],
  categories: ['A+', 'A', 'B', 'C', 'A-OEM', 'B-OEM', 'C-OEM'], requesting_departments: [], requesting_department_available: false,
  engineers: ENGINEERS.map((e) => ({ engineer_id: e.id, name: e.name, hub: HUBS.find((h) => h.id === e.hub_id)!.name })),
};

const TEMPLATES = [
  { id: 'OEM-E', workflow_id: 'OEM', code: 'POC', name: 'Proof of Concept', kind: 'lab', base_weeks: 3 },
  { id: 'OEM-H', workflow_id: 'OEM', code: 'CERT', name: 'Certification Testing & Compliance', kind: 'lab', base_weeks: 3 },
  { id: 'PDD-E', workflow_id: 'PDD', code: 'DES', name: 'Design', kind: 'design', base_weeks: 3 },
  { id: 'PDD-F', workflow_id: 'PDD', code: 'POC', name: 'Proof of Concept', kind: 'lab', base_weeks: 3 },
  { id: 'PDD-H', workflow_id: 'PDD', code: 'CERT', name: 'Certification Testing & Compliance', kind: 'lab', base_weeks: 3 },
];

interface Calls {
  resourceLoad: string[];
  patches: { path: string; body: unknown }[];
}

async function mockApi(page: Page, role: Role): Promise<Calls> {
  const calls: Calls = { resourceLoad: [], patches: [] };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route((u) => u.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = route.request().method();
    if (path === '/me') return json(route, me(role));
    if (path === '/hubs') return json(route, HUBS);
    if (path === '/workflow-step-templates') return json(route, TEMPLATES);
    if (method === 'PATCH' && (path.startsWith('/engineers/') || path.startsWith('/chambers/'))) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.patches.push({ path, body });
      const list = path.startsWith('/engineers/') ? ENGINEERS : CHAMBERS;
      const row = list.find((r) => path.endsWith(`/${r.id}`))!;
      return json(route, { ...row, ...body });
    }
    if (path === '/engineers') return json(route, ENGINEERS);
    if (path === '/chambers') return json(route, CHAMBERS);
    if (path === '/planning/capacity-summary') return json(route, summary());
    if (path === '/planning/resource-load/options') return json(route, OPTIONS);
    if (path === '/planning/resource-load') {
      calls.resourceLoad.push(url.search);
      return json(route, resourceLoad((url.searchParams.get('basis') as 'year' | 'remaining' | null) ?? 'remaining'));
    }
    if (path === '/schedule-runs/active') return json(route, { detail: 'none' }, 404);
    if (path.startsWith('/notifications')) return json(route, path.endsWith('unread-count') ? { count: 0 } : []);
    return json(route, { detail: 'not mocked' }, 404);
  });
  return calls;
}

async function serious(page: Page): Promise<string[]> {
  const res = await new AxeBuilder({ page }).analyze();
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} x${String(v.nodes.length)} ${v.nodes[0]?.target.join(' ') ?? ''}`);
}

const SHOTS = process.env.P19_SHOTS;
/** Tall viewports are for full-page screenshots only (the shell scrolls inside its own container). */
const HEIGHT = Number(process.env.P19_HEIGHT ?? '900');

for (const width of [1440, 1280, 390]) {
  test(`Overview at ${String(width)} px: order, fit, axe, lazy resource load (admin)`, async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('rpd-theme', 'light'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: HEIGHT });
    const calls = await mockApi(page, 'admin');
    const planning = new PlanningPage(page);
    await planning.goto();
    await expect(planning.hubCard('R&D-Greece')).toBeVisible();
    await expect(planning.labCard('Greece').getByText('GR-CH1')).toBeVisible();

    // Not fetched until the analytics section is near the viewport.
    if (HEIGHT <= 900) expect(calls.resourceLoad).toEqual([]);

    // No page-level horizontal overflow; at 1280+ no card table scrolls.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (width >= 1280) {
      const scrolling = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="hub-card-"] [role="region"], [data-testid^="lab-card-"] [role="region"]')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.getAttribute('aria-label')),
      );
      expect(scrolling).toEqual([]);
    }

    expect(await serious(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/overview-${String(width)}.png`, fullPage: true });

    await planning.resourceLoadSection().scrollIntoViewIfNeeded();
    await expect(planning.resourceLoadSection().getByText('Aris (R&D-Greece)')).toBeVisible();
    expect(calls.resourceLoad.length).toBeGreaterThanOrEqual(1);
    expect(calls.resourceLoad[0]).toBe('?basis=remaining');
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow2).toBeLessThanOrEqual(0);
    expect(await serious(page)).toEqual([]);
    if (SHOTS) {
      await planning.resourceLoadSection().screenshot({ path: `${SHOTS}/resource-load-${String(width)}.png` });
      await page.screenshot({ path: `${SHOTS}/overview-full-${String(width)}.png`, fullPage: true });
    }
  });
}

test('chips are keyboard toggles that PATCH the existing endpoints; toggles switch basis and unit', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls = await mockApi(page, 'admin');
  const planning = new PlanningPage(page);
  await planning.goto();
  const chip = page.getByRole('button', { name: 'Allow category C for Aris' });
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => calls.patches.length).toBe(1);
  expect(calls.patches[0]).toEqual({ path: '/engineers/e0', body: { allowed_categories: ['A+', 'A', 'C'] } });

  const stage = page.getByRole('button', { name: 'Allow stage PDD-H Certification for GR-CH2' });
  await stage.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => calls.patches.length).toBe(2);
  expect(calls.patches[1]).toEqual({ path: '/chambers/c1', body: { allowed_stages: ['PDD-F', 'PDD-H', 'OEM-E'] } });

  const before = await planning.totalsHeadlines().first().textContent();
  await planning.basisToggle('Full year').click();
  await expect(planning.totalsHeadlines().first()).not.toHaveText(before ?? '');
  await planning.unitToggle('Days').click();
  await expect(planning.totalsHeadlines().first()).toContainText('man-days');
});

test('read-only role (Portfolio Manager): static values, no editable controls, axe clean', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('rpd-theme', 'light'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, 'pm');
  const planning = new PlanningPage(page);
  await planning.goto();
  await expect(planning.hubCard('R&D-Greece')).toBeVisible();
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Allow / })).toHaveCount(0);
  expect(await serious(page)).toEqual([]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/overview-readonly-1440.png`, fullPage: true });
});
