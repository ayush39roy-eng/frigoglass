import type { Page } from '@playwright/test';

export class CapacityPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/capacity');
  }

  heading() {
    return this.page.getByRole('heading', { name: 'RPD Capacity' });
  }

  hubLoadPanel() {
    return this.page.getByRole('heading', { name: 'Load vs. capacity per hub' });
  }

  classBreakdownPanel() {
    return this.page.getByRole('heading', { name: 'Class breakdown — deliverable vs. left out' });
  }

  /** P19: the chamber matrix is collapsed by default; open it, then its heading is visible. */
  async openChamberUtilization(): Promise<void> {
    await this.page.getByRole('button', { name: 'Show chamber utilization' }).click();
  }

  utilizationPanel() {
    return this.page.getByRole('heading', { name: 'Resource utilization matrix' });
  }

  /** P19: engineer utilization is collapsed and only fetched once opened (audited per read). */
  async openEngineerUtilization(): Promise<void> {
    await this.page.getByRole('button', { name: 'Show engineer utilization' }).click();
  }

  /** P19: open one hub's Details dialog from the summary table. */
  async openHubDetails(hub: string) {
    await this.page.getByRole('button', { name: `Details for ${hub}` }).click();
    return this.page.getByRole('dialog');
  }
}
