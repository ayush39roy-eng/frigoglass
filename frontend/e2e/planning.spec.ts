import { test, expect, seriousAxeViolations, loginAs } from './fixtures';
import { PlanningPage } from './pages/planning.page';

/**
 * Capacity Planning surface (P4-T07) — CRUD/Apply-Logic scope only.
 * Auto-assign is deliberately unbuilt (blocked on `docs/OPEN_QUESTIONS.md`
 * #10) — this spec only asserts its placeholder is present, never that the
 * action itself works. Logged in as Admin throughout: Apply Logic's endpoint
 * (`POST /schedule-runs/greedy-recalc`) is gated `RoleName.ADMIN`-only per
 * `docs/MEMORY.md`'s P4-T07 review, and Admin also has full Engineer/Chamber
 * CRUD, so one role covers this surface's whole in-scope deliverable without
 * hitting the write-forbidden downgrade path.
 */
test.describe('Capacity Planning surface (P4-T07)', () => {
  test('Engineer CRUD, Chamber CRUD, and Apply Logic end-to-end', async ({ page }) => {
    await loginAs(page, 'admin');
    const planning = new PlanningPage(page);
    await planning.goto();
    await expect(planning.heading()).toBeVisible();

    // 1. Engineer CRUD — create (Engineers tab; P19-T04 made Overview the default).
    await planning.engineersTab().click();
    const engineerName = `E2E Engineer ${String(Date.now())}`;
    await planning.newEngineerButton().click();
    const engineerDialog = planning.formDialog();
    await expect(engineerDialog).toBeVisible();
    await engineerDialog.getByLabel('Name').fill(engineerName);
    await engineerDialog.getByLabel('Hub').click();
    await page.getByRole('option').first().click();
    await engineerDialog.getByRole('button', { name: 'Add engineer' }).click();
    await expect(engineerDialog).toBeHidden();

    const engineerRow = planning.engineerRowByName(engineerName);
    await expect(engineerRow).toBeVisible();

    // 2. Chamber CRUD — create (Chambers tab).
    await planning.chambersTab().click();
    const chamberCode = `E2E-${String(Date.now())}`;
    await planning.newChamberButton().click();
    const chamberDialog = planning.formDialog();
    await expect(chamberDialog).toBeVisible();
    await chamberDialog.getByLabel('Code').fill(chamberCode);
    await chamberDialog.getByLabel('Lab region').click();
    await page.getByRole('option').first().click();
    await chamberDialog.getByLabel('Max concurrent').fill('2');
    await chamberDialog.getByRole('button', { name: 'Add chamber' }).click();
    await expect(chamberDialog).toBeHidden();

    const chamberRow = planning.chamberRowByCode(chamberCode);
    await expect(chamberRow).toBeVisible();

    // 3. P19-T04: header buttons. Auto-assign stays a named placeholder
    // (OQ#10); Apply Logic (greedy recalc) actually runs from its dialog.
    await planning.autoAssignButton().click();
    await expect(planning.autoAssignPlaceholder()).toBeVisible();
    await page.keyboard.press('Escape');

    await planning.openApplyLogicButton().click();
    await expect(planning.applyLogicDialog()).toBeVisible();
    await planning.applyLogicButton().click();
    const confirmDialog = planning.confirmDialog();
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Apply Logic', exact: true }).click();
    await expect(confirmDialog).toBeHidden();

    await expect(page.getByText('Within year')).toBeVisible({ timeout: 15_000 });
  });

  test('has no serious/critical axe violations', async ({ page }) => {
    await loginAs(page, 'admin');
    await new PlanningPage(page).goto();
    await expect(page.getByRole('heading', { name: 'Capacity Planning' })).toBeVisible();
    const violations = await seriousAxeViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
