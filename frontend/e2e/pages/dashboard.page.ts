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
    return this.page.getByRole('heading', { name: 'Completion outcome' });
  }

  statusOverviewSection() {
    return this.page.getByRole('heading', { name: 'Status overview' });
  }

  /** P17-R08: the pipeline summary table (the Hub × type bar chart is gone). */
  hubTypePipelineSection() {
    return this.page.getByRole('heading', { name: 'Project pipeline summary: Hub × Type' });
  }

  completingHubTypeSection() {
    return this.page.getByRole('heading', { name: 'Completing within year: Hub × Type' });
  }

  /** A clickable Hub × Type figure, by its aria-label ("View 3 New Model projects in PD-India"). */
  drillCell(name: string | RegExp) {
    return this.page.getByRole('button', { name });
  }

  drilldownDialog() {
    return this.page.getByTestId('hub-type-drilldown');
  }
}
