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

  utilizationPanel() {
    return this.page.getByRole('heading', { name: 'Resource utilization matrix' });
  }
}
