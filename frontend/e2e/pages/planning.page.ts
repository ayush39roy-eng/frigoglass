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

  applyLogicTab() {
    return this.page.getByRole('tab', { name: 'Apply Logic & Auto-assign' });
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

  applyLogicButton() {
    return this.page.getByRole('button', { name: 'Apply Logic', exact: true });
  }

  confirmDialog() {
    return this.page.getByRole('dialog');
  }

  autoAssignPlaceholder() {
    return this.page.getByText('Auto-assign is pending a client decision');
  }
}
