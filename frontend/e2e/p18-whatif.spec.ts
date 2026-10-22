import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import {
  askFixture,
  estimateFixture,
  INDIA_SCOPE,
  simulateFixture,
  solveFixture,
} from '../src/surfaces/planning/whatif/test-fixtures';

/**
 * P18-T03: the What-if planner on Capacity Planning, with every `/api/**` call
 * mocked (no backend, no shared dev stack). Run:
 *   pnpm exec playwright test -c playwright.p18.config.ts
 * Screenshots go to $P18_SHOTS when set.
 */

const KEYS = [
  'dashboard',
  'capacity',
  'matrix',
  'gantt',
  'project_workspace',
  'project_registration',
  'capacity_planning',
  'workflow_settings',
  'audit_log',
  'user_role_admin',
];

function me(role: 'pm' | 'hub'): unknown {
  return {
    user_id: 'u1',
    email: role === 'pm' ? 'alice.pm@example.com' : 'bob.hub@example.com',
    full_name: role === 'pm' ? 'Alice PM' : 'Bob Hub',
    roles: [role === 'pm' ? 'Portfolio Manager' : 'Hub Planner'],
    hub_scope_all: role === 'pm',
    hub_ids: role === 'pm' ? [] : ['hub-pd-india'],
    engineer_id: null,
    permissions: Object.fromEntries(KEYS.map((k) => [k, { read: true, write: role === 'hub' }])),
    dev_mode: false,
    is_delegate_manager: false,
    current_week: 42,
    weeks_left_in_year: 10,
  };
}

const HUBS = [
  { id: 'hub-pd-india', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'hub-rd-greece', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
];
const CHAMBERS = [
  {
    id: 'ch-1', code: 'IN-1', lab_region: 'India', max_concurrent: 2, platforms: 1, efficiency: 1,
    maintenance_weeks: 2, breakdown_weeks: 0, calibration_weeks: 1, working_weeks_per_chamber: 40,
    efficient_lab_weeks: 40, allowed_stages: ['PDD-F'], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
];

interface Mocks {
  estimate?: unknown;
  ask?: (route: Route) => Promise<void>;
  scope?: 'all' | 'india';
}

async function mockApi(page: Page, role: 'pm' | 'hub', mocks: Mocks = {}): Promise<{ whatifCalls: string[] }> {
  const whatifCalls: string[] = [];
  const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
    route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
  await page.route((u) => u.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    if (path === '/me') return json(route, me(role));
    if (path === '/hubs') return json(route, HUBS);
    if (path === '/chambers') return json(route, CHAMBERS);
    if (path === '/engineers') return json(route, []);
    if (path === '/schedule-runs/active') return json(route, { detail: 'none' }, 404);
    if (path.startsWith('/whatif/')) {
      whatifCalls.push(path);
      const scope = mocks.scope === 'india' ? INDIA_SCOPE : undefined;
      if (path === '/whatif/estimate') return json(route, mocks.estimate ?? estimateFixture(scope ? { scope } : {}));
      if (path === '/whatif/simulate') return json(route, simulateFixture(scope ? { scope } : {}));
      if (path === '/whatif/solve') {
        return json(
          route,
          solveFixture({
            met: false,
            met_attainable: true,
            unattainable_project_ids: ['whatif-p001-001'],
            unattainable_projects: [
              { project_id: 'whatif-p001-001', name: 'What-if project 1', hub: 'PD-India', category: 'A', unconstrained_end_week: 61 },
            ],
            semantics:
              'met: every project of the target finishes inside the planning year. met_attainable: every project that capacity can still help does. They differ when unattainable_project_ids is not empty.',
            ...(scope ? { scope } : {}),
          }),
        );
      }
      if (path === '/whatif/ask') {
        if (mocks.ask) return mocks.ask(route);
        return json(route, askFixture());
      }
    }
    if (path.startsWith('/notifications')) return json(route, path.endsWith('unread-count') ? { count: 0 } : []);
    return json(route, { detail: 'not mocked' }, 404);
  });
  return { whatifCalls };
}

async function openWhatIf(page: Page): Promise<void> {
  await page.goto('/planning');
  await page.getByRole('tab', { name: 'What-if planner' }).click();
  await expect(page.getByRole('heading', { name: 'Scenario builder' })).toBeVisible();
}

async function shot(page: Page, name: string, testId = 'whatif-planner'): Promise<void> {
  const dir = process.env.P18_SHOTS;
  // The shell scrolls inside its own container, so capture the element, not the page.
  if (dir) await page.getByTestId(testId).screenshot({ path: `${dir}/${name}.png` });
}

async function axe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  for (const v of bad) console.log(`AXE ${label}`, v.id, v.impact, JSON.stringify(v.nodes.slice(0, 3).map((n) => n.target)));
  expect(bad.map((v) => v.id), `axe serious/critical on ${label}`).toEqual([]);
}

/** Dark mode: D1 (primary token contrast on filled primary buttons) is a known pre-existing
 *  defect and is not fixed here; every OTHER serious/critical node must be clean. */
async function axeDarkExceptD1(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const offenders: string[] = [];
  for (const v of results.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
    for (const n of v.nodes) {
      const isPrimaryButton = v.id === 'color-contrast' && n.target.join(' ').includes('bg-primary-hover');
      if (!isPrimaryButton) offenders.push(`${v.id}: ${n.html.slice(0, 140)}`);
    }
  }
  console.log(`AXE ${label} non-D1 offenders:`, offenders.length, offenders.slice(0, 5));
  expect(offenders, `axe (excluding D1) on ${label}`).toEqual([]);
}

async function fillProject(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add project line' }).click();
  const g = page.getByRole('group', { name: /Added projects, line 1/ });
  await g.getByLabel('Hub').selectOption('PD-India');
  await g.getByLabel('Count').fill('5');
  await page.getByRole('button', { name: 'Add chamber line' }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('rpd-theme', 'light'));
});

test('Portfolio Manager: build, estimate, simulate, solve (unattainable), axe light', async ({ page }) => {
  const { whatifCalls } = await mockApi(page, 'pm');
  await openWhatIf(page);
  await shot(page, '01-empty');
  await fillProject(page);
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByTestId('est-designers')).toContainText('3 more');
  await expect(page.getByTestId('est-design-row')).toContainText('68.18 %');
  await page.getByText('How this was calculated').click();
  await shot(page, '02-estimate', 'whatif-results');
  await axe(page, 'estimate light');

  await page.getByRole('button', { name: 'Simulate' }).click();
  await expect(page.getByTestId('sim-within-year')).toContainText('120 → 117');
  await shot(page, '03-simulate', 'whatif-results');
  await axe(page, 'simulate light');

  await page.getByRole('button', { name: 'Find fewest additions' }).click();
  await expect(page.getByTestId('solve-unattainable')).toContainText('Cannot finish within the year whatever you add');
  await expect(page.getByTestId('solve-outcome')).toContainText('Everything that capacity can help finishes inside the year');
  await shot(page, '04-solve', 'whatif-results');
  await axe(page, 'solve light');
  expect(whatifCalls).toEqual(['/whatif/estimate', '/whatif/simulate', '/whatif/solve']);
});

test('Hub Planner: scoped response renders as served', async ({ page }) => {
  await mockApi(page, 'hub', { scope: 'india' });
  await openWhatIf(page);
  await fillProject(page);
  await page.getByRole('button', { name: 'Simulate' }).click();
  await expect(page.getByTestId('whatif-scope')).toContainText('Showing your hubs only (PD-India)');
  await shot(page, '05-hub-planner');
});

test('Chat: answer, edit in builder, then 429 countdown, then 503 not configured', async ({ page }) => {
  let calls = 0;
  await mockApi(page, 'pm', {
    ask: async (route) => {
      calls += 1;
      if (calls === 1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(askFixture()) });
      }
      if (calls === 2) {
        return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'Retry-After': '3' }, body: JSON.stringify({ detail: 'slow down' }) });
      }
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'AGENT_UNAVAILABLE' }) });
    },
  });
  await openWhatIf(page);
  await page.getByRole('button', { name: /^If we add 5 PDD\/A projects/ }).click();
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByTestId('chat-answer-text')).toContainText('3 more designers');
  await shot(page, '06-chat', 'whatif-chat');
  await axe(page, 'chat light');
  await page.getByRole('button', { name: 'Edit in builder' }).click();
  await expect(page.getByRole('group', { name: /Added projects, line 1/ }).getByLabel('Count')).toHaveValue('5');

  await page.getByLabel('Your question').fill('again');
  await page.getByRole('button', { name: 'Ask' }).click();
  const notice = page.getByTestId('whatif-error');
  await expect(notice).toContainText('try again in 3 s');
  await expect(notice.getByRole('button', { name: 'Retry this question' })).toBeDisabled();
  await expect(notice.getByRole('button', { name: 'Retry this question' })).toBeEnabled({ timeout: 6_000 });
  await notice.getByRole('button', { name: 'Retry this question' }).click();
  await expect(page.getByTestId('chat-unavailable')).toContainText('Chat is not configured; use the forms.');
  await expect(page.getByLabel('Your question')).toHaveCount(0);
  // The forms keep working.
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByTestId('whatif-estimate')).toBeVisible();
});

test('dark mode and narrow viewport have no serious axe violations', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('rpd-theme', 'dark'));
  await mockApi(page, 'pm');
  await page.setViewportSize({ width: 390, height: 844 });
  await openWhatIf(page);
  await fillProject(page);
  await page.getByRole('button', { name: 'Estimate' }).click();
  await expect(page.getByTestId('whatif-estimate')).toBeVisible();
  await shot(page, '07-mobile-dark');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('horizontal overflow px at 390:', overflow);
  await axeDarkExceptD1(page, 'estimate dark 390');
});


/** P18-R03: six hubs as the server lists them (OEM-HCK first), PD-India touched. */
function sixHubEstimate(): unknown {
  const base = estimateFixture();
  const d0 = base.design[0];
  const l0 = base.lab[0];
  if (!d0 || !l0) throw new Error('fixture');
  const hubs = ['OEM-HCK', 'OEM-Seitek', 'PD-India', 'PD-Romania', 'R&D-Greece', 'R&D-India'];
  const regions = ['Greece', 'India', 'Romania'];
  return {
    ...base,
    touched_hubs: ['PD-India'],
    touched_lab_regions: ['India'],
    design: hubs.map((hub) => ({ ...d0, hub, min_extra_designers: hub === 'PD-India' ? 3 : hub === 'OEM-HCK' ? 1 : 0 })),
    lab: regions.map((lab_region) => ({ ...l0, lab_region, min_extra_chambers: lab_region === 'India' ? 1 : 0 })),
  };
}

for (const width of [390, 1440]) {
  test(`What-if tables scroll inside their own region and touched rows come first at ${String(width)} px`, async ({ page }) => {
    await mockApi(page, 'pm', { estimate: sixHubEstimate() });
    // Tall viewport: the shell scrolls inside its own container, so a tall page shows the whole panel.
    await page.setViewportSize({ width, height: 6000 });
    await openWhatIf(page);
    await fillProject(page);
    await page.getByRole('button', { name: 'Estimate' }).click();
    await expect(page.getByTestId('whatif-estimate')).toBeVisible();

    const rows = page.getByTestId('est-design-row');
    await expect(rows.first()).toContainText('PD-India');
    await expect(rows.first()).toHaveAttribute('data-touched', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-touched', 'false');
    await expect(page.getByTestId('est-touched-list')).toContainText('Hubs: PD-India. Lab regions: India.');

    const regions = page.locator('[data-testid="whatif-estimate"] div[role="region"]');
    const n = await regions.count();
    expect(n).toBeGreaterThanOrEqual(2);
    const widths: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const r = regions.nth(i);
      await expect(r).toHaveAttribute('tabindex', '0');
      await expect(r).toHaveAttribute('aria-label', /.+/);
      const m = await r.evaluate((el) => ({
        sw: el.scrollWidth,
        cw: el.clientWidth,
        overflowX: getComputedStyle(el).overflowX,
        right: el.getBoundingClientRect().right,
      }));
      widths.push(`${String(m.sw)}/${String(m.cw)}`);
      expect(['auto', 'scroll']).toContain(m.overflowX);
      expect(m.right).toBeLessThanOrEqual(width + 1);
      if (m.sw > m.cw) {
        // Scrollable: reach the last column and prove it is reachable.
        await r.evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
        });
        expect(await r.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        await r.evaluate((el) => {
          el.scrollLeft = 0;
        });
      }
    }
    console.log(`regions scrollWidth/clientWidth at ${String(width)}:`, widths.join(' '));
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(pageOverflow).toBeLessThanOrEqual(0);

    const dir = process.env.P18_SHOTS;
    if (dir) {
      await page.screenshot({ path: `${dir}/r03-estimate-${String(width)}-full.png`, fullPage: true });
      // The scroll container's content: widen each region to its content width for one capture.
      const first = regions.first();
      await first.evaluate((el) => {
        el.style.width = `${String(el.scrollWidth)}px`;
        el.style.maxWidth = 'none';
      });
      await first.screenshot({ path: `${dir}/r03-estimate-${String(width)}-design-table-content.png` });
    }
    await axe(page, `estimate light ${String(width)}`);

    await page.getByRole('button', { name: 'Simulate' }).click();
    await expect(page.getByTestId('sim-within-year')).toContainText('120 → 117');
    await axe(page, `simulate light ${String(width)}`);
    await page.getByRole('button', { name: 'Find fewest additions' }).click();
    await expect(page.getByTestId('solve-exact')).toBeVisible();
    await axe(page, `solve light ${String(width)}`);
    if (dir) await page.screenshot({ path: `${dir}/r03-solve-${String(width)}-full.png`, fullPage: true });
  });
}

test('chat egress hint is visible, and the totals message appears before submit', async ({ page }) => {
  await mockApi(page, 'pm');
  await openWhatIf(page);
  await expect(page.getByTestId('chat-egress-hint')).toContainText('Do not type names, customers or prices');
  await page.getByRole('button', { name: 'Add chamber line' }).click();
  await page.getByRole('button', { name: 'Add chamber line' }).click();
  const g1 = page.getByRole('group', { name: /Added chambers, line 1/ });
  const g2 = page.getByRole('group', { name: /Added chambers, line 2/ });
  await g1.getByLabel('Count').fill('12');
  await g2.getByLabel('Count').fill('12');
  await expect(page.getByTestId('whatif-cap-chambers')).toContainText('Total 24 of 20 chambers added: over the limit.');
  await expect(page.getByRole('alert').filter({ hasText: 'At most 20 chambers added' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simulate' })).toBeDisabled();
  await axe(page, 'over-cap light');
});
