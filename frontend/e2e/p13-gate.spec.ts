import { test, expect } from './fixtures';
import { actAs, checkAxe } from './dev-session';

/**
 * P13-T20 gate (qa-inspector): live-stack axe scan (serious/critical) of the
 * surfaces P13 added or changed (ADR 0025, API_CONTRACT_P13 §4–§7):
 * Dashboard (country segmented buttons, region chips, analytics, register),
 * Capacity (priority split, matrix, class cards), Matrix (toolbar, Detailed
 * view, FX editor), Priority board (toolbar, hub load strip), Gantt (toolbar,
 * weekly band, Forest view), Workflow Settings (Timeline previews),
 * Registration (search), Capacity Planning (grouping), and the new
 * Versions & History and Downloads pages, plus the header country/hub select.
 *
 * Same harness as `p12-gate.spec.ts`: a dev-mode backend on a seeded Postgres
 * with an active greedy run, identity from the dev header (`actAs`).
 */

const SURFACES: { path: string; label: string }[] = [
  { path: '/', label: 'Dashboard' },
  { path: '/capacity', label: 'Capacity' },
  { path: '/matrix', label: 'Matrix' },
  { path: '/priority-board', label: 'Priority board' },
  { path: '/timeline', label: 'Gantt' },
  { path: '/settings/workflow', label: 'Workflow settings' },
  { path: '/register', label: 'Registration' },
  { path: '/planning', label: 'Capacity planning' },
  { path: '/history', label: 'Versions & History' },
  { path: '/downloads', label: 'Downloads' },
];

async function settle(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Surfaces' })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
}

for (const role of ['superAdmin', 'hubPlanner'] as const) {
  test.describe(`P13 surfaces as ${role}`, () => {
    for (const s of SURFACES) {
      test(`${s.label}: renders and is axe clean`, async ({ page }) => {
        await actAs(page, role);
        await page.goto(s.path);
        await settle(page);
        await checkAxe(page, `${role} ${s.path}`);
      });
    }
  });
}

test('Dashboard: choose India, the register, axe clean', async ({ page }) => {
  await actAs(page, 'superAdmin');
  await page.goto('/');
  await settle(page);
  await page.getByRole('radiogroup', { name: 'Country filter' }).getByRole('radio', { name: /India/ }).click();
  await expect(page.getByText('Country: India').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.locator('#all-projects').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await checkAxe(page, 'dashboard country India');
});

test('header select open (countries + hubs), axe clean', async ({ page }) => {
  await actAs(page, 'superAdmin');
  await page.goto('/capacity');
  await settle(page);
  await page.getByRole('combobox', { name: 'Hub filter' }).click();
  await checkAxe(page, 'header select open');
  await page.getByRole('option', { name: 'Romania' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await checkAxe(page, 'capacity country Romania');
});

test('Matrix: Detailed view + USD shows the Admin FX editor, axe clean', async ({ page }) => {
  await actAs(page, 'superAdmin');
  await page.goto('/matrix');
  await settle(page);
  await page.getByRole('button', { name: 'Detailed view' }).click();
  await page.getByRole('radio', { name: 'USD' }).click();
  await expect(page.getByTestId('fx-rate-editor')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await checkAxe(page, 'matrix detailed USD');
});

test('Gantt: Forest view, axe clean', async ({ page }) => {
  await actAs(page, 'superAdmin');
  await page.goto('/timeline');
  await settle(page);
  await page.getByRole('button', { name: /Forest view/ }).click();
  await page.waitForTimeout(400);
  await checkAxe(page, 'gantt forest');
});

test('Workflow settings: Timeline previews tab, axe clean', async ({ page }) => {
  await actAs(page, 'superAdmin');
  await page.goto('/settings/workflow');
  await settle(page);
  await page.getByRole('tab', { name: 'Timeline previews' }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await checkAxe(page, 'workflow timeline previews');
});
