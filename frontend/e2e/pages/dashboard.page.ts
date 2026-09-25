import type { Page } from '@playwright/test';

export class DashboardPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  heading() {
    return this.page.getByRole('heading', { name: 'Global RPD Dashboard' });
  }

  withinYearSection() {
    return this.page.getByRole('heading', { name: 'Completing within the year' });
  }

  pipelineSection() {
    return this.page.getByRole('heading', { name: 'Pipeline & completion' });
  }

  statusOverviewSection() {
    return this.page.getByRole('heading', { name: 'Status overview' });
  }

  hubTypePipelineSection() {
    return this.page.getByRole('heading', { name: 'Hub × type pipeline' });
  }
}
