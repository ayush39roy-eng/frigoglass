import { test, expect } from './fixtures';
import { actAs, checkAxe } from './dev-session';

/**
 * P9-T05 (qa-inspector) — Workflow Settings (`/settings/workflow`) and
 * User / Role Admin (`/admin/users`) against the live stack, plus axe on
 * every tab / the open dialog.
 */


test.describe('Workflow Settings (P9, ADR 0007-0009)', () => {
  test('Super Admin: every tab renders and is axe clean', async ({ page }) => {
    await actAs(page, 'superAdmin');
    await page.goto('/settings/workflow');
    await expect(page.getByRole('heading', { name: 'Workflow Settings', exact: true })).toBeVisible();
    await expect(page.getByTestId('read-only-notice')).toHaveCount(0);

    for (const tab of ['Steps & precedence', 'Lead times', 'Hub calendars', 'Chambers']) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(300);
      await checkAxe(page, `Workflow Settings tab: ${tab}`);
    }
  });

  test('Super Admin: lead-time edit saves, shows the stale banner, then reverts', async ({
    page,
  }) => {
    await actAs(page, 'superAdmin');
    await page.goto('/settings/workflow');
    await page.getByRole('tab', { name: 'Lead times' }).click();

    const cell = page.getByLabel('PDD A+ PDD-A weeks');
    await expect(cell).toHaveValue('1');
    await cell.fill('2');
    await page.getByRole('button', { name: 'Save 1 change' }).click();
    const banner = page.getByTestId('stale-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/\d+/);
    await checkAxe(page, 'Workflow Settings: stale banner after save');

    await cell.fill('1');
    await page.getByRole('button', { name: 'Save 1 change' }).click();
    await expect(cell).toHaveValue('1');
    for (const b of await page.getByRole('button', { name: /^Save \d+ change/ }).all()) await expect(b).toBeDisabled();
  });

  test('Admin: read-only with the notice, axe clean', async ({ page }) => {
    await actAs(page, 'admin');
    await page.goto('/settings/workflow');
    await expect(page.getByRole('heading', { name: 'Workflow Settings', exact: true })).toBeVisible();
    await expect(page.getByTestId('read-only-notice')).toBeVisible();
    await page.getByRole('tab', { name: 'Lead times' }).click();
    await expect(page.getByRole('button', { name: /^Save \d+ change/ })).toHaveCount(0);
    await checkAxe(page, 'Workflow Settings: Admin read-only');
  });
});

test.describe('User / Role Admin (P9, ADR 0010)', () => {
  test('Super Admin creates a user; table + dialog axe clean', async ({ page }) => {
    await actAs(page, 'superAdmin');
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: 'User / Role Admin', exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Users' })).toBeVisible();
    await checkAxe(page, 'User Admin: table (Super Admin)');

    await page.getByRole('button', { name: 'New user' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Create a user' })).toBeVisible();
    await checkAxe(page, 'User Admin: create dialog');

    const email = `qa.p9t05.${String(Date.now())}@example.com`;
    await dialog.getByLabel('Email').fill(email);
    await dialog.getByLabel('Full name').fill('QA Gate User');
    await dialog.getByRole('checkbox', { name: 'Executive Viewer' }).click();
    await dialog.getByRole('button', { name: 'Create user' }).click();
    await expect(dialog).toBeHidden();
    await page.getByLabel('Search users').fill('qa.p9t05');
    await expect(page.getByRole('table', { name: 'Users' }).getByText(email)).toBeVisible();
  });

  test('Admin cannot edit Admin / Super Admin accounts', async ({ page }) => {
    await actAs(page, 'admin');
    await page.goto('/admin/users');
    await expect(page.getByRole('table', { name: 'Users' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit sam.super@example.com' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Edit bob.hub@example.com' })).toBeEnabled();
    await checkAxe(page, 'User Admin: table (Admin)');
  });
});
