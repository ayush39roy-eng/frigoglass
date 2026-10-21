import { test, expect } from './fixtures';
import { actAs, checkAxe } from './dev-session';
import type { Page } from '@playwright/test';

/** P16 gate (qa-inspector): Matrix/dialog/Workspace labels and weights, heatmap footnote, names on Gantt. Read-only. */
const WS = '15706752-e038-530d-b371-5f80c341054d';

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Surfaces' })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

test('Matrix labels, weights, total line, points, edit dialog', async ({ page }) => {
  await actAs(page, 'admin');
  await page.goto('/matrix');
  await settle(page);
  await page.getByRole('button', { name: 'Detailed view' }).click();
  await page.getByRole('button', { name: 'Show rubric' }).click();
  const body = page.locator('body');
  await expect(body).toContainText('Gross Profitability');
  await expect(body).toContainText('ROI');
  await expect(body).toContainText('Investment & Feasibility');
  await expect(page.getByTestId('scoring-total-line')).toContainText('Total: 100 (scaled from 295)');
  await expect(body).toContainText(/Score 1 gives 1\/5 of the weight/);
  await expect(body).not.toContainText('Gross Margins');
  for (const n of ['3-Year Volume', 'CAPEX Investment', 'ROI', 'Gross Profitability']) {
    const row = page.getByRole('row').filter({ hasText: n }).last();
    console.log('rubric', n, JSON.stringify((await row.innerText()).replace(/\s+/g, ' ')));
  }
  console.log('cell sample', JSON.stringify(await page.getByTestId('score-cell').first().innerText()));
  await checkAxe(page, 'matrix p16');
  await page.getByRole('button', { name: /Edit prioritization score for/ }).first().click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  const t = await dlg.innerText();
  console.log('dialog', JSON.stringify(t.slice(0, 400)));
  expect(t).toContain('Gross Profitability');
  expect(t).toContain('ROI');
  expect(t.toLowerCase()).toContain('investment & feasibility');
  expect(t).not.toContain('Gross Margins');
  const { seriousAxeViolations } = await import('./fixtures');
  for (const v of await seriousAxeViolations(page)) console.log('AXE', v.id, JSON.stringify(v.nodes.slice(0, 3).map((n) => [n.target, n.any[0]?.message])));
  await checkAxe(page, 'matrix edit dialog p16');
});

test('Workspace scoring section: labels, pillars, edit form', async ({ page }) => {
  await actAs(page, 'admin');
  await page.goto(`/projects/${WS}`);
  await settle(page);
  const sec = page.getByTestId('scoring-section');
  await sec.scrollIntoViewIfNeeded();
  await sec.getByRole('button', { name: /Edit scores|Score this project/ }).click();
  const t = await sec.innerText();
  console.log('scoring text', JSON.stringify(t.slice(0, 1500)));
  expect(t).toContain('Gross Profitability');
  expect(t).toContain('ROI');
  expect(t).not.toContain('Gross Margins');
  await checkAxe(page, 'workspace p16');
});

test('Capacity heatmap footnote visible; Gantt shows engineer names', async ({ page }) => {
  await actAs(page, 'admin');
  await page.goto('/capacity');
  await settle(page);
  await page.getByRole('button', { name: 'Show engineer utilization' }).click();
  const fn = page.getByTestId('engineer-heatmap-footnote');
  await fn.scrollIntoViewIfNeeded();
  await expect(fn).toBeVisible();
  console.log('footnote', await fn.innerText());
  await page.goto('/gantt');
  await settle(page);
  const txt = await page.locator('body').innerText();
  expect(txt).not.toMatch(/Withheld|Name unavailable/);
});
