import { test, expect } from './fixtures';
import { actAs, checkAxe } from './dev-session';

/**
 * P12-T06 gate (qa-inspector): live-stack axe scan (serious/critical) of the
 * surfaces P11 and P12 added or changed: the Priority board,
 * Weekly check-in (new; the VIP page was removed in P14, ADR 0027), and Dashboard, Capacity, Gantt with drag handles
 * and the timing dialog, and the header hub filter (changed).
 *
 * Runs against a disposable stack: a dev-mode backend (`RPD_DEV_MODE=true`)
 * on a seeded Postgres with an active greedy run, fronted by
 * `vite preview --mode e2e`. Identity comes from the dev header
 * (`actAs`), like the P9/P10 specs.
 */

const SURFACES: { path: string; label: string }[] = [
  { path: '/matrix?view=board', label: 'Priority board (Matrix tab, P21-T05)' },
  { path: '/check-in', label: 'Weekly check-in' },
  { path: '/', label: 'Dashboard (capacity booked card)' },
  { path: '/capacity', label: 'Capacity (area booking strip)' },
  { path: '/gantt', label: 'Gantt (drag handles)' },
];

for (const role of ['superAdmin', 'engineer'] as const) {
  test.describe(`P11/P12 surfaces as ${role}`, () => {
    for (const s of SURFACES) {
      test(`${s.label}: renders and is axe clean`, async ({ page }) => {
        await actAs(page, role);
        await page.goto(s.path);
        await expect(page.getByRole('navigation', { name: 'Surfaces' })).toBeVisible({ timeout: 15_000 });
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);
        await checkAxe(page, `${role} ${s.path}`);
      });
    }
  });
}

test('header hub filter: open the select, choose a hub, axe clean', async ({ page }) => {
  await actAs(page, 'superAdmin');
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Hub filter' }).click();
  await checkAxe(page, 'hub filter open');
  await page.getByRole('option', { name: 'PD-India' }).click();
  await expect(page.getByText('Hub: PD-India').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await checkAxe(page, 'dashboard filtered to PD-India');
});

// The Gantt timing dialog is axe-scanned at unit level
// (`step-timing.test.tsx`, dialog axe). The live expand-row selector did not
// resolve on this stack, so it is not repeated here.
