import type { Locator, Page } from '@playwright/test';

export class PlanningPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/planning');
  }

  heading() {
    return this.page.getByRole('heading', { name: 'Capacity Planning' });
  }

  engineersTab() {
    return this.page.getByRole('tab', { name: 'Engineers' });
  }

  chambersTab() {
    return this.page.getByRole('tab', { name: 'Chambers' });
  }

  overviewTab() {
    return this.page.getByRole('tab', { name: 'Overview' });
  }

  /** P19-T04: header button opening the Apply Logic panel in a dialog. */
  openApplyLogicButton() {
    return this.page.getByRole('button', { name: 'Apply logic', exact: true });
  }

  applyLogicDialog() {
    return this.page.getByRole('dialog', { name: 'Apply logic' });
  }

  /** P19-T04: header button opening the Auto-assign (OQ #10) notice. */
  autoAssignButton() {
    return this.page.getByRole('button', { name: 'Auto-assign projects' });
  }

  basisToggle(name: 'YTD 2026' | 'Full year') {
    return this.page.getByTestId('planning-toolbar').getByRole('radio', { name });
  }

  unitToggle(name: 'Weeks' | 'Days') {
    return this.page.getByTestId('planning-toolbar').getByRole('radio', { name });
  }

  hubCard(hub: string): Locator {
    return this.page.getByTestId(`hub-card-${hub}`);
  }

  labCard(region: string): Locator {
    return this.page.getByTestId(`lab-card-${region}`);
  }

  totalsHeadlines(): Locator {
    return this.page.getByTestId('total-headline');
  }

  resourceLoadSection(): Locator {
    return this.page.getByTestId('resource-load');
  }

  newEngineerButton() {
    return this.page.getByRole('button', { name: 'New engineer' });
  }

  newChamberButton() {
    return this.page.getByRole('button', { name: 'New chamber' });
  }

  formDialog() {
    return this.page.getByRole('dialog');
  }

  engineerRowByName(name: string): Locator {
    return this.page.getByRole('row').filter({ hasText: name });
  }

  chamberRowByCode(code: string): Locator {
    return this.page.getByRole('row').filter({ hasText: code });
  }

  /** The panel's own action, inside `applyLogicDialog()`. */
  applyLogicButton() {
    return this.applyLogicDialog().getByRole('button', { name: 'Apply Logic', exact: true });
  }

  confirmDialog() {
    return this.page.getByRole('dialog', { name: /whole portfolio/ });
  }

  autoAssignPlaceholder() {
    return this.page.getByText('Auto-assign is pending a client decision');
  }
}
