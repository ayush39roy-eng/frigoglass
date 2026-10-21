import { test, expect } from './fixtures';
import { actAs, apiGet, checkAxe } from './dev-session';

/**
 * P9-T05 (qa-inspector) — P9 changes on existing surfaces: Gantt completion
 * markers (I16 cross-check against the stored API values), Capacity supply
 * breakdown (ADR 0008), Registration P9 fields + OEM categories; axe on each.
 */

interface GanttRow {
  project_id: string;
  expected_end_week: number | null;
  projected_end_week: number | null;
}
interface GanttResponse {
  rows: GanttRow[];
}

test.describe('Gantt completion markers (P9, I16)', () => {
  test('marker weeks equal the stored API values; legend present; axe clean', async ({
    page,
    request,
  }) => {
    const api = await apiGet<GanttResponse>(request, 'superAdmin', '/gantt?limit=500');
    const expectedWeeks = new Set(
      api.rows.map((r) => r.expected_end_week).filter((w): w is number => w !== null),
    );
    const projectedWeeks = new Set(
      api.rows.map((r) => r.projected_end_week).filter((w): w is number => w !== null),
    );

    await actAs(page, 'superAdmin');
    await page.goto('/timeline');
    await expect(
      page.getByRole('heading', { name: 'Project Execution Timeline', exact: true }),
    ).toBeVisible();
    const markers = page.getByTestId('gantt-completion-markers');
    // P19/P20 gate: a group whose two weeks are both past W52 draws no line and
    // is legitimately invisible; after ADR 0032 the first row can be one of them.
    await expect(markers.filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText('Will be completed (active run + delay)')).toBeVisible();

    const expectedDom = await page
      .locator('[data-testid="gantt-marker-expected"]')
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-week'))));
    const projectedDom = await page
      .locator('[data-testid="gantt-marker-projected"]')
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-week'))));
    expect(expectedDom.length).toBeGreaterThan(0);
    for (const w of expectedDom) expect(expectedWeeks.has(w), `expected W${String(w)}`).toBe(true);
    for (const w of projectedDom) expect(projectedWeeks.has(w), `projected W${String(w)}`).toBe(true);

    await checkAxe(page, 'Gantt: completion markers');
  });
});

test.describe('Capacity supply breakdown (P9, ADR 0008)', () => {
  test('breakdown expands, horizon toggles; axe clean', async ({ page }) => {
    await actAs(page, 'superAdmin');
    await page.goto('/capacity');
    await expect(page.getByRole('heading', { name: 'RPD Capacity', exact: true })).toBeVisible();
    // P19: the per-hub detail lives in a Details dialog on the summary table.
    await page.getByRole('radio', { name: 'YTD 2026' }).click();
    // P19 gate: assert the toggle before the modal opens (the page behind a
    // modal dialog is aria-hidden, so the radio is not in the a11y tree then).
    await expect(page.getByRole('radio', { name: 'YTD 2026' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByRole('button', { name: /^Details for / }).first().click();
    const how = page.getByRole('dialog').getByText('How this is calculated');
    await expect(how).toBeVisible();
    await how.click();
    await page.waitForTimeout(300);
    await checkAxe(page, 'Capacity: breakdown expanded, remaining year');
  });
});

test.describe('Registration P9 fields (P9 contract §6)', () => {
  test('new fields present, OEM hub narrows categories; axe clean', async ({ page }) => {
    await actAs(page, 'superAdmin');
    // P22-T01: registration is a drawer on the Projects page.
    await page.goto('/projects');
    await expect(page.getByRole('heading', { level: 1, name: 'Projects', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Register project' }).first().click();
    const dialog = page.getByTestId('registration-drawer');
    await expect(dialog.getByLabel('Expected completion (week)')).toBeVisible();
    await expect(dialog.getByText('Certification testing required')).toBeVisible();
    await expect(dialog.getByLabel('Estimated design weeks')).toBeVisible();
    await expect(dialog.getByLabel('Estimated lab weeks')).toBeVisible();

    await dialog.locator('#reg-hub').click();
    await page.getByRole('option', { name: 'OEM-HCK' }).click();
    await dialog.locator('#reg-category').click();
    const options = await page.getByRole('option').allInnerTexts();
    expect(options).toEqual(expect.arrayContaining(['A-OEM', 'B-OEM', 'C-OEM']));
    expect(options).not.toContain('A+');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await page.waitForTimeout(500);

    await checkAxe(page, 'Projects: registration drawer, OEM hub');
  });
});
