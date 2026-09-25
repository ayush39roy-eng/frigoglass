import type { Locator, Page } from '@playwright/test';

export class GanttPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/timeline');
  }

  heading() {
    return this.page.getByRole('heading', { name: 'Project Execution Timeline' });
  }

  firstFreezeButton(): Locator {
    return this.page.getByRole('button', { name: /^Freeze / }).first();
  }

  freezeDialog() {
    return this.page.getByRole('dialog');
  }

  recalcNeededNotice() {
    return this.page.getByText('Freeze state saved');
  }
}
