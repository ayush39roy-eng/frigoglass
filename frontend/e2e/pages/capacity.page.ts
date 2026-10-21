import type { Page } from '@playwright/test';

export class CapacityPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/capacity');
  }

  heading() {
    return this.page.getByRole('heading', { name: 'RPD Capacity' });
  }

  /** P19-T06 renamed the merged table "Load vs. capacity by hub". */
  hubLoadPanel() {
    return this.page.getByRole('heading', { name: 'Load vs. capacity by hub' });
  }

  classBreakdownPanel() {
    return this.page.getByRole('heading', { name: 'Class breakdown — deliverable vs. left out' });
  }

  /** P19-T07: the class chart and the chamber utilization matrix were removed (owner);
   *  these locate them so specs can assert they stay gone. */
  removedDisclosures() {
    return this.page.getByRole('button', { name: /^(Show|Hide) (class chart|chamber utilization)$/ });
  }

  removedChamberMatrix() {
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
